import type { Role } from './types';

export interface PatientDocument {
  id: string;
  patientId: string;
  title: string;
  originalName: string;
  mimeType: 'application/pdf';
  sizeBytes: number;
  sha256: string;
  createdById: string;
  createdByName: string;
  createdByRole: Role;
  createdAt: string;
  url: string;
  consent: true;
}
