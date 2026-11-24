import { registerOperations } from './operations.ts';
import { registerClinical } from './clinical.ts';
import { createFollowUp } from './follow-up.ts';
import { createFollowUpEscalation } from './follow-up-escalation.ts';
import { createAppointmentReminders } from './appointment-reminders.ts';
import { registerClinicConfiguration } from './clinic-configuration.ts';
import { createWaitlist } from './waitlist.ts';
import { registerInsights } from './insights.ts';
import { registerInventory } from './inventory.ts';
import { safeInvoiceHistory } from './billing-corrections.ts';
import {
  registerPatientProfile,
  patientWithAllergyStatus,
  receptionPatient,
  safeAllergyHistory,
} from './patient-profile.ts';
import { date, email, required, short, text } from './validation.ts';
import { registerStaffAccountCreation } from './staff-account-creation.ts';
import { registerDoctorProfileEdits } from './doctor-profile-edit.ts';
import { registerDoctorProfileCreation } from './doctor-profile-creation.ts';
import { registerPatientRegistration } from './patient-registration.ts';
import { registerCarePlanCreation } from './care-plan-creation.ts';
import { registerCheckInSubmission } from './check-in-submission.ts';
import { registerIntakeSubmission } from './intake-submission.ts';
import { registerCareMessages } from './care-message.ts';
import { registerCareSummary } from './care-summary.ts';
import { registerCareSummaryCopies } from './care-summary-copies.ts';
import {
  registerImageAnnotations,
  publishedImageAnnotationsForPatient,
} from './image-annotations.ts';
import { registerDocuments } from './documents.ts';
import { registerPrivateUploads } from './private-upload.ts';
import { initializeActivity, notifyPatient, registerActivity } from './activity.ts';
import {
  initializeIdentity,
  managedAccount,
  registerIdentity,
  restrictedSessionAllows,
  sessionLabel,
} from './identity.ts';
import { createScheduling } from './scheduling.ts';
import { createClinicResources } from './clinic-resources.ts';
import { registerRecordSearch } from './record-search.ts';
import { registerAttendance } from './attendance.ts';
import { initializeMfa, invalidateMfaTransient, mfaSessionAllowed, registerMfa } from './mfa.ts';
import { mfaEncryptionKey } from './mfa-crypto.ts';
import { AuthenticationThrottle, createAuthSecurity } from './auth-security.ts';
import { registerVisitDuration } from './visit-duration.ts';
import { registerAppointmentSeries } from './appointment-series.ts';
import { registerAppointmentBookings } from './appointment-booking.ts';
import { registerAppointmentRescheduling } from './appointment-rescheduling.ts';
import { registerAppointmentCancellation } from './appointment-cancellation.ts';
import { registerAppointmentStateChange } from './appointment-state-change.ts';
import { registerConsultationRecording } from './consultation-recording.ts';
import { registerAppointmentSeriesCancellations } from './appointment-series-cancellations.ts';
import { registerAppointmentSeriesRescheduling } from './appointment-series-rescheduling.ts';
import {
  publicSiteConfiguration,
  registerPublicLibrary,
  type PublicSiteOptions,
} from './public-library.ts';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  openDatabase,
  seedDemo,
  get,
  list,
  insert,
  settings,
  createUser,
  verifyPassword,
  hashPassword,
  id,
  nowISO,
  clinicToday,
  addDays,
  type DB,
} from './db.ts';
import type {
  User,
  Doctor,
  Patient,
  Appointment,
  AppointmentStatus,
  CarePlan,
  Intake,
  Encounter,
  CheckIn,
  ClinicalImage,
  Message,
  AuditEntry,
  ClinicSettings,
} from '../shared/types.ts';

