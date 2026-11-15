import type { Appointment, Role } from '../../shared/types';
import type {
  AppointmentStateChangeContext,
  AppointmentStateChangeInput,
  AppointmentStateChangeResult,
  AppointmentStateChangeStatus,
} from '../../shared/appointment-state-change';
import { ApiError } from '../lib';
import { checkedVisitAppointment, visitDate } from './visit-duration-helpers';

export type StateChangeAttempt = {
  actorId: string;
  actorRole: Exclude<Role, 'patient'>;
  source: AppointmentStateChangeContext;
  body: AppointmentStateChangeInput;
};
export const stateChangeStatuses: AppointmentStateChangeStatus[] = [
  'checked-in',
  'in-consultation',
  'completed',
  'no-show',
];
export const stateChangeLabels: Record<Appointment['status'], string> = {
  scheduled: 'Scheduled',
  'checked-in': 'Checked in',
  'in-consultation': 'In consultation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  'no-show': 'No-show',
};
const sourceStatus: Record<AppointmentStateChangeStatus, Appointment['status']> = {
  'checked-in': 'scheduled',
  'in-consultation': 'checked-in',
  completed: 'in-consultation',
  'no-show': 'scheduled',
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
const clinicDay = (instant: string) =>
  new Date(Date.parse(instant) + 330 * 60_000).toISOString().slice(0, 10);
const bad = () =>
  new Error(
    'The response did not confirm this status update. Refresh the visit or retry the same submitted request.',
  );
export const stateChangeFailure = (error: unknown) =>
  error instanceof Error ? error.message : 'The status update could not be confirmed.';
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
export function sameStateChangeAppointment(a: Appointment, b: Appointment, ignoreStatus = false) {
  const clean = (value: Appointment) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !ignoreStatus || key !== 'status'));
  return JSON.stringify(canonical(clean(a))) === JSON.stringify(canonical(clean(b)));
}
function allowed(
  appointment: Appointment,
  status: AppointmentStateChangeStatus,
  role: Role,
  at: string,
) {
  return (
    role !== 'patient' &&
    !(role === 'receptionist' && ['in-consultation', 'completed'].includes(status)) &&
    appointment.status === sourceStatus[status] &&
    appointment.date <= clinicDay(at) &&
    (status !== 'no-show' ||
      Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) <= Date.parse(at))
  );
}
export function checkedStateChangeContext(
  value: unknown,
  appointmentId: string,
  role: Role,
): AppointmentStateChangeContext {
  if (
    !object(value) ||
    !revision(value.revision) ||
    !timestamp(value.generatedAt) ||
    !visitDate(value.clinicDate) ||
    value.clinicDate !== clinicDay(value.generatedAt) ||
    !Array.isArray(value.actions) ||
    value.actions.length !== stateChangeStatuses.length ||
    role === 'patient'
  )
    throw bad();
  const appointment = checkedVisitAppointment(value.appointment, appointmentId);
  for (const [index, action] of value.actions.entries()) {
    if (
      !object(action) ||
      action.status !== stateChangeStatuses[index] ||
      typeof action.allowed !== 'boolean' ||
      (action.allowed ? action.blockedReason !== null : !text(action.blockedReason)) ||
      action.allowed !== allowed(appointment, stateChangeStatuses[index], role, value.generatedAt)
    )
      throw bad();
  }
  return { ...value, appointment } as unknown as AppointmentStateChangeContext;
}
export function checkedStateChangeResult(
  value: unknown,
  attempt: StateChangeAttempt,
): AppointmentStateChangeResult {
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
    body.expectedRevision !== attempt.source.revision ||
    !revision(event.expectedRevision) ||
    event.changeConfirmed !== true ||
    event.createdById !== attempt.actorId ||
    event.createdByRole !== attempt.actorRole ||
    !text(event.createdByName) ||
    !timestamp(event.createdAt) ||
    !sameStateChangeAppointment(before, attempt.source.appointment) ||
    !sameStateChangeAppointment(before, after, true) ||
    !allowed(before, body.status, attempt.actorRole, event.createdAt) ||
    after.status !== body.status ||
    current.patientId !== before.patientId ||
    current.createdAt !== before.createdAt ||
    receipt.requestId !== body.requestId ||
    receipt.actorId !== attempt.actorId ||
    receipt.patientId !== before.patientId ||
    receipt.appointmentId !== before.id ||
    receipt.eventId !== event.id ||
    receipt.expectedRevision !== body.expectedRevision ||
    receipt.status !== body.status
  )
    throw bad();
  return {
    appointment: current,
    event: { ...event, before, after },
    receipt,
  } as unknown as AppointmentStateChangeResult;
}
export function stateChangeNotApplied(error: unknown, attempt: StateChangeAttempt) {
  if (
    !(error instanceof ApiError) ||
    ![400, 404, 409].includes(error.status) ||
    !object(error.responseData)
  )
    return false;
  const value = error.responseData;
  return (
    text(value.error) &&
    value.stateChangeOutcome === 'not-applied' &&
    value.requestId === attempt.body.requestId &&
    value.actorId === attempt.actorId &&
    value.patientId === attempt.source.appointment.patientId &&
    value.appointmentId === attempt.source.appointment.id
  );
}
