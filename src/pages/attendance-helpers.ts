import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AttendanceContext,
  AttendanceDetail,
  AttendanceEvent,
  AttendanceMutation,
  AttendanceOperation,
  AttendanceReport,
  AttendanceShift,
  AttendanceStaff,
  AttendanceState,
} from '../../shared/attendance';
import { api } from '../lib';

export const attendanceFailure = (problem: unknown) =>
  problem instanceof Error
    ? problem.message
    : 'The request could not be confirmed. Please try again.';
export const attendanceStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
export const attendanceDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return `${hours.toLocaleString('en-IN')}h ${minutes}m ${seconds % 60}s`;
};
export const attendanceDay = (value: string) =>
  new Date(Date.parse(value) + 330 * 60_000).toISOString().slice(0, 10);
export const attendanceParts = (value: string) => {
  const local = new Date(Date.parse(value) + 330 * 60_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 19) };
};
export const attendanceRealDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
  new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export function attendancePeriod(from: string, to: string) {
  if (!attendanceRealDate(from) || !attendanceRealDate(to))
    return 'Choose a valid start and end date.';
  if (to < from) return 'The end date must be on or after the start date.';
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > 366)
    return 'Choose a period of 366 days or fewer, including both dates.';
  return '';
}
export function attendanceInput(date: string, time: string, original?: string | null) {
  if (!attendanceRealDate(date) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time))
    throw new Error('Enter a valid date and time in India Standard Time.');
  const normalizedTime = time.length === 5 ? `${time}:00` : time;
  if (original) {
    const parts = attendanceParts(original);
    if (parts.date === date && parts.time === normalizedTime) return original;
  }
  return new Date(`${date}T${normalizedTime}+05:30`).toISOString();
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const stamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const role = (value: unknown) => ['admin', 'doctor', 'receptionist'].includes(value as string);
const seconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const bad = () =>
  new Error(
    'The attendance response could not be confirmed. Refresh the record or retry the same submitted request.',
  );
export function checkedAttendanceStaff(value: unknown): AttendanceStaff[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        object(entry) &&
        text(entry.id) &&
        text(entry.name) &&
        role(entry.role) &&
        typeof entry.active === 'boolean',
    ) ||
    new Set(value.map((entry) => entry.id)).size !== value.length
  )
    throw bad();
  return value;
}
function state(value: unknown): value is AttendanceState {
  return (
    object(value) &&
    stamp(value.startedAt) &&
    (value.endedAt === null ||
      (stamp(value.endedAt) &&
        value.endedAt >= value.startedAt &&
        Date.parse(value.endedAt) - Date.parse(value.startedAt) <= 36 * 3_600_000)) &&
    typeof value.voided === 'boolean'
  );
}
export function checkedAttendanceShift(
  value: unknown,
  id?: string,
  userId?: string,
): AttendanceShift {
  if (
    !object(value) ||
    !text(value.id) ||
    (id && value.id !== id) ||
    !text(value.userId) ||
    (userId && value.userId !== userId) ||
    !text(value.staffName) ||
    !role(value.staffRole) ||
    !['clock', 'manual'].includes(value.source as string) ||
    !stamp(value.startedAt) ||
    !(value.endedAt === null || stamp(value.endedAt)) ||
    !stamp(value.createdAt) ||
    !revision(value.revision) ||
    !['open', 'closed', 'voided'].includes(value.status as string)
  )
    throw bad();
  if (
    !state({
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      voided: value.status === 'voided',
    }) ||
    (value.status === 'open' && value.endedAt !== null) ||
    (value.status === 'closed' && value.endedAt === null) ||
    (value.status === 'closed'
      ? value.recordedSeconds !==
        Math.floor((Date.parse(value.endedAt as string) - Date.parse(value.startedAt)) / 1000)
      : value.recordedSeconds !== null)
  )
    throw bad();
  return value as unknown as AttendanceShift;
}
function checkedEvent(value: unknown, shiftId: string, userId: string): AttendanceEvent {
  if (
    !object(value) ||
    !text(value.id) ||
    value.shiftId !== shiftId ||
    value.userId !== userId ||
    !['clock-in', 'clock-out', 'manual-entry', 'correction', 'void'].includes(
      value.operation as string,
    ) ||
    !uuid(value.requestId) ||
    !revision(value.expectedRevision) ||
    !(value.before === null || state(value.before)) ||
    !state(value.after) ||
    typeof value.reason !== 'string' ||
    !text(value.createdById) ||
    !text(value.createdByName) ||
    !role(value.createdByRole) ||
    !stamp(value.createdAt)
  )
    throw bad();
  if (
    ['clock-in', 'manual-entry'].includes(value.operation as string)
      ? value.before !== null
      : value.before === null
  )
    throw bad();
  return value as unknown as AttendanceEvent;
}
export function checkedAttendanceContext(value: unknown, userId?: string): AttendanceContext {
  if (
    !object(value) ||
    !revision(value.revision) ||
    !stamp(value.serverNow) ||
    value.timezone !== 'Asia/Kolkata'
  )
    throw bad();
  const staff = checkedAttendanceStaff([value.staff])[0];
  if (userId && staff.id !== userId) throw bad();
  if (
    value.openShift !== null &&
    checkedAttendanceShift(value.openShift, undefined, staff.id).status !== 'open'
  )
    throw bad();
  return value as unknown as AttendanceContext;
}
export function checkedAttendanceDetail(value: unknown, id: string): AttendanceDetail {
  if (!object(value)) throw bad();
  const shift = checkedAttendanceShift(value.shift, id);
  if (!Array.isArray(value.events) || !value.events.length) throw bad();
  const events = value.events.map((entry) => checkedEvent(entry, id, shift.userId));
  if (
    new Set(events.map((entry) => entry.id)).size !== events.length ||
    events.filter((entry) => entry.before === null).length !== 1
  )
    throw bad();
  if (
    !sameState(events[0].after, attendanceState(shift)) ||
    events.some((event, index) =>
      index < events.length - 1
        ? !sameState(event.before, events[index + 1].after)
        : event.before !== null,
    )
  )
    throw bad();
  return { shift, events };
}
export type AttendanceFilters = {
  from: string;
  to: string;
  userId: string | null;
  status: AttendanceReport['status'];
};
export function checkedAttendanceReport(
  value: unknown,
  filters: AttendanceFilters,
  requestedPage: number,
): AttendanceReport {
  if (
    !object(value) ||
    value.from !== filters.from ||
    value.to !== filters.to ||
    value.userId !== filters.userId ||
    value.status !== filters.status ||
    value.timezone !== 'Asia/Kolkata' ||
    !stamp(value.generatedAt) ||
    !revision(value.revision) ||
    !seconds(value.total) ||
    !Number.isSafeInteger(value.page) ||
    !Number.isSafeInteger(value.pageSize) ||
    (value.page as number) < 1 ||
    (value.pageSize as number) < 1 ||
    (value.pageSize as number) > 100 ||
    value.totalPages !== Math.max(1, Math.ceil(value.total / (value.pageSize as number))) ||
    (value.page as number) > (value.totalPages as number) ||
    !Array.isArray(value.items) ||
    value.items.length !==
      Math.min(
        value.pageSize as number,
        Math.max(0, value.total - ((value.page as number) - 1) * (value.pageSize as number)),
      ) ||
    !object(value.totals) ||
    !['closedShiftCount', 'recordedSeconds', 'openShiftCount', 'voidedShiftCount'].every((key) =>
      seconds(value.totals && (value.totals as Record<string, unknown>)[key]),
    )
  )
    throw bad();
  const totals = value.totals as unknown as AttendanceReport['totals'];
  if (
    totals.closedShiftCount + totals.openShiftCount + totals.voidedShiftCount !== value.total ||
    totals.recordedSeconds > totals.closedShiftCount * 36 * 3600 ||
    value.pageSize !== 25 ||
    value.page !== Math.min(requestedPage, value.totalPages as number)
  )
    throw bad();
  const items = value.items.map((entry) =>
    checkedAttendanceShift(entry, undefined, filters.userId ?? undefined),
  );
  if (
    new Set(items.map((entry) => entry.id)).size !== items.length ||
    items.some(
      (entry) =>
        attendanceDay(entry.startedAt) < filters.from ||
        attendanceDay(entry.startedAt) > filters.to ||
        (filters.status !== 'all' && entry.status !== filters.status),
    )
  )
    throw bad();
  return value as unknown as AttendanceReport;
}
export type AttendanceAttempt = {
  path: string;
  body: Record<string, unknown>;
  operation: AttendanceOperation;
  userId: string;
  shiftId: string | null;
  before: AttendanceState | null;
  actorId: string;
};
const sameState = (a: AttendanceState | null, b: AttendanceState | null) =>
  a === null || b === null
    ? a === b
    : a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.voided === b.voided;
