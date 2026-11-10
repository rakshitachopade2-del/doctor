import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser } from '../server/db.ts';
import { syntheticPdf } from './fixtures/report.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  patient: Client = {},
  reception: Client = {},
  admin: Client = {},
  other: Client = {};
let server: Server, base: string;
let plan: any, investigation: any, privateReview: any, image: any, document: any, invoice: any;
const path = '/patients/patient-ananya/care-summary';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCeoAAAAASUVORK5CYII=';
const secrets = [
  'PRIVATE_VISIT_ASSESSMENT',
  'PRIVATE_AMENDMENT',
  'PRIVATE_FOLLOWUP_ASSESSMENT',
  'PRIVATE_UNPUBLISHED_INTERPRETATION',
  'PRIVATE_ASSIGNMENT_REASON',
  'PRIVATE_MESSAGE_THREAD',
];
async function call(url: string, client: Client = {}, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${url}`, {
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
async function post(url: string, body: unknown, client = doctor, expected = 201) {
  const result = await call(url, client, 'POST', body);
  assert.equal(result.status, expected, JSON.stringify(result.data));
  return result.data;
}
async function summary(client = patient) {
  const result = await call(path, client);
  assert.equal(result.status, 200);
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
    ['reception', reception],
    ['admin', admin],
  ] as const)
    await post(
      '/auth/login',
      { email: `${role}@derma.demo`, password: 'DemoClinic2026!' },
      client,
      200,
    );
  await post(
    '/auth/register',
    {
      name: 'Other summary patient',
      email: 'summary-other@example.test',
      password: 'SummaryOther2026!',
      phone: '9000000098',
      dob: '1990-01-01',
      gender: 'Other',
    },
    other,
  );
  createUser(
    app.locals.db,
    {
      id: 'summary-next-owner',
      name: 'Synthetic owner',
      email: 'summary-owner@example.test',
      role: 'doctor',
      doctorId: 'doctor-arjun',
      active: true,
      mustChangePassword: true,
    },
    'SummaryOwner2026!',
  );
  const encounter = await post('/encounters', {
    patientId: 'patient-ananya',
    assessment: secrets[0],
    plan: 'Internal visit plan',
  });
  await post(`/encounters/${encounter.id}/amendments`, {
    reason: 'Synthetic correction',
    text: secrets[1],
  });
  plan = await post('/care-plans', {
    patientId: 'patient-ananya',
    title: 'Shared summary care plan',
    instructions: 'Patient-facing original instructions',
    expectations: 'Synthetic expectations',
    warnings: 'Synthetic warning',
    cost: 'Discussed estimate',
    startDate: clinicToday(),
    endDate: addDays(clinicToday(), 7),
    followUpDate: clinicToday(),
    medications: [
      {
        name: 'Synthetic regimen',
        instructions: 'Recorded instructions',
        schedule: 'Recorded schedule',
        duration: 'Recorded duration',
        warnings: '',
      },
    ],
  });
  await post(
    '/check-ins',
    {
      carePlanId: plan.id,
      date: clinicToday(),
      adherence: 'partial',
      feeling: 'same',
      note: 'Shared patient report',
    },
    patient,
  );
  const current = (await call('/care-plans', doctor)).data.find(
    (value: any) => value.id === plan.id,
  );
  await post(`/care-plans/${plan.id}/reviews`, {
    expectedRevision: current.followUpRevision,
    assessment: secrets[2],
    patientInstructions: 'Shared follow-up instructions',
    disposition: 'continue',
    nextReviewDate: addDays(clinicToday(), 10),
  });
  document = await post(
    '/documents',
    {
      title: 'Synthetic portable report',
      originalName: 'summary-report.pdf',
      dataUrl: `data:application/pdf;base64,${syntheticPdf('Synthetic summary report').toString('base64')}`,
      consent: true,
    },
    patient,
  );
  image = await post(
    '/images',
    {
      caption: 'Synthetic summary image',
      category: 'clinical',
      consent: true,
      dataUrl: `data:image/png;base64,${png}`,
    },
    patient,
  );
  investigation = await post('/investigations', {
    patientId: 'patient-ananya',
    title: 'Shared investigation',
    kind: 'laboratory',
    reason: 'Synthetic request',
    instructions: 'Shared result instructions',
  });
  const withResult = await post(
    `/investigations/${investigation.id}/results`,
    { note: 'Shared submitted result', documentIds: [document.id] },
    patient,
  );
  const privateResult = await post(`/investigations/${investigation.id}/reviews`, {
    resultId: withResult.results[0].id,
    summary: secrets[3],
    publishToPatient: false,
  });
  privateReview = privateResult.reviews[0];
  await post('/procedures', {
    patientId: 'patient-ananya',
    title: 'Shared procedure information',
    indication: 'Synthetic indication',
    benefits: 'Recorded benefits',
    risks: 'Recorded risks',
    alternatives: 'Recorded alternatives',
    aftercare: 'Recorded aftercare',
  });
  invoice = await post(
    '/invoices',
    {
      patientId: 'patient-ananya',
      requestId: randomUUID(),
      items: [{ description: 'Synthetic service', quantity: 1, unitAmountPaise: 2505 }],
    },
    reception,
  );
  await post('/messages', { patientId: 'patient-ananya', body: secrets[5] });
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  app.locals.close();
});

test('care summaries deny anonymous, reception and other patients for both view and download', async () => {
  const revision = (await summary()).revision;
  for (const suffix of ['', `/download?revision=${revision}`]) {
    assert.equal((await call(path + suffix)).status, 401);
    assert.equal((await call(path + suffix, reception)).status, 403);
    assert.equal((await call(path + suffix, other)).status, 403);
  }
  assert.equal((await call('/patients/missing/care-summary', admin)).status, 404);
});

test('all eligible roles receive the same patient-facing projection with no internal records or file bytes', async () => {
  const own = await summary();
  for (const client of [doctor, admin]) {
    const clinical = await summary(client);
    const { generatedAt: _a, ...first } = own;
    const { generatedAt: _b, ...second } = clinical;
    assert.deepEqual(second, first);
  }
  const serialized = JSON.stringify(own);
  for (const secret of secrets) assert.ok(!serialized.includes(secret), secret);
  for (const key of [
    'encounters',
    'amendments',
    'messages',
    'assessment',
    'checkInSnapshots',
    'followUpRevision',
    'assignedById',
    'bytes',
    'dataUrl',
  ])
    assert.ok(!serialized.includes(`"${key}"`), key);
  assert.ok(!serialized.includes(png));
  assert.equal(own.audience, 'patient');
  assert.equal(own.schemaVersion, 1);
  assert.equal(own.timezone, 'Asia/Kolkata');
  assert.ok(
    own.investigations.find((row: any) => row.id === investigation.id).reviews.length === 0,
  );
  assert.ok(own.procedures.some((row: any) => row.title === 'Shared procedure information'));
  assert.ok(own.invoices.some((row: any) => row.id === invoice.id && row.totalPaise === 2505));
});

test('summary preserves original regimen, later review instructions, patient reports and attachment provenance', async () => {
  const value = await summary();
  const selected = value.carePlans.find((row: any) => row.id === plan.id);
  assert.equal(selected.instructions, plan.instructions);
  assert.deepEqual(selected.medications, plan.medications);
  assert.equal(selected.endDate, plan.endDate);
  assert.equal(selected.followUpDate, plan.followUpDate);
  assert.equal(selected.effectiveFollowUpDate, addDays(clinicToday(), 10));
  assert.equal(selected.reviews[0].patientInstructions, 'Shared follow-up instructions');
  assert.ok(
    value.checkIns.some(
      (row: any) => row.carePlanId === plan.id && row.note === 'Shared patient report',
    ),
  );
  const exportedImage = value.images.find((row: any) => row.id === image.id);
  assert.equal(
    exportedImage.sha256,
    createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'),
  );
  assert.equal(exportedImage.createdById, 'user-patient');
  assert.equal(value.documents.find((row: any) => row.id === document.id).sha256, document.sha256);
});

test('JSON download requires the displayed revision and sets private attachment headers', async () => {
  const view = await summary();
  const result = await call(`${path}/download?revision=${view.revision}`, patient);
  assert.equal(result.status, 200);
  assert.equal(result.data.revision, view.revision);
  assert.match(result.headers.get('content-type')!, /application\/json/);
  assert.match(
    result.headers.get('content-disposition')!,
    /^attachment; filename="care-summary-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  assert.match(result.headers.get('cache-control')!, /no-store/);
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  for (const suffix of ['/download', '/download?revision=invalid'])
    assert.equal((await call(path + suffix, patient)).status, 400);
});

test('private handovers and private annotation drafts do not change the patient-visible revision', async () => {
  const before = await summary();
  const current = (await call('/care-plans', doctor)).data.find((row: any) => row.id === plan.id);
  await post(
    `/care-plans/${plan.id}/assignment`,
    { doctorId: 'doctor-arjun', reason: secrets[4], expectedRevision: current.followUpRevision },
    admin,
  );
  const annotations = (await call(`/images/${image.id}/annotations`, doctor)).data;
  await post(`/images/${image.id}/annotations`, {
    expectedRevision: annotations.revision,
    note: 'PRIVATE_IMAGE_DRAFT',
    markers: [],
  });
  const after = await summary();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.imageAnnotations, []);
  assert.ok(!JSON.stringify(after).includes('PRIVATE_IMAGE_DRAFT'));
  assert.ok(!JSON.stringify(after).includes(secrets[4]));
  assert.equal((await call(`${path}/download?revision=${before.revision}`, patient)).status, 200);
});

test('publishing an annotation changes the snapshot while a later private draft preserves published history', async () => {
  const before = await summary();
  const current = (await call(`/images/${image.id}/annotations`, doctor)).data;
  const draft = await post(`/images/${image.id}/annotations`, {
    expectedRevision: current.revision,
    note: 'Published image note',
    markers: [
      {
        id: randomUUID(),
        type: 'rectangle',
        color: 'blue',
        label: 'Shared marker',
        x: 0.2,
        y: 0.2,
        width: 0.3,
        height: 0.3,
      },
    ],
  });
  await post(
    `/images/${image.id}/annotations/${draft.versions[0].id}/publish`,
    { expectedRevision: draft.revision, patientSharingConfirmed: true },
    doctor,
    200,
  );
  const shared = await summary();
  assert.notEqual(shared.revision, before.revision);
  assert.equal(shared.imageAnnotations.length, 1);
  assert.equal(shared.imageAnnotations[0].note, 'Published image note');
  assert.ok(shared.imageAnnotations[0].publishedAt);
  const next = (await call(`/images/${image.id}/annotations`, doctor)).data;
  await post(`/images/${image.id}/annotations`, {
    expectedRevision: next.revision,
    note: 'PRIVATE_NEWER_IMAGE_DRAFT',
    markers: [],
  });
  const later = await summary();
  assert.equal(later.revision, shared.revision);
  assert.deepEqual(later.imageAnnotations, shared.imageAnnotations);
  assert.ok(!JSON.stringify(later).includes('PRIVATE_NEWER_IMAGE_DRAFT'));
});

test('newly shared interpretations and payments reject stale downloads until the summary is refreshed', async () => {
  const before = await summary();
  await post(
    `/investigations/${investigation.id}/reviews/${privateReview.id}/publish`,
    {},
    doctor,
    200,
  );
  assert.equal((await call(`${path}/download?revision=${before.revision}`, patient)).status, 409);
  const updated = await summary();
  assert.ok(
    updated.investigations
      .find((row: any) => row.id === investigation.id)
      .reviews.some((row: any) => row.summary === secrets[3]),
  );
  await post(
    `/invoices/${invoice.id}/payments`,
    { amountPaise: 1001, method: 'cash', requestId: randomUUID() },
    reception,
  );
  assert.equal((await call(`${path}/download?revision=${updated.revision}`, patient)).status, 409);
  const latest = await summary();
  assert.equal(latest.invoices.find((row: any) => row.id === invoice.id).paidPaise, 1001);
  assert.equal((await call(`${path}/download?revision=${latest.revision}`, patient)).status, 200);
});

test('pausing optional modules preserves existing care summary and download access', async () => {
  const before = await summary();
  const settings = (await call('/settings', admin)).data;
  assert.equal(
    (
      await call('/settings', admin, 'PATCH', {
        modules: { intake: false, images: false, followUp: false },
      })
    ).status,
    200,
  );
  try {
    const paused = await summary();
    assert.equal(paused.revision, before.revision);
    assert.equal((await call(`${path}/download?revision=${paused.revision}`, patient)).status, 200);
  } finally {
    await call('/settings', admin, 'PATCH', { modules: settings.modules });
  }
});

test('failed audit prevents a summary response or download attachment', async () => {
  const view = await summary();
  app.locals.db.exec(
    "CREATE TRIGGER summary_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') LIKE '%patient-facing care summary' BEGIN SELECT RAISE(ABORT,'Synthetic summary audit failure'); END;",
  );
  try {
    for (const url of [path, `${path}/download?revision=${view.revision}`]) {
      const result = await call(url, patient);
      assert.equal(result.status, 500);
      assert.equal(result.headers.get('content-disposition'), null);
      assert.ok(!JSON.stringify(result.data).includes('Shared summary care plan'));
    }
  } finally {
    app.locals.db.exec('DROP TRIGGER summary_audit_failure');
  }
});

test('care-summary filenames use the clinic calendar day across the UTC midnight boundary', async (context) => {
  const localDay = clinicToday();
  context.mock.timers.enable({ apis: ['Date'], now: new Date(`${localDay}T00:10:00+05:30`) });
  const view = await summary();
  assert.notEqual(view.generatedAt.slice(0, 10), localDay);
  const result = await call(`${path}/download?revision=${view.revision}`, patient);
  assert.equal(result.status, 200);
  assert.ok(result.headers.get('content-disposition')!.endsWith(`-${localDay}.json"`));
});
