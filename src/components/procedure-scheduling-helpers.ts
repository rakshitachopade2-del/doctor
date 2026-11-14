import type {
  ProcedureAppointmentCandidate,
  ProcedureAppointmentSnapshot,
  ProcedureCandidatePage,
  ProcedureScheduleContext,
  ProcedureScheduleEvent,
  ProcedureScheduleMutation,
  ProcedureScheduleRow,
} from '../../shared/procedure-scheduling';
import { visitDate, visitTime } from './visit-duration-helpers';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const nullableId = (value: unknown) => value === null || text(value);
const bad = () =>
  new Error(
    'The procedure scheduling response could not be confirmed. Refresh the record or retry the same submitted request.',
  );
export function checkedProcedureAppointment(
  value: unknown,
  id?: string,
  patientId?: string,
): ProcedureAppointmentSnapshot {
  if (
    !object(value) ||
    !['id', 'patientId', 'doctorId', 'doctorName'].every((key) => text(value[key])) ||
    (id && value.id !== id) ||
    (patientId && value.patientId !== patientId) ||
    !visitDate(value.date) ||
    !visitTime(value.time) ||
    !['in-person', 'online'].includes(value.mode as string) ||
    !['scheduled', 'checked-in', 'in-consultation', 'completed', 'cancelled', 'no-show'].includes(
      value.status as string,
    ) ||
    !['schedule', 'custom'].includes(value.durationPolicy as string) ||
    !Number.isSafeInteger(value.durationMinutes) ||
    Number(value.durationMinutes) < 1 ||
    Number(value.durationMinutes) > 240
  )
    throw bad();
  const minutes = Number(value.durationMinutes);
  if (value.durationPolicy === 'custom' && (minutes < 15 || minutes % 5 !== 0)) throw bad();
  const [h, m] = value.time.split(':').map(Number);
  if (h * 60 + m + minutes > 1440) throw bad();
  return value as unknown as ProcedureAppointmentSnapshot;
}
export function checkedProcedureScheduleRow(value: unknown): ProcedureScheduleRow {
  if (
    !object(value) ||
    !['id', 'patientId', 'patientName', 'title', 'doctorId', 'doctorName'].every((key) =>
      text(value[key]),
    ) ||
    !['planned', 'completed', 'cancelled'].includes(value.status as string) ||
    !timestamp(value.createdAt) ||
    !nullableId(value.originalAppointmentId) ||
    !nullableId(value.effectiveAppointmentId) ||
    !['unlinked', 'linked', 'attention'].includes(value.schedulingState as string) ||
    typeof value.canChange !== 'boolean' ||
    !(value.blockedReason === null || text(value.blockedReason))
  )
    throw bad();
  if (value.appointment !== null)
    checkedProcedureAppointment(
      value.appointment,
      value.effectiveAppointmentId as string,
      value.patientId as string,
    );
  if (
    (value.effectiveAppointmentId === null &&
      (value.appointment !== null || value.schedulingState !== 'unlinked')) ||
    (value.effectiveAppointmentId !== null && value.schedulingState === 'unlinked') ||
    (value.canChange && value.status !== 'planned') ||
    (value.canChange ? value.blockedReason !== null : value.blockedReason === null)
  )
    throw bad();
  if (
    value.canChange &&
    value.appointment !== null &&
    ['checked-in', 'in-consultation', 'completed'].includes(
      (value.appointment as ProcedureAppointmentSnapshot).status,
    )
  )
    throw bad();
  const appointment = value.appointment as ProcedureAppointmentSnapshot | null;
  if (
    (value.effectiveAppointmentId !== null &&
      (!appointment || ['cancelled', 'no-show', 'completed'].includes(appointment.status)) &&
      value.schedulingState !== 'attention') ||
    (appointment &&
      ['checked-in', 'in-consultation'].includes(appointment.status) &&
      value.schedulingState !== 'linked') ||
    (value.canChange && appointment?.status === 'scheduled' && value.schedulingState !== 'linked')
  )
    throw bad();
  return value as unknown as ProcedureScheduleRow;
}
function checkedEvent(
  value: unknown,
  procedureId: string,
  patientId: string,
): ProcedureScheduleEvent {
  if (
    !object(value) ||
    !text(value.id) ||
    value.procedureId !== procedureId ||
    !['attach', 'replace', 'unlink'].includes(value.operation as string) ||
    !uuid(value.requestId) ||
    !revision(value.expectedRevision) ||
    !(value.expectedAppointmentRevision === null || revision(value.expectedAppointmentRevision)) ||
    !nullableId(value.beforeAppointmentId) ||
    !nullableId(value.afterAppointmentId) ||
    !text(value.reason) ||
    value.reason.length > 1000 ||
    !text(value.createdById) ||
    !text(value.createdByName) ||
    !['admin', 'doctor', 'receptionist'].includes(value.createdByRole as string) ||
    !timestamp(value.createdAt)
  )
    throw bad();
  if (value.beforeAppointmentId === null && value.beforeAppointment !== null) throw bad();
  if (value.beforeAppointment !== null)
    checkedProcedureAppointment(
      value.beforeAppointment,
      value.beforeAppointmentId as string,
      patientId,
    );
  if (value.afterAppointmentId === null) {
    if (
      value.afterAppointment !== null ||
      value.expectedAppointmentRevision !== null ||
      value.operation !== 'unlink' ||
      value.beforeAppointmentId === null
    )
      throw bad();
  } else {
    const after = checkedProcedureAppointment(
      value.afterAppointment,
      value.afterAppointmentId as string,
      patientId,
    );
    if (
      !revision(value.expectedAppointmentRevision) ||
      after.status !== 'scheduled' ||
      value.operation !== (value.beforeAppointmentId === null ? 'attach' : 'replace') ||
      value.beforeAppointmentId === value.afterAppointmentId
    )
      throw bad();
  }
  return value as unknown as ProcedureScheduleEvent;
}
export function checkedProcedureScheduleContext(
  value: unknown,
  id: string,
): ProcedureScheduleContext {
  if (!object(value) || !revision(value.revision) || !Array.isArray(value.history)) throw bad();
  const procedure = checkedProcedureScheduleRow(value.procedure);
  if (procedure.id !== id) throw bad();
  const history = value.history.map((event) => checkedEvent(event, id, procedure.patientId));
  if (
    new Set(history.map((event) => event.id)).size !== history.length ||
    new Set(history.map((event) => event.requestId)).size !== history.length ||
    procedure.effectiveAppointmentId !==
      (history.length ? history[0].afterAppointmentId : procedure.originalAppointmentId) ||
    history.some(
      (event, index) =>
        event.beforeAppointmentId !==
        (index === history.length - 1
          ? procedure.originalAppointmentId
          : history[index + 1].afterAppointmentId),
    )
  )
    throw bad();
  return { procedure, revision: value.revision, history };
}
export type CandidateQuery = { from: string; to: string; page: number };
export function checkedProcedureCandidates(
  value: unknown,
  source: ProcedureScheduleContext,
  query: CandidateQuery,
): ProcedureCandidatePage {
  if (
    !object(value) ||
    value.procedureId !== source.procedure.id ||
    value.from !== query.from ||
    value.to !== query.to ||
    !Array.isArray(value.items) ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < 0 ||
    value.pageSize !== 25 ||
    value.totalPages !== Math.max(1, Math.ceil(Number(value.total) / 25)) ||
    value.page !== Math.min(query.page, Number(value.totalPages)) ||
    value.items.length !==
      Math.min(25, Math.max(0, Number(value.total) - (Number(value.page) - 1) * 25))
  )
    throw bad();
  const ids: string[] = [];
  for (const item of value.items) {
    if (!object(item) || !revision(item.revision)) throw bad();
    const a = checkedProcedureAppointment(item.appointment, undefined, source.procedure.patientId);
    if (
      a.status !== 'scheduled' ||
      a.id === source.procedure.effectiveAppointmentId ||
      a.date < query.from ||
      a.date > query.to
    )
      throw bad();
    ids.push(a.id);
  }
  if (new Set(ids).size !== ids.length) throw bad();
  return value as unknown as ProcedureCandidatePage;
}
export const sameProcedureAppointment = (
  a: ProcedureAppointmentSnapshot | null,
  b: ProcedureAppointmentSnapshot | null,
) =>
  a === null || b === null
    ? a === b
    : [
        'id',
        'patientId',
        'doctorId',
        'doctorName',
        'date',
        'time',
        'mode',
        'status',
        'durationMinutes',
        'durationPolicy',
      ].every(
        (key) =>
          a[key as keyof ProcedureAppointmentSnapshot] ===
          b[key as keyof ProcedureAppointmentSnapshot],
      );
