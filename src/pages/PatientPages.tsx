import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  HeartHandshake,
  ImagePlus,
  Leaf,
  MapPin,
  MessageCircle,
  Plus,
  Search,
  ShieldCheck,
  Stethoscope,
  Upload,
  Video,
  X,
} from 'lucide-react';
import type {
  Appointment,
  CarePlan,
  CheckIn,
  ClinicalImage,
  ClinicSettings,
  Doctor,
  Intake,
  Message,
  PatientRecord,
} from '../../shared/types';
import { api, formatDate, money, today, useResource, useSession, useToast } from '../lib';
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
import './patient.css';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { PatientWorkflowPanel } from './PatientWorkflowPanel';
import type { WaitlistEntry } from '../../shared/waitlist';
import { PatientWaitlistPanel, WaitlistJoinModal } from '../components/PatientWaitlist';
import { ImageAnnotationViewer } from '../components/ImageAnnotations';
import {
  PatientFollowUp,
  effectivePlanStatus,
  effectiveReviewDate,
} from '../components/PatientFollowUp';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const longDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
const dateAfter = (days: number) => {
  const date = new Date(`${today()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const readableStatus = (status: string) => status.replaceAll('-', ' ');

export function DiscoverPage() {
  const doctors = useResource<Doctor[]>('/api/doctors');
  const settings = useResource<ClinicSettings>('/api/settings');
  const { session } = useSession();
  const [search, setSearch] = useState('');
  const [specialty, setSpecialty] = useState('All concerns');
  const options = [
    'All concerns',
    ...new Set((doctors.data ?? []).flatMap((doctor) => doctor.specialties)),
  ];
  const filtered = (doctors.data ?? []).filter(
    (doctor) =>
      (specialty === 'All concerns' || doctor.specialties.includes(specialty)) &&
      `${doctor.name} ${doctor.specialties.join(' ')} ${doctor.languages.join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="discovery-page">
      <section className="discovery-hero">
        <div className="discovery-hero-copy">
          <span className="eyebrow">
            <span className="status-dot" /> YOUR SKIN. YOUR JOURNEY.
          </span>
          <h1>
            Care that stays
            <br />
            with you.
          </h1>
          <p>
            Find your dermatologist, feel prepared for your visit, and keep every step of your care
            in one place.
          </p>
          <div className="row hero-actions">
            <a className="button button-primary" href="#doctors">
              Find your dermatologist <ArrowRight size={17} />
            </a>
            {settings.data?.modules.intake && (
              <Link className="button button-secondary" to="/intake">
                Prepare for your visit
              </Link>
            )}
          </div>
          <div className="hero-reassurance">
            <ShieldCheck size={16} /> Your records stay private. Your care stays connected.
          </div>
        </div>
        <div className="care-illustration" aria-hidden="true">
          <div className="illustration-orbit orbit-one" />
          <div className="illustration-orbit orbit-two" />
          <div className="illustration-leaf leaf-one" />
          <div className="illustration-leaf leaf-two" />
          <div className="illustration-center">
            <Leaf size={58} strokeWidth={1} />
            <span>
              Room to
              <br />
              <em>feel better.</em>
            </span>
          </div>
          <div className="floating-care care-top">
            <CalendarDays size={19} />
            <div>
              <strong>Your next chapter</strong>
              <small>Thoughtful, connected care</small>
            </div>
          </div>
          <div className="floating-care care-bottom">
            <HeartHandshake size={20} />
            <div>
              <strong>One care journey</strong>
              <small>From the first visit onward</small>
            </div>
          </div>
        </div>
      </section>
      <div className="care-principles">
        <div>
          <Stethoscope size={20} />
          <span>Dermatology, at the centre</span>
        </div>
        <div>
          <FileText size={20} />
          <span>Your story in one place</span>
        </div>
        <div>
          <HeartHandshake size={20} />
          <span>Support between visits</span>
        </div>
      </div>
      <section id="doctors" className="discovery-doctors">
        <PageHeader
          eyebrow="MEET YOUR CARE TEAM"
          title="A little clarity. The right care."
          headingLevel={2}
          description="Explore your options by area of focus, language, and consultation fee."
        />
        {session?.demoMode && (
          <div className="notice demo-profile-note">
            Demonstration clinic · These are fictional doctor profiles and appointments for
            exploring the platform.
          </div>
        )}
        <div className="doctor-search-row">
          <div className="search-field">
            <Search size={18} />
            <input
              aria-label="Search doctors, concerns, or languages"
              placeholder="Search a doctor, concern, or language"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <label className="sr-only" htmlFor="doctor-specialty">
            Area of focus
          </label>
          <select
            id="doctor-specialty"
            className="select"
            value={specialty}
            onChange={(event) => setSpecialty(event.target.value)}
          >
            {options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </div>
        {doctors.loading ? (
          <Loading />
        ) : doctors.error ? (
          <ErrorState message={doctors.error} retry={doctors.reload} />
        ) : filtered.length ? (
          <div className="doctor-grid">
            {filtered.map((doctor) => (
              <Card key={doctor.id} className="doctor-profile-card">
                <div className="row between">
                  <Avatar name={doctor.name} color={doctor.color} />
                  <span className="doctor-label">DERMATOLOGIST</span>
                </div>
                <h3>{doctor.name}</h3>
                <p className="doctor-qualification">{doctor.qualifications}</p>
                <p className="muted">
                  {doctor.title} · {doctor.experience} years of experience
                </p>
                <div className="doctor-specialties">
                  {doctor.specialties.map((area) => (
                    <span className="pill" key={area}>
                      {area}
                    </span>
                  ))}
                </div>
                <p className="doctor-bio">{doctor.bio}</p>
                <div className="doctor-details">
                  <span>
                    <MessageCircle size={15} /> {doctor.languages.join(', ')}
                  </span>
                  <span>
                    <MapPin size={15} /> In-clinic & online consultation
                  </span>
                </div>
                <div className="doctor-booking-footer">
                  <div>
                    <strong>{money(doctor.fee)}</strong>
                    <span>Consultation fee</span>
                  </div>
                  <Link to={`/book?doctor=${doctor.id}`} className="button button-primary">
                    View availability <ArrowUpRight size={16} />
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No matching doctors"
            description="Try another concern, language, or name."
            action={
              <button
                className="button button-secondary"
                onClick={() => {
                  setSearch('');
                  setSpecialty('All concerns');
                }}
              >
                Clear filters
              </button>
            }
          />
        )}
      </section>
      <section className="journey-section">
        <div>
          <span className="eyebrow">A MORE CONNECTED EXPERIENCE</span>
          <h2>
            Your care doesn’t end
            <br />
            at the clinic door.
          </h2>
          <p className="muted">
            A clear plan. A place for questions. A record that grows with you.
          </p>
          <Link to={session?.user ? '/my-care' : '/register'} className="button button-secondary">
            {session?.user ? 'Open your workspace' : 'Create your patient account'}
            <ArrowRight size={16} />
          </Link>
        </div>
        <div className="journey-steps">
          {[
            [
              '01',
              'Start with your story',
              'Capture your concerns before your appointment, at your own pace.',
            ],
            [
              '02',
              'Keep the plan close',
              'Find your clinician’s instructions, records, and follow-up dates together.',
            ],
            [
              '03',
              'Stay in touch',
              'Record your daily check-in and share questions with your clinic.',
            ],
          ].map(([number, title, description]) => (
            <div className="journey-step" key={number}>
              <span>{number}</span>
              <div>
                <h3>{title}</h3>
                <p>{description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      {settings.data && (
        <footer className="clinic-contact">
          <div>
            <strong>{settings.data.name}</strong>
            <p>{settings.data.address}</p>
          </div>
          <div>
            <span>{settings.data.hours}</span>
            <a href={`tel:${settings.data.phone}`}>{settings.data.phone}</a>
          </div>
        </footer>
      )}
    </div>
  );
}

export function BookingPage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  if (!session?.user)
    return (
      <Navigate to={`/login?next=${encodeURIComponent(`/book?${params.toString()}`)}`} replace />
    );
  if (session.user.role !== 'patient')
    return (
      <EmptyState
        title="Book on behalf of a patient"
        description="Use the clinic appointment workspace to select a patient and schedule a visit."
        action={
          <Link className="button button-primary" to="/clinic/appointments">
            Open appointments
          </Link>
        }
      />
    );
  return <BookingForm key={params.toString()} />;
}

function BookingForm() {
  const [params] = useSearchParams();
  const doctors = useResource<Doctor[]>('/api/doctors');
  const appointments = useResource<Appointment[]>('/api/appointments');
  const appointmentId = params.get('appointmentId');
  const waitlistId = params.get('waitlist');
  const waitlist = useResource<WaitlistEntry[]>(waitlistId ? '/api/waitlist' : null);
  const waitlistEntry = waitlist.data?.find((entry) => entry.id === waitlistId);
  const existing = appointments.data?.find((appointment) => appointment.id === appointmentId);
  const [doctorId, setDoctorId] = useState(params.get('doctor') ?? '');
  const [date, setDate] = useState(today());
  const [time, setTime] = useState('');
  const [mode, setMode] = useState<'in-person' | 'online'>('in-person');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [booked, setBooked] = useState<Appointment | null>(null);
  const [joinWaitlist, setJoinWaitlist] = useState(false);
  const [waitlistCreated, setWaitlistCreated] = useState<WaitlistEntry | null>(null);
  useEffect(() => {
    if (existing) {
      setDoctorId(existing.doctorId);
      setDate(existing.date);
      setMode(existing.mode);
      setReason(existing.reason);
      setTime(existing.time);
    }
  }, [existing?.id]);
  useEffect(() => {
    if (waitlistEntry && !appointmentId) {
      setDoctorId(waitlistEntry.doctorId);
      setMode(waitlistEntry.mode);
      setDate(waitlistEntry.startDate < today() ? today() : waitlistEntry.startDate);
      setReason(waitlistEntry.reason);
      setTime('');
    }
  }, [waitlistEntry?.id, appointmentId]);
  useEffect(() => {
    if (!appointmentId && !waitlistId && !doctorId && doctors.data?.length)
      setDoctorId(doctors.data[0].id);
  }, [doctors.data, doctorId, appointmentId, waitlistId]);
  const doctor = doctors.data?.find((value) => value.id === doctorId);
  const slots = useResource<string[]>(
    doctorId && date
      ? `/api/slots?doctorId=${encodeURIComponent(doctorId)}&date=${encodeURIComponent(date)}&mode=${mode}${appointmentId ? `&excludeAppointmentId=${encodeURIComponent(appointmentId)}` : ''}`
      : null,
  );
  const availableSlots = [...(slots.data ?? [])];
  availableSlots.sort();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || slots.loading) return;
    if (!time || !availableSlots.includes(time)) {
      setTime('');
      setError('Choose an available appointment time.');
      return;
    }
    if (
      waitlistId &&
      (!waitlistEntry ||
        waitlistEntry.status !== 'waiting' ||
        doctorId !== waitlistEntry.doctorId ||
        mode !== waitlistEntry.mode ||
        date < waitlistEntry.startDate ||
        date > waitlistEntry.endDate)
    ) {
      setError('Choose a date within this waiting request. Refresh if the request has changed.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api<Appointment>(
        appointmentId ? `/api/appointments/${appointmentId}` : '/api/appointments',
        {
          method: appointmentId ? 'PATCH' : 'POST',
          body: appointmentId
            ? { doctorId, date, time }
            : {
                doctorId,
                date,
                time,
                mode,
                reason,
                ...(waitlistId ? { waitlistId, patientConfirmed: true } : {}),
              },
        },
      );
      setBooked(result);
    } catch (problem) {
      setError(errorMessage(problem));
      setTime('');
      slots.reload();
      if (waitlistId) waitlist.reload();
    } finally {
      setBusy(false);
    }
  }
  if (
    doctors.loading ||
    (appointmentId && appointments.loading) ||
    (waitlistId && waitlist.loading)
  )
    return <Loading />;
  if (doctors.error || (appointmentId && appointments.error) || (waitlistId && waitlist.error))
    return (
      <ErrorState
        message={
          doctors.error || appointments.error || waitlist.error || 'Unable to load appointment.'
        }
        retry={() => {
          doctors.reload();
          appointments.reload();
          waitlist.reload();
        }}
      />
    );
  if (
    waitlistId &&
    !booked &&
    (appointmentId ||
      !waitlistEntry ||
      waitlistEntry.status !== 'waiting' ||
      waitlistEntry.endDate < today())
  )
    return (
      <EmptyState
        title="This waitlist request cannot be booked"
        description="It may have been booked, withdrawn, or reached the end of its date range. Open your own requests to check its current status."
        action={
          <Link
            className="button button-primary"
            to={`/my-care?waitlist=${encodeURIComponent(waitlistId)}`}
          >
            View my waitlist requests
          </Link>
        }
      />
    );
  if (appointmentId && !existing)
    return (
      <EmptyState
        title="Appointment not found"
        description="This appointment may no longer be available."
        action={
          <Link className="button button-primary" to="/my-care">
            Back to my care
          </Link>
        }
      />
    );
  if (existing && existing.status !== 'scheduled' && !booked)
    return (
      <EmptyState
        title="This visit cannot be rescheduled here"
        description="Contact your clinic to change a visit already in progress or book a new appointment."
        action={
          <Link className="button button-primary" to="/my-care">
            Back to my care
          </Link>
        }
      />
    );
  if (booked)
    return (
      <div className="booking-success">
        <div className="success-mark">
          <CheckCircle2 size={35} />
        </div>
        <span className="eyebrow">YOUR NEXT STEP IS READY</span>
        <h1>{appointmentId ? 'Appointment rescheduled.' : 'You’re booked in.'}</h1>
        <p className="muted">Your appointment is saved in your care workspace.</p>
        {waitlistId && (
          <p className="patient-waitlist-help">
            Your waitlist request is now marked booked. You can find it in your request history.
          </p>
        )}
        <Card>
          <h3>{booked.doctorName}</h3>
          <div className="booking-confirmation-details">
            <span>
              <CalendarDays size={18} />
              {longDate(booked.date)}
            </span>
            <span>
              <Clock3 size={18} />
              {booked.time} · Asia/Kolkata
            </span>
            <span>
              {booked.mode === 'online' ? <Video size={18} /> : <MapPin size={18} />}
              {booked.mode === 'online'
                ? 'Online consultation — the clinic will coordinate connection details'
                : 'In-person consultation'}
            </span>
          </div>
          <p className="muted">
            Consultation fee: {money(booked.fee)} · Payment is coordinated by the clinic.
          </p>
        </Card>
        <div className="row">
          <Link to="/my-care" className="button button-primary">
            View my care <ArrowRight size={17} />
          </Link>
          <a
            className="button button-secondary"
            href={`/api/appointments/${booked.id}/calendar`}
            download
          >
            Add to calendar
          </a>
        </div>
        <Link className="text-link" to="/intake">
          Prepare a history for your dermatologist
        </Link>
      </div>
    );
  return (
    <div className="booking-page">
      <PageHeader
        eyebrow="MAKE TIME FOR YOURSELF"
        title={appointmentId ? 'Reschedule your visit' : 'Let’s plan your visit'}
        description="Choose your dermatologist and a time that works for you. All times are in Asia/Kolkata."
      />
      {waitlistEntry && (
        <div className="notice booking-waitlist-notice">
          <Clock3 size={18} />
          <span>
            You’re booking from your waitlist request for {waitlistEntry.doctorName}. Choose a time
            between {formatDate(waitlistEntry.startDate)} and {formatDate(waitlistEntry.endDate)}.
            Your clinician and consultation mode stay as requested. A slot is reserved only after
            you confirm.
          </span>
        </div>
      )}
      {waitlistCreated && (
        <div className="notice booking-waitlist-notice" role="status">
          <CheckCircle2 size={18} />
          <span>
            Your waitlist request is saved. No appointment is reserved.{' '}
            <Link
              className="text-link"
              to={`/my-care?waitlist=${encodeURIComponent(waitlistCreated.id)}`}
            >
              View your request →
            </Link>
          </span>
        </div>
      )}
      <form onSubmit={submit} className="booking-grid">
        <div className="stack">
          <Card>
            <h2 className="section-title">01 / Your dermatologist</h2>
            <div className="booking-doctors">
              {(doctors.data ?? [])
                .filter((item) => !waitlistEntry || item.id === waitlistEntry.doctorId)
                .map((item) => (
                  <label
                    className={`booking-doctor-option ${doctorId === item.id ? 'selected' : ''}`}
                    key={item.id}
                  >
                    <input
                      type="radio"
                      name="doctor"
                      value={item.id}
                      checked={doctorId === item.id}
                      disabled={!!waitlistEntry}
                      onChange={() => {
                        setDoctorId(item.id);
                        setTime('');
                      }}
                    />
                    <Avatar name={item.name} color={item.color} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.specialties.join(' · ')}</small>
                    </span>
                    <strong>{money(item.fee)}</strong>
                  </label>
                ))}
            </div>
            {!doctors.data?.length && (
              <EmptyState
                title="No doctors available yet"
                description="Contact the clinic to arrange your visit."
              />
            )}
          </Card>
          <Card>
            <h2 className="section-title">02 / A convenient time</h2>
            <Field label="Appointment date">
              <input
                className="input"
                type="date"
                value={date}
                min={
                  waitlistEntry && waitlistEntry.startDate > today()
                    ? waitlistEntry.startDate
                    : today()
                }
                max={waitlistEntry ? waitlistEntry.endDate : dateAfter(180)}
                required
                onChange={(event) => {
                  setDate(event.target.value);
                  setTime('');
                }}
              />
            </Field>
            <p className="slot-label">
              Available start times <span className="muted">· Asia/Kolkata</span>
            </p>
            {slots.loading ? (
              <Loading />
            ) : slots.error && doctorId ? (
              <ErrorState message={slots.error} retry={slots.reload} />
            ) : availableSlots.length ? (
              <div className="time-slots" role="group" aria-label="Available appointment times">
                {availableSlots.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    className={`time-slot ${time === slot ? 'selected' : ''}`}
                    aria-pressed={time === slot}
                    onClick={() => setTime(slot)}
                  >
                    {slot}
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No slots on this date"
                description={
                  waitlistEntry
                    ? 'Try another date within your requested range. Your request remains waiting until an appointment is confirmed.'
                    : 'Try another day or dermatologist, or join the waitlist below with a preferred date range.'
                }
              />
            )}
          </Card>
          <Card>
            <h2 className="section-title">03 / Your visit</h2>
            <div className="form-grid">
              <Field label="Consultation mode">
                <select
                  className="select"
                  value={mode}
                  disabled={!!appointmentId || !!waitlistEntry}
                  onChange={(event) => {
                    setMode(event.target.value as typeof mode);
                    setTime('');
                  }}
                >
                  <option value="in-person">In person at the clinic</option>
                  <option value="online">Online consultation</option>
                </select>
              </Field>
              <Field
                label="Main reason for your visit"
                hint="A short description helps your clinic prepare."
              >
                <textarea
                  className="textarea"
                  rows={3}
                  required
                  minLength={3}
                  maxLength={300}
                  disabled={!!appointmentId}
                  value={reason}
                  placeholder="For example, a follow-up for an ongoing skin concern"
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
            </div>
            {mode === 'online' && (
              <div className="notice">
                The clinic will coordinate your online consultation details. Video calls are not
                hosted inside this platform.
              </div>
            )}
          </Card>
        </div>
        <aside>
          <Card className="booking-summary">
            <span className="eyebrow">YOUR APPOINTMENT</span>
            <h2>{doctor?.name ?? 'Choose a dermatologist'}</h2>
            <p className="muted">{doctor?.qualifications}</p>
            <div className="summary-lines">
              <div>
                <span>Date</span>
                <strong>{date ? formatDate(date) : 'Choose a date'}</strong>
              </div>
              <div>
                <span>Time</span>
                <strong>{time || 'Choose a time'}</strong>
              </div>
              <div>
                <span>Visit</span>
                <strong>{mode === 'online' ? 'Online' : 'In person'}</strong>
              </div>
              <div>
                <span>Duration</span>
                <strong>{doctor?.appointmentDurationMinutes || 30} minutes</strong>
              </div>
              <div className="summary-total">
                <span>Consultation fee</span>
                <strong>{doctor ? money(doctor.fee) : '—'}</strong>
              </div>
            </div>
            <p className="small muted">
              Your slot is reserved when you confirm. Payment is arranged with the clinic.
            </p>
            {error && (
              <div className="notice notice-error" role="alert">
                {error}
              </div>
            )}
            <button
              className="button button-primary full-width"
              type="submit"
              disabled={
                busy ||
                slots.loading ||
                !!slots.error ||
                !doctorId ||
                !time ||
                !availableSlots.includes(time)
              }
            >
              {busy
                ? 'Saving your visit…'
                : appointmentId
                  ? 'Confirm new time'
                  : 'Confirm appointment'}
              <ArrowRight size={17} />
            </button>
            <Link to="/my-care" className="button button-ghost full-width">
              Back to my care
            </Link>
            {!appointmentId && !waitlistEntry && (
              <div className="booking-waitlist-alternative">
                <h3>Need a different time?</h3>
                <p>
                  Share a preferred date range with the clinic. Joining the waitlist does not hold
                  an appointment or send email or SMS.
                </p>
                <button
                  type="button"
                  className="button button-secondary full-width"
                  disabled={!doctorId}
                  onClick={() => setJoinWaitlist(true)}
                >
                  Join waitlist
                </button>
              </div>
            )}
          </Card>
        </aside>
      </form>
      {joinWaitlist && (
        <WaitlistJoinModal
          doctorId={doctorId}
          mode={mode}
          startDate={date}
          reason={reason}
          onClose={() => setJoinWaitlist(false)}
          onCreated={(entry) => {
            setJoinWaitlist(false);
            setWaitlistCreated(entry);
          }}
        />
      )}
    </div>
  );
}

const intakeSections = ['Your concern', 'Your history', 'Your priorities', 'Review & share'];
const intakeLabels: Record<string, string> = {
  concern: 'Main concern',
  location: 'Area affected',
  duration: 'How long it has been present',
  symptoms: 'What you have noticed',
  triggers: 'Possible triggers',
  previousTreatment: 'Previous treatments',
  medications: 'Current medicines or supplements',
  allergies: 'Allergies or sensitivities',
  goals: 'What matters to you',
};
export function IntakePage() {
  const { session } = useSession();
  const settings = useResource<ClinicSettings>('/api/settings');
  if (!session?.user) return <Navigate to="/login?next=%2Fintake" replace />;
  if (session.user.role !== 'patient')
    return (
      <EmptyState
        title="Patient preparation"
        description="Patients can prepare their history here. You can review their completed intake in the clinic patient record."
        action={
          <Link className="button button-primary" to="/clinic/patients">
            Open patient records
          </Link>
        }
      />
    );
  if (settings.loading) return <Loading />;
  if (settings.error) return <ErrorState message={settings.error} retry={settings.reload} />;
  if (!settings.data?.modules.intake)
    return (
      <EmptyState
        title="Intake is not enabled"
        description="You can share your history with your dermatologist during your visit."
        action={
          <Link to="/book" className="button button-primary">
            Book a visit
          </Link>
        }
      />
    );
  return <IntakeForm />;
}

function IntakeForm() {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState({
    concern: '',
    location: '',
    duration: '',
    symptoms: '',
    triggers: '',
    previousTreatment: '',
    medications: '',
    allergies: '',
    goals: '',
  });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step > 0) heading.current?.focus();
  }, [step]);
  const update = (key: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  async function next(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (step < 3) {
      setStep((current) => current + 1);
      return;
    }
    setBusy(true);
    try {
      await api<Intake>('/api/intakes', { method: 'POST', body: { ...values, consent } });
      setSaved(true);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  if (saved)
    return (
      <div className="booking-success">
        <div className="success-mark">
          <CheckCircle2 size={35} />
        </div>
        <h1>Your story is ready.</h1>
        <p className="muted">
          Your summary is saved to your record for your dermatologist to review.
        </p>
        <Card>
          <h3>{values.concern}</h3>
          <p>
            {values.location} · {values.duration}
          </p>
          <p className="muted">
            {values.goals || 'You can discuss your priorities at your visit.'}
          </p>
        </Card>
        <div className="row">
          <Link to="/book" className="button button-primary">
            Find an appointment <ArrowRight size={17} />
          </Link>
          <Link to="/my-care/record" className="button button-secondary">
            View my record
          </Link>
        </div>
      </div>
    );
  return (
    <div className="intake-page">
      <PageHeader
        eyebrow="BEFORE YOUR VISIT"
        title="Tell us your story"
        description="Take a few minutes to gather your history. Your dermatologist will review it with you."
      />
      <div className="intake-layout">
        <aside>
          <ol className="intake-steps">
            {intakeSections.map((label, index) => (
              <li
                key={label}
                className={index === step ? 'current' : index < step ? 'complete' : ''}
                aria-current={index === step ? 'step' : undefined}
              >
                <span>{index < step ? <Check size={15} /> : index + 1}</span>
                <div>
                  {label}
                  <small>
                    {index === step ? 'You’re here' : index < step ? 'Completed' : 'Up next'}
                  </small>
                </div>
              </li>
            ))}
          </ol>
          <div className="intake-privacy">
            <ShieldCheck size={22} />
            <strong>A clearer conversation</strong>
            <p>
              This questionnaire organizes what you share. It does not generate a diagnosis or
              recommend treatment.
            </p>
          </div>
        </aside>
        <Card>
          <form onSubmit={next} className="stack">
            <div>
              <span className="eyebrow">STEP {step + 1} OF 4</span>
              <h2 ref={heading} tabIndex={-1}>
                {intakeSections[step]}
              </h2>
            </div>
            {step === 0 && (
              <>
                <Field label="What would you like help with?">
                  <input
                    className="input"
                    required
                    minLength={3}
                    maxLength={200}
                    placeholder="Describe your main skin, hair, or nail concern"
                    value={values.concern}
                    onChange={(event) => update('concern', event.target.value)}
                  />
                </Field>
                <div className="form-grid">
                  <Field label="Which areas are affected?">
                    <input
                      className="input"
                      required
                      maxLength={300}
                      placeholder="For example, hands and arms"
                      value={values.location}
                      onChange={(event) => update('location', event.target.value)}
                    />
                  </Field>
                  <Field label="How long has this been present?">
                    <input
                      className="input"
                      required
                      maxLength={200}
                      placeholder="For example, about three weeks"
                      value={values.duration}
                      onChange={(event) => update('duration', event.target.value)}
                    />
                  </Field>
                </div>
                <Field label="What changes or symptoms have you noticed?">
                  <textarea
                    className="textarea"
                    rows={4}
                    maxLength={2000}
                    required
                    placeholder="Use your own words. Include how the concern has changed over time."
                    value={values.symptoms}
                    onChange={(event) => update('symptoms', event.target.value)}
                  />
                </Field>
                <Field
                  label="Have you noticed any triggers?"
                  hint="Optional. You can write ‘not sure’."
                >
                  <input
                    className="input"
                    maxLength={1000}
                    value={values.triggers}
                    onChange={(event) => update('triggers', event.target.value)}
                  />
                </Field>
              </>
            )}
            {step === 1 && (
              <>
                <p className="muted">
                  Sharing what you have already tried helps your dermatologist understand the full
                  picture.
                </p>
                <Field label="Previous treatments or similar episodes">
                  <textarea
                    className="textarea"
                    rows={4}
                    maxLength={2000}
                    placeholder="Include products, prescriptions, tests, or earlier episodes. Write ‘none’ if there are none."
                    value={values.previousTreatment}
                    onChange={(event) => update('previousTreatment', event.target.value)}
                  />
                </Field>
                <Field label="Current medicines or supplements">
                  <textarea
                    className="textarea"
                    rows={3}
                    maxLength={2000}
                    placeholder="Names and frequency, if known. You can also bring a list to your visit."
                    value={values.medications}
                    onChange={(event) => update('medications', event.target.value)}
                  />
                </Field>
                <Field label="Known allergies or sensitivities">
                  <input
                    className="input"
                    maxLength={1000}
                    placeholder="If none are known, please say so"
                    value={values.allergies}
                    onChange={(event) => update('allergies', event.target.value)}
                  />
                </Field>
              </>
            )}
            {step === 2 && (
              <>
                <div className="intake-prompt">
                  <HeartHandshake size={30} />
                  <h3>What would make this visit helpful?</h3>
                  <p>Your priorities belong in the conversation.</p>
                </div>
                <Field label="Questions, concerns, or goals for your dermatologist">
                  <textarea
                    className="textarea"
                    rows={6}
                    maxLength={2000}
                    placeholder="For example, understanding my condition, discussing a treatment I have tried, or building a routine that fits my day."
                    value={values.goals}
                    onChange={(event) => update('goals', event.target.value)}
                  />
                </Field>
                <div className="notice">
                  Your answers are saved only after you choose “Share with my clinic” on the next
                  step.
                </div>
              </>
            )}
            {step === 3 && (
              <>
                <p className="muted">
                  Here is the summary your dermatologist will see. Go back to change anything before
                  sharing.
                </p>
                <dl className="intake-summary">
                  {Object.entries(values).map(([key, value]) => (
                    <div key={key}>
                      <dt>{intakeLabels[key]}</dt>
                      <dd>{value || 'Not provided'}</dd>
                    </div>
                  ))}
                </dl>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    required
                    checked={consent}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  <span>
                    I agree to share these answers with my clinic for care and have checked that
                    they reflect my history.
                  </span>
                </label>
              </>
            )}
            {error && (
              <div className="notice notice-error" role="alert">
                {error}
              </div>
            )}
            <div className="row between intake-navigation">
              {step > 0 ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setStep((current) => current - 1)}
                >
                  <ChevronLeft size={16} /> Back
                </button>
              ) : (
                <Link to="/my-care" className="button button-ghost">
                  Return to my care
                </Link>
              )}
              <button className="button button-primary" disabled={busy}>
                {busy ? 'Sharing…' : step === 3 ? 'Share with my clinic' : 'Continue'}
                <ChevronRight size={17} />
              </button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}

export function MyCarePage() {
  const { session } = useSession();
  if (!session?.user) return <Navigate to="/login?next=%2Fmy-care" replace />;
  if (session.user.role !== 'patient' || !session.user.patientId)
    return <Navigate to="/clinic" replace />;
  return <PatientCare patientId={session.user.patientId} name={session.user.name} />;
}

function PatientCare({ patientId, name }: { patientId: string; name: string }) {
  const record = useResource<PatientRecord>(`/api/patients/${patientId}`);
  const settings = useResource<ClinicSettings>('/api/settings');
  const toast = useToast();
  const [checkIn, setCheckIn] = useState<CarePlan | null>(null);
  const [cancel, setCancel] = useState<Appointment | null>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const selectedPlanId = params.get('plan');
  const [showCompleted, setShowCompleted] = useState(false);
  const activePlans =
    record.data?.carePlans.filter((plan) => effectivePlanStatus(plan) === 'active') ?? [];
  const completedPlans =
    record.data?.carePlans.filter((plan) => effectivePlanStatus(plan) === 'completed') ?? [];
  useEffect(() => {
    if (
      record.data?.carePlans.some(
        (plan) => plan.id === selectedPlanId && effectivePlanStatus(plan) === 'completed',
      )
    ) {
      setShowCompleted(true);
    }
  }, [selectedPlanId, record.data]);
  const upcoming =
    record.data?.appointments
      .filter(
        (appointment) =>
          appointment.date >= today() &&
          !['cancelled', 'completed', 'no-show'].includes(appointment.status),
      )
      .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)) ?? [];
  async function cancelVisit() {
    if (!cancel) return;
    setBusy(true);
    try {
      await api(`/api/appointments/${cancel.id}`, {
        method: 'PATCH',
        body: { status: 'cancelled' },
      });
      setCancel(null);
      record.reload();
      toast('Appointment cancelled.');
    } catch (problem) {
      toast(errorMessage(problem), 'error');
    } finally {
      setBusy(false);
    }
  }
  if (record.loading) return <Loading />;
  if (record.error) return <ErrorState message={record.error} retry={record.reload} />;
  return (
    <div className="patient-care-page">
      <PageHeader
        eyebrow="YOUR CARE, ALL TOGETHER"
        title={`Hello, ${name.split(' ')[0]}.`}
        description="A little consistency. A little support. Your next step is right here."
        actions={
          <Link to="/book" className="button button-primary">
            <Plus size={17} /> Book a visit
          </Link>
        }
      />
      <div className="patient-welcome-banner">
        <div>
          <span className="eyebrow">ONE DAY AT A TIME</span>
          <h2>
            Your journey is personal.
            <br />
            Your care should be, too.
          </h2>
          <p>Keep your plan close and your clinic in the loop.</p>
        </div>
        <HeartHandshake size={94} strokeWidth={0.8} />
      </div>
      <div className="patient-content-grid">
        <div className="stack">
          <div className="row between">
            <h2 className="section-title">Your treatment plans</h2>
            <span className="muted small">{activePlans.length} active</span>
          </div>
          {activePlans.length ? (
            activePlans.map((plan) => (
              <CarePlanCard
                key={plan.id}
                plan={plan}
                checkIns={
                  record.data?.checkIns.filter((value) => value.carePlanId === plan.id) ?? []
                }
                onCheckIn={
                  settings.data?.modules.followUp &&
                  plan.startDate <= today() &&
                  plan.endDate >= today()
                    ? () => setCheckIn(plan)
                    : undefined
                }
              />
            ))
          ) : (
            <Card>
              <EmptyState
                title={
                  completedPlans.length ? 'No active treatment plans' : 'A plan built around you'
                }
                description={
                  completedPlans.length
                    ? 'Your completed plans and shared reviews remain available below.'
                    : 'After your consultation, your clinician’s treatment plan and follow-up instructions will appear here.'
                }
                action={
                  <Link to="/book" className="button button-secondary">
                    {completedPlans.length ? 'Book a visit' : 'Book your first visit'}
                  </Link>
                }
              />
            </Card>
          )}
          {completedPlans.length > 0 && (
            <section className="patient-completed-plans" aria-label="Completed treatment plans">
              <div className="patient-completed-plans-heading">
                <h2>
                  Completed plans <span className="muted small">({completedPlans.length})</span>
                </h2>
                <button
                  className="button button-ghost button-small"
                  aria-expanded={showCompleted}
                  aria-controls="completed-patient-plans"
                  onClick={() => setShowCompleted((value) => !value)}
                >
                  {showCompleted ? 'Hide completed plans' : 'Show completed plans'}
                </button>
              </div>
              <div id="completed-patient-plans" className="stack" hidden={!showCompleted}>
                {showCompleted &&
                  completedPlans.map((plan) => (
                    <CarePlanCard
                      key={plan.id}
                      plan={plan}
                      checkIns={
                        record.data?.checkIns.filter((value) => value.carePlanId === plan.id) ?? []
                      }
                    />
                  ))}
              </div>
            </section>
          )}
        </div>
        <aside className="stack">
          <Card>
            <div className="row between">
              <h2 className="section-title">Your next visits</h2>
              <CalendarDays size={20} />
            </div>
            {upcoming.length ? (
              <div className="upcoming-visits">
                {upcoming.map((appointment) => (
                  <div className="upcoming-visit" key={appointment.id}>
                    <div className="visit-date">
                      <strong>{new Date(`${appointment.date}T12:00:00`).getDate()}</strong>
                      <span>
                        {new Date(`${appointment.date}T12:00:00`).toLocaleDateString('en-IN', {
                          month: 'short',
                        })}
                      </span>
                    </div>
                    <div>
                      <h3>{appointment.doctorName}</h3>
                      <p>
                        {formatDate(appointment.date)} · {appointment.time} IST
                      </p>
                      <p className="muted">
                        {appointment.mode === 'online'
                          ? 'Online consultation'
                          : 'In-person consultation'}
                      </p>
                      <Badge>{readableStatus(appointment.status)}</Badge>
                      <div className="appointment-actions">
                        <a href={`/api/appointments/${appointment.id}/calendar`} download>
                          Add to calendar
                        </a>
                        {appointment.status === 'scheduled' && (
                          <>
                            <Link to={`/book?appointmentId=${appointment.id}`}>Reschedule</Link>
                            <button onClick={() => setCancel(appointment)}>Cancel</button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
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
          <PatientWaitlistPanel />
          {settings.data?.modules.intake && (
            <Card className="preparation-card">
              <FileText size={25} />
              <h3>A more prepared visit</h3>
              <p className="muted">
                Capture your concerns, history, and questions before you arrive.
              </p>
              <Link to="/intake" className="text-link">
                Prepare your history <ArrowRight size={15} />
              </Link>
            </Card>
          )}
          {settings.data?.modules.followUp && (
            <Card>
              <MessageCircle size={25} />
              <h3>Keep the conversation going</h3>
              <p className="muted">
                Send a question or update directly to your clinic’s care inbox.
              </p>
              <Link to="/my-care/messages" className="text-link">
                Message your clinic <ArrowRight size={15} />
              </Link>
            </Card>
          )}
          <Link to="/my-care/record" className="button button-secondary">
            <FileText size={17} /> View your full record
          </Link>
          <Link to="/my-care/details" className="button button-secondary">
            <ShieldCheck size={17} /> View patient details
          </Link>
          <Link to="/my-care/summary" className="button button-secondary">
            <FileText size={17} /> View care summary
          </Link>
        </aside>
      </div>
      {checkIn && (
        <CheckInModal
          plan={checkIn}
          existing={record.data?.checkIns.find(
            (value) => value.carePlanId === checkIn.id && value.date === today(),
          )}
          onClose={() => setCheckIn(null)}
          onSave={() => {
            setCheckIn(null);
            record.reload();
          }}
        />
      )}
      {cancel && (
        <Modal title="Cancel this appointment?" onClose={() => setCancel(null)}>
          <p>
            Your visit with {cancel.doctorName} on {formatDate(cancel.date)} at {cancel.time} will
            be cancelled.
          </p>
          <p className="muted">You can book a new time when you are ready.</p>
          <div className="row">
            <button className="button button-secondary" onClick={() => setCancel(null)}>
              Keep appointment
            </button>
            <button className="button button-primary" disabled={busy} onClick={cancelVisit}>
              {busy ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CarePlanCard({
  plan,
  checkIns,
  onCheckIn,
}: {
  plan: CarePlan;
  checkIns: CheckIn[];
  onCheckIn?: () => void;
}) {
  const todaysCheckIn = checkIns.find((value) => value.date === today());
  const [params] = useSearchParams();
  const selected = params.get('plan') === plan.id;
  const anchor = useRef<HTMLDivElement>(null);
  const status = effectivePlanStatus(plan);
  const reviewDate = effectiveReviewDate(plan);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      anchor.current?.focus({ preventScroll: true });
      anchor.current?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  return (
    <div
      ref={anchor}
      id={`care-plan-${plan.id}`}
      className={`patient-plan-anchor${selected ? ' patient-plan-target' : ''}`}
      tabIndex={-1}
      role="region"
      aria-label={`${plan.title} treatment plan`}
    >
      <Card className="care-plan-card">
        <div className="row between">
          <div>
            <span className="eyebrow">YOUR CLINICIAN’S PLAN</span>
            <h2>{plan.title}</h2>
          </div>
          <Badge>{status}</Badge>
        </div>
        <p className="muted">
          {plan.doctorName ? `${plan.doctorName} · ` : ''}
          {formatDate(plan.startDate)} – {formatDate(plan.endDate)}
        </p>
        <p className="pre-line">{plan.instructions}</p>
        {plan.medications.length > 0 && (
          <div className="medication-list">
            {plan.medications.map((medication, index) => (
              <div className="medication-item" key={`${medication.name}-${index}`}>
                <div className="medication-number">{index + 1}</div>
                <div>
                  <h3>{medication.name}</h3>
                  <p>{medication.instructions}</p>
                  <div className="row">
                    <span className="pill">{medication.schedule}</span>
                    <span className="muted small">{medication.duration}</span>
                  </div>
                  {medication.warnings && (
                    <p className="medication-warning">
                      Clinician’s precautions: {medication.warnings}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {plan.expectations && (
          <div className="care-plan-note">
            <strong>What to expect</strong>
            <p>{plan.expectations}</p>
          </div>
        )}
        {plan.warnings && (
          <div className="notice">
            <strong>Important instructions from your clinician</strong>
            <p>{plan.warnings}</p>
          </div>
        )}
        <div className="plan-facts">
          {reviewDate && (
            <div>
              <CalendarDays size={18} />
              <span>
                Follow-up requested<strong>{formatDate(reviewDate)}</strong>
              </span>
              <Link to={`/book?doctor=${plan.doctorId}`}>Book</Link>
            </div>
          )}
          {plan.cost && (
            <div>
              <span>
                Estimated treatment cost<strong>{plan.cost}</strong>
              </span>
            </div>
          )}
        </div>
        <PatientFollowUp plan={plan} />
        {onCheckIn && status === 'active' && (
          <div className="plan-check-in">
            <div>
              <strong>
                {todaysCheckIn ? 'Today’s check-in is saved' : 'How is your plan going today?'}
              </strong>
              <p>
                {todaysCheckIn
                  ? `Reported: ${todaysCheckIn.adherence === 'taken' ? 'followed the plan' : todaysCheckIn.adherence === 'partial' ? 'partly followed' : 'missed the plan'} · feeling ${todaysCheckIn.feeling}`
                  : 'A quick update helps your clinic see your experience.'}
              </p>
            </div>
            <button className="button button-secondary" onClick={onCheckIn}>
              {todaysCheckIn ? 'Update check-in' : 'Daily check-in'} <ArrowRight size={15} />
            </button>
          </div>
        )}
        {checkIns.length > 0 && (
          <div className="check-in-week" aria-label="Your recent reported check-ins">
            {Array.from({ length: 7 }, (_, index) => dateAfter(index - 6)).map((date) => {
              const entry = checkIns.find((value) => value.date === date);
              return (
                <div key={date} title={`${formatDate(date)}: ${entry?.adherence ?? 'No check-in'}`}>
                  <span className={`check-in-dot ${entry?.adherence ?? ''}`}>
                    {entry?.adherence === 'taken' ? (
                      <Check size={13} />
                    ) : entry?.adherence === 'missed' ? (
                      <X size={12} />
                    ) : entry?.adherence === 'partial' ? (
                      '–'
                    ) : (
                      '·'
                    )}
                  </span>
                  <small>
                    {new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}
                  </small>
                </div>
              );
            })}
            <p className="muted small">
              Your reported routine
              <br />
              No clinical score is inferred.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function CheckInModal({
  plan,
  existing,
  onClose,
  onSave,
}: {
  plan: CarePlan;
  existing?: CheckIn;
  onClose: () => void;
  onSave: () => void;
}) {
  const [adherence, setAdherence] = useState<CheckIn['adherence']>(existing?.adherence ?? 'taken');
  const [feeling, setFeeling] = useState<CheckIn['feeling']>(existing?.feeling ?? 'same');
  const [note, setNote] = useState(existing?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/check-ins', {
        method: 'POST',
        body: { carePlanId: plan.id, date: today(), adherence, feeling, note },
      });
      toast('Your check-in has been saved.');
      onSave();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Your daily check-in" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">
          {plan.title} · {formatDate(today())}
        </p>
        <Field label="How did your routine go today?">
          <select
            className="select"
            value={adherence}
            onChange={(event) => setAdherence(event.target.value as typeof adherence)}
          >
            <option value="taken">I followed my plan</option>
            <option value="partial">I followed part of my plan</option>
            <option value="missed">I missed my plan today</option>
          </select>
        </Field>
        <Field label="How are you feeling compared with before?">
          <select
            className="select"
            value={feeling}
            onChange={(event) => setFeeling(event.target.value as typeof feeling)}
          >
            <option value="better">Better</option>
            <option value="same">About the same</option>
            <option value="worse">Worse</option>
          </select>
        </Field>
        <Field
          label="Anything you want your clinic to know?"
          hint="Optional. This is your own report, not a clinical assessment."
        >
          <textarea
            className="textarea"
            rows={3}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="How your day went, questions, or changes you noticed"
          />
        </Field>
        {(feeling === 'worse' || adherence !== 'taken') && (
          <div className="notice">
            For questions about symptoms or changing your treatment, contact your clinician.
            Check-ins do not change your prescribed plan.
          </div>
        )}
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <button className="button button-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save check-in'}
          <Check size={17} />
        </button>
      </form>
    </Modal>
  );
}

export function MyRecordPage() {
  const { session } = useSession();
  if (!session?.user) return <Navigate to="/login?next=%2Fmy-care%2Frecord" replace />;
  if (session.user.role !== 'patient' || !session.user.patientId)
    return <Navigate to="/clinic/patients" replace />;
  return <PatientRecordView patientId={session.user.patientId} />;
}

function PatientRecordView({ patientId }: { patientId: string }) {
  const record = useResource<PatientRecord>(`/api/patients/${patientId}`);
  const settings = useResource<ClinicSettings>('/api/settings');
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab') ?? 'timeline';
  const aliases: Record<string, string> = {
    careplans: 'plans',
    'care-plans': 'plans',
    reports: 'images',
    investigations: 'workflows',
    procedures: 'workflows',
  };
  const normalizedTab = aliases[requestedTab] ?? requestedTab;
  const tab = ['timeline', 'plans', 'workflows', 'history', 'images', 'visits'].includes(
    normalizedTab,
  )
    ? normalizedTab
    : 'timeline';
  function setTab(value: string) {
    const next = new URLSearchParams(params);
    next.set('tab', value);
    next.delete('image');
    setParams(next, { replace: true });
  }
  const selectedImageId = params.get('image');
  const viewedImage =
    tab === 'images'
      ? record.data?.images.find((image) => image.id === selectedImageId)
      : undefined;
  function openImage(image: ClinicalImage) {
    const next = new URLSearchParams(params);
    next.set('tab', 'images');
    next.set('image', image.id);
    setParams(next, { replace: true });
  }
  function closeImage() {
    const next = new URLSearchParams(params);
    next.delete('image');
    setParams(next, { replace: true });
  }
  const [upload, setUpload] = useState(false);
  const [compare, setCompare] = useState(false);
  const [firstImage, setFirstImage] = useState('');
  const [secondImage, setSecondImage] = useState('');
  if (record.loading) return <Loading />;
  if (record.error || !record.data)
    return (
      <ErrorState
        message={record.error || 'Your record could not be loaded.'}
        retry={record.reload}
      />
    );
  const data = record.data;
  const clinicalImages = data.images.filter((value) => value.category === 'clinical');
  const selectedFirst =
    clinicalImages.find((value) => value.id === firstImage) ?? clinicalImages[0];
  const selectedSecond =
    clinicalImages.find((value) => value.id === secondImage) ?? clinicalImages[1];
  const sections = [
    ['timeline', 'Care timeline'],
    ['plans', 'Treatment plans'],
    ['workflows', 'Tests & procedures'],
    ['history', 'Shared history'],
    ['images', 'Images & reports'],
    ['visits', 'All appointments'],
  ];
  const timeline = [
    ...data.intakes.map((entry) => ({
      id: entry.id,
      date: entry.createdAt,
      label: 'History shared',
      title: entry.concern,
      content: `${entry.location} · ${entry.duration}`,
      detail: entry.symptoms,
      type: 'intake',
    })),
    ...data.encounters.map((entry) => ({
      id: entry.id,
      date: entry.createdAt,
      label: `Consultation · ${entry.doctorName}`,
      title: entry.assessment || 'Consultation recorded',
      content: entry.plan,
      detail: entry.investigations ? `Investigations: ${entry.investigations}` : '',
      type: 'encounter',
    })),
    ...data.carePlans.map((entry) => ({
      id: entry.id,
      date: entry.createdAt,
      label: 'Treatment plan',
      title: entry.title,
      content: entry.instructions,
      detail: entry.followUpDate ? `Follow-up requested for ${formatDate(entry.followUpDate)}` : '',
      type: 'plan',
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <div>
      <PageHeader
        eyebrow="YOUR STORY, OVER TIME"
        title="My health record"
        description="Your visits, shared history, and documents in one place."
        actions={
          <>
            <Link to="/my-care/summary" className="button button-primary">
              <FileText size={17} />
              View care summary
            </Link>
            <button className="button button-secondary" onClick={() => window.print()}>
              <FileText size={17} /> Print record
            </button>
          </>
        }
      />
      <Card className="patient-record-profile">
        <Avatar name={data.patient.name} />
        <div>
          <h2>{data.patient.name}</h2>
          <p className="muted">
            {data.patient.email} · {data.patient.phone}
          </p>
          <Link to="/my-care/details" className="text-link">
            Review patient details & allergy history
          </Link>
        </div>
        <div className="patient-allergies">
          <span className="small muted">Current allergy record</span>
          <strong>
            {data.patient.allergyStatus === 'none-known'
              ? 'No known allergies recorded'
              : data.patient.allergyStatus === 'not-recorded'
                ? 'Not recorded'
                : data.patient.allergies || 'Not recorded'}
          </strong>
        </div>
      </Card>
      <div className="record-mobile-section">
        <Field label="Record section">
          <select value={tab} onChange={(event) => setTab(event.target.value)}>
            {sections.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="tabs record-desktop-tabs" role="tablist" aria-label="Health record sections">
        {sections.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={sections.find(([id]) => id === tab)?.[1]}>
        {tab === 'workflows' && <PatientWorkflowPanel patientId={patientId} />}
        {tab === 'timeline' && (
          <Card>
            {timeline.length ? (
              <div className="record-timeline">
                {timeline.map((entry) => (
                  <div className="record-event" key={entry.id}>
                    <div className="record-event-dot">
                      <FileText size={15} />
                    </div>
                    <div>
                      <div className="row between">
                        <span className="eyebrow">{entry.label}</span>
                        <span className="muted small">{formatDate(entry.date.slice(0, 10))}</span>
                      </div>
                      <h3>{entry.title}</h3>
                      <p className="pre-line">{entry.content}</p>
                      {entry.detail && <p className="muted pre-line">{entry.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Your story starts here"
                description="As you share your history and visit your dermatologist, your care timeline will grow."
                action={
                  <Link to="/intake" className="button button-secondary">
                    Prepare your history
                  </Link>
                }
              />
            )}
          </Card>
        )}
        {tab === 'plans' && (
          <div className="stack">
            {data.carePlans.length ? (
              data.carePlans.map((plan) => (
                <CarePlanCard
                  key={plan.id}
                  plan={plan}
                  checkIns={data.checkIns.filter((check) => check.carePlanId === plan.id)}
                />
              ))
            ) : (
              <EmptyState
                title="No treatment plans yet"
                description="Your clinician’s shared plans will appear here after a consultation."
              />
            )}
          </div>
        )}
        {tab === 'history' && (
          <div className="stack">
            {data.intakes.length ? (
              data.intakes.map((entry) => (
                <Card key={entry.id}>
                  <div className="row between">
                    <h3>{entry.concern}</h3>
                    <span className="muted small">
                      Shared {formatDate(entry.createdAt.slice(0, 10))}
                    </span>
                  </div>
                  <dl className="intake-summary">
                    {Object.entries(intakeLabels).map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>{String(entry[key as keyof Intake] || 'Not provided')}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="small muted">
                    <ShieldCheck size={14} /> Shared with your care team with your agreement.
                  </div>
                </Card>
              ))
            ) : (
              <EmptyState
                title="No history shared yet"
                description="Prepare a summary before your next visit."
                action={
                  <Link to="/intake" className="button button-primary">
                    Share your history
                  </Link>
                }
              />
            )}
          </div>
        )}
        {tab === 'images' && (
          <div className="stack">
            {selectedImageId && !viewedImage && (
              <div className="notice notice-error" role="alert">
                This image is not available in your record.{' '}
                <button className="text-link" onClick={closeImage}>
                  Return to images
                </button>
              </div>
            )}
            <DocumentsPanel patientId={patientId} />
            <Card>
              <div className="row between">
                <div>
                  <h2 className="section-title">Your images & reports</h2>
                  <p className="muted">
                    Visible to you and your clinic for care. Never published to a public profile.
                  </p>
                </div>
                <div className="row">
                  {clinicalImages.length >= 2 && (
                    <button className="button button-secondary" onClick={() => setCompare(true)}>
                      Compare images
                    </button>
                  )}
                  {settings.data?.modules.images && (
                    <button className="button button-primary" onClick={() => setUpload(true)}>
                      <ImagePlus size={17} /> Add image
                    </button>
                  )}
                </div>
              </div>
              {settings.data && !settings.data.modules.images && (
                <div className="notice">
                  Image uploads are paused. Your existing images and reports remain available.
                </div>
              )}
              {data.images.length ? (
                <div className="clinical-image-grid">
                  {data.images.map((item) => (
                    <figure key={item.id}>
                      <button
                        type="button"
                        className="patient-image-preview"
                        aria-haspopup="dialog"
                        aria-label={`View image and shared annotations: ${item.caption || formatDate(item.createdAt)}`}
                        onClick={() => openImage(item)}
                      >
                        <img
                          src={item.url}
                          alt={item.caption || 'Patient clinical image'}
                          loading="lazy"
                        />
                      </button>
                      <figcaption>
                        <strong>{item.caption}</strong>
                        <span>
                          {item.category === 'report' ? 'Report' : 'Clinical image'} ·{' '}
                          {formatDate(item.createdAt.slice(0, 10))}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="A home for your records"
                  description={
                    settings.data?.modules.images
                      ? 'Add a clinical photograph or a photographed report to share securely with your clinic.'
                      : 'There are no images or reports in your record yet.'
                  }
                />
              )}
            </Card>
          </div>
        )}
        {tab === 'visits' && (
          <Card>
            {data.appointments.length ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date & time</th>
                      <th>Dermatologist</th>
                      <th>Visit</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.appointments]
                      .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))
                      .map((appointment) => (
                        <tr key={appointment.id}>
                          <td>
                            {formatDate(appointment.date)}
                            <span className="table-subline">{appointment.time} IST</span>
                          </td>
                          <td>{appointment.doctorName}</td>
                          <td>
                            {appointment.reason}
                            <span className="table-subline">
                              {appointment.mode === 'online' ? 'Online' : 'In person'}
                            </span>
                          </td>
                          <td>
                            <Badge>{readableStatus(appointment.status)}</Badge>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title="No appointments yet"
                action={
                  <Link to="/book" className="button button-primary">
                    Book an appointment
                  </Link>
                }
              />
            )}
          </Card>
        )}
      </div>
      {viewedImage && (
        <Modal title="Image details" onClose={closeImage}>
          <ImageAnnotationViewer image={viewedImage} enabled={settings.data?.modules.images} />
        </Modal>
      )}
      {upload && settings.data?.modules.images && (
        <UploadModal
          patientId={patientId}
          onClose={() => setUpload(false)}
          onSave={() => {
            setUpload(false);
            record.reload();
          }}
        />
      )}
      {compare && (
        <Modal title="Compare your clinical images" onClose={() => setCompare(false)}>
          <p className="muted">
            Lighting, distance, and camera angle can differ. Your clinician will assess any changes.
          </p>
          <div className="image-comparison">
            {[
              {
                image: selectedFirst,
                value: firstImage || selectedFirst?.id,
                update: setFirstImage,
                label: 'First image',
              },
              {
                image: selectedSecond,
                value: secondImage || selectedSecond?.id,
                update: setSecondImage,
                label: 'Second image',
              },
            ].map(({ image, value, update, label }) => (
              <div key={label}>
                <Field label={label}>
                  <select
                    className="select"
                    value={value}
                    onChange={(event) => update(event.target.value)}
                  >
                    {clinicalImages.map((item) => (
                      <option key={item.id} value={item.id}>
                        {formatDate(item.createdAt.slice(0, 10))} · {item.caption}
                      </option>
                    ))}
                  </select>
                </Field>
                {image && <img src={image.url} alt={image.caption} />}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function UploadModal({
  patientId,
  onClose,
  onSave,
}: {
  patientId: string;
  onClose: () => void;
  onSave: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [category, setCategory] = useState<'clinical' | 'report'>('clinical');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!file) {
      setError('Choose an image to upload.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Choose an image smaller than 5 MB.');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Please choose a JPEG, PNG, or WebP image.');
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('The image could not be read.'));
        reader.readAsDataURL(file);
      });
      await api('/api/images', {
        method: 'POST',
        body: { patientId, caption, category, consent, dataUrl },
      });
      toast('Image securely added to your record.');
      onSave();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add to your health record" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="upload-dropzone">
          <Upload size={26} />
          <strong>Choose a clinical photo or report image</strong>
          <span className="muted small">JPEG, PNG, or WebP · up to 5 MB</span>
          <input
            type="file"
            aria-label="Choose image"
            accept="image/jpeg,image/png,image/webp"
            required
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>
        <Field label="Description">
          <input
            className="input"
            required
            minLength={3}
            maxLength={300}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="For example, left hand before follow-up"
          />
        </Field>
        <Field label="Type of record">
          <select
            className="select"
            value={category}
            onChange={(event) => setCategory(event.target.value as typeof category)}
          >
            <option value="clinical">Clinical photograph</option>
            <option value="report">Photographed investigation report</option>
          </select>
        </Field>
        <label className="checkbox-label">
          <input
            type="checkbox"
            required
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            I agree to share this image with my clinic for my care. This does not authorize
            teaching, research, or public use.
          </span>
        </label>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <button className="button button-primary" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload to my record'}
          <Upload size={16} />
        </button>
      </form>
    </Modal>
  );
}

export function MessagesPage() {
  const { session } = useSession();
  const settings = useResource<ClinicSettings>('/api/settings');
  if (!session?.user) return <Navigate to="/login?next=%2Fmy-care%2Fmessages" replace />;
  if (session.user.role !== 'patient' || !session.user.patientId)
    return <Navigate to="/clinic/follow-ups" replace />;
  if (settings.loading) return <Loading />;
  if (settings.error) return <ErrorState message={settings.error} retry={settings.reload} />;
  return <PatientMessages patientId={session.user.patientId} settings={settings.data!} />;
}

function PatientMessages({ patientId, settings }: { patientId: string; settings: ClinicSettings }) {
  const messages = useResource<Message[]>(`/api/messages?patientId=${patientId}`);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/messages', { method: 'POST', body: { patientId, body: body.trim() } });
      setBody('');
      messages.reload();
      toast('Message saved to your clinic’s inbox.');
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="patient-messages-page">
      <PageHeader
        eyebrow="BETWEEN VISITS"
        title="A conversation with your clinic"
        description="Share a question, an update, or something you want to discuss at your next visit."
      />
      <div className="patient-message-layout">
        <Card>
          <div className="message-thread-header">
            <div className="clinic-message-icon">
              <MessageCircle size={22} />
            </div>
            <div>
              <h3>{settings.name || 'Your care team'}</h3>
              <p className="muted small">Private clinic inbox</p>
            </div>
            <button
              className="button button-ghost button-small"
              onClick={messages.reload}
              disabled={messages.loading}
            >
              Refresh
            </button>
          </div>
          <div className="patient-message-thread" aria-live="polite">
            {messages.loading ? (
              <Loading />
            ) : messages.error ? (
              <ErrorState message={messages.error} retry={messages.reload} />
            ) : messages.data?.length ? (
              [...messages.data]
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .map((message) => (
                  <div
                    className={`patient-message ${message.authorRole === 'patient' ? 'sent' : 'received'}`}
                    key={message.id}
                  >
                    <span className="message-author">
                      {message.authorRole === 'patient' ? 'You' : message.authorName}
                    </span>
                    <div className="message-bubble">{message.body}</div>
                    <span className="message-time">
                      {new Date(message.createdAt).toLocaleString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      IST
                    </span>
                  </div>
                ))
            ) : (
              <EmptyState
                title="You have a place to ask"
                description="Start a conversation with your care team. Your messages stay attached to your care record."
              />
            )}
          </div>
          {settings.modules.followUp ? (
            <form onSubmit={submit} className="message-composer">
              <Field label="Your message">
                <textarea
                  className="textarea"
                  rows={3}
                  required
                  maxLength={2000}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Write a question or update for your clinic…"
                />
              </Field>
              {error && (
                <div role="alert" className="notice notice-error">
                  {error}
                </div>
              )}
              <div className="row between">
                <span className="muted small">{body.length}/2000</span>
                <button className="button button-primary" disabled={busy || !body.trim()}>
                  {busy ? 'Sending…' : 'Send message'}
                  <ArrowUpRight size={17} />
                </button>
              </div>
            </form>
          ) : (
            <div className="notice">
              Messaging is paused. Your existing conversation remains available. Contact the clinic
              directly for new questions.
            </div>
          )}
        </Card>
        <aside className="stack">
          <Card>
            <Clock3 size={24} />
            <h3>Care takes a conversation</h3>
            <p className="muted">
              Messages are stored in your clinic’s inbox for staff to review. This is not live chat
              or an emergency service.
            </p>
            {settings && (
              <>
                <p className="small">{settings.hours}</p>
                <a href={`tel:${settings.phone}`} className="text-link">
                  Call the clinic: {settings.phone}
                </a>
              </>
            )}
          </Card>
          <Card>
            <ShieldCheck size={24} />
            <h3>Your conversation stays private</h3>
            <p className="muted">Only you and authorized clinical staff can read your messages.</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
