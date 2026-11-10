import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { clinicToday, addDays, openDatabase, createUser } from '../server/db.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server, base: string;
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  patient: Client = {},
  reception: Client = {},
  admin: Client = {},
  outsider: Client = {};
async function call(
  path: string,
  {
    method = 'GET',
    body,
    client = {},
    csrf = true,
    headers = {},
  }: {
    method?: string;
    body?: unknown;
    client?: Client;
    csrf?: boolean;
    headers?: Record<string, string>;
  } = {},
) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf && csrf ? { 'X-CSRF-Token': client.csrf } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = res.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : await res.text();
  if (data?.csrfToken) client.csrf = data.csrfToken;
  return { res, data };
}
async function login(role: string, client: Client) {
  const result = await call('/auth/login', {
    method: 'POST',
    body: { email: `${role}@derma.demo`, password: 'DemoClinic2026!' },
    client,
  });
  assert.equal(result.res.status, 200);
}
function nextDay(offset = 1) {
  let day = addDays(clinicToday(), offset);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() === 0) day = addDays(day, 1);
  return day;
}
before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  base = `http://127.0.0.1:${addr.port}`;
  await login('doctor', doctor);
  await login('patient', patient);
  await login('reception', reception);
  await login('admin', admin);
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  app.locals.close();
});

