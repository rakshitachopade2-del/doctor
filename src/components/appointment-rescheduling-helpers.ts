import type { Appointment } from '../../shared/types';
import type {
  AppointmentRescheduleContext,
  AppointmentRescheduleInput,
  AppointmentReschedulePreview,
  AppointmentRescheduleResult,
  AppointmentRescheduleTarget,
} from '../../shared/appointment-rescheduling';
import { ApiError } from '../lib';
import {
  checkedVisitAppointment,
  visitDate,
  visitMinutes,
  visitPolicy,
  visitTime,
} from './visit-duration-helpers';

export type RescheduleAttempt = {
  actorId: string;
  source: AppointmentRescheduleContext;
  preview: AppointmentReschedulePreview;
  body: AppointmentRescheduleInput;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const timestamp = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const bad = () =>
  new Error(
    'The response did not confirm this appointment change. Refresh the source or retry the same submitted request.',
  );
export const rescheduleFailure = (error: unknown) =>
  error instanceof Error ? error.message : 'The appointment change could not be confirmed.';
export const sameRescheduleTarget = (
  a: AppointmentRescheduleTarget,
  b: AppointmentRescheduleTarget,
) => a.doctorId === b.doctorId && a.date === b.date && a.time === b.time && a.mode === b.mode;
export function sameRescheduleAppointment(a: Appointment, b: Appointment) {
  return (
    (
      [
        'id',
        'patientId',
        'patientName',
        'doctorId',
        'doctorName',
        'date',
        'time',
        'mode',
        'reason',
        'status',
        'fee',
        'createdAt',
      ] as const
    ).every((field) => a[field] === b[field]) &&
    visitMinutes(a) === visitMinutes(b) &&
    visitPolicy(a) === visitPolicy(b)
  );
}
function blocked(value: Record<string, unknown>) {
  if (
    typeof value.canReschedule !== 'boolean' ||
    (value.canReschedule ? value.blockedReason !== null : !text(value.blockedReason))
  )
    throw bad();
}
export function checkedRescheduleContext(
  value: unknown,
  appointmentId: string,
): AppointmentRescheduleContext {
  if (
    !object(value) ||
    !hash(value.sourceRevision) ||
    !visitDate(value.clinicDate) ||
    !visitDate(value.bookingThroughDate)
  )
    throw bad();
  const appointment = checkedVisitAppointment(value.appointment, appointmentId);
  blocked(value);
  if (value.canReschedule && appointment.status !== 'scheduled') throw bad();
  if (
    Date.parse(`${value.bookingThroughDate}T12:00:00Z`) -
      Date.parse(`${value.clinicDate}T12:00:00Z`) !==
    180 * 86400000
  )
    throw bad();
  return { ...value, appointment } as unknown as AppointmentRescheduleContext;
}
function proposed(value: unknown, allowOvernight: boolean) {
  if (!object(value) || !visitTime(value.time)) throw bad();
  if (!allowOvernight) return checkedVisitAppointment(value);
  // A blocked custom proposal can cross midnight; it is displayed, never treated as bookable.
  checkedVisitAppointment({ ...value, time: '00:00' });
  return value as unknown as Appointment;
}
export function checkedReschedulePreview(
  value: unknown,
  source: AppointmentRescheduleContext,
  target: AppointmentRescheduleTarget,
): AppointmentReschedulePreview {
  if (
    !object(value) ||
    value.appointmentId !== source.appointment.id ||
    value.sourceRevision !== source.sourceRevision ||
    !hash(value.revision) ||
    !timestamp(value.generatedAt)
  )
    throw bad();
  blocked(value);
  const before = checkedVisitAppointment(value.before, source.appointment.id),
    after = proposed(value.after, !value.canReschedule);
  const unchanged = sameRescheduleTarget(before, target);
  if (
    !sameRescheduleAppointment(before, source.appointment) ||
    !sameRescheduleTarget(after, target) ||
    after.id !== before.id ||
    after.patientId !== before.patientId ||
    after.patientName !== before.patientName ||
    after.reason !== before.reason ||
    after.createdAt !== before.createdAt ||
    after.status !== before.status ||
    visitPolicy(after) !== visitPolicy(before) ||
    (visitPolicy(before) === 'custom' && visitMinutes(after) !== visitMinutes(before)) ||
    (!unchanged &&
      visitPolicy(after) === 'schedule' &&
      ![15, 20, 30, 45, 60].includes(visitMinutes(after))) ||
    (unchanged && (!sameRescheduleAppointment(before, after) || value.canReschedule)) ||
    (value.canReschedule &&
      (before.status !== 'scheduled' ||
        Date.parse(`${before.date}T${before.time}:00+05:30`) <= Date.parse(value.generatedAt) ||
        Date.parse(`${after.date}T${after.time}:00+05:30`) <= Date.parse(value.generatedAt)))
  )
    throw bad();
  return { ...value, before, after } as unknown as AppointmentReschedulePreview;
}
export function checkedRescheduleResult(
  value: unknown,
  attempt: RescheduleAttempt,
): AppointmentRescheduleResult {
  if (!object(value) || !object(value.event) || !object(value.receipt)) throw bad();
  const event = value.event,
    receipt = value.receipt,
    body = attempt.body;
  const before = checkedVisitAppointment(event.before, attempt.source.appointment.id),
    after = checkedVisitAppointment(event.after, before.id),
    current = checkedVisitAppointment(value.appointment, before.id);
  if (
    !uuid(event.id) ||
    event.appointmentId !== before.id ||
    event.requestId !== body.requestId ||
    !uuid(event.requestId) ||
    event.expectedRevision !== body.expectedRevision ||
    !hash(event.expectedRevision) ||
    event.patientConfirmed !== true ||
    event.createdById !== attempt.actorId ||
    !text(event.createdByName) ||
    !['patient', 'admin', 'doctor', 'receptionist'].includes(event.createdByRole as string) ||
    !timestamp(event.createdAt) ||
    !attempt.preview.canReschedule ||
    !sameRescheduleAppointment(before, attempt.preview.before) ||
    !sameRescheduleAppointment(after, attempt.preview.after) ||
    !sameRescheduleTarget(after, body) ||
    before.status !== 'scheduled' ||
    after.status !== 'scheduled' ||
    current.patientId !== before.patientId ||
    current.createdAt !== before.createdAt ||
    receipt.requestId !== body.requestId ||
    receipt.actorId !== attempt.actorId ||
    receipt.patientId !== before.patientId ||
    receipt.appointmentId !== before.id ||
    receipt.eventId !== event.id ||
    receipt.expectedRevision !== body.expectedRevision
  )
    throw bad();
  return {
    appointment: current,
    event: { ...event, before, after },
    receipt,
  } as unknown as AppointmentRescheduleResult;
}
export function rescheduleNotApplied(error: unknown, attempt: RescheduleAttempt) {
  if (
    !(error instanceof ApiError) ||
    ![400, 404, 409].includes(error.status) ||
    !object(error.responseData)
  )
    return false;
  const value = error.responseData;
  return (
    text(value.error) &&
    value.rescheduleOutcome === 'not-applied' &&
    value.requestId === attempt.body.requestId &&
    value.actorId === attempt.actorId &&
    value.patientId === attempt.source.appointment.patientId &&
    value.appointmentId === attempt.source.appointment.id
  );
}
export function rescheduleEnd(appointment: Appointment) {
  const end = new Date(
    Date.parse(`${appointment.date}T${appointment.time}:00Z`) + visitMinutes(appointment) * 60000,
  );
  return { date: end.toISOString().slice(0, 10), time: end.toISOString().slice(11, 16) };
}
