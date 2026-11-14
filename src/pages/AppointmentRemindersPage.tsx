import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Bell, RefreshCw } from 'lucide-react';
import type {
  AppointmentReminderCandidate,
  AppointmentReminderEvent,
  AppointmentReminderPolicy,
  AppointmentReminderPolicyContext,
  AppointmentReminderRun,
  AppointmentReminderSnapshot,
} from '../../shared/appointment-reminders';
import { api, ApiError, formatDate, useSession } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal, PageHeader } from '../components/ui';
import { Pagination } from '../components/Pagination';
import { visitClock } from '../components/visit-duration-helpers';
import {
  checkedReminderHistory,
  checkedReminderPage,
  checkedReminderPolicyChange,
  checkedReminderPolicyContext,
  checkedReminderPolicyMutation,
  checkedReminderPreview,
  checkedReminderRun,
  checkedReminderRunReceipt,
  checkedReminderRunSummary,
  reminderFailure,
  reminderStamp,
  sameReminderValue,
  useReminderData,
  useReminderGuard,
  type ReminderPolicyAttempt,
  type ReminderRunAttempt,
} from './appointment-reminder-helpers';
import './appointment-reminders.css';

const basePath = '/clinic/appointment-reminders';
const stateLabels = {
  disabled: 'Reminders disabled',
  'not-scheduled': 'Not scheduled',
  past: 'Start time reached',
  'not-due': 'Outside reminder window',
  'no-recipient': 'No eligible patient account',
  recorded: 'Reminder recorded',
  ready: 'Ready for a reminder',
};
function PolicyDescription({ policy }: { policy: AppointmentReminderPolicy }) {
  return (
    <div className="reminder-policy-description">
      <Badge tone={policy.enabled ? 'green' : 'neutral'}>
        {policy.enabled ? 'Enabled' : 'Disabled'}
      </Badge>
      <span>
        Record an in-app reminder within {policy.leadHours}{' '}
        {policy.leadHours === 1 ? 'hour' : 'hours'} before a scheduled visit.
      </span>
    </div>
  );
}
function VisitSummary({ appointment }: { appointment: AppointmentReminderSnapshot }) {
  return (
    <div className="reminder-visit-summary">
      <strong>{appointment.patientName}</strong>
      <p>
        {formatDate(appointment.date)} · {visitClock(appointment.time)} IST ·{' '}
        {appointment.durationMinutes} minutes
      </p>
      <p>
        {appointment.doctorName} ·{' '}
        {appointment.mode === 'online' ? 'Online consultation' : 'In clinic'}
      </p>
      <Badge>{appointment.status.replaceAll('-', ' ')}</Badge>
    </div>
  );
}
function AppointmentLink({ id, runId }: { id: string; runId?: string }) {
  return (
    <Link
      className="text-link"
      to={`${basePath}?appointment=${encodeURIComponent(id)}${runId ? `&run=${encodeURIComponent(runId)}` : ''}`}
    >
      Appointment reminder history
    </Link>
  );
}
function CandidateCard({ candidate }: { candidate: AppointmentReminderCandidate }) {
  return (
    <article className="reminder-preview-candidate">
      <VisitSummary appointment={candidate.appointment} />
      <p>
        Patient account: <strong>{candidate.recipient.name}</strong>
      </p>
      <p className="muted small">Reminder window opened {reminderStamp(candidate.dueAt)} IST</p>
      <AppointmentLink id={candidate.appointment.id} />
    </article>
  );
}
function EventCard({ event }: { event: AppointmentReminderEvent }) {
  return (
    <article className="reminder-event">
      <VisitSummary appointment={event.appointment} />
      <p>
        In-app reminder recorded for <strong>{event.recipient.name}</strong>
      </p>
      <p className="muted small">
        {reminderStamp(event.createdAt)} IST ·{' '}
        {event.source === 'automatic' ? 'Automatic check' : 'Manual check'} ·{' '}
        {event.policy.leadHours}-hour policy
      </p>
      <p className="muted small">
        This entry preserves the appointment details at the check. Open its current history to see
        later changes.
      </p>
      <AppointmentLink id={event.appointment.id} runId={event.runId} />
    </article>
  );
}
function RunReceipt({ run }: { run: AppointmentReminderRun }) {
  return (
    <section className="reminder-run-receipt">
      <h2>In-app reminders recorded</h2>
      <p>
        {run.noticeCount} recipient {run.noticeCount === 1 ? 'notice' : 'notices'} ·{' '}
        {run.createdByName} · {reminderStamp(run.createdAt)} IST
      </p>
      <PolicyDescription policy={run.policy} />
      <p>
        {run.remainingReady} ready recipient notices remaining · {run.unroutableTotal} appointments
        without an eligible patient account · {run.alreadyRecordedTotal} recipient reminders already
        recorded
      </p>
      <p className="muted small">
        Checked {reminderStamp(run.checkedAt)} IST. This record does not confirm that a patient read
        the reminder or will attend.
      </p>
    </section>
  );
}

