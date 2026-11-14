import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { CareSummary } from '../../shared/care-summary';
import type {
  CareSummaryCopy,
  CareSummaryCopyDetail,
  CareSummaryCopyInput,
  CareSummaryCopyPage,
  CareSummaryCopyResult,
} from '../../shared/care-summary-copies';
import { checkedVisitAppointment, visitDate, visitTime } from './visit-duration-helpers';
import { api } from '../lib';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const nonempty = (v: unknown): v is string => text(v) && !!v.trim();
const timestamp = (v: unknown) => nonempty(v) && Number.isFinite(Date.parse(v));
const hash = (v: unknown) => text(v) && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  text(v) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const bad = () =>
  new Error(
    'The response did not contain a complete matching care summary. Refresh the view or retry the same submitted request.',
  );
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw bad();
}
function fields(v: unknown, names: string[]) {
  requireValue(object(v) && names.every((k) => text(v[k])));
  return v;
}
function records(v: unknown): Record<string, unknown>[] {
  requireValue(Array.isArray(v) && v.every(object));
  return v;
}
function entries(v: unknown): Record<string, unknown>[] {
  const rows = records(v);
  requireValue(
    rows.every((r) => nonempty(r.id)) && new Set(rows.map((r) => r.id)).size === rows.length,
  );
  return rows;
}
function dated(v: unknown, names: string[]) {
  const r = fields(v, names);
  requireValue(timestamp(r.createdAt));
  return r;
}
const optionalText = (v: unknown) => v === null || v === undefined || text(v);
const optionalDate = (v: unknown) => v === null || v === undefined || v === '' || visitDate(v);
function allergy(v: unknown) {
  const r = fields(v, ['text']);
  requireValue(['not-recorded', 'none-known', 'recorded'].includes(r.status as string));
}
function charges(v: unknown, financial = false) {
  requireValue(object(v));
  const items = records(v.items);
  requireValue(
    items.every(
      (i) =>
        text(i.description) &&
        integer(i.quantity) &&
        Number(i.quantity) > 0 &&
        integer(i.unitAmountPaise),
    ) && integer(v.totalPaise),
  );
  requireValue(
    items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitAmountPaise), 0) ===
      v.totalPaise,
  );
  if (financial) {
    requireValue(integer(v.paidPaise) && Number(v.paidPaise) <= Number(v.totalPaise));
    const status =
      v.totalPaise === 0
        ? 'no-charge'
        : v.paidPaise === 0
          ? 'unpaid'
          : v.paidPaise === v.totalPaise
            ? 'paid'
            : 'partial';
    requireValue(v.status === status);
  }
}
function procedureVisit(v: unknown) {
  if (v === null || v === undefined) return;
  const r = fields(v, ['id', 'patientId', 'doctorId', 'doctorName', 'status']);
  requireValue(
    visitDate(r.date) &&
      visitTime(r.time) &&
      integer(r.durationMinutes) &&
      Number(r.durationMinutes) > 0 &&
      Number(r.durationMinutes) <= 240 &&
      ['in-person', 'online'].includes(r.mode as string),
  );
  requireValue(['schedule', 'custom'].includes(r.durationPolicy as string));
}

