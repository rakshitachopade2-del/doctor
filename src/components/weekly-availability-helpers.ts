import type { DoctorSchedule, ScheduleWindow } from '../../shared/scheduling';
import type {
  WeeklyAvailabilityChange,
  WeeklyAvailabilityContext,
  WeeklyAvailabilityHistory,
  WeeklyAvailabilityInput,
  WeeklyAvailabilityMutation,
  WeeklyAvailabilitySnapshot,
  WeeklyAvailabilityValues,
} from '../../shared/weekly-availability';
export {
  useCancellationData as useWeeklyData,
  useCancellationGuard as useWeeklyGuard,
} from './series-cancellation-helpers';

export const weekdays = [
  { day: 1, name: 'Monday' },
  { day: 2, name: 'Tuesday' },
  { day: 3, name: 'Wednesday' },
  { day: 4, name: 'Thursday' },
  { day: 5, name: 'Friday' },
  { day: 6, name: 'Saturday' },
  { day: 0, name: 'Sunday' },
];
export const minutes = (value: string) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
export const clock = (value: number) =>
  `${Math.floor(value / 60)
    .toString()
    .padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
export const sortedWindows = (values: ScheduleWindow[]) =>
  [...values].sort(
    (a, b) =>
      a.day - b.day ||
      a.start.localeCompare(b.start) ||
      a.end.localeCompare(b.end) ||
      a.mode.localeCompare(b.mode),
  );
export const weeklyValues = (value: WeeklyAvailabilityValues): WeeklyAvailabilityValues => ({
  durationMinutes: value.durationMinutes,
  windows: sortedWindows(value.windows).map(({ day, start, end, mode }) => ({
    day,
    start,
    end,
    mode,
  })),
});
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && !!value.trim();
const hash = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  text(value) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const time = (value: unknown): value is string =>
  text(value) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function check(condition: unknown): asserts condition {
  if (!condition)
    throw new Error(
      'The weekly availability response could not be confirmed. Refresh the view or retry the exact saved request.',
    );
}
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
}
export const sameWeekly = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const sameWeeklyValues = (a: WeeklyAvailabilityValues, b: WeeklyAvailabilityValues) =>
  sameWeekly(weeklyValues(a), weeklyValues(b));
export const weeklyFailure = (value: unknown) =>
  value instanceof Error
    ? value.message
    : 'The save outcome could not be confirmed. Retry the same request.';
export const weeklyStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
export function validateWeeklyDraft(value: WeeklyAvailabilityValues) {
  if (value.windows.length > 70) return 'A weekly schedule can contain at most 70 sessions.';
  for (const day of weekdays) {
    const rows = sortedWindows(value.windows.filter((window) => window.day === day.day));
    if (
      rows.some(
        (window) =>
          !time(window.start) ||
          !time(window.end) ||
          minutes(window.end) - minutes(window.start) < value.durationMinutes,
      )
    )
      return `${day.name}: each session must have room for at least one ${value.durationMinutes}-minute appointment.`;
    if (rows.some((window, index) => index > 0 && window.start < rows[index - 1].end))
      return `${day.name}: sessions must not overlap. Leave a gap between sessions for a break.`;
  }
  return '';
}
function checkedSchedule(value: unknown, doctorId: string): DoctorSchedule {
  check(
    object(value) &&
      value.doctorId === doctorId &&
      typeof value.durationMinutes === 'number' &&
      [15, 20, 30, 45, 60].includes(value.durationMinutes) &&
      Array.isArray(value.windows) &&
      value.windows.length <= 70 &&
      (value.updatedAt === '' || timestamp(value.updatedAt)),
  );
  const windows = value.windows.map((window): ScheduleWindow => {
    check(
      object(window) &&
        typeof window.day === 'number' &&
        Number.isInteger(window.day) &&
        window.day >= 0 &&
        window.day <= 6 &&
        time(window.start) &&
        time(window.end) &&
        ['in-person', 'online', 'both'].includes(window.mode as string),
    );
    return {
      day: window.day,
      start: window.start,
      end: window.end,
      mode: window.mode as ScheduleWindow['mode'],
    };
  });
  const schedule: DoctorSchedule = {
    doctorId,
    durationMinutes: value.durationMinutes as DoctorSchedule['durationMinutes'],
    windows: sortedWindows(windows),
    updatedAt: value.updatedAt as string,
  };
  check(!validateWeeklyDraft(schedule));
  return schedule;
}
function checkedSnapshot(value: unknown, doctorId: string): WeeklyAvailabilitySnapshot {
  check(object(value) && (value.source === 'inherited' || value.source === 'explicit'));
  const schedule = checkedSchedule(value.schedule, doctorId);
  if (value.source === 'inherited')
    check(
      schedule.updatedAt === '' &&
        sameWeeklyValues(schedule, {
          durationMinutes: 30,
          windows: [1, 2, 3, 4, 5, 6].map((day) => ({
            day,
            start: '09:00',
            end: '18:00',
            mode: 'both',
          })),
        }),
    );
  else check(timestamp(schedule.updatedAt));
  return { source: value.source, schedule };
}
export function checkedWeeklyChange(value: unknown, doctorId: string): WeeklyAvailabilityChange {
  check(
    object(value) &&
      uuid(value.id) &&
      value.doctorId === doctorId &&
      nonempty(value.doctorName) &&
      (value.source === 'reviewed' || value.source === 'legacy') &&
      nonempty(value.createdByName) &&
      ['admin', 'doctor'].includes(value.createdByRole as string) &&
      timestamp(value.createdAt),
  );
  check(
    value.source === 'legacy'
      ? value.reason === null
      : nonempty(value.reason) &&
          value.reason === value.reason.trim() &&
          value.reason.length <= 1000,
  );
  const before = checkedSnapshot(value.before, doctorId),
    after = checkedSnapshot(value.after, doctorId);
  check(
    after.source === 'explicit' &&
      (before.source === 'inherited' || !sameWeeklyValues(before.schedule, after.schedule)),
  );
  return { ...value, before, after } as WeeklyAvailabilityChange;
}
export function checkedWeeklyContext(value: unknown, doctorId: string): WeeklyAvailabilityContext {
  check(
    object(value) &&
      object(value.doctor) &&
      value.doctor.id === doctorId &&
      nonempty(value.doctor.name) &&
      hash(value.revision),
  );
  const snapshot = checkedSnapshot(value, doctorId),
    latestChange =
      value.latestChange === null ? null : checkedWeeklyChange(value.latestChange, doctorId);
  check(
    !latestChange ||
      (latestChange.after.source === snapshot.source &&
        sameWeeklyValues(latestChange.after.schedule, snapshot.schedule)),
  );
  check(snapshot.source !== 'inherited' || latestChange === null);
  return {
    ...snapshot,
    doctor: { id: doctorId, name: value.doctor.name },
    revision: value.revision as string,
    latestChange,
  };
}
export interface WeeklyAttempt {
  source: WeeklyAvailabilityContext;
  actorId: string;
  actorRole: 'admin' | 'doctor';
  body: WeeklyAvailabilityInput;
}
export function checkedWeeklyMutation(
  value: unknown,
  sent: WeeklyAttempt,
): WeeklyAvailabilityMutation {
  check(object(value) && object(value.receipt));
  const doctorId = sent.source.doctor.id,
    context = checkedWeeklyContext(value.context, doctorId),
    change = checkedWeeklyChange(value.change, doctorId),
    receipt = value.receipt;
  check(
    receipt.requestId === sent.body.requestId &&
      receipt.actorId === sent.actorId &&
      receipt.doctorId === doctorId &&
      receipt.expectedRevision === sent.body.expectedRevision &&
      receipt.changeId === change.id &&
      change.source === 'reviewed' &&
      change.createdByRole === sent.actorRole &&
      change.reason === sent.body.reason &&
      change.before.source === sent.source.source &&
      sameWeeklyValues(change.before.schedule, sent.source.schedule) &&
      sameWeeklyValues(change.after.schedule, sent.body.schedule) &&
      change.id !== sent.source.latestChange?.id &&
      context.revision !== sent.source.revision,
  );
  return { context, change, receipt: receipt as unknown as WeeklyAvailabilityMutation['receipt'] };
}
export function checkedWeeklyHistory(
  value: unknown,
  doctorId: string,
  page: number,
): WeeklyAvailabilityHistory {
  check(
    object(value) &&
      count(value.total) &&
      value.pageSize === 25 &&
      value.totalPages === Math.max(1, Math.ceil(Number(value.total) / 25)) &&
      value.page === Math.min(page, Number(value.totalPages)) &&
      Array.isArray(value.items),
  );
  const items = value.items.map((row) => checkedWeeklyChange(row, doctorId));
  check(
    items.length ===
      Math.min(25, Math.max(0, Number(value.total) - (Number(value.page) - 1) * 25)) &&
      new Set(items.map((row) => row.id)).size === items.length,
  );
  return {
    items,
    page: Number(value.page),
    pageSize: 25,
    total: Number(value.total),
    totalPages: Number(value.totalPages),
  };
}
