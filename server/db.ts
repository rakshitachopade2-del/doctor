import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Doctor, Patient, ClinicSettings, User } from '../shared/types.ts';

export const id = () => randomUUID();
export const nowISO = () => new Date().toISOString();
export const clinicToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, hash: string) {
  const [salt, expected] = hash.split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const b = Buffer.from(expected, 'hex');
  return actual.length === b.length && timingSafeEqual(actual, b);
}
export const defaultSettings: ClinicSettings = {
  name: 'Derma Studio',
  tagline: 'Thoughtful care. Healthier skin.',
  phone: '',
  email: '',
  address: 'Clinic location not yet configured',
  hours: 'Monday–Saturday, 9:00 AM–6:00 PM',
  timezone: 'Asia/Kolkata',
  modules: { intake: true, images: true, followUp: true },
};
export function openDatabase(path = process.env.DATABASE_PATH || 'data/clinic.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL, role TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrfToken TEXT NOT NULL, expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS doctors (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), doctorId TEXT NOT NULL REFERENCES doctors(id), date TEXT NOT NULL, time TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS unique_active_doctor_slot ON appointments(doctorId,date,time) WHERE status NOT IN ('cancelled','no-show');
    CREATE UNIQUE INDEX IF NOT EXISTS unique_active_patient_slot ON appointments(patientId,date,time) WHERE status NOT IN ('cancelled','no-show');
    CREATE INDEX IF NOT EXISTS appointments_patient ON appointments(patientId,date);
    CREATE TABLE IF NOT EXISTS intakes (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS encounters (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS carePlans (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS checkIns (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), carePlanId TEXT NOT NULL REFERENCES carePlans(id), date TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(carePlanId,date));
    CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS prevent_audit_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'Audit records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_audit_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'Audit records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_encounter_update BEFORE UPDATE ON encounters BEGIN SELECT RAISE(ABORT, 'Encounter records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_encounter_delete BEFORE DELETE ON encounters BEGIN SELECT RAISE(ABORT, 'Encounter records are append-only'); END;
  `);
  db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run(
    'settings',
    JSON.stringify(defaultSettings),
  );
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
export function get<T>(db: DB, table: string, key: string): T | undefined {
  const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key) as
    { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : undefined;
}
export function list<T>(db: DB, table: string, patientId?: string): T[] {
  const rows = patientId
    ? db.prepare(`SELECT data FROM ${table} WHERE patientId=? ORDER BY rowid DESC`).all(patientId)
    : db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all();
  return rows.map((r) => JSON.parse(r.data as string) as T);
}
export function insert(db: DB, table: string, data: { id: string; patientId?: string }) {
  if (data.patientId)
    db.prepare(`INSERT INTO ${table}(id,patientId,data) VALUES (?,?,?)`).run(
      data.id,
      data.patientId,
      JSON.stringify(data),
    );
  else db.prepare(`INSERT INTO ${table}(id,data) VALUES (?,?)`).run(data.id, JSON.stringify(data));
}
export function settings(db: DB): ClinicSettings {
  return JSON.parse(
    (db.prepare('SELECT value FROM meta WHERE key=?').get('settings') as { value: string }).value,
  );
}
export function createUser(db: DB, user: User, password: string) {
  db.prepare('INSERT INTO users(id,email,password,role,data) VALUES (?,?,?,?,?)').run(
    user.id,
    user.email.toLowerCase(),
    hashPassword(password),
    user.role,
    JSON.stringify(user),
  );
}
export function seedDemo(db: DB) {
  if (db.prepare('SELECT 1 FROM meta WHERE key=?').get('demo-seeded')) return;
  if ((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n > 0) return;
  const today = clinicToday();
  const doctors: Doctor[] = [
    {
      id: 'doctor-meera',
      name: 'Dr. Meera Shah',
      title: 'Consultant Dermatologist',
      qualifications: 'MBBS, MD Dermatology',
      specialties: ['Acne', 'Pigmentation', 'General dermatology'],
      experience: 12,
      fee: 800,
      bio: 'A thoughtful, long-term approach to skin health, with a focus on helping you understand every step of your care. Fictional profile for demonstration.',
      languages: ['English', 'Hindi', 'Marathi'],
      color: '#b3c7aa',
    },
    {
      id: 'doctor-arjun',
      name: 'Dr. Arjun Rao',
      title: 'Dermatologist & Hair Specialist',
      qualifications: 'MBBS, MD Dermatology',
      specialties: ['Hair & scalp', 'Eczema', 'Psoriasis'],
      experience: 9,
      fee: 700,
      bio: 'Personalized care for chronic skin concerns and hair health, with clear plans and consistent follow-up. Fictional profile for demonstration.',
      languages: ['English', 'Hindi', 'Kannada'],
      color: '#d7bfa9',
    },
  ];
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE meta SET value=? WHERE key=?').run(
      JSON.stringify({
        ...defaultSettings,
        phone: '+91 80000 00000',
        email: 'hello@derma.example',
        address: '12, Garden Avenue, Pune, Maharashtra · Demo clinic',
      }),
      'settings',
    );
    for (const doctor of doctors) insert(db, 'doctors', doctor);
    const names = [
      'Ananya Sharma',
      'Rohan Patel',
      'Priya Mehta',
      'Vikram Desai',
      'Kavya Nair',
      'Arjun Kulkarni',
      'Isha Verma',
      'Rahul Joshi',
      'Sneha Kapoor',
      'Aditya Rao',
      'Neha Gupta',
      'Dev Shah',
    ];
    const patients: Patient[] = names.map((name, i) => ({
      id: i === 0 ? 'patient-ananya' : `patient-${i + 1}`,
      name,
      email: i === 0 ? 'patient@derma.demo' : `patient${i + 1}@derma.demo`,
      phone: `90000000${String(i + 10)}`,
      dob: `${1990 + (i % 10)}-0${(i % 9) + 1}-12`,
      gender: i % 2 === 0 ? 'Female' : 'Male',
      allergies: i === 0 ? 'No known allergies (patient reported)' : '',
      createdAt: new Date(Date.now() - (30 - i) * 86400000).toISOString(),
    }));
    for (const patient of patients) insert(db, 'patients', patient);
    createUser(
      db,
      {
        id: 'user-doctor',
        name: doctors[0].name,
        email: 'doctor@derma.demo',
        role: 'doctor',
        doctorId: doctors[0].id,
      },
      'DemoClinic2026!',
    );
    createUser(
      db,
      {
        id: 'user-reception',
        name: 'Nisha Kulkarni',
        email: 'reception@derma.demo',
        role: 'receptionist',
      },
      'DemoClinic2026!',
    );
    createUser(
      db,
      {
        id: 'user-admin',
        name: 'Clinic administrator',
        email: 'admin@derma.demo',
        role: 'admin',
        doctorId: doctors[0].id,
      },
      'DemoClinic2026!',
    );
    createUser(
      db,
      {
        id: 'user-patient',
        name: patients[0].name,
        email: 'patient@derma.demo',
        role: 'patient',
        patientId: patients[0].id,
      },
      'DemoClinic2026!',
    );
    for (let day = -6; day <= 5; day++) {
      const date = addDays(today, day);
      if (new Date(`${date}T12:00:00Z`).getUTCDay() === 0 && day !== 0) continue;
      for (let j = 0; j < (day === 0 ? 8 : day < 0 ? 3 + (Math.abs(day) % 4) : 3); j++) {
        const p = patients[(j + Math.abs(day) * 2) % patients.length],
          d = doctors[j % 2];
        const status =
          day < 0
            ? 'completed'
            : day === 0
              ? [
                  'completed',
                  'checked-in',
                  'scheduled',
                  'in-consultation',
                  'scheduled',
                  'scheduled',
                  'scheduled',
                  'scheduled',
                ][j]
              : 'scheduled';
        const appointment = {
          id: id(),
          patientId: p.id,
          doctorId: d.id,
          date,
          time: `${String(9 + Math.floor(j / 2)).padStart(2, '0')}:${j % 2 ? '30' : '00'}`,
          mode: j % 4 === 3 ? 'online' : 'in-person',
          reason: [
            'Skin consultation',
            'Follow-up review',
            'Hair & scalp concern',
            'Routine skin review',
          ][j % 4],
          status,
          patientName: p.name,
          doctorName: d.name,
          fee: d.fee,
          createdAt: nowISO(),
        };
        db.prepare(
          'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
        ).run(
          appointment.id,
          p.id,
          d.id,
          date,
          appointment.time,
          status,
          JSON.stringify(appointment),
        );
      }
    }
    for (let i = 0; i < 5; i++) {
      const p = patients[i],
        d = doctors[i % 2];
      const plan = {
        id: `plan-${i + 1}`,
        patientId: p.id,
        doctorId: d.id,
        title: [
          'Skin barrier care',
          'Scalp care follow-up',
          'Skin health review',
          'Ongoing care plan',
          'Routine skin care',
        ][i],
        instructions:
          'Follow the instructions discussed with your clinician. Keep a short note of changes and bring your questions to the next visit.',
        expectations: 'Your clinician will assess progress at your follow-up appointment.',
        warnings:
          'Contact the clinic if you have a new concern. This is a synthetic demonstration plan, not a prescription.',
        cost: 'Discuss with your clinician',
        startDate: addDays(today, -14),
        endDate: addDays(today, 28),
        followUpDate: addDays(today, i - 2),
        medications: [
          {
            name: 'Demo care step',
            instructions: 'Example instruction — replace with clinician-approved care.',
            schedule: 'Morning',
            duration: 'Until review',
            warnings: 'Demonstration only; no medication is prescribed.',
          },
        ],
        status: 'active',
        createdAt: new Date(Date.now() - 14 * 86400000).toISOString(),
        patientName: p.name,
        doctorName: d.name,
      };
      insert(db, 'carePlans', plan);
      for (let day = -5; day < 0; day++) {
        const check = {
          id: id(),
          carePlanId: plan.id,
          patientId: p.id,
          date: addDays(today, day),
          adherence: day === -3 ? 'partial' : 'taken',
          feeling: 'same',
          note: day === -3 ? 'Missed part of my routine.' : '',
          createdAt: new Date(Date.now() + day * 86400000).toISOString(),
        };
        db.prepare(
          'INSERT INTO checkIns(id,patientId,carePlanId,date,data) VALUES (?,?,?,?,?)',
        ).run(check.id, p.id, plan.id, check.date, JSON.stringify(check));
      }
      insert(db, 'encounters', {
        id: id(),
        patientId: p.id,
        doctorId: d.id,
        history: 'Synthetic demonstration history. Follow-up for an ongoing skin concern.',
        examination: 'Demonstration encounter. No real clinical observations.',
        assessment: 'Clinician review and documentation example.',
        investigations: 'No investigations recorded.',
        plan: 'Discuss care, document patient questions, arrange a follow-up.',
        createdAt: new Date(Date.now() - 14 * 86400000).toISOString(),
        doctorName: d.name,
      } as any);
    }
    insert(db, 'intakes', {
      id: id(),
      patientId: patients[0].id,
      concern: 'Skin irritation',
      location: 'Face',
      duration: 'A few weeks',
      symptoms: 'Intermittent dryness',
      triggers: 'Unsure',
      previousTreatment: 'No prior treatment recorded',
      medications: 'None reported',
      allergies: 'None reported',
      goals: 'Understand the concern and agree on a care plan',
      consent: true,
      createdAt: new Date(Date.now() - 15 * 86400000).toISOString(),
    } as any);
    insert(db, 'messages', {
      id: id(),
      patientId: patients[0].id,
      authorName: doctors[0].name,
      authorRole: 'doctor',
      body: 'Welcome to your care space. You can track your routine here and send us questions ahead of your follow-up. This inbox is not monitored for emergencies.',
      createdAt: new Date(Date.now() - 86400000).toISOString(),
    } as any);
    db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('demo-seeded', 'true');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
