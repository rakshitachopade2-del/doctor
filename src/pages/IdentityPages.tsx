import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Check,
  Copy,
  KeyRound,
  LogOut,
  Monitor,
  Pencil,
  Search,
  ShieldCheck,
  UserRoundCheck,
  UserRoundX,
} from 'lucide-react';
import type { AccountSession, ManagedAccount, RecoveryGrant } from '../../shared/identity';
import type { Doctor, Role } from '../../shared/types';
import { api, formatDate, useResource, useSession, useToast } from '../lib';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import './identity.css';

export function AccountsPage() {
  const { session } = useSession();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [action, setAction] = useState<{
    account: ManagedAccount;
    type: 'edit' | 'status' | 'recovery';
  } | null>(null);
  const accounts = useResource<ManagedAccount[]>(
    `/api/accounts?search=${encodeURIComponent(query)}${role ? `&role=${role}` : ''}`,
  );
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 200);
    return () => clearTimeout(timer);
  }, [search]);
  return (
    <>
      <PageHeader
        eyebrow="PEOPLE & ACCESS"
        title="The right access, for every person."
        description="Manage clinic accounts while keeping their care records intact."
        actions={
          <Link className="button button-primary" to="/clinic/settings?tab=team">
            Add a team member
          </Link>
        }
      />
      <div className="notice">
        <ShieldCheck size={19} />
        <span>
          Account changes are recorded in the activity log. Suspending an account ends its sessions
          without removing appointments or clinical records.
        </span>
      </div>
      <Card>
        <div className="section-heading">
          <div className="identity-search">
            <Search size={17} />
            <input
              aria-label="Search accounts"
              placeholder="Search name or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="identity-role-filter"
            aria-label="Filter account role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">All roles</option>
            <option value="admin">Administrators</option>
            <option value="doctor">Doctors</option>
            <option value="receptionist">Reception</option>
            <option value="patient">Patients</option>
          </select>
        </div>
        {accounts.loading ? (
          <Loading />
        ) : accounts.error ? (
          <ErrorState message={accounts.error} retry={accounts.reload} />
        ) : !accounts.data?.length ? (
          <EmptyState
            title="No matching accounts"
            description="Try another name, email, or role."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Role</th>
                  <th>Access</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.data.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <div className="row">
                        <Avatar name={account.name} size="sm" />
                        <div>
                          <strong>{account.name}</strong>
                          <small className="table-subtitle">{account.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={account.role === 'admin' ? 'purple' : 'neutral'}>
                        {account.role}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={account.active ? 'green' : 'red'}>
                        {account.active ? 'Active' : 'Suspended'}
                      </Badge>
                      {account.mustChangePassword && (
                        <small className="table-subtitle">Password change required</small>
                      )}
                    </td>
                    <td>
                      <div className="identity-actions">
                        {account.role !== 'patient' && (
                          <button
                            className="button button-secondary button-small"
                            onClick={() => setAction({ account, type: 'edit' })}
                          >
                            <Pencil size={13} />
                            Edit access
                          </button>
                        )}
                        <button
                          className="button button-ghost button-small"
                          disabled={!account.active}
                          onClick={() => setAction({ account, type: 'recovery' })}
                        >
                          <KeyRound size={13} />
                          Recovery
                        </button>
                        <button
                          className="button button-ghost button-small"
                          disabled={account.id === session.user?.id}
                          onClick={() => setAction({ account, type: 'status' })}
                        >
                          {account.active ? <UserRoundX size={13} /> : <UserRoundCheck size={13} />}
                          {account.active ? 'Suspend' : 'Restore'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {action?.type === 'edit' && (
        <EditAccount
          account={action.account}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null);
            accounts.reload();
          }}
        />
      )}
      {action?.type === 'status' && (
        <AccountStatus
          account={action.account}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null);
            accounts.reload();
            toast('Account access updated.');
          }}
        />
      )}
      {action?.type === 'recovery' && (
        <RecoveryGrantModal account={action.account} onClose={() => setAction(null)} />
      )}
    </>
  );
}

