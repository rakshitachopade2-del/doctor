import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, HeartHandshake, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api, useSession, useToast, today } from '../lib';
import { Card, Field, PageHeader } from '../components/ui';
import type { Session } from '../../shared/types';
export function AuthPage({ register = false }: { register?: boolean }) {
  const { session, refresh } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signIn(email: string, password: string, details?: Record<string, string>) {
    setBusy(true);
    setError('');
    try {
      const result = await api<Session>(register ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        body: { email, password, ...details },
      });
      await refresh();
      const next = params.get('next');
      const safeNext =
        next &&
        /^\/(?!\/)/.test(next) &&
        !/[\\\x00-\x20]/.test(next) &&
        new URL(next, window.location.origin).origin === window.location.origin;
      navigate(
        result.user?.mustChangePassword
          ? '/account?required=1'
          : safeNext
            ? next
            : result.user?.role === 'patient'
              ? '/my-care'
              : '/clinic',
      );
      toast(register ? 'Your care account is ready.' : 'Welcome back.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
        <h2>{register ? 'Start your care journey' : 'Welcome back'}</h2>
        <p className="muted">
          {register
            ? 'Create a patient account to connect with your clinic.'
            : 'Sign in to your Derma workspace.'}
        </p>
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
          <button className="button button-primary button-full" disabled={busy}>
            {busy ? 'Connecting…' : register ? 'Create account' : 'Sign in'}
            <ArrowRight size={17} />
          </button>
        </form>
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
        {session.demoMode && !register && (
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
                  disabled={busy}
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
