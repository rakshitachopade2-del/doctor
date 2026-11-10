import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarDays,
  ClipboardCheck,
  HeartHandshake,
  History,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { CarePlan, CheckIn, ClinicSettings } from '../../shared/types';
import type { FollowUpReview, FollowUpWorkItem } from '../../shared/follow-up';
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
  const [scope, setScope] = useState(session.user?.role === 'doctor' ? 'mine' : 'all');
  const resource = useResource<FollowUpWorkItem[]>(`/api/follow-up-worklist?scope=${scope}`);
  const settings = useResource<ClinicSettings>('/api/settings');
  const [filter, setFilter] = useState('due');
  const [search, setSearch] = useState('');
  const [reviewId, setReviewId] = useState<string | null>(null);
  const enabled = settings.data?.modules.followUp === true;
  const canReview = !!session.user?.doctorId;
  const data = resource.data ?? [];
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
          <button
            className="button button-secondary"
            onClick={resource.reload}
            disabled={resource.loading}
          >
            <RefreshCw size={15} /> Refresh worklist
          </button>
        }
      />
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
            <strong>{count}</strong>
            <p>{detail}</p>
          </Card>
        ))}
      </div>
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
                            <span className="table-sub">{item.ownerDoctorName}</span>
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
                        <div className="fu-row-actions">
                          {active && canReview && (
                            <button
                              className="button button-primary button-small"
                              disabled={!enabled}
                              onClick={() => setReviewId(plan.id)}
                            >
                              Review progress
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
      {reviewId && (
        <FollowUpReviewModal
          carePlanId={reviewId}
          onClose={() => setReviewId(null)}
          onSaved={() => {
            setReviewId(null);
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
      <small>Submitted or updated {dateTime(report.createdAt)} IST</small>
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
  const history = useResource<FollowUpReview[]>(`/api/care-plans/${plan.id}/reviews`);
  const [reviewing, setReviewing] = useState(false);
  const active = statusOf(plan) === 'active';
  return (
    <section className="fu-plan-section">
      <div className="fu-plan-section-heading">
        <h3>
          <History size={16} /> Follow-up reviews
        </h3>
        {active && session.user?.doctorId && (
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
          carePlanId={plan.id}
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

export function FollowUpReviewModal({
  carePlanId,
  onClose,
  onSaved,
}: {
  carePlanId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [item, setItem] = useState<FollowUpWorkItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assessment, setAssessment] = useState('');
  const [instructions, setInstructions] = useState('');
  const [disposition, setDisposition] = useState<FollowUpReview['disposition']>('continue');
  const [nextDate, setNextDate] = useState('');
  const toast = useToast();
  const loadContext = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const items = await api<FollowUpWorkItem[]>('/api/follow-up-worklist?scope=all');
      const current = items.find((value) => value.carePlan.id === carePlanId);
      if (!current)
        throw new Error(
          'This care plan is no longer available. Close this dialog and refresh the record.',
        );
      setItem(current);
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!item || stale || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/care-plans/${carePlanId}/reviews`, {
        method: 'POST',
        body: {
          expectedRevision: item.revision,
          assessment,
          patientInstructions: instructions,
          disposition,
          nextReviewDate: disposition === 'complete' ? null : nextDate,
        },
      });
      toast('Review recorded. Instructions are available in the patient’s portal.');
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
      title="Review care plan progress"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack fu-review-form" onSubmit={submit}>
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
                  {item.ownerDoctorName} · Original plan {formatDate(item.carePlan.startDate)} –{' '}
                  {formatDate(item.carePlan.endDate)}
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
                    There are no unreviewed patient reports. Record the source of any additional
                    information in your assessment.
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
          )
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
        {error && (
          <div className="notice notice-error" role="alert">
            <div>
              <strong>{error}</strong>
              {stale && (
                <p>
                  Your draft is preserved. Refresh the reports and previous review, then check your
                  assessment before saving again.
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
            <RefreshCw size={15} /> Refresh review context
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
            disabled={
              busy ||
              loading ||
              !!loadError ||
              stale ||
              !item ||
              statusOf(item.carePlan) === 'completed'
            }
          >
            {busy ? 'Saving…' : 'Save review & share instructions'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
