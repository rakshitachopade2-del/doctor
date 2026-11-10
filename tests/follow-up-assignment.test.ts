import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser } from '../server/db.ts';
import type { CarePlan } from '../shared/types.ts';
import type { FollowUpAssignment, FollowUpWorkItem } from '../shared/follow-up.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server,
  base: string,
  counter = 0;
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  nextDoctor: Client = {},
  admin: Client = {},
  unlinkedAdmin: Client = {},
  patient: Client = {},
  reception: Client = {};
async function call(path: string, client: Client = {}, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
  return { status: response.status, data };
}
async function plan(): Promise<CarePlan> {
  const result = await call('/care-plans', doctor, 'POST', {
    patientId: 'patient-ananya',
    title: `Assignment fixture ${++counter}`,
    instructions: 'Original care instructions.',
    expectations: '',
    warnings: 'Synthetic test.',
    cost: '',
    startDate: clinicToday(),
    endDate: addDays(clinicToday(), 14),
    followUpDate: clinicToday(),
    medications: [],
  });
  assert.equal(result.status, 201);
  return result.data;
}
async function work(planId: string): Promise<FollowUpWorkItem> {
  const result = await call('/follow-up-worklist?scope=all', admin);
  const item = result.data.find((row: FollowUpWorkItem) => row.carePlan.id === planId);
  assert.ok(item);
  return item;
}
async function assign(
  carePlan: CarePlan,
  client = doctor,
  overrides: Record<string, unknown> = {},
) {
  return call(`/care-plans/${carePlan.id}/assignment`, client, 'POST', {
    doctorId: 'doctor-arjun',
    reason: 'Internal handover note for continued clinic review.',
    expectedRevision: (await work(carePlan.id)).revision,
    ...overrides,
  });
}
async function history(carePlan: CarePlan): Promise<FollowUpAssignment[]> {
  const response = await call(`/care-plans/${carePlan.id}/assignments`, admin);
  assert.equal(response.status, 200);
  return response.data;
}
async function checkIn(carePlan: CarePlan) {
  const result = await call('/check-ins', patient, 'POST', {
    carePlanId: carePlan.id,
    date: clinicToday(),
    adherence: 'partial',
    feeling: 'same',
    note: 'Patient report after handover.',
  });
  assert.equal(result.status, 201);
  return result.data;
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'assignment-next-doctor',
      name: 'Dr. Arjun Rao',
      email: 'assignment-arjun@example.test',
      role: 'doctor',
      doctorId: 'doctor-arjun',
      active: true,
      mustChangePassword: false,
    },
    'AssignmentDoctor2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'assignment-unlinked-admin',
      name: 'Operations administrator',
      email: 'assignment-admin@example.test',
      role: 'admin',
      active: true,
      mustChangePassword: false,
    },
    'AssignmentAdmin2026!',
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const [role, client] of [
    ['doctor', doctor],
    ['admin', admin],
    ['patient', patient],
    ['reception', reception],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', client, 'POST', {
          email: `${role}@derma.demo`,
          password: 'DemoClinic2026!',
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call('/auth/login', nextDoctor, 'POST', {
        email: 'assignment-arjun@example.test',
        password: 'AssignmentDoctor2026!',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call('/auth/login', unlinkedAdmin, 'POST', {
        email: 'assignment-admin@example.test',
        password: 'AssignmentAdmin2026!',
      })
    ).status,
    200,
  );
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  app.locals.close();
});

test('owner choices expose active linked clinician counts without account details', async () => {
  assert.equal((await call('/follow-up-owners')).status, 401);
  assert.equal((await call('/follow-up-owners', patient)).status, 403);
  assert.equal((await call('/follow-up-owners', reception)).status, 403);
  const owners = (await call('/follow-up-owners', doctor)).data;
  assert.equal(owners.find((row: any) => row.doctorId === 'doctor-meera').activeAccounts, 2);
  assert.equal(owners.find((row: any) => row.doctorId === 'doctor-arjun').activeAccounts, 1);
  assert.ok(
    owners.every(
      (row: any) => Object.keys(row).sort().join(',') === 'activeAccounts,doctorId,doctorName',
    ),
  );
  const db = app.locals.db;
  const saved = db.prepare('SELECT data FROM users WHERE id=?').get('assignment-next-doctor').data;
  try {
    db.prepare('UPDATE users SET data=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(saved), mustChangePassword: true }),
      'assignment-next-doctor',
    );
    assert.ok(
      (await call('/follow-up-owners', admin)).data.some(
        (row: any) => row.doctorId === 'doctor-arjun',
      ),
    );
    db.prepare('UPDATE users SET data=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(saved), active: false }),
      'assignment-next-doctor',
    );
    assert.ok(
      !(await call('/follow-up-owners', admin)).data.some(
        (row: any) => row.doctorId === 'doctor-arjun',
      ),
    );
  } finally {
    db.prepare('UPDATE users SET data=? WHERE id=?').run(saved, 'assignment-next-doctor');
  }
});

