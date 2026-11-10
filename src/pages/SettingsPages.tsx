import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  CircleOff,
  FileClock,
  Plus,
  Settings2,
  ShieldCheck,
  Stethoscope,
  Users,
} from 'lucide-react';
import { api, formatDate, useResource, useToast } from '../lib';
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
import type { AuditEntry, ClinicSettings, Doctor, User, Patient } from '../../shared/types';
export function SettingsPage() {
  const settings = useResource<ClinicSettings>('/api/settings');
  const doctors = useResource<Doctor[]>('/api/doctors');
  const users = useResource<User[]>('/api/users');
  const toast = useToast();
  const [draft, setDraft] = useState<ClinicSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'doctor' | 'user' | null>(null);
  const [editing, setEditing] = useState<Doctor | null>(null);
  const [tab, setTab] = useState('clinic');
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/settings', { method: 'PATCH', body: draft });
      await settings.reload();
      toast('Clinic settings saved.');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      if (modal === 'doctor') {
        const body = {
          ...form,
          experience: Number(form.experience),
          fee: Number(form.fee),
          specialties: form.specialties
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
          languages: form.languages
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
          color: form.color || '#e0ede6',
        };
        await api(editing ? `/api/doctors/${editing.id}` : '/api/doctors', {
          method: editing ? 'PATCH' : 'POST',
          body,
        });
        await doctors.reload();
      } else {
        await api('/api/users', {
          method: 'POST',
          body: { ...form, doctorId: form.doctorId || undefined },
        });
        await users.reload();
      }
      setModal(null);
      setEditing(null);
      toast(modal === 'doctor' ? 'Doctor profile saved.' : 'Team member added.');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  if (settings.loading) return <Loading />;
  if (settings.error) return <ErrorState message={settings.error} retry={settings.reload} />;
  if (!draft) return null;
  return (
    <>
      <PageHeader
        eyebrow="MAKE IT YOURS"
        title="Your clinic, your way."
        description="Manage your clinic details, care modules, and the people behind it."
      />
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {[
          ['clinic', 'Clinic profile'],
          ['modules', 'Care modules'],
          ['team', 'Your team'],
          ['integrations', 'Connections'],
        ].map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'clinic' && (
        <div className="settings-grid">
          <Card>
            <h2>Public clinic information</h2>
            <p className="muted">These details appear on your patient-facing clinic page.</p>
            <form className="stack" onSubmit={save}>
              <Field label="Clinic name">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  required
                  maxLength={120}
                />
              </Field>
              <Field label="Tagline">
                <input
                  value={draft.tagline}
                  onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                  required
                  maxLength={200}
                />
              </Field>
              <div className="form-grid">
                <Field label="Contact phone">
                  <input
                    type="tel"
                    value={draft.phone}
                    onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                    required
                    maxLength={30}
                  />
                </Field>
                <Field label="Contact email">
                  <input
                    type="email"
                    value={draft.email}
                    onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                    required
                  />
                </Field>
              </div>
              <Field label="Clinic address">
                <textarea
                  value={draft.address}
                  onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                  required
                  maxLength={300}
                />
              </Field>
              <Field
                label="Opening hours"
                hint="Display information. Booking slots currently run Monday–Saturday, 09:00–17:30, every 30 minutes."
              >
                <input
                  value={draft.hours}
                  onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
                  required
                />
              </Field>
              <Field label="Clinic time zone">
                <input value="Asia/Kolkata (IST)" readOnly />
              </Field>
              <div>
                <button className="button button-primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Save clinic details'}
                </button>
              </div>
            </form>
          </Card>
          <Card className="settings-tip">
            <Settings2 size={25} />
            <h2>A familiar face for your clinic.</h2>
            <p>
              Your public profile helps patients find your clinic, understand your services, and
              book with confidence.
            </p>
            <div className="notice">
              <ShieldCheck size={18} />
              <span>Patient records stay inside the protected workspace.</span>
            </div>
          </Card>
        </div>
      )}
      {tab === 'modules' && (
        <form onSubmit={save}>
          <div className="module-grid">
            {(
              [
                {
                  key: 'intake',
                  title: 'Structured intake',
                  text: 'Give patients space to share their history before a consultation.',
                  icon: FileClock,
                },
                {
                  key: 'images',
                  title: 'Clinical image library',
                  text: 'Keep private clinical photographs and image reports connected to each patient.',
                  icon: Stethoscope,
                },
                {
                  key: 'followUp',
                  title: 'Follow-up companion',
                  text: 'Capture daily check-ins and keep your clinic conversations in one place.',
                  icon: Users,
                },
              ] as const
            ).map((m) => (
              <Card key={m.key}>
                <span className="module-icon">
                  <m.icon size={24} />
                </span>
                <h2>{m.title}</h2>
                <p className="muted">{m.text}</p>
                <label className="toggle-row">
                  <span>{draft.modules[m.key] ? 'Enabled' : 'Disabled'}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Enable ${m.title}`}
                    checked={draft.modules[m.key]}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        modules: { ...draft.modules, [m.key]: e.target.checked },
                      })
                    }
                  />
                </label>
              </Card>
            ))}
          </div>
          <div className="notice">
            Turning off a module pauses new activity. Existing records remain available for
            continuity of care.
          </div>
          <button className="button button-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save modules'}
          </button>
        </form>
      )}
      {tab === 'team' && (
        <div className="stack">
          <Card>
            <div className="section-heading">
              <div>
                <h2>Doctor profiles</h2>
                <p className="muted">Public qualifications, focus areas, and consultation fees.</p>
              </div>
              <button
                className="button button-primary"
                onClick={() => {
                  setEditing(null);
                  setModal('doctor');
                }}
              >
                <Plus size={16} />
                Add doctor
              </button>
            </div>
            {doctors.error ? (
              <ErrorState message={doctors.error} retry={doctors.reload} />
            ) : (
              <div className="team-list">
                {doctors.data?.map((d) => (
                  <div className="team-row" key={d.id}>
                    <Avatar name={d.name} color={d.color} />
                    <div className="grow">
                      <strong>{d.name}</strong>
                      <small>
                        {d.qualifications} · {d.specialties.join(', ')}
                      </small>
                    </div>
                    <button
                      className="button button-secondary button-small"
                      onClick={() => {
                        setEditing(d);
                        setModal('doctor');
                      }}
                    >
                      Edit profile
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <div className="section-heading">
              <div>
                <h2>Workspace access</h2>
                <p className="muted">Each team member gets their own account and role.</p>
              </div>
              <button className="button button-secondary" onClick={() => setModal('user')}>
                <Plus size={16} />
                Add team member
              </button>
            </div>
            {users.error ? (
              <ErrorState message={users.error} retry={users.reload} />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Team member</th>
                      <th>Email</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.data
                      ?.filter((u) => u.role !== 'patient')
                      .map((u) => (
                        <tr key={u.id}>
                          <td>
                            <div className="row">
                              <Avatar name={u.name} size="sm" />
                              <strong>{u.name}</strong>
                            </div>
                          </td>
                          <td>{u.email}</td>
                          <td>
                            <Badge tone={u.role === 'admin' ? 'purple' : 'green'}>{u.role}</Badge>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <PortalAccessCard />
        </div>
      )}
      {tab === 'integrations' && (
        <div className="grid-2">
          {[
            {
              title: 'Calendar export',
              text: 'Every appointment includes a downloadable .ics calendar event. Import it into your preferred calendar.',
              active: true,
            },
            {
              title: 'Clinic messaging',
              text: 'Patients and clinicians can exchange messages inside the private workspace.',
              active: true,
            },
            {
              title: 'WhatsApp, SMS & email',
              text: 'External message delivery needs a provider account and an integration. No messages are sent outside this app.',
              active: false,
            },
            {
              title: 'Payments & online visits',
              text: 'Online appointments can be booked. Video calls and payment collection require a separate provider.',
              active: false,
            },
            {
              title: 'AI & voice assistance',
              text: 'Structured intake is available. AI diagnosis, voice transcription, and generated medical advice are not enabled.',
              active: false,
            },
            {
              title: 'Clinical systems',
              text: 'Hospital integrations, validated clinical calculators, and automated medicine warnings need specialist implementation.',
              active: false,
            },
          ].map((i) => (
            <Card key={i.title}>
              <div className="row between">
                <h2>{i.title}</h2>
                <Badge tone={i.active ? 'green' : 'neutral'}>
                  {i.active ? (
                    <>
                      <Check size={12} />
                      Available
                    </>
                  ) : (
                    <>
                      <CircleOff size={12} />
                      Not connected
                    </>
                  )}
                </Badge>
              </div>
              <p className="muted">{i.text}</p>
            </Card>
          ))}
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal === 'doctor'
              ? editing
                ? 'Edit doctor profile'
                : 'Add a doctor'
              : 'Add a team member'
          }
          onClose={() => {
            setModal(null);
            setEditing(null);
          }}
        >
          <form className="stack" onSubmit={create}>
            {modal === 'doctor' ? (
              <>
                <Field label="Display name">
                  <input
                    name="name"
                    defaultValue={editing?.name}
                    placeholder="Dr. Full name"
                    required
                  />
                </Field>
                <Field label="Professional title">
                  <input
                    name="title"
                    defaultValue={editing?.title || 'Consultant Dermatologist'}
                    required
                  />
                </Field>
                <Field label="Qualifications">
                  <input
                    name="qualifications"
                    defaultValue={editing?.qualifications}
                    placeholder="MBBS, MD Dermatology"
                    required
                  />
                </Field>
                <div className="form-grid">
                  <Field label="Years of experience">
                    <input
                      type="number"
                      name="experience"
                      min="0"
                      max="70"
                      defaultValue={editing?.experience || 0}
                      required
                    />
                  </Field>
                  <Field label="Consultation fee (₹)">
                    <input
                      type="number"
                      name="fee"
                      min="0"
                      max="100000"
                      defaultValue={editing?.fee || 800}
                      required
                    />
                  </Field>
                </div>
                <Field label="Focus areas" hint="Separate each focus area with a comma.">
                  <input
                    name="specialties"
                    defaultValue={editing?.specialties.join(', ')}
                    placeholder="Acne, Hair and scalp, General dermatology"
                    required
                  />
                </Field>
                <Field label="Languages" hint="Separate with commas.">
                  <input
                    name="languages"
                    defaultValue={editing?.languages.join(', ') || 'English, Hindi'}
                    required
                  />
                </Field>
                <Field label="About the doctor">
                  <textarea name="bio" defaultValue={editing?.bio} required maxLength={2000} />
                </Field>
                <input name="color" type="hidden" value={editing?.color || '#e0ede6'} />
              </>
            ) : (
              <>
                <Field label="Full name">
                  <input name="name" required maxLength={100} />
                </Field>
                <Field label="Email address">
                  <input name="email" type="email" required />
                </Field>
                <Field
                  label="Initial password"
                  hint="Share securely. The team member can change it from Account & security."
                >
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </Field>
                <Field label="Role">
                  <select name="role" defaultValue="receptionist">
                    <option value="receptionist">
                      Receptionist — appointments and demographics
                    </option>
                    <option value="doctor">Doctor — clinical workspace</option>
                    <option value="admin">Administrator — full clinic access</option>
                  </select>
                </Field>
                <Field
                  label="Doctor profile"
                  hint="Required for doctor accounts. Leave empty for other roles."
                >
                  <select name="doctorId">
                    <option value="">No doctor profile</option>
                    {doctors.data?.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <button className="button button-primary" disabled={busy}>
              {busy ? 'Saving…' : modal === 'doctor' ? 'Save doctor' : 'Create account'}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
export function AuditPage() {
  const { data, loading, error, reload } = useResource<AuditEntry[]>('/api/audit');
  return (
    <>
      <PageHeader
        eyebrow="A CLEARER RECORD"
        title="Clinic activity"
        description="A traceable history of access and changes across your workspace."
      />
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} retry={reload} />
      ) : (
        <Card>
          {data?.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th>Performed by</th>
                    <th>Record</th>
                    <th>Date & time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.action.replaceAll('_', ' ').replaceAll('.', ' ')}</strong>
                      </td>
                      <td>{a.actorName}</td>
                      <td>
                        <Badge>{a.entityType}</Badge>
                        <small className="table-subtitle">{a.entityId.slice(0, 12)}</small>
                      </td>
                      <td>
                        {formatDate(a.createdAt)}
                        <small className="table-subtitle">
                          {new Date(a.createdAt).toLocaleTimeString('en-IN', {
                            timeZone: 'Asia/Kolkata',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}{' '}
                          IST
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="A fresh start" description="Workspace activity will appear here." />
          )}
        </Card>
      )}
    </>
  );
}

function PortalAccessCard() {
  const patients = useResource<Patient[]>('/api/patients');
  const users = useResource<User[]>('/api/users');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const linked = new Set(users.data?.map((u) => u.patientId).filter(Boolean));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError('');
    try {
      await api(`/api/patients/${values.patientId}/portal-account`, {
        method: 'POST',
        body: { email: values.email, password: values.password, identityVerified: true },
      });
      form.reset();
      await users.reload();
      toast('Portal account created and linked to the existing patient record.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2>Patient portal access</h2>
      <p className="muted">
        Connect an existing clinic patient to their record with a private sign-in account.
      </p>
      <form className="stack portal-provision" onSubmit={submit}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Field label="Existing patient">
          <select name="patientId" required>
            <option value="">Choose a patient without portal access</option>
            {patients.data
              ?.filter((p) => !linked.has(p.id))
              .map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name} · {p.phone}
                </option>
              ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Patient login email">
            <input name="email" type="email" required autoComplete="off" />
          </Field>
          <Field label="Initial portal password">
            <input
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <label className="checkbox-field">
          <input required type="checkbox" />
          <span>I have verified this patient’s identity and that this email belongs to them.</span>
        </label>
        <div className="notice">
          Share the initial credentials securely with the patient. No email is sent automatically.
          They can change the password in Account & security.
        </div>
        <div>
          <button className="button button-primary" disabled={busy}>
            {busy ? 'Creating access…' : 'Create patient portal access'}
          </button>
        </div>
      </form>
    </Card>
  );
}
