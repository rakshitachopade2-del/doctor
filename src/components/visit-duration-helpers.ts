import { useCallback, useEffect, useRef, useState } from 'react';
import type { Appointment } from '../../shared/types';
import type {
  VisitDurationContext,
  VisitDurationEvent,
  VisitDurationMutation,
  VisitDurationPolicy,
} from '../../shared/visit-duration';
import { api } from '../lib';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const revision = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
export const visitDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
  new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export const visitTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const validCustomMinutes = (value: number) =>
  Number.isInteger(value) && value >= 15 && value <= 240 && value % 5 === 0;
export const visitMinutes = (appointment: Appointment) => appointment.durationMinutes ?? 30;
export const visitPolicy = (appointment: Appointment): VisitDurationPolicy =>
  appointment.durationPolicy ?? 'schedule';
export const visitFailure = (error: unknown) =>
  error instanceof Error ? error.message : 'The visit update could not be confirmed. Please retry.';
export function visitClock(time: string) {
  const [hour, minute] = time.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}
export function visitInterval(time: string, duration: number) {
  const [hour, minute] = time.split(':').map(Number),
    end = hour * 60 + minute + duration;
  return `${visitClock(time)}–${visitClock(`${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`)} IST`;
}
const bad = () =>
  new Error(
    'The response did not confirm this visit update. Refresh the record or retry the same submitted request.',
  );
export function checkedVisitAppointment(value: unknown, id?: string): Appointment {
  if (
    !object(value) ||
    !['id', 'patientId', 'patientName', 'doctorId', 'doctorName'].every((key) =>
      text(value[key]),
    ) ||
    (id && value.id !== id) ||
    !visitDate(value.date) ||
    !visitTime(value.time) ||
    !['in-person', 'online'].includes(value.mode as string) ||
    !['scheduled', 'checked-in', 'in-consultation', 'completed', 'cancelled', 'no-show'].includes(
      value.status as string,
    ) ||
    typeof value.reason !== 'string' ||
    typeof value.fee !== 'number' ||
    !Number.isFinite(value.fee) ||
    value.fee < 0 ||
    !timestamp(value.createdAt) ||
    (value.durationPolicy !== undefined &&
      !['schedule', 'custom'].includes(value.durationPolicy as string)) ||
    (value.durationMinutes !== undefined &&
      (!Number.isInteger(value.durationMinutes) ||
        Number(value.durationMinutes) < 1 ||
        Number(value.durationMinutes) > 240)) ||
    (value.durationPolicy === 'custom' && !validCustomMinutes(Number(value.durationMinutes)))
  )
    throw bad();
  const [h, m] = value.time.split(':').map(Number);
  if (h * 60 + m + Number(value.durationMinutes ?? 30) > 1440) throw bad();
  return value as unknown as Appointment;
}
function checkedEvent(value: unknown, id: string): VisitDurationEvent {
  if (
    !object(value) ||
    !text(value.id) ||
    value.appointmentId !== id ||
    !['custom-booking', 'duration-change'].includes(value.operation as string) ||
    !uuid(value.requestId) ||
    (value.operation === 'custom-booking'
      ? value.expectedRevision !== null
      : !revision(value.expectedRevision)) ||
    typeof value.reason !== 'string' ||
    !text(value.createdById) ||
    !text(value.createdByName) ||
    !['admin', 'doctor', 'receptionist'].includes(value.createdByRole as string) ||
    !timestamp(value.createdAt)
  )
    throw bad();
  const after = checkedVisitAppointment(value.after, id);
  if (value.operation === 'custom-booking') {
    if (value.before !== null || visitPolicy(after) !== 'custom') throw bad();
  } else {
    const before = checkedVisitAppointment(value.before, id);
    if (
      before.patientId !== after.patientId ||
      before.patientName !== after.patientName ||
      before.doctorId !== after.doctorId ||
      before.mode !== after.mode ||
      before.reason !== after.reason ||
      before.createdAt !== after.createdAt ||
      before.status !== 'scheduled'
    )
      throw bad();
  }
  if (after.status !== 'scheduled') throw bad();
  return value as unknown as VisitDurationEvent;
}
export function checkedVisitContext(value: unknown, id: string): VisitDurationContext {
  if (!object(value)) throw bad();
  const appointment = checkedVisitAppointment(value.appointment, id);
  if (
    !revision(value.revision) ||
    typeof value.scheduleDurationMinutes !== 'number' ||
    ![15, 20, 30, 45, 60].includes(value.scheduleDurationMinutes) ||
    typeof value.currentDoctorFee !== 'number' ||
    !Number.isFinite(value.currentDoctorFee) ||
    value.currentDoctorFee < 0 ||
    !text(value.currentDoctorName) ||
    typeof value.canChange !== 'boolean' ||
    !Array.isArray(value.history)
  )
    throw bad();
  const history = value.history.map((event) => checkedEvent(event, id));
  if (
    new Set(history.map((event) => event.id)).size !== history.length ||
    history.some((event) => event.after.patientId !== appointment.patientId) ||
    (value.canChange && appointment.status !== 'scheduled')
  )
    throw bad();
  return { ...value, history } as unknown as VisitDurationContext;
}
export const checkedVisitSlots = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every(visitTime) || new Set(value).size !== value.length)
    throw new Error('Available times could not be confirmed. Refresh to try again.');
  return value;
};
export type CustomVisitPayload = {
  patientId: string;
  doctorId: string;
  date: string;
  time: string;
  mode: Appointment['mode'];
  reason: string;
  durationMinutes: number;
  requestId: string;
};
export type CustomVisitAttempt = { body: CustomVisitPayload; actorId: string };
export type LengthPayload = {
  durationPolicy: VisitDurationPolicy;
  durationMinutes?: number;
  date: string;
  time: string;
  reason: string;
  expectedRevision: string;
  requestId: string;
};
export type LengthAttempt = { body: LengthPayload; actorId: string; source: VisitDurationContext };
const sameAppointment = (a: Appointment, b: Appointment) =>
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
  ].every((key) => a[key as keyof Appointment] === b[key as keyof Appointment]) &&
  visitMinutes(a) === visitMinutes(b) &&
  visitPolicy(a) === visitPolicy(b);