export function AppointmentRemindersPage() {
  const [params, setParams] = useSearchParams(),
    location = useLocation(),
    { session } = useSession();
  const appointmentId = params.get('appointment'),
    runId = params.get('run'),
    main = !appointmentId && !runId;
  const policy = useReminderData(
    main ? '/api/appointment-reminder-policy' : null,
    checkedReminderPolicyContext,
  );
  const [action, setAction] = useState<{ kind: 'policy' | 'preview'; origin: string } | null>(null),
    [refreshVersion, setRefreshVersion] = useState(0),
    [success, setSuccess] = useState('');
  useLayoutEffect(() => {
    setAction((current) => (current?.origin === location.key ? current : null));
    setSuccess('');
  }, [location.key]);
  async function refresh() {
    setRefreshVersion((value) => value + 1);
    await policy.reload();
  }
  const admin = session.user?.role === 'admin';
  return (
    <div className="appointment-reminders-page">
      <Link to="/clinic/appointments" className="text-link">
        <ArrowLeft size={15} />
        Back to appointments
      </Link>
      {appointmentId ? (
        <AppointmentHistory key={appointmentId} appointmentId={appointmentId} runId={runId} />
      ) : runId ? (
        <RunDetails key={runId} runId={runId} />
      ) : (
        <>
          <PageHeader
            eyebrow="APPOINTMENT OPERATIONS"
            title="Appointment reminders"
            description="Optional reminders recorded in each eligible patient's activity inbox."
            actions={
              <>
                <button
                  className="button button-secondary"
                  disabled={policy.loading}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={16} />
                  Refresh reminders
                </button>
                {admin && (
                  <button
                    className="button button-secondary"
                    onClick={() => setAction({ kind: 'policy', origin: location.key })}
                  >
                    Edit reminder policy
                  </button>
                )}
                <button
                  className="button button-primary"
                  onClick={() => setAction({ kind: 'preview', origin: location.key })}
                >
                  <Bell size={16} />
                  Preview reminders
                </button>
              </>
            }
          />
          <div className="notice reminder-delivery-note">
            These reminders appear inside Derma when a patient opens or refreshes the app. Email,
            SMS, WhatsApp, push and external calendar delivery are not connected. A recorded
            reminder is not an attendance confirmation.
          </div>
          {success && (
            <div className="notice" role="status">
              {success}
            </div>
          )}
          <section className="reminder-overview" aria-labelledby="reminder-policy-title">
            <h2 id="reminder-policy-title">Current reminder policy</h2>
            {policy.loading ? (
              <Loading />
            ) : policy.error ? (
              <ErrorState message={policy.error} retry={() => void policy.reload()} />
            ) : policy.data ? (
              <>
                <PolicyDescription policy={policy.data.policy} />
                <p>
                  {policy.data.worker.automaticEnabled
                    ? 'Automatic checks every 5 minutes while this server is running.'
                    : 'Automatic checks are off for this server. An administrator can preview and create reminders manually.'}
                </p>
                <p className="muted small">
                  {policy.data.worker.lastCheckedAt
                    ? `Last automatic check: ${reminderStamp(policy.data.worker.lastCheckedAt)} IST.`
                    : 'No automatic check recorded.'}
                  {policy.data.worker.lastErrorAt &&
                    ` Last automatic failure: ${reminderStamp(policy.data.worker.lastErrorAt)} IST. Refresh to check the latest status.`}
                </p>
                <p className="muted small">
                  Each check handles up to {policy.data.worker.batchLimit} recipient notices.
                  Missing eligible accounts remain visible for later checks.
                </p>
              </>
            ) : null}
            <p className="muted small">
              One reminder is recorded for each patient account and appointment date, time,
              clinician and mode. Policy, fee, name or duration changes do not resend it. Returning
              to a previously reminded schedule does not resend it.
            </p>
          </section>
          <PolicyHistory key={`policy:${refreshVersion}`} />
          <RunHistory key={`runs:${refreshVersion}`} />
        </>
      )}
      {action?.origin === location.key && action.kind === 'policy' && admin && (
        <PolicyModal
          onClose={() => setAction(null)}
          onSaved={async () => {
            setAction(null);
            setSuccess(
              'Reminder policy change recorded. The current policy below includes any later changes.',
            );
            await refresh();
          }}
        />
      )}
      {action?.origin === location.key && action.kind === 'preview' && (
        <PreviewModal
          onClose={() => setAction(null)}
          onSaved={async (run) => {
            setAction(null);
            setParams({ run: run.id });
          }}
        />
      )}
    </div>
  );
}

