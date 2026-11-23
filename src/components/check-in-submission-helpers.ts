import type { CheckInSubmissionCommand } from '../../shared/check-in-submission';
import type { CheckIn } from '../../shared/types';
import { ApiError } from '../lib';

export type CheckInAnswers = Pick<CheckIn, 'adherence' | 'feeling' | 'note'>;
export const adherenceLabels = {
  taken: 'I followed my plan',
  partial: 'I followed part of my plan',
  missed: 'I missed my plan today',
} satisfies Record<CheckIn['adherence'], string>;
export const feelingLabels = {
  better: 'Better',
  same: 'About the same',
  worse: 'Worse',
} satisfies Record<CheckIn['feeling'], string>;

export interface CheckInSource {
  patientId: string;
  carePlanId: string;
  date: string;
  planTitle: string;
  existing: CheckIn | null;
  existingIds: string[];
}

export interface ReviewedCheckIn {
  command: CheckInSubmissionCommand;
  source: CheckInSource;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const uuid = (value: string) =>
  /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(value);

export function isReport(value: unknown, patientId: string): value is CheckIn {
  return (
    object(value) &&
    nonempty(value.id) &&
    value.patientId === patientId &&
    nonempty(value.carePlanId) &&
    date(value.date) &&
    timestamp(value.createdAt) &&
    typeof value.adherence === 'string' &&
    Object.hasOwn(adherenceLabels, value.adherence) &&
    typeof value.feeling === 'string' &&
    Object.hasOwn(feelingLabels, value.feeling) &&
    typeof value.note === 'string'
  );
}

/** A missing or ambiguous supporting response must never turn a correction into a creation. */
export function readCheckInSource(
  value: unknown,
  patientId: string,
  carePlanId: string,
  day: string,
  fallbackTitle: string,
) {
  const invalid = () =>
    new Error('We could not confirm the care plan and its current report. Please try again.');
  if (
    !object(value) ||
    !object(value.patient) ||
    value.patient.id !== patientId ||
    !date(day) ||
    !Array.isArray(value.carePlans) ||
    !Array.isArray(value.checkIns) ||
    !value.checkIns.every((entry) => isReport(entry, patientId)) ||
    !value.carePlans.every(
      (plan) => object(plan) && plan.patientId === patientId && nonempty(plan.id),
    )
  )
    throw invalid();
  const plans = value.carePlans.filter((plan) => plan.id === carePlanId);
  const reports = value.checkIns.filter(
    (entry) => entry.carePlanId === carePlanId && entry.date === day,
  );
  const existingIds = value.checkIns.map((entry) => entry.id);
  if (plans.length > 1 || reports.length > 1 || new Set(existingIds).size !== existingIds.length)
    throw invalid();
  const plan = plans[0];
  if (
    plan &&
    (!nonempty(plan.title) ||
      !date(plan.startDate) ||
      !date(plan.endDate) ||
      plan.endDate < plan.startDate ||
      !['active', 'completed'].includes(plan.status) ||
      (plan.effectiveStatus !== undefined &&
        !['active', 'completed'].includes(plan.effectiveStatus)))
  )
    throw invalid();
  const source: CheckInSource = {
    patientId,
    carePlanId,
    date: day,
    planTitle: plan?.title ?? fallbackTitle,
    existing: reports[0] ?? null,
    existingIds,
  };
  return {
    source,
    plan: plan
      ? {
          active: (plan.effectiveStatus ?? plan.status) === 'active',
          startDate: String(plan.startDate),
          endDate: String(plan.endDate),
        }
      : null,
  };
}

/** Each plan/day keeps one row. Identical versions must describe identical answers. */
export function confirmReportContinuity(source: CheckInSource, known: CheckIn | null) {
  if (!known) return;
  const fresh = source.existing;
  if (
    !fresh ||
    fresh.id !== known.id ||
    fresh.createdAt < known.createdAt ||
    (fresh.createdAt === known.createdAt &&
      (fresh.adherence !== known.adherence ||
        fresh.feeling !== known.feeling ||
        fresh.note !== known.note))
  )
    throw new Error('We could not confirm the current report.');
}

export function confirmedCheckIn(
  value: unknown,
  attempt: ReviewedCheckIn,
  actorId: string,
): CheckIn | null {
  if (!object(value) || Object.keys(value).length !== 1 || !object(value.receipt)) return null;
  const { receipt } = value;
  const { command, source } = attempt;
  const report = receipt.checkIn;
  if (
    Object.keys(receipt).length !== 8 ||
    receipt.requestId !== command.requestId ||
    receipt.actorId !== actorId ||
    receipt.patientId !== command.patientId ||
    receipt.carePlanId !== command.carePlanId ||
    receipt.date !== command.date ||
    receipt.expectedUpdatedAt !== command.expectedUpdatedAt ||
    receipt.operation !== (source.existing ? 'corrected' : 'created') ||
    !isReport(report, command.patientId) ||
    Object.keys(report).length !== 8 ||
    report.date !== command.date ||
    report.carePlanId !== command.carePlanId ||
    report.adherence !== command.adherence ||
    report.feeling !== command.feeling ||
    report.note !== command.note ||
    Date.parse(report.createdAt) < Date.parse(command.date + 'T00:00:00+05:30') ||
    (source.existing
      ? report.id !== source.existing.id || report.createdAt <= source.existing.createdAt
      : !uuid(report.id) ||
        source.existingIds.includes(report.id) ||
        report.id === command.requestId)
  )
    return null;
  return report;
}

export function checkInRejection(error: unknown, attempt: ReviewedCheckIn, actorId: string) {
  if (
    !(error instanceof ApiError) ||
    ![400, 403, 409].includes(error.status) ||
    !object(error.responseData)
  )
    return null;
  const { code, actorId: respondent, command, message } = error.responseData;
  if (
    Object.keys(error.responseData).length !== 4 ||
    code !== 'CHECK_IN_NOT_SAVED' ||
    respondent !== actorId ||
    !nonempty(message) ||
    !object(command)
  )
    return null;
  const entries = Object.entries(attempt.command);
  return Object.keys(command).length === entries.length &&
    entries.every(([key, value]) => command[key] === value)
    ? message
    : null;
}
