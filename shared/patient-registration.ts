import { z } from 'zod';
import type { Patient, Role } from './types';
import { date, email, required, text } from './validation.ts';

export function staffPatientRegistrationFields(clinicToday: () => string) {
  return z.object({
    name: required,
    email: email.or(z.literal('')),
    phone: z.string().trim().min(7).max(30),
    dob: date
      .refine((value) => value <= clinicToday(), 'Date of birth must not be in the future')
      .or(z.literal('')),
    gender: z.string().trim().max(50),
    allergies: text,
  });
}

export type PatientRegistrationFields = z.infer<ReturnType<typeof staffPatientRegistrationFields>>;

export interface PatientRegistrationCommand extends PatientRegistrationFields {
  requestId: string;
  registeredByRole: Exclude<Role, 'patient'>;
  reviewedConfirmed: true;
}

export interface PatientRegistrationReceipt {
  requestId: string;
  actorId: string;
  registeredByRole: PatientRegistrationCommand['registeredByRole'];
  patient: Patient;
}

export interface PatientRegistrationResponse {
  receipt: PatientRegistrationReceipt;
}
