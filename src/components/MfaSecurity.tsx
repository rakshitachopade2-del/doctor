import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Copy, Download, RefreshCw, ShieldCheck } from 'lucide-react';
import type { MfaOperation, MfaPreparation, MfaProof, MfaStatus } from '../../shared/mfa';
import { api, ApiError, useSession, useToast } from '../lib';
import { Badge, Card, ErrorState, Field, Loading, Modal } from './ui';
import { isVisitRequestCollision, useVisitData } from './visit-duration-helpers';
import {
  checkedMfaMutation,
  checkedMfaPreparation,
  checkedMfaStatus,
  mfaEndpoint,
  mfaFailure,
  recoveryValue,
  type MfaAttempt,
  type MfaCommand,
} from './mfa-security-helpers';
import './mfa-security.css';

const stamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' IST';
const operationNames: Record<MfaOperation, string> = {
  'enrollment-prepared': 'Authenticator setup prepared',
  enabled: 'Authenticator enabled',
  'recovery-codes-prepared': 'Replacement recovery codes prepared',
  'recovery-codes-replaced': 'Recovery codes replaced',
  disabled: 'Authenticator disabled',
  'operator-reset': 'Authenticator reset by clinic operator',
};
type Action = 'enrollment' | 'recovery-codes' | 'disable';
function StatusSummary({ value }: { value: MfaStatus }) {
  return (
    <div className="mfa-security-summary">
      <Badge tone={value.enabled ? 'green' : 'neutral'}>
        {value.enabled ? 'Authenticator enabled' : 'Authenticator not enabled'}
      </Badge>
      {value.enabled ? (
        <>
          <p>{value.recoveryCodesRemaining} recovery codes remaining</p>
          <p className="muted small">Enabled {stamp(value.enabledAt!)}</p>
          {value.recoveryCodesRemaining === 0 && (
            <p>
              All recovery codes have been used. Prepare a replacement set while you can access your
              authenticator.
            </p>
          )}
        </>
      ) : (
        <p>Sign-in currently uses your password.</p>
      )}
      {value.pending && (
        <p className="muted small">
          {value.pending.kind === 'enrollment'
            ? 'Authenticator setup'
            : 'Recovery-code replacement'}{' '}
          {Date.parse(value.pending.expiresAt) > Date.now()
            ? `is pending until ${stamp(value.pending.expiresAt)}. It has not been activated.`
            : 'has expired. Prepare a new setup to continue.'}
        </p>
      )}
    </div>
  );
}
function History({ value }: { value: MfaStatus }) {
  return (
    <details className="mfa-history">
      <summary>Authenticator history</summary>
      {value.history.length ? (
        value.history.map((event) => (
          <article className="mfa-history-event" key={event.id}>
            <strong>{operationNames[event.operation]}</strong>
            <p>
              {stamp(event.createdAt)} · {event.createdByName}
            </p>
          </article>
        ))
      ) : (
        <p className="muted small">No authenticator changes recorded.</p>
      )}
      <p className="muted small">
        The latest 100 changes are shown. Recovery codes used during sign-in are reflected in the
        current remaining count.
      </p>
    </details>
  );
}
export function MfaSecurityCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const { session } = useSession(),
    userId = session.user!.id;
  const status = useVisitData('/api/auth/mfa', (value) => checkedMfaStatus(value, userId));
  const [action, setAction] = useState<{ kind: Action; source: MfaStatus } | null>(null);
  async function changed() {
    await Promise.all([status.reload(), onChanged()]);
  }
  return (
    <Card className="mfa-security-card">
      <div className="mfa-security-heading">
        <div>
          <h2>
            <ShieldCheck size={21} />
            Authenticator app
          </h2>
          <p className="muted small">
            Add an authenticator code to password sign-in. Recovery codes provide another way to
            verify your account.
          </p>
        </div>
        <button
          className="button button-secondary button-small"
          disabled={status.loading}
          onClick={status.reload}
        >
          <RefreshCw size={15} />
          Refresh authenticator status
        </button>
      </div>
      {status.loading ? (
        <Loading />
      ) : status.error ? (
        <ErrorState message={status.error} retry={status.reload} />
      ) : status.data ? (
        <>
          {!status.data.available ? (
            <div className="notice">
              Authenticator setup is currently unavailable. Your existing sign-in remains available.
            </div>
          ) : (
            <>
              <StatusSummary value={status.data} />
              <div className="mfa-security-actions">
                {status.data.enabled ? (
                  <>
                    <button
                      className="button button-secondary"
                      onClick={() => setAction({ kind: 'recovery-codes', source: status.data! })}
                    >
                      Replace recovery codes
                    </button>
                    <button
                      className="button button-ghost"
                      onClick={() => setAction({ kind: 'disable', source: status.data! })}
                    >
                      Disable authenticator
                    </button>
                  </>
                ) : (
                  <button
                    className="button button-primary"
                    onClick={() => setAction({ kind: 'enrollment', source: status.data! })}
                  >
                    Enable authenticator
                  </button>
                )}
              </div>
              <p className="muted small">
                Use an authenticator app that supports time-based codes. Keep recovery codes
                private. If you lose access to both, contact your clinic for help restoring account
                access.
              </p>
            </>
          )}
          <History value={status.data} />
        </>
      ) : null}
      {action && (
        <MfaManagementModal
          key={`${action.kind}:${userId}`}
          action={action.kind}
          initial={action.source}
          userId={userId}
          onClose={() => setAction(null)}
          onChanged={changed}
        />
      )}
    </Card>
  );
}
function MfaManagementModal({
  action,
  initial,
  userId,
  onClose,
  onChanged,
}: {
  action: Action;
  initial: MfaStatus;
  userId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const location = useLocation(),
    toast = useToast();
  const [source, setSource] = useState(initial),
    [reviewed, setReviewed] = useState<MfaStatus | null>(null),
    [prepared, setPrepared] = useState<MfaPreparation['setup'] | null>(null),
    [password, setPassword] = useState(''),
    [method, setMethod] = useState<MfaProof['method']>('totp'),
    [proof, setProof] = useState(''),
    [code, setCode] = useState(''),
    [saved, setSaved] = useState(false),
    [disableConfirmed, setDisableConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<MfaAttempt | null>(null),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState(''),
    [info, setInfo] = useState(''),
    [done, setDone] = useState<{ operation: MfaOperation; createdAt: string } | null>(null);
  const mounted = useRef(false),
    pending = useRef(false),
    latestKey = useRef(location.key),
    stageHeading = useRef<HTMLHeadingElement>(null);
  latestKey.current = location.key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!prepared) return;
    const expire = () => {
      setPrepared(null);
      setSaved(false);
      setCode('');
      setInfo(
        'This preparation expired. Its displayed key and codes were cleared. Prepare a new set to continue.',
      );
    };
    const delay = Date.parse(prepared.expiresAt) - Date.now();
    if (delay <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, Math.min(delay, 2147483647));
    return () => clearTimeout(timer);
  }, [prepared]);
  useEffect(() => {
    if (prepared || done) stageHeading.current?.focus({ preventScroll: true });
  }, [prepared?.id, done]);
  const locked = busy || refreshing || phase !== 'editing';
  const applicable =
    source.available && (action === 'enrollment' ? !source.enabled : source.enabled);
  const staged = prepared !== null;
  function clearProofs() {
    setPassword('');
    setProof('');
    setCode('');
    setDisableConfirmed(false);
  }
  function applyReviewed() {
    if (!reviewed || refreshing) return;
    setSource(reviewed);
    setReviewed(null);
    setPhase('editing');
    setAttempt(null);
    setError('');
    setDisableConfirmed(false);
    setCode('');
    if (
      prepared &&
      (reviewed.pending?.id !== prepared.id || Date.parse(prepared.expiresAt) <= Date.now())
    ) {
      setPrepared(null);
      setSaved(false);
      clearProofs();
      setInfo('The earlier preparation is no longer active. Prepare a new set before continuing.');
    }
  }
  async function refreshLatest() {
    if (pending.current || refreshing) return;
    setRefreshing(true);
    setReviewed(null);
    setError('');
    const key = location.key;
    try {
      const value = checkedMfaStatus(await api<unknown>('/api/auth/mfa'), userId);
      if (mounted.current && latestKey.current === key) setReviewed(value);
    } catch (e) {
      if (mounted.current) setError(mfaFailure(e));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || refreshing || phase === 'conflict' || done) return;
    const command: MfaCommand =
      attempt?.command ??
      (action === 'disable'
        ? 'disable'
        : action === 'enrollment'
          ? staged
            ? 'enrollment-confirm'
            : 'enrollment-prepare'
          : staged
            ? 'recovery-confirm'
            : 'recovery-prepare');
    const confirming = command.endsWith('-confirm');
    if (
      !attempt &&
      (!applicable ||
        (confirming && (!prepared || !saved || Date.parse(prepared.expiresAt) <= Date.now())) ||
        (command === 'disable' && !disableConfirmed))
    ) {
      setError(
        'Review the current status and complete the required confirmations before continuing.',
      );
      return;
    }
    if (!attempt && command === 'enrollment-confirm' && !/^\d{6}$/.test(code)) {
      setError('Enter the six-digit code from the authenticator you just set up.');
      return;
    }
    if (
      !attempt &&
      !confirming &&
      (!password ||
        (action !== 'enrollment' &&
          !(method === 'totp'
            ? /^\d{6}$/.test(proof)
            : /^[A-F0-9]{32}$/.test(recoveryValue(proof)))))
    ) {
      setError('Enter your current password and a valid verification code where requested.');
      return;
    }
    const sent: MfaAttempt = attempt ?? {
      command,
      source,
      userId,
      body: {
        expectedRevision: source.revision,
        requestId: crypto.randomUUID(),
        ...(confirming
          ? {
              pendingId: prepared!.id,
              savedRecoveryCodes: true as const,
              ...(command === 'enrollment-confirm' ? { code } : {}),
            }
          : {
              currentPassword: password,
              ...(action !== 'enrollment'
                ? {
                    proof: {
                      method,
                      code: method === 'recovery-code' ? recoveryValue(proof) : proof,
                    } as MfaProof,
                  }
                : {}),
            }),
      },
    };
    pending.current = true;
    setBusy(true);
    setAttempt(sent);
    setError('');
    setInfo('');
    const key = location.key;
    try {
      const raw = await api<unknown>(mfaEndpoint[sent.command], {
        method: 'POST',
        body: sent.body,
      });
      const isPreparation = sent.command.endsWith('-prepare');
      const result = isPreparation
        ? checkedMfaPreparation(raw, sent)
        : checkedMfaMutation(raw, sent);
      if (!mounted.current) return;
      if (latestKey.current !== key) {
        setPhase('uncertain');
        setError(
          'The page changed before confirmation. Retry the same request to confirm its outcome.',
        );
        return;
      }
      setSource(result.status);
      setAttempt(null);
      setPhase('editing');
      setReviewed(null);
      clearProofs();
      if (isPreparation) {
        setPrepared((result as MfaPreparation).setup);
        setSaved(false);
        setInfo(
          action === 'enrollment'
            ? 'Setup is prepared but not yet enabled. Save your recovery codes and verify your authenticator below.'
            : 'Replacement codes are prepared but not active yet. Existing codes remain active until you confirm, except any recovery code used for this verification.',
        );
      } else {
        setPrepared(null);
        setSaved(false);
        setDone({ operation: result.event.operation, createdAt: result.event.createdAt });
      }
      void onChanged().catch(() => {});
    } catch (e) {
      if (!mounted.current) return;
      setError(mfaFailure(e));
      const known =
        e instanceof ApiError &&
        [400, 401, 403, 409, 410, 429].includes(e.status) &&
        !isVisitRequestCollision(e);
      if (known && (phase !== 'uncertain' || (e as ApiError).status === 410)) {
        setAttempt(null);
        setReviewed(null);
        if ((e as ApiError).status === 410) {
          setPrepared(null);
          setSaved(false);
          clearProofs();
          setPhase('conflict');
          setInfo(
            'This preparation is no longer available. Refresh your security status before preparing another set.',
          );
        } else setPhase((e as ApiError).status === 409 ? 'conflict' : 'editing');
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (mounted.current) toast(`${label} copied. Keep it private.`);
    } catch {
      if (mounted.current) setInfo(`Copy ${label.toLowerCase()} directly from the displayed text.`);
    }
  }
  function download() {
    if (!prepared || Date.parse(prepared.expiresAt) <= Date.now()) return;
    const content = [
      'Derma recovery codes',
      'Keep these codes private. Each code can be used once.',
      'This set becomes active only after you confirm setup in Derma.',
      '',
      ...prepared.recoveryCodes,
      '',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'derma-recovery-codes.txt';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const title =
    action === 'enrollment'
      ? 'Set up authenticator'
      : action === 'recovery-codes'
        ? 'Replace recovery codes'
        : 'Disable authenticator';
  const submitLabel =
    phase === 'uncertain'
      ? 'Retry same request'
      : action === 'disable'
        ? 'Disable authenticator'
        : staged
          ? action === 'enrollment'
            ? 'Activate authenticator'
            : 'Confirm replacement codes'
          : action === 'enrollment'
            ? 'Prepare authenticator setup'
            : 'Prepare replacement codes';
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy && !refreshing && phase !== 'uncertain') onClose();
      }}
    >
      <div className="stack mfa-editor">
        <StatusSummary value={source} />
        {done ? (
          <>
            <section className="mfa-operation-receipt" role="status">
              <h3 ref={stageHeading} tabIndex={-1}>
                {operationNames[done.operation]}
              </h3>
              <p>
                Change confirmed at {stamp(done.createdAt)}. The current account status is shown
                above.
              </p>
              <p>Your other sessions have been ended. This session remains signed in.</p>
            </section>
            <button className="button button-primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <form className="stack" onSubmit={submit}>
            {error && <ErrorState message={error} />}
            {info && (
              <p className="notice" role="status">
                {info}
              </p>
            )}
            {phase === 'uncertain' && (
              <div className="notice notice-warning">
                <strong>The security outcome could not be confirmed.</strong>
                <p>
                  The exact request is retained only in this open dialog. Retry the same request
                  before editing or closing it.
                </p>
              </div>
            )}
            {!applicable && phase === 'editing' && (
              <p className="notice">
                This action is no longer available for the current account status. Close this dialog
                and refresh authenticator status.
              </p>
            )}
            {prepared ? (
              <>
                <section className="mfa-private-material">
                  <h3 ref={stageHeading} tabIndex={-1}>
                    {action === 'enrollment'
                      ? 'Add your authenticator'
                      : 'Save the replacement codes'}
                  </h3>
                  <p className="mfa-expiry">
                    Confirm before {stamp(prepared.expiresAt)}. Closing this dialog clears the
                    displayed private material without activating it.
                  </p>
                  {prepared.secret && (
                    <>
                      <p>
                        In your authenticator app, add a time-based account using this setup key.
                        Use six-digit codes with a 30-second interval.
                      </p>
                      <Field label="Authenticator setup key">
                        <input
                          readOnly
                          value={prepared.secret}
                          onFocus={(e) => e.target.select()}
                        />
                      </Field>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => void copy(prepared.secret!, 'Setup key')}
                      >
                        {' '}
                        <Copy size={15} />
                        Copy setup key
                      </button>
                      <details>
                        <summary>Setup URI</summary>
                        <Field label="Authenticator setup URI">
                          <textarea
                            rows={3}
                            readOnly
                            value={prepared.otpauthUri}
                            onFocus={(e) => e.target.select()}
                          />
                        </Field>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => void copy(prepared.otpauthUri!, 'Setup URI')}
                        >
                          Copy setup URI
                        </button>
                      </details>
                    </>
                  )}
                  <h3>Recovery codes</h3>
                  <p>
                    Store these privately somewhere you can access if your authenticator is
                    unavailable. Each code can be used once. This set is not active until you
                    confirm.
                  </p>
                  <ul className="mfa-code-list" aria-label="Private recovery codes">
                    {prepared.recoveryCodes.map((value) => (
                      <li key={value}>{value}</li>
                    ))}
                  </ul>
                  <div className="mfa-private-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void copy(prepared.recoveryCodes.join('\n'), 'Recovery codes')}
                    >
                      <Copy size={15} />
                      Copy recovery codes
                    </button>
                    <button type="button" className="button button-secondary" onClick={download}>
                      <Download size={15} />
                      Download recovery codes
                    </button>
                  </div>
                </section>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    required
                    disabled={locked}
                    checked={saved}
                    onChange={(e) => setSaved(e.target.checked)}
                  />
                  I saved these recovery codes privately
                </label>
                {action === 'enrollment' && (
                  <Field
                    label="Authenticator code"
                    hint="Enter the six-digit code from the new authenticator entry."
                  >
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      required
                      pattern="[0-9]{6}"
                      minLength={6}
                      maxLength={6}
                      disabled={locked}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label="Current password">
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                    disabled={locked}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                {action !== 'enrollment' && (
                  <>
                    <Field label="Verification method">
                      <select
                        disabled={locked}
                        value={method}
                        onChange={(e) => {
                          setMethod(e.target.value as MfaProof['method']);
                          setProof('');
                        }}
                      >
                        <option value="totp">Authenticator code</option>
                        <option value="recovery-code">Recovery code</option>
                      </select>
                    </Field>
                    <Field
                      label={method === 'totp' ? 'Authenticator code' : 'Recovery code'}
                      hint={
                        method === 'totp'
                          ? 'Use a current code that has not already been accepted.'
                          : 'A recovery code can be used once. A code used here is consumed even if you do not finish replacing the set.'
                      }
                    >
                      <input
                        type="text"
                        inputMode={method === 'totp' ? 'numeric' : 'text'}
                        autoComplete={method === 'totp' ? 'one-time-code' : 'off'}
                        autoCapitalize="off"
                        spellCheck={false}
                        required
                        maxLength={method === 'totp' ? 6 : 50}
                        pattern={method === 'totp' ? '[0-9]{6}' : undefined}
                        disabled={locked}
                        value={proof}
                        onChange={(e) =>
                          setProof(
                            method === 'totp' ? e.target.value.replace(/\D/g, '') : e.target.value,
                          )
                        }
                      />
                    </Field>
                  </>
                )}
                {action === 'disable' && (
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      required
                      disabled={locked}
                      checked={disableConfirmed}
                      onChange={(e) => setDisableConfirmed(e.target.checked)}
                    />
                    I understand future sign-ins will use only my password
                  </label>
                )}
                {source.pending && action !== 'disable' && (
                  <p className="notice">
                    Preparing again replaces any unfinished setup. Active authenticator settings
                    stay unchanged until confirmation.
                  </p>
                )}
              </>
            )}
            {phase === 'conflict' && (
              <section className="mfa-conflict">
                <h3>Review current security status</h3>
                <p>Your draft is preserved. Review any account changes before trying again.</p>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={refreshing}
                  onClick={refreshLatest}
                >
                  {refreshing ? 'Refreshing…' : 'Refresh MFA status'}
                </button>
                {reviewed && (
                  <>
                    <StatusSummary value={reviewed} />
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={refreshing}
                      onClick={applyReviewed}
                    >
                      I reviewed the latest security status; keep my draft
                    </button>
                  </>
                )}
              </section>
            )}
            <div className="mfa-form-actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || refreshing || phase === 'uncertain'}
                onClick={onClose}
              >
                Close
              </button>
              <button
                className="button button-primary"
                disabled={
                  busy ||
                  refreshing ||
                  phase === 'conflict' ||
                  (phase !== 'uncertain' &&
                    (!applicable ||
                      (staged && !saved) ||
                      (action === 'disable' && !disableConfirmed)))
                }
              >
                {busy ? 'Confirming…' : submitLabel}
              </button>
            </div>
          </form>
        )}
        <History value={source} />
      </div>
    </Modal>
  );
}
