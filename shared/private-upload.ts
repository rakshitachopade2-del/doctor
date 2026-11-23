import type { PatientDocument } from './documents';
import type { ClinicalImage } from './types';

interface UploadCommand {
  requestId: string;
  patientId: string;
  sha256: string;
  dataUrl: string;
  consent: true;
}
export interface ImageUploadCommand extends UploadCommand {
  caption: string;
  category: ClinicalImage['category'];
}
export interface DocumentUploadCommand extends UploadCommand {
  title: string;
  originalName: string;
}
export type UploadedImage = Required<ClinicalImage> & { consent: true };
export type PrivateUploadFile = UploadedImage | PatientDocument;
export type PrivateUploadKind = 'image' | 'document';
export type PrivateUploadReceipt = {
  requestId: string;
  actorId: string;
  patientId: string;
} & ({ kind: 'image'; file: UploadedImage } | { kind: 'document'; file: PatientDocument });
export interface PrivateUploadResult {
  receipt: PrivateUploadReceipt;
}
export interface ImageUploadNotSaved extends Omit<ImageUploadCommand, 'dataUrl'> {
  code: 'UPLOAD_NOT_SAVED';
  actorId: string;
  kind: 'image';
  mimeType: string;
  sizeBytes: number;
  message: string;
}
