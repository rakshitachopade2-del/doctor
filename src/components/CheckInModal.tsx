import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { CheckIn } from '../../shared/types';
import { api, formatDate, today, useSession } from '../lib';
import { Field, Modal } from './ui';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { checkedMessageSettings } from './care-message-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import {
  adherenceLabels,
  feelingLabels,
  checkInRejection,
  confirmReportContinuity,
  confirmedCheckIn,
  readCheckInSource,
  type CheckInAnswers,
  type CheckInSource,
  type ReviewedCheckIn,
} from './check-in-submission-helpers';

const titles = {
  edit: 'Your daily check-in',
  review: 'Review your check-in',
  pending: 'Check-in awaiting confirmation',
  rejected: 'Check-in not saved',
  saved: 'Check-in saved',
  current: 'Current saved report',
} as const;

function ReportValues({ report }: { report: CheckInAnswers | null }) {
  if (!report) return <p>No report is saved for this date.</p>;
  return (
    <dl className="check-in-values">
      <dt>Routine</dt>
      <dd>{adherenceLabels[report.adherence]}</dd>
      <dt>Feeling</dt>
      <dd>{feelingLabels[report.feeling]}</dd>
      <dt>Note</dt>
      <dd>{report.note || 'No note shared'}</dd>
    </dl>
  );
}

function ReportTime({ stamp }: { stamp: string }) {
  return (
    <p className="muted small">
      Saved on{' '}
      <time dateTime={stamp}>
        {new Date(stamp).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'medium',
          timeStyle: 'medium',
        })}{' '}
        IST
      </time>
    </p>
  );
}