export function checkedAttendanceMutation(
  value: unknown,
  attempt: AttendanceAttempt,
): AttendanceMutation {
  if (!object(value)) throw bad();
  const shift = checkedAttendanceShift(value.shift, attempt.shiftId ?? undefined, attempt.userId);
  const event = checkedEvent(value.event, shift.id, attempt.userId);
  if (
    event.requestId !== attempt.body.requestId ||
    event.expectedRevision !== attempt.body.expectedRevision ||
    event.createdById !== attempt.actorId ||
    event.operation !== attempt.operation ||
    !sameState(event.before, attempt.before)
  )
    throw bad();
  const after = event.after;
  if (attempt.operation === 'clock-in') {
    if (
      after.startedAt > event.createdAt ||
      after.endedAt !== null ||
      after.voided ||
      shift.source !== 'clock' ||
      event.reason !== 'Self clock-in.'
    )
      throw bad();
  } else if (attempt.operation === 'clock-out') {
    if (
      after.startedAt !== attempt.before?.startedAt ||
      !after.endedAt ||
      after.endedAt > event.createdAt ||
      after.voided ||
      event.reason !== 'Self clock-out.'
    )
      throw bad();
  } else if (attempt.operation === 'void') {
    if (
      !after.voided ||
      after.startedAt !== attempt.before?.startedAt ||
      after.endedAt !== attempt.before?.endedAt ||
      event.reason !== attempt.body.reason
    )
      throw bad();
  } else if (
    after.startedAt !== attempt.body.startedAt ||
    after.endedAt !== attempt.body.endedAt ||
    after.voided ||
    event.reason !== attempt.body.reason ||
    (attempt.operation === 'manual-entry' && shift.source !== 'manual')
  )
    throw bad();
  return { shift, event };
}
export const attendanceState = (shift: AttendanceShift): AttendanceState => ({
  startedAt: shift.startedAt,
  endedAt: shift.endedAt,
  voided: shift.status === 'voided',
});

/** Keep each read and error attached to the exact current request. */
export function useAttendanceData<T>(path: string | null, check: (value: unknown) => T) {
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
    const id = ++generation.current;
    setState({ path, data: null, loading: !!path, error: '' });
    if (!path) return;
    try {
      const value = await api<unknown>(path);
      if (id !== generation.current || path !== current.current) return;
      setState({ path, data: validator.current(value), loading: false, error: '' });
    } catch (problem) {
      if (id === generation.current && path === current.current)
        setState({ path, data: null, loading: false, error: attendanceFailure(problem) });
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
