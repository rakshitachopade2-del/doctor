import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bell, Clock3, RefreshCw } from 'lucide-react';
import type {
  EscalationCandidate,
  EscalationPolicy,
  EscalationPolicyContext,
  EscalationPreview,
  EscalationRun,
  FollowUpEscalationState,
} from '../../shared/follow-up-escalation';
import { api, ApiError, formatDate, useSession } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import { isVisitRequestCollision, useVisitData } from './visit-duration-helpers';
import {
  checkedEscalationHistory,
  checkedEscalationPolicyContext,
  checkedEscalationPolicyMutation,
  checkedEscalationPreview,
  checkedEscalationRun,
  checkedEscalationState,
  escalationFailure,
  sameEscalationPolicy,
  type PolicyAttempt,
  type RunAttempt,
} from './follow-up-escalation-helpers';
import './follow-up-escalations.css';

const time = (v: string) =>
  new Date(v).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' IST';
const stageName = (stage: string) => (stage === 'owner' ? 'Owner notice' : 'Clinic notice');
const labels: Record<FollowUpEscalationState['state'], string> = {
  'not-due': 'Below notice threshold',
  disabled: 'Notices disabled',
  paused: 'Follow-up paused',
  ready: 'Ready for notice',
  'no-recipients': 'No eligible recipients',
  recorded: 'Notice recorded',
  completed: 'Plan completed',
};
const planLink = (patientId: string, planId: string) =>
  `/clinic/patients/${encodeURIComponent(patientId)}?tab=care&plan=${encodeURIComponent(planId)}`;
function useLifetime() {
  const location = useLocation(),
    mounted = useRef(false),
    key = useRef(location.key);
  key.current = location.key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return { mounted, key, locationKey: location.key };
}
const knownFailure = (error: unknown) =>
  error instanceof ApiError &&
  [400, 401, 403, 404, 409].includes(error.status) &&
  !isVisitRequestCollision(error);
