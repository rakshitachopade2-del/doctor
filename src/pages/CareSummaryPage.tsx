import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, ArrowLeft, Printer, RefreshCw, Save } from 'lucide-react';
import type { CareSummary } from '../../shared/care-summary';
import type { CareSummaryCopy } from '../../shared/care-summary-copies';
import { useSession } from '../lib';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/ui';
import { SummaryDocument } from '../components/CareSummaryDocument';
import { SaveSummaryCopyModal, SavedSummaryCopies } from '../components/CareSummaryCopies';
import {
  checkedCareSummary,
  useSummaryGuard,
  useSummaryData,
} from '../components/care-summary-copy-helpers';
import './care-summary.css';

const snapshotDate = (value: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
export function CareSummaryPage() {
  const { id } = useParams();
  const { session } = useSession();
  if (!session.user) return <Navigate to="/login" replace />;
  if (session.user.role === 'receptionist') return <Navigate to="/clinic" replace />;
  const patient = session.user.role === 'patient';
  const patientId = patient ? session.user.patientId : id;
  if (!patientId)
    return (
      <EmptyState
        title="Choose a patient to view a care summary"
        action={
          <Link to={patient ? '/my-care' : '/clinic/patients'} className="button button-secondary">
            Return to records
          </Link>
        }
      />
    );
  return <SummaryViews key={patientId} patientId={patientId} patient={patient} />;
}

function SummaryViews({ patientId, patient }: { patientId: string; patient: boolean }) {
  const [params, setParams] = useSearchParams();
  const copies = params.get('view') === 'copies';
  const recordPath = patient
    ? '/my-care/record'
    : `/clinic/patients/${encodeURIComponent(patientId)}`;
  function view(saved: boolean, copy?: CareSummaryCopy) {
    const next = new URLSearchParams(params);
    next.delete('copy');
    next.delete('page');
    saved ? next.set('view', 'copies') : next.delete('view');
    if (copy) next.set('copy', copy.id);
    setParams(next);
  }
  return (
    <div className="care-summary-page">
      <nav className="care-summary-view-controls" aria-label="Care summary views">
        <button
          className={`button ${copies ? 'button-secondary' : 'button-primary'}`}
          aria-pressed={!copies}
          onClick={() => view(false)}
        >
          Current summary
        </button>
        <button
          className={`button ${copies ? 'button-primary' : 'button-secondary'}`}
          aria-pressed={copies}
          onClick={() => view(true)}
        >
          Saved copies
        </button>
      </nav>
      {copies ? (
        <SavedSummaryCopies patientId={patientId} recordPath={recordPath} />
      ) : (
        <SummaryWorkspace
          patientId={patientId}
          patient={patient}
          onSaved={(copy) => view(true, copy)}
        />
      )}
    </div>
  );
}

function SummaryWorkspace({
  patientId,
  patient,
  onSaved,
}: {
  patientId: string;
  patient: boolean;
  onSaved: (copy: CareSummaryCopy) => void;
}) {
  const summary = useSummaryData<CareSummary>(
    `/api/patients/${encodeURIComponent(patientId)}/care-summary`,
    (value) => checkedCareSummary(value, patientId),
  );
  const location = useLocation(),
    begin = useSummaryGuard();
  const [saveOrigin, setSaveOrigin] = useState<string | null>(null),
    [reviewNotice, setReviewNotice] = useState('');
  useLayoutEffect(() => {
    setSaveOrigin((previous) => (previous === location.key ? previous : null));
  }, [location.key]);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [stale, setStale] = useState(false);
  const request = useRef<AbortController | null>(null);
  const revision = summary.data?.revision;
  const recordPath = patient
    ? '/my-care/record'
    : `/clinic/patients/${encodeURIComponent(patientId)}`;
  useEffect(() => {
    setDownloading(false);
    setDownloadError('');
    setStale(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [revision, location.key]);
  function refresh() {
    request.current?.abort();
    request.current = null;
    setDownloading(false);
    setDownloadError('');
    setStale(false);
    void summary.reload();
  }
  async function download() {
    if (!summary.data || summary.loading || summary.error || stale || request.current) return;
    const displayed = summary.data;
    const controller = new AbortController();
    const guard = begin();
    request.current = controller;
    const current = () => guard() && request.current === controller && !controller.signal.aborted;
    setDownloading(true);
    setDownloadError('');
    try {
      const response = await fetch(
        `/api/patients/${encodeURIComponent(patientId)}/care-summary/download?revision=${encodeURIComponent(displayed.revision)}`,
        { credentials: 'same-origin', signal: controller.signal },
      );
      if (!current()) return;
      if (response.status === 409) {
        setStale(true);
        setDownloadError(
          'Your shared care record has changed since this summary was loaded. Refresh the summary before downloading the latest version.',
        );
        return;
      }
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(problem?.error || 'The summary could not be downloaded. Please try again.');
      }
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error('The server did not return a summary file. Please try again.');
      const blob = await response.blob();
      if (!current()) return;
      const saved = checkedCareSummary(JSON.parse(await blob.text()), patientId);
      if (!current()) return;
      if (
        saved.schemaVersion !== 1 ||
        saved.audience !== 'patient' ||
        saved.revision !== displayed.revision ||
        saved.patient?.id !== patientId
      )
        throw new Error('The download did not match the displayed summary. Refresh and try again.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `care-summary-${snapshotDate(saved.generatedAt)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      if (current())
        setDownloadError(
          problem instanceof Error ? problem.message : 'The summary could not be downloaded.',
        );
    } finally {
      if (current()) {
        request.current = null;
        setDownloading(false);
      }
    }
  }
  const ready = !!summary.data && !summary.loading && !summary.error;
  return (
    <div className="care-summary-page">
      <div className="care-summary-controls row">
        <Link className="text-link" to={recordPath}>
          <ArrowLeft size={15} />
          Back to health record
        </Link>
        <Link
          className="text-link"
          to={
            patient
              ? '/my-care/details'
              : `/clinic/patients/${encodeURIComponent(patientId)}/details`
          }
        >
          Patient details & allergy history
        </Link>
      </div>
      <PageHeader
        eyebrow="YOUR SHARED CARE RECORD"
        title="Care summary"
        description="A patient-facing snapshot of shared records, ready to read, print or keep."
        actions={
          <>
            <button
              className="button button-secondary"
              disabled={summary.loading}
              onClick={refresh}
            >
              <RefreshCw size={16} />
              Refresh summary
            </button>
            <button
              className="button button-secondary"
              disabled={!ready}
              onClick={() => window.print()}
            >
              <Printer size={16} />
              Print summary
            </button>
            <button
              className="button button-secondary"
              disabled={!ready || stale}
              onClick={() => {
                setReviewNotice('');
                setSaveOrigin(location.key);
              }}
            >
              <Save size={16} />
              Save copy
            </button>
            <button
              className="button button-primary"
              disabled={!ready || stale || downloading}
              onClick={download}
            >
              <ArrowDownToLine size={16} />
              {downloading ? 'Preparing summary…' : 'Download JSON'}
            </button>
          </>
        }
      />
      {reviewNotice && (
        <div className="notice care-summary-download-error" role="status">
          {reviewNotice}
        </div>
      )}
      {downloadError && (
        <div className="notice notice-error care-summary-download-error" role="alert">
          <span>{downloadError}</span>
          {stale && (
            <button className="button button-secondary button-small" onClick={refresh}>
              Refresh to download
            </button>
          )}
        </div>
      )}
      {saveOrigin === location.key && summary.data && (
        <SaveSummaryCopyModal
          key={saveOrigin}
          summary={summary.data}
          onClose={() => setSaveOrigin(null)}
          onSaved={onSaved}
          onRefresh={() => {
            setSaveOrigin(null);
            setReviewNotice(
              'The shared record changed. Review the updated summary, then choose Save copy again.',
            );
            refresh();
          }}
        />
      )}
      {summary.loading ? (
        <Loading />
      ) : summary.error ? (
        <ErrorState message={summary.error} retry={refresh} />
      ) : summary.data ? (
        <SummaryDocument data={summary.data} recordPath={recordPath} />
      ) : (
        <EmptyState title="No summary available" />
      )}
    </div>
  );
}
