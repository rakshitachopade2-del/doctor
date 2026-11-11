import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser, get, openDatabase, seedDemo } from '../server/db.ts';
import type { Investigation } from '../shared/clinical.ts';
import type {
  InvestigationReviewContext,
  InvestigationWorkItem,
} from '../shared/investigation-worklist.ts';
import type { User } from '../shared/types.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string };
const admin: Client = {},
  unlinked: Client = {},
  doctor: Client = {},
  arjun: Client = {},
  reception: Client = {},
  patient: Client = {},
  temporary: Client = {};
let server: Server, base: string;
async function call(
  path: string,
  client: Client = admin,
  method = 'GET',
  body?: unknown,
  target = base,
) {
  const response = await fetch(`${target}/api${path}`, {
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
  return { status: response.status, data, headers: response.headers };
}
async function listen(application: ReturnType<typeof createApp>) {
  let instance: Server;
  await new Promise<void>((resolve) => {
    instance = application.listen(0, '127.0.0.1', () => resolve());
  });
  const address = instance!.address();
  assert.ok(address && typeof address !== 'string');
  return { server: instance!, base: `http://127.0.0.1:${address.port}` };
}
async function close(instance: Server) {
  await new Promise<void>((resolve, reject) =>
    instance.close((error) => (error ? reject(error) : resolve())),
  );
}
async function order(
  overrides: Record<string, unknown> = {},
  client = doctor,
): Promise<Investigation> {
  const response = await call('/investigations', client, 'POST', {
    patientId: 'patient-ananya',
    title: 'Synthetic review queue order',
    kind: 'laboratory',
    reason: 'Synthetic clinical question',
    instructions: 'Clinic-entered report instructions',
    dueDate: addDays(clinicToday(), 3),
    ...overrides,
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
async function context(
  investigationId: string,
  client = doctor,
): Promise<InvestigationReviewContext> {
  const response = await call(`/investigations/${investigationId}/review-context`, client);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function result(investigationId: string, client = patient): Promise<Investigation> {
  const response = await call(`/investigations/${investigationId}/results`, client, 'POST', {
    note: 'Synthetic unreviewed result',
    documentIds: [],
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
async function assignmentBody(investigationId: string, overrides: Record<string, unknown> = {}) {
  return {
    doctorId: 'doctor-arjun',
    reason: 'Internal clinical handover',
    expectedRevision: (await context(investigationId)).revision,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function assign(
  investigationId: string,
  overrides: Record<string, unknown> = {},
  client = doctor,
) {
  return call(
    `/investigations/${investigationId}/assignment`,
    client,
    'POST',
    await assignmentBody(investigationId, overrides),
  );
}
async function reviewBody(investigationId: string, overrides: Record<string, unknown> = {}) {
  const current = await context(investigationId);
  return {
    resultId: current.latestResultId,
    summary: 'Clinician-entered interpretation',
    followUp: 'Clinician-entered follow-up instructions',
    publishToPatient: false,
    expectedRevision: current.revision,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function review(
  investigationId: string,
  overrides: Record<string, unknown> = {},
  client = doctor,
) {
  return call(
    `/investigations/${investigationId}/reviews`,
    client,
    'POST',
    await reviewBody(investigationId, overrides),
  );
}
function activityFor(eventKey: string) {
  return app.locals.db
    .prepare('SELECT userId,data FROM activity WHERE eventKey=? ORDER BY userId')
    .all(eventKey) as { userId: string; data: string }[];
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'queue-arjun',
      name: 'Queue clinician Arjun',
      email: 'queue-arjun@example.test',
      role: 'doctor',
      doctorId: 'doctor-arjun',
    },
    'QueueClinician2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'queue-unlinked-admin',
      name: 'Queue administrator',
      email: 'queue-admin@example.test',
      role: 'admin',
    },
    'QueueAdministrator2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'queue-temporary-admin',
      name: 'Temporary administrator',
      email: 'queue-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'QueueTemporary2026!',
  );
  ({ server, base } = await listen(app));
  for (const [role, client] of [
    ['admin', admin],
    ['doctor', doctor],
    ['reception', reception],
    ['patient', patient],
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
  for (const [client, email, password] of [
    [arjun, 'queue-arjun@example.test', 'QueueClinician2026!'],
    [unlinked, 'queue-admin@example.test', 'QueueAdministrator2026!'],
    [temporary, 'queue-temp@example.test', 'QueueTemporary2026!'],
  ] as const)
    assert.equal((await call('/auth/login', client, 'POST', { email, password })).status, 200);
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('queue, context and eligible-owner reads are clinical-only; unlinked administrators may manage responsibility but cannot review', async () => {
  const created = await order();
  for (const path of [
    '/investigation-worklist',
    '/investigation-owners',
    `/investigations/${created.id}/review-context`,
  ]) {
    assert.equal((await call(path, {})).status, 401);
    for (const client of [patient, reception, temporary])
      assert.equal((await call(path, client)).status, 403);
    for (const client of [doctor, arjun, admin, unlinked]) {
      const response = await call(path, client);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal((await call('/investigation-worklist?scope=bad')).status, 400);
  assert.equal((await call('/investigations/missing/review-context')).status, 404);
  const body = await assignmentBody(created.id);
  assert.equal(
    (await call(`/investigations/${created.id}/assignment`, { cookie: admin.cookie }, 'POST', body))
      .status,
    403,
  );
  for (const client of [patient, reception, temporary])
    assert.equal(
      (await call(`/investigations/${created.id}/assignment`, client, 'POST', body)).status,
      403,
    );
  assert.equal(
    (await call(`/investigations/${created.id}/assignment`, arjun, 'POST', body)).status,
    403,
  );
  assert.equal(
    (await call(`/investigations/${created.id}/assignment`, unlinked, 'POST', body)).status,
    201,
  );
  await result(created.id);
  assert.equal((await review(created.id, {}, unlinked)).status, 400);
  // Responsibility is an operational owner, not an access boundary for other linked clinicians.
  assert.equal((await review(created.id, {}, doctor)).status, 201);
});

test('owner choices expose professional profiles and active-account counts without login identities', async () => {
  const owners = await call('/investigation-owners');
  const meera = owners.data.find(
    (entry: { doctorId: string }) => entry.doctorId === 'doctor-meera',
  );
  const other = owners.data.find(
    (entry: { doctorId: string }) => entry.doctorId === 'doctor-arjun',
  );
  assert.equal(meera.activeAccounts, 2);
  assert.equal(other.activeAccounts, 1);
  for (const owner of owners.data)
    assert.deepEqual(Object.keys(owner).sort(), ['activeAccounts', 'doctorId', 'doctorName']);
  const original = get<User>(app.locals.db, 'users', 'queue-arjun')!;
  app.locals.db
    .prepare('UPDATE users SET data=? WHERE id=?')
    .run(JSON.stringify({ ...original, mustChangePassword: true }), original.id);
  try {
    assert.ok(
      (await call('/investigation-owners')).data.some(
        (entry: { doctorId: string }) => entry.doctorId === 'doctor-arjun',
      ),
    );
  } finally {
    app.locals.db
      .prepare('UPDATE users SET data=? WHERE id=?')
      .run(JSON.stringify(original), original.id);
  }
});

test('queue state targets the latest result and latest review without treating requested dates as review deadlines', async () => {
  const ordered = await order({ dueDate: clinicToday() }),
    noDate = await order({ dueDate: null });
  const original = get<Investigation>(app.locals.db, 'investigations', ordered.id)!;
  const past = { ...original, id: randomUUID(), dueDate: addDays(clinicToday(), -1) };
  app.locals.db
    .prepare('INSERT INTO investigations(id,patientId,data) VALUES (?,?,?)')
    .run(past.id, past.patientId, JSON.stringify(past));
  assert.equal((await context(ordered.id)).pastRequestedDate, false);
  assert.equal((await context(noDate.id)).pastRequestedDate, false);
  assert.equal((await context(past.id)).pastRequestedDate, true);
  const received = await result(past.id),
    firstResultId = received.results.at(-1)!.id;
  let current = await context(past.id);
  assert.equal(current.needsReview, true);
  assert.equal(current.pastRequestedDate, false);
  assert.equal(current.latestReviewId, null);
  const privateReview = await review(past.id);
  assert.equal(privateReview.status, 201);
  current = await context(past.id);
  assert.equal(current.needsReview, false);
  assert.equal(current.awaitingPublication, true);
  const firstReviewId = current.latestReviewId!;
  assert.equal(
    (await call(`/investigations/${past.id}/reviews/${firstReviewId}/publish`, doctor, 'POST', {}))
      .status,
    200,
  );
  assert.equal((await context(past.id)).awaitingPublication, false);
  const supplemental = await result(past.id),
    latestResultId = supplemental.results.at(-1)!.id;
  assert.notEqual(firstResultId, latestResultId);
  current = await context(past.id);
  assert.equal(current.needsReview, true);
  assert.equal(current.latestResultId, latestResultId);
  assert.equal(current.latestReviewId, null);
  assert.equal(current.awaitingPublication, false);
  await call(`/investigations/${past.id}/reviews/${firstReviewId}/publish`, doctor, 'POST', {});
  assert.equal((await context(past.id)).needsReview, true);
  const rows = (await call('/investigation-worklist?scope=all')).data as InvestigationWorkItem[];
  assert.ok(
    rows.findIndex((entry) => entry.investigationId === past.id) <
      rows.findIndex((entry) => entry.investigationId === ordered.id),
  );
  assert.equal('investigation' in rows.find((entry) => entry.investigationId === past.id)!, false);
  assert.equal('assignments' in rows.find((entry) => entry.investigationId === past.id)!, false);
});

test('assignments preserve original authors and requested dates, change mine/all scope, and never enter patient views or summary revisions', async () => {
  const created = await order();
  const originalRow = app.locals.db
    .prepare('SELECT data FROM investigations WHERE id=?')
    .get(created.id)!.data;
  const workflows = '/patients/patient-ananya/clinical-workflows',
    summary = '/patients/patient-ananya/care-summary';
  const patientBefore = (await call(workflows, patient)).data;
  const summaryBefore = (await call(summary, patient)).data;
  const initial = await context(created.id);
  assert.equal(initial.ownerDoctorId, created.doctorId);
  assert.deepEqual(initial.assignments, []);
  const assigned = await assign(created.id, {
    reason: 'PRIVATE_ASSIGNMENT_REASON_NEVER_PATIENT_VISIBLE',
  });
  assert.equal(assigned.status, 201);
  assert.equal(assigned.data.ownerDoctorId, 'doctor-arjun');
  assert.equal(assigned.data.orderedByDoctorId, 'doctor-meera');
  assert.equal(assigned.data.dueDate, created.dueDate);
  assert.equal(assigned.data.assignments[0].assignedById, 'user-doctor');
  assert.notEqual(assigned.data.revision, initial.revision);
  assert.equal(
    app.locals.db.prepare('SELECT data FROM investigations WHERE id=?').get(created.id)!.data,
    originalRow,
  );
  assert.deepEqual((await call(workflows, patient)).data, patientBefore);
  const summaryAfter = (await call(summary, patient)).data;
  assert.equal(summaryAfter.revision, summaryBefore.revision);
  assert.equal(JSON.stringify(summaryAfter).includes('PRIVATE_ASSIGNMENT_REASON'), false);
  assert.equal(
    (await call('/investigation-worklist', doctor)).data.some(
      (entry: InvestigationWorkItem) => entry.investigationId === created.id,
    ),
    false,
  );
  assert.equal(
    (await call('/investigation-worklist', arjun)).data.some(
      (entry: InvestigationWorkItem) => entry.investigationId === created.id,
    ),
    true,
  );
  assert.equal(
    (await call('/investigation-worklist', unlinked)).data.some(
      (entry: InvestigationWorkItem) => entry.investigationId === created.id,
    ),
    true,
  );
  assert.deepEqual((await call('/investigation-worklist?scope=mine', unlinked)).data, []);
  assert.equal(
    (await call('/investigation-worklist?scope=all', doctor)).data.some(
      (entry: InvestigationWorkItem) => entry.investigationId === created.id,
    ),
    true,
  );
});

test('original owners may safely replay their own assignment after a handover, but cannot create another assignment without current ownership', async () => {
  const created = await order(),
    another = await order(),
    body = await assignmentBody(created.id);
  const path = `/investigations/${created.id}/assignment`;
  assert.equal((await call(path, doctor, 'POST', body)).status, 201);
  const retry = await call(path, doctor, 'POST', { ...body, expectedRevision: '0'.repeat(64) });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.assignments.length, 1);
  assert.equal((await assign(created.id, { doctorId: 'doctor-meera' }, doctor)).status, 403);
  assert.equal((await call(path, admin, 'POST', body)).status, 409);
  assert.equal(
    (await call(path, doctor, 'POST', { ...body, reason: 'Different handover' })).status,
    409,
  );
  assert.equal(
    (
      await call(`/investigations/${another.id}/assignment`, doctor, 'POST', {
        ...body,
        expectedRevision: (await context(another.id)).revision,
      })
    ).status,
    409,
  );
  assert.equal((await assign(created.id, { doctorId: 'doctor-meera' }, arjun)).status, 201);
  const current = await context(created.id);
  assert.deepEqual((await call(path, doctor, 'POST', body)).data, current);
  await result(created.id);
  assert.equal((await review(created.id, { requestId: body.requestId })).status, 409);
});

test('invalid, unchanged, unavailable and cancelled assignments reject without changing ownership or consuming commands', async () => {
  const created = await order(),
    body = await assignmentBody(created.id);
  for (const invalid of [
    { doctorId: '' },
    { reason: '' },
    { reason: 'x'.repeat(1001) },
    { expectedRevision: 'invalid' },
    { requestId: 'bad' },
    { dueDate: clinicToday() },
  ])
    assert.equal(
      (
        await call(`/investigations/${created.id}/assignment`, doctor, 'POST', {
          ...body,
          ...invalid,
        })
      ).status,
      400,
    );
  assert.equal((await assign(created.id, { doctorId: 'doctor-meera' })).status, 409);
  assert.equal((await assign(created.id, { doctorId: 'missing-doctor' })).status, 400);
  const original = get<User>(app.locals.db, 'users', 'queue-arjun')!;
  app.locals.db
    .prepare('UPDATE users SET data=? WHERE id=?')
    .run(JSON.stringify({ ...original, active: false }), original.id);
  try {
    assert.equal(
      (await call(`/investigations/${created.id}/assignment`, doctor, 'POST', body)).status,
      400,
    );
  } finally {
    app.locals.db
      .prepare('UPDATE users SET data=? WHERE id=?')
      .run(JSON.stringify(original), original.id);
  }
  assert.equal(
    (await call(`/investigations/${created.id}/assignment`, doctor, 'POST', body)).status,
    201,
  );
  assert.equal(
    (
      await call(`/investigations/${created.id}/cancel`, doctor, 'POST', {
        reason: 'Documented cancellation',
      })
    ).status,
    200,
  );
  assert.equal((await assign(created.id, { doctorId: 'doctor-meera' }, admin)).status, 409);
  const cancelled = await context(created.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.needsReview, false);
  assert.equal(cancelled.awaitingPublication, false);
  assert.equal(
    (await call(`/investigations/${created.id}/assignment`, doctor, 'POST', body)).status,
    200,
  );
});

test('reviews accept only paired command metadata while preserving legacy response and review compatibility', async () => {
  const created = await order();
  await result(created.id);
  const body = await reviewBody(created.id),
    path = `/investigations/${created.id}/reviews`;
  for (const invalid of [
    { requestId: undefined },
    { expectedRevision: undefined },
    { requestId: 'bad' },
    { expectedRevision: 'bad' },
  ])
    assert.equal((await call(path, doctor, 'POST', { ...body, ...invalid })).status, 400);
  assert.equal((await call(path, doctor, 'POST', body)).status, 201);
  const legacy = {
    resultId: body.resultId,
    summary: 'Intentional additional legacy review',
    followUp: '',
    publishToPatient: false,
  };
  const oldClient = await call(path, doctor, 'POST', legacy);
  assert.equal(oldClient.status, 201);
  assert.equal(oldClient.data.reviews.length, 2);
  for (const key of ['revision', 'assignments', 'ownerDoctorId'])
    assert.equal(key in oldClient.data, false);
  const own = (
    await call('/patients/patient-ananya/clinical-workflows', patient)
  ).data.investigations.find((entry: Investigation) => entry.id === created.id);
  assert.equal(own.status, 'reviewed');
  assert.deepEqual(own.reviews, []);
});

test('review revisions detect ownership, publication, supplemental results and competing legacy reviews', async () => {
  const created = await order();
  await result(created.id);
  const beforeAssignment = await reviewBody(created.id);
  await assign(created.id);
  assert.equal(
    (await call(`/investigations/${created.id}/reviews`, doctor, 'POST', beforeAssignment)).status,
    409,
  );
  const saved = await review(created.id);
  assert.equal(saved.status, 201);
  const beforePublication = await reviewBody(created.id, { summary: 'Additional interpretation' });
  const reviewId = saved.data.reviews.at(-1).id;
  await call(`/investigations/${created.id}/reviews/${reviewId}/publish`, doctor, 'POST', {});
  assert.equal(
    (await call(`/investigations/${created.id}/reviews`, doctor, 'POST', beforePublication)).status,
    409,
  );
  const beforeResult = await reviewBody(created.id);
  await result(created.id);
  assert.equal(
    (await call(`/investigations/${created.id}/reviews`, doctor, 'POST', beforeResult)).status,
    409,
  );
  assert.equal((await review(created.id, { resultId: beforeResult.resultId })).status, 409);
  const beforeLegacy = await reviewBody(created.id);
  await call(`/investigations/${created.id}/reviews`, arjun, 'POST', {
    resultId: beforeLegacy.resultId,
    summary: 'Legacy clinician interpretation',
  });
  assert.equal(
    (await call(`/investigations/${created.id}/reviews`, doctor, 'POST', beforeLegacy)).status,
    409,
  );
});

test('same-result concurrent review writes conflict and exact concurrent command retries append one review only', async () => {
  const created = await order();
  await result(created.id);
  const first = await reviewBody(created.id),
    path = `/investigations/${created.id}/reviews`;
  const competing = await Promise.all([
    call(path, doctor, 'POST', first),
    call(path, arjun, 'POST', {
      ...first,
      requestId: randomUUID(),
      summary: 'Competing interpretation',
    }),
  ]);
  assert.deepEqual(competing.map((response) => response.status).sort(), [201, 409]);
  assert.equal((await context(created.id)).investigation.reviews.length, 1);
  const intentional = await reviewBody(created.id, {
    summary: 'Intentional new interpretation after refreshing context',
  });
  const retried = await Promise.all([1, 2].map(() => call(path, doctor, 'POST', intentional)));
  assert.deepEqual(retried.map((response) => response.status).sort(), [200, 201]);
  assert.equal((await context(created.id)).investigation.reviews.length, 2);
});

test('review retry remains actor, action and order bound and returns original review in current state after newer reports', async () => {
  const created = await order(),
    another = await order();
  await result(created.id);
  await result(another.id);
  const body = await reviewBody(created.id, { publishToPatient: true }),
    path = `/investigations/${created.id}/reviews`;
  const saved = await call(path, doctor, 'POST', body);
  assert.equal(saved.status, 201);
  const originalReview = saved.data.reviews[0];
  await result(created.id);
  await assign(created.id);
  const retry = await call(path, doctor, 'POST', { ...body, expectedRevision: '0'.repeat(64) });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.status, 'result-received');
  assert.deepEqual(retry.data.reviews[0], originalReview);
  assert.equal(retry.data.reviews.length, 1);
  assert.equal(activityFor(`investigation-review:${originalReview.id}`).length, 1);
  assert.equal((await call(path, arjun, 'POST', body)).status, 409);
  assert.equal(
    (await call(path, doctor, 'POST', { ...body, summary: 'Changed interpretation' })).status,
    409,
  );
  assert.equal((await review(another.id, { requestId: body.requestId })).status, 409);
  assert.equal(
    (await assign(created.id, { doctorId: 'doctor-meera', requestId: body.requestId }, admin))
      .status,
    409,
  );
});

test('competing handover and review use one clinical state revision and cannot silently supersede each other', async () => {
  const created = await order();
  await result(created.id);
  const handover = await assignmentBody(created.id),
    interpretation = await reviewBody(created.id);
  assert.equal(handover.expectedRevision, interpretation.expectedRevision);
  const attempts = await Promise.all([
    call(`/investigations/${created.id}/assignment`, doctor, 'POST', handover),
    call(`/investigations/${created.id}/reviews`, doctor, 'POST', interpretation),
  ]);
  assert.deepEqual(attempts.map((response) => response.status).sort(), [201, 409]);
});

test('new results notify current responsibility, preserve exact source links and fall back only when the owner has no active linked account', async () => {
  const created = await order();
  const handover = await assign(created.id, { reason: 'PRIVATE_HANDOVER_NOT_ACTIVITY_BODY' });
  const assignment = handover.data.assignments[0];
  const assignedActivity = activityFor(`investigation-assignment:${assignment.id}`);
  assert.deepEqual(
    assignedActivity.map((row) => row.userId),
    ['queue-arjun'],
  );
  assert.equal(assignedActivity[0].data.includes('PRIVATE_HANDOVER_NOT_ACTIVITY_BODY'), false);
  const received = await result(created.id),
    resultId = received.results.at(-1)!.id;
  const notification = activityFor(`investigation-result:${resultId}`);
  assert.deepEqual(
    notification.map((row) => row.userId),
    ['queue-arjun'],
  );
  assert.equal(
    JSON.parse(notification[0].data).href,
    `/clinic/patients/patient-ananya?tab=workup&investigation=${created.id}&result=${resultId}`,
  );
  const selfAuthored = await result(created.id, arjun);
  assert.equal(activityFor(`investigation-result:${selfAuthored.results.at(-1)!.id}`).length, 0);
  const original = get<User>(app.locals.db, 'users', 'queue-arjun')!;
  app.locals.db
    .prepare('UPDATE users SET data=? WHERE id=?')
    .run(JSON.stringify({ ...original, active: false }), original.id);
  try {
    assert.equal((await context(created.id)).ownerAvailable, false);
    const fallback = await result(created.id);
    assert.deepEqual(
      activityFor(`investigation-result:${fallback.results.at(-1)!.id}`).map((row) => row.userId),
      ['user-admin', 'user-doctor'],
    );
    assert.equal((await context(created.id)).ownerDoctorId, 'doctor-arjun');
  } finally {
    app.locals.db
      .prepare('UPDATE users SET data=? WHERE id=?')
      .run(JSON.stringify(original), original.id);
  }
});

test('cancelled orders reject new publication while retaining idempotent publication and review-command retries', async () => {
  const created = await order();
  await result(created.id);
  const privateBody = await reviewBody(created.id),
    privateReview = await call(
      `/investigations/${created.id}/reviews`,
      doctor,
      'POST',
      privateBody,
    );
  const sharedReview = await review(created.id, {
    publishToPatient: true,
    summary: 'Previously shared interpretation',
  });
  const privateId = privateReview.data.reviews[0].id,
    published = sharedReview.data.reviews.at(-1);
  await result(created.id);
  assert.equal(
    (
      await call(`/investigations/${created.id}/cancel`, doctor, 'POST', {
        reason: 'Documented cancellation after supplemental result',
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(`/investigations/${created.id}/reviews/${privateId}/publish`, doctor, 'POST', {}))
      .status,
    409,
  );
  const retry = await call(
    `/investigations/${created.id}/reviews/${published.id}/publish`,
    doctor,
    'POST',
    {},
  );
  assert.equal(retry.status, 200);
  assert.equal(retry.data.reviews.at(-1).publishedAt, published.publishedAt);
  assert.equal(
    (await call(`/investigations/${created.id}/reviews`, doctor, 'POST', privateBody)).status,
    200,
  );
  assert.equal((await review(created.id)).status, 409);
});

test('assignment and review source events, command receipts, audit and activity roll back together', async () => {
  for (const failure of ['audit', 'activity']) {
    for (const operation of ['assignment', 'review']) {
      const created = await order();
      await result(created.id);
      const body =
        operation === 'assignment'
          ? await assignmentBody(created.id)
          : await reviewBody(created.id, { publishToPatient: true });
      const path = `/investigations/${created.id}/${operation === 'assignment' ? 'assignment' : 'reviews'}`;
      const before = await context(created.id);
      const action =
        operation === 'assignment'
          ? 'assigned investigation responsibility'
          : 'reviewed investigation result';
      const prefix =
        operation === 'assignment' ? 'investigation-assignment:' : 'investigation-review:';
      const predicate =
        failure === 'audit'
          ? `json_extract(NEW.data,'$.action')='${action}'`
          : `NEW.eventKey LIKE '${prefix}%'`;
      app.locals.db.exec(
        `CREATE TRIGGER fail_investigation_command BEFORE INSERT ON ${failure} WHEN ${predicate} BEGIN SELECT RAISE(ABORT,'synthetic investigation transaction failure'); END;`,
      );
      try {
        assert.equal((await call(path, doctor, 'POST', body)).status, 500);
      } finally {
        app.locals.db.exec('DROP TRIGGER fail_investigation_command');
      }
      assert.deepEqual(await context(created.id), before);
      assert.equal(
        app.locals.db
          .prepare('SELECT COUNT(*) AS n FROM investigationCommands WHERE requestId=?')
          .get(body.requestId)!.n,
        0,
      );
      assert.equal((await call(path, doctor, 'POST', body)).status, 201);
    }
  }
});

test('private assignment history and command receipts are immutable and clinical reads require audit success', async () => {
  const created = await order();
  await assign(created.id);
  for (const table of ['investigationAssignments', 'investigationCommands']) {
    const row = app.locals.db.prepare(`SELECT rowid FROM ${table} LIMIT 1`).get()!;
    const column = table === 'investigationCommands' ? 'payload' : 'data';
    assert.throws(
      () =>
        app.locals.db
          .prepare(`UPDATE ${table} SET ${column}=${column} WHERE rowid=?`)
          .run(row.rowid),
      /immutable/,
    );
    assert.throws(
      () => app.locals.db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row.rowid),
      /immutable/,
    );
  }
  app.locals.db.exec(
    "CREATE TRIGGER fail_investigation_read BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') IN ('viewed investigation worklist','viewed investigation review context') BEGIN SELECT RAISE(ABORT,'synthetic read audit failure'); END;",
  );
  try {
    assert.equal((await call('/investigation-worklist')).status, 500);
    assert.equal((await call(`/investigations/${created.id}/review-context`)).status, 500);
  } finally {
    app.locals.db.exec('DROP TRIGGER fail_investigation_read');
  }
});

test('additive migration keeps legacy orders and persists handovers and review retries across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-investigation-queue-')),
    databasePath = join(directory, 'clinic.sqlite');
  let application: ReturnType<typeof createApp> | undefined, instance: Server | undefined;
  try {
    const legacy = openDatabase(databasePath);
    seedDemo(legacy);
    legacy.exec(
      'CREATE TABLE investigations(id TEXT PRIMARY KEY,patientId TEXT NOT NULL REFERENCES patients(id),data TEXT NOT NULL);',
    );
    const original = {
      id: randomUUID(),
      patientId: 'patient-ananya',
      doctorId: 'doctor-meera',
      doctorName: 'Original ordering clinician',
      title: 'Legacy investigation',
      kind: 'other',
      reason: 'Known clinical question',
      instructions: 'Known instructions',
      dueDate: null,
      status: 'ordered',
      cancellationReason: null,
      createdAt: '2025-01-01T12:00:00Z',
    };
    legacy
      .prepare('INSERT INTO investigations(id,patientId,data) VALUES (?,?,?)')
      .run(original.id, original.patientId, JSON.stringify(original));
    createUser(
      legacy,
      {
        id: 'legacy-queue-arjun',
        name: 'New responsible clinician',
        email: 'legacy-arjun@example.test',
        role: 'doctor',
        doctorId: 'doctor-arjun',
      },
      'LegacyQueueClinician2026!',
    );
    legacy.close();
    application = createApp({ databasePath, demoMode: true });
    let listening = await listen(application);
    instance = listening.server;
    const client: Client = {};
    await call(
      '/auth/login',
      client,
      'POST',
      { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
      listening.base,
    );
    const path = `/investigations/${original.id}`,
      initial = await call(`${path}/review-context`, client, 'GET', undefined, listening.base);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.data.assignments, []);
    assert.equal(initial.data.ownerDoctorId, 'doctor-meera');
    const handover = {
      doctorId: 'doctor-arjun',
      reason: 'Recorded handover',
      expectedRevision: initial.data.revision,
      requestId: randomUUID(),
    };
    assert.equal(
      (await call(`${path}/assignment`, client, 'POST', handover, listening.base)).status,
      201,
    );
    await call(
      `${path}/results`,
      client,
      'POST',
      { note: 'Known submitted result', documentIds: [] },
      listening.base,
    );
    const ready = (await call(`${path}/review-context`, client, 'GET', undefined, listening.base))
      .data;
    const interpretation = {
      resultId: ready.latestResultId,
      summary: 'Preserved clinician interpretation',
      followUp: '',
      publishToPatient: false,
      expectedRevision: ready.revision,
      requestId: randomUUID(),
    };
    assert.equal(
      (await call(`${path}/reviews`, client, 'POST', interpretation, listening.base)).status,
      201,
    );
    const before = (await call(`${path}/review-context`, client, 'GET', undefined, listening.base))
      .data;
    await close(instance);
    instance = undefined;
    application.locals.close();
    application = undefined;
    application = createApp({ databasePath, demoMode: true });
    listening = await listen(application);
    instance = listening.server;
    const restored = await call(`${path}/review-context`, client, 'GET', undefined, listening.base);
    assert.deepEqual(restored.data, before);
    assert.equal(
      (await call(`${path}/assignment`, client, 'POST', handover, listening.base)).status,
      200,
    );
    assert.equal(
      (await call(`${path}/reviews`, client, 'POST', interpretation, listening.base)).status,
      200,
    );
    assert.deepEqual(get(application.locals.db, 'investigations', original.id), original);
  } finally {
    if (instance) await close(instance);
    application?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
