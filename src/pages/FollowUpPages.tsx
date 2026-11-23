import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  CalendarDays,
  ClipboardCheck,
  HeartHandshake,
  History,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { CarePlan, CheckIn } from '../../shared/types';
import type {
  FollowUpAssignment,
  FollowUpOwner,
  FollowUpReview,
  FollowUpWorkItem,
} from '../../shared/follow-up';
import { ApiError, api, formatDate, today, useResource, useSession, useToast } from '../lib';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import './follow-up.css';
import {
  EscalationHistoryModal,
  EscalationOverview,
  EscalationPolicyModal,
  EscalationPreviewModal,
  EscalationStateBadge,
} from '../components/FollowUpEscalations';
import { checkedEscalationPolicyContext } from '../components/follow-up-escalation-helpers';
import type { FollowUpReviewContext } from '../../shared/follow-up-review-recording';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from '../components/appointment-booking-helpers';
import { checkedMessageSettings } from '../components/care-message-helpers';
import { usePendingCareSubmissions } from '../components/pending-care-submissions';
import {
  checkedReviewContext,
  checkReportContinuity,
  sameReview,
  checkedReviewHistory,
  confirmedReview,
  reviewRejection,
  type ReviewTarget,
  type ReviewAttempt,
} from '../components/follow-up-review-helpers';
import { useVisitData } from '../components/visit-duration-helpers';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to save. Please try again.';
const dispositionText = {
  continue: 'Follow-up continues',
  'visit-requested': 'Visit requested',
  complete: 'Plan completed',
};
const statusOf = (plan: CarePlan) => plan.effectiveStatus ?? plan.status;
const dateOf = (plan: CarePlan) =>
  plan.effectiveFollowUpDate === undefined ? plan.followUpDate : plan.effectiveFollowUpDate;
const dateTime = (date: string) =>
  new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const planLink = (plan: CarePlan) =>
  `/clinic/patients/${plan.patientId}?tab=care&plan=${encodeURIComponent(plan.id)}`;

