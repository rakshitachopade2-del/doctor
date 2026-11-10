import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { notifyClinicians, notifyPatient } from '../server/activity.ts';
import { clinicToday } from '../server/db.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server;
let base: string;
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  patient: Client = {},
  admin: Client = {},
  reception: Client = {},
  other: Client = {};
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
async function login(role: string, client: Client) {
  assert.equal(
    (
      await call('/auth/login', client, 'POST', {
        email: `${role}@derma.demo`,
        password: 'DemoClinic2026!',
      })
    ).status,
    200,
  );
}
async function message(client: Client, body = 'Synthetic message for activity verification.') {
  const result = await call('/messages', client, 'POST', { patientId: 'patient-ananya', body });
  assert.equal(result.status, 201);
  return result.data;
}
before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const [role, client] of [
    ['doctor', doctor],
    ['patient', patient],
    ['admin', admin],
    ['reception', reception],
  ] as const)
    await login(role, client);
  assert.equal(
    (
      await call('/auth/register', other, 'POST', {
        name: 'Separate Activity Patient',
        email: 'activity-other@example.test',
        password: 'ActivityOther2026!',
        phone: '9000000081',
        dob: '1990-01-02',
        gender: 'Other',
      })
    ).status,
    201,
  );
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  app.locals.close();
});