const sameEvent = (a: ProcedureScheduleEvent, b: ProcedureScheduleEvent) =>
  [
    'id',
    'procedureId',
    'operation',
    'requestId',
    'expectedRevision',
    'expectedAppointmentRevision',
    'beforeAppointmentId',
    'afterAppointmentId',
    'reason',
    'createdById',
    'createdByName',
    'createdByRole',
    'createdAt',
  ].every(
    (key) => a[key as keyof ProcedureScheduleEvent] === b[key as keyof ProcedureScheduleEvent],
  ) &&
  sameProcedureAppointment(a.beforeAppointment, b.beforeAppointment) &&
  sameProcedureAppointment(a.afterAppointment, b.afterAppointment);
export type ProcedureLinkPayload = {
  appointmentId: string | null;
  expectedAppointmentRevision: string | null;
  expectedRevision: string;
  requestId: string;
  reason: string;
  removeConfirmed?: true;
};
export type ProcedureLinkAttempt = {
  body: ProcedureLinkPayload;
  source: ProcedureScheduleContext;
  target: ProcedureAppointmentCandidate | null;
  actorId: string;
};
export function checkedProcedureScheduleMutation(
  value: unknown,
  attempt: ProcedureLinkAttempt,
): ProcedureScheduleMutation {
  if (!object(value)) throw bad();
  const context = checkedProcedureScheduleContext(value.context, attempt.source.procedure.id),
    event = checkedEvent(
      value.event,
      attempt.source.procedure.id,
      attempt.source.procedure.patientId,
    ),
    body = attempt.body;
  const operation =
    body.appointmentId === null
      ? 'unlink'
      : attempt.source.procedure.effectiveAppointmentId === null
        ? 'attach'
        : 'replace';
  if (
    context.procedure.patientId !== attempt.source.procedure.patientId ||
    context.procedure.originalAppointmentId !== attempt.source.procedure.originalAppointmentId ||
    event.operation !== operation ||
    event.requestId !== body.requestId ||
    event.expectedRevision !== body.expectedRevision ||
    event.expectedAppointmentRevision !== body.expectedAppointmentRevision ||
    event.createdById !== attempt.actorId ||
    event.reason !== body.reason.trim() ||
    event.beforeAppointmentId !== attempt.source.procedure.effectiveAppointmentId ||
    event.afterAppointmentId !== body.appointmentId ||
    !sameProcedureAppointment(event.beforeAppointment, attempt.source.procedure.appointment) ||
    !sameProcedureAppointment(event.afterAppointment, attempt.target?.appointment ?? null) ||
    !context.history.some((item) => sameEvent(item, event))
  )
    throw bad();
  return { context, event };
}
