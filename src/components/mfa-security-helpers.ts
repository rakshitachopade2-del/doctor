import type {
  MfaEvent,
  MfaMutation,
  MfaOperation,
  MfaPending,
  MfaPreparation,
  MfaProof,
  MfaStateSnapshot,
  MfaStatus,
} from '../../shared/mfa';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const token = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const time = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const bad = () =>
  new Error(
    'The security response could not be confirmed. Retry the same request to confirm its outcome.',
  );
export const mfaFailure = (v: unknown) =>
  v instanceof Error ? v.message : 'The security request could not be confirmed.';
export const recoveryValue = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();
export function checkedMfaSnapshot(v: unknown): MfaStateSnapshot {
  if (
    !object(v) ||
    typeof v.enabled !== 'boolean' ||
    !Number.isSafeInteger(v.recoveryCodesRemaining) ||
    Number(v.recoveryCodesRemaining) < 0 ||
    Number(v.recoveryCodesRemaining) > 10 ||
    (!v.enabled && v.recoveryCodesRemaining !== 0)
  )
    throw bad();
  return v as unknown as MfaStateSnapshot;
}
const sameSnapshot = (a: MfaStateSnapshot, b: MfaStateSnapshot) =>
  a.enabled === b.enabled && a.recoveryCodesRemaining === b.recoveryCodesRemaining;
function checkedPending(v: unknown): MfaPending {
  if (
    !object(v) ||
    !text(v.id) ||
    !['enrollment', 'recovery-codes'].includes(v.kind as string) ||
    !time(v.expiresAt)
  )
    throw bad();
  return v as unknown as MfaPending;
}
function checkedEvent(v: unknown, userId: string): MfaEvent {
  if (
    !object(v) ||
    !text(v.id) ||
    v.userId !== userId ||
    ![
      'enrollment-prepared',
      'enabled',
      'recovery-codes-prepared',
      'recovery-codes-replaced',
      'disabled',
      'operator-reset',
    ].includes(v.operation as string) ||
    !(v.requestId === null || uuid(v.requestId)) ||
    !(v.expectedRevision === null || token(v.expectedRevision)) ||
    !(v.pendingId === null || text(v.pendingId)) ||
    !(v.createdById === null || text(v.createdById)) ||
    !text(v.createdByName) ||
    !time(v.createdAt)
  )
    throw bad();
  const before = checkedMfaSnapshot(v.before),
    after = checkedMfaSnapshot(v.after);
  if (v.operation === 'operator-reset') {
    if (
      after.enabled ||
      v.requestId !== null ||
      v.expectedRevision !== null ||
      v.pendingId !== null ||
      v.createdById !== null
    )
      throw bad();
  } else {
    if (!uuid(v.requestId) || !token(v.expectedRevision) || v.createdById !== userId) throw bad();
    if (
      v.operation === 'enrollment-prepared' &&
      (before.enabled || after.enabled || !text(v.pendingId))
    )
      throw bad();
    if (
      v.operation === 'enabled' &&
      (before.enabled ||
        !after.enabled ||
        after.recoveryCodesRemaining !== 10 ||
        !text(v.pendingId))
    )
      throw bad();
    if (
      v.operation === 'recovery-codes-prepared' &&
      (!before.enabled ||
        !after.enabled ||
        !text(v.pendingId) ||
        ![before.recoveryCodesRemaining, before.recoveryCodesRemaining - 1].includes(
          after.recoveryCodesRemaining,
        ))
    )
      throw bad();
    if (
      v.operation === 'recovery-codes-replaced' &&
      (!before.enabled ||
        !after.enabled ||
        after.recoveryCodesRemaining !== 10 ||
        !text(v.pendingId))
    )
      throw bad();
    if (v.operation === 'disabled' && (!before.enabled || after.enabled || v.pendingId !== null))
      throw bad();
  }
  return v as unknown as MfaEvent;
}
const sameEvent = (a: MfaEvent, b: MfaEvent) =>
  [
    'id',
    'userId',
    'operation',
    'requestId',
    'expectedRevision',
    'pendingId',
    'createdById',
    'createdByName',
    'createdAt',
  ].every((k) => a[k as keyof MfaEvent] === b[k as keyof MfaEvent]) &&
  sameSnapshot(a.before, b.before) &&
  sameSnapshot(a.after, b.after);
export function checkedMfaStatus(v: unknown, userId: string): MfaStatus {
  const state = checkedMfaSnapshot(v);
  if (
    !object(v) ||
    typeof v.available !== 'boolean' ||
    !token(v.revision) ||
    !(v.enabledAt === null || time(v.enabledAt)) ||
    !Array.isArray(v.history) ||
    v.history.length > 100 ||
    state.enabled !== (v.enabledAt !== null)
  )
    throw bad();
  const pending = v.pending === null ? null : checkedPending(v.pending),
    history = v.history.map((e) => checkedEvent(e, userId));
  if (
    (!v.available && (state.enabled || pending !== null)) ||
    (pending && (pending.kind === 'enrollment') === state.enabled) ||
    new Set(history.map((e) => e.id)).size !== history.length ||
    new Set(history.filter((e) => e.requestId !== null).map((e) => e.requestId)).size !==
      history.filter((e) => e.requestId !== null).length
  )
    throw bad();
  return v as unknown as MfaStatus;
}
export type MfaCommand =
  'enrollment-prepare' | 'enrollment-confirm' | 'recovery-prepare' | 'recovery-confirm' | 'disable';
