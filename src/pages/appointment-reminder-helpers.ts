import type {
  AppointmentReminderCandidate,
  AppointmentReminderEvent,
  AppointmentReminderHistory,
  AppointmentReminderPage,
  AppointmentReminderPolicy,
  AppointmentReminderPolicyChange,
  AppointmentReminderPolicyContext,
  AppointmentReminderPolicyMutation,
  AppointmentReminderPreview,
  AppointmentReminderRun,
  AppointmentReminderRunSummary,
  AppointmentReminderSnapshot,
} from '../../shared/appointment-reminders';
import { visitDate, visitTime } from '../components/visit-duration-helpers';
export {
  useCancellationData as useReminderData,
  useCancellationGuard as useReminderGuard,
} from '../components/series-cancellation-helpers';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const stamp = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));
const optionalStamp = (v: unknown) => v === null || stamp(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : object(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, canonical(v[key])]),
        )
      : v;
export const sameReminderValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const bad = () =>
  new Error(
    'The reminder response could not be confirmed. Refresh the view or retry the same submitted request.',
  );
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw bad();
}
export const reminderFailure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The reminder request could not be confirmed. Please try again.';
export const reminderStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export function checkedReminderPolicy(v: unknown): AppointmentReminderPolicy {
  requireValue(
    object(v) &&
      typeof v.enabled === 'boolean' &&
      Number.isInteger(v.leadHours) &&
      Number(v.leadHours) >= 1 &&
      Number(v.leadHours) <= 168,
  );
  return { enabled: v.enabled, leadHours: Number(v.leadHours) };
}
export function checkedReminderPolicyChange(v: unknown): AppointmentReminderPolicyChange {
  requireValue(
    object(v) &&
      uuid(v.id) &&
      uuid(v.requestId) &&
      hash(v.expectedRevision) &&
      text(v.reason) &&
      v.reason === v.reason.trim() &&
      v.reason.length <= 1000 &&
      text(v.createdById) &&
      text(v.createdByName) &&
      v.createdByRole === 'admin' &&
      stamp(v.createdAt),
  );
  const before = checkedReminderPolicy(v.before),
    after = checkedReminderPolicy(v.after);
  requireValue(!sameReminderValue(before, after));
  return { ...(v as unknown as AppointmentReminderPolicyChange), before, after };
}
export function checkedReminderPolicyContext(v: unknown): AppointmentReminderPolicyContext {
  requireValue(
    object(v) &&
      hash(v.revision) &&
      object(v.worker) &&
      typeof v.worker.automaticEnabled === 'boolean' &&
      v.worker.intervalSeconds === 300 &&
      v.worker.batchLimit === 200 &&
      optionalStamp(v.worker.lastCheckedAt) &&
      optionalStamp(v.worker.lastErrorAt) &&
      (v.worker.lastRunId === null || uuid(v.worker.lastRunId)),
  );
  const policy = checkedReminderPolicy(v.policy),
    latestChange = v.latestChange === null ? null : checkedReminderPolicyChange(v.latestChange);
  if (latestChange) requireValue(sameReminderValue(latestChange.after, policy));
  else requireValue(!policy.enabled && policy.leadHours === 24);
  return {
    policy,
    revision: String(v.revision),
    latestChange,
    worker: v.worker as unknown as AppointmentReminderPolicyContext['worker'],
  };
}
export interface ReminderPolicyAttempt {
  source: AppointmentReminderPolicyContext;
  actorId: string;
  body: AppointmentReminderPolicy & { reason: string; expectedRevision: string; requestId: string };
}
export function checkedReminderPolicyMutation(
  v: unknown,
  sent: ReminderPolicyAttempt,
): AppointmentReminderPolicyMutation {
  requireValue(object(v));
  const context = checkedReminderPolicyContext(v.context),
    change = checkedReminderPolicyChange(v.change);
  requireValue(
    change.requestId === sent.body.requestId &&
      change.expectedRevision === sent.body.expectedRevision &&
      change.createdById === sent.actorId &&
      change.reason === sent.body.reason &&
      sameReminderValue(change.before, sent.source.policy) &&
      sameReminderValue(change.after, {
        enabled: sent.body.enabled,
        leadHours: sent.body.leadHours,
      }),
  );
  return { context, change };
}
export function checkedReminderAppointment(v: unknown, id?: string): AppointmentReminderSnapshot {
  requireValue(
    object(v) &&
      ['id', 'patientId', 'patientName', 'doctorId', 'doctorName'].every((key) => text(v[key])) &&
      (!id || v.id === id) &&
      visitDate(v.date) &&
      visitTime(v.time) &&
      ['in-person', 'online'].includes(v.mode as string) &&
      Number.isInteger(v.durationMinutes) &&
      Number(v.durationMinutes) >= 1 &&
      Number(v.durationMinutes) <= 240 &&
      ['scheduled', 'checked-in', 'in-consultation', 'completed', 'cancelled', 'no-show'].includes(
        v.status as string,
      ),
  );
  const [hours, minutes] = String(v.time).split(':').map(Number);
  requireValue(hours * 60 + minutes + Number(v.durationMinutes) <= 1440);
  return v as unknown as AppointmentReminderSnapshot;
}
function checkedRecipient(v: unknown): AppointmentReminderCandidate['recipient'] {
  requireValue(object(v) && text(v.id) && text(v.name));
  return { id: v.id, name: v.name };
}
function checkedCandidate(
  v: unknown,
  policy: AppointmentReminderPolicy,
): AppointmentReminderCandidate {
  requireValue(object(v) && hash(v.episodeId) && stamp(v.startAt) && stamp(v.dueAt));
  const appointment = checkedReminderAppointment(v.appointment),
    recipient = checkedRecipient(v.recipient);
  requireValue(
    appointment.status === 'scheduled' &&
      Date.parse(v.startAt) === Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) &&
      Date.parse(v.dueAt) === Date.parse(v.startAt) - policy.leadHours * 3600000,
  );
  return {
    episodeId: String(v.episodeId),
    appointment,
    recipient,
    startAt: v.startAt,
    dueAt: v.dueAt,
  };
}
export function checkedReminderPreview(v: unknown): AppointmentReminderPreview {
  requireValue(
    object(v) &&
      hash(v.policyRevision) &&
      hash(v.revision) &&
      stamp(v.generatedAt) &&
      stamp(v.windowEndAt) &&
      visitDate(v.clinicDate) &&
      v.batchLimit === 200 &&
      ['upcomingAppointmentTotal', 'readyTotal', 'unroutableTotal', 'alreadyRecordedTotal'].every(
        (key) => count(v[key]),
      ) &&
      Array.isArray(v.items),
  );
  const policy = checkedReminderPolicy(v.policy),
    items = v.items.map((item) => checkedCandidate(item, policy));
  if (!policy.enabled) requireValue(v.readyTotal === 0 && items.length === 0);
  requireValue(
    v.status === (policy.enabled ? 'ready' : 'disabled') &&
      Date.parse(v.windowEndAt) === Date.parse(v.generatedAt) + policy.leadHours * 3600000 &&
      v.clinicDate ===
        new Date(Date.parse(v.generatedAt) + 330 * 60000).toISOString().slice(0, 10) &&
      items.length === Math.min(200, Number(v.readyTotal)) &&
      new Set(items.map((item) => `${item.episodeId}:${item.recipient.id}`)).size ===
        items.length &&
      items.every(
        (item) =>
          Date.parse(item.startAt) > Date.parse(String(v.generatedAt)) &&
          Date.parse(item.startAt) <= Date.parse(String(v.windowEndAt)),
      ),
  );
  return { ...(v as unknown as AppointmentReminderPreview), policy, items };
}
export function checkedReminderEvent(v: unknown): AppointmentReminderEvent {
  requireValue(
    object(v) &&
      uuid(v.id) &&
      uuid(v.runId) &&
      ['manual', 'automatic'].includes(v.source as string) &&
      hash(v.policyRevision) &&
      stamp(v.createdAt),
  );
  const policy = checkedReminderPolicy(v.policy);
  requireValue(policy.enabled);
  const candidate = checkedCandidate(v, policy);
  return {
    ...candidate,
    id: String(v.id),
    runId: String(v.runId),
    source: v.source as AppointmentReminderEvent['source'],
    policy,
    policyRevision: String(v.policyRevision),
    createdAt: String(v.createdAt),
  };
}
export function checkedReminderRunSummary(v: unknown): AppointmentReminderRunSummary {
  requireValue(
    object(v) &&
      uuid(v.id) &&
      ['manual', 'automatic'].includes(v.source as string) &&
      text(v.createdByName) &&
      stamp(v.createdAt) &&
      stamp(v.checkedAt) &&
      hash(v.previewRevision) &&
      hash(v.policyRevision) &&
      ['noticeCount', 'remainingReady', 'unroutableTotal', 'alreadyRecordedTotal'].every((key) =>
        count(v[key]),
      ) &&
      Number(v.noticeCount) >= 1 &&
      Number(v.noticeCount) <= 200,
  );
  requireValue(
    v.source === 'manual'
      ? uuid(v.requestId) && text(v.createdById)
      : v.requestId === null && v.createdById === null,
  );
  const policy = checkedReminderPolicy(v.policy);
  requireValue(policy.enabled);
  return { ...(v as unknown as AppointmentReminderRunSummary), policy };
}
export function checkedReminderRun(v: unknown, id?: string): AppointmentReminderRun {
  const summary = checkedReminderRunSummary(v);
  requireValue(object(v) && (!id || summary.id === id) && Array.isArray(v.events));
  const events = v.events.map(checkedReminderEvent);
  requireValue(
    events.length === summary.noticeCount &&
      new Set(events.map((event) => event.id)).size === events.length &&
      new Set(events.map((event) => `${event.episodeId}:${event.recipient.id}`)).size ===
        events.length &&
      events.every(
        (event) =>
          event.runId === summary.id &&
          event.source === summary.source &&
          event.createdAt === summary.createdAt &&
          event.policyRevision === summary.policyRevision &&
          sameReminderValue(event.policy, summary.policy) &&
          Date.parse(event.startAt) > Date.parse(summary.checkedAt) &&
          Date.parse(event.dueAt) <= Date.parse(summary.checkedAt),
      ),
  );
  return { ...summary, events };
}
export interface ReminderRunAttempt {
  preview: AppointmentReminderPreview;
  actorId: string;
  body: {
    expectedPreviewRevision: string;
    expectedPolicyRevision: string;
    confirmed: true;
    requestId: string;
  };
}
export function checkedReminderRunReceipt(
  v: unknown,
  sent: ReminderRunAttempt,
): AppointmentReminderRun {
  const run = checkedReminderRun(v);
  requireValue(
    sent.preview.status === 'ready' &&
      run.source === 'manual' &&
      run.requestId === sent.body.requestId &&
      run.createdById === sent.actorId &&
      run.previewRevision === sent.body.expectedPreviewRevision &&
      run.policyRevision === sent.body.expectedPolicyRevision &&
      sameReminderValue(run.policy, sent.preview.policy) &&
      run.noticeCount === sent.preview.items.length &&
      run.remainingReady === sent.preview.readyTotal - sent.preview.items.length &&
      run.unroutableTotal === sent.preview.unroutableTotal &&
      run.alreadyRecordedTotal === sent.preview.alreadyRecordedTotal,
  );
  requireValue(
    run.events.every((event, index) => {
      const candidate = sent.preview.items[index];
      return sameReminderValue(
        {
          episodeId: event.episodeId,
          appointment: event.appointment,
          recipient: event.recipient,
          startAt: event.startAt,
          dueAt: event.dueAt,
        },
        candidate,
      );
    }),
  );
  return run;
}
export function checkedReminderPage<T>(
  v: unknown,
  page: number,
  check: (value: unknown) => T,
): AppointmentReminderPage<T> {
  requireValue(
    object(v) &&
      count(v.total) &&
      v.pageSize === 25 &&
      v.totalPages === Math.max(1, Math.ceil(Number(v.total) / 25)) &&
      v.page === Math.min(page, Number(v.totalPages)) &&
      Array.isArray(v.items) &&
      v.items.length === Math.min(25, Math.max(0, Number(v.total) - (Number(v.page) - 1) * 25)),
  );
  const items = v.items.map(check);
  requireValue(
    new Set(v.items.map((item) => (object(item) ? item.id : null))).size === items.length,
  );
  return {
    items,
    page: Number(v.page),
    pageSize: 25,
    total: Number(v.total),
    totalPages: Number(v.totalPages),
  };
}
export function checkedReminderHistory(
  v: unknown,
  appointmentId: string,
  page: number,
): AppointmentReminderHistory {
  const history = checkedReminderPage(v, page, checkedReminderEvent);
  requireValue(object(v) && object(v.current));
  const appointment = checkedReminderAppointment(v.appointment, appointmentId),
    current = v.current;
  requireValue(
    ['disabled', 'not-scheduled', 'past', 'not-due', 'no-recipient', 'recorded', 'ready'].includes(
      current.state as string,
    ) &&
      hash(current.episodeId) &&
      stamp(current.startAt) &&
      stamp(current.dueAt) &&
      optionalStamp(current.recordedAt) &&
      Date.parse(current.startAt) ===
        Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) &&
      Date.parse(current.dueAt) < Date.parse(current.startAt),
  );
  const recipient = current.recipient === null ? null : checkedRecipient(current.recipient);
  requireValue(history.items.every((event) => event.appointment.id === appointmentId));
  if (current.state === 'recorded') requireValue(recipient && stamp(current.recordedAt));
  if (current.state === 'ready')
    requireValue(recipient && current.recordedAt === null && appointment.status === 'scheduled');
  if (current.state === 'no-recipient') requireValue(recipient === null);
  return {
    ...history,
    appointment,
    current: { ...(current as unknown as AppointmentReminderHistory['current']), recipient },
  };
}
