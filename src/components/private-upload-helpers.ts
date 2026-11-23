import type { PatientDocument } from '../../shared/documents';
import type {
  DocumentUploadCommand,
  ImageUploadCommand,
  PrivateUploadFile,
  PrivateUploadKind,
} from '../../shared/private-upload';
import { ApiError } from '../lib';
import { useAppointmentBookingData } from './appointment-booking-helpers';

interface SelectedFile {
  source: File;
  mimeType: string;
  investigationId?: string;
}
export type UploadAttempt = SelectedFile &
  (
    | { kind: 'image'; command: ImageUploadCommand }
    | { kind: 'document'; command: DocumentUploadCommand }
  );
export const uploadKey = (kind: PrivateUploadKind, patientId: string) => kind + '/' + patientId;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function usePatientDocuments(patientId: string) {
  return useAppointmentBookingData(
    '/api/documents?patientId=' + encodeURIComponent(patientId),
    (value): PatientDocument[] => {
      if (
        !Array.isArray(value) ||
        !value.every(
          (item) =>
            object(item) &&
            item.patientId === patientId &&
            typeof item.title === 'string' &&
            typeof item.originalName === 'string' &&
            typeof item.id === 'string' &&
            item.url === '/api/documents/' + item.id + '/file',
        )
      )
        throw new Error('The private report list could not be verified. Refresh to try again.');
      return value;
    },
  );
}

export function checkFile(file: File, kind: PrivateUploadKind) {
  if (!file.size || file.size > 5 * 1024 * 1024)
    throw new Error('Choose a nonempty file of 5 MB or less.');
  if (kind === 'document') {
    if (file.name.trim().length > 200 || /[\\/\u0000-\u001f\u007f]/.test(file.name.trim()))
      throw new Error(
        'Use a filename of up to 200 characters without path separators or control characters.',
      );
    if (!/\.pdf$/i.test(file.name.trim()) || (file.type && file.type !== 'application/pdf'))
      throw new Error('Choose a PDF report.');
  } else if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPEG, PNG or WebP image.');
  }
}

function validFormat(bytes: Uint8Array, mimeType: string) {
  const text = (slice: Uint8Array) => String.fromCharCode(...slice);
  if (mimeType === 'application/pdf')
    return (
      /^%PDF-(?:1\.[0-7]|2\.0)[\r\n ]/.test(text(bytes.subarray(0, 16))) &&
      /%%EOF\s*$/.test(text(bytes.subarray(-1024)))
    );
  if (bytes.length < 12) return false;
  if (mimeType === 'image/png')
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
  if (mimeType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    mimeType === 'image/webp' &&
    text(bytes.subarray(0, 4)) === 'RIFF' &&
    text(bytes.subarray(8, 12)) === 'WEBP'
  );
}

export async function prepareUpload(file: File, mimeType: string, current: () => boolean) {
  const content = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error('The file could not be read.'));
    reader.onerror = reader.onabort = () =>
      reject(new Error('The file could not be read. Choose it again.'));
    reader.readAsArrayBuffer(file);
  });
  if (!current()) return null;
  const bytes = new Uint8Array(content);
  if (bytes.length !== file.size || !validFormat(bytes, mimeType))
    throw new Error(
      mimeType === 'application/pdf'
        ? 'Choose a complete PDF report.'
        : 'The image content does not match its file type.',
    );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content));
  if (!current()) return null;
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const blocks: string[] = [];
  // Each full block contains whole base64 triplets and fits comfortably on the JS stack.
  const blockSize = 24 * 1024;
  for (let start = 0; start < bytes.length; start += blockSize)
    blocks.push(btoa(String.fromCharCode(...bytes.subarray(start, start + blockSize))));
  return { sha256, dataUrl: 'data:' + mimeType + ';base64,' + blocks.join('') };
}

function originalFile(
  value: unknown,
  attempt: UploadAttempt,
  actorId: string,
): value is PrivateUploadFile {
  const { command, kind } = attempt;
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) ||
    value.patientId !== command.patientId ||
    value.consent !== true ||
    value.url !==
      '/api/' + (kind === 'image' ? 'images' : 'documents') + '/' + value.id + '/file' ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    value.createdById !== actorId ||
    typeof value.createdByName !== 'string' ||
    !value.createdByName.trim() ||
    !['admin', 'doctor', 'patient'].some((role) => role === value.createdByRole) ||
    value.sha256 !== command.sha256 ||
    value.sizeBytes !== attempt.source.size ||
    value.mimeType !== attempt.mimeType
  )
    return false;
  return attempt.kind === 'image'
    ? value.caption === attempt.command.caption && value.category === attempt.command.category
    : value.title === attempt.command.title && value.originalName === attempt.command.originalName;
}

export function confirmedUpload(value: unknown, attempt: UploadAttempt, actorId: string) {
  if (!object(value) || !object(value.receipt)) return null;
  const receipt = value.receipt;
  return receipt.requestId === attempt.command.requestId &&
    receipt.patientId === attempt.command.patientId &&
    receipt.kind === attempt.kind &&
    receipt.actorId === actorId &&
    originalFile(receipt.file, attempt, actorId)
    ? receipt.file
    : null;
}

export function uploadNotSaved(error: unknown, attempt: UploadAttempt, actorId: string) {
  if (
    attempt.kind !== 'image' ||
    !(error instanceof ApiError) ||
    error.status !== 403 ||
    !object(error.responseData)
  )
    return false;
  const value = error.responseData,
    command = attempt.command;
  return (
    value.code === 'UPLOAD_NOT_SAVED' &&
    value.actorId === actorId &&
    value.kind === 'image' &&
    value.requestId === command.requestId &&
    value.patientId === command.patientId &&
    value.consent === true &&
    value.sha256 === command.sha256 &&
    value.caption === command.caption &&
    value.category === command.category &&
    value.sizeBytes === attempt.source.size &&
    value.mimeType === attempt.mimeType &&
    typeof value.message === 'string' &&
    !!value.message.trim()
  );
}
