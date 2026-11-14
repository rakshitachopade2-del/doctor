import { registerOperations } from './operations.ts';
import { registerClinical } from './clinical.ts';
import { createFollowUp } from './follow-up.ts';
import { createFollowUpEscalation } from './follow-up-escalation.ts';
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
import { registerCareSummary } from './care-summary.ts';
import {
  registerImageAnnotations,
  imageProvenance,
  publishedImageAnnotationsForPatient,
} from './image-annotations.ts';
import { registerDocuments } from './documents.ts';
import {
  initializeActivity,
  notifyPatient,
  notifyClinicians,
  registerActivity,
} from './activity.ts';
import {
  initializeIdentity,
  managedAccount,
  registerIdentity,
  restrictedSessionAllows,
  sessionLabel,
  validateAccountLinkage,
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
const text = z.string().trim().max(8000);
const short = z.string().trim().max(300);
const required = short.min(1);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) &&
      new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s,
    'Invalid calendar date',
  );
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
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
const doctorSchema = z.object({
  name: required,
  title: required,
  qualifications: required,
  specialties: z.array(required).min(1).max(20),
  experience: z.number().int().min(0).max(80),
  fee: z.number().min(0).max(100000),
  bio: text,
  languages: z.array(required).min(1).max(20),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#b3c7aa'),
});

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
  const moduleEnabled = (name: keyof ClinicSettings['modules']) => {
    if (!settings(db).modules[name]) fail(403, 'This module is currently disabled by the clinic.');
  };
  const clinicianId = (req: AuthRequest) => {
    const user = clinical(req);
    const doctorId = user.doctorId;
    if (!doctorId || !get<Doctor>(db, 'doctors', doctorId))
      return fail(400, 'Sign in with a linked doctor account to document clinical care.');
    return doctorId;
  };
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
  const scheduling = createScheduling({ db, actor, audit, fail });
  const clinicResources = createClinicResources({ db, actor, audit, fail });
  const waitlist = createWaitlist({ db, actor, ownPatient, patientAccess, audit, fail });
  const followUp = createFollowUp({
    db,
    actor,
    patientAccess,
    clinicianId,
    moduleEnabled,
    audit,
    fail,
  });
  const followUpEscalation = createFollowUpEscalation({ db, actor, audit, fail });
  app.locals.runFollowUpEscalations = followUpEscalation.runAutomatic;
  app.locals.startFollowUpEscalations = followUpEscalation.start;
  app.locals.stopFollowUpEscalations = followUpEscalation.stop;
  app.locals.close = () => {
    followUpEscalation.stop();
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
  app.post('/api/users', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const input = z
      .object({
        name: required,
        email,
        password,
        role: z.enum(['doctor', 'receptionist', 'admin']),
        doctorId: required.optional(),
      })
      .parse(req.body);
    validateAccountLinkage(db, input, fail);
    if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(input.email))
      fail(409, 'An account already exists with this email.');
    const user: User = {
      id: id(),
      name: input.name,
      email: input.email,
      role: input.role,
      active: true,
      mustChangePassword: true,
      ...(input.doctorId ? { doctorId: input.doctorId } : {}),
    };
    createUser(db, user, input.password);
    audit(req, 'created staff account', 'user', user.id);
    res.status(201).json(user);
  });
  app.get('/api/doctors', (_req, res) =>
    res.json(
      list<Doctor>(db, 'doctors')
        .reverse()
        .map((doctor) => ({
          ...doctor,
          appointmentDurationMinutes: scheduling.schedule(doctor.id).durationMinutes,
        })),
    ),
  );
  app.post('/api/doctors', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const doctor = { ...doctorSchema.parse(req.body), id: id() };
    insert(db, 'doctors', doctor);
    audit(req, 'created doctor profile', 'doctor', doctor.id);
    res.status(201).json(doctor);
  });
  app.patch('/api/doctors/:id', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const key = String(req.params.id);
    if (!get(db, 'doctors', key)) fail(404, 'Doctor not found.');
    const doctor = { ...doctorSchema.parse(req.body), id: key };
    db.prepare('UPDATE doctors SET data=? WHERE id=?').run(JSON.stringify(doctor), key);
    audit(req, 'updated doctor profile', 'doctor', key);
    res.json(doctor);
  });
  app.get('/api/settings', (_req, res) => res.json(settings(db)));
  app.patch('/api/settings', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const input = z
      .object({
        name: required,
        tagline: short,
        phone: short,
        email: email.or(z.literal('')),
        address: short,
        hours: short,
        timezone: z.literal('Asia/Kolkata'),
        modules: z.object({ intake: z.boolean(), images: z.boolean(), followUp: z.boolean() }),
      })
      .partial()
      .parse(req.body);
    const updated = { ...settings(db), ...input };
    db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(updated), 'settings');
    audit(req, 'updated clinic settings', 'settings', 'clinic');
    res.json(updated);
  });
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
  app.post('/api/patients', (req: AuthRequest, res) => {
    const user = actor(req, ['admin', 'doctor', 'receptionist']);
    const input = patientFields
      .extend({
        email: email.or(z.literal('')).default(''),
        dob: date
          .refine((d) => d <= clinicToday(), 'Date of birth must not be in the future')
          .or(z.literal(''))
          .default(''),
      })
      .parse(req.body);
    if (user.role === 'receptionist' && input.allergies)
      fail(403, 'Clinical information must be recorded by a clinician.');
    const patient = { ...input, id: id(), createdAt: nowISO() };
    insert(db, 'patients', patient);
    audit(req, 'created patient', 'patient', patient.id);
    res
      .status(201)
      .json(
        user.role === 'receptionist'
          ? receptionPatient(patient)
          : patientWithAllergyStatus(patient),
      );
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
  app.post('/api/appointments', (req: AuthRequest, res) => {
    const input = z
      .object({
        patientId: required.optional(),
        doctorId: required,
        date,
        time: z.string().regex(/^\d{2}:\d{2}$/),
        mode: z.enum(['in-person', 'online']),
        reason: short.min(1),
        waitlistId: required.optional(),
        patientConfirmed: z.literal(true).optional(),
        durationMinutes: z.never().optional(),
        durationPolicy: z.never().optional(),
      })
      .parse(req.body);
    const { waitlistId, patientConfirmed, ...appointmentInput } = input;
    const patientId = ownPatient(req, input.patientId);
    const p = patientAccess(req, patientId, true);
    const appointment = scheduling.transaction(() => {
      const durationMinutes = scheduling.validateBooking({
        doctorId: input.doctorId,
        date: input.date,
        time: input.time,
        mode: input.mode,
        patientId,
      });
      const d = get<Doctor>(db, 'doctors', input.doctorId)!;
      const value: Appointment = {
        ...appointmentInput,
        id: id(),
        patientId,
        patientName: p.name,
        doctorName: d.name,
        fee: d.fee,
        durationMinutes,
        status: 'scheduled',
        createdAt: nowISO(),
      };
      db.prepare(
        'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
      ).run(value.id, patientId, d.id, value.date, value.time, value.status, JSON.stringify(value));
      if (waitlistId) waitlist.book(req, waitlistId, value, patientConfirmed);
      audit(req, 'booked appointment', 'appointment', value.id);
      if (!waitlistId)
        notifyPatient(db, patientId, `appointment-created:${value.id}`, {
          kind: 'appointment',
          title: 'Your appointment is booked',
          detail: `${value.date} at ${value.time} IST · ${value.doctorName}`,
          href: '/my-care',
        });
      return value;
    });
    res.status(201).json(appointment);
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
      const a = appointmentGet(req, String(req.params.id)),
        user = actor(req);
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
  app.post('/api/intakes', (req: AuthRequest, res) => {
    moduleEnabled('intake');
    const input = z
      .object({
        patientId: required.optional(),
        concern: required,
        location: required,
        duration: required,
        symptoms: text.default(''),
        triggers: text.default(''),
        previousTreatment: text.default(''),
        medications: text.default(''),
        allergies: text.default(''),
        goals: text.default(''),
        consent: z.literal(true),
      })
      .parse(req.body);
    const patientId = ownPatient(req, input.patientId);
    patientAccess(req, patientId);
    const intake = { ...input, patientId, id: id(), createdAt: nowISO() };
    insert(db, 'intakes', intake);
    audit(req, 'submitted intake', 'intake', intake.id);
    res.status(201).json(intake);
  });
  app.post('/api/encounters', (req: AuthRequest, res) => {
    const doctorId = clinicianId(req);
    const input = z
      .object({
        patientId: required,
        appointmentId: required.optional(),
        history: text.default(''),
        examination: text.default(''),
        assessment: text.min(1),
        investigations: text.default(''),
        plan: text.min(1),
      })
      .parse(req.body);
    patientAccess(req, input.patientId);
    if (input.appointmentId) {
      const a = get<Appointment>(db, 'appointments', input.appointmentId);
      if (!a || a.patientId !== input.patientId)
        fail(400, 'The appointment must belong to this patient.');
    }
    const encounter = {
      ...input,
      id: id(),
      doctorId,
      doctorName: get<Doctor>(db, 'doctors', doctorId)!.name,
      createdAt: nowISO(),
    };
    insert(db, 'encounters', encounter);
    audit(req, 'recorded consultation', 'encounter', encounter.id);
    res.status(201).json(encounter);
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
  app.post('/api/care-plans', (req: AuthRequest, res) => {
    const doctorId = clinicianId(req);
    const input = z
      .object({
        patientId: required,
        title: required,
        instructions: text.min(1),
        expectations: text.default(''),
        warnings: text.default(''),
        cost: short.default(''),
        startDate: date,
        endDate: date,
        followUpDate: date,
        medications: z
          .array(
            z.object({
              name: required,
              instructions: text.min(1),
              schedule: required,
              duration: required,
              warnings: text.default(''),
            }),
          )
          .max(30),
      })
      .refine((v) => v.endDate >= v.startDate, 'End date must not precede start date')
      .refine((v) => v.followUpDate >= v.startDate, 'Follow-up must not precede start date')
      .parse(req.body);
    const p = patientAccess(req, input.patientId);
    const plan: CarePlan = {
      ...input,
      id: id(),
      doctorId,
      doctorName: get<Doctor>(db, 'doctors', doctorId)!.name,
      patientName: p.name,
      status: 'active',
      createdAt: nowISO(),
    };
    scheduling.transaction(() => {
      insert(db, 'carePlans', plan);
      audit(req, 'created care plan', 'carePlan', plan.id);
      notifyPatient(db, plan.patientId, `care-plan-created:${plan.id}`, {
        kind: 'care-plan',
        title: 'Your care plan is ready',
        detail: plan.title,
        href: `/my-care?plan=${encodeURIComponent(plan.id)}`,
      });
    });
    res.status(201).json(plan);
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
  app.post('/api/check-ins', (req: AuthRequest, res) => {
    moduleEnabled('followUp');
    const user = actor(req, ['patient']);
    const input = z
      .object({
        carePlanId: required,
        date,
        adherence: z.enum(['taken', 'partial', 'missed']),
        feeling: z.enum(['better', 'same', 'worse']),
        note: text.default(''),
      })
      .parse(req.body);
    const plan = get<CarePlan>(db, 'carePlans', input.carePlanId);
    if (!plan) return fail(404, 'Care plan not found.');
    patientAccess(req, plan.patientId);
    if (plan.status !== 'active') fail(409, 'This care plan is completed.');
    if (input.date < plan.startDate || input.date > plan.endDate || input.date > clinicToday())
      fail(400, 'Check-ins must be within the plan dates and cannot be in the future.');
    const existing = db
      .prepare('SELECT id FROM checkIns WHERE carePlanId=? AND date=?')
      .get(plan.id, input.date) as { id: string } | undefined;
    const check: CheckIn = {
      ...input,
      id: existing?.id ?? id(),
      patientId: user.patientId!,
      createdAt: nowISO(),
    };
    scheduling.transaction(() => {
      db.prepare(
        'INSERT INTO checkIns(id,patientId,carePlanId,date,data) VALUES (?,?,?,?,?) ON CONFLICT(carePlanId,date) DO UPDATE SET data=excluded.data',
      ).run(check.id, check.patientId, check.carePlanId, check.date, JSON.stringify(check));
      audit(
        req,
        existing ? 'updated daily check-in' : 'recorded daily check-in',
        'checkIn',
        check.id,
      );
      notifyClinicians(
        db,
        check.patientId,
        `check-in:${check.id}:${digest(JSON.stringify(check))}`,
        {
          kind: 'check-in',
          title: existing ? 'A patient updated their check-in' : 'A patient shared a check-in',
          detail: `${get<Patient>(db, 'patients', check.patientId)!.name} · ${plan.title}`,
          href: `/clinic/patients/${check.patientId}?tab=care&plan=${plan.id}`,
        },
        { doctorId: followUp.owner(plan).doctorId, excludeActorId: user.id },
      );
    });
    res.status(existing ? 200 : 201).json(check);
  });
  app.post('/api/images', (req: AuthRequest, res) => {
    moduleEnabled('images');
    const input = z
      .object({
        patientId: required.optional(),
        caption: short.min(1),
        category: z.enum(['clinical', 'report']),
        consent: z.literal(true),
        dataUrl: z.string().max(7 * 1024 * 1024),
      })
      .parse(req.body);
    const patientId = ownPatient(req, input.patientId);
    patientAccess(req, patientId);
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      input.dataUrl,
    );
    if (!match) return fail(400, 'Upload a JPEG, PNG or WebP image.');
    const mimeType = match[1],
      bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 5 * 1024 * 1024) fail(413, 'Images must be 5 MB or smaller.');
    if (bytes.length < 12) fail(400, 'The image file is invalid.');
    const valid =
      mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mimeType === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.subarray(0, 4).toString() === 'RIFF' &&
            bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) fail(400, 'The image content does not match its file type.');
    const key = id();
    const image: ClinicalImage = {
      id: key,
      patientId,
      caption: input.caption,
      category: input.category,
      consent: true,
      mimeType,
      createdAt: nowISO(),
      url: `/api/images/${key}/file`,
      ...imageProvenance(bytes, actor(req)),
    };
    scheduling.transaction(() => {
      db.prepare('INSERT INTO images(id,patientId,data,bytes) VALUES (?,?,?,?)').run(
        key,
        patientId,
        JSON.stringify(image),
        bytes,
      );
      audit(req, 'uploaded private image', 'image', key);
    });
    res.status(201).json(image);
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
  app.get('/api/messages', (req: AuthRequest, res) => {
    const input = z.object({ patientId: required.optional() }).parse(req.query);
    const patientId = ownPatient(req, input.patientId);
    patientAccess(req, patientId);
    res.json(list<Message>(db, 'messages', patientId).reverse());
  });
  app.post('/api/messages', (req: AuthRequest, res) => {
    moduleEnabled('followUp');
    const user = actor(req);
    const input = z
      .object({ patientId: required.optional(), body: text.min(1).max(4000) })
      .parse(req.body);
    const patientId = ownPatient(req, input.patientId);
    patientAccess(req, patientId);
    const message: Message = {
      id: id(),
      patientId,
      body: input.body,
      authorName: user.name,
      authorRole: user.role,
      createdAt: nowISO(),
    };
    scheduling.transaction(() => {
      insert(db, 'messages', message);
      audit(req, 'sent care message', 'message', message.id);
      if (user.role === 'patient')
        notifyClinicians(
          db,
          patientId,
          `message:${message.id}`,
          {
            kind: 'message',
            title: 'A patient sent a message',
            detail: user.name,
            href: `/clinic/patients/${patientId}?tab=messages`,
          },
          { excludeActorId: user.id },
        );
      else
        notifyPatient(db, patientId, `message:${message.id}`, {
          kind: 'message',
          title: 'Your clinic sent a message',
          detail: 'Open your private conversation to read it.',
          href: '/my-care/messages',
        });
    });
    res.status(201).json(message);
  });
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
  registerAppointmentSeries(app, { db, actor, audit, fail, patientAccess, scheduling });
  registerRecordSearch(app, { db, actor, fail });
  registerAttendance(app, { db, actor, audit, fail });
  waitlist.register(app);
  registerActivity(app, { db, actor, audit, fail });
  registerDocuments(app, { db, actor, patientAccess, audit, fail });
  registerOperations(app, { db, demoMode, actor, patientAccess, audit, fail });
  registerPatientProfile(app, { db, actor, patientAccess, clinicianId, audit, fail });
  const clinicalWorkflows = registerClinical(app, {
    db,
    actor,
    patientAccess,
    clinicianId,
    audit,
    fail,
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
  registerCareSummary(app, {
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
  registerInsights(app, { db, actor, audit, fail });
  registerInventory(app, { db, actor, audit, fail });
  followUp.register(app, followUpEscalation.states);
  followUpEscalation.register(app);
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
