import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { get, openDatabase, type DB } from '../server/db.ts';
import {
  doctorProfileFields,
  type DoctorProfileFields,
} from '../shared/doctor-profile-creation.ts';
import type {
  DoctorProfileEditCommand,
  DoctorProfileEditContext,
  DoctorProfileEditHistory,
  DoctorProfileEditReceipt,
} from '../shared/doctor-profile-edit.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

type Fixture = Awaited<ReturnType<typeof careApiFixture>>;
const doctorId = 'doctor-meera',
  otherId = 'doctor-arjun';
const base = '/doctors/' + doctorId,
  edit = base + '/profile-changes',
  history = base + '/profile-history';
async function context(
  f: Fixture,
  admin: Client,
  id = doctorId,
): Promise<DoctorProfileEditContext> {
  const result = await f.call('/doctors/' + id + '/profile-context', admin);
  assert.equal(result.status, 200);
  assert.match(result.data.revision, /^[a-f0-9]{64}$/);
  return result.data;
}
function command(
  source: DoctorProfileEditContext,
  profile: Partial<DoctorProfileFields> = {},
): DoctorProfileEditCommand {
  return {
    expectedRevision: source.revision,
    profile: { ...doctorProfileFields.parse(source.doctor), ...profile },
    requestId: randomUUID(),
    reviewedConfirmed: true,
  };
}
async function patch(f: Fixture, who: Client, profile: unknown, id = doctorId) {
  const reply = await fetch(f.base + '/doctors/' + id, {
    method: 'PATCH',
    headers: { Cookie: who.cookie, 'X-CSRF-Token': who.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  return { status: reply.status, data: await reply.json() };
}
function counts(db: DB) {
  return {
    ...db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM doctorProfileEditCommands) commands,
    (SELECT COUNT(*) FROM doctorProfileChanges) changes,
    (SELECT COUNT(*) FROM audit WHERE json_extract(data,'$.action')='updated doctor profile') audits`,
      )
      .get(),
  };
}
function generic(reply: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(reply.status, status);
  assert.deepEqual(Object.keys(reply.data), ['error']);
}

test('an edit records its original public fields and actor, preserves booked facts and linked accounts, and recovers after restart', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    patient = await f.login('patient');
  const source = await context(f, admin),
    beforeUser = (await f.call('/users', admin)).data;
  const beforeVisit = (await f.call('/appointments', patient)).data;
  assert.ok(beforeVisit.some((a: { doctorId: string }) => a.doctorId === doctorId));
  const status = await f.call(base + '/booking-status', admin);
  assert.equal(status.status, 200);
  assert.equal(
    (
      await f.call(base + '/booking-status', admin, {
        acceptingNewBookings: false,
        expectedRevision: status.data.revision,
        requestId: randomUUID(),
        reason: 'Synthetic pause',
      })
    ).status,
    201,
  );
  assert.deepEqual(await context(f, admin), source);
  const input = command(source, {
    fee: 0,
    name: 'Dr. Synthetic',
    experience: 0,
    languages: ['Language B', 'Language A'],
    specialties: ['Focus, with comma'],
  });
  const first = await f.call(edit, admin, {
    ...input,
    requestId: input.requestId.toUpperCase(),
    profile: { ...input.profile, name: ' Dr. Synthetic ' },
  });
  assert.equal(first.status, 201);
  const next = await context(f, admin);
  const receipt: DoctorProfileEditReceipt = {
    actorId: admin.user.id,
    doctorId,
    requestId: input.requestId,
    expectedRevision: source.revision,
    revision: next.revision,
    before: source.doctor,
    after: { ...input.profile, id: doctorId },
  };
  assert.notEqual(receipt.revision, source.revision);
  assert.deepEqual(first.data, { receipt });
  assert.deepEqual(next.doctor, receipt.after);
  const h: DoctorProfileEditHistory = (await f.call(history, admin)).data;
  assert.equal(h.total, 1);
  const [change] = h.items;
  assert.deepEqual(change, {
    id: change.id,
    source: 'reviewed',
    doctorId,
    actorId: admin.user.id,
    actorName: admin.user.name,
    createdAt: change.createdAt,
    before: source.doctor,
    after: next.doctor,
  });
  assert.ok(Number.isFinite(Date.parse(change.createdAt)));
  assert.ok(!JSON.stringify(change).includes(input.requestId));
  assert.equal(
    (await patch(f, admin, { ...next.doctor, fee: 100.25, qualifications: 'Updated again' }))
      .status,
    200,
  );
  assert.deepEqual((await f.call('/appointments', patient)).data, beforeVisit);
  assert.deepEqual((await f.call('/users', admin)).data, beforeUser);
  const publicDoc = (await f.call('/doctors')).data.find((d: { id: string }) => d.id === doctorId);
  assert.deepEqual(publicDoc, {
    ...next.doctor,
    fee: 100.25,
    qualifications: 'Updated again',
    acceptingNewBookings: false,
    appointmentDurationMinutes: 30,
  });
  changeUser(f.db, admin.user, { name: 'Renamed administrator' });
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  assert.deepEqual((await reopened.call(edit, admin, input)).data, first.data);
  assert.equal((await reopened.call(edit, admin, input)).status, 200);
  assert.deepEqual(counts(reopened.db), { changes: 2, commands: 1, audits: 2 });
  const restored = (await reopened.call(history, admin)).data.items;
  assert.equal(restored[0].source, 'legacy');
  assert.deepEqual(restored[1], change);
});

test('legacy and reviewed edits advance the revision across ABA, and stale and unchanged requests keep definitive private refusals', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    source = await context(f, admin);
  const noChange = command(source),
    absent = await f.call(edit, admin, noChange);
  assert.equal(absent.status, 409);
  assert.deepEqual(absent.data, {
    code: 'DOCTOR_PROFILE_UNCHANGED',
    actorId: admin.user.id,
    doctorId,
    requestId: noChange.requestId,
    expectedRevision: source.revision,
    profile: noChange.profile,
  });
  assert.deepEqual(await context(f, admin), source);
  assert.deepEqual(counts(f.db), { changes: 0, commands: 1, audits: 0 });
  const legacy = await patch(f, admin, { ...source.doctor, extra: 'ignored', fee: 99 });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.data, { ...source.doctor, fee: 99 });
  const changed = await context(f, admin);
  assert.notEqual(changed.revision, source.revision);
  const stale = command(source, { qualifications: 'Second administrator edit' });
  const refusal = await f.call(edit, admin, stale);
  assert.equal(refusal.status, 409);
  assert.deepEqual(refusal.data, {
    code: 'DOCTOR_PROFILE_CHANGED',
    actorId: admin.user.id,
    doctorId,
    requestId: stale.requestId,
    expectedRevision: source.revision,
    profile: stale.profile,
  });
  assert.equal(
    (await f.call(edit, admin, command(changed, { fee: source.doctor.fee }))).status,
    201,
  );
  const back = await context(f, admin);
  assert.deepEqual(back.doctor, source.doctor);
  assert.notEqual(back.revision, source.revision);
  assert.deepEqual((await f.call(edit, admin, stale)).data, refusal.data);
  assert.deepEqual((await f.call(edit, admin, noChange)).data, absent.data);
  const fresh = await f.call(
    edit,
    admin,
    command(back, { qualifications: stale.profile.qualifications }),
  );
  assert.equal(fresh.status, 201);
  assert.deepEqual(counts(f.db), { changes: 3, commands: 4, audits: 3 });
  const final = await context(f, admin);
  assert.equal((await patch(f, admin, final.doctor)).status, 200);
  assert.deepEqual(await context(f, admin), final);
  assert.equal(counts(f.db).changes, 3);
});

test('adapters protect private requests and snapshots, enforce explicit reviewed fields and bind actor, doctor, ordered arrays and revision', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    reception = await f.login('reception');
  const source = await context(f, admin),
    cmd = command(source, { languages: ['B', 'A'], fee: 49.5 });
  for (const actor of [undefined, reception, await f.login('doctor'), await f.login('patient')]) {
    const denied = actor ? 403 : 401;
    for (const [route, body] of [
      [history, undefined],
      [base + '/profile-context', undefined],
      [edit, cmd],
    ] as const)
      generic(await f.call(route, actor, body), denied);
  }
  for (const invalid of [
    { ...cmd, profile: { ...cmd.profile, id: doctorId } },
    { ...cmd, profile: { ...cmd.profile, color: undefined } },
    { ...cmd, profile: { ...cmd.profile, languages: [] } },
    { ...cmd, profile: { ...cmd.profile, acceptingNewBookings: true } },
    { ...cmd, reviewedConfirmed: false },
    { ...cmd, expectedRevision: 'invalid' },
    { ...cmd, extra: true },
  ]) {
    assert.equal((await f.call(edit, admin, invalid)).status, 400);
  }
  assert.equal((await f.call(edit + '?extra=1', admin, cmd)).status, 400);
  assert.equal((await f.call(edit, admin, cmd)).status, 201);
  changeUser(f.db, reception.user, { role: 'admin' });
  for (const reply of [
    await f.call(edit, reception, cmd),
    await f.call('/doctors/' + otherId + '/profile-changes', admin, cmd),
    await f.call(edit, admin, { ...cmd, expectedRevision: '0'.repeat(64) }),
    await f.call(edit, admin, { ...cmd, profile: { ...cmd.profile, languages: ['A', 'B'] } }),
    await f.call(edit, admin, { ...cmd, profile: { ...cmd.profile, color: '#998877' } }),
  ])
    generic(reply, 409);
  generic(await f.call('/doctors/missing/profile-context', admin), 404);
  generic(await f.call('/doctors/missing/profile-history', admin), 404);
  generic(await f.call('/doctors/missing/profile-changes', admin, cmd), 404);
  assert.deepEqual(counts(f.db), { changes: 1, commands: 1, audits: 1 });
});

test('independent SQLite writers serialize competing profile revisions, exact retries, and colliding UUIDs', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    source = await context(f, admin);
  const identical = command(source, { fee: 802 });
  const copies = await simultaneousCareRequests(f, edit, admin, identical);
  assert.deepEqual(copies.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(copies[0].data, copies[1].data);
  const next = await context(f, admin),
    a = command(next, { title: 'Synthetic competing A' }),
    b = command(next, { fee: 804 });
  const race = await simultaneousCareRequests(f, edit, admin, a, { who: admin, body: b });
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  const winner = race[0].status === 201 ? 0 : 1,
    loser = 1 - winner;
  assert.deepEqual((await context(f, admin)).doctor, race[winner].data.receipt.after);
  assert.equal(race[loser].data.code, 'DOCTOR_PROFILE_CHANGED');
  assert.deepEqual((await f.call(edit, admin, [a, b][loser])).data, race[loser].data);
  const candidate = command(await context(f, admin), { fee: 501 });
  const collision = await simultaneousCareRequests(f, edit, admin, candidate, {
    who: admin,
    body: { ...candidate, profile: { ...candidate.profile, fee: 502 } },
  });
  assert.deepEqual(collision.map((r) => r.status).sort(), [201, 409]);
  generic(
    collision.find((r) => r.status === 409)!,
    409,
  );
  assert.deepEqual(counts(f.db), { changes: 3, commands: 4, audits: 3 });
});

test('history remains ordered, doctor-scoped and paginated, and existing doctors start without retrospective events', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    initial = await context(f, admin);
  assert.deepEqual((await f.call(history, admin)).data, {
    items: [],
    page: 1,
    pageSize: 10,
    total: 0,
    totalPages: 1,
  });
  for (let i = 1; i <= 12; i++)
    assert.equal((await patch(f, admin, { ...initial.doctor, fee: i })).status, 200);
  const other = await context(f, admin, otherId);
  assert.equal((await patch(f, admin, { ...other.doctor, fee: 0 }, otherId)).status, 200);
  const first = await f.call(history + '?page=1&pageSize=10', admin);
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.data.items.map((e: { after: { fee: number } }) => e.after.fee),
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3],
  );
  const last = await f.call(history + '?page=999999&pageSize=10', admin);
  assert.equal(last.data.page, 2);
  assert.equal(last.data.total, 12);
  assert.equal(last.data.totalPages, 2);
  assert.deepEqual(
    last.data.items.map((e: { after: { fee: number } }) => e.after.fee),
    [2, 1],
  );
  for (const query of ['?page=0', '?pageSize=40', '?doctorId=elsewhere', '?page=9999999'])
    assert.equal((await f.call(history + query, admin)).status, 400);
  assert.throws(() => f.db.exec('DELETE FROM doctorProfileChanges'), /immutable/);
});

test('writes, replays and reads revalidate active administrator, session, CSRF and MFA inside the transaction', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    source = await context(f, admin);
  const saved = command(source, { fee: 1 });
  assert.equal((await f.call(edit, admin, saved)).status, 201);
  const stale = command(source, { fee: 2 });
  assert.equal((await f.call(edit, admin, stale)).status, 409);
  const fresh = command(await context(f, admin), { fee: 3 });
  const before = counts(f.db),
    other = openDatabase(f.databasePath),
    user = admin.user;
  t.after(() => other.close());
  const session = other
    .prepare('SELECT csrfToken,expiresAt FROM sessions WHERE userId=?')
    .get(user.id)!;
  const restore = () => changeUser(other, user, {});
  const checks: [number, () => unknown, () => unknown][] = [
    [403, () => changeUser(other, user, { role: 'doctor' }), restore],
    [403, () => changeUser(other, user, { mustChangePassword: true }), restore],
    [401, () => changeUser(other, user, { active: false }), restore],
    [
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id),
      () =>
        other
          .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
          .run(session.expiresAt, user.id),
    ],
    [
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='different' WHERE userId=?").run(user.id),
      () =>
        other
          .prepare('UPDATE sessions SET csrfToken=? WHERE userId=?')
          .run(session.csrfToken, user.id),
    ],
    [
      401,
      () =>
        other
          .prepare(
            "INSERT INTO mfaCredentials VALUES (?,'fixture-credential','synthetic','2026-01-01',0)",
          )
          .run(user.id),
      () => other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id),
    ],
  ];
  for (const route of [
    () => patch(f, admin, fresh.profile),
    () => f.call(edit, admin, saved),
    () => f.call(edit, admin, stale),
    () => f.call(edit, admin, fresh),
    () => f.call(history, admin),
    () => f.call(base + '/profile-context', admin),
  ]) {
    for (const [status, mutate, reset] of checks) {
      const reply = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', mutate, route);
      reset();
      generic(reply, status);
    }
  }
  assert.deepEqual(counts(f.db), before);
});

test('a failed public write, history, audit, or command insert rolls back every edit and allows exact recovery', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    source = await context(f, admin);
  const cmd = command(source, { fee: 0 }),
    unchanged = command(source),
    before = counts(f.db);
  for (const [route, tables] of [
    [
      () => patch(f, admin, cmd.profile),
      ['UPDATE ON doctors', 'INSERT ON doctorProfileChanges', 'INSERT ON audit'],
    ],
    [
      () => f.call(edit, admin, cmd),
      [
        'UPDATE ON doctors',
        'INSERT ON doctorProfileChanges',
        'INSERT ON audit',
        'INSERT ON doctorProfileEditCommands',
      ],
    ],
    [() => f.call(edit, admin, unchanged), ['INSERT ON doctorProfileEditCommands']],
    [() => f.call(history, admin), ['INSERT ON audit']],
  ] as const) {
    for (const event of tables) {
      for (const failure of ["RAISE(ABORT,'Test profile write failure')", 'RAISE(IGNORE)']) {
        f.db.exec(
          'CREATE TRIGGER synthetic_failure BEFORE ' + event + ' BEGIN SELECT ' + failure + '; END',
        );
        try {
          generic(await route(), 500);
        } finally {
          f.db.exec('DROP TRIGGER synthetic_failure');
        }
        assert.deepEqual(counts(f.db), before);
        assert.deepEqual(await context(f, admin), source);
        assert.deepEqual(get(f.db, 'doctors', doctorId), source.doctor);
      }
    }
  }
  assert.equal((await f.call(edit, admin, cmd)).status, 201);
  assert.throws(() => f.db.exec('UPDATE doctorProfileEditCommands SET rowid=rowid'), /immutable/);
});