export function FollowUpsPage() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const [escalationAction, setEscalationAction] = useState<'policy' | 'preview' | null>(null);
  const [scope, setScope] = useState(session.user?.role === 'doctor' ? 'mine' : 'all');
  const resource = useAppointmentBookingData(`/api/follow-up-worklist?scope=${scope}`, (value) => {
    if (!Array.isArray(value)) throw new Error('The follow-up worklist could not be loaded.');
    return value as FollowUpWorkItem[];
  });
  const settings = useAppointmentBookingData('/api/settings', checkedMessageSettings);
  const escalationPolicy = useVisitData(
    '/api/follow-up-escalation-policy',
    checkedEscalationPolicyContext,
  );
  const [filter, setFilter] = useState('due');
  const [search, setSearch] = useState('');
  const location = useLocation();
  const { followUpReviews } = usePendingCareSubmissions();
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  useLayoutEffect(() => setReviewTarget(null), [location.key, session.user?.id, session.csrfToken]);
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  const enabled = settings.data?.modules.followUp === true;
  const canReview = !!session.user?.doctorId;
  const data = resource.data ?? [];
  const refreshAll = async () => {
    await Promise.all([resource.reload(), escalationPolicy.reload()]);
  };
  const matches = useMemo(
    () =>
      data
        .filter((item) => {
          const active = statusOf(item.carePlan) === 'active';
          const future = (dateOf(item.carePlan) ?? '') > today();
          return (
            (filter === 'all' ||
              (filter === 'due'
                ? item.due
                : filter === 'new'
                  ? active && item.unreviewedCount > 0
                  : filter === 'upcoming'
                    ? active && future
                    : !active)) &&
            `${item.patient.name} ${item.carePlan.title} ${item.ownerDoctorName}`
              .toLowerCase()
              .includes(search.toLowerCase())
          );
        })
        .sort(
          (a, b) =>
            Number(b.due) - Number(a.due) ||
            (dateOf(a.carePlan) ?? '9999').localeCompare(dateOf(b.carePlan) ?? '9999') ||
            b.unreviewedCount - a.unreviewedCount,
        ),
    [data, filter, search],
  );
  return (
    <div className="fu-workspace">
      <PageHeader
        eyebrow="CONTINUITY OF CARE"
        title="Follow-up care"
        description="Turn patient updates into a documented next step."
        actions={
          <>
            <button
              className="button button-secondary"
              onClick={refreshAll}
              disabled={resource.loading || escalationPolicy.loading}
            >
              <RefreshCw size={15} /> Refresh worklist
            </button>
            <button
              className="button button-secondary"
              onClick={() => setEscalationAction('policy')}
            >
              {session.user?.role === 'admin' ? 'Escalation policy' : 'View escalation policy'}
            </button>
            {session.user?.role === 'admin' && (
              <button
                className="button button-primary"
                onClick={() => setEscalationAction('preview')}
              >
                Preview notices
              </button>
            )}
          </>
        }
      />
      {!reviewTarget &&
        [...followUpReviews.values()].map((attempt) => (
          <div className="notice fu-resume" key={attempt.command.carePlanId}>
            <span>
              {attempt.patientName} · {attempt.planTitle} · Confirmation pending
            </span>
            <button
              className="button button-secondary"
              onClick={() =>
                setReviewTarget({
                  carePlanId: attempt.command.carePlanId,
                  patientId: attempt.command.patientId,
                })
              }
            >
              Resume follow-up review
            </button>
          </div>
        ))}
      <div className="fu-metrics">
        {[
          [
            'Due for review',
            data.filter((item) => item.due).length,
            'Active plans due today or earlier',
          ],
          [
            'New patient reports',
            data.filter((item) => statusOf(item.carePlan) === 'active' && item.unreviewedCount > 0)
              .length,
            'Plans with updates awaiting a clinical review',
          ],
          [
            'Upcoming reviews',
            data.filter(
              (item) =>
                statusOf(item.carePlan) === 'active' && (dateOf(item.carePlan) ?? '') > today(),
            ).length,
            'Based on the latest documented next step',
          ],
        ].map(([label, count, detail]) => (
          <Card key={label}>
            <span>{label}</span>
            <strong>
              {resource.loading
                ? 'Loading…'
                : resource.error || !resource.data
                  ? 'Unavailable'
                  : count}
            </strong>
            <p>{detail}</p>
          </Card>
        ))}
      </div>
      <EscalationOverview
        context={escalationPolicy.data}
        loading={escalationPolicy.loading}
        error={escalationPolicy.error}
        onRetry={escalationPolicy.reload}
      />
      {settings.error && <ErrorState message={settings.error} retry={settings.reload} />}
      {settings.data?.modules.followUp === false && (
        <div className="notice">
          Follow-up activity is paused. Existing plans, patient reports, and reviews remain
          available. New reviews can be recorded when the clinic enables the module.
        </div>
      )}
      {!canReview && (
        <div className="notice">
          You can read the worklist. Clinical reviews require an account linked to a doctor profile.
        </div>
      )}
      <Card className="fu-worklist">
        <div className="fu-worklist-controls">
          <div className="segmented fu-filters">
            {[
              ['due', 'Due'],
              ['new', 'New reports'],
              ['upcoming', 'Upcoming'],
              ['completed', 'Completed'],
              ['all', 'All plans'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'active' : ''}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="fu-search">
            <Search size={16} />
            <input
              aria-label="Search follow-ups"
              placeholder="Patient, plan or clinician"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <Field label="Plan owner">
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              {session.user?.doctorId && <option value="mine">My plans</option>}
              <option value="all">All clinic plans</option>
            </select>
          </Field>
        </div>
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={resource.reload} />
        ) : !matches.length ? (
          <EmptyState
            title={filter === 'due' ? 'No plans are due for review' : 'No plans in this view'}
            description="Try another filter or refresh to check for patient updates."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table fu-table">
              <thead>
                <tr>
                  <th>Patient & care plan</th>
                  <th>Next review</th>
                  <th>Patient-reported updates</th>
                  <th>Last clinical review</th>
                  <th>Operational notices</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {matches.map((item) => {
                  const plan = item.carePlan;
                  const latestReport = [...item.unreviewedCheckIns].sort((a, b) =>
                    b.createdAt.localeCompare(a.createdAt),
                  )[0];
                  const active = statusOf(plan) === 'active';
                  return (
                    <tr key={plan.id}>
                      <td>
                        <div className="row">
                          <Avatar name={item.patient.name} size="sm" />
                          <div>
                            <Link className="table-name" to={planLink(plan)}>
                              {item.patient.name}
                            </Link>
                            <span className="table-sub">{plan.title}</span>
                            <span className="table-sub">Owner: {item.ownerDoctorName}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <strong>{active && dateOf(plan) ? formatDate(dateOf(plan)!) : '—'}</strong>
                        <span className="table-sub">
                          <Badge tone={!active ? 'neutral' : item.due ? 'amber' : 'green'}>
                            {!active ? 'Completed' : item.due ? 'Due for review' : 'Upcoming'}
                          </Badge>
                        </span>
                      </td>
                      <td>
                        {item.unreviewedCount > 0 ? (
                          <>
                            <strong>
                              {item.unreviewedCount} unreviewed{' '}
                              {item.unreviewedCount === 1 ? 'report' : 'reports'}
                            </strong>
                            {latestReport && (
                              <span className="table-sub">
                                Latest: feeling {latestReport.feeling} ·{' '}
                                {formatDate(latestReport.date)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted small">No new reports</span>
                        )}
                      </td>
                      <td>
                        {item.latestReview ? (
                          <>
                            <span>{formatDate(item.latestReview.createdAt)}</span>
                            <span className="table-sub">
                              {dispositionText[item.latestReview.disposition]}
                            </span>
                          </>
                        ) : (
                          <span className="muted small">Not yet reviewed</span>
                        )}
                      </td>
                      <td>
                        <EscalationStateBadge value={item.escalation} />
                        <button
                          className="button button-ghost button-small"
                          onClick={() =>
                            setParams((current) => {
                              const next = new URLSearchParams(current);
                              next.set('escalation', plan.id);
                              return next;
                            })
                          }
                        >
                          Notice history
                        </button>
                      </td>
                      <td>
                        <div className="fu-row-actions">
                          {active && canReview && (
                            <button
                              className="button button-primary button-small"
                              disabled={!enabled || followUpReviews.has(plan.id)}
                              onClick={() =>
                                setReviewTarget({ carePlanId: plan.id, patientId: plan.patientId })
                              }
                            >
                              Review progress
                            </button>
                          )}
                          {(session.user?.role === 'admin' ||
                            session.user?.doctorId === item.ownerDoctorId) && (
                            <button
                              className="button button-secondary button-small"
                              onClick={() => setAssignmentId(plan.id)}
                            >
                              Assign follow-up
                            </button>
                          )}
                          <Link className="button button-ghost button-small" to={planLink(plan)}>
                            View plan <ArrowRight size={13} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="notice fu-worklist-note">
        <HeartHandshake size={20} />
        <span>
          Patient reports describe their experience. Opening a report or reading a notification does
          not complete a clinical review. Review dates do not book visits or send external
          reminders.
        </span>
      </div>
      {escalationAction === 'policy' && (
        <EscalationPolicyModal onClose={() => setEscalationAction(null)} onSaved={refreshAll} />
      )}
      {escalationAction === 'preview' && (
        <EscalationPreviewModal onClose={() => setEscalationAction(null)} onSaved={refreshAll} />
      )}
      {params.get('escalation') && (
        <EscalationHistoryModal
          key={params.get('escalation')!}
          carePlanId={params.get('escalation')!}
          onClose={() =>
            setParams((current) => {
              const next = new URLSearchParams(current);
              next.delete('escalation');
              return next;
            })
          }
        />
      )}
      {assignmentId && (
        <FollowUpAssignmentModal
          carePlanId={assignmentId}
          onClose={() => setAssignmentId(null)}
          onSaved={() => {
            setAssignmentId(null);
            void resource.reload();
          }}
        />
      )}
      {reviewTarget && (
        <FollowUpReviewModal
          key={JSON.stringify([reviewTarget, location.key, session.user?.id, session.csrfToken])}
          target={reviewTarget}
          onClose={() => setReviewTarget(null)}
          onSaved={() => {
            setReviewTarget(null);
            void resource.reload();
          }}
        />
      )}
    </div>
  );
}

function ReportSnapshot({ report }: { report: CheckIn }) {
  const adherence = {
    taken: 'Followed the plan',
    partial: 'Partly followed the plan',
    missed: 'Missed the plan',
  };
  return (
    <article className="fu-report">
      <div className="fu-report-heading">
        <strong>{formatDate(report.date)}</strong>
        <Badge tone="neutral">Patient reported</Badge>
      </div>
      <p>
        {adherence[report.adherence]} · Feeling {report.feeling}
      </p>
      {report.note && <p className="fu-prose">{report.note}</p>}
      <small>
        Submitted or updated{' '}
        <time dateTime={report.createdAt}>
          {new Date(report.createdAt).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3,
          })}{' '}
          IST
        </time>
      </small>
    </article>
  );
}

export function FollowUpReviewHistory({ reviews }: { reviews: FollowUpReview[] }) {
  return (
    <div className="fu-history">
      {[...reviews]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((review) => (
          <article className="fu-review-record" key={review.id}>
            <div className="fu-review-heading">
              <div>
                <h4>{dispositionText[review.disposition]}</h4>
                <p>
                  {review.doctorName} · {dateTime(review.createdAt)} IST
                </p>
              </div>
              <Badge tone={review.source === 'status-change' ? 'neutral' : 'green'}>
                {review.source === 'status-change' ? 'Status update' : 'Clinical review'}
              </Badge>
            </div>
            {review.assessment && (
              <div className="fu-record-field">
                <span>Clinician assessment · clinic only</span>
                <p>{review.assessment}</p>
              </div>
            )}
            <div className="fu-record-field">
              <span>Instructions shared with patient</span>
              <p>{review.patientInstructions}</p>
            </div>
            {review.nextReviewDate && (
              <p className="fu-next-date">
                <CalendarDays size={15} /> Next review: {formatDate(review.nextReviewDate)}
              </p>
            )}
            {review.checkInSnapshots.length > 0 && (
              <details className="fu-snapshots">
                <summary>
                  Patient reports preserved with this review ({review.checkInSnapshots.length})
                </summary>
                <div className="fu-reports">
                  {review.checkInSnapshots.map((snapshot) => (
                    <ReportSnapshot
                      key={`${snapshot.id}-${snapshot.contentHash}`}
                      report={snapshot.snapshot}
                    />
                  ))}
                </div>
              </details>
            )}
          </article>
        ))}
    </div>
  );
}

export function FollowUpPlanSection({
  plan,
  enabled,
  onChanged,
}: {
  plan: CarePlan;
  enabled: boolean;
  onChanged: () => void;
}) {
  const { session } = useSession();
  const location = useLocation();
  const { followUpReviews } = usePendingCareSubmissions();
  const target = { carePlanId: plan.id, patientId: plan.patientId };
  const pending = followUpReviews.get(plan.id)?.command.patientId === plan.patientId;
  const history = useAppointmentBookingData(
    `/api/care-plans/${encodeURIComponent(plan.id)}/reviews`,
    (value) => checkedReviewHistory(value, target),
  );
  const [reviewing, setReviewing] = useState(false);
  useLayoutEffect(
    () => setReviewing(false),
    [plan.id, location.key, session.user?.id, session.csrfToken],
  );
  const active = statusOf(plan) === 'active';
  return (
    <section className="fu-plan-section">
      <FollowUpOwnerPanel plan={plan} onChanged={onChanged} />
      <div className="fu-plan-section-heading">
        <h3>
          <History size={16} /> Follow-up reviews
        </h3>
        {pending && !reviewing && (
          <button
            className="button button-secondary button-small"
            onClick={() => setReviewing(true)}
          >
            Resume follow-up review
          </button>
        )}
        {active && !pending && session.user?.doctorId && (
          <button
            className="button button-secondary button-small"
            disabled={!enabled}
            onClick={() => setReviewing(true)}
          >
            <ClipboardCheck size={14} /> Review progress
          </button>
        )}
      </div>
      {!enabled && (
        <p className="fu-paused">
          New follow-up reviews are paused. Previous reviews remain available.
        </p>
      )}
      {history.loading ? (
        <Loading />
      ) : history.error ? (
        <ErrorState message={history.error} retry={history.reload} />
      ) : history.data?.length ? (
        <FollowUpReviewHistory reviews={history.data} />
      ) : (
        <p className="muted small">
          No clinical follow-up reviews yet. A review records the assessment, patient-facing
          instructions, and next step together.
        </p>
      )}
      {reviewing && (
        <FollowUpReviewModal
          key={JSON.stringify([plan.id, location.key, session.user?.id, session.csrfToken])}
          target={target}
          onClose={() => setReviewing(false)}
          onSaved={() => {
            setReviewing(false);
            void history.reload();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function ReviewEvidence({ attempt }: { attempt: ReviewAttempt }) {
  const c = attempt.command;
  return (
    <>
      <p>
        {attempt.patientName} · {attempt.planTitle}
      </p>
      <p>Reviewing clinician · {attempt.doctorName}</p>
      <div className="fu-record-field">
        <span>Clinician assessment · clinic only</span>
        <p>{c.assessment}</p>
      </div>
      <div className="fu-record-field">
        <span>Instructions to share with the patient</span>
        <p>{c.patientInstructions}</p>
      </div>
      <p>
        {dispositionText[c.disposition]}
        {c.nextReviewDate && <> · Next review {formatDate(c.nextReviewDate)}</>}
      </p>
      <details className="fu-snapshots">
        <summary>Patient reports included in this review ({attempt.snapshots.length})</summary>
        {attempt.snapshots.map((v) => (
          <ReportSnapshot key={v.id} report={v.snapshot} />
        ))}
      </details>
    </>
  );
}
function ReviewContext({ context }: { context: FollowUpReviewContext }) {
  const { item } = context;
  return (
    <>
      {!context.followUpEnabled && <p className="notice">Follow-up reviews are paused.</p>}
      <p>Reviewing clinician · {context.doctorName}</p>
      <div className="fu-review-context">
        <span className="eyebrow">{item.patient.name}</span>
        <h3>{item.carePlan.title}</h3>
        <p>
          Follow-up owner: {item.ownerDoctorName} · Original plan{' '}
          {formatDate(item.carePlan.startDate)} – {formatDate(item.carePlan.endDate)}
        </p>
        <details>
          <summary>Read original treatment instructions</summary>
          <p className="fu-prose">{item.carePlan.instructions}</p>
          {item.carePlan.medications.map((medication, index) => (
            <div className="fu-original-item" key={index}>
              <strong>{medication.name}</strong>
              <p>{medication.instructions}</p>
              <small>
                {medication.schedule} · {medication.duration}
              </small>
              {medication.warnings && <p>{medication.warnings}</p>}
            </div>
          ))}
          {item.carePlan.warnings && (
            <p className="fu-prose">Precautions: {item.carePlan.warnings}</p>
          )}
        </details>
      </div>
      {statusOf(item.carePlan) === 'completed' && (
        <div className="notice">
          This plan is now completed. Its reviews remain available in the patient record.
        </div>
      )}
      <section className="fu-review-reports">
        <h3>
          Patient updates awaiting review <span>{item.unreviewedCount}</span>
        </h3>
        {item.unreviewedCheckIns.length ? (
          <div className="fu-reports">
            {[...item.unreviewedCheckIns]
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((report) => (
                <ReportSnapshot key={report.id} report={report} />
              ))}
          </div>
        ) : (
          <p className="muted small">
            There are no unreviewed patient reports. Record the source of any additional information
            in your assessment.
          </p>
        )}
      </section>
      {item.latestReview && (
        <details className="fu-previous-review">
          <summary>Previous review · {formatDate(item.latestReview.createdAt)}</summary>
          <FollowUpReviewHistory reviews={[item.latestReview]} />
        </details>
      )}
    </>
  );
}

function FollowUpReviewModal({
  target,
  onClose,
  onSaved,
}: {
  target: ReviewTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { session } = useSession(),
    actorId = session.user!.id;
  const { followUpReviews: pending } = usePendingCareSubmissions();
  const { carePlanId, patientId } = target;
  const capture = useAppointmentBookingGuard();
  const stored = pending.get(carePlanId);
  const initial = stored?.command.patientId === patientId ? stored : null;
  const [phase, setPhase] = useState<
    'edit' | 'review' | 'pending' | 'saved' | 'rejected' | 'current'
  >(initial ? 'pending' : 'edit');
  const [context, setContext] = useState<FollowUpReviewContext | null>(null);
  const [attempt, setAttempt] = useState<ReviewAttempt | null>(initial);
  const [saved, setSaved] = useState<FollowUpReview | null>(null);
  const [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(''),
    [rejection, setRejection] = useState('');
  const [assessment, setAssessment] = useState(initial?.command.assessment ?? '');
  const [instructions, setInstructions] = useState(initial?.command.patientInstructions ?? '');
  const [disposition, setDisposition] = useState<FollowUpReview['disposition']>(
    initial?.command.disposition ?? 'continue',
  );
  const [nextDate, setNextDate] = useState(initial?.command.nextReviewDate ?? '');
  const binding = useRef(session);
  binding.current = session;
  const observed = useRef(initial?.snapshots);
  const started = useRef(!!initial),
    openedPending = useRef(!!initial),
    dismissed = useRef(false);
  const reading = useRef(0),
    writing = useRef(false),
    heading = useRef<HTMLDivElement>(null);
  const close = () => {
    dismissed.current = true;
    if (started.current) onSaved();
    else onClose();
  };
  const load = useCallback(
    async (mode: 'edit' | 'current', confirmation?: FollowUpReview, source?: ReviewAttempt) => {
      const origin = capture(),
        seq = ++reading.current;
      const current = () => origin() && !dismissed.current && reading.current === seq;
      setLoading(true);
      setError('');
      try {
        const value = await api<unknown>(
          `/api/care-plans/${encodeURIComponent(carePlanId)}/review-context`,
          { isCurrent: current },
        );
        const fresh = await checkedReviewContext(value, { patientId, carePlanId });
        if (!current()) return;
        if (fresh.doctorId !== binding.current.user?.doctorId) {
          // A linked professional can change since sign-in. Independently confirm the current binding.
          const active = await api<typeof session>('/api/session', { isCurrent: current });
          if (
            active.user?.id !== actorId ||
            active.csrfToken !== binding.current.csrfToken ||
            active.user.doctorId !== fresh.doctorId
          )
            throw new Error(
              'The reviewing clinician could not be confirmed. Please refresh and try again.',
            );
        }
        if (!current()) return;
        if (mode === 'current' && source && confirmation) {
          const latest = fresh.item.latestReview;
          if (
            !latest ||
            fresh.item.revision === source.command.expectedRevision ||
            latest.id === source.previousReviewId
          )
            throw new Error(
              'The current follow-up context could not be confirmed. Please try again.',
            );
          if (latest.id === confirmation.id && !sameReview(latest, confirmation))
            throw new Error(
              'The current follow-up context could not be confirmed. Please try again.',
            );
        }
        if (observed.current) checkReportContinuity(fresh.checkInSnapshots, observed.current);
        observed.current = fresh.checkInSnapshots;
        setContext(fresh);
        setPhase(mode);
        if (mode === 'edit') {
          setAttempt(null);
          setAck(false);
        }
      } catch (problem) {
        if (current()) setError(message(problem));
      } finally {
        if (current()) setLoading(false);
      }
    },
    [actorId, carePlanId, patientId, capture],
  );
  useEffect(() => {
    if (!openedPending.current) void load('edit');
    return () => {
      reading.current++;
    };
  }, [load]);
  useLayoutEffect(() => {
    if (phase !== 'edit' || started.current) heading.current?.focus();
  }, [phase]);
  function review(event: FormEvent) {
    event.preventDefault();
    if (
      phase !== 'edit' ||
      !context ||
      !context.followUpEnabled ||
      context.item.carePlan.effectiveStatus !== 'active' ||
      loading ||
      pending.has(carePlanId) ||
      !assessment.trim() ||
      !instructions.trim() ||
      (disposition !== 'complete' && (!nextDate || nextDate < today()))
    )
      return;
    setAttempt({
      patientName: context.item.patient.name,
      planTitle: context.item.carePlan.title,
      doctorName: context.doctorName,
      previousReviewId: context.item.latestReview?.id ?? null,
      snapshots: context.checkInSnapshots,
      command: {
        requestId: crypto.randomUUID(),
        patientId,
        carePlanId,
        doctorId: context.doctorId,
        expectedRevision: context.item.revision,
        assessment: assessment.trim(),
        patientInstructions: instructions.trim(),
        disposition,
        nextReviewDate: disposition === 'complete' ? null : nextDate,
        reviewedConfirmed: true,
      },
    });
    setError('');
    setAck(false);
    setPhase('review');
  }
  async function send() {
    if (!attempt || writing.current || dismissed.current) return;
    if (
      phase === 'pending'
        ? pending.get(carePlanId) !== attempt
        : phase !== 'review' || !ack || pending.has(carePlanId)
    )
      return;
    const origin = capture();
    const current = () => origin() && !dismissed.current && pending.get(carePlanId) === attempt;
    pending.set(carePlanId, attempt);
    started.current = true;
    writing.current = true;
    setBusy(true);
    setError('');
    setPhase('pending');
    try {
      const value = await api<unknown>(
        `/api/care-plans/${encodeURIComponent(carePlanId)}/reviews/record`,
        { method: 'POST', body: attempt.command, isCurrent: current },
      );
      if (!current()) return;
      const record = confirmedReview(value, attempt, actorId);
      if (!record) return;
      pending.delete(carePlanId);
      setSaved(record);
      setPhase('saved');
    } catch (problem) {
      if (!current()) return;
      const why = reviewRejection(problem, attempt.command, actorId);
      if (!why) return;
      pending.delete(carePlanId);
      setRejection(why);
      setAck(false);
      setPhase('rejected');
    } finally {
      if (origin() && !dismissed.current) {
        writing.current = false;
        setBusy(false);
      }
    }
  }
  const title = {
    edit: 'Review care plan progress',
    review: 'Confirm follow-up review',
    pending: 'Review awaiting confirmation',
    saved: 'Follow-up review recorded',
    rejected: 'Follow-up review not recorded',
    current: 'Current follow-up context',
  }[phase];
  return (
    <Modal title={title} onClose={close}>
      <div className="stack fu-review-form" ref={heading} tabIndex={-1}>
        {phase === 'edit' &&
          (loading ? (
            <Loading />
          ) : !context ? (
            <ErrorState
              message={error || 'Unable to load this care plan.'}
              retry={() => void load('edit')}
            />
          ) : (
            <form className="stack" onSubmit={review}>
              <ReviewContext context={context} />
              {(!context.followUpEnabled ||
                context.item.carePlan.effectiveStatus === 'completed') && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void load('edit')}
                >
                  Refresh review context
                </button>
              )}
              <Field
                label="Clinician assessment"
                hint="Clinic only. Record the source of information and your assessment."
              >
                <textarea
                  required
                  rows={4}
                  maxLength={8000}
                  value={assessment}
                  onChange={(event) => setAssessment(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field
                label="Instructions for the patient"
                hint="Shared in the patient portal immediately when you save."
              >
                <textarea
                  required
                  rows={4}
                  maxLength={8000}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <div className="form-grid">
                <Field label="Review outcome">
                  <select
                    value={disposition}
                    onChange={(event) =>
                      setDisposition(event.target.value as FollowUpReview['disposition'])
                    }
                    disabled={busy}
                  >
                    <option value="continue">Continue follow-up</option>
                    <option value="visit-requested">Request a visit</option>
                    <option value="complete">Complete care plan</option>
                  </select>
                </Field>
                {disposition !== 'complete' && (
                  <Field label="Next review date">
                    <input
                      type="date"
                      required
                      min={today()}
                      value={nextDate}
                      onChange={(event) => setNextDate(event.target.value)}
                      disabled={busy}
                    />
                  </Field>
                )}
              </div>
              <div className="notice">
                {disposition === 'complete'
                  ? 'Completion ends new check-ins for this plan. The original plan and review history stay available.'
                  : disposition === 'visit-requested'
                    ? 'The patient will see your request and a booking link. This does not reserve an appointment.'
                    : 'The next review date tracks follow-up. It does not extend treatment duration or change the original prescription.'}
              </div>

              <div className="fu-form-actions">
                <button type="button" className="button button-secondary" onClick={close}>
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  disabled={
                    !context.followUpEnabled ||
                    context.item.carePlan.effectiveStatus !== 'active' ||
                    !assessment.trim() ||
                    !instructions.trim()
                  }
                >
                  Review before sharing
                </button>
              </div>
            </form>
          ))}
        {(phase === 'review' || phase === 'pending') && attempt && (
          <>
            <ReviewEvidence attempt={attempt} />
            {phase === 'review' ? (
              <>
                <label className="checkbox-label">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  I reviewed this assessment and the instructions to share with the patient.
                </label>
                <div className="fu-form-actions">
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      setAck(false);
                      setPhase('edit');
                    }}
                  >
                    Edit review
                  </button>
                  <button
                    className="button button-primary"
                    disabled={!ack}
                    onClick={() => void send()}
                  >
                    Save review &amp; share instructions
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="notice" role="status">
                  {busy
                    ? 'Confirming the review…'
                    : 'The outcome is uncertain. Retry this review to recover the original confirmation.'}
                </p>
                <div className="fu-form-actions">
                  <button className="button button-secondary" onClick={close}>
                    Close for now
                  </button>
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => void send()}
                  >
                    Retry exact review
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {phase === 'rejected' && (
          <>
            <p className="notice" role="status">
              {rejection}
            </p>
            <p>
              Your draft is preserved. Check the current reports and review your instructions again
              before sharing.
            </p>
            <div className="fu-form-actions">
              <button className="button button-secondary" onClick={close}>
                Close
              </button>
              <button
                className="button button-primary"
                disabled={loading}
                onClick={() => void load('edit', undefined, attempt ?? undefined)}
              >
                Refresh review context
              </button>
            </div>
          </>
        )}
        {phase === 'saved' && saved && attempt && (
          <>
            <p>
              {attempt.patientName} · {attempt.planTitle}
            </p>
            <p>
              This is the original recorded review. The patient can read the shared instructions.
            </p>
            <FollowUpReviewHistory reviews={[saved]} />
            <div className="fu-form-actions">
              <button className="button button-secondary" onClick={close}>
                Close confirmation
              </button>
              <button
                className="button button-primary"
                disabled={loading}
                onClick={() => void load('current', saved, attempt)}
              >
                View current review context
              </button>
            </div>
          </>
        )}
        {phase === 'current' && context && (
          <>
            <ReviewContext context={context} />
            <div className="fu-form-actions">
              <button className="button button-secondary" onClick={() => setPhase('saved')}>
                Back to confirmation
              </button>
              <button className="button button-primary" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
        {error && (phase !== 'edit' || !!context) && (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function AssignmentHistory({
  assignments,
  authorName,
}: {
  assignments: FollowUpAssignment[];
  authorName?: string;
}) {
  return (
    <div className="fu-assignment-history">
      <p className="fu-owner-origin">
        Original care-plan author: {authorName || 'Recorded in the care plan'}
      </p>
      {assignments.length ? (
        assignments.map((assignment) => (
          <article className="fu-assignment-event" key={assignment.id}>
            <strong>
              {assignment.previousDoctorName} → {assignment.doctorName}
            </strong>
            <p>{assignment.reason}</p>
            <small>
              Assigned by {assignment.assignedByName} · {dateTime(assignment.createdAt)} IST
            </small>
          </article>
        ))
      ) : (
        <p className="muted small">
          No handovers. Follow-up responsibility remains with the original plan author.
        </p>
      )}
    </div>
  );
}

function FollowUpOwnerPanel({ plan, onChanged }: { plan: CarePlan; onChanged: () => void }) {
  const { session } = useSession();
  const assignments = useResource<FollowUpAssignment[]>(`/api/care-plans/${plan.id}/assignments`);
  const [assigning, setAssigning] = useState(false);
  const ownerId = assignments.data?.[0]?.doctorId ?? plan.doctorId;
  const ownerName = assignments.data?.[0]?.doctorName ?? plan.doctorName ?? 'Original plan author';
  const canAssign = session.user?.role === 'admin' || session.user?.doctorId === ownerId;
  return (
    <div className="fu-owner-panel">
      <div className="fu-owner-current">
        <div>
          <span>Follow-up owner</span>
          <strong>{ownerName}</strong>
        </div>
        {canAssign && (
          <button
            className="button button-secondary button-small"
            disabled={assignments.loading || !!assignments.error}
            onClick={() => setAssigning(true)}
          >
            Assign follow-up
          </button>
        )}
      </div>
      {assignments.error ? (
        <ErrorState message={assignments.error} retry={assignments.reload} />
      ) : assignments.loading ? (
        <p className="muted small">Loading responsibility history…</p>
      ) : (
        <details>
          <summary>
            Responsibility history{assignments.data?.length ? ` (${assignments.data.length})` : ''}
          </summary>
          <AssignmentHistory assignments={assignments.data ?? []} authorName={plan.doctorName} />
        </details>
      )}
      {assigning && (
        <FollowUpAssignmentModal
          carePlanId={plan.id}
          onClose={() => setAssigning(false)}
          onSaved={() => {
            setAssigning(false);
            void assignments.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function FollowUpAssignmentModal({
  carePlanId,
  onClose,
  onSaved,
}: {
  carePlanId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { session } = useSession();
  const [item, setItem] = useState<FollowUpWorkItem | null>(null);
  const [owners, setOwners] = useState<FollowUpOwner[]>([]);
  const [history, setHistory] = useState<FollowUpAssignment[]>([]);
  const [doctorId, setDoctorId] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const loadContext = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [items, eligible, assignments] = await Promise.all([
        api<FollowUpWorkItem[]>('/api/follow-up-worklist?scope=all'),
        api<FollowUpOwner[]>('/api/follow-up-owners'),
        api<FollowUpAssignment[]>(`/api/care-plans/${carePlanId}/assignments`),
      ]);
      const current = items.find((value) => value.carePlan.id === carePlanId);
      if (!current) throw new Error('This care plan is no longer available. Refresh the worklist.');
      setItem(current);
      setOwners(eligible);
      setHistory(assignments);
      setStale(false);
      setError('');
    } catch (problem) {
      setLoadError(message(problem));
    } finally {
      setLoading(false);
    }
  }, [carePlanId]);
  useEffect(() => {
    void loadContext();
  }, [loadContext]);
  const canAssign =
    !!item && (session.user?.role === 'admin' || session.user?.doctorId === item.ownerDoctorId);
  const eligible = owners.filter((owner) => owner.doctorId !== item?.ownerDoctorId);
  const validOwner = eligible.some((owner) => owner.doctorId === doctorId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!item || !canAssign || !validOwner || busy || stale) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/care-plans/${carePlanId}/assignment`, {
        method: 'POST',
        body: { doctorId, reason, expectedRevision: item.revision },
      });
      toast('Follow-up responsibility assigned. The care plan and reports remain unchanged.');
      onSaved();
    } catch (problem) {
      setError(message(problem));
      if (problem instanceof ApiError && problem.status === 409) setStale(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Assign follow-up owner"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        {loading ? (
          <Loading />
        ) : loadError ? (
          <ErrorState message={loadError} retry={loadContext} />
        ) : (
          item && (
            <>
              <div className="fu-review-context">
                <span className="eyebrow">{item.patient.name}</span>
                <h3>{item.carePlan.title}</h3>
                <p>
                  Current follow-up owner: <strong>{item.ownerDoctorName}</strong>
                </p>
                <p>Original care-plan author: {item.carePlan.doctorName}</p>
              </div>
              {!canAssign && (
                <div className="notice">
                  Only the current follow-up owner or an administrator can assign this plan. The
                  responsibility history remains available.
                </div>
              )}
              {history.length > 0 && (
                <details className="fu-owner-history-disclosure">
                  <summary>Previous handovers ({history.length})</summary>
                  <AssignmentHistory assignments={history} authorName={item.carePlan.doctorName} />
                </details>
              )}
            </>
          )
        )}
        <Field
          label="New follow-up owner"
          hint="Only doctor profiles with an active linked clinical account are eligible."
        >
          <select
            required
            disabled={loading || busy || !canAssign}
            value={doctorId}
            onChange={(event) => setDoctorId(event.target.value)}
          >
            <option value="">Select a clinician</option>
            {eligible.map((owner) => (
              <option key={owner.doctorId} value={owner.doctorId}>
                {owner.doctorName}
              </option>
            ))}
          </select>
        </Field>
        {!loading && !loadError && !eligible.length && (
          <p className="muted small">
            There is no other eligible clinician. An administrator can link an active clinical
            account to another doctor profile in Accounts & access.
          </p>
        )}
        <Field
          label="Reason for handover"
          hint="Clinic-only context for the receiving clinician. This history is preserved."
        >
          <textarea
            required
            rows={4}
            maxLength={8000}
            disabled={busy || !canAssign}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <div className="notice">
          This changes follow-up responsibility. It does not change the original treatment plan,
          mark patient reports reviewed, or restrict authorized clinicians from reading the record.
          Assignment remains available when follow-up activity is paused.
        </div>
        {error && (
          <div className="notice notice-error" role="alert">
            <div>
              <strong>{error}</strong>
              {stale && (
                <p>
                  The plan or its reports changed. Your handover note is preserved. Refresh and
                  confirm the current owner before saving again.
                </p>
              )}
            </div>
          </div>
        )}
        {stale && (
          <button
            className="button button-secondary"
            type="button"
            onClick={loadContext}
            disabled={loading}
          >
            <RefreshCw size={14} /> Refresh assignment context
          </button>
        )}
        <div className="fu-form-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={loading || busy || !!loadError || stale || !canAssign || !validOwner}
          >
            {busy ? 'Assigning…' : 'Save assignment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
