import type { Appointment } from '../../shared/types';
import type {
  AppointmentCancellationContext,
  AppointmentCancellationInput,
  AppointmentCancellationResult,
} from '../../shared/appointment-cancellation';
import { ApiError } from '../lib';
import { checkedVisitAppointment } from './visit-duration-helpers';

export type CancellationAttempt = {
  actorId: string;
  source: AppointmentCancellationContext;
  body: AppointmentCancellationInput;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const revision = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const timestamp = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const bad = () =>
  new Error(
    'The response did not confirm this cancellation. Refresh the visit or retry the same submitted request.',
  );
export const cancellationFailure = (error: unknown) =>
  error instanceof Error ? error.message : 'The cancellation could not be confirmed.';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function sameCancellationAppointment(a: Appointment, b: Appointment, ignoreStatus = false) {
  const clean = (value: Appointment) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !ignoreStatus || key !== 'status'));
  return JSON.stringify(canonical(clean(a))) === JSON.stringify(canonical(clean(b)));
}
export function checkedCancellationContext(
  value: unknown,
  appointmentId: string,
  ownPatientId?: string,
): AppointmentCancellationContext {
  if (
    !object(value) ||
    !revision(value.revision) ||
    typeof value.canCancel !== 'boolean' ||
    (value.canCancel ? value.blockedReason !== null : !text(value.blockedReason))
  )
    throw bad();
  const appointment = checkedVisitAppointment(value.appointment, appointmentId);
  if (
    (ownPatientId !== undefined && appointment.patientId !== ownPatientId) ||
    (value.canCancel &&
      !(ownPatientId === undefined ? ['scheduled', 'checked-in'] : ['scheduled']).includes(
        appointment.status,
      ))
  )
    throw bad();
  return { ...value, appointment } as unknown as AppointmentCancellationContext;
}
export function checkedCancellationResult(
  value: unknown,
  attempt: CancellationAttempt,
): AppointmentCancellationResult {
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
    !revision(event.expectedRevision) ||
    event.cancellationConfirmed !== true ||
    event.createdById !== attempt.actorId ||
    !text(event.createdByName) ||
    !['patient', 'admin', 'doctor', 'receptionist'].includes(event.createdByRole as string) ||
    !timestamp(event.createdAt) ||
    !sameCancellationAppointment(before, attempt.source.appointment) ||
    !sameCancellationAppointment(before, after, true) ||
    !(event.createdByRole === 'patient' ? ['scheduled'] : ['scheduled', 'checked-in']).includes(
      before.status,
    ) ||
    after.status !== 'cancelled' ||
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
  } as unknown as AppointmentCancellationResult;
}
export function cancellationNotApplied(error: unknown, attempt: CancellationAttempt) {
  if (
    !(error instanceof ApiError) ||
    ![400, 404, 409].includes(error.status) ||
    !object(error.responseData)
  )
    return false;
  const value = error.responseData;
  return (
    text(value.error) &&
    value.cancellationOutcome === 'not-applied' &&
    value.requestId === attempt.body.requestId &&
    value.actorId === attempt.actorId &&
    value.patientId === attempt.source.appointment.patientId &&
    value.appointmentId === attempt.source.appointment.id
  );
}
