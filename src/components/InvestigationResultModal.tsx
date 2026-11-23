import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useLocation } from 'react-router-dom';
import type { InvestigationResult } from '../../shared/clinical';
import type { PatientDocument } from '../../shared/documents';
import { api, formatDate, useSession } from '../lib';
import { ErrorState, Field, Loading, Modal } from './ui';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { DocumentUploadModal } from './PrivateUploadModal';
import {
  confirmedResult,
  resultDocuments,
  requireOriginalResult,
  resultInvestigation,
  resultRejection,
  sameReport,
  type ReportLabel,
  type ResultAttempt,
  type ResultInvestigation,
} from './investigation-result-helpers';
import './investigation-result.css';

export function useInvestigationResultSubmission(
  patientId: string,
  patientName: string,
  onChange: () => void,
) {
  const location = useLocation(),
    { session } = useSession();
  const { investigationResults: pending } = usePendingCareSubmissions();
  const [selected, setSelected] = useState<string | null>(null);
  useLayoutEffect(
    () => setSelected(null),
    [patientId, location.key, session.user?.id, session.user?.role, session.csrfToken],
  );
  const attempts = [...pending.values()].filter(
    (a) => a.command.patientId === patientId && a.command.submittedByRole === session.user?.role,
  );
  const controls = (
    <Fragment key="investigation-result-submission">
      {!selected &&
        attempts.map((a) => (
          <div className="notice result-resume" key={a.command.investigationId}>
            <p>{a.investigationTitle} · Result awaiting confirmation</p>
            <button
              className="button button-secondary"
              onClick={() => setSelected(a.command.investigationId)}
            >
              Resume result submission
            </button>
          </div>
        ))}
      {selected && (
        <InvestigationResultModal
          key={JSON.stringify([
            patientId,
            selected,
            location.key,
            session.user?.id,
            session.user?.role,
            session.csrfToken,
          ])}
          patientId={patientId}
          patientName={patientName}
          investigationId={selected}
          onClose={(refresh) => {
            setSelected(null);
            if (refresh) onChange();
          }}
        />
      )}
    </Fragment>
  );
  return {
    controls,
    open: setSelected,
    hasPending: (id: string) => attempts.some((a) => a.command.investigationId === id),
  };
}

function ReportList({ reports }: { reports: ReportLabel[] }) {
  return reports.length ? (
    <ol className="result-report-list">
      {reports.map((report) => (
        <li key={report.id}>
          <strong>{report.title}</strong>
          <small>{report.originalName}</small>
        </li>
      ))}
    </ol>
  ) : (
    <p>No reports selected.</p>
  );
}