test('public discovery works while clinical records require authentication', async () => {
  assert.equal((await call('/health')).res.status, 200);
  assert.equal((await call('/doctors')).data.length, 2);
  assert.equal((await call('/settings')).data.timezone, 'Asia/Kolkata');
  assert.equal((await call('/session')).data.user, null);
  assert.equal((await call('/patients')).res.status, 401);
  assert.equal((await call('/appointments')).res.status, 401);
  assert.equal((await call('/patients/patient-ananya')).res.status, 401);
});
test('sessions use secure attributes and enforce CSRF and request origins', async () => {
  const result = await call('/auth/login', {
    method: 'POST',
    body: { email: 'patient@derma.demo', password: 'DemoClinic2026!' },
  });
  assert.match(result.res.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(result.res.headers.get('set-cookie')!, /SameSite=Lax/i);
  assert.equal(
    (
      await call('/messages', {
        method: 'POST',
        body: { body: 'hello' },
        client: patient,
        csrf: false,
      })
    ).res.status,
    403,
  );
  assert.equal(
    (
      await call('/messages', {
        method: 'POST',
        body: { body: 'hello' },
        client: patient,
        headers: { Origin: 'https://evil.example' },
      })
    ).res.status,
    403,
  );
  assert.equal(
    (
      await call('/auth/login', {
        method: 'POST',
        body: { email: 'patient@derma.demo', password: 'wrong' },
      })
    ).res.status,
    401,
  );
  const session = await call('/session', { client: patient });
  assert.equal(session.data.user.patientId, 'patient-ananya');
  assert.equal(session.res.headers.get('cache-control'), 'no-store');
});
test('registration cannot choose a privileged role or access another patient', async () => {
  const registration = await call('/auth/register', {
    method: 'POST',
    client: outsider,
    body: {
      name: 'Test Patient',
      email: 'test@example.test',
      password: 'TestPassword2026!',
      phone: '9000000099',
      dob: '1995-06-15',
      gender: 'Prefer not to say',
      role: 'admin',
    },
  });
  assert.equal(registration.res.status, 201);
  assert.equal(registration.data.user.role, 'patient');
  assert.equal((await call('/patients/patient-ananya', { client: outsider })).res.status, 403);
  assert.equal((await call('/patients', { client: outsider })).res.status, 403);
  assert.equal((await call('/audit', { client: outsider })).res.status, 403);
  const plans = await call('/care-plans', { client: outsider });
  assert.deepEqual(plans.data, []);
  assert.equal(
    (await call('/messages?patientId=patient-ananya', { client: outsider })).res.status,
    403,
  );
});
test('reception sees demographics and bookings, not clinical records, plans or images', async () => {
  const patients = await call('/patients', { client: reception });
  assert.equal(patients.res.status, 200);
  assert.ok(patients.data.every((p: any) => p.allergies === ''));
  assert.equal((await call('/patients/patient-ananya', { client: reception })).res.status, 403);
  assert.equal((await call('/care-plans', { client: reception })).res.status, 403);
  assert.equal(
    (
      await call('/encounters', {
        method: 'POST',
        client: reception,
        body: { patientId: 'patient-ananya', assessment: 'test', plan: 'test' },
      })
    ).res.status,
    403,
  );
  const dashboard = await call('/dashboard', { client: reception });
  assert.equal(dashboard.res.status, 200);
  assert.deepEqual(dashboard.data.followUps, []);
});
let appointmentId = '';
test('booking uses persistent slots, prevents patient and doctor conflicts, and exports calendar', async () => {
  const day = nextDay(2),
    slots = await call(`/slots?doctorId=doctor-meera&date=${day}`);
  assert.ok(slots.data.includes('16:00'));
  const result = await call('/appointments', {
    method: 'POST',
    client: patient,
    body: {
      doctorId: 'doctor-meera',
      date: day,
      time: '16:00',
      mode: 'in-person',
      reason: 'Test visit',
    },
  });
  assert.equal(result.res.status, 201);
  appointmentId = result.data.id;
  const duplicate = await call('/appointments', {
    method: 'POST',
    client: reception,
    body: {
      patientId: 'patient-2',
      doctorId: 'doctor-meera',
      date: day,
      time: '16:00',
      mode: 'in-person',
      reason: 'Conflicting appointment',
    },
  });
  assert.equal(duplicate.res.status, 409);
  const patientConflict = await call('/appointments', {
    method: 'POST',
    client: patient,
    body: {
      doctorId: 'doctor-arjun',
      date: day,
      time: '16:00',
      mode: 'online',
      reason: 'Concurrent appointment',
    },
  });
  assert.equal(patientConflict.res.status, 409);
  assert.ok(!(await call(`/slots?doctorId=doctor-meera&date=${day}`)).data.includes('16:00'));
  const calendar = await call(`/appointments/${appointmentId}/calendar`, { client: patient });
  assert.equal(calendar.res.status, 200);
  assert.match(calendar.data, /BEGIN:VCALENDAR/);
  assert.match(calendar.data, /DTSTART:/);
  assert.equal(
    (await call(`/appointments/${appointmentId}/calendar`, { client: outsider })).res.status,
    403,
  );
});
test('concurrent requests cannot double-book a doctor slot', async () => {
  const results = await Promise.all(
    ['patient-2', 'patient-3', 'patient-4'].map((patientId) =>
      call('/appointments', {
        method: 'POST',
        client: reception,
        body: {
          patientId,
          doctorId: 'doctor-meera',
          date: nextDay(4),
          time: '17:00',
          mode: 'in-person',
          reason: 'Concurrent booking test',
        },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.res.status).sort(), [201, 409, 409]);
});
test('walk-in registration accepts missing optional contact details', async () => {
  const result = await call('/patients', {
    method: 'POST',
    client: reception,
    body: {
      name: 'Walk-in Patient',
      phone: '9000000088',
      email: '',
      dob: '',
      gender: 'Not specified',
      allergies: '',
    },
  });
  assert.equal(result.res.status, 201);
  assert.equal(result.data.email, '');
  assert.equal(result.data.dob, '');
});
test('appointments reject impossible dates, Sundays, past times, invalid states and ownership changes', async () => {
  for (const date of ['2026-02-30', '2020-01-01'])
    assert.equal(
      (
        await call('/appointments', {
          method: 'POST',
          client: patient,
          body: {
            doctorId: 'doctor-meera',
            date,
            time: '12:00',
            mode: 'in-person',
            reason: 'test',
          },
        })
      ).res.status,
      400,
    );
  let sunday = nextDay(1);
  while (new Date(`${sunday}T12:00:00Z`).getUTCDay() !== 0) sunday = addDays(sunday, 1);
  assert.deepEqual((await call(`/slots?doctorId=doctor-meera&date=${sunday}`)).data, []);
  assert.equal(
    (
      await call(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        client: outsider,
        body: { status: 'cancelled' },
      })
    ).res.status,
    403,
  );
  assert.equal(
    (
      await call(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        client: patient,
        body: { status: 'completed' },
      })
    ).res.status,
    403,
  );
  assert.equal(
    (
      await call(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        client: doctor,
        body: { status: 'completed' },
      })
    ).res.status,
    409,
  );
  assert.equal(
    (
      await call(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        client: doctor,
        body: { status: 'checked-in' },
      })
    ).res.status,
    400,
  );
  assert.equal(
    (
      await call(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        client: patient,
        body: { time: '16:30' },
      })
    ).res.status,
    200,
  );
  assert.equal(
    (
      await call(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        client: patient,
        body: { status: 'cancelled' },
      })
    ).res.status,
    200,
  );
  assert.equal(
    (
      await call(`/appointments/${appointmentId}`, {
        method: 'PATCH',
        client: doctor,
        body: { status: 'scheduled' },
      })
    ).res.status,
    409,
  );
});
test('structured intakes require consent and keep clinician-only notes private', async () => {
  const input = {
    concern: 'Itch',
    location: 'Arm',
    duration: '2 weeks',
    symptoms: 'Dryness',
    consent: true,
  };
  assert.equal(
    (
      await call('/intakes', {
        method: 'POST',
        client: patient,
        body: { ...input, consent: false },
      })
    ).res.status,
    400,
  );
  assert.equal(
    (await call('/intakes', { method: 'POST', client: patient, body: input })).res.status,
    201,
  );
  assert.equal(
    (
      await call('/encounters', {
        method: 'POST',
        client: doctor,
        body: {
          patientId: 'patient-ananya',
          assessment: 'Clinical review documented.',
          plan: 'Review at next appointment.',
        },
      })
    ).res.status,
    201,
  );
  const own = await call('/patients/patient-ananya', { client: patient });
  assert.deepEqual(own.data.encounters, []);
  assert.ok(own.data.intakes.length >= 2);
  const clinical = await call('/patients/patient-ananya', { client: doctor });
  assert.ok(clinical.data.encounters.length >= 2);
});
let carePlanId = '';
test('care plan creation validates dates and check-ins enforce ownership and daily uniqueness', async () => {
  const input = {
    patientId: 'patient-ananya',
    title: 'Test care plan',
    instructions: 'Record your care routine.',
    expectations: 'Review at follow-up',
    warnings: 'Test only',
    cost: '0',
    startDate: addDays(clinicToday(), -1),
    endDate: addDays(clinicToday(), 7),
    followUpDate: addDays(clinicToday(), 7),
    medications: [],
  };
  assert.equal(
    (await call('/care-plans', { method: 'POST', client: patient, body: input })).res.status,
    403,
  );
  assert.equal(
    (
      await call('/care-plans', {
        method: 'POST',
        client: doctor,
        body: { ...input, endDate: addDays(clinicToday(), -2) },
      })
    ).res.status,
    400,
  );
  const plan = await call('/care-plans', { method: 'POST', client: doctor, body: input });
  assert.equal(plan.res.status, 201);
  carePlanId = plan.data.id;
  const check = {
    carePlanId,
    date: clinicToday(),
    adherence: 'taken',
    feeling: 'same',
    note: 'Test check-in',
  };
  assert.equal(
    (await call('/check-ins', { method: 'POST', client: outsider, body: check })).res.status,
    403,
  );
  const saved = await call('/check-ins', { method: 'POST', client: patient, body: check });
  assert.equal(saved.res.status, 201);
  const updated = await call('/check-ins', {
    method: 'POST',
    client: patient,
    body: { ...check, adherence: 'partial' },
  });
  assert.equal(updated.res.status, 200);
  assert.equal(updated.data.id, saved.data.id);
  assert.equal(
    (
      await call('/check-ins', {
        method: 'POST',
        client: patient,
        body: { ...check, date: addDays(clinicToday(), 1) },
      })
    ).res.status,
    400,
  );
  assert.equal(
    (
      await call(`/care-plans/${carePlanId}`, {
        method: 'PATCH',
        client: doctor,
        body: { status: 'completed' },
      })
    ).res.status,
    200,
  );
  assert.equal(
    (await call('/check-ins', { method: 'POST', client: patient, body: check })).res.status,
    409,
  );
});
test('clinical image bytes and provenance stay private and fake types are rejected', async () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCeoAAAAASUVORK5CYII=';
  const input = {
    caption: 'Synthetic test pixel',
    category: 'clinical',
    consent: true,
    dataUrl: png,
  };
  assert.equal(
    (await call('/images', { method: 'POST', client: patient, body: { ...input, consent: false } }))
      .res.status,
    400,
  );
  assert.equal(
    (
      await call('/images', {
        method: 'POST',
        client: patient,
        body: { ...input, dataUrl: 'data:image/png;base64,SGVsbG8sIG5vdCBhbiBpbWFnZQ==' },
      })
    ).res.status,
    400,
  );
  assert.equal(
    (
      await call('/images', {
        method: 'POST',
        client: reception,
        body: { ...input, patientId: 'patient-ananya' },
      })
    ).res.status,
    403,
  );
  const uploaded = await call('/images', { method: 'POST', client: patient, body: input });
  assert.equal(uploaded.res.status, 201);
  assert.equal(uploaded.data.consent, true);
  const path = uploaded.data.url.replace('/api', '');
  assert.equal((await call(path)).res.status, 401);
  assert.equal((await call(path, { client: outsider })).res.status, 403);
  assert.equal((await call(path, { client: doctor })).res.status, 200);
});
test('messages are threaded by patient and preserve authenticated authorship', async () => {
  const sent = await call('/messages', {
    method: 'POST',
    client: patient,
    body: { body: 'I have a question for my follow-up.', authorRole: 'doctor' },
  });
  assert.equal(sent.res.status, 201);
  assert.equal(sent.data.authorRole, 'patient');
  const reply = await call('/messages', {
    method: 'POST',
    client: doctor,
    body: { patientId: 'patient-ananya', body: 'Please bring your questions to the visit.' },
  });
  assert.equal(reply.res.status, 201);
  const thread = await call('/messages', { client: patient });
  assert.ok(thread.data.some((m: any) => m.id === reply.data.id));
  assert.equal(
    (await call('/messages?patientId=patient-ananya', { client: reception })).res.status,
    403,
  );
});
test('module switches are enforced server-side and audit records are append-only', async () => {
  assert.equal(
    (await call('/settings', { method: 'PATCH', client: doctor, body: { name: 'Unauthorized' } }))
      .res.status,
    403,
  );
  assert.equal(
    (
      await call('/settings', {
        method: 'PATCH',
        client: admin,
        body: { modules: { intake: false, images: false, followUp: false } },
      })
    ).res.status,
    200,
  );
  assert.equal(
    (await call('/intakes', { method: 'POST', client: patient, body: {} })).res.status,
    403,
  );
  assert.equal(
    (await call('/images', { method: 'POST', client: patient, body: {} })).res.status,
    403,
  );
  assert.equal(
    (await call('/messages', { method: 'POST', client: patient, body: { body: 'test' } })).res
      .status,
    403,
  );
  await call('/settings', {
    method: 'PATCH',
    client: admin,
    body: { modules: { intake: true, images: true, followUp: true } },
  });
  const audit = await call('/audit', { client: admin });
  assert.equal(audit.res.status, 200);
  assert.ok(audit.data.some((e: any) => e.action === 'viewed care record'));
  assert.ok(audit.data.some((e: any) => e.action === 'uploaded private image'));
  assert.throws(() => app.locals.db.exec('DELETE FROM audit'), /append-only/);
  assert.throws(() => app.locals.db.exec("UPDATE encounters SET data='{}'"), /append-only/);
});
test('admin can provision doctors and staff; account password changes revoke other sessions', async () => {
  const doctorInput = {
    name: 'Dr. Test',
    title: 'Dermatologist',
    qualifications: 'Demo qualification',
    specialties: ['General dermatology'],
    experience: 3,
    fee: 650,
    bio: 'Test profile',
    languages: ['English'],
    color: '#b3c7aa',
  };
  const profile = await call('/doctors', { method: 'POST', client: admin, body: doctorInput });
  assert.equal(profile.res.status, 201);
  assert.equal(
    (
      await call('/users', {
        method: 'POST',
        client: admin,
        body: {
          name: 'Test Doctor',
          email: 'staff@example.test',
          password: 'StaffPassword2026!',
          role: 'doctor',
        },
      })
    ).res.status,
    400,
  );
  const staff = await call('/users', {
    method: 'POST',
    client: admin,
    body: {
      name: 'Test Doctor',
      email: 'staff@example.test',
      password: 'StaffPassword2026!',
      role: 'doctor',
      doctorId: profile.data.id,
    },
  });
  assert.equal(staff.res.status, 201);
  assert.ok(!('password' in staff.data));
  assert.equal(
    (
      await call(`/doctors/${profile.data.id}`, {
        method: 'PATCH',
        client: admin,
        body: { ...doctorInput, fee: 750 },
      })
    ).data.fee,
    750,
  );
  const second: Client = {};
  await call('/auth/login', {
    method: 'POST',
    client: second,
    body: { email: 'test@example.test', password: 'TestPassword2026!' },
  });
  assert.equal(
    (
      await call('/auth/password', {
        method: 'POST',
        client: outsider,
        body: { currentPassword: 'wrong', newPassword: 'ChangedPassword2026!' },
      })
    ).res.status,
    400,
  );
  assert.equal(
    (
      await call('/auth/password', {
        method: 'POST',
        client: outsider,
        body: { currentPassword: 'TestPassword2026!', newPassword: 'ChangedPassword2026!' },
      })
    ).res.status,
    200,
  );
  assert.equal((await call('/session', { client: second })).data.user, null);
  assert.ok((await call('/session', { client: outsider })).data.user);
  assert.equal(
    (await call('/auth/logout', { method: 'POST', client: outsider, body: {} })).res.status,
    200,
  );
  assert.equal((await call('/session', { client: outsider })).data.user, null);
});
test('unlinked administrators cannot attribute clinical documents to an arbitrary doctor', async () => {
  const account = await call('/users', {
    method: 'POST',
    client: admin,
    body: {
      name: 'Unlinked administrator',
      email: 'unlinked-admin@example.test',
      password: 'UnlinkedAdmin2026!',
      role: 'admin',
    },
  });
  assert.equal(account.res.status, 201);
  assert.equal(account.data.doctorId, undefined);
  const unlinked: Client = {};
  assert.equal(
    (
      await call('/auth/login', {
        method: 'POST',
        client: unlinked,
        body: { email: 'unlinked-admin@example.test', password: 'UnlinkedAdmin2026!' },
      })
    ).res.status,
    200,
  );
  assert.equal(
    (
      await call('/auth/password', {
        method: 'POST',
        client: unlinked,
        body: { currentPassword: 'UnlinkedAdmin2026!', newPassword: 'RotatedAdmin2026!' },
      })
    ).res.status,
    200,
  );
  for (const path of ['/encounters', '/care-plans']) {
    const result = await call(path, {
      method: 'POST',
      client: unlinked,
      body: {
        patientId: 'patient-ananya',
        doctorId: 'doctor-meera',
        assessment: 'Test',
        plan: 'Test',
      },
    });
    assert.equal(result.res.status, 400);
    assert.match(result.data.error, /linked doctor account/);
  }
  assert.equal((await call('/patients/patient-ananya', { client: unlinked })).res.status, 200);
});
test('expired server sessions cannot read records or use an old CSRF token for writes', async () => {
  const expired: Client = {};
  const session = await call('/auth/login', {
    method: 'POST',
    client: expired,
    body: { email: 'unlinked-admin@example.test', password: 'RotatedAdmin2026!' },
  });
  assert.equal(session.res.status, 200);
  app.locals.db
    .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
    .run(Date.now() - 1, session.data.user.id);
  assert.equal((await call('/session', { client: expired })).data.user, null);
  assert.equal((await call('/patients', { client: expired })).res.status, 401);
  assert.equal(
    (
      await call('/messages', {
        method: 'POST',
        client: expired,
        body: { patientId: 'patient-ananya', body: 'Expired session message' },
      })
    ).res.status,
    401,
  );
});
test('database survives reopen, production blocks demo data, and fresh production has no demo accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'derma-test-')),
    path = join(dir, 'clinic.sqlite');
  try {
    const seeded = createApp({ databasePath: path, demoMode: true });
    seeded.locals.close();
    const reopened = createApp({ databasePath: path, demoMode: true });
    assert.equal(
      reopened.locals.db.prepare('SELECT count(*) AS count FROM patients').get().count,
      12,
    );
    reopened.locals.close();
    assert.throws(
      () => createApp({ databasePath: path, production: true, demoMode: false }),
      /demo database/,
    );
    assert.throws(
      () => createApp({ databasePath: ':memory:', production: true, demoMode: true }),
      /disabled in production/,
    );
    const prod = createApp({ databasePath: ':memory:', production: true, demoMode: false });
    assert.equal(prod.locals.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
    prod.locals.close();
    const db = openDatabase(join(dir, 'clean.sqlite'));
    createUser(
      db,
      { id: 'administrator', name: 'Clinic admin', email: 'admin@example.test', role: 'admin' },
      'StrongPassword2026!',
    );
    assert.equal(db.prepare('SELECT role FROM users').get()!.role, 'admin');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
