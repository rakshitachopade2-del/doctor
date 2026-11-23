import { useState } from 'react';
import { Download, FileText, Upload } from 'lucide-react';
import { formatDate } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading } from './ui';
import { DocumentUploadModal } from './PrivateUploadModal';
import { uploadKey, usePatientDocuments } from './private-upload-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import './documents.css';

export function DocumentsPanel({ patientId }: { patientId: string }) {
  const documents = usePatientDocuments(patientId);
  const { uploads } = usePendingCareSubmissions();
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
          {uploads.has(uploadKey('document', patientId))
            ? 'Resume PDF upload'
            : 'Upload PDF report'}
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