export type AuthRequest = Request & { user?: User; sessionToken?: string; csrfToken?: string };
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const password = z.string().min(12, 'Use at least 12 characters').max(128);
const patientFields = z.object({
  name: required,
  email,
  phone: z.string().trim().min(7).max(30),
  dob: date.refine((d) => d <= clinicToday(), 'Date of birth must not be in the future'),
  gender: z.string().trim().max(50).default('Prefer not to say'),
  allergies: text.default(''),
});
const statusSchema = z.enum([
  'scheduled',
  'checked-in',
  'in-consultation',
  'completed',
  'cancelled',
  'no-show',
]);
const CLOSED = ['cancelled', 'no-show', 'completed'];
const transitions: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ['checked-in', 'cancelled', 'no-show'],
  'checked-in': ['in-consultation', 'cancelled'],
  'in-consultation': ['completed'],
  completed: [],
  cancelled: [],
  'no-show': [],
};
export interface AppOptions extends PublicSiteOptions {
  databasePath?: string;
  demoMode?: boolean;
  production?: boolean;
  mfaEncryptionKey?: string;
}
export function createApp(options: AppOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const demoMode =
    options.demoMode ?? (process.env.DEMO_MODE ? process.env.DEMO_MODE === 'true' : !production);
  if (production && demoMode)
    throw new Error(
      'Demo mode is disabled in production. Use a fresh database and bootstrap an administrator.',
    );
  const publicSite = publicSiteConfiguration(options, production, demoMode);
  const db = openDatabase(options.databasePath);
  if (production && db.prepare('SELECT 1 FROM meta WHERE key=?').get('demo-seeded')) {
    db.close();
    throw new Error(
      'A demo database cannot be used in production. Set DATABASE_PATH to a fresh database.',
    );
  }
  if (demoMode) seedDemo(db);
  initializeIdentity(db);
  let mfaKey: Buffer | null;
  try {
    mfaKey = mfaEncryptionKey(options.mfaEncryptionKey ?? process.env.MFA_ENCRYPTION_KEY);
    initializeMfa(db, mfaKey);
  } catch (error) {
    db.close();
    throw error;
  }
  initializeActivity(db);
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.locals.db = db;
  app.locals.close = () => db.close();
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    if (production)
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.use(express.json({ limit: '7mb' }));
  app.use('/api', (req: AuthRequest, _res, next) => {
    const cookie = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('derma_session='))
      ?.slice('derma_session='.length);
    if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
      const tokenHash = digest(cookie);
      const session = db
        .prepare('SELECT * FROM sessions WHERE tokenHash=? AND expiresAt>?')
        .get(tokenHash, Date.now()) as
        { userId: string; csrfToken: string; mfaCredentialId?: string } | undefined;
      if (session) {
        const user = get<User>(db, 'users', session.userId);
        if (
          user &&
          user.active !== false &&
          mfaSessionAllowed(db, user.id, session.mfaCredentialId)
        ) {
          req.user = managedAccount(user);
          req.sessionToken = tokenHash;
          req.csrfToken = session.csrfToken;
        } else if (user && user.active !== false) {
          db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(tokenHash);
        } else {
          db.prepare('DELETE FROM sessions WHERE userId=?').run(session.userId);
        }
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let allowed = false;
        try {
          const parsed = new URL(origin);
          allowed =
            parsed.host === req.headers.host ||
            (!!process.env.APP_ORIGIN && origin === process.env.APP_ORIGIN);
        } catch {}
        if (!allowed) return next(new HttpError(403, 'This request origin is not allowed.'));
      }
      if (origin === 'null') return next(new HttpError(403, 'This request origin is not allowed.'));
      if (!req.is('application/json')) return next(new HttpError(415, 'Use application/json.'));
      if (
        ![
          '/auth/login',
          '/auth/register',
          '/auth/recover',
          '/auth/mfa/verify',
          '/auth/mfa/challenge/cancel',
        ].includes(req.path)
      ) {
        if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
        if (!req.csrfToken || req.headers['x-csrf-token'] !== req.csrfToken)
          return next(
            new HttpError(
              403,
              'The session security token is missing or expired. Refresh and try again.',
            ),
          );
      }
    }
    if (req.user?.mustChangePassword && !restrictedSessionAllows(req.method, req.path))
      return next(
        new HttpError(403, 'Change your temporary password before accessing your workspace.'),
      );
    next();
  });
  const audit = (req: AuthRequest, action: string, entityType: string, entityId: string) =>
    insert(db, 'audit', {
      id: id(),
      actorName: req.user?.name ?? 'Visitor',
      action,
      entityType,
      entityId,
      createdAt: nowISO(),
    } as AuditEntry);
  const actor = (req: AuthRequest, roles?: User['role'][]) => {
    if (!req.user) return fail(401, 'Please sign in to continue.');
    if (roles && !roles.includes(req.user.role))
      return fail(403, 'Your account does not have permission for this action.');
    return req.user;
  };
  const clinical = (req: AuthRequest) => actor(req, ['doctor', 'admin']);
  const patientAccess = (req: AuthRequest, patientId: string, allowReception = false) => {
    const user = actor(req);
    if (user.role === 'receptionist' && !allowReception)
      fail(403, 'Clinical records are restricted to the care team and patient.');
    if (user.role === 'patient' && user.patientId !== patientId)
      fail(403, 'You can only access your own care record.');
    const p = get<Patient>(db, 'patients', patientId);
    if (!p) fail(404, 'Patient not found.');
    return user.role === 'receptionist' ? receptionPatient(p!) : patientWithAllergyStatus(p!);
  };
  const ownPatient = (req: AuthRequest, input?: string) => {
    const user = actor(req);
    const pid = user.role === 'patient' ? user.patientId : input;
    if (!pid) return fail(400, 'Select a patient.');
    if (user.role === 'patient' && input && input !== pid)
      fail(403, 'You can only access your own care record.');
    return pid;
  };
  // Called within the transaction that reads or changes the patient's record.
  function currentSessionUser(req: AuthRequest) {
    const session = db
      .prepare('SELECT userId,expiresAt,csrfToken,mfaCredentialId FROM sessions WHERE tokenHash=?')
      .get(req.sessionToken ?? '');
    const user = req.user && get<User>(db, 'users', req.user.id);
    if (
      !user ||
      !session ||
      user.active === false ||
      session.userId !== user.id ||
      Number(session.expiresAt) <= Date.now() ||
      !req.csrfToken ||
      session.csrfToken !== req.csrfToken ||
      (req.method === 'POST' && req.headers['x-csrf-token'] !== session.csrfToken) ||
      !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    req.user = user;
    return user;
  }
  function currentCareUser(req: AuthRequest) {
    const user = currentSessionUser(req);
    if (user.mustChangePassword || !['patient', 'doctor', 'admin'].includes(user.role))
      return fail(403, 'Clinical records are restricted to the care team and patient.');
    return user;
  }
  function authorizeBillingStaff(req: AuthRequest) {
    const user = currentSessionUser(req);
    if (user.mustChangePassword || !['admin', 'doctor', 'receptionist'].includes(user.role))
      return fail(403, 'A current staff account is required for this billing entry.');
    return user;
  }
  function authorizePatientRecord(req: AuthRequest, requestedPatient?: string) {
    const user = currentCareUser(req);
    const patientId = ownPatient(req, requestedPatient);
    patientAccess(req, patientId);
    return { user, patientId };
  }

  const moduleEnabled = (name: keyof ClinicSettings['modules']) => {
    if (!settings(db).modules[name]) fail(403, 'This module is currently disabled by the clinic.');
  };
  const clinicianProfile = (req: AuthRequest) => {
    const user = clinical(req);
    const doctor = user.doctorId && get<Doctor>(db, 'doctors', user.doctorId);
    if (!doctor)
      return fail(400, 'Sign in with a linked doctor account to document clinical care.');
    return doctor;
  };
  const clinicianId = (req: AuthRequest) => clinicianProfile(req).id;
  const issueSession = (user: User, req: Request, mfaCredentialId?: string) => {
    if (!mfaSessionAllowed(db, user.id, mfaCredentialId))
      fail(409, 'MFA settings changed. Sign in again.');
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(Date.now());
    const createdAt = Date.now();
    db.prepare(
      'INSERT INTO sessions(tokenHash,userId,csrfToken,expiresAt,createdAt,label,mfaCredentialId) VALUES (?,?,?,?,?,?,?)',
    ).run(
      digest(token),
      user.id,
      csrfToken,
      createdAt + 12 * 3600000,
      createdAt,
      sessionLabel(req.headers['user-agent']),
      mfaCredentialId ?? null,
    );
    return {
      session: { user: managedAccount(user), csrfToken, demoMode },
      apply: (res: Response) => {
        res.cookie('derma_session', token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: production,
          maxAge: 12 * 3600000,
          path: '/',
        });
      },
    };
  };
  const clearSessionCookie = (res: Response) => {
    res.clearCookie('derma_session', {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      path: '/',
    });
  };
  const dummyPasswordHash = hashPassword('dummy-password-for-unregistered-account');
  let authSecurity: ReturnType<typeof createAuthSecurity>;
  try {
    authSecurity = createAuthSecurity({ db, dummyPasswordHash, fail });
  } catch (error) {
    db.close();
    throw error;
  }
  const rateLimit = authSecurity.rateLimit;
  registerIdentity(app, { db, production, actor, audit, fail, rateLimit });
  const mfa = registerMfa(app, {
    db,
    key: mfaKey,
    production,
    actor,
    audit,
    fail,
    issueSession,
    clearSessionCookie,
  });
  const appointmentGet = (req: AuthRequest, key: string) => {
    const a = get<Appointment>(db, 'appointments', key);
    if (!a) return fail(404, 'Appointment not found.');
    patientAccess(req, a.patientId, true);
    return a;
  };
  function currentClinicalAuthor(req: AuthRequest) {
    const user = currentCareUser(req);
    return { user, doctor: clinicianProfile(req) };
  }
  const scheduling = createScheduling({ db, actor, audit, fail });
  const clinicResources = createClinicResources({ db, actor, audit, fail });
  const waitlist = createWaitlist({ db, actor, ownPatient, patientAccess, audit, fail });
  const followUp = createFollowUp({
    db,
    actor,
    patientAccess,
    clinicianId,
    authorizeClinician: currentClinicalAuthor,
    moduleEnabled,
    audit,
    fail,
  });
  const followUpEscalation = createFollowUpEscalation({ db, actor, audit, fail });
  const appointmentReminders = createAppointmentReminders({ db, actor, audit, fail });
  app.locals.runAppointmentReminders = appointmentReminders.runAutomatic;
  app.locals.startAppointmentReminders = appointmentReminders.start;
  app.locals.stopAppointmentReminders = appointmentReminders.stop;
  app.locals.runFollowUpEscalations = followUpEscalation.runAutomatic;
  app.locals.startFollowUpEscalations = followUpEscalation.start;
  app.locals.stopFollowUpEscalations = followUpEscalation.stop;
  app.locals.close = () => {
    followUpEscalation.stop();
    appointmentReminders.stop();
    db.close();
  };
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/session', (req: AuthRequest, res) =>
    res.json({ user: req.user ?? null, csrfToken: req.csrfToken, demoMode }),
  );
  app.post('/api/auth/login', (req: AuthRequest, res) => {
    rateLimit(req, 'login');
    const input = z.object({ email, password: z.string().min(1).max(128) }).parse(req.body);
    const verified = authSecurity.verifyLogin(req, input.email, input.password);
    const { user } = verified;
    const result = authSecurity.finalize(() => {
      const challenge = mfa.beginLogin(
        user,
        req,
        res,
        verified.passwordHash,
        verified.securityVersion,
        () => authSecurity.acceptPassword(req, input.email),
      );
      if (challenge) return { challenge };
      const issued = scheduling.transaction(() => {
        const current = get<User>(db, 'users', user.id);
        if (
          !current ||
          current.active === false ||
          db.prepare('SELECT password FROM users WHERE id=?').get(user.id)?.password !==
            verified.passwordHash ||
          Number(
            db.prepare('SELECT version FROM mfaEpochs WHERE userId=?').get(user.id)?.version ?? 0,
          ) !== verified.securityVersion
        )
          return fail(409, 'The account changed. Sign in again.');
        authSecurity.acceptPassword(req, input.email);
        audit({ ...req, user: current } as AuthRequest, 'signed in', 'user', user.id);
        return issueSession(current, req);
      });
      return { issued };
    });
    if (result.challenge) return res.status(202).json(result.challenge);
    result.issued!.apply(res);
    mfa.clearChallenge(res);
    res.json(result.issued!.session);
  });
  app.post('/api/auth/register', (req: AuthRequest, res) => {
    rateLimit(req, 'register', 10);
    const input = patientFields.extend({ password }).parse(req.body);
    const p: Patient = {
      id: id(),
      name: input.name,
      email: input.email,
      phone: input.phone,
      dob: input.dob,
      gender: input.gender,
      allergies: '',
      createdAt: nowISO(),
    };
    const user: User = {
      id: id(),
      name: p.name,
      email: p.email,
      role: 'patient',
      patientId: p.id,
      active: true,
      mustChangePassword: false,
    };
    const issued = scheduling.transaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(input.email))
        fail(409, 'An account already exists with this email.');
      insert(db, 'patients', p);
      createUser(db, user, input.password);
      audit({ ...req, user } as AuthRequest, 'registered', 'user', user.id);
      return issueSession(user, req);
    });
    issued.apply(res);
    res.status(201).json(issued.session);
  });
  app.post('/api/auth/logout', (req: AuthRequest, res) => {
    scheduling.transaction(() => {
      const session = db
        .prepare('SELECT userId FROM sessions WHERE tokenHash=? AND expiresAt>?')
        .get(req.sessionToken ?? '', Date.now());
      if (!session || session.userId !== req.user?.id) return;
      const current = get<User>(db, 'users', String(session.userId));
      db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(req.sessionToken!);
      db.prepare('DELETE FROM mfaPending WHERE sessionHash=?').run(req.sessionToken!);
      audit(
        { ...req, user: current ?? req.user } as AuthRequest,
        'signed out',
        'user',
        String(session.userId),
      );
    });
    mfa.clearChallenge(res);
    res.clearCookie('derma_session', {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      path: '/',
    });
    res.json({ ok: true });
  });
  app.post('/api/auth/password', (req: AuthRequest, res) => {
    const user = actor(req);
    rateLimit(req, 'change-password', 10);
    const input = z
      .object({ currentPassword: z.string().max(128), newPassword: password })
      .parse(req.body);
    const row = db.prepare('SELECT password FROM users WHERE id=?').get(user.id) as {
      password: string;
    };
    if (!verifyPassword(input.currentPassword, row.password))
      fail(400, 'Current password is incorrect.');
    if (verifyPassword(input.newPassword, row.password))
      fail(400, 'Choose a new password different from your current password.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = get<User>(db, 'users', user.id);
      const session = db
        .prepare(
          'SELECT userId,expiresAt,csrfToken,mfaCredentialId FROM sessions WHERE tokenHash=?',
        )
        .get(req.sessionToken!);
      if (
        !current ||
        current.active === false ||
        !session ||
        session.userId !== user.id ||
        Number(session.expiresAt) <= Date.now() ||
        session.csrfToken !== req.csrfToken ||
        !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
      )
        fail(401, 'Your session changed. Sign in again.');
      if (
        db.prepare('SELECT password FROM users WHERE id=?').get(user.id)?.password !== row.password
      )
        fail(409, 'The account password changed. Sign in again.');
      db.prepare('UPDATE users SET password=?,data=? WHERE id=?').run(
        hashPassword(input.newPassword),
        JSON.stringify({ ...managedAccount(current!), mustChangePassword: false }),
        user.id,
      );
      db.prepare('DELETE FROM sessions WHERE userId=? AND tokenHash!=?').run(
        user.id,
        req.sessionToken!,
      );
      db.prepare('DELETE FROM recoveryGrants WHERE userId=?').run(user.id);
      invalidateMfaTransient(db, user.id);
      audit(req, 'changed password', 'user', user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ ok: true });
  });
  app.get('/api/users', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    res.json(list<User>(db, 'users').map(managedAccount));
  });
  registerStaffAccountCreation(app, {
    db,
    currentSessionUser,
    transaction: scheduling.transaction,
    audit,
    fail,
  });
  app.get('/api/doctors', (_req, res) =>
    res.json(
      list<Doctor>(db, 'doctors')
        .reverse()
        .map((doctor) => ({
          ...doctor,
          appointmentDurationMinutes: scheduling.schedule(doctor.id).durationMinutes,
          acceptingNewBookings: scheduling.acceptingNewBookings(doctor.id),
        })),
    ),
  );
  registerDoctorProfileCreation(app, {
    db,
    currentSessionUser,
    transaction: scheduling.transaction,
    audit,
    fail,
  });
  registerDoctorProfileEdits(app, {
    db,
    currentSessionUser,
    transaction: scheduling.transaction,
    audit,
    fail,
  });
  registerClinicConfiguration(app, { db, actor, audit, fail });
  app.get('/api/slots', (req: AuthRequest, res) => {
    const input = z
      .object({
        doctorId: required,
        date,
        mode: z.enum(['in-person', 'online']).optional(),
        excludeAppointmentId: required.optional(),
      })
      .strict()
      .parse(req.query);
    let patientId =
      req.user?.role === 'patient' && !req.user.mustChangePassword ? req.user.patientId : undefined;
    let customDurationMinutes: number | undefined;
    if (input.excludeAppointmentId) {
      if (req.user?.mustChangePassword)
        fail(403, 'Change your temporary password before accessing appointment details.');
      actor(req);
      const appointment = appointmentGet(req, input.excludeAppointmentId);
      patientId = appointment.patientId;
      if (appointment.durationPolicy === 'custom')
        customDurationMinutes = appointment.durationMinutes ?? 30;
    }
    const slots = scheduling.availableSlots({ ...input, patientId, customDurationMinutes });
    const duration = customDurationMinutes ?? scheduling.schedule(input.doctorId).durationMinutes;
    res.json(
      input.excludeAppointmentId
        ? clinicResources.availableSlotsForAppointment(
            input.excludeAppointmentId,
            input.date,
            slots,
            duration,
          )
        : slots,
    );
  });
  app.get('/api/patients', (req: AuthRequest, res) => {
    const user = actor(req, ['admin', 'doctor', 'receptionist']);
    const search = z
      .string()
      .max(300)
      .parse(req.query.search ?? '')
      .toLowerCase();
    const patients = list<Patient>(db, 'patients').filter((p) =>
      `${p.name} ${p.email} ${p.phone}`.toLowerCase().includes(search),
    );
    res.json(
      patients.map(user.role === 'receptionist' ? receptionPatient : patientWithAllergyStatus),
    );
  });
  registerPatientRegistration(app, {
    db,
    currentSessionUser,
    transaction: scheduling.transaction,
    audit,
    fail,
  });
  app.get('/api/patients/:id', (req: AuthRequest, res) => {
    const key = String(req.params.id),
      patient = patientAccess(req, key),
      user = actor(req);
    audit(req, 'viewed care record', 'patient', key);
    res.json({
      patient,
      appointments: list<Appointment>(db, 'appointments', key).sort((a, b) =>
        `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`),
      ),
      intakes: list<Intake>(db, 'intakes', key),
      encounters: user.role === 'patient' ? [] : list<Encounter>(db, 'encounters', key),
      carePlans: followUp.hydratePlans(
        list<CarePlan>(db, 'carePlans', key),
        user.role === 'patient',
      ),
      checkIns: list<CheckIn>(db, 'checkIns', key),
      images: list<ClinicalImage>(db, 'images', key),
      messages: list<Message>(db, 'messages', key).reverse(),
    });
  });
  app.get('/api/appointments', (req: AuthRequest, res) => {
    const user = actor(req);
    const query = z.object({ date: date.optional(), doctorId: short.optional() }).parse(req.query);
    let rows = list<Appointment>(
      db,
      'appointments',
      user.role === 'patient' ? user.patientId : undefined,
    );
    rows = rows.filter(
      (a) =>
        (!query.date || a.date === query.date) &&
        (!query.doctorId || a.doctorId === query.doctorId),
    );
    res.json(rows.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)));
  });
  registerAppointmentBookings(app, {
    db,
    actor,
    ownPatient,
    patientAccess,
    audit,
    fail,
    scheduling,
    waitlist,
    businessFailure: (error) =>
      error instanceof HttpError ? { status: error.status, message: error.message } : null,
  });
  const appointmentRescheduling = registerAppointmentRescheduling(app, {
    db,
    actor,
    appointmentGet,
    audit,
    fail,
    scheduling,
    clinicResources,
    businessFailure: (error) =>
      error instanceof HttpError ? { status: error.status, message: error.message } : null,
  });
  registerAppointmentCancellation(app, {
    db,
    actor,
    appointmentGet,
    audit,
    fail,
    scheduling,
    clinicResources,
    appointmentRescheduling,
    businessFailure: (error) =>
      error instanceof HttpError ? { status: error.status, message: error.message } : null,
  });
  registerAppointmentStateChange(app, {
    db,
    actor,
    appointmentGet,
    audit,
    fail,
    scheduling,
    clinicResources,
    appointmentRescheduling,
    businessFailure: (error) =>
      error instanceof HttpError ? { status: error.status, message: error.message } : null,
  });
  app.patch('/api/appointments/:id', (req: AuthRequest, res) => {
    const input = z
      .object({
        status: statusSchema.optional(),
        date: date.optional(),
        time: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional(),
        doctorId: required.optional(),
        mode: z.enum(['in-person', 'online']).optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'No changes supplied')
      .parse(req.body);
    const updated = scheduling.transaction(() => {
      const user = appointmentRescheduling.authorize(req);
      const a = appointmentGet(req, String(req.params.id));
      if (CLOSED.includes(a.status)) fail(409, 'This appointment is closed and cannot be changed.');
      if (
        user.role === 'receptionist' &&
        input.status &&
        ['in-consultation', 'completed'].includes(input.status)
      )
        fail(403, 'Only a clinician can start or complete a consultation.');
      if (user.role === 'patient' && input.status && input.status !== 'cancelled')
        fail(403, 'Patients may only cancel or reschedule appointments.');
      if (user.role === 'patient' && a.status !== 'scheduled')
        fail(409, 'Contact reception to change an appointment already in progress.');
      if (
        input.status &&
        input.status !== a.status &&
        !transitions[a.status].includes(input.status)
      )
        fail(409, 'This appointment status change is not allowed.');
      if (
        input.status &&
        ['checked-in', 'in-consultation', 'completed', 'no-show'].includes(input.status) &&
        a.date > clinicToday()
      )
        fail(400, 'Future appointments cannot be checked in, completed or marked as no-show.');
      if (input.status === 'no-show' && Date.parse(`${a.date}T${a.time}:00+05:30`) > Date.now())
        fail(400, 'An appointment cannot be marked as a no-show before its scheduled time.');
      const rescheduling = Boolean(input.date || input.time || input.doctorId || input.mode);
      let durationMinutes = a.durationMinutes ?? 30;
      if (rescheduling) {
        if (a.status !== 'scheduled') fail(409, 'Only scheduled appointments can be rescheduled.');
        if (input.status && input.status !== 'scheduled')
          fail(400, 'Reschedule and status changes must be separate actions.');
        durationMinutes = scheduling.validateBooking({
          doctorId: input.doctorId ?? a.doctorId,
          date: input.date ?? a.date,
          time: input.time ?? a.time,
          mode: input.mode ?? a.mode,
          excludeAppointmentId: a.id,
          patientId: a.patientId,
          customDurationMinutes:
            a.durationPolicy === 'custom' ? (a.durationMinutes ?? 30) : undefined,
        });
      }
      const d = get<Doctor>(db, 'doctors', input.doctorId ?? a.doctorId)!;
      const value: Appointment = {
        ...a,
        ...input,
        durationMinutes,
        doctorName: rescheduling ? d.name : a.doctorName,
        fee: rescheduling ? d.fee : a.fee,
      };
      clinicResources.appointmentChanged(req, a, value);
      db.prepare('UPDATE appointments SET doctorId=?,date=?,time=?,status=?,data=? WHERE id=?').run(
        value.doctorId,
        value.date,
        value.time,
        value.status,
        JSON.stringify(value),
        a.id,
      );
      audit(
        req,
        rescheduling ? 'rescheduled appointment' : `appointment ${value.status}`,
        'appointment',
        a.id,
      );
      if (
        JSON.stringify([a.date, a.time, a.mode, a.doctorId, a.status, a.durationMinutes ?? 30]) !==
        JSON.stringify([
          value.date,
          value.time,
          value.mode,
          value.doctorId,
          value.status,
          value.durationMinutes ?? 30,
        ])
      ) {
        notifyPatient(db, value.patientId, `appointment-changed:${value.id}:${id()}`, {
          kind: 'appointment',
          title: rescheduling
            ? 'Your appointment was rescheduled'
            : `Appointment ${value.status.replaceAll('-', ' ')}`,
          detail: `${value.date} at ${value.time} IST · ${value.durationMinutes ?? 30} minutes · ${value.doctorName}`,
          href: rescheduling ? '/my-care' : '/my-care/record?tab=visits',
        });
      }
      return value;
    });
    res.json(updated);
  });
  app.get('/api/appointments/:id/calendar', (req: AuthRequest, res) => {
    const a = appointmentGet(req, String(req.params.id));
    const start = new Date(`${a.date}T${a.time}:00+05:30`),
      end = new Date(start.getTime() + (a.durationMinutes ?? 30) * 60000);
    const stamp = (d: Date) =>
      d
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    const esc = (s: string) =>
      s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    res.setHeader('Content-Disposition', 'attachment; filename="appointment.ics"');
    res
      .type('text/calendar')
      .send(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Derma Studio//Care Calendar//EN',
          'BEGIN:VEVENT',
          `UID:${a.id}@derma-studio`,
          `DTSTAMP:${stamp(new Date())}`,
          `DTSTART:${stamp(start)}`,
          `DTEND:${stamp(end)}`,
          `SUMMARY:${esc(`${a.durationPolicy === 'custom' ? 'Clinic visit' : 'Consultation'} with ${a.doctorName}`)}`,
          `LOCATION:${esc(a.mode === 'online' ? 'Online — clinic will share joining details' : settings(db).address)}`,
          `STATUS:${a.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      );
  });
  registerIntakeSubmission(app, {
    db,
    transaction: scheduling.transaction,
    authorizePatientRecord,
    audit,
    fail,
  });
  app.get('/api/care-plans', (req: AuthRequest, res) => {
    const user = actor(req, ['admin', 'doctor', 'patient']);
    res.json(
      followUp.hydratePlans(
        list<CarePlan>(db, 'carePlans', user.role === 'patient' ? user.patientId : undefined),
        user.role === 'patient',
      ),
    );
  });
  registerCarePlanCreation(app, {
    db,
    transaction: scheduling.transaction,
    authorize: currentClinicalAuthor,
    patientAccess,
    audit,
    fail,
  });
  app.patch('/api/care-plans/:id', (req: AuthRequest, res) => {
    const input = z
      .object({
        status: z.enum(['active', 'completed']),
        expectedRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      followUp.recordLegacyStatus(req, String(req.params.id), input.status, input.expectedRevision),
    );
  });
  registerCheckInSubmission(app, {
    db,
    transaction: scheduling.transaction,
    authorize: (req) => {
      currentCareUser(req);
      return actor(req, ['patient']);
    },
    patientAccess,
    currentOwner: (plan) => followUp.owner(plan).doctorId,
    audit,
    fail,
  });
  app.get('/api/images/:id/file', (req: AuthRequest, res) => {
    const key = String(req.params.id),
      image = get<ClinicalImage>(db, 'images', key);
    if (!image) return fail(404, 'Image not found.');
    patientAccess(req, image.patientId);
    audit(req, 'viewed private image', 'image', key);
    const row = db.prepare('SELECT bytes FROM images WHERE id=?').get(key) as { bytes: Uint8Array };
    res.setHeader(
      'Content-Disposition',
      `inline; filename="clinical-image.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.split('/')[1]}"`,
    );
    res.type(image.mimeType).send(Buffer.from(row.bytes));
  });
  registerCareMessages(app, { db, authorizePatientRecord, audit, fail });
  app.get('/api/audit', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    res.json(
      db
        .prepare('SELECT data FROM audit ORDER BY rowid DESC LIMIT 500')
        .all()
        .map((row) => JSON.parse(row.data as string) as AuditEntry),
    );
  });
  app.get('/api/dashboard', (req: AuthRequest, res) => {
    const user = actor(req, ['admin', 'doctor', 'receptionist']);
    const today = clinicToday(),
      all = list<Appointment>(db, 'appointments'),
      appointments = all
        .filter((a) => a.date === today)
        .sort((a, b) => a.time.localeCompare(b.time)),
      allPlans = followUp.hydratePlans(list<CarePlan>(db, 'carePlans')),
      followUps = allPlans
        .filter(
          (p) =>
            p.effectiveStatus === 'active' &&
            p.effectiveFollowUpDate !== null &&
            p.effectiveFollowUpDate <= today,
        )
        .sort((a, b) =>
          (a.effectiveFollowUpDate ?? '').localeCompare(b.effectiveFollowUpDate ?? ''),
        );
    const patients = list<Patient>(db, 'patients');
    res.json({
      date: today,
      appointments,
      stats: {
        appointments: appointments.filter((a) => a.status !== 'cancelled').length,
        checkedIn: appointments.filter((a) => a.status === 'checked-in').length,
        patients: patients.length,
        followUps: followUps.length,
        completed: appointments.filter((a) => a.status === 'completed').length,
        scheduledValue: appointments
          .filter((a) => !['cancelled', 'no-show'].includes(a.status))
          .reduce((n, a) => n + a.fee, 0),
      },
      weekly: Array.from({ length: 7 }, (_, i) => {
        const day = addDays(today, i - 6);
        return {
          date: day,
          count: all.filter((a) => a.date === day && !['cancelled', 'no-show'].includes(a.status))
            .length,
        };
      }),
      followUps: user.role === 'receptionist' ? [] : followUps,
      recentPatients: patients
        .slice(0, 5)
        .map(user.role === 'receptionist' ? receptionPatient : patientWithAllergyStatus),
    });
  });
  scheduling.register(app);
  clinicResources.register(app);
  registerVisitDuration(app, {
    db,
    actor,
    audit,
    fail,
    patientAccess,
    appointmentGet,
    scheduling,
    clinicResources,
  });
  const appointmentSeries = registerAppointmentSeries(app, {
    db,
    actor,
    audit,
    fail,
    patientAccess,
    scheduling,
  });
  registerAppointmentSeriesCancellations(app, {
    db,
    patientAccess,
    audit,
    fail,
    scheduling,
    clinicResources,
    series: appointmentSeries,
  });
  registerAppointmentSeriesRescheduling(app, {
    db,
    patientAccess,
    audit,
    fail,
    scheduling,
    clinicResources,
    series: appointmentSeries,
  });
  registerRecordSearch(app, { db, actor, fail });
  registerAttendance(app, { db, actor, audit, fail });
  waitlist.register(app);
  registerActivity(app, { db, actor, audit, fail });
  registerDocuments(app, { db, actor, patientAccess, audit, fail });
  registerPrivateUploads(app, {
    db,
    resolvePatient: (req, supplied) => patientAccess(req, ownPatient(req, supplied)).id,
    authorizePatientRecord,
    transaction: scheduling.transaction,
    audit,
    fail,
  });
  registerOperations(app, {
    db,
    demoMode,
    actor,
    patientAccess,
    audit,
    fail,
    authorizeBillingStaff,
    transaction: scheduling.transaction,
  });
  registerPatientProfile(app, { db, actor, patientAccess, clinicianId, audit, fail });
  const clinicalWorkflows = registerClinical(app, {
    db,
    currentCareUser,
    currentSessionUser,
    actor,
    patientAccess,
    clinicianId,
    audit,
    fail,
  });
  registerConsultationRecording(app, {
    db,
    actor,
    patientAccess,
    clinicianId,
    audit,
    fail,
    businessFailure: (error) =>
      error instanceof HttpError ? { status: error.status, message: error.message } : null,
  });
  registerImageAnnotations(app, {
    db,
    actor,
    patientAccess,
    clinicianId,
    moduleEnabled,
    audit,
    fail,
  });
  const careSummary = registerCareSummary(app, {
    db,
    actor,
    patientAccess,
    audit,
    fail,
    hydratePlans: followUp.hydratePlans,
    patientReviews: followUp.patientReviews,
    patientWorkflows: clinicalWorkflows.patientView,
    publishedAnnotations: (patientId) => publishedImageAnnotationsForPatient(db, patientId),
    allergyHistory: (patientId) => safeAllergyHistory(db, patientId).changes,
    invoiceHistory: (invoiceId) => safeInvoiceHistory(db, invoiceId),
  });
  registerCareSummaryCopies(app, {
    db,
    actor,
    patientAccess,
    audit,
    fail,
    snapshot: careSummary.snapshot,
  });
  registerInsights(app, { db, actor, audit, fail });
  registerInventory(app, { db, actor, audit, fail });
  followUp.register(app, followUpEscalation.states);
  followUpEscalation.register(app);
  appointmentReminders.register(app);
  registerPublicLibrary(app, { db, configuration: publicSite, demoMode });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AuthenticationThrottle)
      return res
        .status(429)
        .setHeader('Retry-After', String(error.retryAfter))
        .json({ error: error.message });
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues.map((e) => `${e.path.join('.') || 'Input'}: ${e.message}`).join('; '),
      });
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    const err = error as Error & { type?: string; status?: number; code?: string };
    if (err.type === 'entity.too.large')
      return res
        .status(413)
        .json({ error: 'Request is too large. Images and reports must be 5 MB or smaller.' });
    if (err instanceof SyntaxError && err.status === 400)
      return res.status(400).json({ error: 'Invalid JSON request.' });
    if (err.message?.includes('UNIQUE constraint failed'))
      return res.status(409).json({ error: 'This record or appointment slot already exists.' });
    console.error('Request failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}
