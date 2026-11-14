import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import type { Appointment } from '../../shared/types';
import { formatDate, today } from '../lib';
import { Badge, Card, EmptyState } from './ui';
import './patient-appointments.css';

function interval(appointment: Appointment) {
  const [hour, minute] = appointment.time.split(':').map(Number);
  const end = hour * 60 + minute + (appointment.durationMinutes ?? 30);
  return `${appointment.time}–${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

function Visit({
  appointment,
  onCancel,
}: {
  appointment: Appointment;
  onCancel: (value: Appointment) => void;
}) {
  const future =
    new Date(`${appointment.date}T${appointment.time}:00+05:30`).getTime() > Date.now();
  const open = !['cancelled', 'completed', 'no-show'].includes(appointment.status);
  return (
    <div className="upcoming-visit" data-appointment-id={appointment.id}>
      <div className="visit-date">
        <strong>{new Date(`${appointment.date}T12:00:00Z`).getUTCDate()}</strong>
        <span>
          {new Date(`${appointment.date}T12:00:00Z`).toLocaleDateString('en-IN', {
            month: 'short',
            timeZone: 'Asia/Kolkata',
          })}
        </span>
      </div>
      <div>
        <h3>{appointment.doctorName}</h3>
        <p>
          {formatDate(appointment.date)} · {interval(appointment)} IST
        </p>
        <p className="muted">
          {appointment.durationPolicy === 'custom'
            ? appointment.mode === 'online'
              ? 'Online clinic visit'
              : 'In-person clinic visit'
            : appointment.mode === 'online'
              ? 'Online consultation'
              : 'In-person consultation'}{' '}
          · {appointment.durationMinutes ?? 30} minutes
        </p>
        <Badge>{appointment.status.replaceAll('-', ' ')}</Badge>
        {future && open && (
          <div className="appointment-actions">
            <a href={`/api/appointments/${appointment.id}/calendar`} download>
              Add to calendar
            </a>
            {appointment.status === 'scheduled' && (
              <>
                <Link to={`/book?appointmentId=${appointment.id}`}>Reschedule</Link>
                <button onClick={() => onCancel(appointment)}>Cancel</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Resolves a deep link only within the already-authorized patient record. */
export function PatientAppointments({
  appointments,
  selectedId,
  onCancel,
}: {
  appointments: Appointment[];
  selectedId: string | null;
  onCancel: (value: Appointment) => void;
}) {
  const selected = selectedId
    ? appointments.find((appointment) => appointment.id === selectedId)
    : undefined;
  const focus = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedId && focus.current) {
      focus.current.focus({ preventScroll: true });
      focus.current.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [selectedId, selected?.id, selected?.date, selected?.time, selected?.status]);
  const upcoming = appointments
    .filter(
      (appointment) =>
        appointment.id !== selected?.id &&
        appointment.date >= today() &&
        !['cancelled', 'completed', 'no-show'].includes(appointment.status),
    )
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  return (
    <Card>
      {selectedId && (
        <section
          ref={focus}
          tabIndex={-1}
          className="patient-selected-appointment"
          aria-labelledby="patient-selected-appointment-title"
        >
          <h2 id="patient-selected-appointment-title" className="section-title">
            {selected ? 'Current appointment details' : 'Appointment unavailable'}
          </h2>
          {selected ? (
            <>
              <p className="patient-appointment-history-note">
                Earlier activity notices are recorded history. These are the appointment’s current
                details.
              </p>
              <Visit appointment={selected} onCancel={onCancel} />
              <Link className="text-link" to="/my-care/record?tab=visits">
                View visit history
              </Link>
            </>
          ) : (
            <p>
              This appointment is not available in your record. You can review your visits below or
              contact the clinic.
            </p>
          )}
        </section>
      )}
      <div className="row between">
        <h2 className="section-title">Your next visits</h2>
        <CalendarDays size={20} />
      </div>
      {upcoming.length ? (
        <div className="upcoming-visits">
          {upcoming.map((appointment) => (
            <Visit key={appointment.id} appointment={appointment} onCancel={onCancel} />
          ))}
        </div>
      ) : selected &&
        selected.date >= today() &&
        !['cancelled', 'completed', 'no-show'].includes(selected.status) ? (
        <p className="muted small">
          Your selected visit is shown above. No other upcoming visits are recorded.
        </p>
      ) : (
        <EmptyState
          title="No upcoming visits"
          description="Choose a time when you’re ready."
          action={
            <Link className="button button-secondary" to="/book">
              View availability
            </Link>
          }
        />
      )}
    </Card>
  );
}
