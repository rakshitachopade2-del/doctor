import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Appointment, Doctor, User } from '../shared/types.ts';
import type { DoctorSchedule, ScheduleClosure, SchedulingData } from '../shared/scheduling.ts';
import { addDays, clinicToday, get, list, type DB } from './db.ts';
import { registerWeeklyAvailability } from './weekly-availability.ts';
import { registerTimeOff } from './time-off.ts';
import {
  initializeDoctorBooking,
  registerDoctorBooking,
  doctorAcceptingNewBookings,
  doctorAllowsBooking,
  doctorBookingRevision,
  DOCTOR_BOOKING_PAUSED,
} from './doctor-booking.ts';

type Fail = (status: number, message: string) => never;
interface SchedulingContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: Fail;
}
interface SlotQuery {
  doctorId: string;
  date: string;
  mode?: 'in-person' | 'online';
  excludeAppointmentId?: string;
  patientId?: string;
  /** Internal, authorized override. Custom visits retain this length on rescheduling. */
  customDurationMinutes?: number;
}
interface BookingValidationOptions {
  /** Internal stored source for batch rescheduling; never inferred from excluded IDs. */
  existingAppointmentId?: string;
  /** Internal batch-only exclusions. Never accepted by a public request schema. */
  excludeAppointmentIds?: readonly string[];
  /** A coherent preview instant; commit callers must revalidate with the live clock. */
  asOf?: number;
}
const timeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a real 24-hour time (HH:mm).');
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clockTime = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const overlaps = (start: number, end: number, otherStart: number, otherEnd: number) =>
  start < otherEnd && otherStart < end;
const appointmentDuration = (appointment: Appointment) => appointment.durationMinutes ?? 30;
const modeMatches = (windowMode: 'in-person' | 'online' | 'both', mode?: 'in-person' | 'online') =>
  !mode || windowMode === 'both' || windowMode === mode;