test('assignment changes current ownership and revision while preserving original authorship and immutable history', async () => {
  const carePlan = await plan();
  const before = await work(carePlan.id);
  assert.equal(before.ownerDoctorId, 'doctor-meera');
  assert.deepEqual(await history(carePlan), []);
  const result = await assign(carePlan);
  assert.equal(result.status, 201);
  assert.equal(result.data.doctorId, 'doctor-meera');
  assert.equal(result.data.followUpDate, carePlan.followUpDate);
  assert.notEqual(result.data.followUpRevision, before.revision);
  const after = await work(carePlan.id);
  assert.equal(after.ownerDoctorId, 'doctor-arjun');
  assert.ok(
    !(await call('/follow-up-worklist', doctor)).data.some(
      (row: FollowUpWorkItem) => row.carePlan.id === carePlan.id,
    ),
  );
  assert.ok(
    (await call('/follow-up-worklist', nextDoctor)).data.some(
      (row: FollowUpWorkItem) => row.carePlan.id === carePlan.id,
    ),
  );
  const events = await history(carePlan);
  assert.equal(events.length, 1);
  assert.equal(events[0].previousDoctorId, 'doctor-meera');
  assert.equal(events[0].assignedById, 'user-doctor');
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE followUpAssignments SET data=? WHERE id=?')
        .run('{}', events[0].id),
    /append-only/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM followUpAssignments WHERE id=?').run(events[0].id),
    /append-only/,
  );
});

test('only the current doctor owner or an administrator may assign and same-owner writes are rejected', async () => {
  const carePlan = await plan();
  assert.equal((await assign(carePlan, nextDoctor)).status, 403);
  assert.equal((await assign(carePlan, patient)).status, 403);
  assert.equal((await assign(carePlan, reception)).status, 403);
  assert.equal((await assign(carePlan, doctor, { doctorId: 'doctor-meera' })).status, 409);
  assert.equal((await assign(carePlan)).status, 201);
  assert.equal((await assign(carePlan, doctor, { doctorId: 'doctor-meera' })).status, 403);
  assert.equal((await assign(carePlan, nextDoctor, { doctorId: 'doctor-meera' })).status, 201);
  assert.equal((await assign(carePlan, unlinkedAdmin)).status, 201);
  const events = await history(carePlan);
  assert.equal(events.length, 3);
  assert.equal(events[0].assignedById, 'assignment-unlinked-admin');
  assert.equal(events[1].doctorId, 'doctor-meera');
});

test('assignment validates active linked destinations, bounded reasons and server-owned provenance', async () => {
  const carePlan = await plan();
  for (const changes of [
    { doctorId: 'missing-doctor' },
    { reason: '' },
    { reason: 'x'.repeat(8001) },
    { expectedRevision: 'invalid' },
    { assignedById: 'forged-user' },
  ])
    assert.equal((await assign(carePlan, admin, changes)).status, 400);
  const db = app.locals.db;
  const saved = db.prepare('SELECT data FROM users WHERE id=?').get('assignment-next-doctor').data;
  try {
    db.prepare('UPDATE users SET data=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(saved), active: false }),
      'assignment-next-doctor',
    );
    assert.equal((await assign(carePlan, admin)).status, 400);
    assert.deepEqual(await history(carePlan), []);
  } finally {
    db.prepare('UPDATE users SET data=? WHERE id=?').run(saved, 'assignment-next-doctor');
  }
});

