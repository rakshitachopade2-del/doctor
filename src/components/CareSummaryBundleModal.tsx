import { useEffect, useRef, useState } from 'react';
import { Download, FileArchive, FileText, Image, RefreshCw, X } from 'lucide-react';
import type { CareSummary } from '../../shared/care-summary';
import type { CareSummaryCopy } from '../../shared/care-summary-copies';
import type {
  CareSummaryBundleAttachment,
  CareSummaryBundlePreview,
} from '../../shared/care-summary-bundles';
import { api, ApiError, useSession } from '../lib';
import { Badge, ErrorState, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import { copyTimestamp, useSummaryData, useSummaryGuard } from './care-summary-copy-helpers';
import {
  attachmentKey,
  attachmentTitle,
  bundleFailure,
  bundleLimits,
  checkedBundleAttachmentPage,
  checkedBundleBytes,
  checkedBundlePreview,
  checkBundleHeaders,
  fileSize,
} from './care-summary-bundle-helpers';
import './care-summary-bundle.css';

export function CareSummaryBundleModal({
  copy,
  summary,
  onClose,
}: {
  copy: CareSummaryCopy;
  summary: CareSummary;
  onClose: () => void;
}) {
  const { session } = useSession(),
    begin = useSummaryGuard();
  const base = `/api/patients/${encodeURIComponent(copy.patientId)}/care-summary/copies/${encodeURIComponent(copy.id)}/bundle`;
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState<CareSummaryBundleAttachment[]>([]);
  const [preview, setPreview] = useState<CareSummaryBundlePreview | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'download' | 'refresh' | null>(null),
    [error, setError] = useState(''),
    [stale, setStale] = useState(false),
    [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null),
    pending = useRef(false);
  const list = useSummaryData(`${base}/attachments?page=${page}&pageSize=25`, (value) =>
    checkedBundleAttachmentPage(value, copy, summary, page),
  );
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [],
  );
  useEffect(() => {
    if (list.loading || list.error || !list.data) return;
    if (list.data.page !== page) setPage(list.data.page);
    const rows = new Map(list.data.items.map((item) => [attachmentKey(item), item]));
    setSelected((current) => current.map((item) => rows.get(attachmentKey(item)) ?? item));
  }, [list.data, list.loading, list.error, page]);
  function change(item: CareSummaryBundleAttachment, included: boolean) {
    if (pending.current) return;
    setSelected((current) =>
      included
        ? current.some((entry) => attachmentKey(entry) === attachmentKey(item)) ||
          current.length >= bundleLimits.maxAttachments
          ? current
          : [...current, item]
        : current.filter((entry) => attachmentKey(entry) !== attachmentKey(item)),
    );
    setPreview(null);
    setConfirmed(false);
    setError('');
    setMessage('');
  }
  async function refresh() {
    if (pending.current) return;
    const current = begin();
    pending.current = true;
    setBusy('refresh');
    setError('');
    setPreview(null);
    setConfirmed(false);
    setMessage('');
    setStale(false);
    try {
      await list.reload();
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  async function review() {
    if (
      pending.current ||
      stale ||
      list.loading ||
      list.error ||
      !list.data ||
      !selected.length ||
      selected.length > bundleLimits.maxAttachments
    )
      return;
    const controller = new AbortController(),
      origin = begin();
    request.current = controller;
    const current = () => origin() && request.current === controller && !controller.signal.aborted;
    const input = { attachments: selected.map(({ type, id }) => ({ type, id })) };
    pending.current = true;
    setBusy('preview');
    setError('');
    setMessage('');
    setConfirmed(false);
    try {
      const raw = await api<unknown>(`${base}/preview`, {
        method: 'POST',
        body: input,
        signal: controller.signal,
        isCurrent: current,
      });
      if (!current()) return;
      const checked = await checkedBundlePreview(raw, copy, summary, input.attachments);
      if (current()) setPreview(checked);
    } catch (problem) {
      if (!current()) return;
      setError(bundleFailure(problem));
      setPreview(null);
      if (problem instanceof ApiError && problem.status === 409) setStale(true);
    } finally {
      pending.current = false;
      if (current()) {
        request.current = null;
        setBusy(null);
      }
    }
  }
  async function download() {
    if (pending.current || !preview || !confirmed || !session.csrfToken || stale) return;
    const source = preview,
      controller = new AbortController(),
      origin = begin();
    request.current = controller;
    const current = () => origin() && request.current === controller && !controller.signal.aborted;
    pending.current = true;
    setBusy('download');
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${base}/download`, {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ attachments: source.selection, expectedRevision: source.revision }),
      });
      if (!current()) return;
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        if (!current()) return;
        throw new ApiError(
          typeof problem?.error === 'string'
            ? problem.error
            : 'The selected files could not be downloaded. Refresh and review your selection.',
          response.status,
        );
      }
      checkBundleHeaders(response, source);
      const bytes = await response.arrayBuffer();
      if (!current()) return;
      await checkedBundleBytes(bytes, source);
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })),
        link = document.createElement('a');
      link.href = url;
      link.download = source.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('ZIP download started. Keep the downloaded files in a private location.');
    } catch (problem) {
      if (!current()) return;
      setError(bundleFailure(problem));
      if (problem instanceof ApiError && problem.status === 409) {
        setStale(true);
        setPreview(null);
        setConfirmed(false);
      }
    } finally {
      pending.current = false;
      if (current()) {
        request.current = null;
        setBusy(null);
      }
    }
  }
  return (
    <Modal
      title="Download summary attachments"
      onClose={() => {
        if (!pending.current) onClose();
      }}
    >
      <div className="care-bundle stack">
        <div className="care-bundle-source">
          <strong>{copy.patientName}</strong>
          <span>
            Saved {copyTimestamp(copy.savedAt)} IST · by {copy.savedBy.name}
          </span>
          <p>
            This download keeps the saved summary unchanged. Select original images and PDFs
            referenced by that copy; later records are not included.
          </p>
        </div>
        <p className="muted small">
          The ZIP includes the saved JSON, selected original files and a manifest with file
          fingerprints. Image annotations remain in the summary; they are not drawn onto the
          original images. This is a selected export, not a complete internal clinical record.
        </p>
        {error && (
          <div className="notice notice-error care-bundle-error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <p className="notice care-bundle-message" role="status">
            {message}
          </p>
        )}
        {stale && (
          <div className="notice care-bundle-stale">
            <p>
              The selected files could not be confirmed against your preview. Your selection is
              retained. Refresh the list, review any unavailable files and create a new preview.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={!!busy}
              onClick={() => void refresh()}
            >
              Refresh attachment list
            </button>
          </div>
        )}
        {preview ? (
          <section className="care-bundle-preview stack" aria-label="Reviewed download contents">
            <h3>Review your download</h3>
            <p className="muted">
              The ZIP is not encrypted. Anyone who can access the downloaded file can read its
              contents.
            </p>
            <div className="care-bundle-total">
              <FileArchive size={22} aria-hidden="true" />
              <div>
                <strong>{fileSize(preview.byteLength)} ZIP</strong>
                <span>
                  {preview.selection.length} selected{' '}
                  {preview.selection.length === 1 ? 'attachment' : 'attachments'} + saved JSON +
                  manifest
                </span>
              </div>
            </div>
            <ul className="care-bundle-manifest">
              <li>
                <FileText size={18} aria-hidden="true" />
                <div>
                  <strong>care-summary.json</strong>
                  <span>Unchanged saved summary · {fileSize(copy.byteLength)}</span>
                </div>
              </li>
              <li>
                <FileText size={18} aria-hidden="true" />
                <div>
                  <strong>manifest.json</strong>
                  <span>Copy provenance, file names, sizes and SHA-256 fingerprints</span>
                </div>
              </li>
              {preview.manifest.files.map((file) => (
                <li key={attachmentKey(file)}>
                  {file.type === 'image' ? (
                    <Image size={18} aria-hidden="true" />
                  ) : (
                    <FileText size={18} aria-hidden="true" />
                  )}
                  <div>
                    <strong>{attachmentTitle(file)}</strong>
                    <span>
                      {file.type === 'image' ? 'Original image' : 'Original PDF'} ·{' '}
                      {fileSize(file.byteLength)}
                    </span>
                    {file.originalName && <span>{file.originalName}</span>}
                    <span>
                      {file.verification === 'saved-sha256'
                        ? 'Matches the fingerprint recorded in this copy.'
                        : 'Fingerprint computed for this export. No historical fingerprint was recorded.'}
                    </span>
                    {file.uploadedBy && (
                      <span>
                        Uploaded by {file.uploadedBy.name} ({file.uploadedBy.role})
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <label className="care-bundle-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={!!busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                I reviewed the selected files and understand this download contains private health
                information.
              </span>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={!!busy}
                onClick={() => {
                  setPreview(null);
                  setConfirmed(false);
                  setError('');
                  setMessage('');
                }}
              >
                Back to selection
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={!!busy || !confirmed || !session.csrfToken}
                onClick={() => void download()}
              >
                <Download size={16} />
                {busy === 'download' ? 'Preparing ZIP…' : 'Download ZIP'}
              </button>
            </div>
          </section>
        ) : (
          <>
            <div className="care-bundle-toolbar">
              <div>
                <h3>Select attachments</h3>
                <p className="care-bundle-selection-count" role="status">
                  {selected.length} of {bundleLimits.maxAttachments} attachments selected
                </p>
              </div>
              {!stale && (
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={!!busy || list.loading}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={14} />
                  Refresh attachment list
                </button>
              )}
            </div>
            <p className="muted small">
              Select up to 20 files, each at most 5 MiB. The complete ZIP must fit within 25 MiB.
              Availability is checked again when you preview and download.
            </p>
            {selected.length > 0 && (
              <section className="care-bundle-selected" aria-label="Selected attachments">
                <h4>Your selection across all pages</h4>
                <ul>
                  {selected.map((item) => (
                    <li key={attachmentKey(item)}>
                      <div>
                        <strong>{attachmentTitle(item)}</strong>
                        <span>
                          {item.type === 'image' ? 'Image' : 'PDF'} ·{' '}
                          {fileSize(item.recordedByteLength)}
                        </span>
                        {item.availability !== 'present' && <span>{item.problem}</span>}
                      </div>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={!!busy}
                        aria-label={`Remove ${attachmentTitle(item)}`}
                        onClick={() => change(item, false)}
                      >
                        <X size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {list.loading ? (
              <Loading />
            ) : list.error ? (
              <ErrorState message={list.error} retry={() => void refresh()} />
            ) : (
              list.data && (
                <>
                  {list.data.items.length ? (
                    <div className="care-bundle-files">
                      {list.data.items.map((item) => {
                        const included = selected.some(
                          (row) => attachmentKey(row) === attachmentKey(item),
                        );
                        return (
                          <article
                            key={attachmentKey(item)}
                            className="care-bundle-file"
                            data-attachment-type={item.type}
                            data-attachment-id={item.id}
                          >
                            <label>
                              <input
                                type="checkbox"
                                aria-label={`Include ${attachmentTitle(item)}`}
                                checked={included}
                                disabled={
                                  !!busy ||
                                  (!included &&
                                    (item.availability !== 'present' ||
                                      selected.length >= bundleLimits.maxAttachments))
                                }
                                onChange={(event) => change(item, event.target.checked)}
                              />
                              <div>
                                <strong>{attachmentTitle(item)}</strong>
                                <span>
                                  {item.type === 'image' ? 'Original image' : 'Original PDF'} ·{' '}
                                  {fileSize(item.recordedByteLength)}
                                </span>
                                {item.originalName && <span>{item.originalName}</span>}
                                <span>{copyTimestamp(item.createdAt)} IST</span>
                              </div>
                            </label>
                            <Badge tone={item.availability === 'present' ? 'neutral' : 'amber'}>
                              {item.availability === 'present'
                                ? 'Available for verification'
                                : 'Unavailable'}
                            </Badge>
                            {item.problem && <p className="care-bundle-problem">{item.problem}</p>}
                            {item.recordedSha256 === null && item.type === 'image' && (
                              <p className="muted small">
                                No historical fingerprint recorded. Preview will compute one for
                                this export.
                              </p>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="notice">
                      This saved copy references no images or PDFs. Use Download saved JSON to
                      download the summary alone.
                    </div>
                  )}
                  <Pagination
                    {...list.data}
                    label="Attachment pagination"
                    disabled={!!busy}
                    onPageChange={setPage}
                  />
                </>
              )
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={!!busy}
                onClick={onClose}
              >
                Close
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={
                  !!busy || stale || list.loading || !!list.error || !list.data || !selected.length
                }
                onClick={() => void review()}
              >
                {busy === 'preview' ? 'Checking selected files…' : 'Preview download'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