export function checkedCustomBooking(
  value: unknown,
  attempt: CustomVisitAttempt,
): VisitDurationMutation {
  if (!object(value)) throw bad();
  const appointment = checkedVisitAppointment(value.appointment),
    event = checkedEvent(value.event, appointment.id),
    after = event.after,
    body = attempt.body;
  if (
    event.operation !== 'custom-booking' ||
    event.requestId !== body.requestId ||
    event.createdById !== attempt.actorId ||
    event.expectedRevision !== null ||
    event.before !== null ||
    after.patientId !== body.patientId ||
    after.doctorId !== body.doctorId ||
    after.date !== body.date ||
    after.time !== body.time ||
    after.mode !== body.mode ||
    after.reason !== body.reason.trim() ||
    visitMinutes(after) !== body.durationMinutes ||
    visitPolicy(after) !== 'custom' ||
    appointment.patientId !== body.patientId
  )
    throw bad();
  return { appointment, event };
}
export function checkedLengthChange(value: unknown, attempt: LengthAttempt): VisitDurationMutation {
  if (!object(value)) throw bad();
  const before = attempt.source.appointment,
    appointment = checkedVisitAppointment(value.appointment, before.id),
    event = checkedEvent(value.event, before.id),
    body = attempt.body,
    after = event.after;
  const moved = body.date !== before.date || body.time !== before.time;
  if (
    event.operation !== 'duration-change' ||
    event.requestId !== body.requestId ||
    event.createdById !== attempt.actorId ||
    event.expectedRevision !== body.expectedRevision ||
    !event.before ||
    !sameAppointment(event.before, before) ||
    event.reason !== body.reason.trim() ||
    after.date !== body.date ||
    after.time !== body.time ||
    visitPolicy(after) !== body.durationPolicy ||
    visitMinutes(after) !==
      (body.durationPolicy === 'custom'
        ? body.durationMinutes
        : attempt.source.scheduleDurationMinutes) ||
    after.fee !== (moved ? attempt.source.currentDoctorFee : before.fee) ||
    after.doctorName !== (moved ? attempt.source.currentDoctorName : before.doctorName) ||
    appointment.patientId !== before.patientId
  )
    throw bad();
  return { appointment, event };
}
export const isVisitRequestCollision = (error: unknown) =>
  error instanceof Error &&
  /request (?:ID|id).*already|request.*different (?:details|payload)|idempotency/i.test(
    error.message,
  );
export function useVisitData<T>(path: string | null, check: (value: unknown) => T) {
  const [state, setState] = useState<{
    path: string | null;
    data: T | null;
    loading: boolean;
    error: string;
  }>({ path, data: null, loading: !!path, error: '' });
  const generation = useRef(0),
    current = useRef(path),
    validator = useRef(check);
  current.current = path;
  validator.current = check;
  const reload = useCallback(async () => {
    if (path !== current.current) return;
    const request = ++generation.current;
    setState({ path, data: null, loading: !!path, error: '' });
    if (!path) return;
    try {
      const result = await api<unknown>(path);
      if (request === generation.current && path === current.current)
        setState({ path, data: validator.current(result), loading: false, error: '' });
    } catch (error) {
      if (request === generation.current && path === current.current)
        setState({ path, data: null, loading: false, error: visitFailure(error) });
    }
  }, [path]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return state.path === path
    ? { ...state, reload }
    : { path, data: null, loading: !!path, error: '', reload };
}