export const mfaEndpoint: Record<MfaCommand, string> = {
  'enrollment-prepare': '/api/auth/mfa/enrollment/prepare',
  'enrollment-confirm': '/api/auth/mfa/enrollment/confirm',
  'recovery-prepare': '/api/auth/mfa/recovery-codes/prepare',
  'recovery-confirm': '/api/auth/mfa/recovery-codes/confirm',
  disable: '/api/auth/mfa/disable',
};
export type MfaCommandPayload = {
  expectedRevision: string;
  requestId: string;
  currentPassword?: string;
  proof?: MfaProof;
  pendingId?: string;
  code?: string;
  savedRecoveryCodes?: true;
};
export type MfaAttempt = {
  command: MfaCommand;
  body: MfaCommandPayload;
  source: MfaStatus;
  userId: string;
};
export function checkedMfaMutation(v: unknown, a: MfaAttempt): MfaMutation {
  if (!object(v)) throw bad();
  const status = checkedMfaStatus(v.status, a.userId),
    event = checkedEvent(v.event, a.userId);
  const operations: Record<MfaCommand, MfaOperation> = {
    'enrollment-prepare': 'enrollment-prepared',
    'enrollment-confirm': 'enabled',
    'recovery-prepare': 'recovery-codes-prepared',
    'recovery-confirm': 'recovery-codes-replaced',
    disable: 'disabled',
  };
  const after: MfaStateSnapshot =
    a.command === 'enrollment-prepare'
      ? { enabled: false, recoveryCodesRemaining: 0 }
      : a.command === 'disable'
        ? { enabled: false, recoveryCodesRemaining: 0 }
        : a.command === 'recovery-prepare'
          ? {
              enabled: true,
              recoveryCodesRemaining:
                a.source.recoveryCodesRemaining -
                (a.body.proof?.method === 'recovery-code' ? 1 : 0),
            }
          : { enabled: true, recoveryCodesRemaining: 10 };
  if (
    event.operation !== operations[a.command] ||
    event.userId !== a.userId ||
    event.createdById !== a.userId ||
    event.requestId !== a.body.requestId ||
    event.expectedRevision !== a.body.expectedRevision ||
    !sameSnapshot(event.before, a.source) ||
    !sameSnapshot(event.after, after) ||
    (a.body.pendingId !== undefined && event.pendingId !== a.body.pendingId) ||
    (a.command === 'disable' && event.pendingId !== null) ||
    a.source.history.some((e) => e.id === event.id || e.requestId === event.requestId)
  )
    throw bad();
  const historical = status.history.find((e) => e.id === event.id);
  if (historical ? !sameEvent(historical, event) : status.history.length < 100) throw bad();
  return { status, event };
}
export function checkedMfaPreparation(v: unknown, a: MfaAttempt): MfaPreparation {
  const result = checkedMfaMutation(v, a);
  if (
    !object(v) ||
    !object(v.setup) ||
    !Array.isArray(v.setup.recoveryCodes) ||
    v.setup.recoveryCodes.length !== 10 ||
    !['enrollment-prepare', 'recovery-prepare'].includes(a.command)
  )
    throw bad();
  const setup = checkedPending(v.setup),
    codes = v.setup.recoveryCodes;
  if (
    codes.some((c) => typeof c !== 'string' || !/^[A-F0-9]{32}$/.test(recoveryValue(c))) ||
    new Set(codes.map((c) => recoveryValue(c as string))).size !== 10 ||
    setup.kind !== (a.command === 'enrollment-prepare' ? 'enrollment' : 'recovery-codes') ||
    setup.id !== result.event.pendingId ||
    result.status.pending?.id !== setup.id ||
    result.status.pending?.kind !== setup.kind ||
    result.status.pending?.expiresAt !== setup.expiresAt
  )
    throw bad();
  if (setup.kind === 'enrollment') {
    if (
      typeof v.setup.secret !== 'string' ||
      !/^[A-Z2-7]{32}$/.test(v.setup.secret) ||
      typeof v.setup.otpauthUri !== 'string'
    )
      throw bad();
    try {
      const uri = new URL(v.setup.otpauthUri);
      if (
        uri.protocol !== 'otpauth:' ||
        uri.hostname !== 'totp' ||
        uri.searchParams.get('secret') !== v.setup.secret ||
        uri.searchParams.get('algorithm')?.toUpperCase() !== 'SHA1' ||
        uri.searchParams.get('digits') !== '6' ||
        uri.searchParams.get('period') !== '30'
      )
        throw bad();
    } catch {
      throw bad();
    }
  } else if (v.setup.secret !== undefined || v.setup.otpauthUri !== undefined) throw bad();
  return { ...result, setup: v.setup as unknown as MfaPreparation['setup'] };
}
