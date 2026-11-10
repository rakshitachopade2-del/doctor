import { useState, type FormEvent } from 'react';
import { Download, FileText, Upload } from 'lucide-react';
import type { PatientDocument } from '../../shared/documents';
import { api, formatDate, useResource, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import './documents.css';

export function DocumentsPanel({ patientId }: { patientId: string }) {
  const documents = useResource<PatientDocument[]>(
    `/api/documents?patientId=${encodeURIComponent(patientId)}`,
  );
  const [upload, setUpload] = useState(false);
  const [search, setSearch] = useState('');
  const matches = documents.data?.filter((document) =>
    `${document.title} ${document.originalName}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Card className="report-documents">
      <div className="section-heading">
        <div>
          <h2>Private PDF reports</h2>
          <p className="muted small">Original files, available to the patient and clinical team.</p>
        </div>
        <button className="button button-secondary" onClick={() => setUpload(true)}>
          <Upload size={16} />
          Upload PDF report
        </button>
      </div>
      <div className="notice">
        <FileText size={18} />
        <span>
          Uploading a report shares the file with the care team. Clinical interpretation appears
          separately when your clinician reviews an investigation.
        </span>
      </div>
      {!!documents.data?.length && (
        <div className="report-search">
          <Field label="Search reports">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Report title or filename"
            />
          </Field>
        </div>
      )}
      {documents.loading ? (
        <Loading />
      ) : documents.error ? (
        <ErrorState message={documents.error} retry={documents.reload} />
      ) : !matches?.length ? (
        <EmptyState
          title={search ? 'No matching reports' : 'No PDF reports yet'}
          description={
            search
              ? 'Try another title or filename.'
              : 'Add a laboratory report, referral, or other care document. PDFs up to 5 MB.'
          }
        />
      ) : (
        <div className="report-document-list">
          {matches.map((document) => (
            <article className="report-document" key={document.id}>
              <span className="report-file-icon">
                <FileText size={23} />
              </span>
              <div className="grow">
                <h3>{document.title}</h3>
                <p>
                  {document.originalName} · {Math.max(1, Math.ceil(document.sizeBytes / 1024))} KB
                </p>
                <p>
                  Added {formatDate(document.createdAt)} by {document.createdByName}
                </p>
                <Badge tone={document.createdByRole === 'patient' ? 'neutral' : 'blue'}>
                  {document.createdByRole === 'patient' ? 'Patient uploaded' : 'Clinic uploaded'}
                </Badge>
                <details className="report-provenance">
                  <summary>File provenance</summary>
                  <p>Original file retained. SHA-256 fingerprint:</p>
                  <code>{document.sha256}</code>
                </details>
              </div>
              <a className="button button-secondary button-small" href={document.url} download>
                <Download size={14} />
                Download PDF<span className="sr-only">: {document.title}</span>
              </a>
            </article>
          ))}
        </div>
      )}
      {upload && (
        <DocumentUploadModal
          patientId={patientId}
          onClose={() => setUpload(false)}
          onUploaded={() => {
            setUpload(false);
            void documents.reload();
          }}
        />
      )}
    </Card>
  );
}

export function DocumentUploadModal({
  patientId,
  onClose,
  onUploaded,
}: {
  patientId: string;
  onClose: () => void;
  onUploaded: (document: PatientDocument) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  function choose(next?: File) {
    setError('');
    setFile(null);
    if (!next) return;
    if (!/\.pdf$/i.test(next.name) || (next.type && next.type !== 'application/pdf')) {
      setError('Choose a PDF report.');
      return;
    }
    if (next.size > 5 * 1024 * 1024) {
      setError('Reports must be 5 MB or smaller.');
      return;
    }
    setFile(next);
    if (!title) setTitle(next.name.replace(/\.pdf$/i, '').slice(0, 200));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || !agreed) return;
    setBusy(true);
    setError('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).replace(/^data:[^;]*;/, 'data:application/pdf;'));
        reader.onerror = () => reject(new Error('The file could not be read. Choose it again.'));
        reader.readAsDataURL(file);
      });
      const document = await api<PatientDocument>('/api/documents', {
        method: 'POST',
        body: { patientId, title, originalName: file.name, dataUrl, consent: true },
      });
      toast('PDF report added to the private record.');
      onUploaded(document);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Upload PDF report"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        <Field
          label="PDF file"
          hint="Up to 5 MB. Check the patient name in the report before uploading."
        >
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => choose(event.target.files?.[0])}
            required
            disabled={busy}
          />
        </Field>
        <Field label="Report title">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={200}
            disabled={busy}
            placeholder="For example, laboratory report — 10 November"
          />
        </Field>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            required
            disabled={busy}
          />
          <span>
            I confirm this is the correct patient’s report and have permission to share it with
            their clinical team for care.
          </span>
        </label>
        <p className="muted small">
          The original file becomes part of this care record. Reports download as files and are not
          displayed inside the portal.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button button-primary" disabled={busy || !file || !agreed}>
            {busy ? 'Uploading…' : 'Add report to record'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
