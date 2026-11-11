import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight,
  ClipboardCheck,
  FileClock,
  History,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type {
  InvestigationAssignment,
  InvestigationOwner,
  InvestigationReviewContext,
  InvestigationWorkItem,
} from '../../shared/investigation-worklist';
import { api, ApiError, formatDate, useResource, useSession, useToast } from '../lib';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import { InvestigationReviewModal } from '../components/InvestigationReviewModal';
import './investigation-worklist.css';

const statusLabels: Record<InvestigationWorkItem['status'], string> = {
  ordered: 'Awaiting result',
  'result-received': 'Awaiting review',
  reviewed: 'Reviewed',
  cancelled: 'Cancelled',
};
const filters = [
  ['awaiting-review', 'Awaiting review'],
  ['awaiting-result', 'Awaiting result'],
  ['past-requested-date', 'Past requested date'],
  ['reviewed', 'Reviewed'],
  ['cancelled', 'Cancelled'],
  ['all', 'All investigations'],
] as const;
type QueueFilter = (typeof filters)[number][0];
const errorText = (problem: unknown) =>
  problem instanceof Error
    ? problem.message
    : 'The request could not be confirmed. Please try again.';
const stamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const recordLink = (item: InvestigationWorkItem) =>
  `/clinic/patients/${encodeURIComponent(item.patientId)}?tab=workup&investigation=${encodeURIComponent(item.investigationId)}${item.latestResultId ? `&result=${encodeURIComponent(item.latestResultId)}` : ''}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const isDate = (value: unknown): value is string =>
  isText(value) && Number.isFinite(Date.parse(value));
const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nullableText = (value: unknown) => value === null || isText(value);
const nullableDate = (value: unknown) => value === null || isDate(value);
function checkedItem(value: unknown): InvestigationWorkItem {
  if (
    !isRecord(value) ||
    ![
      'investigationId',
      'patientId',
      'patientName',
      'title',
      'orderedByDoctorId',
      'orderedByDoctorName',
      'ownerDoctorId',
      'ownerDoctorName',
    ].every((key) => isText(value[key])) ||
    !['laboratory', 'pathology', 'imaging', 'other'].includes(value.kind as string) ||
    typeof value.status !== 'string' ||
    !Object.hasOwn(statusLabels, value.status) ||
    !['ownerAvailable', 'needsReview', 'awaitingPublication', 'pastRequestedDate'].every(
      (key) => typeof value[key] === 'boolean',
    ) ||
    !isDate(value.createdAt) ||
    !nullableDate(value.dueDate) ||
    !nullableText(value.latestResultId) ||
    !nullableDate(value.latestResultAt) ||
    !nullableText(value.latestReviewId) ||
    !nullableDate(value.latestReviewAt) ||
    (value.latestResultId === null) !== (value.latestResultAt === null) ||
    (value.latestReviewId === null) !== (value.latestReviewAt === null) ||
    !isRevision(value.revision)
  )
    throw new Error(
      'The response did not contain a complete investigation worklist record. Refresh to try again.',
    );
  if (
    value.needsReview !== (value.status === 'result-received') ||
    (value.latestReviewId !== null && value.latestResultId === null) ||
    (value.pastRequestedDate && (value.status !== 'ordered' || value.dueDate === null)) ||
    (value.awaitingPublication && value.latestReviewId === null)
  )
    throw new Error(
      'The investigation status and result context could not be confirmed. Refresh to try again.',
    );
  return value as unknown as InvestigationWorkItem;
}
function checkedWorklist(value: unknown): InvestigationWorkItem[] {
  if (!Array.isArray(value))
    throw new Error(
      'The response did not contain an investigation worklist. Refresh to try again.',
    );
  const items = value.map(checkedItem);
  if (new Set(items.map((item) => item.investigationId)).size !== items.length)
    throw new Error(
      'The worklist contained duplicate investigation records. Refresh to try again.',
    );
  return items;
}
function checkedOwners(value: unknown): InvestigationOwner[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (owner) =>
        isRecord(owner) &&
        isText(owner.doctorId) &&
        isText(owner.doctorName) &&
        Number.isSafeInteger(owner.activeAccounts) &&
        Number(owner.activeAccounts) > 0,
    ) ||
    new Set(value.map((owner) => owner.doctorId)).size !== value.length
  )
    throw new Error('Eligible clinician accounts could not be confirmed. Refresh to try again.');
  return value as InvestigationOwner[];
}
function checkedContext(value: unknown, investigationId: string): InvestigationReviewContext {
  const item = checkedItem(value);
  const context = value as InvestigationReviewContext;
  if (
    item.investigationId !== investigationId ||
    !isRecord(context.investigation) ||
    context.investigation.id !== investigationId ||
    context.investigation.patientId !== item.patientId ||
    context.investigation.doctorId !== item.orderedByDoctorId ||
    context.investigation.title !== item.title ||
    context.investigation.status !== item.status ||
    !Array.isArray(context.assignments) ||
    !context.assignments.every(
      (entry) =>
        isRecord(entry) &&
        entry.investigationId === investigationId &&
        [
          'id',
          'doctorId',
          'doctorName',
          'previousDoctorId',
          'previousDoctorName',
          'reason',
          'assignedById',
          'assignedByName',
        ].every((key) => isText(entry[key])) &&
        isDate(entry.createdAt),
    ) ||
    new Set(context.assignments.map((entry) => entry.id)).size !== context.assignments.length
  )
    throw new Error(
      'The response did not confirm this investigation and its ownership history. Refresh or retry the same submitted request.',
    );
  return context;
}
function Status({ item }: { item: InvestigationWorkItem }) {
  return (
    <Badge
      tone={
        item.status === 'reviewed'
          ? 'green'
          : item.status === 'result-received'
            ? 'blue'
            : item.status === 'ordered'
              ? 'amber'
              : 'neutral'
      }
    >
      {statusLabels[item.status]}
    </Badge>
  );
}
function Sharing({ item }: { item: InvestigationWorkItem }) {
  return (
    <span className="iwq-sharing">
      {!item.latestReviewId
        ? 'No review of the latest result'
        : item.awaitingPublication
          ? 'Latest review is clinic-only'
          : 'Latest review shared with patient'}
    </span>
  );
}
type AssignmentPayload = {
  doctorId: string;
  reason: string;
  expectedRevision: string;
  requestId: string;
};
type AssignmentDraft = {
  investigationId: string;
  source: InvestigationReviewContext;
  doctorId: string;
  reason: string;
  requestId: string;
  attempt: AssignmentPayload | null;
  phase: 'editing' | 'uncertain' | 'conflict';
  error: string;
  reviewed: InvestigationReviewContext | null;
};
function newAssignment(source: InvestigationReviewContext): AssignmentDraft {
  return {
    investigationId: source.investigationId,
    source,
    doctorId: '',
    reason: '',
    requestId: crypto.randomUUID(),
    attempt: null,
    phase: 'editing',
    error: '',
    reviewed: null,
  };
}

export function InvestigationWorklistPage() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const defaultScope = session.user?.role === 'doctor' && session.user.doctorId ? 'mine' : 'all';
  const scope =
    params.get('scope') === 'all'
      ? 'all'
      : params.get('scope') === 'mine' && session.user?.doctorId
        ? 'mine'
        : defaultScope;
  const selectedFilter = params.get('filter');
  const filter: QueueFilter = filters.some(([key]) => key === selectedFilter)
    ? (selectedFilter as QueueFilter)
    : 'awaiting-review';
  const search = params.get('q') ?? '';
  const unavailableOnly = params.get('owner') === 'unavailable';
  const selectedId = params.get('investigation');
  const resource = useResource<InvestigationWorkItem[]>(
    `/api/investigation-worklist?scope=${scope}`,
  );
  const [draft, setDraft] = useState<AssignmentDraft | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const canReview = !!session.user?.doctorId && ['doctor', 'admin'].includes(session.user.role);
  function setQuery(key: string, value: string | null) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void resource.reload();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [resource.reload]);
  let items: InvestigationWorkItem[] = [],
    loadError = resource.error;
  if (!resource.loading && !loadError) {
    try {
      items = checkedWorklist(resource.data);
    } catch (problem) {
      loadError = errorText(problem);
    }
  }
  const visible = items
    .filter((item) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'awaiting-review'
          ? item.needsReview
          : filter === 'awaiting-result'
            ? item.status === 'ordered'
            : filter === 'past-requested-date'
              ? item.pastRequestedDate
              : item.status === filter);
      return (
        matchesFilter &&
        (!unavailableOnly || !item.ownerAvailable) &&
        `${item.patientName} ${item.title} ${item.ownerDoctorName} ${item.orderedByDoctorName}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      );
    })
    .sort((a, b) => {
      if (filter === 'awaiting-review')
        return (
          (a.latestResultAt ?? a.createdAt).localeCompare(b.latestResultAt ?? b.createdAt) ||
          a.investigationId.localeCompare(b.investigationId)
        );
      if (filter === 'awaiting-result' || filter === 'past-requested-date')
        return (
          (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
          a.createdAt.localeCompare(b.createdAt)
        );
      return (
        (b.latestReviewAt ?? b.latestResultAt ?? b.createdAt).localeCompare(
          a.latestReviewAt ?? a.latestResultAt ?? a.createdAt,
        ) || a.investigationId.localeCompare(b.investigationId)
      );
    });
  const unavailable = resource.loading || !!loadError;
  return (
    <div className="iwq-workspace">
      <PageHeader
        eyebrow="CLINICAL CONTINUITY"
        title="Investigation worklist"
        description="Find incoming results, review the latest submission and keep responsibility clear."
        actions={
          <button
            className="button button-secondary"
            disabled={resource.loading}
            onClick={resource.reload}
          >
            <RefreshCw size={16} />
            Refresh worklist
          </button>
        }
      />
      <div className="iwq-metrics">
        {[
          {
            label: 'Awaiting review',
            value: items.filter((item) => item.needsReview).length,
            detail: 'Latest result has no clinical review',
            icon: ClipboardCheck,
          },
          {
            label: 'Awaiting result',
            value: items.filter((item) => item.status === 'ordered').length,
            detail: 'An order exists; no result has been submitted',
            icon: FileClock,
          },
          {
            label: 'Past requested date',
            value: items.filter((item) => item.pastRequestedDate).length,
            detail: 'No result; the original requested date has passed',
            icon: History,
          },
        ].map(({ label, value, detail, icon: Icon }) => (
          <Card key={label}>
            <div>
              <span>{label}</span>
              <Icon size={18} />
            </div>
            <strong>{unavailable ? '—' : value}</strong>
            <p>{detail}</p>
          </Card>
        ))}
      </div>
      <p className="iwq-scope">
        {loadError
          ? 'Worklist totals are unavailable until the records load.'
          : `Counts cover ${scope === 'mine' ? 'investigations currently assigned to your doctor profile' : 'all clinic investigations'}, before the filters below. Dates use Asia/Kolkata.`}
      </p>
      {draft && !selectedId && (
        <div className="notice iwq-pending">
          <div>
            <strong>An investigation handover is unfinished.</strong>
            <p>
              {draft.source.patientName} · {draft.source.title}. The draft is retained while this
              page stays open.
            </p>
          </div>
          <button
            className="button button-secondary"
            onClick={() => setQuery('investigation', draft.investigationId)}
          >
            Resume pending assignment
          </button>
        </div>
      )}
      {!canReview && (
        <div className="notice">
          <ShieldCheck size={18} />
          <span>
            You can read the worklist. Recording a clinical review requires an account linked to a
            doctor profile.
          </span>
        </div>
      )}
      <Card className="iwq-register">
        <div className="iwq-filters" role="group" aria-label="Investigation status filters">
          {filters.map(([value, label]) => (
            <button
              key={value}
              className={`button button-small ${filter === value ? 'button-primary' : 'button-secondary'}`}
              aria-pressed={filter === value}
              onClick={() => setQuery('filter', value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="iwq-controls">
          <Field label="Search investigations">
            <div className="iwq-search">
              <Search size={16} />
              <input
                aria-label="Search investigations"
                placeholder="Patient, investigation or clinician"
                value={search}
                maxLength={300}
                onChange={(event) => setQuery('q', event.target.value)}
              />
            </div>
          </Field>
          <Field label="Investigation owner">
            <select value={scope} onChange={(event) => setQuery('scope', event.target.value)}>
              {session.user?.doctorId && <option value="mine">My investigations</option>}
              <option value="all">All clinic investigations</option>
            </select>
          </Field>
          <label className="checkbox-field iwq-owner-filter">
            <input
              type="checkbox"
              checked={unavailableOnly}
              onChange={(event) => setQuery('owner', event.target.checked ? 'unavailable' : null)}
            />
            Owner has no active account
          </label>
        </div>
        {resource.loading ? (
          <Loading />
        ) : loadError ? (
          <ErrorState message={loadError} retry={resource.reload} />
        ) : !visible.length ? (
          <EmptyState
            title={
              filter === 'awaiting-review'
                ? 'No investigations await review in this view'
                : 'No investigations in this view'
            }
            description="Try another status, owner or search term. Refresh to check for newly submitted results."
          />
        ) : (
          <div
            className="table-wrap iwq-table-wrap"
            role="region"
            aria-label="Investigation worklist; scroll horizontally for all columns"
            tabIndex={0}
          >
            <table className="data-table iwq-table">
              <thead>
                <tr>
                  <th scope="col">Patient & investigation</th>
                  <th scope="col">Result & review</th>
                  <th scope="col">Requested result date</th>
                  <th scope="col">Responsibility</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.investigationId} className="iwq-row">
                    <td>
                      <Link className="iwq-record-link" to={recordLink(item)}>
                        {item.patientName}
                      </Link>
                      <strong className="iwq-order-title">{item.title}</strong>
                      <small>
                        {item.kind} · Ordered {formatDate(item.createdAt)}
                      </small>
                      <small>Ordered by {item.orderedByDoctorName}</small>
                    </td>
                    <td>
                      <Status item={item} />
                      <small>
                        {item.latestResultAt
                          ? `Latest result: ${stamp(item.latestResultAt)} IST`
                          : 'No result submitted'}
                      </small>
                      {item.latestReviewAt && (
                        <small>Latest review: {stamp(item.latestReviewAt)} IST</small>
                      )}
                      <Sharing item={item} />
                    </td>
                    <td>
                      <strong>{item.dueDate ? formatDate(item.dueDate) : 'Not recorded'}</strong>
                      {item.pastRequestedDate && (
                        <small>Requested date passed; awaiting result</small>
                      )}
                    </td>
                    <td>
                      <strong>{item.ownerDoctorName}</strong>
                      {!item.ownerAvailable && (
                        <small className="iwq-owner-unavailable">
                          No active linked clinical account
                        </small>
                      )}
                    </td>
                    <td>
                      <div className="iwq-row-actions">
                        {item.needsReview && canReview && (
                          <button
                            className="button button-primary button-small"
                            disabled={!!draft || !!selectedId}
                            onClick={() => setReviewId(item.investigationId)}
                          >
                            Review latest result
                          </button>
                        )}
                        <button
                          className="button button-secondary button-small"
                          disabled={!!reviewId}
                          onClick={() => setQuery('investigation', item.investigationId)}
                        >
                          Owner & history
                        </button>
                        <Link className="text-link" to={recordLink(item)}>
                          Open record <ArrowUpRight size={13} />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!unavailable && (
          <p className="iwq-result-count">
            {visible.length} {visible.length === 1 ? 'investigation' : 'investigations'} shown
          </p>
        )}
      </Card>
      <div className="notice iwq-explanation">
        <ShieldCheck size={19} />
        <span>
          The requested date records when a result was requested; it is not a review deadline or a
          measure of clinical urgency. Reading a result or activity notice does not complete its
          clinical review. A reviewed result can remain clinic-only until explicitly shared.
        </span>
      </div>
      {selectedId && (
        <InvestigationAssignmentModal
          key={selectedId}
          investigationId={selectedId}
          draft={draft}
          onDraftChange={setDraft}
          onClose={() => setQuery('investigation', null)}
          onResume={() => {
            if (draft) setQuery('investigation', draft.investigationId);
          }}
          onSaved={async () => {
            setDraft(null);
            setQuery('investigation', null);
            await resource.reload();
          }}
        />
      )}
      {reviewId && (
        <InvestigationReviewModal
          key={reviewId}
          investigationId={reviewId}
          onClose={() => setReviewId(null)}
          onSaved={async () => {
            setReviewId(null);
            await resource.reload();
          }}
        />
      )}
    </div>
  );
}

function AssignmentHistory({ context }: { context: InvestigationReviewContext }) {
  return (
    <section className="iwq-assignment-history">
      <h3>Responsibility history</h3>
      <p className="iwq-help">
        The original ordering clinician remains {context.orderedByDoctorName}. Handover notes are
        clinic-only.
      </p>
      {context.assignments.length ? (
        <div className="iwq-handover-list">
          {context.assignments.map((entry: InvestigationAssignment) => (
            <article className="iwq-handover" key={entry.id}>
              <h4>
                {entry.previousDoctorName} → {entry.doctorName}
              </h4>
              <p className="iwq-prose">{entry.reason}</p>
              <small>
                {entry.assignedByName} · {stamp(entry.createdAt)} IST
              </small>
            </article>
          ))}
        </div>
      ) : (
        <p className="iwq-help">
          No handovers have been recorded. Responsibility remains with the original ordering
          clinician.
        </p>
      )}
    </section>
  );
}
function ContextSummary({
  context,
  latest = false,
}: {
  context: InvestigationReviewContext;
  latest?: boolean;
}) {
  return (
    <section className="iwq-assignment-context">
      <span className="eyebrow">{latest ? 'LATEST SAVED CONTEXT' : context.patientName}</span>
      <h3>{context.title}</h3>
      <Status item={context} />
      <dl>
        <div>
          <dt>Current investigation owner</dt>
          <dd>{context.ownerDoctorName}</dd>
        </div>
        <div>
          <dt>Original ordering clinician</dt>
          <dd>{context.orderedByDoctorName}</dd>
        </div>
        <div>
          <dt>Latest result</dt>
          <dd>
            {context.latestResultAt
              ? `${stamp(context.latestResultAt)} IST`
              : 'No result submitted'}
          </dd>
        </div>
        <div>
          <dt>Latest review</dt>
          <dd>
            {context.latestReviewAt
              ? `${stamp(context.latestReviewAt)} IST`
              : 'No review of the latest result'}
          </dd>
        </div>
      </dl>
      <Sharing item={context} />
      {!context.ownerAvailable && (
        <p className="iwq-owner-unavailable">
          The current owner has no active linked clinical account.
        </p>
      )}
    </section>
  );
}
function InvestigationAssignmentModal({
  investigationId,
  draft,
  onDraftChange,
  onClose,
  onResume,
  onSaved,
}: {
  investigationId: string;
  draft: AssignmentDraft | null;
  onDraftChange: (draft: AssignmentDraft | null) => void;
  onClose: () => void;
  onResume: () => void;
  onSaved: () => Promise<void>;
}) {
  const { session } = useSession();
  const toast = useToast();
  const resource = useResource<InvestigationReviewContext>(
    `/api/investigations/${encodeURIComponent(investigationId)}/review-context`,
  );
  const ownerResource = useResource<InvestigationOwner[]>('/api/investigation-owners');
  const [busy, setBusy] = useState(false);
  const [refreshed, setRefreshed] = useState<InvestigationReviewContext | null>(null);
  const [refreshedOwners, setRefreshedOwners] = useState<InvestigationOwner[] | null>(null);
  const mounted = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  let context: InvestigationReviewContext | null = null,
    owners: InvestigationOwner[] = [];
  let loadError = resource.error,
    ownersError = ownerResource.error;
  if (!resource.loading && !loadError) {
    try {
      context = checkedContext(refreshed ?? resource.data, investigationId);
    } catch (problem) {
      loadError = errorText(problem);
    }
  }
  if (!ownerResource.loading && !ownersError) {
    try {
      owners = checkedOwners(refreshedOwners ?? ownerResource.data);
    } catch (problem) {
      ownersError = errorText(problem);
    }
  }
  const currentDraft = draft?.investigationId === investigationId ? draft : null;
  const blocked = !!draft && !currentDraft;
  const source = currentDraft?.source ?? context;
  const phase = currentDraft?.phase ?? 'editing';
  const canAssign =
    !!source &&
    source.status !== 'cancelled' &&
    (session.user?.role === 'admin' || session.user?.doctorId === source.ownerDoctorId);
  const eligible = owners.filter((owner) => owner.doctorId !== source?.ownerDoctorId);
  const doctorId = currentDraft?.doctorId ?? '',
    reason = currentDraft?.reason ?? '';
  const validOwner = eligible.some((owner) => owner.doctorId === doctorId);
  const locked =
    busy ||
    phase !== 'editing' ||
    !canAssign ||
    blocked ||
    resource.loading ||
    !!loadError ||
    ownerResource.loading ||
    !!ownersError;
  function update(change: Partial<AssignmentDraft>) {
    if (source && !blocked)
      onDraftChange({ ...(currentDraft ?? newAssignment(source)), ...change });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || blocked || !source || phase === 'conflict') return;
    const entry = currentDraft ?? newAssignment(source);
    if (
      !entry.attempt &&
      (!canAssign || !validOwner || !reason.trim() || reason.trim().length > 1000)
    ) {
      update({
        error: 'Choose an eligible new owner and enter a handover reason of 1–1,000 characters.',
      });
      return;
    }
    const body: AssignmentPayload = entry.attempt ?? {
      doctorId,
      reason: reason.trim(),
      expectedRevision: source.revision,
      requestId: entry.requestId,
    };
    saving.current = true;
    setBusy(true);
    onDraftChange({ ...entry, attempt: body, error: '' });
    try {
      const response = checkedContext(
        await api<unknown>(
          `/api/investigations/${encodeURIComponent(investigationId)}/assignment`,
          { method: 'POST', body },
        ),
        investigationId,
      );
      if (
        response.patientId !== entry.source.patientId ||
        response.orderedByDoctorId !== entry.source.orderedByDoctorId ||
        response.revision === entry.source.revision ||
        !response.assignments.some(
          (assignment) =>
            !entry.source.assignments.some((original) => original.id === assignment.id) &&
            assignment.assignedById === session.user?.id &&
            assignment.doctorId === body.doctorId &&
            assignment.previousDoctorId === entry.source.ownerDoctorId &&
            assignment.reason === body.reason,
        )
      )
        throw new Error(
          'The response did not confirm the submitted handover. Retry the same request to check its outcome.',
        );
      if (!mounted.current) return;
      toast(
        'Investigation responsibility assigned. The original order and clinical history are preserved.',
      );
      await onSaved();
    } catch (problem) {
      if (!mounted.current) return;
      const error = errorText(problem);
      if (
        problem instanceof ApiError &&
        [400, 403].includes(problem.status) &&
        /current investigation owner|active linked account/i.test(error)
      )
        onDraftChange({ ...entry, phase: 'conflict', attempt: body, reviewed: null, error });
      else if (problem instanceof ApiError && [400, 403, 404, 422].includes(problem.status))
        onDraftChange({ ...entry, phase: 'editing', attempt: null, error });
      else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        !/request.*(?:already|different|used)|idempot/i.test(error)
      )
        onDraftChange({ ...entry, phase: 'conflict', attempt: body, reviewed: null, error });
      else onDraftChange({ ...entry, phase: 'uncertain', attempt: body, error });
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function refreshContext() {
    if (saving.current || !currentDraft) return;
    saving.current = true;
    setBusy(true);
    try {
      const [fresh, available] = await Promise.all([
        api<unknown>(`/api/investigations/${encodeURIComponent(investigationId)}/review-context`),
        api<unknown>('/api/investigation-owners'),
      ]);
      const reviewed = checkedContext(fresh, investigationId),
        nextOwners = checkedOwners(available);
      if (!mounted.current) return;
      setRefreshed(reviewed);
      setRefreshedOwners(nextOwners);
      update({ reviewed, error: '' });
    } catch (problem) {
      if (mounted.current) update({ error: errorText(problem) });
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const showForm = canAssign || !!currentDraft;
  return (
    <Modal
      title="Investigation ownership"
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <div className="stack iwq-ownership-modal">
        {resource.loading ? (
          <Loading />
        ) : loadError ? (
          <ErrorState
            message={loadError}
            retry={async () => {
              setRefreshed(null);
              await resource.reload();
            }}
          />
        ) : (
          context && (
            <>
              <ContextSummary context={context} />
              <Link
                className="text-link"
                to={recordLink(context)}
                aria-disabled={busy || !!currentDraft?.attempt}
                tabIndex={busy || currentDraft?.attempt ? -1 : undefined}
                onClick={(event) => {
                  if (saving.current || currentDraft?.attempt) event.preventDefault();
                }}
              >
                Open exact investigation record <ArrowUpRight size={14} />
              </Link>
              <AssignmentHistory context={context} />
            </>
          )
        )}
        {blocked && (
          <div className="notice iwq-blocked">
            <p>Another investigation handover is unfinished. Its draft remains preserved.</p>
            <button className="button button-secondary" onClick={onResume}>
              Resume pending assignment
            </button>
          </div>
        )}
        {context && context.status === 'cancelled' && (
          <p className="notice">
            This investigation is cancelled. Its order and responsibility history remain available;
            further handovers are closed.
          </p>
        )}
        {context && !canAssign && !currentDraft && context.status !== 'cancelled' && (
          <p className="notice">
            Only the current investigation owner or an administrator can transfer responsibility.
            Authorized clinicians can still read the record and review results.
          </p>
        )}
        {showForm && !blocked && (
          <form className="stack iwq-assignment-form" onSubmit={submit}>
            <h3>Assign investigation owner</h3>
            {currentDraft &&
              context &&
              currentDraft.source.revision !== context.revision &&
              phase === 'editing' && (
                <p className="notice">
                  Your draft retains an earlier investigation context. Saving will verify that its
                  ownership and clinical record are still current.
                </p>
              )}
            <p className="iwq-help">
              Change who follows this investigation. This does not alter its original author, mark a
              result reviewed or share clinical findings with the patient.
            </p>
            {ownersError && (
              <ErrorState
                message={ownersError}
                retry={async () => {
                  setRefreshedOwners(null);
                  await ownerResource.reload();
                }}
              />
            )}
            <Field
              label="New investigation owner"
              hint="Only clinicians with an active linked account can receive responsibility."
            >
              <select
                required
                value={doctorId}
                disabled={locked}
                onChange={(event) => update({ doctorId: event.target.value, error: '' })}
              >
                <option value="">Select a clinician</option>
                {doctorId && !validOwner && (
                  <option value={doctorId} disabled>
                    Previously selected clinician is unavailable or already owns this investigation
                  </option>
                )}
                {eligible.map((owner) => (
                  <option key={owner.doctorId} value={owner.doctorId}>
                    {owner.doctorName}
                  </option>
                ))}
              </select>
            </Field>
            {!ownerResource.loading && !ownersError && !eligible.length && (
              <p className="iwq-help">
                No other eligible clinician is available. An administrator can link an active
                clinical account in Accounts & access.
              </p>
            )}
            <Field
              label="Reason for handover"
              hint="Clinic-only context for the receiving clinician. This reason is preserved in responsibility history."
            >
              <textarea
                required
                rows={4}
                maxLength={1000}
                disabled={locked}
                value={reason}
                onChange={(event) => update({ reason: event.target.value, error: '' })}
              />
            </Field>
            {currentDraft?.error && (
              <div className="notice notice-error" role="alert">
                {currentDraft.error}
              </div>
            )}
            {phase === 'uncertain' && (
              <div className="notice iwq-retry">
                <strong>The save outcome could not be confirmed.</strong>
                <p>
                  The exact handover and request ID are retained. Retry the same request to check
                  its outcome without applying it twice. You may close this dialog and resume from
                  the worklist.
                </p>
              </div>
            )}
            {phase === 'conflict' && (
              <div className="notice iwq-conflict">
                <strong>The investigation context changed.</strong>
                <p>
                  Your selected clinician and note are preserved. Review the latest owner, result
                  and review before preparing another request.
                </p>
                {currentDraft?.reviewed ? (
                  <>
                    <ContextSummary context={currentDraft.reviewed} latest />
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() =>
                        update({
                          source: currentDraft.reviewed!,
                          reviewed: null,
                          phase: 'editing',
                          requestId: crypto.randomUUID(),
                          attempt: null,
                          error: '',
                        })
                      }
                    >
                      I reviewed the latest context; keep my draft
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={refreshContext}
                  >
                    <RefreshCw size={15} />
                    Refresh assignment context
                  </button>
                )}
              </div>
            )}
            <div className="iwq-form-actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={onClose}
              >
                Close for now
              </button>
              {phase === 'editing' && !currentDraft?.attempt && currentDraft && (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() => onDraftChange(null)}
                >
                  Cancel assignment draft
                </button>
              )}
              <button
                className="button button-primary"
                disabled={
                  busy ||
                  phase === 'conflict' ||
                  (phase === 'editing' && (locked || !validOwner || !reason.trim()))
                }
              >
                {busy
                  ? 'Saving…'
                  : phase === 'uncertain'
                    ? 'Retry same request'
                    : 'Save assignment'}
              </button>
            </div>
          </form>
        )}
        {!showForm && (
          <div className="iwq-form-actions">
            <button className="button button-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
