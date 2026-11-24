import { useLocation, useSearchParams, Link } from 'react-router-dom';
import { useState, type FormEvent } from 'react';
import { Check, CircleOff } from 'lucide-react';
import { api, useResource, useSession, useToast } from '../lib';
import { Avatar, Badge, Card, ErrorState, Field, Loading, PageHeader } from '../components/ui';
import type { Doctor, User, Patient } from '../../shared/types';
import { ClinicConfigurationPanel } from '../components/ClinicConfigurationPanel';
import { DoctorProfileCreationControl } from '../components/DoctorProfileCreationModal';
import { DoctorProfileEditControls } from '../components/DoctorProfileEditModal';
import { DoctorBookingStatusControls } from '../components/DoctorBookingStatus';
import { useAppointmentBookingData } from '../components/appointment-booking-helpers';
import { StaffAccountCreationControl } from '../components/StaffAccountCreationModal';
export function SettingsPage() {
  const { session } = useSession();
  const location = useLocation();
  const doctors = useAppointmentBookingData<Doctor[]>('/api/doctors', (value) => {
    if (
      !Array.isArray(value) ||
      value.some(
        (doctor) =>
          !doctor ||
          typeof doctor.id !== 'string' ||
          !doctor.id ||
          typeof doctor.name !== 'string' ||
          !Array.isArray(doctor.specialties) ||
          !Array.isArray(doctor.languages),
      )
    )
      throw new Error('The doctor profiles could not be loaded.');
    return value;
  });
  const users = useAppointmentBookingData<User[]>('/api/users', (value) => {
    if (
      !Array.isArray(value) ||
      value.some(
        (account) =>
          !account ||
          typeof account.id !== 'string' ||
          typeof account.name !== 'string' ||
          typeof account.email !== 'string' ||
          !['admin', 'doctor', 'receptionist', 'patient'].includes(account.role),
      )
    )
      throw new Error('The workspace accounts could not be loaded.');
    return value;
  });
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
              {session.user?.role === 'admin' && !session.user.mustChangePassword && (
                <DoctorProfileCreationControl
                  key={JSON.stringify([location.key, session.user.id, session.csrfToken])}
                  actorId={session.user.id}
                  onSaved={() => void doctors.reload()}
                />
              )}
            </div>
            {doctors.error ? (
              <ErrorState message={doctors.error} retry={doctors.reload} />
            ) : (
              <div className="team-list">
                {doctors.data?.map((d) => (
                  <div
                    className="team-row doctor-booking-team-row"
                    key={d.id}
                    data-doctor-id={d.id}
                  >
                    <Avatar name={d.name} color={d.color} />
                    <div className="grow doctor-booking-team-main">
                      <strong>{d.name}</strong>
                      <small>
                        {d.qualifications} · {d.specialties.join(', ')}
                      </small>
                    </div>
                    <div className="doctor-booking-team-tools">
                      {session.user?.role === 'admin' && !session.user.mustChangePassword && (
                        <DoctorProfileEditControls
                          key={JSON.stringify([
                            location.key,
                            session.user.id,
                            session.csrfToken,
                            d.id,
                          ])}
                          actorId={session.user.id}
                          doctorId={d.id}
                          name={d.name}
                          onSaved={() => void doctors.reload()}
                        />
                      )}
                      <DoctorBookingStatusControls
                        doctor={d}
                        onSaved={() => void doctors.reload()}
                      />
                    </div>
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
              {session.user?.role === 'admin' && !session.user.mustChangePassword && (
                <StaffAccountCreationControl
                  key={JSON.stringify([location.key, session.user.id, session.csrfToken])}
                  actorId={session.user.id}
                  doctors={doctors.data ?? []}
                  onRefreshDoctors={() => void doctors.reload()}
                  onSaved={() => void users.reload()}
                />
              )}
            </div>
            {users.error ? (
              <ErrorState message={users.error} retry={users.reload} />
            ) : (
              <div
                className="table-wrap"
                role="region"
                tabIndex={0}
                aria-label="Team member accounts; scroll horizontally for all columns"
              >
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
          <PortalAccessCard accounts={users.data} reloadAccounts={users.reload} />
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
    </>
  );
}
function PortalAccessCard({
  accounts,
  reloadAccounts,
}: {
  accounts: User[] | null;
  reloadAccounts: () => Promise<User[] | null>;
}) {
  const patients = useResource<Patient[]>('/api/patients');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const linked = new Set(accounts?.map((u) => u.patientId).filter(Boolean));
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
      await reloadAccounts();
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