test('activity is private, recipient-scoped, and reading a feed does not mark it read', async () => {
  assert.equal((await call('/activity')).status, 401);
  await message(doctor);
  const feed = (await call('/activity', patient)).data;
  assert.equal(feed.items[0].kind, 'message');
  assert.equal(feed.unreadCount, 1);
  assert.equal(feed.items[0].readAt, null);
  assert.equal((await call('/activity', patient)).data.unreadCount, 1);
  assert.deepEqual((await call('/activity', other)).data.items, []);
  assert.deepEqual((await call('/activity', reception)).data.items, []);
  assert.equal((await call(`/activity/${feed.items[0].id}/read`, other, 'POST', {})).status, 404);
  assert.equal(
    (await call('/activity/read-all', other, 'POST', { throughId: feed.items[0].id })).status,
    404,
  );
  const read = (await call(`/activity/${feed.items[0].id}/read`, patient, 'POST', {})).data;
  assert.ok(read.readAt);
  assert.equal(
    (await call(`/activity/${read.id}/read`, patient, 'POST', {})).data.readAt,
    read.readAt,
  );
  assert.equal((await call('/activity', patient)).data.unreadCount, 0);
});
test('patient reports notify the clinical team and marking read does not clear review work', async () => {
  await message(patient);
  assert.equal((await call('/activity', doctor)).data.items[0].kind, 'message');
  const check = await call('/check-ins', patient, 'POST', {
    carePlanId: 'plan-1',
    date: clinicToday(),
    adherence: 'partial',
    feeling: 'same',
    note: 'Synthetic patient report, not observed adherence.',
  });
  assert.equal(check.status, 201);
  const work = (await call('/follow-up-worklist?scope=all', doctor)).data.find(
    (row: any) => row.carePlan.id === 'plan-1',
  );
  assert.ok(work.unreviewedCount > 0);
  const item = (await call('/activity', doctor)).data.items[0];
  assert.equal(item.kind, 'check-in');
  assert.equal((await call(`/activity/${item.id}/read`, doctor, 'POST', {})).status, 200);
  const afterRead = (await call('/follow-up-worklist?scope=all', doctor)).data.find(
    (row: any) => row.carePlan.id === 'plan-1',
  );
  assert.equal(afterRead.unreviewedCount, work.unreviewedCount);
  assert.equal(afterRead.revision, work.revision);
});
test('mark all read respects the visible snapshot and preserves newer arrivals', async () => {
  await message(doctor, 'First snapshot message');
  const snapshot = (await call('/activity', patient)).data;
  await message(doctor, 'Arrived after snapshot');
  const latest = (await call('/activity', patient)).data.items[0];
  assert.equal(
    (await call('/activity/read-all', patient, 'POST', { throughId: snapshot.items[0].id })).status,
    200,
  );
  const unread = (await call('/activity?unread=true', patient)).data;
  assert.equal(unread.unreadCount, 1);
  assert.equal(unread.items[0].id, latest.id);
});
test('activity pagination is stable and rejects another recipient cursor', async () => {
  await message(doctor, 'Pagination message');
  const first = (await call('/activity?limit=1', patient)).data;
  const second = (await call(`/activity?limit=1&cursor=${first.nextCursor}`, patient)).data;
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal((await call(`/activity?cursor=${first.items[0].id}`, other)).status, 400);
  assert.equal((await call('/activity?limit=101', patient)).status, 400);
});
test('unpublished clinical reviews do not create patient activity and publication retries do not duplicate it', async () => {
  const order = (
    await call('/investigations', doctor, 'POST', {
      patientId: 'patient-ananya',
      title: 'Synthetic activity investigation',
      kind: 'other',
      reason: 'Test publication',
      instructions: 'Share synthetic report',
    })
  ).data;
  const submitted = (
    await call(`/investigations/${order.id}/results`, patient, 'POST', { note: 'Synthetic result' })
  ).data;
  const before = (await call('/activity', patient)).data.items.length;
  const reviewed = await call(`/investigations/${order.id}/reviews`, doctor, 'POST', {
    resultId: submitted.results[0].id,
    summary: 'Private synthetic clinical assessment',
    followUp: 'Review at clinic',
    publishToPatient: false,
  });
  assert.equal(reviewed.status, 201);
  assert.equal((await call('/activity', patient)).data.items.length, before);
  const review = reviewed.data.reviews[0];
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await call(`/investigations/${order.id}/reviews/${review.id}/publish`, doctor, 'POST', {}))
        .status,
      200,
    );
  const after = (await call('/activity', patient)).data;
  assert.equal(after.items.length, before + 1);
  assert.equal(after.items[0].title, 'Your clinician shared a report review');
  assert.ok(!JSON.stringify(after).includes('Private synthetic clinical assessment'));
});
test('source event keys are idempotent and activity contents are immutable', () => {
  const eventKey = `synthetic:${randomUUID()}`;
  const data = {
    kind: 'message' as const,
    title: 'Synthetic immutable activity',
    detail: 'Test only',
    href: '/my-care/messages',
  };
  notifyPatient(app.locals.db, 'patient-ananya', eventKey, data);
  notifyPatient(app.locals.db, 'patient-ananya', eventKey, data);
  assert.equal(
    app.locals.db.prepare('SELECT count(*) AS n FROM activity WHERE eventKey=?').get(eventKey).n,
    1,
  );
  const row = app.locals.db.prepare('SELECT id FROM activity WHERE eventKey=?').get(eventKey);
  assert.throws(
    () => app.locals.db.prepare('UPDATE activity SET data=? WHERE id=?').run('{}', row.id),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM activity WHERE id=?').run(row.id),
    /immutable/,
  );
});
test('notification failure rolls back the source message instead of returning a partial success', async () => {
  const before = app.locals.db.prepare('SELECT count(*) AS n FROM messages').get().n;
  app.locals.db.exec(
    "CREATE TRIGGER simulate_activity_failure BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'Synthetic notification failure'); END;",
  );
  try {
    assert.equal(
      (
        await call('/messages', doctor, 'POST', {
          patientId: 'patient-ananya',
          body: 'Must roll back with its notification',
        })
      ).status,
      500,
    );
  } finally {
    app.locals.db.exec('DROP TRIGGER simulate_activity_failure');
  }
  assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM messages').get().n, before);
});
test('role changes hide earlier clinical notifications and prevent read-state writes', async () => {
  const clinicalItem = (await call('/activity', doctor)).data.items[0];
  assert.ok(clinicalItem);
  assert.equal(
    (await call('/accounts/user-doctor', admin, 'PATCH', { role: 'receptionist', doctorId: null }))
      .status,
    200,
  );
  try {
    await login('doctor', doctor);
    assert.deepEqual((await call('/activity', doctor)).data.items, []);
    assert.equal((await call(`/activity/${clinicalItem.id}/read`, doctor, 'POST', {})).status, 404);
  } finally {
    assert.equal(
      (
        await call('/accounts/user-doctor', admin, 'PATCH', {
          role: 'doctor',
          doctorId: 'doctor-meera',
        })
      ).status,
      200,
    );
  }
});

