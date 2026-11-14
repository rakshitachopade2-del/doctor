import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { Appointment, Role } from '../../shared/types';
import type { AppointmentSeries } from '../../shared/appointment-series';
import type {
  SeriesCancellationContext,
  SeriesCancellationEvent,
  SeriesCancellationInput,
  SeriesCancellationPage,
  SeriesCancellationPreview,
  SeriesCancellationResult,
  SeriesCancellationVisit,
} from '../../shared/appointment-series-cancellations';
import { api } from '../lib';
import { checkedSeriesDetail } from './appointment-series-helpers';
import { checkedVisitAppointment, visitMinutes, visitPolicy } from './visit-duration-helpers';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const stamp = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const roles = ['admin', 'doctor', 'receptionist'];
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
    'The response did not confirm these series cancellations. Refresh the visits or retry the same submitted request.',
  );
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw bad();
}
export const cancellationFailure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The cancellation could not be confirmed. Please try again.';
export function sameCancellationAppointment(a: Appointment, b: Appointment) {
  return (
    [
      'id',
      'patientId',
      'doctorId',
      'patientName',
      'doctorName',
      'date',
      'time',
      'mode',
      'status',
      'reason',
      'fee',
      'createdAt',
    ].every((key) => a[key as keyof Appointment] === b[key as keyof Appointment]) &&
    visitMinutes(a) === visitMinutes(b) &&
    visitPolicy(a) === visitPolicy(b)
  );
}
function member(value: unknown, series: AppointmentSeries, position: unknown) {
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
function checkedVisit(
  value: unknown,
  series: AppointmentSeries,
  generatedAt: string,
): SeriesCancellationVisit {
  requireValue(
    object(value) &&
      typeof value.eligible === 'boolean' &&
      count(value.reservationCount) &&
      Number(value.reservationCount) <= 8,
  );
  const appointment = member(value.appointment, series, value.position);
  const eligible =
    appointment.status === 'scheduled' &&
    Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) > Date.parse(generatedAt);
  requireValue(
    value.eligible === eligible &&
      (eligible ? value.blockedReason === null : text(value.blockedReason)),
  );
  return {
    position: Number(value.position),
    appointment,
    eligible,
    blockedReason: value.blockedReason as string | null,
    reservationCount: Number(value.reservationCount),
  };
}
function context(
  value: unknown,
  series: AppointmentSeries,
  all: boolean,
): SeriesCancellationContext {
  requireValue(
    object(value) &&
      value.seriesId === series.id &&
      object(value.patient) &&
      value.patient.id === series.patient.id &&
      text(value.patient.name) &&
      typeof value.patient.phone === 'string' &&
      stamp(value.generatedAt) &&
      Array.isArray(value.visits),
  );
  const visits = value.visits.map((v) => checkedVisit(v, series, String(value.generatedAt)));
  requireValue(
    visits.length >= 1 &&
      visits.length <= series.input.count &&
      visits.every((v, index) => index === 0 || v.position > visits[index - 1].position),
  );
  if (all)
    requireValue(
      visits.length === series.input.count && visits.every((v, index) => v.position === index + 1),
    );
  return {
    seriesId: series.id,
    patient: value.patient as unknown as SeriesCancellationContext['patient'],
    visits,
    generatedAt: String(value.generatedAt),
  };
}
export function checkedCancellationContext(value: unknown, series: AppointmentSeries) {
  return context(value, series, true);
}
function selectedIds(value: unknown, series: AppointmentSeries): string[] {
  requireValue(
    Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= series.input.count &&
      value.every(text) &&
      new Set(value).size === value.length,
  );
  const ids = series.bookedAppointments.filter((a) => value.includes(a.id)).map((a) => a.id);
  requireValue(ids.length === value.length && ids.every((id, index) => id === value[index]));
  return ids;
}
export function checkedCancellationPreview(
  value: unknown,
  series: AppointmentSeries,
  selected: string[],
): SeriesCancellationPreview {
  requireValue(object(value) && hash(value.revision) && typeof value.canCancel === 'boolean');
  const result = context(value, series, false),
    ids = selectedIds(value.appointmentIds, series);
  requireValue(
    selected.length === ids.length &&
      selected.every((id) => ids.includes(id)) &&
      result.visits.length === ids.length &&
      result.visits.every((visit, index) => visit.appointment.id === ids[index]) &&
      value.canCancel === result.visits.every((v) => v.eligible),
  );
  return {
    ...result,
    appointmentIds: ids,
    revision: String(value.revision),
    canCancel: value.canCancel,
  };
}
export function checkedCancellationEvent(
  value: unknown,
  series: AppointmentSeries,
): SeriesCancellationEvent {
  requireValue(
    object(value) &&
      uuid(value.id) &&
      value.seriesId === series.id &&
      text(value.reason) &&
      value.reason === value.reason.trim() &&
      value.reason.length <= 1000 &&
      value.patientConfirmed === true &&
      uuid(value.requestId) &&
      hash(value.expectedRevision) &&
      text(value.createdById) &&
      text(value.createdByName) &&
      roles.includes(value.createdByRole as string) &&
      stamp(value.createdAt) &&
      Array.isArray(value.visits),
  );
  const ids = selectedIds(value.appointmentIds, series);
  requireValue(value.visits.length === ids.length);
  const visits = value.visits.map((v, index) => {
    requireValue(
      object(v) && count(v.releasedReservationCount) && Number(v.releasedReservationCount) <= 8,
    );
    const before = member(v.before, series, v.position),
      after = member(v.after, series, v.position);
    requireValue(
      before.id === ids[index] &&
        before.status === 'scheduled' &&
        after.status === 'cancelled' &&
        sameCancellationAppointment({ ...before, status: 'cancelled' }, after),
    );
    return {
      position: Number(v.position),
      before,
      after,
      releasedReservationCount: Number(v.releasedReservationCount),
    };
  });
  return { ...(value as unknown as SeriesCancellationEvent), appointmentIds: ids, visits };
}
export interface CancellationAttempt {
  series: AppointmentSeries;
  preview: SeriesCancellationPreview;
  actorId: string;
  actorRole: Exclude<Role, 'patient'>;
  body: SeriesCancellationInput;
}
export function checkedCancellationResult(
  value: unknown,
  sent: CancellationAttempt,
): SeriesCancellationResult {
  requireValue(object(value));
  const event = checkedCancellationEvent(value.event, sent.series),
    detail = checkedSeriesDetail(value.detail, sent.series.id);
  // The immutable series source and command evidence stay fixed; current visits may advance.
  requireValue(JSON.stringify(canonical(detail.series)) === JSON.stringify(canonical(sent.series)));
  requireValue(
    event.requestId === sent.body.requestId &&
      event.expectedRevision === sent.body.expectedRevision &&
      event.expectedRevision === sent.preview.revision &&
      event.createdById === sent.actorId &&
      event.createdByRole === sent.actorRole &&
      event.reason === sent.body.reason &&
      event.appointmentIds.length === sent.body.appointmentIds.length &&
      event.appointmentIds.every(
        (id, index) =>
          id === sent.body.appointmentIds[index] && id === sent.preview.appointmentIds[index],
      ),
  );
  requireValue(
    sent.preview.canCancel &&
      event.visits.every(
        (visit, index) =>
          visit.position === sent.preview.visits[index].position &&
          sameCancellationAppointment(visit.before, sent.preview.visits[index].appointment) &&
          visit.releasedReservationCount === sent.preview.visits[index].reservationCount,
      ),
  );
  return { event, detail };
}
export function checkedCancellationPage(
  value: unknown,
  series: AppointmentSeries,
  page: number,
): SeriesCancellationPage {
  requireValue(
    object(value) &&
      count(value.total) &&
      value.pageSize === 25 &&
      value.totalPages === Math.max(1, Math.ceil(Number(value.total) / 25)) &&
      value.page === Math.min(page, Number(value.totalPages)) &&
      Array.isArray(value.items),
  );
  const items = value.items.map((item) => checkedCancellationEvent(item, series));
  requireValue(
    items.length ===
      Math.min(25, Math.max(0, Number(value.total) - (Number(value.page) - 1) * 25)) &&
      new Set(items.map((i) => i.id)).size === items.length &&
      new Set(items.map((i) => i.requestId)).size === items.length,
  );
  return {
    items,
    page: Number(value.page),
    pageSize: 25,
    total: Number(value.total),
    totalPages: Number(value.totalPages),
  };
}
export function useCancellationGuard() {
  const location = useLocation(),
    key = useRef(location.key),
    mounted = useRef(false);
  key.current = location.key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const origin = key.current,
      href = window.location.href,
      nativeKey = window.history.state?.key;
    return () =>
      mounted.current &&
      key.current === origin &&
      window.location.href === href &&
      window.history.state?.key === nativeKey;
  };
}
/** Keeps obsolete reads, including 401s, from changing a newer route or session. */
export function useCancellationData<T>(path: string | null, check: (value: unknown) => T) {
  const location = useLocation();
  const [state, setState] = useState<{
    path: string | null;
    data: T | null;
    loading: boolean;
    error: string;
  }>({ path, data: null, loading: !!path, error: '' });
  const saved = useRef(state),
    source = useRef({ path, key: location.key }),
    generation = useRef(0),
    mounted = useRef(false),
    validator = useRef(check);
  source.current = { path, key: location.key };
  validator.current = check;
  const reload = useCallback(async (): Promise<T | null> => {
    if (source.current.path !== path || !mounted.current) return null;
    const request = ++generation.current,
      key = source.current.key,
      href = window.location.href,
      nativeKey = window.history.state?.key;
    const current = () =>
      mounted.current &&
      request === generation.current &&
      source.current.path === path &&
      source.current.key === key &&
      window.location.href === href &&
      window.history.state?.key === nativeKey;
    function publish(next: typeof state) {
      saved.current = next;
      setState(next);
    }
    publish({ path, data: null, loading: !!path, error: '' });
    if (!path) return null;
    try {
      const response = await api<unknown>(path, { isCurrent: current });
      if (current()) {
        const data = validator.current(response);
        publish({ path, data, loading: false, error: '' });
        return data;
      }
    } catch (error) {
      if (current())
        publish({ path, data: null, loading: false, error: cancellationFailure(error) });
    }
    return null;
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    if (saved.current.path !== path || !saved.current.data) void reload();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [path, location.key, reload]);
  return state.path === path
    ? { ...state, reload }
    : { path, data: null, loading: !!path, error: '', reload };
}
