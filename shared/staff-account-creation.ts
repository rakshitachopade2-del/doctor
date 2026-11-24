import { z } from 'zod';
import type { User } from './types';
import { email, required } from './validation.ts';

export const staffAccountFields = z.object({
  name: required,
  email,
  role: z.enum(['doctor', 'receptionist', 'admin']),
  doctorId: required.nullable(),
});
export const staffInitialPassword = z.string().min(12, 'Use at least 12 characters').max(128);

export interface StaffAccountCreationReview extends z.infer<typeof staffAccountFields> {
  requestId: string;
  reviewedConfirmed: true;
}
export interface StaffAccountCreationResponse {
  receipt: { requestId: string; actorId: string; account: User };
}
export interface StaffAccountNotCreated {
  code: 'STAFF_ACCOUNT_NOT_CREATED';
  actorId: string;
  review: StaffAccountCreationReview;
  message: string;
}