/** Validate every nested collection and displayed value before rendering an archived document. */
export function checkedCareSummary(
  value: unknown,
  patientId: string,
  archived = false,
): CareSummary {
  requireValue(
    object(value) &&
      value.schemaVersion === 1 &&
      value.audience === 'patient' &&
      value.timezone === 'Asia/Kolkata' &&
      hash(value.revision) &&
      timestamp(value.generatedAt),
  );
  fields(value.clinic, ['name', 'address', 'phone', 'email']);
  const patient = fields(value.patient, [
    'id',
    'name',
    'email',
    'phone',
    'dob',
    'gender',
    'allergies',
  ]);
  requireValue(
    patient.id === patientId &&
      optionalDate(patient.dob) &&
      (patient.allergyStatus === undefined ||
        ['not-recorded', 'none-known', 'recorded'].includes(patient.allergyStatus as string)),
  );
  for (const key of [
    'appointments',
    'intakes',
    'carePlans',
    'checkIns',
    'investigations',
    'procedures',
    'images',
    'documents',
    'invoices',
  ]) {
    for (const row of entries(value[key])) requireValue(row.patientId === patientId);
  }
  for (const row of entries(value.allergyHistory)) {
    dated(row, ['doctorName', 'reason']);
    allergy(row.before);
    allergy(row.after);
  }
  for (const row of entries(value.appointments)) checkedVisitAppointment(row);
  for (const row of entries(value.intakes))
    dated(row, [
      'concern',
      'location',
      'duration',
      'symptoms',
      'triggers',
      'previousTreatment',
      'medications',
      'allergies',
      'goals',
    ]);
  for (const row of entries(value.carePlans)) {
    dated(row, ['title', 'instructions', 'expectations', 'warnings', 'cost']);
    requireValue(
      visitDate(row.startDate) &&
        visitDate(row.endDate) &&
        optionalDate(row.followUpDate) &&
        optionalDate(row.effectiveFollowUpDate) &&
        optionalText(row.doctorName),
    );
    requireValue(
      ['active', 'completed'].includes(row.status as string) &&
        (row.effectiveStatus === undefined ||
          ['active', 'completed'].includes(row.effectiveStatus as string)),
    );
    for (const medication of records(row.medications))
      fields(medication, ['name', 'instructions', 'schedule', 'duration', 'warnings']);
    for (const review of entries(row.reviews)) {
      dated(review, ['doctorName', 'patientInstructions']);
      requireValue(
        ['clinical-review', 'status-change'].includes(review.source as string) &&
          ['continue', 'visit-requested', 'complete'].includes(review.disposition as string) &&
          optionalDate(review.nextReviewDate),
      );
    }
  }
  for (const row of entries(value.checkIns)) {
    dated(row, ['carePlanId', 'note']);
    requireValue(
      visitDate(row.date) &&
        ['taken', 'partial', 'missed'].includes(row.adherence as string) &&
        ['better', 'same', 'worse'].includes(row.feeling as string),
    );
  }
  for (const row of entries(value.investigations)) {
    dated(row, ['title', 'doctorName', 'kind', 'reason', 'instructions', 'status']);
    requireValue(optionalDate(row.dueDate) && optionalText(row.cancellationReason));
    for (const result of entries(row.results)) {
      dated(result, ['submittedByName', 'submittedByRole', 'note']);
      requireValue(Array.isArray(result.documentIds) && result.documentIds.every(nonempty));
    }
    for (const review of entries(row.reviews)) {
      dated(review, ['resultId', 'doctorName', 'summary', 'followUp']);
      requireValue(timestamp(review.publishedAt));
    }
  }
  for (const row of entries(value.procedures)) {
    dated(row, [
      'title',
      'doctorName',
      'indication',
      'benefits',
      'risks',
      'alternatives',
      'aftercare',
      'estimatedCost',
      'status',
    ]);
    requireValue(
      optionalText(row.cancellationReason) &&
        optionalText(row.appointmentId) &&
        optionalText(row.effectiveAppointmentId),
    );
    procedureVisit(row.scheduledAppointment);
    if (row.templateSource !== null && row.templateSource !== undefined) {
      const source = fields(row.templateSource, ['templateTitle', 'reviewedByDoctorName']);
      requireValue(
        integer(source.version) && Number(source.version) > 0 && timestamp(source.publishedAt),
      );
    }
    for (const agreement of entries(row.agreements)) {
      dated(agreement, ['recordedByName', 'recordedByRole', 'method', 'note']);
      requireValue(['agreed', 'declined'].includes(agreement.decision as string));
    }
    if (row.completion !== null) {
      const complete = fields(row.completion, ['doctorName', 'outcome', 'aftercare']);
      requireValue(timestamp(complete.completedAt));
      procedureVisit(complete.appointment);
    }
  }
  for (const row of entries(value.images)) {
    dated(row, ['caption', 'category', 'mimeType']);
    requireValue(
      optionalText(row.createdByName) && (row.sizeBytes === undefined || integer(row.sizeBytes)),
    );
  }
  for (const row of entries(value.imageAnnotations)) {
    dated(row, ['imageId', 'doctorName', 'note']);
    requireValue(timestamp(row.publishedAt) && optionalText(row.publishedByDoctorName));
    for (const marker of entries(row.markers)) {
      fields(marker, ['label']);
      requireValue(['rectangle', 'ellipse', 'arrow'].includes(marker.type as string));
    }
  }
  for (const row of entries(value.documents)) {
    dated(row, ['title', 'originalName', 'createdByName', 'createdByRole', 'url']);
    requireValue(
      integer(row.sizeBytes) &&
        row.url === `/api/documents/${encodeURIComponent(String(row.id))}/file`,
    );
  }
  for (const row of entries(value.invoices)) {
    dated(row, ['number', 'patientName']);
    requireValue(optionalText(row.procedureTitle));
    charges(row, true);
  }
  for (const history of records(value.invoiceHistories)) {
    requireValue(nonempty(history.invoiceId));
    charges(history.issuedCharges);
    for (const row of entries(history.corrections)) {
      dated(row, ['reason', 'createdByName']);
      charges(row.before, true);
      charges(row.after, true);
    }
    for (const row of entries(history.reversals)) {
      dated(row, ['reason', 'createdByName']);
      requireValue(
        integer(row.amountPaise) && integer(row.beforePaidPaise) && integer(row.afterPaidPaise),
      );
    }
    // Previously saved schema-1 documents predate refund history. Never alter their bytes.
    const refunds = archived && history.refunds === undefined ? [] : entries(history.refunds);
    for (const row of refunds) {
      dated(row, ['reason', 'reference', 'createdByName']);
      requireValue(
        row.invoiceId === history.invoiceId &&
          nonempty(row.paymentId) &&
          integer(row.amountPaise) &&
          Number(row.amountPaise) > 0 &&
          Number(row.amountPaise) <= 1_000_000_000 &&
          integer(row.beforePaidPaise) &&
          integer(row.afterPaidPaise) &&
          Number(row.beforePaidPaise) - Number(row.amountPaise) === row.afterPaidPaise &&
          row.refundedExternallyConfirmed === true &&
          ['cash', 'card', 'upi', 'bank'].includes(row.method as string) &&
          String(row.reference).length <= 200 &&
          row.reference === String(row.reference).trim() &&
          (row.method === 'cash' || nonempty(row.reference)) &&
          nonempty(row.reason) &&
          String(row.reason).length <= 1000 &&
          nonempty(row.createdByName),
      );
    }
    const refundVoids =
      archived && history.refundVoids === undefined ? [] : entries(history.refundVoids);
    requireValue(new Set(refundVoids.map((row) => row.refundId)).size === refundVoids.length);
    for (const row of refundVoids) {
      dated(row, ['reason', 'createdByName']);
      requireValue(
        row.invoiceId === history.invoiceId &&
          nonempty(row.refundId) &&
          nonempty(row.paymentId) &&
          integer(row.amountPaise) &&
          Number(row.amountPaise) > 0 &&
          Number(row.amountPaise) <= 1_000_000_000 &&
          integer(row.beforePaidPaise) &&
          integer(row.afterPaidPaise) &&
          Number(row.afterPaidPaise) <= 1_000_000_000 &&
          Number(row.beforePaidPaise) + Number(row.amountPaise) === row.afterPaidPaise &&
          row.entryErrorConfirmed === true &&
          nonempty(row.reason) &&
          String(row.reason).length <= 1000 &&
          row.reason === String(row.reason).trim() &&
          nonempty(row.createdByName) &&
          refunds.some(
            (refund) =>
              refund.id === row.refundId &&
              refund.paymentId === row.paymentId &&
              refund.amountPaise === row.amountPaise,
          ),
      );
    }
  }
  return value as unknown as CareSummary;
}
export function checkedSummaryCopy(
  value: unknown,
  patientId: string,
  copyId?: string,
): CareSummaryCopy {
  requireValue(
    object(value) &&
      uuid(value.id) &&
      (!copyId || value.id === copyId) &&
      value.patientId === patientId &&
      nonempty(value.patientName) &&
      hash(value.sourceRevision) &&
      timestamp(value.generatedAt) &&
      timestamp(value.savedAt) &&
      hash(value.contentSha256) &&
      integer(value.byteLength) &&
      Number(value.byteLength) > 0 &&
      Number(value.byteLength) <= 10 * 1024 * 1024,
  );
  requireValue(
    object(value.savedBy) &&
      nonempty(value.savedBy.name) &&
      ['patient', 'doctor', 'admin'].includes(value.savedBy.role as string),
  );
  return value as unknown as CareSummaryCopy;
}
export function checkedSummaryCopyDetail(
  value: unknown,
  patientId: string,
  copyId: string,
): CareSummaryCopyDetail {
  requireValue(object(value));
  const copy = checkedSummaryCopy(value.copy, patientId, copyId),
    summary = checkedCareSummary(value.summary, patientId, true);
  requireValue(
    copy.sourceRevision === summary.revision &&
      copy.generatedAt === summary.generatedAt &&
      copy.patientName === summary.patient.name,
  );
  return { copy, summary };
}
export function checkedSummaryCopyPage(
  value: unknown,
  patientId: string,
  page: number,
): CareSummaryCopyPage {
  requireValue(
    object(value) &&
      integer(value.total) &&
      integer(value.totalPages) &&
      value.totalPages === Math.max(1, Math.ceil(Number(value.total) / 25)) &&
      value.pageSize === 25 &&
      value.page === Math.min(page, Number(value.totalPages)),
  );
  const items = records(value.items).map((r) => checkedSummaryCopy(r, patientId));
  requireValue(
    items.length === Math.min(25, Number(value.total) - (Number(value.page) - 1) * 25) &&
      new Set(items.map((r) => r.id)).size === items.length,
  );
  return {
    items,
    page: Number(value.page),
    pageSize: 25,
    total: Number(value.total),
    totalPages: Number(value.totalPages),
  };
}
export function checkedSummaryCopyResult(
  value: unknown,
  input: CareSummaryCopyInput,
  patientId: string,
  actorId: string,
  role: string,
): CareSummaryCopyResult {
  requireValue(object(value) && object(value.receipt));
  const copy = checkedSummaryCopy(value.copy, patientId),
    receipt = value.receipt;
  requireValue(
    receipt.requestId === input.requestId &&
      receipt.actorId === actorId &&
      receipt.patientId === patientId &&
      receipt.expectedRevision === input.expectedRevision &&
      receipt.copyId === copy.id &&
      copy.sourceRevision === input.expectedRevision &&
      copy.savedBy.role === role,
  );
  return { copy, receipt: receipt as unknown as CareSummaryCopyResult['receipt'] };
}
/** React location and native history must both still identify the initiating screen. */
export function useSummaryGuard() {
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
    const start = key.current,
      href = window.location.href,
      nativeKey = window.history.state?.key;
    return () =>
      mounted.current &&
      key.current === start &&
      window.location.href === href &&
      window.history.state?.key === nativeKey;
  };
}
/** A stale read must not invalidate a newer session or overwrite a different screen. */
export function useSummaryData<T>(path: string, check: (value: unknown) => T) {
  const location = useLocation();
  const [state, setState] = useState<{
    path: string;
    data: T | null;
    loading: boolean;
    error: string;
  }>({ path, data: null, loading: true, error: '' });
  const stateRef = useRef(state),
    source = useRef({ path, key: location.key }),
    generation = useRef(0),
    mounted = useRef(false),
    validator = useRef(check);
  source.current = { path, key: location.key };
  validator.current = check;
  const reload = useCallback(async () => {
    if (source.current.path !== path || !mounted.current) return;
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
      stateRef.current = next;
      setState(next);
    }
    publish({ path, data: null, loading: true, error: '' });
    try {
      const value = await api<unknown>(path, { isCurrent: current });
      if (current()) publish({ path, data: validator.current(value), loading: false, error: '' });
    } catch (error) {
      if (current())
        publish({
          path,
          data: null,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : 'The summary could not be loaded. Please retry.',
        });
    }
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    // A section-anchor change keeps an already loaded immutable document. If a
    // read was pending, replace it so the new screen cannot remain loading.
    if (stateRef.current.path !== path || !stateRef.current.data) void reload();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [path, location.key, reload]);
  return state.path === path
    ? { ...state, reload }
    : { path, data: null, loading: true, error: '', reload };
}
export const copyTimestamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
