import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { SQLInputValue } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import {
  addDays,
  clinicToday,
  createUser,
  get,
  openDatabase,
  seedDemo,
  type DB,
} from '../server/db.ts';
import type { CarePlan, User } from '../shared/types.ts';
import type {
  EscalationPolicyContext,
  EscalationPreview,
  EscalationRun,
  EscalationEvent,
} from '../shared/follow-up-escalation.ts';

type Client = { cookie?: string; csrf?: string; id?: string };
const privateText = 'PRIVATE_ESCALATION_CLINICAL_TEXT';
async function listen(app: ReturnType<typeof createApp>) {
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  return { server: server!, base: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function setup(t: TestContext, databasePath = ':memory:', clearSeed = true) {
  const app = createApp({ databasePath, demoMode: true }),
    db: DB = app.locals.db;
  if (clearSeed) db.exec("UPDATE carePlans SET data=json_set(data,'$.status','completed')");
  const { server, base } = await listen(app);
  const admin: Client = {},
    doctor: Client = {},
    patient: Client = {},
    reception: Client = {};
  let closed = false;
  async function cleanup() {
    if (!closed) {
      closed = true;
      await close(server);
      app.locals.close();
    }
  }
  t.after(cleanup);
  async function call(path: string, client: Client = admin, method = 'GET', body?: unknown) {
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
    if (data.user?.id) client.id = data.user.id;
    return { status: response.status, data, headers: response.headers };
  }
  for (const [role, client] of [
    ['admin', admin],
    ['doctor', doctor],
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
  async function policy(): Promise<EscalationPolicyContext> {
    const result = await call('/follow-up-escalation-policy');
    assert.equal(result.status, 200);
    return result.data;
  }
  async function policyBody(fields: Record<string, unknown> = {}) {
    const current = await policy();
    return {
      ...current.policy,
      reason: 'PRIVATE_POLICY_REASON',
      expectedRevision: current.revision,
      requestId: randomUUID(),
      ...fields,
    };
  }
  async function enable(fields: Record<string, unknown> = {}) {
    const result = await call(
      '/follow-up-escalation-policy',
      admin,
      'POST',
      await policyBody({ enabled: true, ...fields }),
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  async function plan(days = 5, fields: Record<string, unknown> = {}): Promise<CarePlan> {
    const result = await call('/care-plans', doctor, 'POST', {
      patientId: 'patient-ananya',
      title: `Operational reminder ${randomUUID()}`,
      instructions: privateText,
      expectations: privateText,
      warnings: privateText,
      cost: 'Discussed separately',
      medications: [],
      startDate: addDays(clinicToday(), -100),
      endDate: addDays(clinicToday(), 30),
      followUpDate: addDays(clinicToday(), -days),
      ...fields,
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  async function preview(): Promise<EscalationPreview> {
    const result = await call('/follow-up-escalations/preview');
    assert.equal(result.status, 200);
    return result.data;
  }
  const runBody = (value: EscalationPreview, fields: Record<string, unknown> = {}) => ({
    expectedPreviewRevision: value.revision,
    expectedPolicyRevision: value.policyRevision,
    requestId: randomUUID(),
    ...fields,
  });
  async function run(value?: EscalationPreview): Promise<EscalationRun> {
    const result = await call(
      '/follow-up-escalations/run',
      admin,
      'POST',
      runBody(value ?? (await preview())),
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  async function history(id: string) {
    const result = await call(`/care-plans/${id}/escalations`, doctor);
    assert.equal(result.status, 200);
    return result.data;
  }
  async function work(id: string) {
    const result = await call('/follow-up-worklist?scope=all', doctor);
    assert.equal(result.status, 200);
    return result.data.find((row: { carePlan: CarePlan }) => row.carePlan.id === id);
  }
  async function review(id: string, fields: Record<string, unknown> = {}) {
    const current = await work(id);
    const result = await call(`/care-plans/${id}/reviews`, doctor, 'POST', {
      expectedRevision: current.revision,
      assessment: privateText,
      patientInstructions: 'Shared recorded instructions',
      disposition: 'continue',
      nextReviewDate: clinicToday(),
      ...fields,
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  return {
    app,
    db,
    admin,
    doctor,
    reception,
    patient,
    call,
    policy,
    policyBody,
    enable,
    plan,
    preview,
    runBody,
    run,
    history,
    work,
    review,
    cleanup,
  };
}
function counts(db: DB) {
  return Object.fromEntries(
    [
      'followUpEscalationPolicyChanges',
      'followUpEscalationRuns',
      'followUpEscalationEvents',
      'followUpEscalationCommands',
      'activity',
      'audit',
    ].map((table) => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n]),
  );
}
function changeUser(db: DB, userId: string, fields: Partial<User>) {
  const user = { ...get<User>(db, 'users', userId)!, ...fields };
  db.prepare('UPDATE users SET role=?,data=? WHERE id=?').run(
    user.role,
    JSON.stringify(user),
    userId,
  );
}
function seedPlan(db: DB, prototype: CarePlan, fields: Partial<CarePlan> = {}) {
  const value = { ...prototype, id: randomUUID(), ...fields };
  db.prepare('INSERT INTO carePlans(id,patientId,data) VALUES (?,?,?)').run(
    value.id,
    value.patientId,
    JSON.stringify(value),
  );
  return value;
}
function rawReview(db: DB, plan: CarePlan, dueDate: string | null, disposition = 'continue') {
  const value = {
    id: randomUUID(),
    carePlanId: plan.id,
    doctorId: plan.doctorId,
    doctorName: plan.doctorName,
    source: 'clinical-review',
    assessment: privateText,
    patientInstructions: 'Recorded instructions',
    disposition,
    nextReviewDate: dueDate,
    checkInSnapshots: [],
    createdAt: new Date().toISOString(),
  };
  db.prepare('INSERT INTO followUpReviews(id,carePlanId,data) VALUES (?,?,?)').run(
    value.id,
    plan.id,
    JSON.stringify(value),
  );
  return value;
}

test('disabled default policy has no invented history or timer; preview is hypothetical and GET never sends', async (t) => {
  const f = await setup(t),
    plan = await f.plan(10),
    policy = await f.policy();
  assert.deepEqual(policy.policy, { enabled: false, ownerAfterDays: 3, clinicAfterDays: 7 });
  assert.deepEqual(policy.history, []);
  assert.deepEqual(policy.worker, {
    automaticEnabled: false,
    intervalSeconds: 900,
    lastCheckedAt: null,
    lastRunId: null,
    lastErrorAt: null,
  });
  const preview = await f.preview();
  assert.equal(preview.status, 'disabled');
  assert.equal(preview.readyTotal, 1);
  assert.equal(preview.items[0].carePlanId, plan.id);
  assert.equal(preview.items[0].stage, 'clinic');
  assert.equal((await f.work(plan.id)).escalation.state, 'disabled');
  assert.equal(
    (await f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(preview))).status,
    409,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM followUpEscalationEvents').get()!.n, 0);
  assert.equal(f.app.locals.runFollowUpEscalations(), null);
  const checked = await f.policy();
  assert.ok(checked.worker.lastCheckedAt);
  assert.equal(checked.worker.lastRunId, null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM followUpEscalationRuns').get()!.n, 0);
});

test('policy edits are strict, optimistic, actor-bound and replay original evidence with current context', async (t) => {
  const f = await setup(t),
    body = await f.policyBody({ enabled: true });
  const saved = await f.call('/follow-up-escalation-policy', f.admin, 'POST', {
    ...body,
    requestId: body.requestId.toUpperCase(),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.change.requestId, body.requestId);
  assert.equal(saved.data.change.createdById, f.admin.id);
  const before = counts(f.db),
    replay = await f.call('/follow-up-escalation-policy', f.admin, 'POST', body);
  assert.deepEqual(replay.data, saved.data);
  assert.deepEqual(counts(f.db), before);
  for (const fields of [{ reason: 'Changed' }, { expectedRevision: '0'.repeat(64) }])
    assert.equal(
      (await f.call('/follow-up-escalation-policy', f.admin, 'POST', { ...body, ...fields }))
        .status,
      409,
    );
  const newer = await f.enable({ ownerAfterDays: 4 });
  const later = await f.call('/follow-up-escalation-policy', f.admin, 'POST', body);
  assert.deepEqual(later.data.change, saved.data.change);
  assert.equal(later.data.context.revision, newer.context.revision);
  const noOp = await f.policyBody();
  assert.equal((await f.call('/follow-up-escalation-policy', f.admin, 'POST', noOp)).status, 400);
  for (const fields of [
    { ownerAfterDays: 0 },
    { ownerAfterDays: 31 },
    { ownerAfterDays: 3.5 },
    { clinicAfterDays: 4 },
    { clinicAfterDays: 91 },
    { reason: '' },
    { extra: true },
  ])
    assert.equal(
      (await f.call('/follow-up-escalation-policy', f.admin, 'POST', { ...noOp, ...fields }))
        .status,
      400,
    );
  assert.equal(
    (
      await f.call('/follow-up-escalation-policy', f.admin, 'POST', {
        ...noOp,
        expectedRevision: body.expectedRevision,
        enabled: false,
      })
    ).status,
    409,
  );
});

test('strict queries, role restrictions, CSRF and temporary sessions protect every escalation route', async (t) => {
  const f = await setup(t),
    plan = await f.plan(),
    body = await f.policyBody({ enabled: true });
  const preview = await f.preview();
  for (const client of [f.patient, f.reception]) {
    for (const path of [
      '/follow-up-escalation-policy',
      '/follow-up-escalations/preview',
      `/care-plans/${plan.id}/escalations`,
    ])
      assert.equal((await f.call(path, client)).status, 403);
    assert.equal((await f.call('/follow-up-escalation-policy', client, 'POST', body)).status, 403);
    assert.equal(
      (await f.call('/follow-up-escalations/run', client, 'POST', f.runBody(preview))).status,
      403,
    );
  }
  assert.equal((await f.call('/follow-up-escalation-policy', f.doctor)).status, 200);
  assert.equal((await f.call('/follow-up-escalations/preview', f.doctor)).status, 403);
  assert.equal(
    (await f.call('/follow-up-escalations/run', f.doctor, 'POST', f.runBody(preview))).status,
    403,
  );
  assert.equal((await f.call('/follow-up-escalation-policy', {})).status, 401);
  assert.equal(
    (await f.call('/follow-up-escalation-policy', { cookie: f.admin.cookie }, 'POST', body)).status,
    403,
  );
  for (const path of [
    '/follow-up-escalation-policy',
    '/follow-up-escalations/preview',
    `/care-plans/${plan.id}/escalations`,
  ])
    assert.equal((await f.call(`${path}?unknown=1&unknown=2`)).status, 400);
  assert.equal(
    (await f.call('/follow-up-escalation-policy?unknown=1', f.admin, 'POST', body)).status,
    400,
  );
  assert.equal(
    (await f.call('/follow-up-escalations/run?unknown=1', f.admin, 'POST', f.runBody(preview)))
      .status,
    400,
  );
  changeUser(f.db, f.admin.id!, { mustChangePassword: true });
  assert.equal((await f.call('/follow-up-escalation-policy')).status, 403);
  assert.equal((await f.call('/care-plans/missing/escalations', f.doctor)).status, 404);
});

test('IST calendar boundaries advance owner to clinic stage once while due-today and future plans stay ineligible', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-14T18:29:59.000Z') });
  const f = await setup(t),
    dueToday = await f.plan(0),
    future = await f.plan(-1),
    overdue = await f.plan(6);
  await f.enable();
  const preview = await f.preview();
  assert.equal(preview.clinicDate, '2026-11-14');
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].overdueDays, 6);
  assert.equal(preview.items[0].stage, 'owner');
  assert.equal((await f.history(dueToday.id)).current.state, 'not-due');
  assert.equal((await f.history(future.id)).current.overdueDays, 0);
  const owner = f.app.locals.runFollowUpEscalations() as EscalationRun;
  assert.equal(owner.events[0].stage, 'owner');
  t.mock.timers.tick(1000);
  const clinic = f.app.locals.runFollowUpEscalations() as EscalationRun;
  assert.equal(clinic.clinicDate, '2026-11-15');
  assert.equal(clinic.events.length, 1);
  assert.equal(clinic.events[0].carePlanId, overdue.id);
  assert.equal(clinic.events[0].stage, 'clinic');
  assert.equal(clinic.events[0].overdueDays, 7);
  assert.equal(clinic.events[0].episodeId, owner.events[0].episodeId);
  assert.equal(f.app.locals.runFollowUpEscalations(), null);
  assert.equal((await f.history(overdue.id)).events.length, 2);
});

test('exact active linked recipient snapshots exclude temporary, inactive, invalid and nonclinical accounts', async (t) => {
  const f = await setup(t),
    plan = await f.plan(4);
  await f.enable();
  for (const [key, fields] of [
    ['temporary', { role: 'doctor', doctorId: plan.doctorId, mustChangePassword: true }],
    ['inactive', { role: 'doctor', doctorId: plan.doctorId, active: false }],
    ['invalid', { role: 'doctor', doctorId: 'missing-doctor' }],
    ['unlinked', { role: 'admin' }],
  ] as const)
    createUser(
      f.db,
      { id: `excluded-${key}`, name: key, email: `${key}@escalation.test`, ...fields },
      'FixturePassword2026!',
    );
  const preview = await f.preview(),
    item = preview.items[0];
  assert.equal(item.routing, 'owner');
  assert.deepEqual(
    item.recipients.map((user) => user.userId),
    [f.admin.id, f.doctor.id].sort(),
  );
  const run = await f.run(preview);
  assert.equal(run.recipientCount, 2);
  const stored = f.db
    .prepare('SELECT userId,data FROM activity WHERE eventKey=? ORDER BY userId')
    .all(`follow-up-escalation:${item.episodeId}:owner`);
  assert.deepEqual(
    stored.map((row) => row.userId),
    item.recipients.map((user) => user.userId),
  );
  for (const row of stored) {
    assert.ok(!(row.data as string).includes(privateText));
    assert.ok(!(row.data as string).includes('PRIVATE_POLICY_REASON'));
    assert.match(row.data as string, new RegExp(`/clinic/follow-ups\\?escalation=${plan.id}`));
  }
});

test('unavailable owner routes to clinic and zero recipients do not consume a stage', async (t) => {
  const f = await setup(t),
    plan = await f.plan(4);
  await f.enable();
  changeUser(f.db, f.admin.id!, { doctorId: undefined });
  changeUser(f.db, f.doctor.id!, { active: false });
  const noRecipients = await f.preview();
  assert.equal(noRecipients.readyTotal, 0);
  assert.equal(noRecipients.unroutableTotal, 1);
  assert.equal(await f.history(plan.id).catch(() => null), null); // inactive doctor cannot read history
  const checked = await f.run(noRecipients);
  assert.equal(checked.notifiedPlans, 0);
  assert.equal(checked.unroutableTotal, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM followUpEscalationEvents').get()!.n, 0);
  createUser(
    f.db,
    {
      id: 'fallback-clinician',
      name: 'Fallback clinician',
      email: 'fallback@escalation.test',
      role: 'doctor',
      doctorId: 'doctor-arjun',
    },
    'FixturePassword2026!',
  );
  const available = await f.preview();
  assert.equal(available.items[0].routing, 'owner-unavailable-fallback');
  assert.deepEqual(
    available.items[0].recipients.map((user) => user.userId),
    ['fallback-clinician'],
  );
  assert.equal((await f.run(available)).notifiedPlans, 1);
});

test('manual run exactly matches preview and retry retains original run after policy changes without duplicate notices', async (t) => {
  const f = await setup(t);
  await f.plan(10);
  await f.plan(4);
  await f.enable();
  const preview = await f.preview(),
    input = f.runBody(preview);
  const result = await f.call('/follow-up-escalations/run', f.admin, 'POST', {
    ...input,
    requestId: input.requestId.toUpperCase(),
  });
  assert.equal(result.status, 200);
  const run: EscalationRun = result.data;
  assert.equal(run.requestId, input.requestId);
  assert.equal(run.createdById, f.admin.id);
  assert.equal(run.previewRevision, preview.revision);
  assert.equal(run.notifiedPlans, preview.items.length);
  assert.equal(
    run.recipientCount,
    preview.items.reduce((n, item) => n + item.recipients.length, 0),
  );
  assert.deepEqual(
    run.events.map(
      ({
        id: _id,
        runId: _run,
        source: _source,
        policy: _policy,
        policyRevision: _revision,
        clinicDate: _date,
        createdAt: _at,
        ...item
      }) => item,
    ),
    preview.items,
  );
  const before = counts(f.db),
    replay = await f.call('/follow-up-escalations/run', f.admin, 'POST', input);
  assert.deepEqual(replay.data, run);
  assert.deepEqual(counts(f.db), before);
  await f.enable({ enabled: false });
  assert.deepEqual((await f.call('/follow-up-escalations/run', f.admin, 'POST', input)).data, run);
  assert.equal(
    (
      await f.call('/follow-up-escalations/run', f.admin, 'POST', {
        ...input,
        expectedPreviewRevision: '0'.repeat(64),
      })
    ).status,
    409,
  );
  const policyInput = await f.policyBody({ enabled: true, requestId: input.requestId });
  assert.equal(
    (await f.call('/follow-up-escalation-policy', f.admin, 'POST', policyInput)).status,
    409,
  );
  createUser(
    f.db,
    { id: 'other-admin', name: 'Other admin', email: 'other-admin@escalation.test', role: 'admin' },
    'FixturePassword2026!',
  );
  const other: Client = {};
  await f.call('/auth/login', other, 'POST', {
    email: 'other-admin@escalation.test',
    password: 'FixturePassword2026!',
  });
  assert.equal((await f.call('/follow-up-escalations/run', other, 'POST', input)).status, 409);
});

test('module state changes invalidate previews even while disabled; paused and disabled manual runs cannot send', async (t) => {
  const f = await setup(t);
  await f.plan(10);
  const disabled = await f.preview();
  await f.call('/settings', f.admin, 'PATCH', {
    modules: { intake: true, images: true, followUp: false },
  });
  const both = await f.preview();
  assert.equal(both.status, 'disabled');
  assert.notEqual(both.revision, disabled.revision);
  assert.equal(
    (await f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(disabled))).status,
    409,
  );
  await f.enable();
  const paused = await f.preview();
  assert.equal(paused.status, 'paused');
  assert.equal(
    (await f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(paused))).status,
    409,
  );
  assert.equal(f.app.locals.runFollowUpEscalations(), null);
  await f.call('/settings', f.admin, 'PATCH', {
    modules: { intake: true, images: true, followUp: true },
  });
  assert.equal((await f.run()).notifiedPlans, 1);
});

test('check-in contents and read receipts leave preview/review intent unchanged while source and recipient changes reject stale runs', async (t) => {
  const f = await setup(t),
    plan = await f.plan(5);
  await f.enable();
  const preview = await f.preview();
  for (const [note, expectedStatus] of [
    ['First patient report', 201],
    ['Edited patient report', 200],
  ] as const)
    assert.equal(
      (
        await f.call('/check-ins', f.patient, 'POST', {
          carePlanId: plan.id,
          date: clinicToday(),
          adherence: 'taken',
          feeling: 'same',
          note,
        })
      ).status,
      expectedStatus,
    );
  assert.equal((await f.preview()).revision, preview.revision);
  const beforeReviewRevision = (await f.work(plan.id)).revision;
  const run = await f.run(preview);
  assert.equal((await f.work(plan.id)).revision, beforeReviewRevision);
  const recorded = await f.preview();
  const activity = f.db
    .prepare('SELECT id FROM activity WHERE userId=? AND eventKey=?')
    .get(f.doctor.id!, `follow-up-escalation:${preview.items[0].episodeId}:owner`)!;
  assert.equal((await f.call(`/activity/${activity.id}/read`, f.doctor, 'POST', {})).status, 200);
  assert.equal((await f.preview()).revision, recorded.revision);
  const newPlan = await f.plan(4),
    stale = await f.preview();
  changeUser(f.db, f.doctor.id!, { name: 'Renamed clinician account' });
  assert.equal(
    (await f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(stale))).status,
    409,
  );
  const current = await f.preview();
  await f.review(newPlan.id, { disposition: 'complete', nextReviewDate: null });
  assert.equal(
    (await f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(current))).status,
    409,
  );
  assert.equal(run.events[0].carePlanId, plan.id);
});

test('assignment changes preserve episode and overdue age but update source preview and exact routing', async (t) => {
  const f = await setup(t),
    plan = await f.plan(5);
  await f.enable();
  createUser(
    f.db,
    {
      id: 'next-owner',
      name: 'Next owner',
      email: 'next@escalation.test',
      role: 'doctor',
      doctorId: 'doctor-arjun',
    },
    'FixturePassword2026!',
  );
  const before = await f.preview();
  const work = await f.work(plan.id);
  assert.equal(
    (
      await f.call(`/care-plans/${plan.id}/assignment`, f.admin, 'POST', {
        doctorId: 'doctor-arjun',
        reason: 'Private handover',
        expectedRevision: work.revision,
      })
    ).status,
    201,
  );
  const after = await f.preview();
  assert.equal(after.items[0].episodeId, before.items[0].episodeId);
  assert.equal(after.items[0].overdueDays, before.items[0].overdueDays);
  assert.notEqual(after.revision, before.revision);
  assert.notEqual(after.items[0].latestAssignmentId, null);
  assert.deepEqual(
    after.items[0].recipients.map((user) => user.userId),
    ['next-owner'],
  );
  assert.equal(
    (await f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(before))).status,
    409,
  );
  await f.run(after);
  const latest = await f.work(plan.id);
  await f.call(`/care-plans/${plan.id}/assignment`, f.admin, 'POST', {
    doctorId: plan.doctorId,
    reason: 'Return responsibility',
    expectedRevision: latest.revision,
  });
  assert.equal((await f.preview()).readyTotal, 0);
  assert.equal((await f.history(plan.id)).events.length, 1);
});

test('new clinical/status reviews start a new episode and completed plans stop; historical episodes remain readable', async (t) => {
  const f = await setup(t),
    plan = await f.plan(10);
  await f.enable();
  const original = await f.run();
  await f.review(plan.id);
  const current = await f.history(plan.id);
  assert.equal(current.current.state, 'not-due');
  assert.notEqual(current.current.episodeId, original.events[0].episodeId);
  const next = rawReview(f.db, plan, addDays(clinicToday(), -8));
  const preview = await f.preview();
  assert.equal(preview.items[0].latestReviewId, next.id);
  const second = await f.run(preview);
  assert.notEqual(second.events[0].episodeId, original.events[0].episodeId);
  const row = await f.work(plan.id);
  assert.equal(
    (
      await f.call(`/care-plans/${plan.id}`, f.doctor, 'PATCH', {
        status: 'completed',
        expectedRevision: row.revision,
      })
    ).status,
    200,
  );
  const completed = await f.history(plan.id);
  assert.equal(completed.current.state, 'completed');
  assert.equal(completed.current.episodeId, null);
  assert.equal(completed.events.length, 2);
  assert.equal((await f.preview()).readyTotal, 0);
  const completedWork = await f.work(plan.id);
  await f.call(`/care-plans/${plan.id}`, f.doctor, 'PATCH', {
    status: 'active',
    expectedRevision: completedWork.revision,
  });
  const active = await f.history(plan.id);
  assert.equal(active.current.state, 'not-due');
  assert.equal(active.current.reviewDate, clinicToday());
});

test('owner notices may advance to clinic, but sent clinic stage never falls back to owner after policy changes', async (t) => {
  const f = await setup(t),
    plan = await f.plan(5);
  await f.enable();
  const first = await f.run();
  assert.equal(first.events[0].stage, 'owner');
  await f.enable({ clinicAfterDays: 4 });
  const next = await f.run();
  assert.equal(next.events[0].stage, 'clinic');
  assert.equal(next.events[0].episodeId, first.events[0].episodeId);
  await f.enable({ clinicAfterDays: 90 });
  const preview = await f.preview();
  assert.equal(preview.readyTotal, 0);
  assert.equal(preview.alreadyNotifiedTotal, 1);
  assert.equal((await f.history(plan.id)).current.state, 'recorded');
  const zero = await f.run(preview);
  assert.equal(zero.notifiedPlans, 0);
  assert.equal(zero.recipientCount, 0);
});

test('audit and activity failures roll back manual runs, receipts and all notices; exact retry remains possible', async (t) => {
  const f = await setup(t);
  await f.plan(10);
  await f.plan(4);
  await f.enable();
  const input = f.runBody(await f.preview());
  for (const table of ['audit', 'activity']) {
    const condition =
      table === 'audit'
        ? "json_extract(NEW.data,'$.action')='recorded follow-up escalation check'"
        : "NEW.eventKey LIKE 'follow-up-escalation:%'";
    const before = counts(f.db);
    f.db.exec(
      `CREATE TRIGGER escalation_failure BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic escalation rollback'); END;`,
    );
    try {
      assert.equal(
        (await f.call('/follow-up-escalations/run', f.admin, 'POST', input)).status,
        500,
      );
      assert.deepEqual(counts(f.db), before);
    } finally {
      f.db.exec('DROP TRIGGER escalation_failure');
    }
  }
  assert.equal((await f.call('/follow-up-escalations/run', f.admin, 'POST', input)).status, 200);
});

test('policy audit failure rolls back changes and command; source evidence rejects SQL updates and deletion', async (t) => {
  const f = await setup(t),
    input = await f.policyBody({ enabled: true }),
    before = counts(f.db);
  f.db.exec(
    "CREATE TRIGGER escalation_policy_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='changed follow-up escalation policy' BEGIN SELECT RAISE(ABORT,'Synthetic policy rollback'); END;",
  );
  try {
    assert.equal(
      (await f.call('/follow-up-escalation-policy', f.admin, 'POST', input)).status,
      500,
    );
    assert.deepEqual(counts(f.db), before);
  } finally {
    f.db.exec('DROP TRIGGER escalation_policy_failure');
  }
  assert.equal((await f.call('/follow-up-escalation-policy', f.admin, 'POST', input)).status, 200);
  await f.plan(10);
  await f.run();
  for (const table of [
    'followUpEscalationPolicyChanges',
    'followUpEscalationRuns',
    'followUpEscalationEvents',
    'followUpEscalationCommands',
  ]) {
    assert.throws(
      () =>
        f.db.exec(
          `UPDATE ${table} SET ${table === 'followUpEscalationCommands' ? 'payload=payload' : 'data=data'}`,
        ),
      /immutable/,
    );
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  assert.equal(f.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('parallel same-command checks replay once and competing fresh previews cannot duplicate notifications', async (t) => {
  const f = await setup(t);
  await f.plan(10);
  await f.enable();
  const input = f.runBody(await f.preview());
  const same = await Promise.all([
    f.call('/follow-up-escalations/run', f.admin, 'POST', input),
    f.call('/follow-up-escalations/run', f.admin, 'POST', input),
  ]);
  assert.deepEqual(
    same.map((value) => value.status),
    [200, 200],
  );
  assert.deepEqual(same[0].data, same[1].data);
  await f.plan(8);
  const preview = await f.preview();
  const different = await Promise.all([
    f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(preview)),
    f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(preview)),
  ]);
  assert.deepEqual(different.map((value) => value.status).sort(), [200, 409]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM followUpEscalationEvents').get()!.n, 2);
});

test('batch evaluation sorts oldest date/ID, limits200 notices, drains backlog and never decodes clinical content', async (t) => {
  const f = await setup(t),
    original = await f.plan(10);
  await f.enable();
  const all = [original];
  f.db.exec('BEGIN');
  try {
    for (let i = 0; i < 224; i++)
      all.push(seedPlan(f.db, original, { followUpDate: addDays(clinicToday(), -(3 + (i % 20))) }));
    f.db.exec('COMMIT');
  } catch (error) {
    f.db.exec('ROLLBACK');
    throw error;
  }
  for (const plan of all.slice(0, 5)) rawReview(f.db, plan, plan.followUpDate);
  let clinicalDecodes = 0;
  const parse = JSON.parse;
  const mock = t.mock.method(
    JSON,
    'parse',
    (value: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      const result = parse(value, reviver);
      if (
        result?.instructions === privateText ||
        result?.assessment === privateText ||
        result?.note === privateText
      )
        clinicalDecodes++;
      return result;
    },
  );
  const preview = await f.preview();
  assert.equal(preview.readyTotal, 225);
  assert.equal(preview.items.length, 200);
  assert.equal(clinicalDecodes, 0);
  const expected = [...all].sort(
    (a, b) => a.followUpDate.localeCompare(b.followUpDate) || a.id.localeCompare(b.id),
  );
  assert.deepEqual(
    preview.items.map((item) => item.carePlanId),
    expected.slice(0, 200).map((plan) => plan.id),
  );
  const first = await f.run(preview);
  assert.equal(first.notifiedPlans, 200);
  assert.equal(first.remainingReady, 25);
  assert.equal(clinicalDecodes, 0);
  mock.mock.restore();
  const secondPreview = await f.preview();
  assert.equal(secondPreview.readyTotal, 25);
  assert.equal(secondPreview.alreadyNotifiedTotal, 200);
  assert.deepEqual(
    secondPreview.items.map((item) => item.carePlanId),
    expected.slice(200).map((plan) => plan.id),
  );
  const next = await f.run(secondPreview);
  assert.equal(next.notifiedPlans, 25);
  assert.equal(next.remainingReady, 0);
  assert.equal((await f.preview()).alreadyNotifiedTotal, 225);
});

test('operational policy/notices do not change patient summaries or clinical review revisions and never notify patients', async (t) => {
  const f = await setup(t),
    plan = await f.plan(10);
  const before = (await f.call('/patients/patient-ananya/care-summary', f.patient)).data,
    revision = (await f.work(plan.id)).revision;
  const patientNotices = f.db
    .prepare('SELECT count(*) n FROM activity WHERE userId=?')
    .get(f.patient.id!)!.n;
  await f.enable();
  const run = await f.run();
  assert.equal(run.notifiedPlans, 1);
  const after = (await f.call('/patients/patient-ananya/care-summary', f.patient)).data;
  assert.equal(after.revision, before.revision);
  assert.equal((await f.work(plan.id)).revision, revision);
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM activity WHERE userId=?').get(f.patient.id!)!.n,
    patientNotices,
  );
  const care = (await f.call('/care-plans', f.patient)).data.find(
    (row: CarePlan) => row.id === plan.id,
  );
  assert.equal('escalation' in care, false);
  assert.ok(!JSON.stringify(after).includes(run.events[0].episodeId));
  const request = await f.call(`/care-plans/${plan.id}/escalations`, f.doctor);
  assert.match(request.headers.get('cache-control')!, /no-store/);
});

test('automatic service records truthful system runs, skips empty polls and reports generic failure without consuming stages', async (t) => {
  const f = await setup(t),
    plan = await f.plan(10);
  await f.enable();
  f.db.exec(
    "CREATE TRIGGER escalation_worker_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='recorded automatic follow-up escalation check' BEGIN SELECT RAISE(ABORT,'PRIVATE_FAILURE_TEXT'); END;",
  );
  const messages: unknown[][] = [];
  const log = t.mock.method(console, 'error', (...args: unknown[]) => {
    messages.push(args);
  });
  try {
    assert.equal(f.app.locals.runFollowUpEscalations(), null);
  } finally {
    f.db.exec('DROP TRIGGER escalation_worker_failure');
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM followUpEscalationEvents').get()!.n, 0);
  const failed = await f.policy();
  assert.ok(failed.worker.lastErrorAt);
  assert.equal(failed.worker.lastCheckedAt, null);
  assert.ok(!JSON.stringify(messages).includes('PRIVATE_FAILURE_TEXT'));
  log.mock.restore();
  const run = f.app.locals.runFollowUpEscalations() as EscalationRun;
  assert.equal(run.source, 'automatic');
  assert.equal(run.requestId, null);
  assert.equal(run.createdById, null);
  assert.equal(run.createdByName, 'Follow-up scheduler');
  assert.equal(run.events[0].carePlanId, plan.id);
  const before = counts(f.db);
  assert.equal(f.app.locals.runFollowUpEscalations(), null);
  assert.deepEqual(counts(f.db), before);
  const checked = await f.policy();
  assert.ok(checked.worker.lastCheckedAt);
  assert.equal(checked.worker.lastRunId, run.id);
  const audit = f.db
    .prepare("SELECT data FROM audit WHERE json_extract(data,'$.entityId')=?")
    .get(run.id)!;
  assert.equal(JSON.parse(audit.data as string).actorName, 'Follow-up scheduler');
});

test('real runner starts once, catches up immediately, installs an unref15-minute interval and stops before database close', async (t) => {
  const f = await setup(t);
  await f.plan(10);
  await f.enable();
  const realInterval = globalThis.setInterval,
    realClear = globalThis.clearInterval;
  const handles: ReturnType<typeof setInterval>[] = [],
    callbacks: (() => unknown)[] = [],
    delays: number[] = [],
    cleared: unknown[] = [];
  t.mock.method(globalThis, 'setInterval', (handler: () => unknown, delay?: number) => {
    callbacks.push(handler);
    delays.push(delay!);
    const handle = realInterval(() => {}, 3_600_000);
    handles.push(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearInterval', (handle: ReturnType<typeof setInterval>) => {
    cleared.push(handle);
    realClear(handle);
  });
  f.app.locals.startFollowUpEscalations();
  f.app.locals.startFollowUpEscalations();
  assert.deepEqual(delays, [900_000]);
  assert.equal(handles[0].hasRef(), false);
  assert.equal((await f.policy()).worker.automaticEnabled, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM followUpEscalationRuns').get()!.n, 1);
  callbacks[0]();
  assert.equal(f.db.prepare('SELECT count(*) n FROM followUpEscalationRuns').get()!.n, 1);
  await f.plan(10);
  callbacks[0]();
  assert.equal(f.db.prepare('SELECT count(*) n FROM followUpEscalationRuns').get()!.n, 2);
  await f.cleanup();
  assert.deepEqual(cleared, handles);
});

test('restart and a second application connection share stage dedupe and preserve exact command receipts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'follow-up-escalation-')),
    databasePath = join(directory, 'clinic.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = openDatabase(databasePath);
  seedDemo(legacy);
  legacy.close();
  const first = await setup(t, databasePath);
  await first.plan(10);
  await first.enable();
  const preview = await first.preview(),
    input = first.runBody(preview);
  const saved = await first.call('/follow-up-escalations/run', first.admin, 'POST', input);
  assert.equal(saved.status, 200);
  const second = createApp({ databasePath, demoMode: false });
  try {
    assert.equal(second.locals.runFollowUpEscalations(), null);
    assert.equal(
      second.locals.db.prepare('SELECT count(*) n FROM followUpEscalationEvents').get().n,
      1,
    );
  } finally {
    second.locals.close();
  }
  await first.cleanup();
  const restarted = await setup(t, databasePath, false);
  const replay = await restarted.call('/follow-up-escalations/run', restarted.admin, 'POST', input);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved.data);
  assert.equal(restarted.db.prepare('SELECT count(*) n FROM followUpEscalationEvents').get()!.n, 1);
  assert.equal(restarted.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
});

test('preview source and recipient reads are coherent with their audit against an external writer', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'follow-up-escalation-snapshot-')),
    databasePath = join(directory, 'clinic.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await setup(t, databasePath),
    plan = await f.plan(10);
  await f.enable();
  const writer = openDatabase(databasePath);
  writer.exec('PRAGMA busy_timeout=0');
  t.after(() => writer.close());
  let intercepted = false;
  const prepare = f.db.prepare.bind(f.db);
  const mutation = () =>
    writer
      .prepare("UPDATE carePlans SET data=json_set(data,'$.followUpDate',?) WHERE id=?")
      .run(clinicToday(), plan.id);
  const mock = t.mock.method(f.db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql.includes('SELECT p.id AS carePlanId')) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...values: SQLInputValue[]) => {
        const rows = all(...values);
        if (!intercepted) {
          assert.throws(mutation, /locked/);
          intercepted = true;
        }
        return rows;
      });
    }
    return statement;
  });
  const preview = await f.preview();
  assert.equal(intercepted, true);
  assert.equal(preview.readyTotal, 1);
  mock.mock.restore();
  mutation();
  assert.equal((await f.preview()).readyTotal, 0);
  assert.equal(
    (await f.call('/follow-up-escalations/run', f.admin, 'POST', f.runBody(preview))).status,
    409,
  );
});
