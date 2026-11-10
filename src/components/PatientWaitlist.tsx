import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarDays, Clock3, ListPlus, RefreshCw } from 'lucide-react';
import type { Doctor } from '../../shared/types';
import type { WaitlistEntry } from '../../shared/waitlist';
import { api, formatDate, today, useResource, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import './patient-waitlist.css';

function after(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to save this request. Please try again.';
const modeLabel = (mode: WaitlistEntry['mode']) =>
  mode === 'online' ? 'Online consultation' : 'In-person consultation';

export function WaitlistJoinModal({
  doctorId: initialDoctor = '',
  mode: initialMode = 'in-person',
  startDate: initialDate,
  reason: initialReason = '',
  onClose,
  onCreated,
}: {
  doctorId?: string;
  mode?: WaitlistEntry['mode'];
  startDate?: string;
  reason?: string;
  onClose: () => void;
  onCreated: (entry: WaitlistEntry) => void;
}) {
  const doctors = useResource<Doctor[]>('/api/doctors');
  const [doctorId, setDoctorId] = useState(initialDoctor);
  const [mode, setMode] = useState(initialMode);
  const latest = after(today(), 180);
  const initialStart =
    initialDate && initialDate >= today() && initialDate <= latest ? initialDate : today();
  const [startDate, setStartDate] = useState(initialStart);
  const [endDate, setEndDate] = useState(
    after(initialStart, 7) > latest ? latest : after(initialStart, 7),
  );
  const [reason, setReason] = useState(initialReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!doctorId && doctors.data?.length) setDoctorId(doctors.data[0].id);
  }, [doctorId, doctors.data]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!doctorId || !reason.trim() || endDate < startDate) {
      setError('Choose a clinician, a valid date range, and the reason for your visit.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const entry = await api<WaitlistEntry>('/api/waitlist', {
        method: 'POST',
        body: { doctorId, mode, startDate, endDate, reason: reason.trim() },
      });
      onCreated(entry);
    } catch (problem) {
      setError(message(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Join the appointment waitlist"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="muted">
        Tell your clinic which dates could work. Joining does not reserve an appointment or send an
        email or SMS. Your clinic can contact you separately to coordinate a visit.
      </p>
      {doctors.loading ? (
        <Loading />
      ) : doctors.error ? (
        <ErrorState message={doctors.error} retry={doctors.reload} />
      ) : !doctors.data?.length ? (
        <EmptyState
          title="No clinicians available yet"
          description="Contact the clinic to discuss an appointment."
        />
      ) : (
        <form onSubmit={submit} className="stack patient-waitlist-form">
          <Field label="Preferred clinician">
            <select
              value={doctorId}
              required
              disabled={busy}
              onChange={(event) => setDoctorId(event.target.value)}
            >
              {doctors.data.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Preferred consultation mode">
            <select
              value={mode}
              disabled={busy}
              onChange={(event) => setMode(event.target.value as WaitlistEntry['mode'])}
            >
              <option value="in-person">In person at the clinic</option>
              <option value="online">Online consultation</option>
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Earliest date">
              <input
                type="date"
                required
                disabled={busy}
                min={today()}
                max={latest}
                value={startDate}
                onChange={(event) => {
                  const value = event.target.value;
                  setStartDate(value);
                  if (value > endDate) setEndDate(value);
                }}
              />
            </Field>
            <Field label="Latest date">
              <input
                type="date"
                required
                disabled={busy}
                min={startDate || today()}
                max={latest}
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Reason for your waitlist request"
            hint="Up to 300 characters. Your clinic will see this with your request."
          >
            <textarea
              rows={3}
              required
              disabled={busy}
              maxLength={300}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <p className="patient-waitlist-help">
            You can have one waiting request per clinician and consultation mode. You can withdraw a
            request from My care.
          </p>
          {error && (
            <div role="alert" className="notice notice-error">
              {error}
            </div>
          )}
          <button className="button button-primary" disabled={busy || !doctorId}>
            {busy ? 'Saving request…' : 'Join waitlist'}
            <ListPlus size={16} />
          </button>
        </form>
      )}
    </Modal>
  );
}

export function PatientWaitlistPanel() {
  const requests = useResource<WaitlistEntry[]>('/api/waitlist');
  const [join, setJoin] = useState(false);
  const [withdraw, setWithdraw] = useState<WaitlistEntry | null>(null);
  const [history, setHistory] = useState(false);
  const [params] = useSearchParams();
  const selected = params.get('waitlist');
  const anchor = useRef<HTMLDivElement>(null);
  const focusedRequest = useRef<string | null>(null);
  const toast = useToast();
  const waiting = requests.data?.filter((entry) => entry.status === 'waiting') ?? [];
  const previous = requests.data?.filter((entry) => entry.status !== 'waiting') ?? [];
  useEffect(() => {
    if (requests.data?.some((entry) => entry.id === selected && entry.status !== 'waiting'))
      setHistory(true);
  }, [selected, requests.data]);
  useEffect(() => {
    if (!selected) {
      focusedRequest.current = null;
      return;
    }
    if (
      requests.loading ||
      join ||
      withdraw ||
      focusedRequest.current === selected ||
      !requests.data?.some((entry) => entry.id === selected)
    )
      return;
    const frame = requestAnimationFrame(() => {
      anchor.current?.focus({ preventScroll: true });
      anchor.current?.scrollIntoView({ block: 'start' });
      focusedRequest.current = selected;
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, requests.data, requests.loading, join, withdraw]);
  function renderEntry(entry: WaitlistEntry) {
    return (
      <article
        className={`patient-waitlist-entry${selected === entry.id ? ' patient-waitlist-selected' : ''}`}
        key={entry.id}
        data-waitlist-id={entry.id}
      >
        <div className="patient-waitlist-entry-heading">
          <div>
            <h3>{entry.doctorName}</h3>
            <p>{modeLabel(entry.mode)}</p>
          </div>
          <Badge tone={entry.status === 'booked' ? 'green' : 'neutral'}>
            {entry.status === 'waiting'
              ? 'Waiting'
              : entry.status === 'cancelled'
                ? 'Withdrawn'
                : entry.status === 'expired'
                  ? 'Date range ended'
                  : 'Booked'}
          </Badge>
        </div>
        <p className="patient-waitlist-dates">
          <CalendarDays size={15} />
          <span>
            {formatDate(entry.startDate)} – {formatDate(entry.endDate)}
          </span>
        </p>
        <p className="patient-waitlist-reason">{entry.reason}</p>
        <p className="patient-waitlist-created">Requested {formatDate(entry.createdAt)}</p>
        {entry.cancellationReason && (
          <p className="patient-waitlist-reason">Withdrawal note: {entry.cancellationReason}</p>
        )}
        {entry.status === 'waiting' && (
          <div className="patient-waitlist-actions">
            <Link
              className="button button-secondary button-small"
              to={`/book?waitlist=${encodeURIComponent(entry.id)}`}
            >
              Choose an available time
            </Link>
            <button className="button button-ghost button-small" onClick={() => setWithdraw(entry)}>
              Withdraw request
            </button>
          </div>
        )}
        {entry.status === 'booked' && (
          <Link className="text-link" to="/my-care/record?tab=visits">
            View appointment record →
          </Link>
        )}
        {entry.status === 'expired' && (
          <p className="patient-waitlist-help">
            This date range has ended. Join again if you would like to request different dates.
          </p>
        )}
      </article>
    );
  }
  return (
    <div
      className="patient-waitlist-panel"
      id="waitlist-requests"
      ref={anchor}
      tabIndex={-1}
      role="region"
      aria-label="Your appointment waitlist"
    >
      <Card>
        <div className="patient-waitlist-heading">
          <div>
            <span className="eyebrow">WHEN THE TIME IS RIGHT</span>
            <h2>Your waitlist requests</h2>
          </div>
          <Clock3 size={23} />
        </div>
        <p className="patient-waitlist-help">
          A request keeps your preferred dates with the clinic. It does not hold a slot. A confirmed
          appointment appears in your care record and in-app activity.
        </p>
        <div className="patient-waitlist-toolbar">
          <button className="button button-secondary button-small" onClick={() => setJoin(true)}>
            <ListPlus size={15} />
            Join waitlist
          </button>
          <button
            className="button button-ghost button-small"
            disabled={requests.loading}
            onClick={requests.reload}
          >
            <RefreshCw size={14} />
            Refresh requests
          </button>
        </div>
        {requests.loading ? (
          <Loading />
        ) : requests.error ? (
          <ErrorState message={requests.error} retry={requests.reload} />
        ) : (
          <>
            {waiting.length ? (
              <div className="patient-waitlist-list">{waiting.map(renderEntry)}</div>
            ) : (
              <EmptyState
                title="No waiting requests"
                description="If the available times do not suit you, share a preferred date range with your clinic."
              />
            )}
            {previous.length > 0 && (
              <div className="patient-waitlist-history">
                <button
                  className="button button-ghost button-small"
                  aria-expanded={history}
                  aria-controls="patient-waitlist-history"
                  onClick={() => setHistory((value) => !value)}
                >
                  {history ? 'Hide request history' : `View request history (${previous.length})`}
                </button>
                <div id="patient-waitlist-history" hidden={!history}>
                  {history && previous.map(renderEntry)}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
      {join && (
        <WaitlistJoinModal
          onClose={() => setJoin(false)}
          onCreated={() => {
            setJoin(false);
            requests.reload();
            toast('Waitlist request saved. No appointment is reserved.');
          }}
        />
      )}
      {withdraw && (
        <WithdrawWaitlistModal
          entry={withdraw}
          onClose={() => setWithdraw(null)}
          onSaved={() => {
            setWithdraw(null);
            requests.reload();
            toast('Waitlist request withdrawn.');
          }}
        />
      )}
    </div>
  );
}

function WithdrawWaitlistModal({
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/waitlist/${encodeURIComponent(entry.id)}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      onSaved();
    } catch (problem) {
      setError(message(problem));
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
      <p>
        Your request for {entry.doctorName} between {formatDate(entry.startDate)} and{' '}
        {formatDate(entry.endDate)} will close. Existing appointments are unchanged.
      </p>
      <form className="stack patient-waitlist-form" onSubmit={submit}>
        <Field label="Withdrawal note" hint="Optional. Up to 300 characters.">
          <textarea
            rows={3}
            maxLength={300}
            disabled={busy}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {error && (
          <div role="alert" className="notice notice-error">
            {error}
          </div>
        )}
        <div className="patient-waitlist-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Keep request
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy ? 'Withdrawing…' : 'Confirm withdrawal'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
