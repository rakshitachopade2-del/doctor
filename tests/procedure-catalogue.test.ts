import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createUser, get, openDatabase, type DB } from '../server/db.ts';
import type { User } from '../shared/types.ts';
import type {
  ProcedureTemplateDetail,
  ProcedureTemplateFields,
} from '../shared/procedure-catalogue.ts';

type Client = { cookie?: string; csrf?: string; id?: string };
const fields: ProcedureTemplateFields = {
  title: 'Synthetic procedure explanation',
  benefits: 'Synthetic benefits for fixture only',
  risks: 'Synthetic risks for fixture only',
  alternatives: 'Synthetic alternatives for fixture only',
  aftercare: 'Synthetic aftercare for fixture only',
  estimatedCost: 'Discuss individually',
};
const privateReason = 'INTERNAL CATALOGUE REASON must not appear in patient records';
async function fixture(t: TestContext, path = ':memory:') {
  const app = createApp({ databasePath: path, demoMode: true }),
    db = app.locals.db as DB;
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    app.locals.close();
  };
  t.after(close);
  async function call(path: string, who: Client = {}, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who.cookie ? { Cookie: who.cookie } : {}),
        ...(who.csrf ? { 'X-CSRF-Token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookie = response.headers.getSetCookie().find((v) => v.startsWith('derma_session='));
    if (cookie) who.cookie = cookie.split(';')[0];
    const data = await response.json();
    if (data.csrfToken) who.csrf = data.csrfToken;
    if (data.user?.id) who.id = data.user.id;
    return { status: response.status, data, headers: response.headers };
  }
  const doctor: Client = {},
    admin: Client = {},
    patient: Client = {},
    reception: Client = {},
    unlinked: Client = {};
  for (const [name, who] of [
    ['doctor', doctor],
    ['admin', admin],
    ['patient', patient],
    ['reception', reception],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', who, 'POST', {
          email: `${name}@derma.demo`,
          password: 'DemoClinic2026!',
        })
      ).status,
      200,
    );
  if (!db.prepare('SELECT id FROM users WHERE id=?').get('catalogue-unlinked'))
    createUser(
      db,
      {
        id: 'catalogue-unlinked',
        name: 'Unlinked admin',
        email: 'catalogue-unlinked@example.test',
        role: 'admin',
      },
      'SyntheticAdmin2026!',
    );
  assert.equal(
    (
      await call('/auth/login', unlinked, 'POST', {
        email: 'catalogue-unlinked@example.test',
        password: 'SyntheticAdmin2026!',
      })
    ).status,
    200,
  );
  async function create(overrides: Partial<ProcedureTemplateFields> = {}) {
    const r = await call('/procedure-catalogue', doctor, 'POST', {
      fields: { ...fields, ...overrides },
      reason: privateReason,
      requestId: randomUUID(),
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data as { detail: ProcedureTemplateDetail; event: { id: string; requestId: string } };
  }
  async function detail(id: string) {
    const r = await call(`/procedure-catalogue/${id}`, doctor);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data as ProcedureTemplateDetail;
  }
  async function publish(d: ProcedureTemplateDetail, who = doctor) {
    const r = await call(`/procedure-catalogue/${d.template.id}/publish`, who, 'POST', {
      versionId: d.latestVersion.id,
      reviewed: true,
      reason: privateReason,
      expectedRevision: d.template.revision,
      requestId: randomUUID(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.detail as ProcedureTemplateDetail;
  }
  async function draft(d: ProcedureTemplateDetail, title = 'Revised synthetic explanation') {
    const r = await call(`/procedure-catalogue/${d.template.id}/versions`, doctor, 'POST', {
      fields: { ...fields, title },
      reason: privateReason,
      expectedRevision: d.template.revision,
      requestId: randomUUID(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.detail as ProcedureTemplateDetail;
  }
  async function availability(d: ProcedureTemplateDetail, active: boolean) {
    const r = await call(`/procedure-catalogue/${d.template.id}/availability`, unlinked, 'POST', {
      active,
      reason: privateReason,
      expectedRevision: d.template.revision,
      requestId: randomUUID(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.detail as ProcedureTemplateDetail;
  }
  function plan(d?: ProcedureTemplateDetail) {
    return {
      patientId: 'patient-ananya',
      appointmentId: null,
      ...(d?.publishedVersion?.fields ?? fields),
      indication: 'Individually entered synthetic patient indication',
      requestId: randomUUID(),
      ...(d
        ? {
            templateSelection: {
              templateId: d.template.id,
              versionId: d.publishedVersion?.id ?? d.latestVersion.id,
              expectedSelectionRevision: d.template.selectionRevision,
            },
            reviewedForPatient: true,
          }
        : {}),
    };
  }
  return {
    app,
    db,
    call,
    doctor,
    admin,
    patient,
    reception,
    unlinked,
    create,
    detail,
    publish,
    draft,
    availability,
    plan,
    close,
  };
}
function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-catalogue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'clinic.sqlite');
}

test('catalogue is private to clinicians; clinical authorship and admin availability have separate guards', async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    d = created.detail;
  assert.equal((await f.call('/procedure-catalogue')).status, 401);
  for (const who of [f.patient, f.reception])
    for (const path of [
      '/procedure-catalogue',
      `/procedure-catalogue/${d.template.id}`,
      `/procedure-catalogue/${d.template.id}/versions`,
      `/procedure-catalogue/${d.template.id}/history`,
    ])
      assert.equal((await f.call(path, who)).status, 403);
  assert.equal((await f.call(`/procedure-catalogue/${d.template.id}`, f.unlinked)).status, 200);
  assert.equal(
    (
      await f.call('/procedure-catalogue', f.unlinked, 'POST', {
        fields,
        reason: 'Attempted content',
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(`/procedure-catalogue/${d.template.id}/publish`, f.unlinked, 'POST', {
        versionId: d.latestVersion.id,
        reviewed: true,
        reason: 'Attempted review',
        expectedRevision: d.template.revision,
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(`/procedure-catalogue/${d.template.id}/availability`, f.doctor, 'POST', {
        active: false,
        reason: 'Attempted archive',
        expectedRevision: d.template.revision,
        requestId: randomUUID(),
      })
    ).status,
    403,
  );
  assert.equal((await f.availability(d, false)).template.active, false);
  assert.equal(
    (
      await f.call('/procedure-catalogue', { cookie: f.doctor.cookie }, 'POST', {
        fields,
        reason: 'No CSRF',
        requestId: randomUUID(),
      })
    ).status,
    403,
  );
});

test('strict content/command validation forbids templated indication, hidden provenance, unknown queries and unreviewed publication', async (t) => {
  const f = await fixture(t),
    d = (await f.create()).detail;
  for (const badFields of [
    { ...fields, indication: 'Must remain patient-specific' },
    { ...fields, title: '' },
    { ...fields, risks: 'x'.repeat(8001) },
    { ...fields, estimatedCost: 'x'.repeat(301) },
  ])
    assert.equal(
      (
        await f.call('/procedure-catalogue', f.doctor, 'POST', {
          fields: badFields,
          reason: 'Invalid fixture',
          requestId: randomUUID(),
        })
      ).status,
      400,
    );
  for (const query of [
    '?page=0',
    '?pageSize=100',
    '?active=maybe',
    '?publication=draft',
    '?page=1&page=2',
    '?extra=true',
  ])
    assert.equal((await f.call(`/procedure-catalogue${query}`, f.doctor)).status, 400);
  assert.equal(
    (
      await f.call(`/procedure-catalogue/${d.template.id}/publish`, f.doctor, 'POST', {
        versionId: d.latestVersion.id,
        reviewed: false,
        reason: 'Not reviewed',
        expectedRevision: d.template.revision,
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.call('/procedures', f.doctor, 'POST', { ...f.plan(), templateSource: { version: 1 } }))
      .status,
    400,
  );
  assert.equal((await f.call('/procedures?extra=1', f.doctor, 'POST', f.plan())).status, 400);
  assert.equal(
    (await f.call('/procedures', f.doctor, 'POST', { ...f.plan(d), requestId: undefined })).status,
    400,
  );
  assert.equal(
    (await f.call('/procedures', f.doctor, 'POST', { ...f.plan(d), reviewedForPatient: undefined }))
      .status,
    400,
  );
  assert.equal(
    (await f.call('/procedures', f.doctor, 'POST', { ...f.plan(), reviewedForPatient: true }))
      .status,
    400,
  );
});

test('drafts retain the last explicit publication; publishing latest only and archive/restore invalidate selection', async (t) => {
  const f = await fixture(t),
    original = (await f.create()).detail;
  assert.equal(original.publishedVersion, null);
  assert.equal(original.publication, null);
  assert.equal((await f.call('/procedures', f.doctor, 'POST', f.plan(original))).status, 409);
  const published = await f.publish(original, f.admin),
    draft = await f.draft(published);
  assert.equal(draft.template.selectionRevision, published.template.selectionRevision);
  assert.notEqual(draft.template.revision, published.template.revision);
  assert.equal(draft.publishedVersion!.id, published.publishedVersion!.id);
  assert.equal(draft.publication!.createdById, f.admin.id);
  assert.equal(
    (
      await f.call(`/procedure-catalogue/${draft.template.id}/publish`, f.doctor, 'POST', {
        versionId: original.latestVersion.id,
        reviewed: true,
        reason: 'Old version',
        expectedRevision: draft.template.revision,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal((await f.call('/procedures', f.doctor, 'POST', f.plan(published))).status, 201);
  const next = await f.publish(draft);
  assert.notEqual(next.template.selectionRevision, published.template.selectionRevision);
  assert.equal((await f.call('/procedures', f.doctor, 'POST', f.plan(published))).status, 409);
  const archived = await f.availability(next, false);
  assert.equal((await f.call('/procedures', f.doctor, 'POST', f.plan(next))).status, 409);
  const restored = await f.availability(archived, true);
  assert.notEqual(restored.template.selectionRevision, next.template.selectionRevision);
  assert.equal(restored.publishedVersion!.id, next.publishedVersion!.id);
  assert.equal((await f.call('/procedures', f.doctor, 'POST', f.plan(next))).status, 409);
  assert.equal((await f.call('/procedures', f.doctor, 'POST', f.plan(restored))).status, 201);
});

test('new patient plans preserve tailored fields and safe reviewer provenance without catalogue reasons or request tokens', async (t) => {
  const f = await fixture(t),
    published = await f.publish((await f.create()).detail, f.admin);
  const body = {
    ...f.plan(published),
    title: 'Tailored patient title',
    aftercare: 'Tailored patient explanation',
  };
  const result = await f.call('/procedures', f.doctor, 'POST', body);
  assert.equal(result.status, 201);
  assert.equal(result.data.procedure.indication, body.indication);
  assert.equal(result.data.procedure.aftercare, body.aftercare);
  assert.equal(
    result.data.procedure.templateSource.reviewedByDoctorName,
    published.publication!.doctorName,
  );
  assert.deepEqual(result.data.procedure.templateSource.customizedFields, ['title', 'aftercare']);
  assert.equal(result.data.receipt.createdById, f.doctor.id);
  assert.deepEqual(result.data.receipt.templateSelection, body.templateSelection);
  const summaryBefore = await f.call('/patients/patient-ananya/care-summary', f.patient);
  assert.equal(summaryBefore.status, 200);
  const revised = await f.publish(await f.draft(published));
  await f.availability(revised, false);
  const workflows = await f.call('/patients/patient-ananya/clinical-workflows', f.patient),
    summary = await f.call('/patients/patient-ananya/care-summary', f.patient);
  const saved = workflows.data.procedures.find(
    (p: { id: string }) => p.id === result.data.procedure.id,
  );
  assert.equal(saved.templateSource.version, 1);
  assert.equal(saved.aftercare, body.aftercare);
  assert.equal(summary.data.revision, summaryBefore.data.revision);
  const serialized = JSON.stringify([workflows.data, summary.data]);
  for (const forbidden of [
    privateReason,
    body.requestId,
    body.templateSelection!.expectedSelectionRevision,
    'procedureCatalogueCommands',
    'createdById',
  ])
    assert.ok(!serialized.includes(forbidden), forbidden);
  const reception = await f.call('/procedure-billing?patientId=patient-ananya', f.reception);
  assert.equal(reception.status, 200);
  assert.ok(!JSON.stringify(reception.data).includes('templateSource'));
});

test('patient-plan command retries retain original receipts after publication, archival and terminal lifecycle changes', async (t) => {
  const f = await fixture(t),
    d = await f.publish((await f.create()).detail),
    body = f.plan(d);
  const first = await f.call('/procedures', f.doctor, 'POST', {
    ...body,
    requestId: body.requestId.toUpperCase(),
  });
  assert.equal(first.status, 201);
  await f.call(`/procedures/${first.data.procedure.id}/cancel`, f.doctor, 'POST', {
    reason: 'Synthetic cancellation',
  });
  await f.availability(await f.publish(await f.draft(d)), false);
  const replay = await f.call('/procedures', f.doctor, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.receipt, first.data.receipt);
  assert.equal(replay.data.procedure.status, 'cancelled');
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM procedures WHERE id=?').get(first.data.procedure.id)!.n,
    1,
  );
  assert.equal(
    f.db
      .prepare('SELECT count(*) n FROM activity WHERE eventKey=?')
      .get(`procedure-planned:${first.data.procedure.id}`)!.n,
    1,
  );
  assert.equal((await f.call('/procedures', f.admin, 'POST', body)).status, 409);
  assert.equal(
    (
      await f.call('/procedures', f.doctor, 'POST', {
        ...body,
        indication: 'Different patient explanation',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call('/procedure-catalogue', f.doctor, 'POST', {
        fields,
        reason: 'Cross-operation collision',
        requestId: body.requestId,
      })
    ).status,
    409,
  );
});

test('catalogue replay returns the original immutable version after later drafts and publication', async (t) => {
  const f = await fixture(t),
    requestId = randomUUID(),
    body = { fields, reason: privateReason, requestId };
  const first = await f.call('/procedure-catalogue', f.doctor, 'POST', body);
  assert.equal(first.status, 201);
  const newest = await f.publish(await f.draft(first.data.detail));
  const replay = await f.call('/procedure-catalogue', f.doctor, 'POST', {
    ...body,
    requestId: requestId.toUpperCase(),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.event.id, first.data.event.id);
  assert.equal(replay.data.version.id, first.data.version.id);
  assert.deepEqual(replay.data.version.fields, fields);
  assert.equal(replay.data.detail.latestVersion.id, newest.latestVersion.id);
  assert.equal((await f.call('/procedure-catalogue', f.admin, 'POST', body)).status, 409);
  assert.equal(
    (
      await f.call('/procedure-catalogue', f.doctor, 'POST', {
        ...body,
        reason: 'Different reason',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(`/procedure-catalogue/${newest.template.id}/versions`, f.doctor, 'POST', {
        fields: newest.latestVersion.fields,
        reason: 'No-op',
        expectedRevision: newest.template.revision,
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
});

test('legacy manual responses remain plain while manual UUID plans get immutable receipts without template claims', async (t) => {
  const f = await fixture(t),
    { requestId: _request, ...manual } = f.plan();
  const legacy = await f.call('/procedures', f.doctor, 'POST', manual);
  assert.equal(legacy.status, 201);
  assert.ok(legacy.data.id);
  assert.equal(legacy.data.procedure, undefined);
  assert.equal(legacy.data.templateSource, undefined);
  const body = f.plan(),
    first = await f.call('/procedures', f.doctor, 'POST', body);
  assert.equal(first.status, 201);
  assert.equal(first.data.receipt.templateSelection, null);
  assert.equal(first.data.procedure.templateSource, undefined);
  const replay = await f.call('/procedures', f.doctor, 'POST', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.procedure.id, first.data.procedure.id);
  assert.equal((await f.call('/procedures', f.unlinked, 'POST', body)).status, 400);
});

test('stale catalogue writes and concurrent publication/version saves cannot overwrite their shared source', async (t) => {
  const f = await fixture(t),
    d = (await f.create()).detail;
  const changes = await Promise.all(
    ['A', 'B'].map((title) =>
      f.call(`/procedure-catalogue/${d.template.id}/versions`, f.doctor, 'POST', {
        fields: { ...fields, title },
        reason: 'Concurrent fixture',
        expectedRevision: d.template.revision,
        requestId: randomUUID(),
      }),
    ),
  );
  assert.deepEqual(changes.map((r) => r.status).sort(), [200, 409]);
  const latest = await f.detail(d.template.id),
    body = {
      versionId: latest.latestVersion.id,
      reviewed: true,
      reason: 'Concurrent publication',
      expectedRevision: latest.template.revision,
      requestId: randomUUID(),
    };
  const same = await Promise.all([
    f.call(`/procedure-catalogue/${d.template.id}/publish`, f.doctor, 'POST', body),
    f.call(`/procedure-catalogue/${d.template.id}/publish`, f.doctor, 'POST', body),
  ]);
  assert.deepEqual(
    same.map((r) => r.status),
    [200, 200],
  );
  assert.equal(same[0].data.event.id, same[1].data.event.id);
  const plan = f.plan(same[0].data.detail),
    created = await Promise.all([
      f.call('/procedures', f.doctor, 'POST', plan),
      f.call('/procedures', f.doctor, 'POST', plan),
    ]);
  assert.deepEqual(created.map((r) => r.status).sort(), [200, 201]);
  assert.equal(created[0].data.procedure.id, created[1].data.procedure.id);
});

test('catalogue original versions, lifecycle events and command receipts reject mutation/deletion', async (t) => {
  const f = await fixture(t),
    d = await f.publish((await f.create()).detail);
  await f.call('/procedures', f.doctor, 'POST', f.plan(d));
  for (const table of [
    'procedureTemplateVersions',
    'procedureTemplateEvents',
    'procedureCatalogueCommands',
  ]) {
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
    const column = table === 'procedureCatalogueCommands' ? 'payload' : 'data';
    assert.throws(() => f.db.exec(`UPDATE ${table} SET ${column}='{}'`), /immutable/);
  }
});

test('catalogue audit failures roll back source, version, receipt and publication atomically', async (t) => {
  const f = await fixture(t),
    body = { fields, reason: privateReason, requestId: randomUUID() };
  f.db.exec(
    "CREATE TRIGGER catalogue_test_audit BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') LIKE 'procedure catalogue %' BEGIN SELECT RAISE(ABORT,'Synthetic catalogue audit failure'); END",
  );
  assert.equal((await f.call('/procedure-catalogue', f.doctor, 'POST', body)).status, 500);
  for (const table of [
    'procedureTemplates',
    'procedureTemplateVersions',
    'procedureTemplateEvents',
    'procedureCatalogueCommands',
  ])
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
  f.db.exec('DROP TRIGGER catalogue_test_audit');
  const created = await f.call('/procedure-catalogue', f.doctor, 'POST', body);
  assert.equal(created.status, 201);
  const d = created.data.detail;
  f.db.exec(
    "CREATE TRIGGER catalogue_test_audit BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='procedure catalogue published' BEGIN SELECT RAISE(ABORT,'Synthetic catalogue audit failure'); END",
  );
  const publish = {
    versionId: d.latestVersion.id,
    reviewed: true,
    reason: privateReason,
    expectedRevision: d.template.revision,
    requestId: randomUUID(),
  };
  assert.equal(
    (await f.call(`/procedure-catalogue/${d.template.id}/publish`, f.doctor, 'POST', publish))
      .status,
    500,
  );
  assert.equal((await f.detail(d.template.id)).publishedVersion, null);
  assert.equal(
    f.db
      .prepare('SELECT count(*) n FROM procedureCatalogueCommands WHERE requestId=?')
      .get(publish.requestId)!.n,
    0,
  );
  f.db.exec('DROP TRIGGER catalogue_test_audit');
  assert.equal(
    (await f.call(`/procedure-catalogue/${d.template.id}/publish`, f.doctor, 'POST', publish))
      .status,
    200,
  );
});

test('patient activity failure rolls back plan and replay receipt, allowing the exact original retry', async (t) => {
  const f = await fixture(t),
    d = await f.publish((await f.create()).detail),
    body = f.plan(d),
    before = Number(f.db.prepare('SELECT count(*) n FROM procedures').get()!.n);
  f.db.exec(
    "CREATE TRIGGER catalogue_test_activity BEFORE INSERT ON activity WHEN NEW.eventKey LIKE 'procedure-planned:%' BEGIN SELECT RAISE(ABORT,'Synthetic catalogue activity failure'); END",
  );
  assert.equal((await f.call('/procedures', f.doctor, 'POST', body)).status, 500);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM procedures').get()!.n), before);
  assert.equal(
    f.db
      .prepare('SELECT count(*) n FROM procedureCatalogueCommands WHERE requestId=?')
      .get(body.requestId)!.n,
    0,
  );
  f.db.exec('DROP TRIGGER catalogue_test_activity');
  assert.equal((await f.call('/procedures', f.doctor, 'POST', body)).status, 201);
});

test('history remains bounded but current publication provenance and every older version remain accessible', async (t) => {
  const f = await fixture(t),
    published = await f.publish((await f.create()).detail, f.admin);
  let d = published;
  for (let i = 0; i < 29; i++) d = await f.draft(d, `Draft ${i}`);
  assert.equal(d.history.length, 25);
  assert.equal(d.historyTotal, 31);
  assert.ok(!d.history.some((e) => e.operation === 'published'));
  assert.equal(d.publication!.id, published.publication!.id);
  assert.equal(d.template.selectionRevision, published.template.selectionRevision);
  const oldHistory = await f.call(
    `/procedure-catalogue/${d.template.id}/history?page=999&pageSize=10`,
    f.doctor,
  );
  assert.equal(oldHistory.status, 200);
  assert.equal(oldHistory.data.page, 4);
  assert.equal(oldHistory.data.items.at(-1).operation, 'created');
  const versions = await f.call(
    `/procedure-catalogue/${d.template.id}/versions?page=3&pageSize=10`,
    f.doctor,
  );
  assert.equal(versions.data.items.length, 10);
  assert.equal(versions.data.items.at(-1).version, 1);
  const plan = await f.call('/procedures', f.doctor, 'POST', f.plan(d));
  assert.equal(plan.status, 201);
  assert.equal(
    plan.data.procedure.templateSource.reviewedByDoctorName,
    published.publication!.doctorName,
  );
});

test('catalogue pagination/search are literal, deterministic, clamped and SQL bounded', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 31; i++)
    await f.create({
      title: `Synthetic list ${String(i).padStart(2, '0')}${i === 0 ? ' %_ needle' : ''}`,
    });
  const one = await f.call('/procedure-catalogue?page=1&pageSize=10', f.doctor),
    two = await f.call('/procedure-catalogue?page=2&pageSize=10', f.doctor);
  assert.equal(one.data.total, 31);
  assert.equal(one.data.items.length, 10);
  assert.equal(two.data.items.length, 10);
  assert.equal(
    new Set([...one.data.items, ...two.data.items].map((row: { id: string }) => row.id)).size,
    20,
  );
  const final = await f.call('/procedure-catalogue?page=99&pageSize=10', f.doctor);
  assert.equal(final.data.page, 4);
  assert.equal(final.data.items.length, 1);
  const literal = await f.call('/procedure-catalogue?search=%25_', f.doctor);
  assert.equal(literal.data.total, 1);
  assert.equal(
    (await f.call('/procedure-catalogue?publication=published', f.doctor)).data.total,
    0,
  );
  const statements: string[] = [],
    prepare = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  }) as typeof f.db.prepare;
  await f.call('/procedure-catalogue?pageSize=10', f.doctor);
  f.db.prepare = prepare;
  assert.ok(
    statements.some((sql) => sql.includes('ORDER BY t.updatedAt DESC,t.id DESC LIMIT ? OFFSET ?')),
  );
  assert.ok(!statements.some((sql) => /^SELECT data FROM procedureTemplateVersions/.test(sql)));
  const explain = f.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM procedureTemplates ORDER BY updatedAt DESC,id DESC LIMIT 10',
    )
    .all();
  assert.ok(explain.some((row) => String(row.detail).includes('procedure_templates_updated')));
});

test('restart retains published sources and exact command receipts without changing existing plan evidence', async (t) => {
  const path = directory(t),
    first = await fixture(t, path),
    d = await first.publish((await first.create()).detail),
    body = first.plan(d);
  const saved = await first.call('/procedures', first.doctor, 'POST', body);
  assert.equal(saved.status, 201);
  await first.close();
  const restarted = await fixture(t, path),
    replay = await restarted.call('/procedures', restarted.doctor, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.receipt, saved.data.receipt);
  assert.deepEqual(replay.data.procedure.templateSource, saved.data.procedure.templateSource);
  assert.equal((await restarted.detail(d.template.id)).publication!.id, d.publication!.id);
});

test('fresh role/session authorization occurs inside the write transaction before replay or source disclosure', async (t) => {
  const path = directory(t),
    f = await fixture(t, path),
    d = (await f.create()).detail,
    external = openDatabase(path);
  t.after(() => external.close());
  const original = f.db.exec.bind(f.db);
  let interrupted = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !interrupted) {
      interrupted = true;
      external.prepare('DELETE FROM sessions WHERE userId=?').run(f.doctor.id!);
    }
    return original(sql);
  }) as typeof f.db.exec;
  const response = await f.call(`/procedure-catalogue/${d.template.id}`, f.doctor);
  f.db.exec = original;
  assert.equal(interrupted, true);
  assert.equal(response.status, 401);
  assert.equal(response.data.latestVersion, undefined);
});

test('source selection is revalidated under the patient-plan lock after a second application archives the template', async (t) => {
  const path = directory(t),
    f = await fixture(t, path),
    d = await f.publish((await f.create()).detail),
    external = openDatabase(path);
  t.after(() => external.close());
  const original = f.db.exec.bind(f.db);
  let interrupted = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !interrupted) {
      interrupted = true;
      external.prepare('UPDATE procedureTemplates SET active=0 WHERE id=?').run(d.template.id);
    }
    return original(sql);
  }) as typeof f.db.exec;
  const body = f.plan(d),
    response = await f.call('/procedures', f.doctor, 'POST', body);
  f.db.exec = original;
  assert.equal(interrupted, true);
  assert.equal(response.status, 409);
  assert.equal(
    f.db
      .prepare('SELECT count(*) n FROM procedureCatalogueCommands WHERE requestId=?')
      .get(body.requestId)!.n,
    0,
  );
});
