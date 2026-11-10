import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarDays,
  Clock3,
  History,
  ListPlus,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { Appointment, Doctor, Patient } from '../../shared/types';
import type { WaitlistEntry, WaitlistStatus } from '../../shared/waitlist';
import { api, formatDate, today, useResource, useToast } from '../lib';
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
import { ClinicBookingModal } from './ClinicPages';
import './waitlist.css';

const statusLabels: Record<WaitlistStatus, string> = {
  waiting: 'Waiting',
  booked: 'Booked',
  cancelled: 'Withdrawn',
  expired: 'Window ended',
};
const shiftDate = (value: string, days: number) => {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const timeLabel = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
};
const modeLabel = (value: WaitlistEntry['mode']) =>
  value === 'online' ? 'Online consultation' : 'In clinic';
const failure = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
function Status({ value }: { value: WaitlistStatus }) {
  return (
    <Badge tone={value === 'booked' ? 'green' : value === 'waiting' ? 'amber' : 'neutral'}>
      {statusLabels[value]}
    </Badge>
  );
}

type WaitlistAction =
  { kind: 'create' } | { kind: 'book' | 'withdraw' | 'details'; entry: WaitlistEntry };

export function WaitlistPage() {
  const entries = useResource<WaitlistEntry[]>('/api/waitlist');
  const doctors = useResource<Doctor[]>('/api/doctors');
  const [status, setStatus] = useState<WaitlistStatus | 'all'>('waiting');
  const [doctorId, setDoctorId] = useState('');
  const [search, setSearch] = useState('');
  const [action, setAction] = useState<WaitlistAction | null>(null);
  const matches = useMemo(
    () =>
      (entries.data ?? [])
        .filter(
          (entry) =>
            (status === 'all' || entry.status === status) &&
            (!doctorId || entry.doctorId === doctorId) &&
            `${entry.patientName} ${entry.patientPhone ?? ''} ${entry.reason} ${entry.doctorName}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [entries.data, status, doctorId, search],
  );
  const saved = async () => {
    setAction(null);
    await entries.reload();
  };
  return (
    <div className="wl-workspace">
      <PageHeader
        eyebrow="WHEN THE NEXT SLOT OPENS"
        title="Appointment waitlist"
        description="Keep patient preferences ready for a confirmed booking."
        actions={
          <>
            <button
              className="button button-secondary"
              onClick={entries.reload}
              disabled={entries.loading}
            >
              <RefreshCw size={15} /> Refresh waitlist
            </button>
            <button
              className="button button-primary"
              disabled={doctors.loading || !!doctors.error || !doctors.data?.length}
              onClick={() => setAction({ kind: 'create' })}
            >
              <Plus size={16} /> Add to waitlist
            </button>
          </>
        }
      />
      <div className="wl-intro">
        <span className="wl-intro-icon">
          <ListPlus size={23} />
        </span>
        <div>
          <h2>A request now. A confirmed visit when it fits.</h2>
          <p>
            The waitlist records a preferred doctor, consultation mode, and date range. Contact the
            patient before booking a specific available slot. Requests do not reserve slots or send
            external offers.
          </p>
        </div>
      </div>
      {doctors.error && <ErrorState message={doctors.error} retry={doctors.reload} />}
      <div className="wl-metrics">
        {[
          [
            'Waiting requests',
            entries.data?.filter((entry) => entry.status === 'waiting').length ?? 0,
            'Ready for staff to review',
          ],
          [
            'Booked from waitlist',
            entries.data?.filter((entry) => entry.status === 'booked').length ?? 0,
            'Linked to a confirmed appointment',
          ],
          [
            'Windows ended',
            entries.data?.filter((entry) => entry.status === 'expired').length ?? 0,
            'History retained for continuity',
          ],
        ].map(([label, count, detail]) => (
          <Card key={label}>
            <span>{label}</span>
            <strong>{count}</strong>
            <p>{detail}</p>
          </Card>
        ))}
      </div>
      <Card className="wl-list-card">
        <div className="wl-controls">
          <div className="segmented wl-filters">
            {[
              ['waiting', 'Waiting'],
              ['booked', 'Booked'],
              ['cancelled', 'Withdrawn'],
              ['expired', 'Expired'],
              ['all', 'All requests'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={value === status ? 'active' : ''}
                aria-pressed={value === status}
                onClick={() => setStatus(value as typeof status)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="wl-search">
            <Search size={16} />
            <input
              aria-label="Search waitlist"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Patient, phone or request"
            />
          </div>
          <Field label="Filter by doctor">
            <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}>
              <option value="">All doctors</option>
              {doctors.data?.map((doctor) => (
                <option value={doctor.id} key={doctor.id}>
                  {doctor.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {entries.loading ? (
          <Loading />
        ) : entries.error ? (
          <ErrorState message={entries.error} retry={entries.reload} />
        ) : !matches.length ? (
          <EmptyState
            title={
              status === 'waiting' ? 'No waiting requests in this view' : 'No requests in this view'
            }
            description="Try another filter or add a request after discussing the patient’s preferences."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table wl-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Requested visit</th>
                  <th>Date window</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {matches.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="row">
                        <Avatar name={entry.patientName} size="sm" />
                        <div>
                          <strong>{entry.patientName}</strong>
                          <span className="table-sub">
                            {entry.patientPhone || 'No phone recorded'}
                          </span>
                          <span className="table-sub">Added {formatDate(entry.createdAt)}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <strong>{entry.doctorName}</strong>
                      <span className="table-sub">{modeLabel(entry.mode)}</span>
                      <span className="table-sub">{entry.reason}</span>
                    </td>
                    <td>
                      <strong>{formatDate(entry.startDate)}</strong>
                      <span className="table-sub">through {formatDate(entry.endDate)}</span>
                    </td>
                    <td>
                      <Status value={entry.status} />
                      {entry.closedAt && (
                        <span className="table-sub">{formatDate(entry.closedAt)}</span>
                      )}
                    </td>
                    <td>
                      <div className="wl-actions">
                        {entry.status === 'waiting' && (
                          <>
                            <button
                              className="button button-primary button-small"
                              disabled={doctors.loading || !!doctors.error}
                              onClick={() => setAction({ kind: 'book', entry })}
                            >
                              Find a slot
                            </button>
                            <button
                              className="button button-ghost button-small"
                              onClick={() => setAction({ kind: 'withdraw', entry })}
                            >
                              Withdraw request
                            </button>
                          </>
                        )}
                        <button
                          className="button button-secondary button-small"
                          onClick={() => setAction({ kind: 'details', entry })}
                        >
                          <History size={13} /> Request details
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
      <p className="wl-form-note">
        Requests are shown oldest first. This list is an operational record, not a clinical urgency
        score or a promise of appointment availability.
      </p>
      {action?.kind === 'create' && (
        <WaitlistCreateModal
          doctors={doctors.data ?? []}
          onClose={() => setAction(null)}
          onSaved={() => {
            setStatus('waiting');
            setDoctorId('');
            setSearch('');
            void saved();
          }}
        />
      )}
      {action?.kind === 'withdraw' && (
        <WithdrawModal entry={action.entry} onClose={() => setAction(null)} onSaved={saved} />
      )}
      {action?.kind === 'details' && (
        <WaitlistDetails entry={action.entry} onClose={() => setAction(null)} />
      )}
      {action?.kind === 'book' && (
        <ClinicBookingModal
          waitlist={action.entry}
          initialDate={action.entry.startDate > today() ? action.entry.startDate : today()}
          doctors={doctors.data ?? []}
          onClose={() => setAction(null)}
          onSaved={() => {
            setStatus('booked');
            void saved();
          }}
        />
      )}
    </div>
  );
}

function WaitlistCreateModal({
  doctors,
  onClose,
  onSaved,
}: {
  doctors: Doctor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const patients = useResource<Patient[]>('/api/patients');
  const [patientId, setPatientId] = useState('');
  const [doctorId, setDoctorId] = useState(doctors[0]?.id ?? '');
  const [mode, setMode] = useState<WaitlistEntry['mode']>('in-person');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(shiftDate(today(), 7));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/waitlist', {
        method: 'POST',
        body: { patientId, doctorId, mode, startDate, endDate, reason },
      });
      toast('Waitlist request recorded. A slot still needs to be confirmed with the patient.');
      onSaved();
    } catch (problem) {
      setError(failure(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add a patient to the waitlist"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        <p className="muted small">
          Record the visit the patient has requested. No appointment or external message is created
          by joining the waitlist.
        </p>
        {patients.loading ? (
          <Loading />
        ) : patients.error ? (
          <ErrorState message={patients.error} retry={patients.reload} />
        ) : (
          <Field label="Patient">
            <select
              required
              disabled={busy}
              value={patientId}
              onChange={(event) => setPatientId(event.target.value)}
            >
              <option value="">Select a patient</option>
              {patients.data?.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name} · {patient.phone}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!patients.loading && !patients.error && !patients.data?.length && (
          <p className="muted small">
            Register the patient in the Patients workspace before creating a request.
          </p>
        )}
        <div className="form-grid">
          <Field label="Requested doctor">
            <select
              required
              disabled={busy}
              value={doctorId}
              onChange={(event) => setDoctorId(event.target.value)}
            >
              {doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Consultation mode">
            <select
              disabled={busy}
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="in-person">In clinic</option>
              <option value="online">Online consultation</option>
            </select>
          </Field>
        </div>
        <div className="wl-form-section">
          <h3>Dates that work for the patient</h3>
          <div className="wl-window-fields">
            <Field label="Earliest acceptable date">
              <input
                type="date"
                required
                disabled={busy}
                min={today()}
                max={shiftDate(today(), 180)}
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  if (endDate < event.target.value) setEndDate(event.target.value);
                }}
              />
            </Field>
            <Field label="Latest acceptable date">
              <input
                type="date"
                required
                disabled={busy}
                min={startDate || today()}
                max={shiftDate(today(), 180)}
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
              />
            </Field>
          </div>
          <p className="wl-form-note">
            Both dates are included. A request may cover one day or a range within the next 180
            days.
          </p>
        </div>
        <Field label="Reason for requested visit">
          <textarea
            required
            disabled={busy}
            rows={3}
            maxLength={300}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Briefly describe the visit the patient is requesting"
          />
        </Field>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <div className="wl-modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={busy || patients.loading || !!patients.error || !patientId || !doctorId}
          >
            {busy ? 'Saving…' : 'Save waitlist request'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WithdrawModal({
  entry,
  onClose,
  onSaved,
}: {
  entry: WaitlistEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/waitlist/${entry.id}/cancel`, { method: 'POST', body: { reason } });
      toast('Waitlist request withdrawn. Its history remains available.');
      onSaved();
    } catch (problem) {
      setError(failure(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Withdraw this waitlist request?"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        <RequestSummary entry={entry} />
        <Field label="Reason for withdrawal">
          <textarea
            required
            rows={3}
            maxLength={300}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <p className="muted small">
          The request remains in the history and cannot be reopened. If the patient changes their
          preference, record a new request.
        </p>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <div className="wl-modal-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Keep request
          </button>
          <button className="button button-danger" disabled={busy}>
            {busy ? 'Withdrawing…' : 'Confirm withdrawal'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RequestSummary({ entry }: { entry: WaitlistEntry }) {
  return (
    <div className="wl-request-summary">
      <h3>{entry.patientName}</h3>
      <p>{entry.patientPhone || 'No phone recorded'}</p>
      <p>
        <strong>{entry.doctorName}</strong> · {modeLabel(entry.mode)}
      </p>
      <p>
        {formatDate(entry.startDate)} – {formatDate(entry.endDate)}
      </p>
    </div>
  );
}

function WaitlistDetails({ entry, onClose }: { entry: WaitlistEntry; onClose: () => void }) {
  const appointments = useResource<Appointment[]>(entry.appointmentId ? '/api/appointments' : null);
  const appointment = appointments.data?.find((value) => value.id === entry.appointmentId);
  return (
    <Modal title="Waitlist request details" onClose={onClose}>
      <div className="stack">
        <div className="wl-status-line">
          <Status value={entry.status} />
          <span className="muted small">Requested {formatDate(entry.createdAt)}</span>
        </div>
        <RequestSummary entry={entry} />
        <div className="wl-record-field">
          <span>Reason for requested visit</span>
          <p>{entry.reason}</p>
        </div>
        <div className="wl-history">
          <div className="wl-history-entry">
            <strong>Request recorded</strong>
            <p>
              Preferences saved for {entry.doctorName}, {modeLabel(entry.mode).toLowerCase()}.
            </p>
            <small>{formatDate(entry.createdAt)}</small>
          </div>
          {entry.status === 'booked' && (
            <div className="wl-history-entry">
              <strong>Booked after patient confirmation</strong>
              <p>
                The request was linked to an appointment. Later appointment changes do not reopen
                this request.
              </p>
              {entry.closedAt && <small>{formatDate(entry.closedAt)}</small>}
            </div>
          )}
          {entry.status === 'cancelled' && (
            <div className="wl-history-entry">
              <strong>Request withdrawn</strong>
              <p>{entry.cancellationReason || 'No reason recorded.'}</p>
              {entry.closedAt && <small>{formatDate(entry.closedAt)}</small>}
            </div>
          )}
          {entry.status === 'expired' && (
            <div className="wl-history-entry">
              <strong>Requested date window ended</strong>
              <p>
                No appointment was linked within this request. Record a new request if the patient
                still wants a visit.
              </p>
              <small>Window ended {formatDate(entry.endDate)}</small>
            </div>
          )}
        </div>
        {entry.appointmentId && (
          <div className="wl-booking-summary">
            <h3>
              <CalendarDays size={14} /> Linked appointment · current details
            </h3>
            {appointments.loading ? (
              <Loading />
            ) : appointments.error ? (
              <ErrorState message={appointments.error} retry={appointments.reload} />
            ) : appointment ? (
              <>
                <p>
                  {formatDate(appointment.date)} at {timeLabel(appointment.time)} IST ·{' '}
                  {appointment.durationMinutes ?? 30} minutes
                </p>
                <p>
                  {appointment.doctorName} · {modeLabel(appointment.mode)}
                </p>
                <Badge
                  tone={
                    appointment.status === 'cancelled' || appointment.status === 'no-show'
                      ? 'neutral'
                      : 'green'
                  }
                >
                  {appointment.status.replaceAll('-', ' ')}
                </Badge>
                <Link
                  className="button button-secondary button-small"
                  to={`/clinic/appointments?date=${appointment.date}`}
                  onClick={onClose}
                >
                  Open appointment day <ArrowRight size={13} />
                </Link>
              </>
            ) : (
              <p className="muted small">
                The appointment may have moved to another doctor. Open the Appointments workspace to
                find its current details.
              </p>
            )}
          </div>
        )}
        {entry.status === 'waiting' && (
          <div className="notice">
            <Clock3 size={17} />
            <span>
              Still waiting. This request does not reserve an appointment or send an external offer.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