function PendingNotice() {
  return (
    <div className="notice notice-warning">
      <strong>The save outcome could not be confirmed.</strong>
      <p>
        The exact request is retained. Retry the same request before editing or closing this dialog.
      </p>
    </div>
  );
}
function PolicySummary({ context }: { context: EscalationPolicyContext }) {
  return (
    <div className="escalation-policy-current">
      <Badge tone={context.policy.enabled ? 'green' : 'neutral'}>
        {context.policy.enabled ? 'Notices enabled' : 'Notices disabled'}
      </Badge>
      <p>
        Owner notice: {context.policy.ownerAfterDays} days after review date · Clinic notice:{' '}
        {context.policy.clinicAfterDays} days after review date
      </p>
      {!context.followUpEnabled && <p>Follow-up is paused. New notices cannot be recorded.</p>}
    </div>
  );
}
export function EscalationOverview({
  context,
  loading,
  error,
  onRetry,
}: {
  context: EscalationPolicyContext | null;
  loading: boolean;
  error: string;
  onRetry: () => Promise<void>;
}) {
  return (
    <section className="escalation-overview" aria-label="Operational notice status">
      <div className="escalation-overview-heading">
        <Bell size={19} />
        <h2>Operational follow-up notices</h2>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} retry={onRetry} />
      ) : context ? (
        <>
          <PolicySummary context={context} />
          <p className="escalation-worker">
            <Clock3 size={15} />
            {context.worker.automaticEnabled
              ? 'Automatic checks every 15 minutes while this server is running.'
              : 'Automatic checks are off for this server; an administrator can run a manual preview.'}
          </p>
          <p className="muted small">
            {context.worker.lastCheckedAt
              ? `Last automatic check: ${time(context.worker.lastCheckedAt)}.`
              : 'No automatic check recorded.'}
            {context.worker.lastErrorAt &&
              ` Last automatic check failure: ${time(context.worker.lastErrorAt)}. Refresh to check the latest status.`}
          </p>
        </>
      ) : null}
      <p className="muted small">
        These are staff notices inside Derma. They do not assess medical urgency or change treatment
        instructions. Email, SMS, WhatsApp and push delivery are not connected.
      </p>
    </section>
  );
}
export function EscalationStateBadge({ value }: { value?: FollowUpEscalationState }) {
  let state: FollowUpEscalationState;
  try {
    state = checkedEscalationState(value);
  } catch {
    return <span className="muted small">Notice status unavailable</span>;
  }
  return (
    <div className="escalation-row-state">
      <Badge
        tone={state.state === 'ready' || state.state === 'no-recipients' ? 'amber' : 'neutral'}
      >
        {labels[state.state]}
      </Badge>
      {state.clinicNoticeAt || state.ownerNoticeAt ? (
        <span className="table-sub">
          Last notice {formatDate(state.clinicNoticeAt ?? state.ownerNoticeAt!)}
        </span>
      ) : null}
      {state.eligibleStage && state.state === 'ready' && (
        <span className="table-sub">{stageName(state.eligibleStage)}</span>
      )}
    </div>
  );
}
function PolicyHistory({ context }: { context: EscalationPolicyContext }) {
  return (
    <section className="escalation-policy-history">
      <h3>Policy history</h3>
      {context.history.length ? (
        context.history.map((c) => (
          <article className="escalation-event" key={c.id}>
            <strong>
              {c.createdByName} · {time(c.createdAt)}
            </strong>
            <p>{c.reason}</p>
            <p className="muted small">
              {c.before.enabled ? 'Enabled' : 'Disabled'} · {c.before.ownerAfterDays}/
              {c.before.clinicAfterDays} days → {c.after.enabled ? 'Enabled' : 'Disabled'} ·{' '}
              {c.after.ownerAfterDays}/{c.after.clinicAfterDays} days
            </p>
          </article>
        ))
      ) : (
        <p className="muted small">Default policy. No policy changes have been recorded.</p>
      )}
    </section>
  );
}
export function EscalationPolicyModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { session } = useSession(),
    life = useLifetime(),
    admin = session.user?.role === 'admin';
  const resource = useVisitData('/api/follow-up-escalation-policy', checkedEscalationPolicyContext);
  const [source, setSource] = useState<EscalationPolicyContext | null>(null),
    [reviewed, setReviewed] = useState<EscalationPolicyContext | null>(null),
    [draft, setDraft] = useState({ enabled: false, owner: '3', clinic: '7' }),
    [reason, setReason] = useState(''),
    [attempt, setAttempt] = useState<PolicyAttempt | null>(null),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const pending = useRef(false);
  const setCurrent = (context: EscalationPolicyContext) => {
    setSource(context);
    setDraft({
      enabled: context.policy.enabled,
      owner: String(context.policy.ownerAfterDays),
      clinic: String(context.policy.clinicAfterDays),
    });
  };
  useEffect(() => {
    if (!source && resource.data) setCurrent(resource.data);
  }, [source, resource.data]);
  const locked = busy || refreshing || phase !== 'editing';
  async function latest() {
    if (pending.current || refreshing) return;
    setRefreshing(true);
    setReviewed(null);
    setError('');
    const key = life.locationKey;
    try {
      const result = checkedEscalationPolicyContext(
        await api<unknown>('/api/follow-up-escalation-policy'),
      );
      if (life.mounted.current && life.key.current === key) setReviewed(result);
    } catch (e) {
      if (life.mounted.current) setError(escalationFailure(e));
    } finally {
      if (life.mounted.current) setRefreshing(false);
    }
  }
  function accept() {
    if (!reviewed || refreshing) return;
    setSource(reviewed);
    setReviewed(null);
    setPhase('editing');
    setAttempt(null);
    setError('');
    setSuccess('');
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!admin || !source || !session.user || pending.current || refreshing || phase === 'conflict')
      return;
    const values: EscalationPolicy = {
      enabled: draft.enabled,
      ownerAfterDays: Number(draft.owner),
      clinicAfterDays: Number(draft.clinic),
    };
    if (
      !attempt &&
      (!/^\d+$/.test(draft.owner) ||
        !/^\d+$/.test(draft.clinic) ||
        values.ownerAfterDays < 1 ||
        values.ownerAfterDays > 30 ||
        values.clinicAfterDays <= values.ownerAfterDays ||
        values.clinicAfterDays > 90 ||
        !reason.trim() ||
        reason.trim().length > 1000)
    ) {
      setError(
        'Enter whole-day thresholds: owner 1–30 days and clinic greater than owner, up to 90 days, plus a reason.',
      );
      return;
    }
    const sent = attempt ?? {
      actorId: session.user.id,
      source,
      body: {
        ...values,
        reason: reason.trim(),
        expectedRevision: source.revision,
        requestId: crypto.randomUUID(),
      },
    };
    const key = life.locationKey;
    pending.current = true;
    setBusy(true);
    setAttempt(sent);
    setError('');
    setSuccess('');
    try {
      const result = checkedEscalationPolicyMutation(
        await api<unknown>('/api/follow-up-escalation-policy', { method: 'POST', body: sent.body }),
        sent,
      );
      if (!life.mounted.current) return;
      if (life.key.current !== key) {
        setPhase('uncertain');
        setError(
          'The page changed before confirmation. Retry the same request to confirm the outcome.',
        );
        return;
      }
      setCurrent(result.context);
      setReason('');
      setAttempt(null);
      setPhase('editing');
      setReviewed(null);
      setSuccess(
        'Policy change recorded. The current policy is shown above. Existing notice history and duplicate protection are retained.',
      );
      void onSaved().catch(() => {});
    } catch (error) {
      if (!life.mounted.current) return;
      setError(escalationFailure(error));
      if (phase !== 'uncertain' && knownFailure(error)) {
        setAttempt(null);
        setPhase((error as ApiError).status === 409 ? 'conflict' : 'editing');
        setReviewed(null);
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (life.mounted.current) setBusy(false);
    }
  }
  const changed =
    !!source &&
    !sameEscalationPolicy(source.policy, {
      enabled: draft.enabled,
      ownerAfterDays: Number(draft.owner),
      clinicAfterDays: Number(draft.clinic),
    });
  return (
    <Modal
      title="Escalation policy"
      onClose={() => {
        if (!busy && !refreshing && phase !== 'uncertain') onClose();
      }}
    >
      <div className="stack escalation-policy-editor">
        {!source ? (
          resource.loading ? (
            <Loading />
          ) : (
            <ErrorState message={resource.error} retry={resource.reload} />
          )
        ) : (
          <>
            <PolicySummary context={source} />
            <p className="muted small">
              Days are counted from the documented review date in Asia/Kolkata. Notices go to
              eligible clinical accounts inside Derma; they are not patient instructions. Changing
              thresholds does not repeat notices already recorded for the same review episode.
            </p>
            {success && (
              <div className="notice" role="status">
                {success}
              </div>
            )}
            {admin ? (
              <form className="stack" onSubmit={save}>
                {error && <ErrorState message={error} />}
                {phase === 'uncertain' && <PendingNotice />}
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    disabled={locked}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  />
                  Enable operational notices
                </label>
                <div className="form-grid">
                  <Field
                    label="Owner notice after days"
                    hint="1–30 calendar days after the review date."
                  >
                    <input
                      type="number"
                      min={1}
                      max={30}
                      step={1}
                      required
                      disabled={locked}
                      value={draft.owner}
                      onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="Clinic notice after days"
                    hint="Greater than the owner threshold; up to 90 days."
                  >
                    <input
                      type="number"
                      min={Number(draft.owner) + 1}
                      max={90}
                      step={1}
                      required
                      disabled={locked}
                      value={draft.clinic}
                      onChange={(e) => setDraft({ ...draft, clinic: e.target.value })}
                    />
                  </Field>
                </div>
                <Field
                  label="Reason for policy change"
                  hint="Visible to clinic doctors and administrators in policy history."
                >
                  <textarea
                    required
                    maxLength={1000}
                    rows={3}
                    disabled={locked}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                {phase === 'conflict' && (
                  <section className="escalation-conflict">
                    <h3>Review the current policy</h3>
                    <p>
                      Your draft is preserved. Refresh and compare the latest saved policy before
                      trying again.
                    </p>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={refreshing}
                      onClick={latest}
                    >
                      {refreshing ? 'Refreshing…' : 'Refresh latest policy'}
                    </button>
                    {reviewed && (
                      <>
                        <PolicySummary context={reviewed} />
                        {reviewed.history[0] && <p>Latest change: {reviewed.history[0].reason}</p>}
                        <button type="button" className="button button-secondary" onClick={accept}>
                          I reviewed the latest policy; keep my draft
                        </button>
                      </>
                    )}
                  </section>
                )}
                <div className="escalation-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || refreshing || phase === 'uncertain'}
                    onClick={onClose}
                  >
                    Close
                  </button>
                  <button
                    className="button button-primary"
                    disabled={
                      busy ||
                      refreshing ||
                      phase === 'conflict' ||
                      (phase !== 'uncertain' && !changed)
                    }
                  >
                    {busy
                      ? 'Saving…'
                      : phase === 'uncertain'
                        ? 'Retry same request'
                        : 'Save escalation policy'}
                  </button>
                </div>
              </form>
            ) : (
              <p className="notice">
                Only administrators can change the policy or create manual notices.
              </p>
            )}
            <PolicyHistory context={source} />
          </>
        )}
      </div>
    </Modal>
  );
}

