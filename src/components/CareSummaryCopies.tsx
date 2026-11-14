import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, ArrowLeft, Printer, RefreshCw, Save } from 'lucide-react';
import type { CareSummary } from '../../shared/care-summary';
import type { CareSummaryCopy, CareSummaryCopyInput } from '../../shared/care-summary-copies';
import { api, ApiError, useSession } from '../lib';
import { EmptyState, ErrorState, Loading, Modal, PageHeader } from './ui';
import { Pagination } from './Pagination';
import { SummaryDocument } from './CareSummaryDocument';
import { CareSummaryBundleModal } from './CareSummaryBundleModal';
import {
  checkedCareSummary,
  checkedSummaryCopyDetail,
  checkedSummaryCopyPage,
  checkedSummaryCopyResult,
  copyTimestamp,
  useSummaryGuard,
  useSummaryData,
} from './care-summary-copy-helpers';

const failure = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be confirmed. Please try again.';
export function SaveSummaryCopyModal({
  summary,
  onClose,
  onRefresh,
  onSaved,
}: {
  summary: CareSummary;
  onClose: () => void;
  onRefresh: () => void;
  onSaved: (copy: CareSummaryCopy) => void;
}) {
  const { session } = useSession(),
    begin = useSummaryGuard();
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [stale, setStale] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const attempt = useRef<CareSummaryCopyInput | null>(null),
    pending = useRef(false);
  async function save() {
    if (pending.current || !session.user || stale || (!confirmed && !uncertain)) return;
    const input = attempt.current ?? {
      expectedRevision: summary.revision,
      requestId: crypto.randomUUID(),
    };
    attempt.current = input;
    const wasUncertain = uncertain,
      current = begin(),
      actor = session.user;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await api<unknown>(
        `/api/patients/${encodeURIComponent(summary.patient.id)}/care-summary/copies`,
        { method: 'POST', body: input, isCurrent: current },
      );
      if (!current()) return;
      const result = checkedSummaryCopyResult(
        value,
        input,
        summary.patient.id,
        actor.id,
        actor.role,
      );
      onSaved(result.copy);
    } catch (problem) {
      if (!current()) return;
      setError(failure(problem));
      if (
        !wasUncertain &&
        problem instanceof ApiError &&
        problem.status === 409 &&
        !/request.*already|request.*different|idempotency/i.test(problem.message)
      ) {
        setStale(true);
        setConfirmed(false);
      } else if (
        !wasUncertain &&
        problem instanceof ApiError &&
        [400, 403, 404, 413, 422, 429].includes(problem.status)
      ) {
        attempt.current = null;
      } else setUncertain(true);
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <Modal
      title="Save a care summary copy"
      onClose={() => {
        if (!pending.current && !uncertain) onClose();
      }}
    >
      <form
        className="care-copy-confirm"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p>
          Keep an unchanged copy of the shared summary you just reviewed. You and authorized
          clinicians can read, print and download it later.
        </p>
        <div className="care-copy-context">
          <strong>{summary.patient.name}</strong>
          <span>Source generated {copyTimestamp(summary.generatedAt)} IST</span>
        </div>
        <p>
          Only the patient-facing information in this summary is saved. Original image and PDF files
          remain authenticated references. Saving does not create a new clinical assessment.
        </p>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        {uncertain && (
          <div className="notice">
            The save outcome could not be confirmed. Retry the same request to retrieve its copy
            without saving another. Keep this dialog open until the outcome is confirmed.
          </div>
        )}
        {stale ? (
          <div className="notice">
            <p>
              The shared record changed. Refresh and review the complete current summary before
              starting a new save.
            </p>
            <button type="button" className="button button-secondary" onClick={onRefresh}>
              Refresh summary for review
            </button>
          </div>
        ) : (
          <label className="checkbox-label">
            <input
              type="checkbox"
              required
              checked={confirmed}
              disabled={busy || uncertain}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed this summary and want to save an unchanged copy.
          </label>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || uncertain}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={busy || stale || (!confirmed && !uncertain)}
          >
            <Save size={16} />
            {busy ? 'Saving copy…' : uncertain ? 'Retry same request' : 'Save copy'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SavedSummaryCopies({
  patientId,
  recordPath,
}: {
  patientId: string;
  recordPath: string;
}) {
  const [params, setParams] = useSearchParams(),
    location = useLocation();
  const copyId = params.get('copy');
  function navigate(next: Record<string, string | null>, replace = false) {
    const changed = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next))
      value === null ? changed.delete(key) : changed.set(key, value);
    setParams(changed, { replace });
  }
  if (copyId)
    return (
      <SavedSummaryDetail
        key={copyId}
        patientId={patientId}
        copyId={copyId}
        recordPath={recordPath}
        onBack={() => navigate({ copy: null })}
      />
    );
  return (
    <SavedSummaryList
      key={`${patientId}:${location.pathname}`}
      patientId={patientId}
      onPage={(page) => navigate({ page: page === 1 ? null : String(page) })}
      onClamp={(page) => navigate({ page: page === 1 ? null : String(page) }, true)}
    />
  );
}
function SavedSummaryList({
  patientId,
  onPage,
  onClamp,
}: {
  patientId: string;
  onPage: (page: number) => void;
  onClamp: (page: number) => void;
}) {
  const [params] = useSearchParams(),
    location = useLocation();
  const raw = params.get('page'),
    page = raw && /^[1-9]\d{0,6}$/.test(raw) && Number(raw) <= 1000000 ? Number(raw) : 1;
  const list = useSummaryData(
    `/api/patients/${encodeURIComponent(patientId)}/care-summary/copies?page=${page}&pageSize=25`,
    (value) => checkedSummaryCopyPage(value, patientId, page),
  );
  useEffect(() => {
    if (!list.loading && !list.error && list.data && list.data.page !== page)
      onClamp(list.data.page);
  }, [list.loading, list.error, list.data, page]);
  function copyLink(id: string) {
    const next = new URLSearchParams(params);
    next.set('copy', id);
    return `${location.pathname}?${next}`;
  }
  return (
    <>
      <PageHeader
        eyebrow="SHARED CARE RECORD"
        title="Saved care summaries"
        description="Unchanged copies saved by you or your clinic. Later changes appear only in Current summary."
        actions={
          <button
            className="button button-secondary"
            disabled={list.loading}
            onClick={() => void list.reload()}
          >
            <RefreshCw size={16} />
            Refresh saved copies
          </button>
        }
      />
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <ErrorState message={list.error} retry={() => void list.reload()} />
      ) : list.data ? (
        <>
          {list.data.items.length ? (
            <div className="care-copy-list">
              {list.data.items.map((copy) => (
                <article className="care-copy-card" key={copy.id}>
                  <div>
                    <h2>Saved {copyTimestamp(copy.savedAt)} IST</h2>
                    <p>Patient in this copy: {copy.patientName}</p>
                    <p>
                      Saved by {copy.savedBy.name} ({copy.savedBy.role})
                    </p>
                    <p>Source generated {copyTimestamp(copy.generatedAt)} IST</p>
                  </div>
                  <Link className="button button-secondary" to={copyLink(copy.id)}>
                    Open saved copy
                    <span className="sr-only">
                      {' '}
                      saved {copyTimestamp(copy.savedAt)} by {copy.savedBy.name}
                    </span>
                  </Link>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No saved care summaries yet"
              description="Open Current summary, review its contents and choose Save copy to keep an unchanged record."
            />
          )}
          <Pagination
            {...list.data}
            label="Saved care summaries pagination"
            onPageChange={onPage}
          />
        </>
      ) : null}
    </>
  );
}
function SavedSummaryDetail({
  patientId,
  copyId,
  recordPath,
  onBack,
}: {
  patientId: string;
  copyId: string;
  recordPath: string;
  onBack: () => void;
}) {
  const detail = useSummaryData(
    `/api/patients/${encodeURIComponent(patientId)}/care-summary/copies/${encodeURIComponent(copyId)}`,
    (value) => checkedSummaryCopyDetail(value, patientId, copyId),
  );
  const begin = useSummaryGuard(),
    location = useLocation();
  const request = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false),
    [error, setError] = useState(''),
    [bundleOrigin, setBundleOrigin] = useState<string | null>(null);
  useEffect(() => {
    setDownloading(false);
    setError('');
    setBundleOrigin(null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [location.key]);
  async function download() {
    if (!detail.data || detail.loading || detail.error || request.current) return;
    const controller = new AbortController(),
      guard = begin(),
      copy = detail.data.copy;
    request.current = controller;
    const current = () => guard() && request.current === controller && !controller.signal.aborted;
    setDownloading(true);
    setError('');
    try {
      const response = await fetch(
        `/api/patients/${encodeURIComponent(patientId)}/care-summary/copies/${encodeURIComponent(copyId)}/download`,
        { credentials: 'same-origin', signal: controller.signal },
      );
      if (!current()) return;
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        throw new Error(
          problem?.error || 'This saved copy could not be downloaded. Please try again.',
        );
      }
      if (
        !response.headers.get('content-type')?.includes('application/json') ||
        !response.headers.get('content-disposition')?.startsWith('attachment;') ||
        response.headers.get('x-content-sha256') !== copy.contentSha256
      )
        throw new Error(
          'The server did not return the matching saved copy file. Please try again.',
        );
      const bytes = await response.arrayBuffer();
      if (!current()) return;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
      if (!current()) return;
      if (bytes.byteLength !== copy.byteLength || digest !== copy.contentSha256)
        throw new Error(
          'The downloaded file did not match this saved copy. No file was downloaded. Please retry.',
        );
      const summary = checkedCareSummary(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        patientId,
        true,
      );
      if (summary.revision !== copy.sourceRevision || summary.generatedAt !== copy.generatedAt)
        throw new Error('The downloaded file did not match this saved copy. Please retry.');
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' })),
        link = document.createElement('a');
      link.href = url;
      link.download = `care-summary-copy-${copy.id}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      if (current()) setError(failure(problem));
    } finally {
      if (current()) {
        request.current = null;
        setDownloading(false);
      }
    }
  }
  const ready = !!detail.data && !detail.loading && !detail.error;
  return (
    <>
      <div className="care-summary-controls">
        <button className="text-link" onClick={onBack}>
          <ArrowLeft size={15} />
          Back to saved copies
        </button>
      </div>
      <PageHeader
        eyebrow="UNCHANGED HISTORICAL COPY"
        title="Saved care summary"
        description="This document preserves shared records at the time it was saved. It does not include later updates."
        actions={
          <>
            <button
              className="button button-secondary"
              disabled={!ready}
              onClick={() => window.print()}
            >
              <Printer size={16} />
              Print saved copy
            </button>
            <button
              className="button button-primary"
              disabled={!ready || downloading}
              onClick={() => void download()}
            >
              <ArrowDownToLine size={16} />
              {downloading ? 'Preparing saved copy…' : 'Download saved JSON'}
            </button>
            <button
              className="button button-secondary"
              disabled={!ready || downloading}
              onClick={() => setBundleOrigin(location.key)}
            >
              <ArrowDownToLine size={16} />
              Download with attachments
            </button>
          </>
        }
      />
      {error && (
        <div className="notice notice-error care-summary-download-error" role="alert">
          {error}
        </div>
      )}
      {detail.loading ? (
        <Loading />
      ) : detail.error ? (
        <ErrorState message={detail.error} retry={() => void detail.reload()} />
      ) : detail.data ? (
        <SummaryDocument
          data={detail.data.summary}
          copy={detail.data.copy}
          recordPath={recordPath}
        />
      ) : null}
      {bundleOrigin === location.key && detail.data && ready && (
        <CareSummaryBundleModal
          key={`${copyId}:${bundleOrigin}`}
          copy={detail.data.copy}
          summary={detail.data.summary}
          onClose={() => setBundleOrigin(null)}
        />
      )}
    </>
  );
}
