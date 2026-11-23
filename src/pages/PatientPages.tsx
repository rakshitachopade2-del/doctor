import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
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
import { PrivateUploadModal } from '../components/PrivateUploadModal';
import { uploadKey } from '../components/private-upload-helpers';
import { DocumentsPanel } from '../components/DocumentsPanel';
import type { IntakeSubmissionCommand } from '../../shared/intake-submission';
import { usePendingCareSubmissions } from '../components/pending-care-submissions';
import {
  confirmedIntake,
  intakeKeys,
  intakeLabels,
  intakeNotSubmitted,
  intakeValues,
  type IntakeValues,
} from '../components/intake-submission-helpers';
import { checkedModules } from '../components/clinic-configuration-helpers';
import { CareMessageComposer } from '../components/CareMessageComposer';
import { checkedMessageSettings, useCareMessages } from '../components/care-message-helpers';
import { PatientWorkflowPanel } from './PatientWorkflowPanel';
import type { WaitlistEntry } from '../../shared/waitlist';
import { PatientWaitlistPanel, WaitlistJoinModal } from '../components/PatientWaitlist';
import { PatientAppointments } from '../components/PatientAppointments';
import { AppointmentRescheduleForm } from '../components/AppointmentRescheduleForm';
import { AppointmentCancellationForm } from '../components/AppointmentCancellationForm';
import type { CancellationAttempt } from '../components/appointment-cancellation-helpers';
import type { AppointmentBookingInput } from '../../shared/appointment-booking';
import {
  appointmentBookingHasChanged,
  isAppointmentBookingNotCreated,
  requestAppointmentBooking,
  useAppointmentBookingData,
  useAppointmentBookingGuard,
  type AppointmentBookingAttempt,
} from '../components/appointment-booking-helpers';
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
const visitInterval = (time: string, durationMinutes: number) => {
  const [hour, minute] = time.split(':').map(Number);
  const end = hour * 60 + minute + durationMinutes;
  return `${time}–${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
};

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
                <Badge tone={doctor.acceptingNewBookings === false ? 'neutral' : 'green'}>
                  {doctor.acceptingNewBookings === false
                    ? 'New bookings paused'
                    : 'Accepting new bookings'}
                </Badge>
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
                  {doctor.acceptingNewBookings === false ? (
                    <p className="doctor-paused-copy">
                      Existing appointments remain booked. Contact the clinic for help.
                    </p>
                  ) : (
                    <Link to={`/book?doctor=${doctor.id}`} className="button button-primary">
                      View availability <ArrowUpRight size={16} />
                    </Link>
                  )}
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
  const location = useLocation();
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
  const appointmentId = params.get('appointmentId');
  if (appointmentId)
    return (
      <div className="booking-page" key={`${session.user.id}:${location.key}:${appointmentId}`}>
        <PageHeader
          eyebrow="REVIEW YOUR NEXT VISIT"
          title="Reschedule your visit"
          description="Choose a new time, then review the current appointment and proposed change before confirming. All times are in Asia/Kolkata."
        />
        <AppointmentRescheduleForm appointmentId={appointmentId} />
        <Link to="/my-care" className="button button-ghost">
          Back to my care
        </Link>
      </div>
    );
  return <BookingForm key={`${session.user.id}:${location.key}`} />;
}

function BookingForm() {
  const { session } = useSession();
  const guard = useAppointmentBookingGuard();
  const [params] = useSearchParams();
  const waitlistId = params.get('waitlist');
  const doctors = useAppointmentBookingData('/api/doctors', (value) => {
    if (!Array.isArray(value)) throw new Error('The doctor list could not be loaded.');
    return value as Doctor[];
  });
  const waitlist = useAppointmentBookingData(waitlistId ? '/api/waitlist' : null, (value) => {
    if (!Array.isArray(value)) throw new Error('Your waiting request could not be loaded.');
    return value as WaitlistEntry[];
  });
  const waitlistEntry = waitlist.data?.find((entry) => entry.id === waitlistId);
  const [doctorId, setDoctorId] = useState(params.get('doctor') ?? '');
  const [date, setDate] = useState(today());
  const [time, setTime] = useState('');
  const [mode, setMode] = useState<'in-person' | 'online'>('in-person');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [booked, setBooked] = useState<Appointment | null>(null);
  const [originalBooking, setOriginalBooking] = useState<Appointment | null>(null);
  const [bookingChanged, setBookingChanged] = useState(false);
  const [attempt, setAttempt] = useState<AppointmentBookingAttempt | null>(null);
  const submitting = useRef(false);
  const locked = busy || !!attempt;
  const [joinWaitlist, setJoinWaitlist] = useState(false);
  const [waitlistCreated, setWaitlistCreated] = useState<WaitlistEntry | null>(null);
  const initializedWaitlist = useRef<string | null>(null);
  useEffect(() => {
    if (waitlistEntry && initializedWaitlist.current !== waitlistEntry.id) {
      initializedWaitlist.current = waitlistEntry.id;
      setDoctorId(waitlistEntry.doctorId);
      setMode(waitlistEntry.mode);
      setDate(waitlistEntry.startDate < today() ? today() : waitlistEntry.startDate);
      setReason(waitlistEntry.reason);
      setTime('');
    }
  }, [waitlistEntry?.id]);
  useEffect(() => {
    if (!waitlistId && !doctorId && doctors.data?.length)
      setDoctorId(doctors.data.find((value) => value.acceptingNewBookings !== false)?.id ?? '');
  }, [doctors.data, doctorId, waitlistId]);
  const doctor = doctors.data?.find((value) => value.id === doctorId);
  const bookingPaused = doctor?.acceptingNewBookings === false;
  const durationMinutes = doctor?.appointmentDurationMinutes ?? 30;
  const slots = useAppointmentBookingData(
    doctorId && date && !bookingPaused
      ? `/api/slots?doctorId=${encodeURIComponent(doctorId)}&date=${encodeURIComponent(date)}&mode=${mode}`
      : null,
    (value) => {
      if (
        !Array.isArray(value) ||
        !value.every((slot) => typeof slot === 'string' && /^\d{2}:\d{2}$/.test(slot))
      )
        throw new Error('Available appointment times could not be loaded.');
      return value as string[];
    },
  );
  const availableSlots = bookingPaused ? [] : [...(slots.data ?? [])];
  availableSlots.sort();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || submitting.current) return;
    if (attempt) {
      await saveBooking(attempt);
      return;
    }
    if (slots.loading) return;
    if (bookingPaused) {
      setError(
        'This doctor is not accepting new bookings. Choose another doctor or contact the clinic.',
      );
      return;
    }
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
    if (!session.user?.patientId) return;
    if (!reason.trim() || reason.trim().length > 300) {
      setError('Enter a reason for your visit using 1 to 300 characters.');
      return;
    }
    const body: AppointmentBookingInput = {
      requestId: crypto.randomUUID(),
      patientId: session.user.patientId,
      doctorId,
      date,
      time,
      mode,
      reason: reason.trim(),
      ...(waitlistId ? { waitlistId, patientConfirmed: true } : {}),
    };
    await saveBooking({ actorId: session.user.id, body });
  }

  async function saveBooking(sent: AppointmentBookingAttempt) {
    const currentRoute = guard();
    const current = () => currentRoute() && session.user?.id === sent.actorId;
    submitting.current = true;
    setAttempt(sent);
    setBusy(true);
    setError('');
    try {
      const result = await requestAppointmentBooking(sent.body, {
        actorId: sent.actorId,
        isCurrent: current,
      });
      if (!current()) return;
      setOriginalBooking(result.booking.appointment);
      setBookingChanged(appointmentBookingHasChanged(result));
      setBooked(result.appointment);
      setAttempt(null);
    } catch (problem) {
      if (!current()) return;
      setError(errorMessage(problem));
      if (isAppointmentBookingNotCreated(problem, sent.body, sent.actorId)) {
        setAttempt(null);
        setTime('');
        void slots.reload();
        void doctors.reload();
        if (waitlistId) void waitlist.reload();
      }
    } finally {
      if (current()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  if ((!attempt && doctors.loading) || (waitlistId && !attempt && waitlist.loading))
    return <Loading />;
  if (!attempt && (doctors.error || (waitlistId && waitlist.error)))
    return (
      <ErrorState
        message={doctors.error || waitlist.error || 'Unable to load appointment.'}
        retry={() => {
          doctors.reload();
          waitlist.reload();
        }}
      />
    );
  if (
    waitlistId &&
    !attempt &&
    !booked &&
    (!waitlistEntry || waitlistEntry.status !== 'waiting' || waitlistEntry.endDate < today())
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
  if (booked)
    return (
      <div className="booking-success">
        <div className="success-mark">
          <CheckCircle2 size={35} />
        </div>
        <span className="eyebrow">BOOKING CONFIRMED</span>
        <h1>{bookingChanged ? 'Your booking is recorded.' : 'You’re booked in.'}</h1>
        <p className="muted">
          {bookingChanged
            ? 'The original booking was saved. The details below show the appointment’s current state after later changes.'
            : 'Your appointment is saved in your care workspace.'}
        </p>
        {waitlistId && (
          <p className="patient-waitlist-help">
            Your waitlist request is now marked booked. You can find it in your request history.
          </p>
        )}
        <Card className="patient-booking-current">
          <h2 className="section-title">Current appointment</h2>
          <Badge>{readableStatus(booked.status)}</Badge>
          <h3>{booked.doctorName}</h3>
          <div className="booking-confirmation-details">
            <span>
              <CalendarDays size={18} />
              {longDate(booked.date)}
            </span>
            <span>
              <Clock3 size={18} />
              {visitInterval(booked.time, booked.durationMinutes ?? 30)} · Asia/Kolkata ·{' '}
              {booked.durationMinutes ?? 30} minutes
            </span>
            <span>
              {booked.mode === 'online' ? <Video size={18} /> : <MapPin size={18} />}
              {booked.durationPolicy === 'custom'
                ? booked.mode === 'online'
                  ? 'Online clinic visit — the clinic will coordinate connection details'
                  : 'In-person clinic visit'
                : booked.mode === 'online'
                  ? 'Online consultation — the clinic will coordinate connection details'
                  : 'In-person consultation'}
            </span>
          </div>
          <p className="muted">
            {booked.durationPolicy === 'custom' ? 'Visit fee' : 'Consultation fee'}:{' '}
            {money(booked.fee)} · Payment is coordinated by the clinic.
          </p>
        </Card>
        {bookingChanged && originalBooking && (
          <details className="patient-booking-original">
            <summary>Original booking confirmation</summary>
            <p>
              {originalBooking.doctorName} · {formatDate(originalBooking.date)} ·{' '}
              {visitInterval(originalBooking.time, originalBooking.durationMinutes ?? 30)} IST
            </p>
            <p>
              {originalBooking.durationMinutes ?? 30} minutes · {money(originalBooking.fee)} ·{' '}
              {originalBooking.mode === 'online' ? 'Online consultation' : 'In-person consultation'}
            </p>
            <p className="muted">
              This records the original confirmation. Use the current appointment details above for
              your visit.
            </p>
          </details>
        )}
        <div className="row">
          <Link to="/my-care" className="button button-primary">
            View my care <ArrowRight size={17} />
          </Link>
          {booked.status === 'scheduled' && (
            <a
              className="button button-secondary"
              href={`/api/appointments/${booked.id}/calendar`}
              download
            >
              Add to calendar
            </a>
          )}
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
        title="Let’s plan your visit"
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
      {doctor?.acceptingNewBookings === false && (
        <section className="notice booking-pause-notice" aria-label="Doctor booking status">
          <strong>New bookings paused</strong>
          <p>
            {attempt
              ? `${doctor.name} is not accepting new bookings. Your submitted request may already be saved. Retry the same request to confirm its outcome before starting another booking.`
              : waitlistEntry
                ? `${doctor.name} is not accepting new bookings. Your waiting request is retained and can still be withdrawn. Contact the clinic for help; no appointment has been reserved.`
                : `${doctor.name} is not accepting new bookings or new waitlist requests. Choose another dermatologist below or contact the clinic. Existing appointments remain booked.`}
          </p>
          {waitlistEntry && (
            <Link
              className="text-link"
              to={`/my-care?waitlist=${encodeURIComponent(waitlistEntry.id)}`}
            >
              View my waitlist requests
            </Link>
          )}
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => void doctors.reload()}
          >
            Refresh booking status
          </button>
        </section>
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
                      disabled={locked || !!waitlistEntry || item.acceptingNewBookings === false}
                      onChange={() => {
                        setDoctorId(item.id);
                        setTime('');
                      }}
                    />
                    <Avatar name={item.name} color={item.color} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.specialties.join(' · ')}</small>
                      {item.acceptingNewBookings === false && (
                        <small className="booking-paused-label">New bookings paused</small>
                      )}
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
            {!!doctors.data?.length &&
              !doctorId &&
              doctors.data.every((item) => item.acceptingNewBookings === false) && (
                <p className="notice">
                  No doctors are accepting new bookings right now. Existing appointments remain
                  booked. Contact the clinic for help.
                </p>
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
                disabled={locked}
                onChange={(event) => {
                  setDate(event.target.value);
                  setTime('');
                }}
              />
            </Field>
            <p className="slot-label">
              Available start times <span className="muted">· Asia/Kolkata</span>
            </p>
            {bookingPaused ? (
              <p className="muted">
                New appointment times are unavailable while this doctor’s new bookings are paused.
              </p>
            ) : slots.loading ? (
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
                    disabled={locked}
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
                  disabled={locked || !!waitlistEntry}
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
                  minLength={1}
                  maxLength={300}
                  disabled={locked}
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
                <strong>{time ? visitInterval(time, durationMinutes) : 'Choose a time'}</strong>
              </div>
              <div>
                <span>Visit</span>
                <strong>{mode === 'online' ? 'Online' : 'In person'}</strong>
              </div>
              <div>
                <span>Duration</span>
                <strong>{durationMinutes} minutes</strong>
              </div>
              <div className="summary-total">
                <span>Consultation fee</span>
                <strong>{doctor ? money(doctor.fee) : '—'}</strong>
              </div>
            </div>
            <p className="small muted">
              {attempt
                ? 'Your submitted details are locked while the booking is checked. Retry the same request to confirm its outcome without making another booking.'
                : 'Your slot is reserved when you confirm. Payment is arranged with the clinic.'}
            </p>
            {attempt && !busy && (
              <div className="notice notice-error patient-booking-pending" role="alert">
                <strong>The booking outcome could not be confirmed.</strong>
                <p>
                  The clinic may already have saved this appointment. Keep this page open and retry
                  the same request. If you leave or reload, check My care before starting another
                  booking.
                </p>
              </div>
            )}
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
                (!attempt &&
                  (bookingPaused ||
                    slots.loading ||
                    !!slots.error ||
                    !doctorId ||
                    !time ||
                    !availableSlots.includes(time)))
              }
            >
              {busy ? 'Saving your visit…' : attempt ? 'Retry same request' : 'Confirm appointment'}
              <ArrowRight size={17} />
            </button>
            <Link to="/my-care" className="button button-ghost full-width">
              Back to my care
            </Link>
            {!waitlistEntry && (
              <div className="booking-waitlist-alternative">
                <h3>Need a different time?</h3>
                <p>
                  Share a preferred date range with the clinic. Joining the waitlist does not hold
                  an appointment or send email or SMS.
                </p>
                <button
                  type="button"
                  className="button button-secondary full-width"
                  disabled={locked || !doctorId || bookingPaused}
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
function IntakeSummary({ values }: { values: IntakeValues }) {
  return (
    <dl className="intake-summary">
      {intakeKeys.map((key) => (
        <div key={key}>
          <dt>{intakeLabels[key]}</dt>
          <dd>{values[key] || 'Not provided'}</dd>
        </div>
      ))}
    </dl>
  );
}
export function IntakePage() {
  const { session } = useSession();
  const location = useLocation();
  if (!session?.user) return <Navigate to="/login?next=%2Fintake" replace />;
  if (session.user.role !== 'patient' || !session.user.patientId)
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
  return (
    <IntakeForm
      key={JSON.stringify([
        session.user.id,
        session.csrfToken,
        session.user.patientId,
        location.key,
      ])}
      patientId={session.user.patientId}
      actorId={session.user.id}
    />
  );
}

function IntakeForm({ patientId, actorId }: { patientId: string; actorId: string }) {
  const { intakes: pending } = usePendingCareSubmissions();
  const command = pending.get(patientId);
  const capture = useAppointmentBookingGuard();
  const settings = useAppointmentBookingData('/api/settings', (value) => {
    if (!value || typeof value !== 'object' || !('modules' in value))
      throw new Error('Could not read the clinic’s intake settings.');
    return checkedModules(value.modules);
  });
  const [step, setStep] = useState(command ? 3 : 0);
  const [values, setValues] = useState(() => intakeValues(command));
  const [consent, setConsent] = useState(!!command);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [saved, setSaved] = useState<Intake | null>(null);
  const [draftState, setDraftState] = useState<'initial' | 'rejected' | 'editing'>('initial');
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  const enabled = settings.data?.intake === true;
  const locked = !!command || draftState === 'rejected';
  useLayoutEffect(() => {
    // A fast Back can return before the previous page unmounts. Keep the command for
    // recovery but release that history entry's in-flight UI when navigation starts.
    const release = () => {
      if (submitting.current) {
        submitting.current = false;
        setBusy(false);
      }
    };
    window.addEventListener('popstate', release);
    window.addEventListener('hashchange', release);
    return () => {
      window.removeEventListener('popstate', release);
      window.removeEventListener('hashchange', release);
    };
  }, []);
  useEffect(() => {
    if (saved) confirmation.current?.focus();
    else if (step > 0 || draftState === 'editing') heading.current?.focus();
  }, [step, saved, draftState]);
  function update(key: keyof IntakeValues, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setConsent(false);
    setError('');
  }
  function editDraft() {
    setDraftState('editing');
    setStep(0);
    void settings.reload();
  }
  async function next(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || draftState === 'rejected') return;
    setError('');
    const answers = intakeValues(values);
    if (step < 3) {
      if (
        step === 0 &&
        (answers.concern.length < 3 || !answers.location || !answers.duration || !answers.symptoms)
      ) {
        setError(
          'Enter a concern of at least three characters, the affected area, duration and symptoms before continuing.',
        );
        return;
      }
      if (step === 2) setValues(answers);
      setStep((current) => current + 1);
      return;
    }
    if (!command && (!enabled || !consent)) return;
    const submitted: IntakeSubmissionCommand = command ?? {
      ...answers,
      patientId,
      requestId: crypto.randomUUID(),
      consent: true,
    };
    const origin = capture();
    const current = () => origin() && pending.get(patientId) === submitted;
    submitting.current = true;
    pending.set(patientId, submitted);
    setBusy(true);
    try {
      const result = await api<unknown>('/api/intakes/submit', {
        method: 'POST',
        body: submitted,
        isCurrent: current,
      });
      if (!current()) return;
      const intake = confirmedIntake(result, submitted, actorId);
      if (!intake) return;
      pending.delete(patientId);
      setSaved(intake);
    } catch (problem) {
      if (current() && intakeNotSubmitted(problem, submitted, actorId)) {
        pending.delete(patientId);
        setValues(intakeValues(submitted));
        setConsent(false);
        setDraftState('rejected');
      }
    } finally {
      if (origin()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  if (!saved && !command && draftState === 'initial') {
    if (settings.loading) return <Loading />;
    if (settings.error) return <ErrorState message={settings.error} retry={settings.reload} />;
    if (!enabled)
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
  }
  if (saved)
    return (
      <div className="booking-success">
        <div className="success-mark">
          <CheckCircle2 size={35} />
        </div>
        <h1 ref={confirmation} tabIndex={-1}>
          Your story is ready.
        </h1>
        <p className="muted">
          Your summary is saved to your record for your dermatologist to review.
        </p>
        <Card>
          <h2>Shared history</h2>
          <p>
            Shared with your agreement on{' '}
            <time dateTime={saved.createdAt}>
              {new Date(saved.createdAt).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: 'Asia/Kolkata',
              })}{' '}
              IST
            </time>
            .
          </p>
          <IntakeSummary values={saved} />
        </Card>
        <div className="row">
          <Link to="/book" className="button button-primary">
            Find an appointment <ArrowRight size={17} />
          </Link>
          <Link to="/my-care/record?tab=history" className="button button-secondary">
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
                  {locked
                    ? 'These are the answers you submitted.'
                    : 'Here is the summary your dermatologist will see. Go back to change anything before sharing.'}
                </p>
                <IntakeSummary values={command ?? values} />
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    required
                    checked={consent}
                    disabled={locked}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  <span>
                    I agree to share these answers with my clinic for care and have checked that
                    they reflect my history.
                  </span>
                </label>
              </>
            )}
            {command && (
              <p className="notice" role="status">
                {busy
                  ? 'Checking whether your history was shared.'
                  : 'Submission unconfirmed. Retry the exact submission to recover the saved history.'}{' '}
                You can return to this form in this tab. Reloading or signing out clears the retry
                details.
              </p>
            )}
            {draftState === 'rejected' && (
              <p className="notice" role="alert">
                Your history was not shared. The clinic paused intake. You can edit your answers and
                review them again when intake resumes.
              </p>
            )}
            {draftState === 'editing' && step === 3 && !command && !enabled && (
              <p className="notice" role="status">
                {settings.loading
                  ? 'Checking intake availability…'
                  : settings.error ||
                    'The clinic has paused intake. Your draft is available to edit.'}
              </p>
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
                  disabled={locked}
                  onClick={() => setStep((current) => current - 1)}
                >
                  <ChevronLeft size={16} /> Back
                </button>
              ) : (
                <Link to="/my-care" className="button button-ghost">
                  Return to my care
                </Link>
              )}
              {draftState === 'rejected' ? (
                <button
                  key="edit"
                  type="button"
                  className="button button-secondary"
                  onClick={editDraft}
                >
                  Edit draft
                </button>
              ) : step === 3 && !command && !enabled ? (
                <button
                  key="availability"
                  type="button"
                  className="button button-secondary"
                  disabled={settings.loading}
                  onClick={settings.reload}
                >
                  Check availability
                </button>
              ) : (
                <button
                  key="submit"
                  className="button button-primary"
                  disabled={busy || (step === 3 && !command && !consent)}
                >
                  {busy
                    ? 'Sharing…'
                    : command
                      ? 'Retry exact submission'
                      : step === 3
                        ? 'Share with my clinic'
                        : 'Continue'}
                  <ChevronRight size={17} />
                </button>
              )}
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}

export function MyCarePage() {
  const { session } = useSession();
  const location = useLocation();
  if (!session?.user) return <Navigate to="/login?next=%2Fmy-care" replace />;
  if (session.user.role !== 'patient' || !session.user.patientId)
    return <Navigate to="/clinic" replace />;
  return (
    <PatientCare
      key={`${session.user.id}:${location.key}`}
      patientId={session.user.patientId}
      name={session.user.name}
    />
  );
}

function usePatientRecord(patientId: string) {
  return useAppointmentBookingData<PatientRecord>(`/api/patients/${patientId}`, (value) => {
    const data = value as PatientRecord | null;
    if (
      !data ||
      data.patient?.id !== patientId ||
      ![
        'appointments',
        'carePlans',
        'checkIns',
        'intakes',
        'encounters',
        'images',
        'messages',
      ].every((field) => Array.isArray(data[field as keyof PatientRecord]))
    )
      throw new Error('Your care record could not be confirmed. Please try again.');
    return data;
  });
}

function PatientCare({ patientId, name }: { patientId: string; name: string }) {
  const record = usePatientRecord(patientId);
  const settings = useResource<ClinicSettings>('/api/settings');
  const [checkIn, setCheckIn] = useState<CarePlan | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [pendingCancellation, setPendingCancellation] = useState<{
    appointmentId: string;
    attempt: CancellationAttempt;
  } | null>(null);
  const [cancellationConfirmed, setCancellationConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancellationBusy = useRef(false);
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
  function closeCancellation() {
    if (cancellationBusy.current) return;
    setCancelId(null);
    if (cancellationConfirmed) {
      setCancellationConfirmed(false);
      void record.reload();
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
      {pendingCancellation && !cancelId && (
        <div className="notice" role="status">
          <p>
            A cancellation is awaiting confirmation. Resume the same request to check its outcome.
          </p>
          <button
            className="button button-secondary"
            onClick={() => setCancelId(pendingCancellation.appointmentId)}
          >
            Resume cancellation
          </button>
        </div>
      )}
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
          <PatientAppointments
            appointments={record.data?.appointments ?? []}
            selectedId={params.get('appointment')}
            cancellationPending={!!pendingCancellation}
            onCancel={(appointment) => {
              setCancellationConfirmed(false);
              setCancelId(appointment.id);
            }}
          />
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
      {cancelId && (
        <Modal title="Cancel appointment" onClose={closeCancellation}>
          <AppointmentCancellationForm
            key={cancelId}
            appointmentId={cancelId}
            pendingAttempt={
              pendingCancellation?.appointmentId === cancelId ? pendingCancellation.attempt : null
            }
            onPendingAttemptChange={(attempt) =>
              setPendingCancellation(attempt ? { appointmentId: cancelId, attempt } : null)
            }
            onBusyChange={(value) => {
              cancellationBusy.current = value;
              setBusy(value);
            }}
            onConfirmed={() => setCancellationConfirmed(true)}
          />
          <button className="button button-secondary" disabled={busy} onClick={closeCancellation}>
            {cancellationConfirmed
              ? 'Close cancellation'
              : pendingCancellation
                ? 'Close for now'
                : 'Keep appointment'}
          </button>
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
  const location = useLocation();
  const { session } = useSession();
  const { uploads } = usePendingCareSubmissions();
  const pendingImage = uploads.has(uploadKey('image', patientId));
  const record = usePatientRecord(patientId);
  const settings = useAppointmentBookingData('/api/settings', checkedMessageSettings);
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
  useLayoutEffect(
    () => setUpload(false),
    [location.key, patientId, session.user?.id, session.csrfToken],
  );
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
                  <IntakeSummary values={entry} />
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
                  {(settings.data?.modules.images || pendingImage) && (
                    <button className="button button-primary" onClick={() => setUpload(true)}>
                      <ImagePlus size={17} /> {pendingImage ? 'Resume image upload' : 'Add image'}
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
              <div
                className="table-wrap"
                role="region"
                aria-label="Your appointment history; scroll horizontally for all columns"
                tabIndex={0}
              >
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
                            <span className="table-subline">
                              {visitInterval(appointment.time, appointment.durationMinutes ?? 30)}{' '}
                              IST · {appointment.durationMinutes ?? 30} minutes
                            </span>
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
      {upload && tab === 'images' && (
        <PrivateUploadModal
          kind="image"
          patientId={patientId}
          onClose={() => setUpload(false)}
          onUploaded={() => {
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

export function MessagesPage() {
  const { session } = useSession();
  const settings = useAppointmentBookingData('/api/settings', checkedMessageSettings);
  if (!session?.user) return <Navigate to="/login?next=%2Fmy-care%2Fmessages" replace />;
  if (session.user.role !== 'patient' || !session.user.patientId)
    return <Navigate to="/clinic/follow-ups" replace />;
  if (settings.loading) return <Loading />;
  if (settings.error) return <ErrorState message={settings.error} retry={settings.reload} />;
  return <PatientMessages patientId={session.user.patientId} settings={settings.data!} />;
}

function PatientMessages({ patientId, settings }: { patientId: string; settings: ClinicSettings }) {
  const messages = useCareMessages(patientId);
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
          <div
            className="patient-message-thread"
            role="region"
            aria-label="Conversation history"
            aria-live="polite"
            tabIndex={0}
          >
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
          <CareMessageComposer
            patientId={patientId}
            canSend={settings.modules.followUp}
            onSaved={messages.reload}
          />
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