function Candidate({ item }: { item: EscalationCandidate }) {
  return (
    <article className="escalation-candidate">
      <div className="escalation-candidate-heading">
        <div>
          <strong>{item.patientName}</strong>
          <p>{item.title}</p>
        </div>
        <Badge tone="amber">{stageName(item.stage)}</Badge>
      </div>
      <p>
        Review date {formatDate(item.reviewDate)} · {item.overdueDays} days overdue · Owner:{' '}
        {item.ownerDoctorName}
      </p>
      <p className="muted small">
        {item.routing === 'owner'
          ? 'Recipients linked to the current owner'
          : item.routing === 'owner-unavailable-fallback'
            ? 'Owner unavailable: eligible clinic clinicians will be notified'
            : 'Eligible clinic clinicians will be notified'}
      </p>
      <ul aria-label="Notice recipients">
        {item.recipients.map((r) => (
          <li key={r.userId}>
            {r.name} · {r.role === 'admin' ? 'Administrator' : 'Doctor'}
          </li>
        ))}
      </ul>
    </article>
  );
}
function PreviewSummary({ value }: { value: EscalationPreview }) {
  return (
    <section className="escalation-preview-summary">
      <h3>Preview for {formatDate(value.clinicDate)} · IST</h3>
      <Badge tone={value.status === 'ready' ? 'green' : 'neutral'}>
        {value.status === 'ready'
          ? 'Ready to create notices'
          : value.status === 'disabled'
            ? 'Notices disabled'
            : 'Follow-up paused'}
      </Badge>
      <p>
        Owner threshold {value.policy.ownerAfterDays} days · Clinic threshold{' '}
        {value.policy.clinicAfterDays} days
      </p>
      <dl className="escalation-counts">
        <div>
          <dt>Ready plans</dt>
          <dd>{value.readyTotal}</dd>
        </div>
        <div>
          <dt>In this batch</dt>
          <dd>{value.items.length}</dd>
        </div>
        <div>
          <dt>No eligible recipients</dt>
          <dd>{value.unroutableTotal}</dd>
        </div>
        <div>
          <dt>Already notified</dt>
          <dd>{value.alreadyNotifiedTotal}</dd>
        </div>
      </dl>
      {value.status !== 'ready' && (
        <p className="notice">
          This is a hypothetical preview. New notices cannot be recorded while{' '}
          {value.status === 'disabled'
            ? 'the escalation policy is disabled'
            : 'follow-up is paused'}
          .
        </p>
      )}
      {value.readyTotal > value.items.length && (
        <p>
          Up to 200 plans are processed per check. {value.readyTotal - value.items.length} ready
          plans will remain for a later check.
        </p>
      )}
    </section>
  );
}
function RunReceipt({ run }: { run: EscalationRun }) {
  return (
    <section className="escalation-run-receipt" role="status">
      <h3>{run.notifiedPlans ? 'In-app notices recorded' : 'No new notices recorded'}</h3>
      <p>
        {run.notifiedPlans} plans · {run.recipientCount} recipient notices · {time(run.createdAt)}
      </p>
      <p>
        {run.alreadyNotifiedTotal} already notified · {run.unroutableTotal} without eligible
        recipients · {run.remainingReady} ready plans remaining
      </p>
      <p>
        Recorded by {run.createdByName}. This receipt does not confirm that anyone has read or
        clinically reviewed the notices.
      </p>
    </section>
  );
}
export function EscalationPreviewModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { session } = useSession(),
    life = useLifetime(),
    pending = useRef(false),
    serial = useRef(0);
  const [preview, setPreview] = useState<EscalationPreview | null>(null),
    [receipt, setReceipt] = useState<EscalationRun | null>(null),
    [attempt, setAttempt] = useState<RunAttempt | null>(null),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'review' | 'uncertain'>('editing'),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load(requireReview = false) {
    if (pending.current || phase === 'uncertain') return;
    const request = ++serial.current,
      key = life.locationKey;
    setLoading(true);
    setError('');
    setReceipt(null);
    setPreview(null);
    try {
      const result = checkedEscalationPreview(
        await api<unknown>('/api/follow-up-escalations/preview'),
      );
      if (!life.mounted.current || request !== serial.current || key !== life.key.current) return;
      setPreview(result);
      setPhase(requireReview ? 'review' : 'editing');
    } catch (e) {
      if (life.mounted.current && request === serial.current) setError(escalationFailure(e));
    } finally {
      if (life.mounted.current && request === serial.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      serial.current++;
    };
  }, []);
  async function run() {
    if (
      pending.current ||
      loading ||
      !preview ||
      !session.user ||
      session.user.role !== 'admin' ||
      phase === 'conflict' ||
      phase === 'review' ||
      receipt
    )
      return;
    if (!attempt && preview.status !== 'ready') return;
    const sent = attempt ?? {
      actorId: session.user.id,
      preview,
      body: {
        expectedPreviewRevision: preview.revision,
        expectedPolicyRevision: preview.policyRevision,
        requestId: crypto.randomUUID(),
      },
    };
    pending.current = true;
    setBusy(true);
    setAttempt(sent);
    setError('');
    const key = life.locationKey;
    try {
      const result = checkedEscalationRun(
        await api<unknown>('/api/follow-up-escalations/run', { method: 'POST', body: sent.body }),
        sent,
      );
      if (!life.mounted.current) return;
      if (key !== life.key.current) {
        setPhase('uncertain');
        setError(
          'The page changed before confirmation. Retry the same request to confirm the outcome.',
        );
        return;
      }
      setReceipt(result);
      setAttempt(null);
      setPhase('editing');
      window.dispatchEvent(new Event('derma:activity-changed'));
      void onSaved().catch(() => {});
    } catch (e) {
      if (!life.mounted.current) return;
      setError(escalationFailure(e));
      if (phase !== 'uncertain' && knownFailure(e)) {
        setAttempt(null);
        setPhase((e as ApiError).status === 409 ? 'conflict' : 'editing');
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (life.mounted.current) setBusy(false);
    }
  }
  const locked = busy || loading || phase === 'uncertain';
  return (
    <Modal
      title="Preview follow-up notices"
      onClose={() => {
        if (!locked) onClose();
      }}
    >
      <div className="stack escalation-preview">
        <p className="muted small">
          Review the exact plans and recipients before creating staff notices inside Derma. No
          patient email, SMS, WhatsApp or push message is sent. Viewing this preview creates no
          notices.
        </p>
        {error && <ErrorState message={error} />}
        {phase === 'uncertain' && <PendingNotice />}
        {phase === 'conflict' && (
          <div className="notice notice-warning">
            The preview changed before it could be saved. Refresh the preview and explicitly review
            the new plans and recipients.
          </div>
        )}
        {loading ? (
          <Loading />
        ) : (
          preview && (
            <>
              <PreviewSummary value={preview} />
              {receipt && <RunReceipt run={receipt} />}
              {preview.items.length ? (
                <div className="escalation-candidates">
                  {preview.items.map((item) => (
                    <Candidate key={item.carePlanId} item={item} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No new notices in this batch"
                  description="The check can still record a zero-notice manual receipt when the policy and follow-up module are enabled."
                />
              )}
            </>
          )
        )}
        {phase === 'review' && preview && !loading && (
          <div className="escalation-conflict">
            <p>
              The refreshed preview is shown above. Confirm that you reviewed the current plans,
              dates and recipients.
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setPhase('editing')}
            >
              I reviewed the refreshed preview
            </button>
          </div>
        )}
        <div className="escalation-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={locked}
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={locked}
            onClick={() => void load(phase === 'conflict' || phase === 'review')}
          >
            <RefreshCw size={15} />
            Refresh preview
          </button>
          {!receipt && (
            <button
              type="button"
              className="button button-primary"
              disabled={
                busy ||
                loading ||
                !preview ||
                phase === 'conflict' ||
                phase === 'review' ||
                (phase !== 'uncertain' && preview.status !== 'ready')
              }
              onClick={run}
            >
              {busy
                ? 'Creating…'
                : phase === 'uncertain'
                  ? 'Retry same request'
                  : 'Create in-app notices'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
export function EscalationHistoryModal({
  carePlanId,
  onClose,
}: {
  carePlanId: string;
  onClose: () => void;
}) {
  const resource = useVisitData(
    `/api/care-plans/${encodeURIComponent(carePlanId)}/escalations`,
    (v) => checkedEscalationHistory(v, carePlanId),
  );
  const data = resource.data;
  return (
    <Modal title="Follow-up notice history" onClose={onClose}>
      <div className="stack escalation-history">
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={resource.reload} />
        ) : (
          data && (
            <>
              <div>
                <h3>{data.patientName}</h3>
                <p>{data.title}</p>
                <EscalationStateBadge value={data.current} />
              </div>
              <p className="muted small">
                History records staff in-app notices. Reading a notice does not complete a clinical
                review or change patient instructions. Previous review episodes stay in history.
              </p>
              <Link
                className="button button-secondary"
                to={planLink(data.patientId, data.carePlanId)}
              >
                Open care plan
              </Link>
              {data.events.length ? (
                data.events.map((event) => (
                  <section className="escalation-history-event" key={event.id}>
                    <div className="escalation-history-heading">
                      <Badge
                        tone={event.episodeId === data.current.episodeId ? 'green' : 'neutral'}
                      >
                        {event.episodeId === data.current.episodeId
                          ? 'Current episode'
                          : 'Previous episode'}
                      </Badge>
                      <span>{time(event.createdAt)}</span>
                    </div>
                    <Candidate item={event} />
                    <p className="muted small">
                      {event.source === 'automatic' ? 'Automatic check' : 'Manual check'} ·
                      Evaluated {formatDate(event.clinicDate)} IST · Policy thresholds{' '}
                      {event.policy.ownerAfterDays}/{event.policy.clinicAfterDays} days
                    </p>
                  </section>
                ))
              ) : (
                <EmptyState
                  title="No notices recorded"
                  description="No escalation notices have been recorded for this plan. Clinical reviews remain available in the care record."
                />
              )}
              <button className="button button-secondary" onClick={resource.reload}>
                <RefreshCw size={15} />
                Refresh notice history
              </button>
            </>
          )
        )}
      </div>
    </Modal>
  );
}