function EditAccount({
  account,
  onClose,
  onSaved,
}: {
  account: ManagedAccount;
  onClose: () => void;
  onSaved: () => void;
}) {
  const doctors = useResource<Doctor[]>('/api/doctors');
  const { refresh, session } = useSession();
  const toast = useToast();
  const [role, setRole] = useState<Role>(account.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    try {
      await api(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        body: {
          name: form.get('name'),
          role,
          doctorId: role === 'receptionist' ? null : form.get('doctorId') || null,
        },
      });
      toast('Account permissions saved.');
      onSaved();
      if (account.id === session.user?.id) await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Edit access for ${account.name}`} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Field label="Account name">
          <input name="name" required maxLength={100} defaultValue={account.name} />
        </Field>
        <Field label="Account role">
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="receptionist">Receptionist</option>
            <option value="doctor">Doctor</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
        <Field
          label="Linked doctor profile"
          hint="Required for doctors. Administrators need a linked profile to write clinical notes and care plans."
        >
          <select
            name="doctorId"
            defaultValue={account.doctorId || ''}
            required={role === 'doctor'}
            disabled={role === 'receptionist'}
          >
            <option value="">No clinical profile</option>
            {doctors.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="notice">
          Changing a role or doctor profile ends this account’s existing sessions. The person must
          sign in again.
        </div>
        <button className="button button-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save account access'}
        </button>
      </form>
    </Modal>
  );
}

function AccountStatus({
  account,
  onClose,
  onSaved,
}: {
  account: ManagedAccount;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        body: { active: !account.active },
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`${account.active ? 'Suspend' : 'Restore'} account access?`} onClose={onClose}>
      <p>
        <strong>{account.name}</strong> · {account.email}
      </p>
      <p className="muted">
        {account.active
          ? 'This person will be signed out and cannot sign in again until access is restored. Their records remain in the clinic.'
          : 'This person will be able to sign in again. Previously ended sessions will stay closed.'}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="button button-secondary" onClick={onClose}>
          Keep current access
        </button>
        <button className="button button-primary" disabled={busy} onClick={save}>
          {busy ? 'Updating…' : account.active ? 'Suspend account' : 'Restore account'}
        </button>
      </div>
    </Modal>
  );
}

function RecoveryGrantModal({
  account,
  onClose,
}: {
  account: ManagedAccount;
  onClose: () => void;
}) {
  const [grant, setGrant] = useState<RecoveryGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const link = grant
    ? `${window.location.origin}/recover#token=${encodeURIComponent(grant.token)}`
    : '';
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setGrant(
        await api<RecoveryGrant>(`/api/accounts/${account.id}/recovery`, {
          method: 'POST',
          body: { identityVerified: true },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      toast('Recovery link copied. Share it privately with the verified account holder.');
    } catch {
      toast('Copy the recovery link from the field below.', 'error');
    }
  }
  return (
    <Modal title={`Account recovery for ${account.name}`} onClose={onClose}>
      {grant ? (
        <div className="stack">
          <div className="notice">
            <Check size={18} />
            <span>
              Recovery link created. It can be used once before{' '}
              {new Date(grant.expiresAt).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Kolkata',
              })}{' '}
              IST.
            </span>
          </div>
          <Field
            label="Private recovery link"
            hint="Shown only here. Creating another link invalidates the previous one."
          >
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </Field>
          <button className="button button-secondary" onClick={copy}>
            <Copy size={15} />
            Copy recovery link
          </button>
          <p className="muted">
            Give this link only to the person whose identity you verified. No message is sent
            automatically. After they set a new password, all their previous sessions will end.
          </p>
          <button className="button button-primary" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={create}>
          <p>{account.email}</p>
          <p className="muted">
            Create a short-lived recovery link after confirming the account holder’s identity
            through your clinic’s process.
          </p>
          <label className="checkbox-field">
            <input type="checkbox" required />
            <span>I have verified the identity of this account holder.</span>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button button-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create recovery link'}
          </button>
        </form>
      )}
    </Modal>
  );
}

