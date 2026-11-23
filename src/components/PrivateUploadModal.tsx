import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import type { PatientDocument } from '../../shared/documents';
import type { ClinicalImage } from '../../shared/types';
import { api, useSession, useToast } from '../lib';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { checkedMessageSettings } from './care-message-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import {
  checkFile,
  confirmedUpload,
  prepareUpload,
  uploadKey,
  uploadNotSaved,
  type UploadAttempt,
} from './private-upload-helpers';
import { Field, Modal } from './ui';
import './private-upload.css';

interface ModalProps {
  patientId: string;
  onClose: () => void;
}
interface ImageProps extends ModalProps {
  kind: 'image';
  onUploaded: () => void;
}
interface DocumentProps extends ModalProps {
  kind: 'document';
  investigationId?: string;
  onUploaded: (document: PatientDocument, sameInvestigation: boolean) => void;
}

export function PrivateUploadModal(props: ImageProps | DocumentProps) {
  const { patientId, kind } = props;
  const { session } = useSession();
  const actorId = session.user?.id;
  const isImage = kind === 'image';
  const patientImage = isImage && session.user?.role === 'patient';
  const { uploads } = usePendingCareSubmissions();
  const key = uploadKey(kind, patientId);
  const pending = uploads.get(key);
  const [phase, setPhase] = useState<'edit' | 'pending' | 'rejected'>(pending ? 'pending' : 'edit');
  const [file, setFile] = useState<File | null>(pending?.source ?? null);
  const [label, setLabel] = useState(
    pending?.kind === 'image' ? pending.command.caption : (pending?.command.title ?? ''),
  );
  const [category, setCategory] = useState<ClinicalImage['category']>(
    pending?.kind === 'image' ? pending.command.category : 'clinical',
  );
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshAvailability, setRefreshAvailability] = useState(false);
  const availability = useAppointmentBookingData(
    refreshAvailability ? '/api/settings' : null,
    checkedMessageSettings,
  );
  const available = !refreshAvailability || availability.data?.modules.images === true;
  const stateHeading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (phase !== 'edit') stateHeading.current?.focus();
  }, [phase]);
  const working = useRef(false),
    dismissed = useRef(false);
  const capture = useAppointmentBookingGuard();
  const toast = useToast();
  const location = useLocation();
  // A dialog can stay mounted across same-record query changes. Dismiss that instance even on Back.
  const identity = JSON.stringify([
    location.key,
    actorId,
    session.csrfToken,
    kind,
    patientId,
    props.kind === 'document' && props.investigationId,
  ]);
  const initial = useRef(identity),
    closeCallback = useRef(props.onClose);
  closeCallback.current = props.onClose;
  useLayoutEffect(() => {
    function dismiss() {
      dismissed.current = true;
      closeCallback.current();
    }
    if (initial.current !== identity) dismiss();
    window.addEventListener('popstate', dismiss);
    window.addEventListener('hashchange', dismiss);
    window.addEventListener('derma:session-expired', dismiss);
    window.addEventListener('derma:session-invalidated', dismiss);
    return () => {
      window.removeEventListener('popstate', dismiss);
      window.removeEventListener('hashchange', dismiss);
      window.removeEventListener('derma:session-expired', dismiss);
      window.removeEventListener('derma:session-invalidated', dismiss);
    };
  }, [identity]);

  function close() {
    if (working.current && !isImage) return;
    dismissed.current = true;
    props.onClose();
  }
  function choose(next?: File) {
    setFile(null);
    setConsent(false);
    setError('');
    if (!next) return;
    try {
      checkFile(next, kind);
      setFile(next);
      if (!isImage && !label.trim())
        setLabel(
          next.name
            .trim()
            .replace(/\.pdf$/i, '')
            .slice(0, 200),
        );
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Choose a valid file.');
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (working.current || dismissed.current || !actorId || phase === 'rejected') return;
    let attempt = uploads.get(key);
    if (phase === 'pending' && !attempt) return;
    if (!attempt && (!file || !consent || !available)) return;
    const origin = capture();
    const current = () => !dismissed.current && origin();
    working.current = true;
    setBusy(true);
    setError('');
    try {
      if (!attempt && file) {
        const name = label.trim(),
          mimeType = isImage ? file.type : 'application/pdf';
        if (!name)
          throw new Error(isImage ? 'Enter an image description.' : 'Enter a report title.');
        const content = await prepareUpload(file, mimeType, current);
        if (!content || !current()) return;
        // Another dialog for this patient may have submitted while the file was being read.
        if (uploads.has(key)) {
          props.onClose();
          return;
        }
        const command = {
          ...content,
          requestId: crypto.randomUUID(),
          patientId,
          consent: true as const,
        };
        attempt =
          props.kind === 'image'
            ? {
                kind: 'image',
                source: file,
                mimeType,
                command: { ...command, caption: name, category },
              }
            : {
                kind: 'document',
                source: file,
                mimeType,
                investigationId: props.investigationId,
                command: { ...command, title: name, originalName: file.name.trim() },
              };
        uploads.set(key, attempt);
        setPhase('pending');
      }
      if (!attempt) return;
      const active = () => current() && uploads.get(key) === attempt;
      const result = await api<unknown>(isImage ? '/api/images/upload' : '/api/documents/upload', {
        method: 'POST',
        body: attempt.command,
        isCurrent: active,
      });
      if (!active()) return;
      const saved = confirmedUpload(result, attempt, actorId);
      if (!saved) return;
      uploads.delete(key);
      dismissed.current = true;
      if (props.kind === 'document' && 'originalName' in saved) {
        const same = props.investigationId === attempt.investigationId;
        toast(
          props.investigationId && !same
            ? 'PDF report saved. Select it to attach it to this investigation.'
            : 'PDF report added to the private record.',
        );
        props.onUploaded(saved, same);
      } else if (props.kind === 'image') {
        toast(
          patientImage
            ? 'Image securely added to your record.'
            : 'Private image added to the patient record.',
        );
        props.onUploaded();
      }
    } catch (problem) {
      if (!current()) return;
      if (!attempt)
        setError(problem instanceof Error ? problem.message : 'The file could not be read.');
      else if (uploads.get(key) === attempt && uploadNotSaved(problem, attempt, actorId)) {
        uploads.delete(key);
        setPhase('rejected');
        setConsent(false);
        setRefreshAvailability(false);
      }
    } finally {
      if (current()) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  const title = isImage
    ? patientImage
      ? 'Add to your health record'
      : 'Add a clinical image'
    : 'Upload PDF report';
  const uploadLabel = isImage
    ? patientImage
      ? 'Upload to my record'
      : 'Upload privately'
    : 'Add report to record';
  return (
    <Modal title={title} onClose={close}>
      {phase !== 'edit' ? (
        <div className="stack private-upload-state">
          <h3 ref={stateHeading} tabIndex={-1} aria-live="polite">
            {phase === 'rejected' ? 'Image upload was not saved' : 'Upload confirmation pending'}
          </h3>
          <p>
            {phase === 'rejected'
              ? 'The clinic paused new image uploads. You can review your file and permission before uploading again.'
              : busy
                ? 'Waiting for the clinic to confirm this file.'
                : 'Retry with the same file and details to recover its confirmation. This tab keeps the retry available until you reload or sign out.'}
          </p>
          <dl>
            <dt>File</dt>
            <dd>{file?.name}</dd>
            <dt>{isImage ? 'Description' : 'Report title'}</dt>
            <dd>{label}</dd>
            {isImage && (
              <>
                <dt>Category</dt>
                <dd>
                  {category === 'report' ? 'Investigation report image' : 'Clinical photograph'}
                </dd>
              </>
            )}
          </dl>
          <div className="modal-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy && !isImage}
              onClick={close}
            >
              Close upload
            </button>
            {phase === 'rejected' ? (
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  setPhase('edit');
                  setConsent(false);
                  setRefreshAvailability(true);
                }}
              >
                Review upload
              </button>
            ) : (
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? 'Uploading…' : 'Retry exact upload'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <form className="stack private-upload-form" onSubmit={submit}>
          <Field
            label={isImage ? (patientImage ? 'Choose image' : 'Image file') : 'PDF file'}
            hint={
              isImage
                ? 'JPEG, PNG or WebP · Maximum 5 MB'
                : 'Up to 5 MB. Check the patient name in the report before uploading.'
            }
          >
            <input
              type="file"
              aria-label={isImage ? (patientImage ? 'Choose image' : 'Image file') : 'PDF file'}
              accept={isImage ? 'image/jpeg,image/png,image/webp' : 'application/pdf,.pdf'}
              required={!file}
              disabled={busy}
              onChange={(event) => choose(event.target.files?.[0])}
            />
          </Field>
          {refreshAvailability && file && <p className="small">Selected file: {file.name}</p>}
          <Field label={isImage ? (patientImage ? 'Description' : 'Caption') : 'Report title'}>
            <input
              name={isImage ? 'caption' : 'title'}
              required
              minLength={patientImage ? 3 : 1}
              maxLength={isImage ? 300 : 200}
              value={label}
              disabled={busy}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          {isImage && (
            <Field label={patientImage ? 'Type of record' : 'Category'}>
              <select
                name="category"
                value={category}
                disabled={busy}
                onChange={(e) => setCategory(e.target.value as typeof category)}
              >
                <option value="clinical">Clinical photograph</option>
                <option value="report">
                  {patientImage
                    ? 'Photographed investigation report'
                    : 'Investigation report image'}
                </option>
              </select>
            </Field>
          )}
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={consent}
              disabled={busy}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              {isImage
                ? patientImage
                  ? 'I agree to share this image with my clinic for my care. This does not authorize teaching, research, or public use.'
                  : 'I have confirmed the patient’s permission to store this image for their treatment and clinical record.'
                : 'I confirm this is the correct patient’s report and have permission to share it with their clinical team for care.'}
            </span>
          </label>
          {!isImage && (
            <p className="muted small">
              The original file becomes part of this care record. Reports download as files.
            </p>
          )}
          {isImage && !patientImage && (
            <p className="muted small">
              This image is private to the patient and clinical team. Permission covers treatment
              use only.
            </p>
          )}
          {refreshAvailability && !available && (
            <div className="notice">
              {availability.loading ? (
                'Checking image upload availability…'
              ) : (
                <>
                  {availability.error || 'The clinic has paused new image uploads.'}{' '}
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => void availability.reload()}
                  >
                    Refresh availability
                  </button>
                </>
              )}
            </div>
          )}
          {error && (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy && !isImage}
              onClick={close}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !file || !consent || !available}
            >
              {busy ? 'Uploading…' : uploadLabel}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function DocumentUploadModal(props: Omit<DocumentProps, 'kind'>) {
  return <PrivateUploadModal {...props} kind="document" />;
}
