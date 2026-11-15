import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CalendarClock, CalendarOff, Globe2 } from 'lucide-react';
import type { Doctor } from '../../shared/types';
import type { SchedulingData } from '../../shared/scheduling';
import { useResource, useSession } from '../lib';
import { Avatar, Card, EmptyState, ErrorState, Field, Loading, PageHeader } from '../components/ui';
import './scheduling.css';
import { TimeOffPanel } from '../components/TimeOffPanel';
import { DoctorBookingBadge } from '../components/DoctorBookingStatus';
import {
  WeeklyAvailabilityEditor,
  WeeklyAvailabilityReadonly,
} from '../components/WeeklyAvailabilityEditor';

export function SchedulingPage() {
  const { session } = useSession();
  const location = useLocation();
  const scheduling = useResource<SchedulingData>('/api/scheduling');
  const doctors = useResource<Doctor[]>('/api/doctors');
  const [doctorId, setDoctorId] = useState(session.user?.doctorId || '');
  const [saving, setSaving] = useState(false);
  const [addingClosure, setAddingClosure] = useState<{ doctorId: string; key: string } | null>(
    null,
  );
  const [timeOffBusy, setTimeOffBusy] = useState(false);
  useEffect(() => setAddingClosure(null), [doctorId, location.key]);
  const isAdmin = session.user?.role === 'admin';
  const canEdit =
    isAdmin || (session.user?.role === 'doctor' && session.user.doctorId === doctorId);
  const selectedDoctor = doctors.data?.find((d) => d.id === doctorId);
  const savedSchedule = scheduling.data?.schedules.find((s) => s.doctorId === doctorId);
  useEffect(() => {
    if (!doctorId && doctors.data?.length) setDoctorId(doctors.data[0].id);
  }, [doctorId, doctors.data]);
  if ((scheduling.loading && !scheduling.data) || (doctors.loading && !doctors.data))
    return <Loading />;
  if ((!scheduling.data && scheduling.error) || (!doctors.data && doctors.error))
    return (
      <ErrorState
        message={scheduling.error || doctors.error}
        retry={() => {
          void scheduling.reload();
          void doctors.reload();
        }}
      />
    );
  return (
    <>
      <PageHeader
        eyebrow="MAKE ROOM FOR BETTER CARE"
        title="Availability & time off"
        description="Set a considered rhythm for each doctor, with space for breaks and time away."
        actions={
          canEdit ? (
            <button
              className="button button-primary"
              disabled={!doctorId || timeOffBusy}
              onClick={() => setAddingClosure({ doctorId, key: location.key })}
            >
              <CalendarOff size={17} /> Add time off
            </button>
          ) : undefined
        }
      />
      {(scheduling.error || doctors.error) && (
        <ErrorState
          message={scheduling.error || doctors.error}
          retry={() => {
            void scheduling.reload();
            void doctors.reload();
          }}
        />
      )}
      {!doctors.data?.length ? (
        <Card>
          <EmptyState
            title="Start with a doctor profile"
            description="Add a doctor to the clinic before setting their bookable hours."
            action={
              isAdmin ? (
                <Link className="button button-primary" to="/clinic/settings">
                  Open clinic settings
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="schedule-selector">
            <div className="schedule-doctor">
              <Avatar name={selectedDoctor?.name || 'Doctor'} color={selectedDoctor?.color} />
              <Field label="Doctor schedule">
                <select
                  value={doctorId}
                  onChange={(e) => {
                    if (!saving && !timeOffBusy) setDoctorId(e.target.value);
                  }}
                  disabled={saving || timeOffBusy}
                >
                  {doctors.data.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="schedule-timezone">
              <Globe2 size={16} />
              <span>
                India Standard Time · UTC +05:30
                <br />
                <small>Bookable up to {scheduling.data?.bookingWindowDays || 180} days ahead</small>
              </span>
            </div>
          </div>
          {selectedDoctor && (
            <div className="notice doctor-booking-schedule">
              <div>
                <DoctorBookingBadge accepting={selectedDoctor.acceptingNewBookings !== false} />
                <p>
                  {selectedDoctor.acceptingNewBookings === false
                    ? 'New appointments and waitlist requests are paused for this doctor. Existing visits can still be managed and rescheduled with the same doctor. Weekly hours and time off remain in effect.'
                    : 'Weekly hours and time off determine available times for new and existing visits.'}
                </p>
                {isAdmin && (
                  <Link to="/clinic/settings?tab=team">Manage doctor booking status</Link>
                )}
              </div>
            </div>
          )}
          {!canEdit && (
            <div className="notice schedule-readonly">
              <CalendarClock size={18} />
              <span>
                {session.user?.role === 'doctor'
                  ? 'You can view this doctor’s hours. Choose your own profile to manage your availability.'
                  : 'You have read-only access to availability. A doctor or administrator can update it.'}
              </span>
            </div>
          )}
          {!selectedDoctor ? (
            <Loading />
          ) : canEdit ? (
            <WeeklyAvailabilityEditor
              key={`weekly:${doctorId}:${location.key}`}
              doctorId={doctorId}
              onLockChange={setSaving}
              onSaved={() => {
                void scheduling.reload();
                void doctors.reload();
              }}
            />
          ) : savedSchedule ? (
            <WeeklyAvailabilityReadonly schedule={savedSchedule} />
          ) : (
            <EmptyState
              title="No schedule available"
              description="Refresh to load this doctor's availability."
            />
          )}
          {selectedDoctor && (
            <TimeOffPanel
              key={`time-off:${doctorId}:${location.key}`}
              doctor={selectedDoctor}
              createRequested={
                addingClosure?.doctorId === doctorId && addingClosure.key === location.key
              }
              onCreate={() => setAddingClosure({ doctorId, key: location.key })}
              onCreateHandled={() => setAddingClosure(null)}
              onLockChange={setTimeOffBusy}
              onSaved={() => void scheduling.reload()}
            />
          )}
        </>
      )}
    </>
  );
}
