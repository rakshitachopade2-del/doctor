import type { Investigation, InvestigationResult } from '../../shared/clinical';
import type { PatientDocument } from '../../shared/documents';
import type { InvestigationResultCommand } from '../../shared/investigation-result-submission';
import { ApiError } from '../lib';
import { checkedPatientDocuments } from './private-upload-helpers';

export type ResultInvestigation = Pick<
  Investigation,
  'id' | 'patientId' | 'title' | 'status' | 'results'
>;
export type ReportLabel = Pick<PatientDocument, 'id' | 'title' | 'originalName' | 'sha256'>;
export interface ResultAttempt {
  command: InvestigationResultCommand;
  patientName: string;
  investigationTitle: string;
  submitterName: string;
  reports: ReportLabel[];
  priorIds: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const error = () =>
  new Error('The current investigation could not be verified. Refresh and try again.');
function isResult(value: unknown, id: string): value is InvestigationResult {
  return (
    object(value) &&
    text(value.id) &&
    value.investigationId === id &&
    typeof value.note === 'string' &&
    strings(value.documentIds) &&
    value.documentIds.length <= 10 &&
    (!!value.note.trim() || value.documentIds.length > 0) &&
    text(value.submittedById) &&
    text(value.submittedByName) &&
    ['admin', 'doctor', 'patient'].includes(String(value.submittedByRole)) &&
    timestamp(value.createdAt)
  );
}
export function resultInvestigation(
  value: unknown,
  patientId: string,
  id: string,
): ResultInvestigation {
  if (
    !object(value) ||
    !Array.isArray(value.investigations) ||
    !value.investigations.every(
      (order) => object(order) && order.patientId === patientId && text(order.id),
    )
  )
    throw error();
  const matches = value.investigations.filter((order) => order.id === id);
  if (matches.length !== 1) throw error();
  const order = matches[0];
  if (
    !text(order.title) ||
    !['ordered', 'result-received', 'reviewed', 'cancelled'].includes(order.status) ||
    !Array.isArray(order.results) ||
    !order.results.every((r: unknown) => isResult(r, id)) ||
    new Set(order.results.map((r: InvestigationResult) => r.id)).size !== order.results.length ||
    (order.status === 'ordered' && order.results.length !== 0) ||
    (['result-received', 'reviewed'].includes(order.status) && !order.results.length)
  )
    throw error();
  return { id, patientId, title: order.title, status: order.status, results: order.results };
}
export function resultDocuments(value: unknown, patientId: string) {
  const docs = checkedPatientDocuments(value, patientId);
  if (
    !docs.every(
      (d) =>
        text(d.id) &&
        text(d.title) &&
        text(d.originalName) &&
        d.mimeType === 'application/pdf' &&
        typeof d.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(d.sha256) &&
        timestamp(d.createdAt),
    ) ||
    new Set(docs.map((d) => d.id)).size !== docs.length
  )
    throw new Error('The private report list could not be verified.');
  return docs;
}
function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
export function confirmedResult(
  value: unknown,
  attempt: ResultAttempt,
  actorId: string,
): InvestigationResult | null {
  if (!object(value) || !object(value.receipt)) return null;
  const { receipt } = value,
    { command } = attempt,
    result = receipt.result;
  if (
    receipt.requestId !== command.requestId ||
    receipt.actorId !== actorId ||
    receipt.patientId !== command.patientId ||
    receipt.investigationId !== command.investigationId ||
    !isResult(result, command.investigationId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(result.id) ||
    result.id === command.requestId ||
    attempt.priorIds.includes(result.id) ||
    result.submittedById !== actorId ||
    result.submittedByRole !== command.submittedByRole ||
    result.note !== command.note ||
    !sameIds(result.documentIds, command.documentIds)
  )
    return null;
  return result;
}
export function requireOriginalResult(
  current: ResultInvestigation,
  saved: InvestigationResult,
  attempt: ResultAttempt,
) {
  // A later read must include the immutable results seen before submission, in their original order.
  if (!attempt.priorIds.every((id, i) => current.results[i]?.id === id)) throw error();
  const original = current.results.find((r) => r.id === saved.id);
  if (
    !original ||
    original.note !== saved.note ||
    original.createdAt !== saved.createdAt ||
    original.submittedById !== saved.submittedById ||
    original.submittedByName !== saved.submittedByName ||
    original.submittedByRole !== saved.submittedByRole ||
    !sameIds(original.documentIds, saved.documentIds)
  )
    throw error();
}
export function resultRejection(
  problem: unknown,
  command: InvestigationResultCommand,
  actorId: string,
) {
  if (
    !(problem instanceof ApiError) ||
    ![400, 409].includes(problem.status) ||
    !object(problem.responseData)
  )
    return null;
  const { code, actorId: respondent, command: returned, message } = problem.responseData;
  if (
    code !== 'INVESTIGATION_RESULT_NOT_SUBMITTED' ||
    respondent !== actorId ||
    !text(message) ||
    !object(returned) ||
    Object.keys(returned).length !== Object.keys(command).length ||
    !strings(returned.documentIds) ||
    !sameIds(returned.documentIds, command.documentIds)
  )
    return null;
  return Object.entries(command).every(
    ([key, value]) => key === 'documentIds' || returned[key] === value,
  )
    ? message
    : null;
}
export function sameReport(a: ReportLabel, b: ReportLabel) {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.originalName === b.originalName &&
    a.sha256 === b.sha256
  );
}
