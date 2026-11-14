import type { Session } from './types';

export type MfaProof = { method: 'totp'; code: string } | { method: 'recovery-code'; code: string };
export type MfaOperation =
  | 'enrollment-prepared'
  | 'enabled'
  | 'recovery-codes-prepared'
  | 'recovery-codes-replaced'
  | 'disabled'
  | 'operator-reset';
export interface MfaStateSnapshot {
  enabled: boolean;
  recoveryCodesRemaining: number;
}
/** Own-account evidence. No password, proof, secret, token, session hash or payload binding. */
export interface MfaEvent {
  id: string;
  userId: string;
  operation: MfaOperation;
  requestId: string | null;
  expectedRevision: string | null;
  pendingId: string | null;
  before: MfaStateSnapshot;
  after: MfaStateSnapshot;
  createdById: string | null;
  createdByName: string;
  createdAt: string;
}
export interface MfaPending {
  id: string;
  kind: 'enrollment' | 'recovery-codes';
  expiresAt: string;
}
export interface MfaStatus extends MfaStateSnapshot {
  available: boolean;
  enabledAt: string | null;
  revision: string;
  pending: MfaPending | null;
  /** Most recent100 sanitized own-account events, newest first. */
  history: MfaEvent[];
}
export interface MfaMutation {
  status: MfaStatus;
  event: MfaEvent;
}
/** Sensitive setup material is returned only by an authenticated prepare/replay operation. */
export interface MfaPreparation extends MfaMutation {
  setup: MfaPending & {
    recoveryCodes: string[];
    secret?: string;
    otpauthUri?: string;
  };
}
/** Password was accepted, but no signed-in session has been created. */
export interface MfaChallenge {
  mfaRequired: true;
  /** Intended account, disclosed only after password verification; not an authenticated User. */
  accountId: string;
  csrfToken: string;
  expiresAt: string;
}
export type LoginResult = Session | MfaChallenge;