const titles = {
  edit: '',
  review: 'Review investigation result',
  pending: 'Result awaiting confirmation',
  saved: 'Result submitted',
  rejected: 'Result not submitted',
  current: 'Current investigation',
};
const statuses = {
  ordered: 'Awaiting result',
  'result-received': 'Awaiting clinician review',
  reviewed: 'Reviewed by clinician',
  cancelled: 'Cancelled',
};
function InvestigationResultModal({
  patientId,
  patientName,
  investigationId,
  onClose,
}: {
  patientId: string;
  patientName: string;
  investigationId: string;
  onClose: (refresh: boolean) => void;
}) {
  const { session } = useSession(),
    actor = session.user!,
    isPatient = actor.role === 'patient';
  const { investigationResults: pending } = usePendingCareSubmissions();
  const stored = pending.get(investigationId);
  const initial =
    stored?.command.patientId === patientId && stored.command.submittedByRole === actor.role
      ? stored
      : null;
  const [phase, setPhase] = useState<keyof typeof titles>(initial ? 'pending' : 'edit');
  const [attempt, setAttempt] = useState<ResultAttempt | null>(initial);
  const [order, setOrder] = useState<ResultInvestigation | null>(null);
  const [saved, setSaved] = useState<InvestigationResult | null>(null);
  const [note, setNote] = useState(initial?.command.note ?? '');
  const [selection, setSelection] = useState<ReportLabel[]>(initial?.reports ?? []);
  const [documents, setDocuments] = useState<PatientDocument[] | null>(null);
  const [readingDocuments, setReadingDocuments] = useState(!initial);
  const [docError, setDocError] = useState(''),
    [error, setError] = useState(''),
    [rejection, setRejection] = useState('');
  const [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!initial),
    [uploading, setUploading] = useState(false);
  const capture = useAppointmentBookingGuard(),
    version = useRef(0),
    dismissed = useRef(false),
    sending = useRef(false),
    openedPending = useRef(!!initial),
    refreshOnClose = useRef(!!initial);
  const heading = useRef<HTMLDivElement>(null);
  const load = useCallback(
    async (mode: 'edit' | 'current', known?: InvestigationResult, source?: ResultAttempt) => {
      const origin = capture(),
        seq = ++version.current;
      const current = () => origin() && !dismissed.current && version.current === seq;
      setLoading(true);
      setError('');
      // The result text can be read or composed while the private PDF catalogue is unavailable.
      setReadingDocuments(true);
      setDocuments(null);
      setDocError('');
      const reports = api<unknown>('/api/documents?patientId=' + encodeURIComponent(patientId), {
        isCurrent: current,
      })
        .then((value) => resultDocuments(value, patientId))
        .catch(() => null);
      try {
        const workflows = await api<unknown>(
          '/api/patients/' + encodeURIComponent(patientId) + '/clinical-workflows',
          { isCurrent: current },
        );
        if (!current()) return;
        const fresh = resultInvestigation(workflows, patientId, investigationId);
        if (known && source) requireOriginalResult(fresh, known, source);
        setOrder(fresh);
        setPhase(mode);
        setAck(false);
        if (mode === 'edit') setAttempt(null);
      } catch {
        if (current())
          setError('The current investigation could not be verified. Please try again.');
        return;
      } finally {
        if (current()) setLoading(false);
      }
      const docs = await reports;
      if (!current()) return;
      const complete =
        docs &&
        (!known ||
          !source ||
          source.reports.every((report) => docs.some((d) => sameReport(d, report))));
      setDocuments(complete ? docs : null);
      setDocError(
        complete ? '' : 'The private report list could not be verified. Refresh to try again.',
      );
      setReadingDocuments(false);
    },
    [capture, patientId, investigationId],
  );
  useEffect(() => {
    if (!openedPending.current) void load('edit');
    return () => {
      version.current++;
    };
  }, [load]);
  useLayoutEffect(() => {
    if (phase !== 'edit') heading.current?.focus();
  }, [phase]);
  function close() {
    dismissed.current = true;
    onClose(refreshOnClose.current);
  }
  const available = (report: ReportLabel) => documents?.some((d) => sameReport(d, report)) === true;
  const valid =
    !!order &&
    order.status !== 'cancelled' &&
    (!!note.trim() || selection.length > 0) &&
    selection.every(available);
  function review(event: FormEvent) {
    event.preventDefault();
    if (
      phase !== 'edit' ||
      !valid ||
      !order ||
      loading ||
      sending.current ||
      pending.has(investigationId) ||
      actor.role === 'receptionist'
    )
      return;
    setAttempt({
      patientName,
      investigationTitle: order.title,
      submitterName: actor.name,
      reports: selection,
      priorIds: order.results.map((r) => r.id),
      command: {
        requestId: crypto.randomUUID(),
        patientId,
        investigationId,
        submittedByRole: actor.role,
        note: note.trim(),
        documentIds: selection.map((d) => d.id),
        reviewedConfirmed: true,
      },
    });
    setAck(false);
    setError('');
    setPhase('review');
  }
  async function submit() {
    if (
      !attempt ||
      dismissed.current ||
      sending.current ||
      (phase === 'pending'
        ? pending.get(investigationId) !== attempt
        : phase !== 'review' || !ack || pending.has(investigationId))
    )
      return;
    const origin = capture();
    const current = () =>
      origin() && !dismissed.current && pending.get(investigationId) === attempt;
    sending.current = true;
    refreshOnClose.current = true;
    pending.set(investigationId, attempt);
    setBusy(true);
    setError('');
    setPhase('pending');
    try {
      const value = await api<unknown>(
        '/api/investigations/' + encodeURIComponent(investigationId) + '/results/submit',
        { method: 'POST', body: attempt.command, isCurrent: current },
      );
      if (!current()) return;
      const result = confirmedResult(value, attempt, actor.id);
      if (result) {
        pending.delete(investigationId);
        setSaved(result);
        setPhase('saved');
      }
    } catch (problem) {
      if (!current()) return;
      const message = resultRejection(problem, attempt.command, actor.id);
      if (message) {
        pending.delete(investigationId);
        setAck(false);
        setRejection(message);
        setPhase('rejected');
      }
    } finally {
      if (origin() && !dismissed.current) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  function addReport(d: PatientDocument) {
    const { id, title, originalName, sha256 } = d;
    setSelection((prev) =>
      prev.length >= 10 || prev.some((a) => a.id === id)
        ? prev
        : [...prev, { id, title, originalName, sha256 }],
    );
  }
  if (uploading)
    return (
      <DocumentUploadModal
        patientId={patientId}
        investigationId={investigationId}
        onClose={() => setUploading(false)}
        onUploaded={(document, sameInvestigation) => {
          refreshOnClose.current = true;
          if (sameInvestigation) addReport(document);
          setUploading(false);
          void load('edit');
        }}
      />
    );
  const title =
    phase === 'edit'
      ? isPatient
        ? 'Share an investigation result'
        : 'Add an investigation result'
      : titles[phase];
  const original =
    phase === 'pending' || phase === 'review' || phase === 'saved' || phase === 'rejected'
      ? attempt
      : null;
  return (
    <Modal title={title} onClose={close}>
      <div className="stack result-submission" ref={heading} tabIndex={-1}>
        <p className="muted">
          {original?.patientName ?? patientName} · {original?.investigationTitle ?? order?.title}
        </p>
        {phase === 'edit' &&
          (loading ? (
            <Loading />
          ) : error ? (
            <ErrorState message={error} retry={() => load('edit')} />
          ) : (
            order && (
              <form className="stack" onSubmit={review}>
                {order.status === 'cancelled' && (
                  <p className="notice" role="status">
                    This investigation is cancelled. The saved history remains available.
                  </p>
                )}
                <Field
                  label={isPatient ? 'Result note' : 'Result entry / source note'}
                  hint="Add a note, attach PDF reports, or include both."
                >
                  <textarea
                    rows={4}
                    maxLength={8000}
                    value={note}
                    disabled={order.status === 'cancelled'}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                <div className="result-report-picker">
                  <div className="row between">
                    <h3>Attach PDF reports</h3>
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={order.status === 'cancelled'}
                      onClick={() => setUploading(true)}
                    >
                      {isPatient ? 'Upload a PDF report' : 'Upload report'}
                    </button>
                  </div>
                  <p className="muted small">
                    Select up to 10 reports in the order you want them recorded.
                  </p>
                  {readingDocuments ? (
                    <p role="status">Loading PDF reports…</p>
                  ) : docError ? (
                    <div className="notice notice-error" role="alert">
                      <p>{docError}</p>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => void load('edit')}
                      >
                        Try again
                      </button>
                    </div>
                  ) : documents?.length ? (
                    documents.map((d) => (
                      <label className="result-report-option" key={d.id}>
                        <input
                          type="checkbox"
                          checked={selection.some((v) => sameReport(v, d))}
                          disabled={
                            order.status === 'cancelled' ||
                            (selection.length >= 10 && !selection.some((v) => v.id === d.id))
                          }
                          onChange={(e) => {
                            if (e.target.checked) addReport(d);
                            else setSelection((prev) => prev.filter((v) => v.id !== d.id));
                          }}
                        />
                        <span>
                          <strong>{d.title}</strong>
                          <small>
                            {d.originalName} · {formatDate(d.createdAt)}
                          </small>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="muted">No PDF reports on this record yet.</p>
                  )}
                  {selection
                    .filter((d) => !readingDocuments && !available(d))
                    .map((d) => (
                      <div key={d.id} className="notice result-resume">
                        <span>Selected report could not be verified · {d.title}</span>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => setSelection((prev) => prev.filter((v) => v.id !== d.id))}
                        >
                          Remove report
                        </button>
                      </div>
                    ))}
                </div>
                <div className="result-actions">
                  <button type="button" className="button button-secondary" onClick={close}>
                    Cancel
                  </button>
                  <button className="button button-primary" disabled={!valid}>
                    Review result
                  </button>
                </div>
              </form>
            )
          ))}
        {(phase === 'review' || phase === 'pending' || phase === 'saved') && attempt && (
          <>
            <p>
              {phase === 'saved' ? 'Submitted by' : 'Submitting as'}{' '}
              {phase === 'saved' ? saved?.submittedByName : attempt.submitterName} ·{' '}
              {attempt.command.submittedByRole}
            </p>
            {phase === 'saved' && saved && (
              <p>
                This is your original confirmation. Recorded{' '}
                <time dateTime={saved.createdAt}>
                  {new Date(saved.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}{' '}
                  IST
                </time>
                .
              </p>
            )}
            <section>
              <h3>Result note</h3>
              <p className="pre-line">{attempt.command.note || 'No note entered.'}</p>
            </section>
            <section>
              <h3>Attached PDF reports</h3>
              <ReportList reports={attempt.reports} />
            </section>
          </>
        )}
        {phase === 'review' && (
          <>
            <p>Submitting adds a result to the investigation history for clinician review.</p>
            <label className="checkbox-label">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
              reviewed this result and the reports to share.
            </label>
            <div className="result-actions">
              <button
                className="button button-secondary"
                onClick={() => {
                  setAck(false);
                  setAttempt(null);
                  setPhase('edit');
                }}
              >
                Edit result
              </button>
              <button
                className="button button-primary"
                disabled={!ack}
                onClick={() => void submit()}
              >
                {isPatient ? 'Share result with clinic' : 'Save result entry'}
              </button>
            </div>
          </>
        )}
        {phase === 'pending' && (
          <>
            <p className="notice" role="status">
              {busy
                ? 'Confirming the result…'
                : 'The outcome is uncertain. Retry the exact result to recover the original confirmation.'}
            </p>
            <div className="result-actions">
              <button className="button button-secondary" onClick={close}>
                Close for now
              </button>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                Retry exact result
              </button>
            </div>
          </>
        )}
        {phase === 'rejected' && (
          <>
            <p className="notice" role="status">
              {rejection}
            </p>
            <p>Refresh the investigation and report list to review your draft again.</p>
            <div className="result-actions">
              <button className="button button-secondary" onClick={close}>
                Close
              </button>
              <button
                className="button button-primary"
                disabled={loading}
                onClick={() => void load('edit')}
              >
                Refresh investigation
              </button>
            </div>
          </>
        )}
        {phase === 'saved' && saved && (
          <div className="result-actions">
            <button className="button button-secondary" onClick={close}>
              Close confirmation
            </button>
            <button
              className="button button-primary"
              disabled={loading}
              onClick={() => void load('current', saved, attempt ?? undefined)}
            >
              View current investigation
            </button>
          </div>
        )}
        {phase === 'current' && order && (
          <>
            <p>{statuses[order.status]}</p>
            {[...order.results].reverse().map((r) => (
              <article key={r.id} className="result-history">
                <h3>
                  {r.submittedByName} · {formatDate(r.createdAt)}
                </h3>
                <p className="pre-line">{r.note || 'No note entered.'}</p>
                {r.documentIds.map((id) => {
                  const doc = documents?.find((d) => d.id === id);
                  return doc ? (
                    <a className="text-link" href={doc.url} download key={id}>
                      {doc.title}
                    </a>
                  ) : (
                    <span key={id}>Attached PDF report</span>
                  );
                })}
              </article>
            ))}
            {docError && (
              <ErrorState
                message={docError}
                retry={() => saved && load('current', saved, attempt ?? undefined)}
              />
            )}
            <div className="result-actions">
              <button
                className="button button-secondary"
                onClick={() => {
                  version.current++;
                  setLoading(false);
                  setError('');
                  setPhase('saved');
                }}
              >
                Back to confirmation
              </button>
              <button className="button button-primary" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
        {phase !== 'edit' && error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
