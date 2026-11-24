import { z } from 'zod';
import { required, text } from './validation.ts';

export const doctorProfileFields = z.object({
  name: required,
  title: required,
  qualifications: required,
  specialties: z.array(required).min(1).max(20),
  experience: z.number().int().min(0).max(80),
  fee: z.number().min(0).max(100000),
  bio: text,
  languages: z.array(required).min(1).max(20),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#b3c7aa'),
});

export type DoctorProfileFields = z.infer<typeof doctorProfileFields>;
export interface DoctorProfileCreationCommand extends DoctorProfileFields {
  requestId: string;
  reviewedConfirmed: true;
}
export interface DoctorProfileCreationReceipt {
  actorId: string;
  requestId: string;
  doctor: DoctorProfileFields & { id: string };
}
export interface DoctorProfileCreationResponse {
  receipt: DoctorProfileCreationReceipt;
}
