import type { Role } from './types';

export interface PatientDemographics {
  name: string;
  email: string;
  phone: string;
  dob: string;
  gender: string;
}
export interface PatientProfileChange {
  id: string;
  patientId: string;
  before: PatientDemographics;
  after: PatientDemographics;
  reason: string;
  createdById: string;
  createdByName: string;
  createdByRole: Role;
  createdAt: string;
}
export interface PatientProfile {
  patientId: string;
  demographics: PatientDemographics;
  /** Only staff receive a token and demographic correction history. */
  revision: string | null;
  changes: PatientProfileChange[];
}
export type AllergyStatus = 'not-recorded' | 'none-known' | 'recorded';
export interface PatientAllergies {
  status: AllergyStatus;
  text: string;
}
export interface PatientAllergyChange {
  id: string;
  patientId: string;
  before: PatientAllergies;
  after: PatientAllergies;
  /** Explicitly shared with the patient, not an internal clinical assessment. */
  reason: string;
  doctorId: string;
  doctorName: string;
  createdAt: string;
}
export interface PatientAllergyHistory {
  patientId: string;
  current: PatientAllergies;
  /** Patients receive the safe history but no editing token. */
  revision: string | null;
  changes: PatientAllergyChange[];
}