function PolicyHistory() {
  const [page, setPage] = useState(1),
    resource = useReminderData(
      `/api/appointment-reminder-policy/history?page=${page}&pageSize=25`,
      (value) => checkedReminderPage(value, page, checkedReminderPolicyChange),
    );
  useEffect(() => {
    if (resource.data && resource.data.page !== page) setPage(resource.data.page);
  }, [resource.data, page]);
  return (
    <section className="reminder-policy-history">
      <h2>Policy history</h2>
      <p className="muted">Staff-only reasons and the policy recorded at each change.</p>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorState message={resource.error} retry={() => void resource.reload()} />
      ) : resource.data ? (
        <>
          {resource.data.items.length ? (
            resource.data.items.map((change) => (
              <article className="reminder-policy-change" key={change.id}>
                <h3>
                  {change.createdByName} · {reminderStamp(change.createdAt)} IST
                </h3>
                <p className="reminder-private-reason">{change.reason}</p>
                <p>
                  {change.before.enabled ? 'Enabled' : 'Disabled'} · {change.before.leadHours} hours
                  → {change.after.enabled ? 'Enabled' : 'Disabled'} · {change.after.leadHours} hours
                </p>
              </article>
            ))
          ) : (
            <EmptyState
              title="Default policy"
              description="No reminder policy changes have been recorded."
            />
          )}
          <Pagination
            {...resource.data}
            label="Reminder policy history pagination"
            onPageChange={setPage}
          />
        </>
      ) : null}
    </section>
  );
}
function RunHistory() {
  const [page, setPage] = useState(1),
    resource = useReminderData(
      `/api/appointment-reminders/runs?page=${page}&pageSize=25`,
      (value) => checkedReminderPage(value, page, checkedReminderRunSummary),
    );
  useEffect(() => {
    if (resource.data && resource.data.page !== page) setPage(resource.data.page);
  }, [resource.data, page]);
  return (
    <section className="reminder-runs">
      <h2>Reminder check history</h2>
      <p className="muted">
        Manual and automatic checks that created reminders. Empty automatic checks update the
        last-check status above without adding a history entry.
      </p>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorState message={resource.error} retry={() => void resource.reload()} />
      ) : resource.data ? (
        <>
          {resource.data.items.length ? (
            resource.data.items.map((run) => (
              <article className="reminder-run-row" key={run.id}>
                <div>
                  <h3>
                    {run.source === 'automatic' ? 'Automatic check' : 'Manual check'} ·{' '}
                    {reminderStamp(run.createdAt)} IST
                  </h3>
                  <p>
                    {run.noticeCount} recipient notices recorded · {run.remainingReady} ready
                    notices remaining
                  </p>
                  <p className="muted small">Recorded by {run.createdByName}</p>
                </div>
                <Link
                  className="button button-secondary button-small"
                  to={`${basePath}?run=${encodeURIComponent(run.id)}`}
                >
                  View check
                </Link>
              </article>
            ))
          ) : (
            <EmptyState
              title="No reminder checks recorded"
              description="Preview the current window to see which appointments are eligible."
            />
          )}
          <Pagination
            {...resource.data}
            label="Reminder check history pagination"
            onPageChange={setPage}
          />
        </>
      ) : null}
    </section>
  );
}
function RunDetails({ runId }: { runId: string }) {
  const resource = useReminderData(
    `/api/appointment-reminders/runs/${encodeURIComponent(runId)}`,
    (value) => checkedReminderRun(value, runId),
  );
  return (
    <>
      <PageHeader
        eyebrow="IMMUTABLE CHECK RECORD"
        title="Reminder check"
        description="Recorded recipients and appointment details from one completed check."
      />
      <Link to={basePath} className="text-link">
        Back to reminder controls
      </Link>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorState message={resource.error} retry={() => void resource.reload()} />
      ) : resource.data ? (
        <>
          <RunReceipt run={resource.data} />
          <div className="reminder-events">
            {resource.data.events.map((event) => (
              <EventCard event={event} key={event.id} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
function AppointmentHistory({
  appointmentId,
  runId,
}: {
  appointmentId: string;
  runId: string | null;
}) {
  const [page, setPage] = useState(1),
    resource = useReminderData(
      `/api/appointments/${encodeURIComponent(appointmentId)}/reminders?page=${page}&pageSize=25`,
      (value) => checkedReminderHistory(value, appointmentId, page),
    );
  useEffect(() => {
    if (resource.data && resource.data.page !== page) setPage(resource.data.page);
  }, [resource.data, page]);
  return (
    <>
      <PageHeader
        eyebrow="APPOINTMENT OPERATIONS"
        title="Appointment reminder history"
        description="Current eligibility and the unchanged reminders previously recorded for this visit."
        actions={
          <button
            className="button button-secondary"
            disabled={resource.loading}
            onClick={() => void resource.reload()}
          >
            Refresh appointment reminders
          </button>
        }
      />
      <Link
        className="text-link"
        to={runId ? `${basePath}?run=${encodeURIComponent(runId)}` : basePath}
      >
        {runId ? 'Back to reminder check' : 'Back to reminder controls'}
      </Link>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorState message={resource.error} retry={() => void resource.reload()} />
      ) : resource.data ? (
        <>
          <section className="reminder-current-appointment">
            <h2>Current appointment</h2>
            <VisitSummary appointment={resource.data.appointment} />
            <p>
              <Badge tone={resource.data.current.state === 'ready' ? 'amber' : 'neutral'}>
                {stateLabels[resource.data.current.state]}
              </Badge>
            </p>
            <p>Reminder window opens {reminderStamp(resource.data.current.dueAt)} IST.</p>
            <p>
              {resource.data.current.recipient
                ? `Patient account: ${resource.data.current.recipient.name}`
                : 'No eligible patient account is linked for this check.'}
            </p>
            {resource.data.current.recordedAt && (
              <p>
                Recorded for this schedule: {reminderStamp(resource.data.current.recordedAt)} IST.
              </p>
            )}
            <Link
              className="text-link"
              to={`/clinic/appointments?date=${resource.data.appointment.date}&patientId=${encodeURIComponent(resource.data.appointment.patientId)}&doctorId=${encodeURIComponent(resource.data.appointment.doctorId)}`}
            >
              Open appointment
            </Link>
          </section>
          <h2>Recorded reminders</h2>
          {resource.data.items.length ? (
            <div className="reminder-events">
              {resource.data.items.map((event) => (
                <EventCard event={event} key={event.id} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No reminders recorded for this visit"
              description="Eligibility is checked using the current schedule, policy and linked patient account."
            />
          )}
          <Pagination
            {...resource.data}
            label="Appointment reminder history pagination"
            onPageChange={setPage}
          />
        </>
      ) : null}
    </>
  );
}

function PolicyModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { session } = useSession(),
    begin = useReminderGuard(),
    resource = useReminderData('/api/appointment-reminder-policy', checkedReminderPolicyContext);
  const [source, setSource] = useState<AppointmentReminderPolicyContext | null>(null),
    [latest, setLatest] = useState<AppointmentReminderPolicyContext | null>(null),
    [enabled, setEnabled] = useState(false),
    [hours, setHours] = useState('24'),
    [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false),
    attempt = useRef<ReminderPolicyAttempt | null>(null);
  useEffect(() => {
    if (!source && resource.data) {
      setSource(resource.data);
      setEnabled(resource.data.policy.enabled);
      setHours(String(resource.data.policy.leadHours));
    }
  }, [source, resource.data]);
  const locked = busy || phase !== 'editing',
    changed = source && !sameReminderValue(source.policy, { enabled, leadHours: Number(hours) });
  function close() {
    if (!pending.current && phase !== 'uncertain') onClose();
  }
  async function refreshLatest() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setLatest(null);
    const current = begin();
    try {
      const value = await api<unknown>('/api/appointment-reminder-policy', { isCurrent: current });
      if (current()) setLatest(checkedReminderPolicyContext(value));
    } catch (problem) {
      if (current()) setError(reminderFailure(problem));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !source || !session.user || phase === 'conflict') return;
    const uncertain = phase === 'uncertain',
      current = begin(),
      sent = attempt.current ?? {
        source,
        actorId: session.user.id,
        body: {
          enabled,
          leadHours: Number(hours),
          reason: reason.trim(),
          expectedRevision: source.revision,
          requestId: crypto.randomUUID(),
        },
      };
    attempt.current = sent;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await api<unknown>('/api/appointment-reminder-policy', {
        method: 'POST',
        body: sent.body,
        isCurrent: current,
      });
      if (!current()) return;
      checkedReminderPolicyMutation(value, sent);
      await onSaved();
    } catch (problem) {
      if (!current()) return;
      setError(reminderFailure(problem));
      if (uncertain) setPhase('uncertain');
      else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        !/request.*already|request.*different|idempotency/i.test(problem.message)
      ) {
        setPhase('conflict');
        setLatest(null);
      } else if (problem instanceof ApiError && [400, 403, 404, 422, 429].includes(problem.status))
        attempt.current = null;
      else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <Modal title="Appointment reminder policy" onClose={close}>
      <form className="reminder-policy-form" onSubmit={submit}>
        <p>
          This policy controls only upcoming-visit reminders in patient activity. It is independent
          of follow-up care and sends no email, SMS, WhatsApp or push message.
        </p>
        {resource.loading && !source ? (
          <Loading />
        ) : resource.error && !source ? (
          <ErrorState message={resource.error} retry={() => void resource.reload()} />
        ) : (
          source && (
            <>
              <label className="reminder-checkbox">
                <input
                  type="checkbox"
                  role="switch"
                  checked={enabled}
                  disabled={locked}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                Enable in-app appointment reminders
              </label>
              <Field
                label="Hours before appointment"
                hint="One window, from 1 to 168 hours before each scheduled start."
              >
                <input
                  type="number"
                  min={1}
                  max={168}
                  step={1}
                  required
                  disabled={locked}
                  value={hours}
                  onChange={(event) => setHours(event.target.value)}
                />
              </Field>
              <Field label="Reason for policy change" hint="Staff-only policy history.">
                <textarea
                  rows={3}
                  required
                  maxLength={1000}
                  disabled={locked}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
            </>
          )
        )}
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        {phase === 'uncertain' && (
          <div className="notice">
            The policy outcome could not be confirmed. Retry the same request to retrieve its saved
            change. Editing and closing remain locked until the outcome is confirmed.
          </div>
        )}
        {phase === 'conflict' && (
          <div className="notice">
            <p>
              The policy changed. Your draft is preserved. Refresh and review the latest values
              before keeping this draft.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void refreshLatest()}
            >
              Refresh latest policy
            </button>
            {latest && (
              <section className="reminder-latest-policy">
                <h3>Latest saved policy</h3>
                <PolicyDescription policy={latest.policy} />
                {latest.latestChange && (
                  <p>
                    {latest.latestChange.createdByName} ·{' '}
                    {reminderStamp(latest.latestChange.createdAt)} IST ·{' '}
                    {latest.latestChange.reason}
                  </p>
                )}
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => {
                    setSource(latest);
                    setLatest(null);
                    attempt.current = null;
                    setPhase('editing');
                    setError('');
                  }}
                >
                  I reviewed the latest policy; keep my draft
                </button>
              </section>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || phase === 'uncertain'}
            onClick={close}
          >
            Close
          </button>
          <button
            className="button button-primary"
            disabled={
              busy ||
              !source ||
              phase === 'conflict' ||
              (phase === 'editing' && (!changed || !reason.trim()))
            }
          >
            {busy
              ? 'Saving policy…'
              : phase === 'uncertain'
                ? 'Retry same request'
                : 'Save reminder policy'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function PreviewModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (run: AppointmentReminderRun) => Promise<void>;
}) {
  const { session } = useSession(),
    admin = session.user?.role === 'admin',
    begin = useReminderGuard(),
    resource = useReminderData('/api/appointment-reminders/preview', checkedReminderPreview);
  const [confirmed, setConfirmed] = useState(false),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false),
    attempt = useRef<ReminderRunAttempt | null>(null),
    preview = resource.data;
  const locked = busy || phase !== 'editing';
  function close() {
    if (!pending.current && phase !== 'uncertain') onClose();
  }
  async function refresh() {
    if (pending.current || phase === 'uncertain') return;
    pending.current = true;
    setBusy(true);
    setError('');
    setConfirmed(false);
    const current = begin();
    try {
      const value = await resource.reload();
      if (current() && value) {
        attempt.current = null;
        setPhase('editing');
      }
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      pending.current ||
      !admin ||
      !preview ||
      phase === 'conflict' ||
      (phase === 'editing' && (!confirmed || preview.status !== 'ready' || !preview.items.length))
    )
      return;
    const uncertain = phase === 'uncertain',
      current = begin(),
      sent = attempt.current ?? {
        preview,
        actorId: session.user!.id,
        body: {
          expectedPreviewRevision: preview.revision,
          expectedPolicyRevision: preview.policyRevision,
          confirmed: true as const,
          requestId: crypto.randomUUID(),
        },
      };
    attempt.current = sent;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await api<unknown>('/api/appointment-reminders/run', {
        method: 'POST',
        body: sent.body,
        isCurrent: current,
      });
      if (!current()) return;
      const run = checkedReminderRunReceipt(value, sent);
      await onSaved(run);
    } catch (problem) {
      if (!current()) return;
      setError(reminderFailure(problem));
      if (uncertain) setPhase('uncertain');
      else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        !/request.*already|request.*different|idempotency/i.test(problem.message)
      ) {
        setPhase('conflict');
        setConfirmed(false);
      } else if (
        problem instanceof ApiError &&
        [400, 403, 404, 422, 429].includes(problem.status)
      ) {
        attempt.current = null;
        setConfirmed(false);
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <Modal title="Preview appointment reminders" onClose={close}>
      <form className="reminder-preview-form" onSubmit={submit}>
        <p>
          This check covers upcoming appointments across the clinic. It records notices only in
          eligible patient activity inboxes.
        </p>
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={() => void refresh()} />
        ) : (
          preview && (
            <>
              <PolicyDescription policy={preview.policy} />
              <p>
                Checked {reminderStamp(preview.generatedAt)} IST · Window ends{' '}
                {reminderStamp(preview.windowEndAt)} IST
              </p>
              <div className="reminder-counts">
                {[
                  ['Upcoming appointments', preview.upcomingAppointmentTotal],
                  ['Ready recipient notices', preview.readyTotal],
                  ['No eligible patient account', preview.unroutableTotal],
                  ['Already recorded', preview.alreadyRecordedTotal],
                ].map(([label, count]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
              {preview.status === 'disabled' && (
                <div className="notice">
                  Reminders are disabled. This window is shown for reference; no ready recipients or
                  new reminders are created.
                </div>
              )}
              {preview.readyTotal > preview.items.length && (
                <p>
                  Only the first {preview.items.length} recipient notices are in this batch.{' '}
                  {preview.readyTotal - preview.items.length} remain for a later check.
                </p>
              )}
              <div className="reminder-preview-list">
                {preview.items.map((candidate) => (
                  <CandidateCard
                    candidate={candidate}
                    key={`${candidate.episodeId}:${candidate.recipient.id}`}
                  />
                ))}
              </div>
              {!preview.items.length && (
                <p className="muted">No recipient notices are ready in this preview.</p>
              )}
              {admin ? (
                <label className="reminder-checkbox">
                  <input
                    type="checkbox"
                    required
                    checked={confirmed}
                    disabled={locked || preview.status !== 'ready' || !preview.items.length}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I reviewed these patient recipients and appointment details.
                </label>
              ) : (
                <p className="notice">
                  Only administrators can create manual reminders. You can review the current policy
                  and recorded history.
                </p>
              )}
            </>
          )
        )}
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        {phase === 'conflict' && (
          <div className="notice">
            <p>
              The policy, appointment window or recipients changed. Refresh this preview and confirm
              the current recipients again.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh reminder preview
            </button>
          </div>
        )}
        {phase === 'uncertain' && (
          <div className="notice">
            The reminder check outcome could not be confirmed. Retry the same request to retrieve
            its recorded result without creating duplicates.
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || phase === 'uncertain'}
            onClick={close}
          >
            Close
          </button>
          {phase === 'editing' && (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || resource.loading}
              onClick={() => void refresh()}
            >
              Refresh reminder preview
            </button>
          )}
          {admin && (
            <button
              className="button button-primary"
              disabled={
                busy ||
                resource.loading ||
                !!resource.error ||
                !preview ||
                phase === 'conflict' ||
                (phase === 'editing' &&
                  (!confirmed || preview.status !== 'ready' || !preview.items.length))
              }
            >
              {busy
                ? 'Recording reminders…'
                : phase === 'uncertain'
                  ? 'Retry same request'
                  : 'Create in-app reminders'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
