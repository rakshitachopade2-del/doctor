import { useSearchParams, Link } from 'react-router-dom';
import { useState, type FormEvent } from 'react';
import { Check, CircleOff, Plus } from 'lucide-react';
import { api, useResource, useToast } from '../lib';
import {
  Avatar,
  Badge,
  Card,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import type { Doctor, User, Patient } from '../../shared/types';
import { ClinicConfigurationPanel } from '../components/ClinicConfigurationPanel';
export function SettingsPage() {
  const doctors = useResource<Doctor[]>('/api/doctors');
  const users = useResource<User[]>('/api/users');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'doctor' | 'user' | null>(null);
  const [editing, setEditing] = useState<Doctor | null>(null);
  const [params, setParams] = useSearchParams();
  const sections = [
    ['clinic', 'Clinic profile'],
    ['modules', 'Care modules'],
    ['team', 'Your team'],
    ['integrations', 'Connections'],
    ['history', 'Configuration history'],
  ];
  const tab = sections.some(([key]) => key === params.get('tab')) ? params.get('tab')! : 'clinic';
  function setTab(key: string) {
    const next = new URLSearchParams(params);
    next.set('tab', key);
    setParams(next);
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
  return (
    <>
      <PageHeader
        eyebrow="MAKE IT YOURS"
        title="Your clinic, your way."
        description="Manage your clinic details, care modules, and the people behind it."
      />
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {sections.map(([key, label], index) => (
          <button
            key={key}
            id={`settings-tab-${key}`}
            role="tab"
            aria-controls={tab === key ? `settings-panel-${key}` : undefined}
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
            onKeyDown={(event) => {
              const target =
                event.key === 'ArrowRight'
                  ? (index + 1) % sections.length
                  : event.key === 'ArrowLeft'
                    ? (index + sections.length - 1) % sections.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? sections.length - 1
                        : null;
              if (target === null) return;
              event.preventDefault();
              setTab(sections[target][0]);
              document.getElementById(`settings-tab-${sections[target][0]}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ClinicConfigurationPanel activeTab={tab} />
      {tab === 'team' && (
        <div
          className="stack"
          role="tabpanel"
          id="settings-panel-team"
          aria-labelledby="settings-tab-team"
        >
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
                <p className="muted">
                  Each team member gets their own account and role. Manage suspensions and recovery
                  in Accounts & access.
                </p>
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
        <div
          className="grid-2"
          role="tabpanel"
          id="settings-panel-integrations"
          aria-labelledby="settings-tab-integrations"
        >
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
                  hint="Share securely. The team member must replace this password at first sign-in."
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
          They must replace it with a private password at first sign-in.
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