export function createScheduling(context: SchedulingContext) {
  const { db, fail } = context;
  initializeDoctorBooking(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS doctorSchedules (id TEXT PRIMARY KEY REFERENCES doctors(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduleClosures (id TEXT PRIMARY KEY, doctorId TEXT REFERENCES doctors(id), startDate TEXT NOT NULL, endDate TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS closures_dates ON scheduleClosures(startDate,endDate);
  `);
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function schedule(doctorId: string): DoctorSchedule {
    if (!get<Doctor>(db, 'doctors', doctorId)) return fail(404, 'Doctor not found.');
    return (
      get<DoctorSchedule>(db, 'doctorSchedules', doctorId) ?? {
        doctorId,
        durationMinutes: 30,
        updatedAt: '',
        windows: [1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          start: '09:00',
          end: '18:00',
          mode: 'both',
        })),
      }
    );
  }
  function closures(doctorId?: string, date?: string): ScheduleClosure[] {
    const rows = date
      ? db
          .prepare('SELECT data FROM scheduleClosures WHERE startDate<=? AND endDate>=?')
          .all(date, date)
      : db.prepare('SELECT data FROM scheduleClosures ORDER BY startDate, rowid').all();
    return rows
      .map((row) => JSON.parse(row.data as string) as ScheduleClosure)
      .filter((closure) => !doctorId || !closure.doctorId || closure.doctorId === doctorId);
  }
  function closed(
    doctorId: string,
    day: string,
    start: number,
    end: number,
    list = closures(doctorId, day),
  ) {
    return list.some(
      (closure) =>
        (!closure.doctorId || closure.doctorId === doctorId) &&
        closure.startDate <= day &&
        closure.endDate >= day &&
        (closure.startTime === null ||
          overlaps(start, end, minutes(closure.startTime), minutes(closure.endTime!))),
    );
  }
  function fitsSchedule(value: DoctorSchedule, appointment: Appointment) {
    const day = new Date(`${appointment.date}T12:00:00Z`).getUTCDay();
    const start = minutes(appointment.time),
      end = start + appointmentDuration(appointment);
    return value.windows.some(
      (window) =>
        window.day === day &&
        modeMatches(window.mode, appointment.mode) &&
        minutes(window.start) <= start &&
        minutes(window.end) >= end,
    );
  }
  function pendingFutureAppointments(): Appointment[] {
    return list<Appointment>(db, 'appointments').filter(
      (appointment) =>
        ['scheduled', 'checked-in', 'in-consultation'].includes(appointment.status) &&
        appointment.date >= clinicToday() &&
        (Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) +
          appointmentDuration(appointment) * 60000 >
          Date.now() ||
          appointment.status !== 'scheduled'),
    );
  }
  function busyAppointments(query: SlotQuery, excludedIds: readonly string[] = []): Appointment[] {
    return db
      .prepare(
        `SELECT data FROM appointments WHERE date=? AND (doctorId=? OR patientId=?) AND id!=? AND status NOT IN ('cancelled','no-show')${excludedIds.length ? ` AND id NOT IN (${excludedIds.map(() => '?').join(',')})` : ''}`,
      )
      .all(
        query.date,
        query.doctorId,
        query.patientId ?? '',
        query.excludeAppointmentId ?? '',
        ...excludedIds,
      )
      .map((row) => JSON.parse(row.data as string) as Appointment);
  }
  function availableSlots(query: SlotQuery): string[] {
    const value = schedule(query.doctorId);
    if (!doctorAllowsBooking(db, query.doctorId, query.excludeAppointmentId, query.patientId))
      return [];
    const duration = query.customDurationMinutes ?? value.durationMinutes;
    const cadence = query.customDurationMinutes === undefined ? value.durationMinutes : 5;
    const today = clinicToday();
    if (query.date < today || query.date > addDays(today, 180)) return [];
    const day = new Date(`${query.date}T12:00:00Z`).getUTCDay();
    const busy = busyAppointments(query),
      blocks = closures(query.doctorId, query.date);
    const slots: string[] = [];
    for (const window of value.windows.filter(
      (window) => window.day === day && modeMatches(window.mode, query.mode),
    )) {
      for (
        let start = minutes(window.start);
        start + duration <= minutes(window.end);
        start += cadence
      ) {
        const time = clockTime(start),
          end = start + duration;
        if (Date.parse(`${query.date}T${time}:00+05:30`) <= Date.now()) continue;
        if (closed(query.doctorId, query.date, start, end, blocks)) continue;
        if (
          busy.some((appointment) =>
            overlaps(
              start,
              end,
              minutes(appointment.time),
              minutes(appointment.time) + appointmentDuration(appointment),
            ),
          )
        )
          continue;
        slots.push(time);
      }
    }
    return slots.sort();
  }
  function validateBooking(
    query: SlotQuery & { time: string; mode: 'in-person' | 'online' },
    options: BookingValidationOptions = {},
  ): number {
    const asOf = options.asOf ?? Date.now();
    const value = schedule(query.doctorId),
      today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(asOf));
    if (
      !doctorAllowsBooking(
        db,
        query.doctorId,
        options.existingAppointmentId ?? query.excludeAppointmentId,
        query.patientId,
      )
    )
      return fail(409, DOCTOR_BOOKING_PAUSED);
    const duration = query.customDurationMinutes ?? value.durationMinutes;
    const cadence = query.customDurationMinutes === undefined ? value.durationMinutes : 5;
    if (query.date < today || query.date > addDays(today, 180))
      return fail(400, 'Choose a date within the next 180 days.');
    if (Date.parse(`${query.date}T${query.time}:00+05:30`) <= asOf)
      return fail(400, 'This appointment time has already passed.');
    timeSchema.parse(query.time);
    const start = minutes(query.time),
      end = start + duration;
    const day = new Date(`${query.date}T12:00:00Z`).getUTCDay();
    const withinWindow = value.windows.some(
      (window) =>
        window.day === day &&
        modeMatches(window.mode, query.mode) &&
        start >= minutes(window.start) &&
        end <= minutes(window.end) &&
        (start - minutes(window.start)) % cadence === 0,
    );
    if (!withinWindow)
      return fail(
        400,
        'Choose an available appointment time for this doctor and consultation mode.',
      );
    if (closed(query.doctorId, query.date, start, end))
      return fail(409, 'The clinic or doctor is unavailable at this time. Choose another slot.');
    if (
      busyAppointments(query, options.excludeAppointmentIds).some((appointment) =>
        overlaps(
          start,
          end,
          minutes(appointment.time),
          minutes(appointment.time) + appointmentDuration(appointment),
        ),
      )
    )
      return fail(
        409,
        'This time overlaps an existing appointment. Choose another available slot.',
      );
    return duration;
  }
  function register(app: Express) {
    const { actor } = context;
    const staff = (req: AuthRequest) => actor(req, ['admin', 'doctor', 'receptionist']);
    app.get('/api/scheduling', (req: AuthRequest, res) => {
      staff(req);
      const data: SchedulingData = {
        schedules: list<Doctor>(db, 'doctors')
          .reverse()
          .map((doctor) => schedule(doctor.id)),
        closures: closures(),
        timezone: 'Asia/Kolkata',
        bookingWindowDays: 180,
      };
      res.json(data);
    });
    app.get('/api/schedules/:doctorId', (req: AuthRequest, res) => {
      staff(req);
      res.json(schedule(String(req.params.doctorId)));
    });
    registerDoctorBooking(app, { ...context, transaction });
    registerWeeklyAvailability(app, {
      ...context,
      transaction,
      schedule,
      assertPreservesBookings(value) {
        const affected = pendingFutureAppointments().filter(
          (appointment) =>
            appointment.doctorId === value.doctorId && !fitsSchedule(value, appointment),
        );
        if (affected.length)
          fail(
            409,
            `This schedule would invalidate ${affected.length} booked appointment${affected.length === 1 ? '' : 's'}. Reschedule or cancel the affected appointments first.`,
          );
      },
    });
    registerTimeOff(app, {
      ...context,
      transaction,
      assertPreservesBookings(closure) {
        const affected = pendingFutureAppointments().filter((appointment) =>
          closed(
            appointment.doctorId,
            appointment.date,
            minutes(appointment.time),
            minutes(appointment.time) + appointmentDuration(appointment),
            [closure],
          ),
        );
        if (affected.length)
          fail(
            409,
            `This closure would affect ${affected.length} booked appointment${affected.length === 1 ? '' : 's'}. Reschedule or cancel the affected appointments first.`,
          );
      },
    });
  }
  return {
    schedule,
    availableSlots,
    validateBooking,
    register,
    transaction,
    acceptingNewBookings: (doctorId: string) => doctorAcceptingNewBookings(db, doctorId),
    bookingStatusRevision: (doctorId: string) => doctorBookingRevision(db, doctorId),
  };
}