test('excluding the sole active owner does not reroute their own event to unrelated clinicians', () => {
  const db = app.locals.db;
  const adminBefore = db.prepare('SELECT data FROM users WHERE id=?').get('user-admin').data;
  try {
    db.prepare('UPDATE users SET data=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(adminBefore), doctorId: 'doctor-arjun' }),
      'user-admin',
    );
    const eventKey = `owner-authored:${randomUUID()}`;
    notifyClinicians(
      db,
      'patient-ananya',
      eventKey,
      {
        kind: 'investigation',
        title: 'Synthetic owner-authored result',
        detail: 'Routing regression fixture',
        href: '/clinic/patients/patient-ananya?tab=workup',
      },
      { doctorId: 'doctor-meera', excludeActorId: 'user-doctor' },
    );
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM activity WHERE eventKey=?').get(eventKey).n,
      0,
    );
  } finally {
    db.prepare('UPDATE users SET data=? WHERE id=?').run(adminBefore, 'user-admin');
  }
});

test('an inactive owner falls back to active clinicians without notifying the inactive account', () => {
  const db = app.locals.db;
  const adminBefore = db.prepare('SELECT data FROM users WHERE id=?').get('user-admin').data;
  const doctorBefore = db.prepare('SELECT data FROM users WHERE id=?').get('user-doctor').data;
  try {
    db.prepare('UPDATE users SET data=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(adminBefore), doctorId: 'doctor-arjun' }),
      'user-admin',
    );
    db.prepare('UPDATE users SET data=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(doctorBefore), active: false }),
      'user-doctor',
    );
    const eventKey = `inactive-owner:${randomUUID()}`;
    notifyClinicians(
      db,
      'patient-ananya',
      eventKey,
      {
        kind: 'check-in',
        title: 'Synthetic check-in for inactive owner',
        detail: 'Routing regression fixture',
        href: '/clinic/patients/patient-ananya?tab=care',
      },
      { doctorId: 'doctor-meera', excludeActorId: 'user-patient' },
    );
    assert.deepEqual(
      db
        .prepare('SELECT userId FROM activity WHERE eventKey=?')
        .all(eventKey)
        .map((row: { userId: string }) => row.userId),
      ['user-admin'],
    );
  } finally {
    db.prepare('UPDATE users SET data=? WHERE id=?').run(adminBefore, 'user-admin');
    db.prepare('UPDATE users SET data=? WHERE id=?').run(doctorBefore, 'user-doctor');
  }
});

test('audit failures roll back both individual and bulk activity read receipts', async () => {
  await message(admin, 'First receipt transaction fixture');
  await message(admin, 'Second receipt transaction fixture');
  const before = (await call('/activity?unread=true', patient)).data;
  assert.ok(before.unreadCount >= 2);
  const latest = before.items[0];
  app.locals.db.exec(
    "CREATE TRIGGER simulate_activity_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') LIKE 'marked activity %' BEGIN SELECT RAISE(ABORT,'Synthetic activity audit failure'); END;",
  );
  try {
    assert.equal((await call(`/activity/${latest.id}/read`, patient, 'POST', {})).status, 500);
    assert.equal(
      app.locals.db.prepare('SELECT readAt FROM activity WHERE id=?').get(latest.id).readAt,
      null,
    );
    assert.equal(
      (await call('/activity/read-all', patient, 'POST', { throughId: latest.id })).status,
      500,
    );
    const after = (await call('/activity?unread=true', patient)).data;
    assert.equal(after.unreadCount, before.unreadCount);
    assert.deepEqual(after.items, before.items);
  } finally {
    app.locals.db.exec('DROP TRIGGER simulate_activity_audit_failure');
  }
  assert.equal((await call(`/activity/${latest.id}/read`, patient, 'POST', {})).status, 200);
});
