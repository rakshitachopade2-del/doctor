import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser } from '../server/db.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server, base: string;
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  admin: Client = {},
  reception: Client = {},
  patient: Client = {},
  other: Client = {},
  unlinked: Client = {};
async function call(
  path: string,
  { method = 'GET', body, client = {} }: { method?: string; body?: unknown; client?: Client } = {},
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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
let planCounter = 0;
async function newPlan(overrides: Record<string, unknown> = {}) {
  const result = await call('/care-plans', {
    method: 'POST',
    client: doctor,
    body: {
      patientId: 'patient-ananya',
      title: `Follow-up test ${++planCounter}`,
      instructions: 'Original clinician instructions.',
      expectations: 'Discuss progress with your clinic.',
      warnings: 'Synthetic test only.',
      cost: 'Discuss with clinic',
      startDate: addDays(clinicToday(), -2),
      endDate: addDays(clinicToday(), 14),
      followUpDate: clinicToday(),
      medications: [],
      ...overrides,
    },
  });
  assert.equal(result.status, 201);
  return result.data;
}
async function summary(planId: string, client = doctor) {
  const result = await call('/care-plans', { client });
  assert.equal(result.status, 200);
  return result.data.find((plan: any) => plan.id === planId);
}
async function work(planId: string) {
  const result = await call('/follow-up-worklist?scope=all', { client: doctor });
  assert.equal(result.status, 200);
  return result.data.find((item: any) => item.carePlan.id === planId);
}
async function checkIn(planId: string, note = 'Patient-reported check-in.', feeling = 'same') {
  return call('/check-ins', {
    method: 'POST',
    client: patient,
    body: { carePlanId: planId, date: clinicToday(), adherence: 'taken', feeling, note },
  });
}
async function review(planId: string, overrides: Record<string, unknown> = {}) {
  const current = await summary(planId);
  return call(`/care-plans/${planId}/reviews`, {
    method: 'POST',
    client: doctor,
    body: {
      expectedRevision: current.followUpRevision,
      assessment: 'Internal clinician assessment.',
      patientInstructions: 'Your clinician shared these follow-up instructions.',
      disposition: 'continue',
      nextReviewDate: addDays(clinicToday(), 7),
      ...overrides,
    },
  });
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
    ['admin', admin],
    ['reception', reception],
    ['patient', patient],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', {
          method: 'POST',
          client,
          body: { email: `${role}@derma.demo`, password: 'DemoClinic2026!' },
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call('/auth/register', {
        method: 'POST',
        client: other,
        body: {
          name: 'Other follow-up patient',
          email: 'followup-other@example.test',
          password: 'OtherFollowup2026!',
          phone: '9000000099',
          dob: '1992-03-04',
          gender: 'Other',
        },
      })
    ).status,
    201,
  );
  createUser(
    app.locals.db,
    {
      id: 'followup-unlinked-admin',
      name: 'Unlinked clinic administrator',
      email: 'followup-unlinked@example.test',
      role: 'admin',
    },
    'FollowupAdmin2026!',
  );
  assert.equal(
    (
      await call('/auth/login', {
        method: 'POST',
        client: unlinked,
        body: { email: 'followup-unlinked@example.test', password: 'FollowupAdmin2026!' },
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

test('follow-up worklists respect roles, owner scope and compatible initial plan hydration', async () => {
  assert.equal((await call('/follow-up-worklist')).status, 401);
  assert.equal((await call('/follow-up-worklist', { client: patient })).status, 403);
  assert.equal((await call('/follow-up-worklist', { client: reception })).status, 403);
  const mine = await call('/follow-up-worklist', { client: doctor });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.length > 0);
  assert.ok(mine.data.every((item: any) => item.ownerDoctorId === 'doctor-meera'));
  const all = await call('/follow-up-worklist', { client: admin });
  assert.ok(all.data.some((item: any) => item.ownerDoctorId === 'doctor-arjun'));
  const plan = await newPlan(),
    current = await summary(plan.id);
  assert.equal(current.effectiveStatus, 'active');
  assert.equal(current.effectiveFollowUpDate, plan.followUpDate);
  assert.equal(current.latestReview, null);
  assert.match(current.followUpRevision, /^[a-f0-9]{64}$/);
  assert.equal((await call(`/care-plans/${plan.id}/reviews`, { client: other })).status, 403);
  assert.equal((await call(`/care-plans/${plan.id}/reviews`, { client: reception })).status, 403);
  assert.deepEqual((await call(`/care-plans/${plan.id}/reviews`, { client: patient })).data, []);
});

test('clinical follow-up changes effective due dates while preserving original regimen and private assessment', async () => {
  const plan = await newPlan();
  assert.equal((await checkIn(plan.id)).status, 201);
  const item = await work(plan.id);
  assert.equal(item.due, true);
  assert.equal(item.unreviewedCount, 1);
  assert.equal(item.revision, item.carePlan.followUpRevision);
  const before = (await call('/dashboard', { client: doctor })).data.stats.followUps;
  const saved = await review(plan.id, { assessment: 'PRIVATE_ASSESSMENT_NOT_FOR_PATIENT' });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.effectiveFollowUpDate, addDays(clinicToday(), 7));
  assert.equal(saved.data.followUpDate, plan.followUpDate);
  assert.equal(saved.data.startDate, plan.startDate);
  assert.equal(saved.data.endDate, plan.endDate);
  assert.equal(saved.data.instructions, plan.instructions);
  assert.deepEqual(saved.data.medications, plan.medications);
  const reviewed = await work(plan.id);
  assert.equal(reviewed.due, false);
  assert.equal(reviewed.unreviewedCount, 0);
  assert.equal(reviewed.latestReview.checkInSnapshots.length, 1);
  assert.equal((await call('/dashboard', { client: doctor })).data.stats.followUps, before - 1);
  const own = await summary(plan.id, patient);
  assert.ok(own.latestReview.patientInstructions);
  assert.ok(!('assessment' in own.latestReview));
  assert.ok(!('checkInSnapshots' in own.latestReview));
  const ownHistory = (await call(`/care-plans/${plan.id}/reviews`, { client: patient })).data;
  assert.ok(!JSON.stringify(ownHistory).includes('PRIVATE_ASSESSMENT_NOT_FOR_PATIENT'));
  assert.ok(!('assessment' in ownHistory[0]));
  const record = (await call('/patients/patient-ananya', { client: patient })).data;
  assert.ok(!JSON.stringify(record).includes('PRIVATE_ASSESSMENT_NOT_FOR_PATIENT'));
  assert.equal(
    record.carePlans.find((value: any) => value.id === plan.id).effectiveFollowUpDate,
    addDays(clinicToday(), 7),
  );
});

test('same-day edited check-ins reenter review and retain the exact previously reviewed snapshot', async () => {
  const plan = await newPlan();
  const initial = await checkIn(plan.id, 'Original patient report.');
  assert.equal(initial.status, 201);
  const saved = await review(plan.id);
  assert.equal(saved.status, 201);
  const previous = saved.data.latestReview.checkInSnapshots[0];
  const changed = await checkIn(
    plan.id,
    'Edited patient report with a different concern.',
    'worse',
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.data.id, initial.data.id);
  const item = await work(plan.id);
  assert.equal(item.unreviewedCount, 1);
  assert.equal(item.unreviewedCheckIns[0].note, 'Edited patient report with a different concern.');
  assert.notEqual(item.revision, saved.data.followUpRevision);
  const stale = await call(`/care-plans/${plan.id}/reviews`, {
    method: 'POST',
    client: doctor,
    body: {
      expectedRevision: saved.data.followUpRevision,
      assessment: 'Stale interpretation',
      patientInstructions: 'Stale instructions',
      disposition: 'continue',
      nextReviewDate: addDays(clinicToday(), 7),
    },
  });
  assert.equal(stale.status, 409);
  const history = (await call(`/care-plans/${plan.id}/reviews`, { client: doctor })).data;
  assert.equal(history[0].checkInSnapshots[0].snapshot.note, 'Original patient report.');
  assert.equal(history[0].checkInSnapshots[0].contentHash, previous.contentHash);
  const latest = await review(plan.id);
  assert.equal(latest.status, 201);
  assert.notEqual(latest.data.latestReview.checkInSnapshots[0].contentHash, previous.contentHash);
  assert.equal((await work(plan.id)).unreviewedCount, 0);
  assert.throws(() => app.locals.db.exec("UPDATE followUpReviews SET data='{}'"), /append-only/);
  assert.throws(() => app.locals.db.exec('DELETE FROM followUpReviews'), /append-only/);
});

test('reviews require linked clinician identity, meaningful text, valid dates and server-derived snapshots', async () => {
  const plan = await newPlan(),
    current = await summary(plan.id);
  const body = {
    expectedRevision: current.followUpRevision,
    assessment: 'Clinical assessment',
    patientInstructions: 'Patient instructions',
    disposition: 'continue',
    nextReviewDate: addDays(clinicToday(), 3),
  };
  for (const [client, status] of [
    [patient, 403],
    [reception, 403],
    [unlinked, 400],
  ] as const)
    assert.equal(
      (await call(`/care-plans/${plan.id}/reviews`, { method: 'POST', client, body })).status,
      status,
    );
  for (const overrides of [
    { assessment: '' },
    { patientInstructions: '' },
    { nextReviewDate: null },
    { nextReviewDate: addDays(clinicToday(), -1) },
    { nextReviewDate: '2026-02-30' },
    { expectedRevision: 'not-a-revision' },
    { source: 'status-change' },
    { checkInSnapshots: [] },
  ])
    assert.equal(
      (
        await call(`/care-plans/${plan.id}/reviews`, {
          method: 'POST',
          client: doctor,
          body: { ...body, ...overrides },
        })
      ).status,
      400,
    );
});

test('competing reviews accept one revision once and notify the patient without private assessment', async () => {
  const plan = await newPlan(),
    current = await summary(plan.id);
  const body = {
    expectedRevision: current.followUpRevision,
    assessment: 'SECRET_REVIEW_CONTENT',
    patientInstructions: 'Please read the care update.',
    disposition: 'visit-requested',
    nextReviewDate: addDays(clinicToday(), 5),
  };
  const beforeAppointments = (await call('/appointments', { client: patient })).data.length;
  const results = await Promise.all([
    call(`/care-plans/${plan.id}/reviews`, { method: 'POST', client: doctor, body }),
    call(`/care-plans/${plan.id}/reviews`, {
      method: 'POST',
      client: admin,
      body: { ...body, assessment: 'Other clinician concurrent review' },
    }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const history = (await call(`/care-plans/${plan.id}/reviews`, { client: doctor })).data;
  assert.equal(history.length, 1);
  const feed = await call('/activity', { client: patient });
  const updates = feed.data.items.filter(
    (item: any) => item.kind === 'follow-up' && item.href === `/my-care?plan=${plan.id}`,
  );
  assert.equal(updates.length, 1);
  assert.ok(!JSON.stringify(updates).includes('SECRET_REVIEW_CONTENT'));
  assert.ok(!JSON.stringify(updates).includes('assessment'));
  assert.equal((await call('/appointments', { client: patient })).data.length, beforeAppointments);
});

test('completion closes the active routine without erasing its worklist or review history', async () => {
  const plan = await newPlan();
  await checkIn(plan.id);
  const saved = await review(plan.id, { disposition: 'complete', nextReviewDate: null });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.status, 'completed');
  assert.equal(saved.data.effectiveStatus, 'completed');
  assert.equal(saved.data.effectiveFollowUpDate, null);
  assert.equal(saved.data.latestReview.nextReviewDate, null);
  const item = await work(plan.id);
  assert.ok(item);
  assert.equal(item.due, false);
  assert.equal(item.carePlan.effectiveStatus, 'completed');
  assert.equal((await checkIn(plan.id, 'Cannot check in on a completed plan.')).status, 409);
  const reopened = await review(plan.id, {
    disposition: 'continue',
    nextReviewDate: addDays(clinicToday(), 2),
  });
  assert.equal(reopened.status, 201);
  assert.equal(reopened.data.status, 'active');
  assert.equal((await checkIn(plan.id, 'New report after reopening.')).status, 200);
});

test('legacy status updates are recorded honestly and cannot clear unreviewed clinical reports', async () => {
  const plan = await newPlan();
  await checkIn(plan.id, 'Not yet clinically reviewed.');
  const completed = await call(`/care-plans/${plan.id}`, {
    method: 'PATCH',
    client: doctor,
    body: { status: 'completed' },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.latestReview.source, 'status-change');
  assert.equal(completed.data.latestReview.assessment, '');
  assert.match(completed.data.latestReview.patientInstructions, /No new clinical instructions/);
  assert.equal((await work(plan.id)).unreviewedCount, 1);
  const same = await call(`/care-plans/${plan.id}`, {
    method: 'PATCH',
    client: doctor,
    body: { status: 'completed' },
  });
  assert.equal(same.status, 200);
  assert.equal(same.data.followUpRevision, completed.data.followUpRevision);
  assert.equal((await call(`/care-plans/${plan.id}/reviews`, { client: doctor })).data.length, 1);
  const reopened = await call(`/care-plans/${plan.id}`, {
    method: 'PATCH',
    client: doctor,
    body: { status: 'active' },
  });
  assert.equal(reopened.status, 200);
  assert.equal((await work(plan.id)).unreviewedCount, 1);
  assert.equal(
    (
      await call(`/care-plans/${plan.id}`, {
        method: 'PATCH',
        client: doctor,
        body: { status: 'completed', expectedRevision: completed.data.followUpRevision },
      })
    ).status,
    409,
  );
  assert.equal((await review(plan.id)).status, 201);
  assert.equal((await work(plan.id)).unreviewedCount, 0);
});

test('continued follow-up never extends the original treatment dates automatically', async () => {
  const plan = await newPlan({
    startDate: addDays(clinicToday(), -7),
    endDate: addDays(clinicToday(), -1),
  });
  const saved = await review(plan.id);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.endDate, plan.endDate);
  assert.equal(saved.data.effectiveFollowUpDate, addDays(clinicToday(), 7));
  assert.equal((await checkIn(plan.id, 'The original treatment period has ended.')).status, 400);
});

test('disabling the follow-up module pauses new clinical reviews but preserves history and core closure', async () => {
  const plan = await newPlan();
  await review(plan.id);
  await call('/settings', {
    method: 'PATCH',
    client: admin,
    body: { modules: { intake: true, images: true, followUp: false } },
  });
  try {
    assert.equal((await review(plan.id)).status, 403);
    assert.equal((await call(`/care-plans/${plan.id}/reviews`, { client: patient })).status, 200);
    assert.equal(
      (
        await call(`/care-plans/${plan.id}`, {
          method: 'PATCH',
          client: doctor,
          body: { status: 'completed' },
        })
      ).status,
      200,
    );
  } finally {
    await call('/settings', {
      method: 'PATCH',
      client: admin,
      body: { modules: { intake: true, images: true, followUp: true } },
    });
  }
});
