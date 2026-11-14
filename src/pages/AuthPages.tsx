import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, HeartHandshake, LockKeyhole, ShieldCheck } from 'lucide-react';
import { ApiError, api, useSession, useToast, today } from '../lib';
import { Card, Field } from '../components/ui';
import type { Session } from '../../shared/types';
import type { MfaChallenge, MfaProof, LoginResult } from '../../shared/mfa';

const fullSession = (value: unknown, accountId?: string): value is Session => {
  const candidate = value as Session | null;
  return !!(
    candidate &&
    typeof candidate.demoMode === 'boolean' &&
    candidate.user &&
    typeof candidate.user.id === 'string' &&
    candidate.user.id &&
    (!accountId || candidate.user.id === accountId) &&
    ['patient', 'doctor', 'receptionist', 'admin'].includes(candidate.user.role) &&
    typeof candidate.csrfToken === 'string' &&
    candidate.csrfToken.length >= 32
  );
};
const loginChallenge = (value: unknown): value is MfaChallenge => {
  const candidate = value as MfaChallenge | null;
  return !!(
    candidate &&
    candidate.mfaRequired === true &&
    typeof candidate.accountId === 'string' &&
    candidate.accountId &&
    typeof candidate.csrfToken === 'string' &&
    candidate.csrfToken.length >= 32 &&
    typeof candidate.expiresAt === 'string' &&
    Number.isFinite(Date.parse(candidate.expiresAt))
  );
};

