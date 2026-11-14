import type { Appointment, Role } from '../../shared/types';
import type { AppointmentSeries } from '../../shared/appointment-series';
import type {
  SeriesRescheduleContext,
  SeriesRescheduleEvent,
  SeriesRescheduleInput,
  SeriesRescheduleMove,
  SeriesReschedulePage,
  SeriesReschedulePreview,
  SeriesRescheduleResult,
} from '../../shared/appointment-series-rescheduling';
import { checkedSeriesDetail, seriesEnd } from './appointment-series-helpers';
import {
  checkedVisitAppointment,
  visitDate,
  visitMinutes,
  visitPolicy,
  visitTime,
} from './visit-duration-helpers';
import { sameCancellationAppointment } from './series-cancellation-helpers';
export {
  useCancellationData as useRescheduleData,
  useCancellationGuard as useRescheduleGuard,
} from './series-cancellation-helpers';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const stamp = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const bad = () =>
  new Error(
    'The response did not confirm these appointment changes. Refresh the visits or retry the same submitted request.',
  );
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw bad();
}
export const rescheduleFailure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The rescheduling could not be confirmed. Please try again.';
export function sameRescheduleMoves(a: SeriesRescheduleMove[], b: SeriesRescheduleMove[]) {
  return (
    a.length === b.length &&
    a.every(
      (move, index) =>
        move.appointmentId === b[index].appointmentId &&
        move.date === b[index].date &&
        move.time === b[index].time,
    )
  );
}
function member(value: unknown, series: AppointmentSeries, position: unknown): Appointment {
  requireValue(
    Number.isInteger(position) &&
      Number(position) >= 1 &&
      Number(position) <= series.bookedAppointments.length,
  );
  const original = series.bookedAppointments[Number(position) - 1],
    appointment = checkedVisitAppointment(value, original.id);
  requireValue(
    appointment.patientId === series.patient.id && appointment.createdAt === original.createdAt,
  );
  return appointment;
}
function moves(value: unknown, series: AppointmentSeries): SeriesRescheduleMove[] {
  requireValue(Array.isArray(value) && value.length >= 1 && value.length <= series.input.count);
  const result = value.map((row) => {
    requireValue(
      object(row) && text(row.appointmentId) && visitDate(row.date) && visitTime(row.time),
    );
    return { appointmentId: row.appointmentId, date: row.date, time: row.time };
  });
  const ids = series.bookedAppointments
    .filter((a) => result.some((move) => move.appointmentId === a.id))
    .map((a) => a.id);
  requireValue(
    result.length === ids.length &&
      result.every((move, index) => move.appointmentId === ids[index]),
  );
  return result;
}
function patient(value: unknown, series: AppointmentSeries): SeriesRescheduleContext['patient'] {
  requireValue(
    object(value) &&
      value.id === series.patient.id &&
      text(value.name) &&
      typeof value.phone === 'string',
  );
  return { id: value.id as string, name: value.name, phone: value.phone };
}
function dates(value: Record<string, unknown>) {
  requireValue(
    stamp(value.generatedAt) && visitDate(value.clinicDate) && visitDate(value.horizonEndDate),
  );
  const clinicDate = new Date(Date.parse(String(value.generatedAt)) + 330 * 60000)
      .toISOString()
      .slice(0, 10),
    horizonEndDate = new Date(Date.parse(`${clinicDate}T12:00:00Z`) + 180 * 86400000)
      .toISOString()
      .slice(0, 10);
  requireValue(value.clinicDate === clinicDate && value.horizonEndDate === horizonEndDate);
  return { generatedAt: String(value.generatedAt), clinicDate, horizonEndDate };
}
export function checkedRescheduleContext(
  value: unknown,
  series: AppointmentSeries,
): SeriesRescheduleContext {
  requireValue(
    object(value) &&
      value.seriesId === series.id &&
      Array.isArray(value.visits) &&
      value.visits.length === series.input.count,
  );
  const period = dates(value),
    currentPatient = patient(value.patient, series);
  const visits = value.visits.map((row, index) => {
    requireValue(
      object(row) &&
        row.position === index + 1 &&
        count(row.reservationCount) &&
        Number(row.reservationCount) <= 8,
    );
    const appointment = member(row.appointment, series, row.position),
      eligible =
        appointment.status === 'scheduled' &&
        Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) >
          Date.parse(period.generatedAt);
    requireValue(
      row.eligible === eligible &&
        (eligible ? row.blockedReason === null : text(row.blockedReason)),
    );
    return {
      position: index + 1,
      appointment,
      eligible,
      blockedReason: row.blockedReason as string | null,
      reservationCount: Number(row.reservationCount),
    };
  });
  return { seriesId: series.id, patient: currentPatient, visits, ...period };
}
function proposed(
  value: unknown,
  before: Appointment,
  move: SeriesRescheduleMove,
  blockedAllowed: boolean,
): Appointment {
  requireValue(
    object(value) && value.id === before.id && value.date === move.date && value.time === move.time,
  );
  // A rejected target can legitimately extend past midnight. Validate its full
  // DTO without the saved-appointment day bound; endDate/endTime explain it.
  const after = blockedAllowed
    ? (checkedVisitAppointment({ ...value, time: '00:00' }), value as unknown as Appointment)
    : checkedVisitAppointment(value, before.id);
  requireValue(
    ['patientId', 'patientName', 'doctorId', 'mode', 'reason', 'createdAt', 'status'].every(
      (key) => before[key as keyof Appointment] === after[key as keyof Appointment],
    ) && visitPolicy(before) === visitPolicy(after),
  );
  if (visitPolicy(before) === 'custom') requireValue(visitMinutes(before) === visitMinutes(after));
  else requireValue([15, 20, 30, 45, 60].includes(visitMinutes(after)));
  return after;
}
export function checkedReschedulePreview(
  value: unknown,
  series: AppointmentSeries,
  requested: SeriesRescheduleMove[],
): SeriesReschedulePreview {
  requireValue(
    object(value) &&
      value.seriesId === series.id &&
      hash(value.revision) &&
      typeof value.canReschedule === 'boolean' &&
      Array.isArray(value.visits),
  );
  const normalized = moves(value.moves, series),
    period = dates(value),
    currentPatient = patient(value.patient, series);
  requireValue(
    normalized.length === requested.length &&
      requested.every((move) =>
        normalized.some(
          (row) =>
            row.appointmentId === move.appointmentId &&
            row.date === move.date &&
            row.time === move.time,
        ),
      ) &&
      value.visits.length === normalized.length,
  );
  const visits = value.visits.map((row, index) => {
    requireValue(
      object(row) &&
        typeof row.eligible === 'boolean' &&
        (row.eligible ? row.blockedReason === null : text(row.blockedReason)) &&
        count(row.reservationCount) &&
        Number(row.reservationCount) <= 8,
    );
    const before = member(row.before, series, row.position),
      move = normalized[index];
    requireValue(before.id === move.appointmentId);
    const after = proposed(row.after, before, move, !row.eligible),
      end = seriesEnd(after.date, after.time, visitMinutes(after));
    requireValue(row.endDate === end.date && row.endTime === end.time);
    if (row.eligible)
      requireValue(
        before.status === 'scheduled' &&
          Date.parse(`${before.date}T${before.time}:00+05:30`) > Date.parse(period.generatedAt) &&
          (before.date !== after.date || before.time !== after.time) &&
          after.date >= period.clinicDate &&
          after.date <= period.horizonEndDate &&
          Date.parse(`${after.date}T${after.time}:00+05:30`) > Date.parse(period.generatedAt),
      );
    return {
      position: Number(row.position),
      before,
      after,
      endDate: end.date,
      endTime: end.time,
      reservationCount: Number(row.reservationCount),
      eligible: row.eligible,
      blockedReason: row.blockedReason as string | null,
    };
  });
  requireValue(value.canReschedule === visits.every((row) => row.eligible));
  return {
    seriesId: series.id,
    patient: currentPatient,
    moves: normalized,
    visits,
    canReschedule: value.canReschedule,
    revision: String(value.revision),
    ...period,
  };
}
export function checkedRescheduleEvent(
  value: unknown,
  series: AppointmentSeries,
): SeriesRescheduleEvent {
  requireValue(
    object(value) &&
      uuid(value.id) &&
      value.seriesId === series.id &&
      text(value.reason) &&
      value.reason === value.reason.trim() &&
      value.reason.length <= 1000 &&
      hash(value.expectedRevision) &&
      value.patientConfirmed === true &&
      uuid(value.requestId) &&
      text(value.createdById) &&
      text(value.createdByName) &&
      ['admin', 'doctor', 'receptionist'].includes(value.createdByRole as string) &&
      stamp(value.createdAt) &&
      Array.isArray(value.visits),
  );
  const normalized = moves(value.moves, series);
  requireValue(value.visits.length === normalized.length);
  const visits = value.visits.map((row, index) => {
    requireValue(
      object(row) &&
        count(row.retainedReservationCount) &&
        Number(row.retainedReservationCount) <= 8,
    );
    const before = member(row.before, series, row.position),
      move = normalized[index];
    requireValue(before.id === move.appointmentId && before.status === 'scheduled');
    const after = proposed(row.after, before, move, false);
    requireValue(before.date !== after.date || before.time !== after.time);
    return {
      position: Number(row.position),
      before,
      after,
      retainedReservationCount: Number(row.retainedReservationCount),
    };
  });
  return { ...(value as unknown as SeriesRescheduleEvent), moves: normalized, visits };
}
export interface RescheduleAttempt {
  series: AppointmentSeries;
  preview: SeriesReschedulePreview;
  actorId: string;
  actorRole: Exclude<Role, 'patient'>;
  body: SeriesRescheduleInput;
}
export function checkedRescheduleResult(
  value: unknown,
  sent: RescheduleAttempt,
): SeriesRescheduleResult {
  requireValue(object(value));
  const event = checkedRescheduleEvent(value.event, sent.series),
    detail = checkedSeriesDetail(value.detail, sent.series.id);
  requireValue(
    JSON.stringify(canonical(detail.series)) === JSON.stringify(canonical(sent.series)) &&
      event.requestId === sent.body.requestId &&
      event.expectedRevision === sent.body.expectedRevision &&
      event.expectedRevision === sent.preview.revision &&
      event.createdById === sent.actorId &&
      event.createdByRole === sent.actorRole &&
      event.reason === sent.body.reason &&
      sameRescheduleMoves(event.moves, sent.body.moves) &&
      sameRescheduleMoves(event.moves, sent.preview.moves),
  );
  requireValue(
    sent.preview.canReschedule &&
      event.visits.every(
        (row, index) =>
          row.position === sent.preview.visits[index].position &&
          sameCancellationAppointment(row.before, sent.preview.visits[index].before) &&
          sameCancellationAppointment(row.after, sent.preview.visits[index].after) &&
          row.retainedReservationCount === sent.preview.visits[index].reservationCount,
      ),
  );
  return { event, detail };
}
export function checkedReschedulePage(
  value: unknown,
  series: AppointmentSeries,
  page: number,
): SeriesReschedulePage {
  requireValue(
    object(value) &&
      count(value.total) &&
      value.pageSize === 25 &&
      value.totalPages === Math.max(1, Math.ceil(Number(value.total) / 25)) &&
      value.page === Math.min(page, Number(value.totalPages)) &&
      Array.isArray(value.items),
  );
  const items = value.items.map((row) => checkedRescheduleEvent(row, series));
  requireValue(
    items.length ===
      Math.min(25, Math.max(0, Number(value.total) - (Number(value.page) - 1) * 25)) &&
      new Set(items.map((row) => row.id)).size === items.length &&
      new Set(items.map((row) => row.requestId)).size === items.length,
  );
  return {
    items,
    page: Number(value.page),
    pageSize: 25,
    total: Number(value.total),
    totalPages: Number(value.totalPages),
  };
}