export function SecurityPage() {
  const { session, refresh } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const sessions = useResource<AccountSession[]>('/api/auth/sessions');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const required = !!session.user?.mustChangePassword;
  async function password(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setError('');
    if (values.newPassword !== values.confirm) return setError('The new passwords do not match.');
    setBusy('password');
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      });
      form.reset();
      await refresh();
      await sessions.reload();
      toast('Password updated. Your other sessions have been signed out.');
      if (required)
        navigate(session.user?.role === 'patient' ? '/my-care' : '/clinic', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function revoke(item?: AccountSession) {
    setBusy(item?.id || 'others');
    try {
      await api(item ? `/api/auth/sessions/${item.id}` : '/api/auth/sessions/revoke-others', {
        method: item ? 'DELETE' : 'POST',
      });
      await sessions.reload();
      toast(item ? 'Session ended.' : 'Other sessions ended.');
      if (item?.current) {
        await refresh();
        navigate('/login');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }
  async function signOut() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      navigate('/login', { replace: true });
      await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  return (
    <div className="account-page">
      <div className="row between">
        {!required && (
          <Link
            className="text-link"
            to={session.user?.role === 'patient' ? '/my-care' : '/clinic'}
          >
            ← Back to workspace
          </Link>
        )}
        <button className="button button-ghost button-small" onClick={signOut}>
          <LogOut size={15} />
          Sign out
        </button>
      </div>
      <PageHeader
        title={required ? 'Make this account your own.' : 'Your account & security'}
        description={
          required
            ? 'Set a private password before opening your workspace.'
            : 'Manage your password and the sessions connected to your account.'
        }
      />
      {required && (
        <div className="notice">
          <KeyRound size={20} />
          <span>
            Your clinic provided an initial password. Change it now to protect access to your
            account.
          </span>
        </div>
      )}
      <div className="grid-2">
        <Card>
          <h2>{session.user?.name}</h2>
          <p>{session.user?.email}</p>
          <Badge tone="green">{session.user?.role}</Badge>
          <div className="notice">
            <ShieldCheck size={20} />
            <span>
              Your access follows your clinic role. Keep your password private and end sessions on
              devices you no longer use.
            </span>
          </div>
        </Card>
        <Card>
          <h2>Change password</h2>
          <form className="stack" onSubmit={password}>
            <Field label={required ? 'Initial password' : 'Current password'}>
              <input
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
              />
            </Field>
            <Field
              label="New password"
              hint="Use 12–128 characters, different from your current password."
            >
              <input
                name="newPassword"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm new password">
              <input
                name="confirm"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button button-primary" disabled={!!busy}>
              {busy === 'password' ? 'Updating…' : required ? 'Set my password' : 'Update password'}
            </button>
          </form>
        </Card>
      </div>
      <Card className="session-card">
        <div className="section-heading">
          <div>
            <h2>Active sessions</h2>
            <p className="muted">Sessions expire automatically after 12 hours.</p>
          </div>
          <button
            className="button button-secondary button-small"
            disabled={!!busy || !sessions.data?.some((s) => !s.current)}
            onClick={() => revoke()}
          >
            End other sessions
          </button>
        </div>
        {sessions.loading ? (
          <Loading />
        ) : sessions.error ? (
          <ErrorState message={sessions.error} retry={sessions.reload} />
        ) : (
          <div className="session-list">
            {sessions.data?.map((item) => (
              <div className="session-row" key={item.id}>
                <Monitor size={22} />
                <div className="grow">
                  <strong>{item.label || 'Web browser'}</strong>
                  <p>
                    Started {formatDate(item.createdAt)} · Expires{' '}
                    {new Date(item.expiresAt).toLocaleTimeString('en-IN', {
                      timeZone: 'Asia/Kolkata',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    IST
                  </p>
                </div>
                {item.current ? (
                  <Badge tone="green">This session</Badge>
                ) : (
                  <button
                    className="button button-secondary button-small"
                    disabled={!!busy}
                    onClick={() => revoke(item)}
                  >
                    End session
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export function RecoveryPage() {
  const [token, setToken] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get('token') || '',
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const { refresh } = useSession();
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setError('');
    if (values.password !== values.confirm) return setError('The new passwords do not match.');
    setBusy(true);
    try {
      await api('/api/auth/recover', {
        method: 'POST',
        body: { token, password: values.password },
      });
      setToken('');
      setDone(true);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="recovery-page">
      <Card>
        <span className="auth-icon">
          <KeyRound size={23} />
        </span>
        <h1>{done ? 'Your password has been reset.' : 'Get back to your care.'}</h1>
        {done ? (
          <>
            <p className="muted">
              Previous sessions have ended. Sign in with your new password to continue.
            </p>
            <Link className="button button-primary" to="/login">
              Sign in
            </Link>
          </>
        ) : !token ? (
          <>
            <p className="muted">
              Contact your clinic for a private recovery link. They will verify your identity before
              helping you regain access.
            </p>
            <Link className="button button-secondary" to="/login">
              Back to sign in
            </Link>
          </>
        ) : (
          <form className="stack" onSubmit={submit}>
            <p className="muted">
              Choose a new private password. This recovery link expires shortly and can be used only
              once.
            </p>
            <Field label="New password" hint="At least 12 characters.">
              <input
                type="password"
                name="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm new password">
              <input
                type="password"
                name="confirm"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button button-primary" disabled={busy}>
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