export function CheckInModal({
  initial,
  patientName,
  onClose,
}: {
  initial: CheckInSource;
  patientName: string;
  onClose: (refresh: boolean) => void;
}) {
  const { session } = useSession();
  const actorId = session.user!.id;
  const { checkInSubmission: pending } = usePendingCareSubmissions();
  const capture = useAppointmentBookingGuard();
  const [source, setSource] = useState(initial);
  const [attempt, setAttempt] = useState<ReviewedCheckIn | null>(pending.current);
  const [phase, setPhase] = useState<keyof typeof titles>(pending.current ? 'pending' : 'edit');
  const starting = pending.current?.command ?? initial.existing;
  const [adherence, setAdherence] = useState<CheckIn['adherence']>(starting?.adherence ?? 'taken');
  const [feeling, setFeeling] = useState<CheckIn['feeling']>(starting?.feeling ?? 'same');
  const [note, setNote] = useState(starting?.note ?? '');
  const [acknowledged, setAcknowledged] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [saved, setSaved] = useState<CheckIn | null>(null);
  const [currentReport, setCurrentReport] = useState<CheckIn | null>(null);
  const [rejection, setRejection] = useState('');
  const [unavailable, setUnavailable] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false),
    dismissed = useRef(false),
    attempted = useRef(!!pending.current),
    readGeneration = useRef(0);
  const heading = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (phase !== 'edit' || comparing) heading.current?.focus();
  }, [phase, comparing]);
  useLayoutEffect(() => {
    // A rapid Back/Forward can invalidate the request without unmounting this dialog.
    const release = () => {
      readGeneration.current++;
      working.current = false;
      setBusy(false);
    };
    window.addEventListener('popstate', release);
    window.addEventListener('hashchange', release);
    return () => {
      window.removeEventListener('popstate', release);
      window.removeEventListener('hashchange', release);
    };
  }, []);
  function close() {
    dismissed.current = true;
    onClose(attempted.current);
  }
  function review(event: FormEvent) {
    event.preventDefault();
    if (phase !== 'edit' || working.current || pending.current) return;
    const reviewedNote = note.trim();
    setNote(reviewedNote);
    setAttempt({
      source,
      command: {
        requestId: crypto.randomUUID(),
        patientId: source.patientId,
        carePlanId: source.carePlanId,
        date: source.date,
        expectedUpdatedAt: source.existing?.createdAt ?? null,
        adherence,
        feeling,
        note: reviewedNote,
        reviewedConfirmed: true,
      },
    });
    setAcknowledged(false);
    setError('');
    setPhase('review');
  }
  async function send() {
    if (!attempt || working.current || dismissed.current) return;
    if (
      phase === 'pending'
        ? pending.current !== attempt
        : phase !== 'review' || !acknowledged || pending.current
    )
      return;
    const origin = capture();
    const current = () => origin() && !dismissed.current && pending.current === attempt;
    working.current = true;
    attempted.current = true;
    pending.current = attempt;
    setBusy(true);
    setError('');
    setPhase('pending');
    try {
      const result = await api<unknown>('/api/check-ins/submit', {
        method: 'POST',
        body: attempt.command,
        isCurrent: current,
      });
      if (!current()) return;
      const report = confirmedCheckIn(result, attempt, actorId);
      if (!report) return;
      pending.current = null;
      setSaved(report);
      setPhase('saved');
    } catch (problem) {
      if (!current()) return;
      const message = checkInRejection(problem, attempt, actorId);
      if (!message) return;
      pending.current = null;
      setAcknowledged(false);
      setRejection(message);
      setPhase('rejected');
    } finally {
      if (origin() && !dismissed.current) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  async function refreshReport() {
    if (working.current || dismissed.current || (phase !== 'rejected' && phase !== 'saved')) return;
    const origin = capture();
    const generation = ++readGeneration.current;
    const current = () => origin() && !dismissed.current && readGeneration.current === generation;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const [record, settings] = await Promise.all([
        api<unknown>('/api/patients/' + encodeURIComponent(source.patientId), {
          isCurrent: current,
        }),
        phase === 'rejected'
          ? api<unknown>('/api/settings', { isCurrent: current }).then(checkedMessageSettings)
          : null,
      ]);
      if (!current()) return;
      const { source: fresh, plan } = readCheckInSource(
        record,
        source.patientId,
        source.carePlanId,
        source.date,
        source.planTitle,
      );
      confirmReportContinuity(fresh, phase === 'saved' ? saved : source.existing);
      if (phase === 'saved') {
        if (!plan) throw new Error('We could not confirm the care plan.');
        setCurrentReport(fresh.existing);
        setPhase('current');
        return;
      }
      setSource(fresh);
      setComparing(true);
      const clinicDay = today();
      if (
        !settings?.modules.followUp ||
        !plan ||
        !plan.active ||
        source.date < plan.startDate ||
        source.date > plan.endDate ||
        source.date > clinicDay
      ) {
        setUnavailable('Check-ins are unavailable for this plan and date.');
        return;
      }
      setAttempt(null);
      setAcknowledged(false);
      setPhase('edit');
    } catch {
      if (current()) setError('We could not confirm the current report. Please try again.');
    } finally {
      if (current()) {
        readGeneration.current++;
        working.current = false;
        setBusy(false);
      }
    }
  }
  function edit() {
    setAttempt(null);
    setAcknowledged(false);
    setPhase('edit');
  }
  return (
    <Modal title={titles[phase]} onClose={close}>
      <div className="stack check-in-dialog" ref={heading} tabIndex={-1}>
        <p className="muted">
          {patientName} · {source.planTitle} ·{' '}
          <time dateTime={source.date}>{formatDate(source.date)}</time>
        </p>
        {phase === 'edit' && (
          <form className="stack" onSubmit={review}>
            {comparing && (
              <section>
                <h3>Current saved report</h3>
                <ReportValues report={source.existing} />
                {source.existing && <ReportTime stamp={source.existing.createdAt} />}
              </section>
            )}
            {comparing && <h3>Your draft</h3>}
            <Field label="How did your routine go today?">
              <select
                className="select"
                value={adherence}
                onChange={(event) => setAdherence(event.target.value as typeof adherence)}
              >
                {Object.entries(adherenceLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="How are you feeling compared with before?">
              <select
                className="select"
                value={feeling}
                onChange={(event) => setFeeling(event.target.value as typeof feeling)}
              >
                {Object.entries(feelingLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Anything you want your clinic to know?"
              hint="Optional. This is your own report, not a clinical assessment."
            >
              <textarea
                className="textarea"
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="How your day went, questions, or changes you noticed"
              />
            </Field>
            {(feeling === 'worse' || adherence !== 'taken') && (
              <div className="notice">
                For questions about symptoms or changing your treatment, contact your clinician.
                Check-ins do not change your prescribed plan.
              </div>
            )}
            <button className="button button-primary">Review check-in</button>
          </form>
        )}
        {(phase === 'review' || phase === 'pending') && attempt && (
          <>
            <p>
              {source.existing
                ? 'This correction will replace your saved report for this date.'
                : 'This will be your first report for this date.'}
            </p>
            <ReportValues report={attempt.command} />
            {phase === 'review' ? (
              <>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  I reviewed this report and want to share it with my clinic.
                </label>
                <div className="check-in-actions">
                  <button className="button button-secondary" onClick={edit}>
                    Edit check-in
                  </button>
                  <button
                    className="button button-primary"
                    disabled={!acknowledged}
                    onClick={() => void send()}
                  >
                    Save check-in
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="notice" role="status">
                  {busy
                    ? 'Confirming your check-in…'
                    : 'The outcome is uncertain. Retry the same report to confirm whether it was saved.'}
                </p>
                <div className="check-in-actions">
                  <button className="button button-secondary" onClick={close}>
                    Close for now
                  </button>
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => void send()}
                  >
                    Retry exact check-in
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {phase === 'rejected' && (
          <>
            <p className="notice notice-warning" role="status">
              {rejection}
            </p>
            {unavailable && (
              <>
                <p>{unavailable}</p>
                <section>
                  <h3>Current saved report</h3>
                  <ReportValues report={source.existing} />
                </section>
                <section>
                  <h3>Your draft</h3>
                  <ReportValues report={{ adherence, feeling, note }} />
                </section>
              </>
            )}
            <div className="check-in-actions">
              <button className="button button-secondary" onClick={close}>
                Close
              </button>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => void refreshReport()}
              >
                Review latest report
              </button>
            </div>
          </>
        )}
        {phase === 'saved' && saved && (
          <>
            <p>
              {source.existing ? 'Your correction was saved.' : 'Your check-in was created.'} This
              is your original confirmation.
            </p>
            <ReportValues report={saved} />
            <ReportTime stamp={saved.createdAt} />
            <div className="check-in-actions">
              <button className="button button-secondary" onClick={close}>
                Close confirmation
              </button>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => void refreshReport()}
              >
                View current report
              </button>
            </div>
          </>
        )}
        {phase === 'current' && (
          <>
            <ReportValues report={currentReport} />
            {currentReport && <ReportTime stamp={currentReport.createdAt} />}
            <div className="check-in-actions">
              <button className="button button-secondary" onClick={() => setPhase('saved')}>
                Back to confirmation
              </button>
              <button className="button button-primary" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