export function AuthPage({ register = false }: { register?: boolean }) {
  const location = useLocation();
  return <AuthScreen key={location.key} register={register} />;
}
function AuthScreen({ register }: { register: boolean }) {
  const { session, refresh } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [method, setMethod] = useState<MfaProof['method']>('totp');
  const [code, setCode] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [expired, setExpired] = useState(false);
  const [restoring, setRestoring] = useState(!register);
  const alive = useRef(false);
  const request = useRef<AbortController | null>(null);
  function begin() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    // The browser URL changes before a transitioned route commits its cleanup.
    const location = window.location.href;
    const historyKey: unknown = window.history.state?.key;
    return {
      controller,
      current: () =>
        alive.current &&
        request.current === controller &&
        !controller.signal.aborted &&
        window.location.href === location &&
        window.history.state?.key === historyKey,
    };
  }
  useEffect(() => {
    alive.current = true;
    if (!register) {
      const { controller, current } = begin();
      void api<unknown>('/api/auth/mfa/challenge', {
        signal: controller.signal,
        isCurrent: current,
      })
        .then((result) => {
          if (!current()) return;
          if (!loginChallenge(result)) throw new Error('Start again to verify your sign-in.');
          setChallenge(result);
          setExpired(Date.parse(result.expiresAt) <= Date.now());
        })
        .catch((problem) => {
          if (current() && !(problem instanceof ApiError && problem.status === 401))
            setError(
              'A previous sign-in could not be restored. Enter your password to start again.',
            );
        })
        .finally(() => {
          if (current()) setRestoring(false);
        });
    }
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, [register]);
  async function finish(
    result: Session,
    current: () => boolean,
    signal: AbortSignal,
    accountId = result.user!.id,
  ) {
    if (!current() || !fullSession(result, accountId))
      throw new Error('Sign-in could not be confirmed. Start again.');
    const refreshed = await refresh(signal, current);
    if (!current()) return;
    if (!fullSession(refreshed, accountId))
      throw new Error('Sign-in could not be confirmed. Check your sign-in status or start again.');
    const next = params.get('next');
    const safeNext =
      next &&
      /^\/(?!\/)/.test(next) &&
      !/[\\\x00-\x20]/.test(next) &&
      new URL(next, window.location.origin).origin === window.location.origin;
    navigate(
      refreshed.user?.mustChangePassword
        ? '/account?required=1'
        : safeNext
          ? next
          : refreshed.user?.role === 'patient'
            ? '/my-care'
            : '/clinic',
    );
    toast(register ? 'Your care account is ready.' : 'Welcome back.');
  }
  async function signIn(email: string, password: string, details?: Record<string, string>) {
    if (busy || restoring) return;
    const { controller, current } = begin();
    setBusy(true);
    setError('');
    setPassword('');
    setCode('');
    setExpired(false);
    setUncertain(false);
    try {
      const result = await api<LoginResult>(register ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        body: { email, password, ...details },
        signal: controller.signal,
        isCurrent: current,
      });
      if (!current()) return;
      if (!register && loginChallenge(result)) {
        setChallenge(result);
        setMethod('totp');
        setExpired(Date.parse(result.expiresAt) <= Date.now());
      } else if (fullSession(result)) await finish(result, current, controller.signal);
      else throw new Error('Sign-in could not be confirmed. Please start again.');
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : 'Sign-in could not be confirmed.');
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!challenge || busy || uncertain || expired) return;
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      setExpired(true);
      setCode('');
      setError('This sign-in check has expired. Start again with your password.');
      return;
    }
    const { controller, current } = begin();
    const proof: MfaProof = {
      method,
      code: method === 'recovery-code' ? code.replace(/[\s-]/g, '').toUpperCase() : code.trim(),
    };
    setCode('');
    setBusy(true);
    setError('');
    try {
      const result = await api<unknown>('/api/auth/mfa/verify', {
        method: 'POST',
        body: { proof },
        signal: controller.signal,
        isCurrent: current,
        mfaCsrfToken: challenge.csrfToken,
      });
      if (!current()) return;
      if (!fullSession(result, challenge.accountId))
        throw new Error('The sign-in response could not be confirmed.');
      await finish(result, current, controller.signal, challenge.accountId);
    } catch (problem) {
      if (!current()) return;
      const unknown = !(problem instanceof ApiError) || problem.status >= 500;
      setUncertain(unknown);
      setExpired(problem instanceof ApiError && [401, 403].includes(problem.status));
      setError(
        unknown
          ? 'Sign-in could not be confirmed. Check its status before using another code.'
          : problem.message,
      );
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function reconcile() {
    if (!challenge || busy) return;
    const { controller, current } = begin();
    setBusy(true);
    setError('');
    try {
      const result = await api<unknown>('/api/session', {
        signal: controller.signal,
        isCurrent: current,
      });
      if (!current()) return;
      if (!fullSession(result, challenge.accountId)) {
        setError('Sign-in is not confirmed. Start again with your password and an unused code.');
        return;
      }
      await finish(result, current, controller.signal, challenge.accountId);
    } catch {
      if (current()) setError('Sign-in status could not be checked. Try again or start again.');
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function restart() {
    if (busy) return;
    const previous = challenge;
    const { controller, current } = begin();
    setChallenge(null);
    setPassword('');
    setCode('');
    setError('');
    setUncertain(false);
    setExpired(false);
    setBusy(true);
    try {
      if (previous)
        await api('/api/auth/mfa/challenge/cancel', {
          method: 'POST',
          mfaCsrfToken: previous.csrfToken,
          signal: controller.signal,
          isCurrent: current,
        });
    } catch {
      // A fresh password submission replaces expired or unavailable challenge state.
    } finally {
      if (current()) setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    void signIn(data.email, data.password, register ? data : undefined);
  }
  return (
    <div className="auth-layout">
      <div className="auth-story">
        <span className="eyebrow">A MORE CONNECTED KIND OF CARE</span>
        <h1>
          Good care starts
          <br />
          with a connection.
        </h1>
        <p>
          One thoughtful space for your appointments, your treatment, and the people looking after
          you.
        </p>
        <div className="auth-orbit">
          <span>
            <HeartHandshake size={58} strokeWidth={1} />
          </span>
          <i />
          <b />
        </div>
        <div className="row">
          <ShieldCheck size={19} />
          <span>Separate, private spaces for patients and clinic teams.</span>
        </div>
      </div>
      <Card className="auth-card">
        <div className="auth-icon">
          <LockKeyhole size={22} />
        </div>
        <h2>
          {challenge
            ? 'Verify your sign-in'
            : register
              ? 'Start your care journey'
              : 'Welcome back'}
        </h2>
        <p className="muted">
          {challenge
            ? 'Your password was accepted. Complete this check to enter your workspace.'
            : register
              ? 'Create a patient account to connect with your clinic.'
              : 'Sign in to your Derma workspace.'}
        </p>
        {challenge ? (
          <form className="stack" onSubmit={verify}>
            <Field label="Verification method">
              <select
                value={method}
                disabled={busy || uncertain || expired}
                onChange={(event) => {
                  setMethod(event.target.value as MfaProof['method']);
                  setCode('');
                  setError('');
                }}
              >
                <option value="totp">Authenticator app</option>
                <option value="recovery-code">Recovery code</option>
              </select>
            </Field>
            <Field
              label="Verification code"
              hint={
                method === 'totp'
                  ? 'Enter the six-digit code from your authenticator app.'
                  : 'Enter one unused recovery code. Each code works once.'
              }
            >
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                inputMode={method === 'totp' ? 'numeric' : 'text'}
                pattern={method === 'totp' ? '[0-9]{6}' : undefined}
                maxLength={method === 'totp' ? 6 : 128}
                spellCheck={false}
                required
                disabled={busy || uncertain || expired}
              />
            </Field>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {expired && <p className="muted small">Start again to request a new sign-in check.</p>}
            {uncertain ? (
              <button
                type="button"
                className="button button-primary button-full"
                disabled={busy}
                onClick={() => void reconcile()}
              >
                {busy ? 'Checking…' : 'Check sign-in status'}
              </button>
            ) : (
              <button className="button button-primary button-full" disabled={busy || expired}>
                {busy ? 'Verifying…' : 'Verify sign-in'}
                <ArrowRight size={17} />
              </button>
            )}
            <button
              type="button"
              className="button button-secondary button-full"
              disabled={busy}
              onClick={() => void restart()}
            >
              Start again
            </button>
          </form>
        ) : (
          <form className="stack" onSubmit={submit}>
            {register && (
              <Field label="Full name">
                <input name="name" autoComplete="name" required maxLength={100} />
              </Field>
            )}
            <Field label="Email address">
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                maxLength={254}
              />
            </Field>
            <Field label="Password" hint={register ? 'Use at least 12 characters.' : undefined}>
              <input
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                minLength={register ? 12 : undefined}
                required
                maxLength={128}
              />
            </Field>
            {register && (
              <>
                <Field label="Phone number">
                  <input
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    required
                    minLength={7}
                    maxLength={20}
                  />
                </Field>
                <div className="form-grid">
                  <Field label="Date of birth">
                    <input name="dob" type="date" required max={today()} />
                  </Field>
                  <Field label="Gender">
                    <select name="gender" defaultValue="prefer-not-to-say">
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                      <option value="other">Other</option>
                      <option value="prefer-not-to-say">Prefer not to say</option>
                    </select>
                  </Field>
                </div>
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button button-primary button-full" disabled={busy || restoring}>
              {restoring
                ? 'Checking sign-in…'
                : busy
                  ? 'Connecting…'
                  : register
                    ? 'Create account'
                    : 'Sign in'}
              <ArrowRight size={17} />
            </button>
          </form>
        )}
        {!register && (
          <p className="auth-switch">
            <Link to="/recover">Need help signing in?</Link>
          </p>
        )}
        <p className="auth-switch">
          {register ? 'Already have an account?' : 'New to the clinic?'}{' '}
          <Link
            to={`${register ? '/login' : '/register'}${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`}
          >
            {register ? 'Sign in' : 'Create a patient account'}
          </Link>
        </p>
        {session.demoMode && !register && !challenge && (
          <div className="demo-accounts">
            <div className="row between">
              <strong>Take a look around</strong>
              <span className="badge badge-amber">DEMO</span>
            </div>
            <p>Explore with fictional records. No setup needed.</p>
            <div className="demo-grid">
              {[
                ['doctor', 'Doctor'],
                ['reception', 'Reception'],
                ['patient', 'Patient'],
                ['admin', 'Admin'],
              ].map(([role, label]) => (
                <button
                  key={role}
                  disabled={busy || restoring}
                  className="button button-secondary"
                  onClick={() => void signIn(`${role}@derma.demo`, 'DemoClinic2026!')}
                >
                  {label}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
