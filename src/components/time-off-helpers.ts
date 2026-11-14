import type { ScheduleClosure } from '../../shared/scheduling';
import type {
  TimeOffCancelInput,
  TimeOffChange,
  TimeOffContext,
  TimeOffCreateInput,
  TimeOffEditInput,
  TimeOffEditValues,
  TimeOffHistory,
  TimeOffMutation,
  TimeOffPage,
  TimeOffSnapshot,
  TimeOffValues,
} from '../../shared/time-off';
export {
  useCancellationData as useTimeOffData,
  useCancellationGuard as useTimeOffGuard,
} from './series-cancellation-helpers';
export type TimeOffFilter = 'upcoming' | 'past' | 'cancelled' | 'all';
export const timeOffFailure = (value: unknown) =>
  value instanceof Error
    ? value.message
    : 'The time-off response could not be confirmed. Please retry the same request.';
export const timeOffStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const nonempty = (v: unknown): v is string => text(v) && !!v.trim();
const id = (v: unknown): v is string => nonempty(v) && v.length <= 300;
const hash = (v: unknown) => text(v) && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  text(v) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const stamp = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const date = (v: unknown): v is string =>
  text(v) &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T12:00:00Z`)) &&
  new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
const time = (v: unknown): v is string => text(v) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
function check(condition: unknown): asserts condition {
  if (!condition)
    throw new Error(
      'The time-off response could not be confirmed. Refresh the view or retry the exact submitted request.',
    );
}
function canonical(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(canonical)
    : object(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, canonical(v[key])]),
        )
      : v;
}
export const sameTimeOff = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function timeOffValues(value: ScheduleClosure | TimeOffValues): TimeOffValues {
  return {
    doctorId: value.doctorId,
    startDate: value.startDate,
    endDate: value.endDate,
    startTime: value.startTime,
    endTime: value.endTime,
    reason: value.reason.trim(),
  };
}
export function timeOffEditValues(value: TimeOffValues): TimeOffEditValues {
  const { doctorId: _doctorId, ...fields } = timeOffValues(value);
  return fields;
}
export function timeOffValidation(value: TimeOffValues, today: string) {
  if (!value.reason.trim()) return 'Enter a reason for this time off.';
  if (!date(value.startDate) || !date(value.endDate)) return 'Choose real first and last dates.';
  if (value.endDate < value.startDate) return 'The last day must be on or after the first day.';
  if (value.endDate < today) return 'Closures must include today or a future date.';
  if (value.startTime !== null || value.endTime !== null) {
    if (!time(value.startTime) || !time(value.endTime) || value.startTime >= value.endTime)
      return 'The end time must be later than the start time on the same day.';
  }
  return '';
}
function checkedClosure(value: unknown, expectedId?: string): ScheduleClosure {
  check(
    object(value) &&
      id(value.id) &&
      (!expectedId || value.id === expectedId) &&
      (value.doctorId === null || id(value.doctorId)) &&
      date(value.startDate) &&
      date(value.endDate) &&
      value.endDate >= value.startDate &&
      nonempty(value.reason) &&
      value.reason.length <= 300 &&
      stamp(value.createdAt),
  );
  check(
    (value.startTime === null && value.endTime === null) ||
      (time(value.startTime) && time(value.endTime) && value.startTime < value.endTime),
  );
  return {
    id: value.id,
    doctorId: value.doctorId,
    startDate: value.startDate,
    endDate: value.endDate,
    startTime: value.startTime as string | null,
    endTime: value.endTime as string | null,
    reason: value.reason,
    createdAt: value.createdAt as string,
  };
}
function checkedSnapshot(value: unknown, closureId?: string): TimeOffSnapshot {
  check(object(value) && (value.status === 'active' || value.status === 'cancelled'));
  return { closure: checkedClosure(value.closure, closureId), status: value.status };
}
export function checkedTimeOffChange(value: unknown, closureId?: string): TimeOffChange {
  check(
    object(value) &&
      uuid(value.id) &&
      id(value.closureId) &&
      (!closureId || value.closureId === closureId) &&
      (value.doctorId === null
        ? value.doctorName === null
        : id(value.doctorId) && nonempty(value.doctorName)) &&
      ['reviewed', 'legacy'].includes(value.source as string) &&
      ['created', 'edited', 'cancelled'].includes(value.action as string) &&
      nonempty(value.createdByName) &&
      ['admin', 'doctor'].includes(value.createdByRole as string) &&
      stamp(value.createdAt),
  );
  check(
    value.source === 'legacy' || value.action === 'created'
      ? value.changeReason === null
      : nonempty(value.changeReason) &&
          value.changeReason === value.changeReason.trim() &&
          value.changeReason.length <= 1000,
  );
  const after = checkedSnapshot(value.after, value.closureId),
    before = value.before === null ? null : checkedSnapshot(value.before, value.closureId);
  check(after.closure.doctorId === value.doctorId);
  if (value.action === 'created') check(before === null && after.status === 'active');
  else {
    check(
      before &&
        before.status === 'active' &&
        before.closure.doctorId === after.closure.doctorId &&
        before.closure.createdAt === after.closure.createdAt,
    );
    if (value.action === 'edited')
      check(after.status === 'active' && !sameTimeOff(before.closure, after.closure));
    else check(after.status === 'cancelled' && sameTimeOff(before.closure, after.closure));
  }
  return { ...value, before, after } as TimeOffChange;
}
export function checkedTimeOffContext(value: unknown, closureId: string): TimeOffContext {
  check(object(value) && hash(value.revision));
  const snapshot = checkedSnapshot(value, closureId);
  check(
    snapshot.closure.doctorId === null
      ? value.doctor === null
      : object(value.doctor) &&
          value.doctor.id === snapshot.closure.doctorId &&
          nonempty(value.doctor.name),
  );
  const latestChange =
    value.latestChange === null ? null : checkedTimeOffChange(value.latestChange, closureId);
  check(!latestChange || sameTimeOff(latestChange.after, snapshot));
  return {
    ...snapshot,
    doctor: value.doctor as TimeOffContext['doctor'],
    revision: value.revision as string,
    latestChange,
  };
}
export interface TimeOffAttempt {
  operation: 'create' | 'edit' | 'cancel';
  actorId: string;
  actorRole: 'admin' | 'doctor';
  source: TimeOffContext | null;
  body: TimeOffCreateInput | TimeOffEditInput | TimeOffCancelInput;
}
export function checkedTimeOffMutation(value: unknown, sent: TimeOffAttempt): TimeOffMutation {
  check(object(value) && object(value.receipt));
  const receipt = value.receipt;
  check(id(receipt.closureId));
  const context = checkedTimeOffContext(value.context, receipt.closureId),
    change = checkedTimeOffChange(value.change, receipt.closureId);
  check(
    receipt.requestId === sent.body.requestId &&
      receipt.actorId === sent.actorId &&
      receipt.operation === sent.operation &&
      receipt.changeId === change.id &&
      receipt.expectedRevision ===
        ('expectedRevision' in sent.body ? sent.body.expectedRevision : null) &&
      change.source === 'reviewed' &&
      change.createdByRole === sent.actorRole &&
      change.action ===
        ({ create: 'created', edit: 'edited', cancel: 'cancelled' } as const)[sent.operation],
  );
  if (sent.operation === 'create') {
    check(
      'closure' in sent.body &&
        'doctorId' in sent.body.closure &&
        change.before === null &&
        sameTimeOff(timeOffValues(change.after.closure), sent.body.closure) &&
        change.changeReason === null,
    );
  } else {
    check(
      sent.source &&
        receipt.closureId === sent.source.closure.id &&
        sameTimeOff(change.before, { closure: sent.source.closure, status: sent.source.status }) &&
        'changeReason' in sent.body &&
        change.changeReason === sent.body.changeReason &&
        context.revision !== sent.source.revision &&
        change.id !== sent.source.latestChange?.id,
    );
    if (sent.operation === 'edit')
      check(
        'closure' in sent.body &&
          sameTimeOff(timeOffEditValues(change.after.closure), sent.body.closure),
      );
  }
  check(
    context.latestChange !== null &&
      context.closure.doctorId === change.doctorId &&
      context.closure.createdAt === change.after.closure.createdAt,
  );
  return { context, change, receipt: receipt as unknown as TimeOffMutation['receipt'] };
}
function pageMetadata(
  value: unknown,
  page: number,
): asserts value is Record<string, unknown> & { items: unknown[] } {
  check(
    object(value) &&
      count(value.total) &&
      value.pageSize === 25 &&
      value.totalPages === Math.max(1, Math.ceil(Number(value.total) / 25)) &&
      value.page === Math.min(page, Number(value.totalPages)) &&
      Array.isArray(value.items) &&
      value.items.length ===
        Math.min(25, Math.max(0, Number(value.total) - (Number(value.page) - 1) * 25)),
  );
}
export function checkedTimeOffPage(
  value: unknown,
  doctorId: string,
  filter: TimeOffFilter,
  page: number,
): TimeOffPage {
  pageMetadata(value, page);
  const items = value.items.map((row) => checkedSnapshot(row));
  check(
    new Set(items.map((row) => row.closure.id)).size === items.length &&
      items.every(
        (row) =>
          (row.closure.doctorId === null || row.closure.doctorId === doctorId) &&
          (filter === 'all' ||
            (filter === 'cancelled' ? row.status === 'cancelled' : row.status === 'active')),
      ),
  );
  const sorted = [...items].sort(
    (a, b) =>
      (a.closure.startDate < b.closure.startDate
        ? -1
        : a.closure.startDate > b.closure.startDate
          ? 1
          : a.closure.id < b.closure.id
            ? -1
            : a.closure.id > b.closure.id
              ? 1
              : 0) * (filter === 'upcoming' ? 1 : -1),
  );
  check(sameTimeOff(items, sorted));
  return {
    items,
    page: Number(value.page),
    pageSize: 25,
    total: Number(value.total),
    totalPages: Number(value.totalPages),
  };
}
export function checkedTimeOffHistory(
  value: unknown,
  closureId: string,
  page: number,
): TimeOffHistory {
  pageMetadata(value, page);
  const items = value.items.map((row) => checkedTimeOffChange(row, closureId));
  check(new Set(items.map((row) => row.id)).size === items.length);
  return {
    items,
    page: Number(value.page),
    pageSize: 25,
    total: Number(value.total),
    totalPages: Number(value.totalPages),
  };
}
