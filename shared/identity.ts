import type { Role } from './types';
export interface ManagedAccount {
  id: string;
  name: string;
  email: string;
  role: Role;
  patientId?: string;
  doctorId?: string;
  active: boolean;
  mustChangePassword: boolean;
}
export interface AccountSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
  label: string;
}
export interface RecoveryGrant {
  token: string; // returned once; never persisted in plaintext
  expiresAt: string;
}
