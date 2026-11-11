import type {
  Appointment,
  CarePlan,
  CheckIn,
  ClinicalImage,
  ClinicSettings,
  Intake,
  Patient,
} from './types';
import type { PatientFollowUpReview } from './follow-up';
import type { Investigation, ProcedureRecord } from './clinical';
import type { PatientDocument } from './documents';
import type { Invoice } from './operations';
import type { ImageAnnotationVersion } from './image-annotations';
import type { PatientAllergyChange } from './patient-profile';

export interface SummaryCarePlan extends Omit<CarePlan, 'followUpRevision' | 'latestReview'> {
  reviews: PatientFollowUpReview[];
}

/** A patient-facing snapshot, with the same scope for patients and clinical staff. */
export interface CareSummary {
  schemaVersion: 1;
  audience: 'patient';
  generatedAt: string;
  timezone: 'Asia/Kolkata';
  /** Hash of patient-visible content; required when requesting the JSON download. */
  revision: string;
  clinic: Pick<ClinicSettings, 'name' | 'address' | 'phone' | 'email'>;
  patient: Patient;
  allergyHistory: PatientAllergyChange[];
  appointments: Appointment[];
  intakes: Intake[];
  carePlans: SummaryCarePlan[];
  checkIns: CheckIn[];
  investigations: Investigation[];
  procedures: ProcedureRecord[];
  images: ClinicalImage[];
  imageAnnotations: ImageAnnotationVersion[];
  documents: PatientDocument[];
  invoices: Invoice[];
}