test('assignment invalidates a stale review and newly submitted check-ins invalidate a stale handover', async () => {
  const carePlan = await plan();
  const original = await work(carePlan.id);
  await checkIn(carePlan);
  assert.equal(
    (await assign(carePlan, doctor, { expectedRevision: original.revision })).status,
    409,
  );
  const withReport = await work(carePlan.id);
  assert.equal(withReport.unreviewedCount, 1);
  assert.equal((await assign(carePlan)).status, 201);
  const assigned = await work(carePlan.id);
  assert.equal(assigned.unreviewedCount, 1);
  assert.equal(assigned.latestReview, null);
  assert.equal(
    (
      await call(`/care-plans/${carePlan.id}/reviews`, doctor, 'POST', {
        expectedRevision: withReport.revision,
        assessment: 'Stale assessment',
        patientInstructions: 'Stale instructions',
        disposition: 'continue',
        nextReviewDate: addDays(clinicToday(), 5),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/care-plans/${carePlan.id}/reviews`, nextDoctor, 'POST', {
        expectedRevision: assigned.revision,
        assessment: 'Current assessment',
        patientInstructions: 'Current instructions',
        disposition: 'continue',
        nextReviewDate: addDays(clinicToday(), 5),
      })
    ).status,
    201,
  );
  assert.equal((await work(carePlan.id)).unreviewedCount, 0);
});

test('assignment and subsequent patient check-ins notify the new owner without exposing the handover reason', async () => {
  const carePlan = await plan();
  const privateReason = 'Private clinician handover detail must stay out of notifications.';
  assert.equal((await assign(carePlan, doctor, { reason: privateReason })).status, 201);
  const event = (await history(carePlan))[0];
  const notifications = app.locals.db
    .prepare('SELECT userId,data FROM activity WHERE eventKey=?')
    .all(`follow-up-assignment:${event.id}`);
  assert.deepEqual(
    notifications.map((row: any) => row.userId),
    ['assignment-next-doctor'],
  );
  assert.ok(!JSON.stringify(notifications).includes(privateReason));
  const report = await checkIn(carePlan);
  const checkRecipients = app.locals.db
    .prepare('SELECT userId FROM activity WHERE eventKey LIKE ?')
    .all(`check-in:${report.id}:%`);
  assert.deepEqual(
    checkRecipients.map((row: any) => row.userId),
    ['assignment-next-doctor'],
  );
  for (const url of [
    '/care-plans',
    `/patients/${carePlan.patientId}`,
    `/care-plans/${carePlan.id}/reviews`,
    '/activity',
  ]) {
    const response = await call(url, patient);
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(response.data).includes(privateReason));
    assert.ok(!JSON.stringify(response.data).includes('assignedById'));
  }
  assert.equal((await call(`/care-plans/${carePlan.id}/assignments`, patient)).status, 403);
  assert.equal((await call(`/care-plans/${carePlan.id}/assignments`, reception)).status, 403);
});

test('operational ownership can be reassigned while new follow-up activity is paused', async () => {
  const carePlan = await plan();
  const saved = (await call('/settings', admin)).data;
  assert.equal(
    (await call('/settings', admin, 'PATCH', { modules: { ...saved.modules, followUp: false } }))
      .status,
    200,
  );
  try {
    assert.equal((await assign(carePlan, admin)).status, 201);
    assert.equal((await work(carePlan.id)).ownerDoctorId, 'doctor-arjun');
    assert.equal((await history(carePlan)).length, 1);
  } finally {
    assert.equal((await call('/settings', admin, 'PATCH', { modules: saved.modules })).status, 200);
  }
});

test('concurrent assignments using the same revision create only one handover', async () => {
  const carePlan = await plan();
  const expectedRevision = (await work(carePlan.id)).revision;
  const outcomes = await Promise.all([
    assign(carePlan, admin, { expectedRevision }),
    assign(carePlan, unlinkedAdmin, { expectedRevision }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [201, 409]);
  assert.equal((await history(carePlan)).length, 1);
});

test('notification failure rolls back assignment, revision, ownership and audit together', async () => {
  const carePlan = await plan();
  const before = await work(carePlan.id);
  const auditBefore = app.locals.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  app.locals.db.exec(
    "CREATE TRIGGER simulate_assignment_notification_failure BEFORE INSERT ON activity WHEN NEW.eventKey LIKE 'follow-up-assignment:%' BEGIN SELECT RAISE(ABORT,'Synthetic assignment notification failure'); END;",
  );
  try {
    assert.equal((await assign(carePlan)).status, 500);
    const after = await work(carePlan.id);
    assert.equal(after.revision, before.revision);
    assert.equal(after.ownerDoctorId, before.ownerDoctorId);
    assert.equal(
      app.locals.db
        .prepare('SELECT count(*) AS n FROM followUpAssignments WHERE carePlanId=?')
        .get(carePlan.id).n,
      0,
    );
    assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM audit').get().n, auditBefore);
  } finally {
    app.locals.db.exec('DROP TRIGGER simulate_assignment_notification_failure');
  }
});
