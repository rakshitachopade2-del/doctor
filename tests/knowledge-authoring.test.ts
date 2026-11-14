import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { createUser, insert, openDatabase, type DB } from '../server/db.ts';
import type { KnowledgeArticle } from '../shared/operations.ts';
import type { KnowledgeAuthoringDetail, KnowledgeFields } from '../shared/knowledge-authoring.ts';
import type { User } from '../shared/types.ts';

const password = 'SyntheticKnowledge2026!';
const fields: KnowledgeFields = {
  title: 'Synthetic clinic information',
  category: 'Clinic information',
  body: 'Approved synthetic information for a local test. No medical advice.',
};
const privateReason = 'PRIVATE_EDITORIAL_REASON_SENTINEL';
const template =
  '<!doctype html><html><head><!--public-library-head-start--><title>Test</title><!--public-library-head-end--></head><body><div id="root"></div><!--public-library-data--></body></html>';
type Client = { user: User; cookie: string; csrf: string };

async function fixture(t: TestContext, path?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-knowledge-authoring-'));
  writeFileSync(join(directory, 'index.html'), template);
  const databasePath = path ?? join(directory, 'clinic.sqlite');
  const app = createApp({
    databasePath,
    demoMode: false,
    production: false,
    staticDirectory: directory,
    publicOrigin: 'https://library.example.test',
    publicIndexing: false,
  });
  const db = app.locals.db as DB;
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    app.locals.close();
  }
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function call(path: string, who?: Client, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who ? { Cookie: who.cookie, 'X-CSRF-Token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  async function account(role: User['role'] = 'admin', overrides: Partial<User> = {}) {
    const id = randomUUID();
    const user: User = {
      id,
      name: `Synthetic ${role}`,
      email: `${id}@example.test`,
      role,
      active: true,
      ...overrides,
    };
    createUser(db, user, password);
    const response = await call('/auth/login', undefined, 'POST', { email: user.email, password });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return {
      user,
      cookie: response.headers.get('set-cookie')!.split(';')[0],
      csrf: response.data.csrfToken,
    };
  }
  const admin = await account();
  async function detail(id: string, who = admin): Promise<KnowledgeAuthoringDetail> {
    const result = await call(`/knowledge-authoring/${id}`, who);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  const createBody = (
    publication: 'draft' | 'published' = 'draft',
    overrides: Record<string, unknown> = {},
  ) => ({
    fields,
    publication,
    ...(publication === 'published' ? { reviewed: true } : {}),
    reason: privateReason,
    requestId: randomUUID(),
    ...overrides,
  });
  async function create(
    publication: 'draft' | 'published' = 'draft',
    overrides: Record<string, unknown> = {},
    who = admin,
  ) {
    const body = createBody(publication, overrides);
    const result = await call('/knowledge-authoring', who, 'POST', body);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return { ...result.data, body };
  }
  const saveBody = (
    source: KnowledgeAuthoringDetail,
    changed: KnowledgeFields,
    publication: 'draft' | 'published' = 'draft',
  ) => ({
    fields: changed,
    publication,
    ...(publication === 'published' ? { reviewed: true } : {}),
    reason: privateReason,
    expectedRevision: source.revision,
    requestId: randomUUID(),
  });
  const publicationBody = (source: KnowledgeAuthoringDetail, published: boolean) => ({
    published,
    ...(published ? { reviewed: true } : {}),
    reason: privateReason,
    expectedRevision: source.revision,
    requestId: randomUUID(),
  });
  return {
    app,
    db,
    databasePath,
    base,
    call,
    account,
    admin,
    detail,
    createBody,
    create,
    saveBody,
    publicationBody,
    close,
  };
}

const count = (db: DB, table: string) =>
  Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
const evidenceTables = [
  'knowledge',
  'knowledgeRevisions',
  'knowledgeVersions',
  'knowledgeEvents',
  'knowledgeCommands',
  'knowledgeAuthoringHeads',
  'audit',
];
const counts = (db: DB) =>
  Object.fromEntries(evidenceTables.map((table) => [table, count(db, table)]));

test('authoring reads, versions and commands are private to current clinicians including unlinked administrators', async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    id = created.detail.article.id;
  const doctor = await f.account('doctor'),
    reception = await f.account('receptionist'),
    patient = await f.account('patient');
  for (const path of [
    '/knowledge-authoring',
    `/knowledge-authoring/${id}`,
    `/knowledge-authoring/${id}/versions`,
    `/knowledge-authoring/${id}/versions/${created.version.id}`,
    `/knowledge-authoring/${id}/history`,
  ]) {
    assert.equal((await f.call(path)).status, 401);
    for (const who of [reception, patient]) assert.equal((await f.call(path, who)).status, 403);
    for (const who of [f.admin, doctor]) {
      const response = await f.call(path, who);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    }
  }
  for (const who of [reception, patient])
    assert.equal((await f.call('/knowledge-authoring', who, 'POST', f.createBody())).status, 403);
  const temporary = await f.account('admin', { mustChangePassword: true });
  assert.equal((await f.call('/knowledge-authoring', temporary)).status, 403);
  assert.equal(
    (await f.call('/knowledge-authoring', temporary, 'POST', f.createBody())).status,
    403,
  );
  const badCsrf = { ...doctor, csrf: 'invalid-token' };
  assert.equal((await f.call('/knowledge-authoring', badCsrf, 'POST', f.createBody())).status, 403);
});

test('one atomic create can publish reviewed content with exact attributed version and normalized command receipt', async (t) => {
  const f = await fixture(t);
  const requestId = randomUUID().toUpperCase();
  const created = await f.create('published', {
    requestId,
    fields: {
      title: ` ${fields.title} `,
      category: ` ${fields.category} `,
      body: ` ${fields.body} `,
    },
    reason: undefined,
  });
  const { detail, version, event } = created;
  assert.equal(detail.article.status, 'published');
  assert.equal(detail.currentVersion.id, version.id);
  assert.equal(detail.publication.id, event.id);
  assert.deepEqual(version.fields, fields);
  assert.equal(version.origin, 'created');
  assert.equal(version.createdById, f.admin.user.id);
  assert.equal(version.legacy, null);
  assert.equal(event.requestId, requestId.toLowerCase());
  assert.equal(event.createdById, f.admin.user.id);
  assert.equal(event.createdByRole, 'admin');
  assert.equal(event.reviewConfirmed, true);
  assert.equal(event.reason, '');
  assert.equal(event.before, null);
  assert.equal(event.after.status, 'published');
  assert.equal(event.source, 'command');
  assert.equal((await f.call(`/public-library/${detail.article.id}`)).data.body, fields.body);
  assert.equal(count(f.db, 'knowledge'), 1);
  assert.equal(count(f.db, 'knowledgeVersions'), 1);
  assert.equal(count(f.db, 'knowledgeEvents'), 1);
  assert.equal(count(f.db, 'knowledgeCommands'), 1);
});

test('strict new commands require explicit publication review, source revision and valid restore confirmation', async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { unknown: true },
    { status: 'published' },
    { fields: { ...fields, hidden: 'injected' } },
    { publication: 'published' },
    { reviewed: false },
    { reason: 'x'.repeat(1001) },
    { requestId: 'bad-id' },
  ]) {
    const response = await f.call('/knowledge-authoring', f.admin, 'POST', {
      ...f.createBody(),
      ...extra,
    });
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  assert.equal(count(f.db, 'knowledge'), 0);
  const created = await f.create(),
    source = created.detail;
  const save = f.saveBody(source, { ...fields, title: 'Updated title' });
  for (const changed of [
    { ...save, expectedRevision: undefined },
    { ...save, requestId: undefined },
    { ...save, expectedRevision: 'invalid' },
    { ...save, unknown: true },
  ])
    assert.equal(
      (await f.call(`/knowledge-authoring/${source.article.id}/save`, f.admin, 'POST', changed))
        .status,
      400,
    );
  assert.equal(
    (
      await f.call(`/knowledge-authoring/${source.article.id}/publication`, f.admin, 'POST', {
        ...f.publicationBody(source, true),
        reviewed: undefined,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(`/knowledge-authoring/${source.article.id}/restore`, f.admin, 'POST', {
        versionId: created.version.id,
        requestId: randomUUID(),
        expectedRevision: source.revision,
        reason: 'Restore source',
      })
    ).status,
    400,
  );
  assert.equal((await f.detail(source.article.id)).revision, source.revision);
});

test('exact create and save retries return original receipts after later changes and reject actor, payload, target and action collisions', async (t) => {
  const f = await fixture(t),
    first = await f.create('published'),
    id = first.detail.article.id;
  const editBody = f.saveBody(first.detail, { ...fields, body: 'A later draft body' });
  const edited = await f.call(`/knowledge-authoring/${id}/save`, f.admin, 'POST', editBody);
  assert.equal(edited.status, 200);
  const publishBody = f.publicationBody(edited.data.detail, true);
  const later = await f.call(
    `/knowledge-authoring/${id}/publication`,
    f.admin,
    'POST',
    publishBody,
  );
  assert.equal(later.status, 200);
  const before = counts(f.db);
  const replay = await f.call('/knowledge-authoring', f.admin, 'POST', first.body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.event, first.event);
  assert.deepEqual(replay.data.version, first.version);
  assert.equal(replay.data.detail.revision, later.data.detail.revision);
  const saveReplay = await f.call(`/knowledge-authoring/${id}/save`, f.admin, 'POST', editBody);
  assert.equal(saveReplay.status, 200);
  assert.deepEqual(saveReplay.data.event, edited.data.event);
  assert.deepEqual(saveReplay.data.version, edited.data.version);
  assert.deepEqual(counts(f.db), before);
  const other = await f.account();
  assert.equal((await f.call('/knowledge-authoring', other, 'POST', first.body)).status, 409);
  assert.equal(
    (
      await f.call('/knowledge-authoring', f.admin, 'POST', {
        ...first.body,
        fields: { ...fields, body: 'Different payload' },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(`/knowledge-authoring/${id}/save`, f.admin, 'POST', {
        ...editBody,
        expectedRevision: later.data.detail.revision,
      })
    ).status,
    409,
  );
  const another = await f.create();
  assert.equal(
    (
      await f.call(
        `/knowledge-authoring/${another.detail.article.id}/save`,
        f.admin,
        'POST',
        editBody,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(`/knowledge-authoring/${id}/publication`, f.admin, 'POST', {
        ...f.publicationBody(later.data.detail, false),
        requestId: editBody.requestId,
      })
    ).status,
    409,
  );
});

test('stale writers cannot publish or overwrite current content, and ABA content changes never revive old revision tokens', async (t) => {
  const f = await fixture(t),
    first = await f.create(),
    id = first.detail.article.id;
  const edited = await f.call(
    `/knowledge-authoring/${id}/save`,
    f.admin,
    'POST',
    f.saveBody(first.detail, { ...fields, body: 'Intermediate content B' }),
  );
  assert.equal(edited.status, 200);
  const returned = await f.call(
    `/knowledge-authoring/${id}/save`,
    f.admin,
    'POST',
    f.saveBody(edited.data.detail, fields),
  );
  assert.equal(returned.status, 200);
  assert.notEqual(returned.data.detail.revision, first.detail.revision);
  assert.equal(returned.data.detail.currentVersion.version, 3);
  const before = counts(f.db);
  assert.equal(
    (
      await f.call(
        `/knowledge-authoring/${id}/save`,
        f.admin,
        'POST',
        f.saveBody(first.detail, { ...fields, title: 'Stale overwrite' }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        `/knowledge-authoring/${id}/publication`,
        f.admin,
        'POST',
        f.publicationBody(first.detail, true),
      )
    ).status,
    409,
  );
  assert.deepEqual(counts(f.db), before);
  const published = await f.call(
    `/knowledge-authoring/${id}/publication`,
    f.admin,
    'POST',
    f.publicationBody(returned.data.detail, true),
  );
  assert.equal(published.status, 200);
  assert.equal(published.data.version.id, returned.data.version.id);
  assert.equal(count(f.db, 'knowledgeVersions'), 3);
  assert.equal(
    (
      await f.call(
        `/knowledge-authoring/${id}/publication`,
        f.admin,
        'POST',
        f.publicationBody(published.data.detail, true),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(
        `/knowledge-authoring/${id}/save`,
        f.admin,
        'POST',
        f.saveBody(published.data.detail, fields, 'published'),
      )
    ).status,
    400,
  );
});

test('restoring a historical version appends an attributed draft, withdraws the same public URL and keeps private evidence immutable', async (t) => {
  const f = await fixture(t),
    first = await f.create('published'),
    id = first.detail.article.id;
  const changed = await f.call(
    `/knowledge-authoring/${id}/save`,
    f.admin,
    'POST',
    f.saveBody(first.detail, { ...fields, body: 'Second approved content' }, 'published'),
  );
  assert.equal(changed.status, 200);
  const otherArticle = await f.create();
  const makeRestore = (versionId: string) => ({
    versionId,
    confirmed: true,
    reason: privateReason,
    requestId: randomUUID(),
    expectedRevision: changed.data.detail.revision,
  });
  for (const versionId of [changed.data.version.id, otherArticle.version.id, randomUUID()]) {
    const rejected = await f.call(
      `/knowledge-authoring/${id}/restore`,
      f.admin,
      'POST',
      makeRestore(versionId),
    );
    assert.equal(
      rejected.status,
      versionId === changed.data.version.id ? 400 : 404,
      JSON.stringify(rejected.data),
    );
  }
  assert.equal(
    (
      await f.call(`/knowledge-authoring/${id}/restore`, f.admin, 'POST', {
        ...makeRestore(first.version.id),
        reason: 'x',
      })
    ).status,
    400,
  );
  const body = makeRestore(first.version.id);
  const restored = await f.call(`/knowledge-authoring/${id}/restore`, f.admin, 'POST', body);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.detail.article.id, id);
  assert.equal(restored.data.detail.article.status, 'draft');
  assert.equal(restored.data.detail.publication, null);
  assert.deepEqual(restored.data.version.fields, first.version.fields);
  assert.notEqual(restored.data.version.id, first.version.id);
  assert.equal(restored.data.version.origin, 'restored');
  assert.equal(restored.data.version.restoredFromVersionId, first.version.id);
  assert.equal(restored.data.version.createdById, f.admin.user.id);
  assert.equal(restored.data.event.restoreConfirmed, true);
  assert.equal(restored.data.event.reviewConfirmed, false);
  assert.equal((await f.call(`/public-library/${id}`)).status, 404);
  assert.equal((await fetch(`${f.base}/library/${id}`)).status, 404);
  const prior = await f.call(`/knowledge-authoring/${id}/versions/${first.version.id}`, f.admin);
  assert.deepEqual(prior.data, first.version);
  const published = await f.call(
    `/knowledge-authoring/${id}/publication`,
    f.admin,
    'POST',
    f.publicationBody(restored.data.detail, true),
  );
  assert.equal(published.status, 200);
  assert.equal((await f.call(`/public-library/${id}`)).data.body, fields.body);
  const equalRestore = await f.call(`/knowledge-authoring/${id}/restore`, f.admin, 'POST', {
    ...body,
    expectedRevision: published.data.detail.revision,
    requestId: randomUUID(),
  });
  assert.equal(equalRestore.status, 200, JSON.stringify(equalRestore.data));
  assert.equal(equalRestore.data.detail.currentVersion.version, 4);
  assert.equal(equalRestore.data.detail.article.status, 'draft');
  const replay = await f.call(`/knowledge-authoring/${id}/restore`, f.admin, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.event, restored.data.event);
  assert.deepEqual(replay.data.version, restored.data.version);
  for (const [table, column] of [
    ['knowledgeVersions', 'data'],
    ['knowledgeEvents', 'data'],
    ['knowledgeCommands', 'payload'],
    ['knowledgeRevisions', 'data'],
  ]) {
    assert.throws(
      () => f.db.exec(`UPDATE ${table} SET ${column}=${column}`),
      /immutable|append-only/i,
    );
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable|append-only/i);
  }
  const final = await f.call(
    `/knowledge-authoring/${id}/publication`,
    f.admin,
    'POST',
    f.publicationBody(equalRestore.data.detail, true),
  );
  assert.equal(final.status, 200);
  const publicApi = await f.call(`/public-library/${id}`),
    legacyPublic = await f.call('/knowledge');
  const html = await (await fetch(`${f.base}/library/${id}`)).text();
  for (const output of [JSON.stringify(publicApi.data), JSON.stringify(legacyPublic.data), html]) {
    for (const secret of [
      privateReason,
      first.event.id,
      restored.data.event.id,
      first.version.id,
      body.requestId,
      f.admin.user.id,
      final.data.detail.revision,
    ])
      assert.ok(!output.includes(secret));
  }
});

test('create, save, publication and restore roll back projection, snapshots, receipts and audit as one transaction', async (t) => {
  for (const operation of ['create', 'save', 'publication', 'restore'] as const) {
    const f = await fixture(t);
    let path = '/knowledge-authoring',
      body: Record<string, unknown> = f.createBody('published');
    if (operation !== 'create') {
      const initial = await f.create();
      const id = initial.detail.article.id;
      path = `/knowledge-authoring/${id}/${operation}`;
      if (operation === 'save')
        body = f.saveBody(initial.detail, { ...fields, title: 'Changed title' }, 'published');
      if (operation === 'publication') body = f.publicationBody(initial.detail, true);
      if (operation === 'restore') {
        const edited = await f.call(
          `/knowledge-authoring/${id}/save`,
          f.admin,
          'POST',
          f.saveBody(initial.detail, { ...fields, body: 'Second source' }),
        );
        assert.equal(edited.status, 200);
        body = {
          versionId: initial.version.id,
          confirmed: true,
          reason: privateReason,
          expectedRevision: edited.data.detail.revision,
          requestId: randomUUID(),
        };
      }
    }
    const before = counts(f.db),
      projections = f.db.prepare('SELECT * FROM knowledge ORDER BY id').all(),
      heads = f.db.prepare('SELECT * FROM knowledgeAuthoringHeads ORDER BY articleId').all();
    f.db.exec(
      "CREATE TRIGGER synthetic_knowledge_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='knowledge' BEGIN SELECT RAISE(ABORT,'Synthetic authoring audit failure'); END;",
    );
    const failed = await f.call(path, f.admin, 'POST', body);
    assert.equal(failed.status, 500, operation);
    assert.equal(failed.headers.get('set-cookie'), null);
    assert.deepEqual(counts(f.db), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM knowledge ORDER BY id').all(), projections);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM knowledgeAuthoringHeads ORDER BY articleId').all(),
      heads,
    );
    f.db.exec('DROP TRIGGER synthetic_knowledge_failure');
    f.db.exec(
      "CREATE TRIGGER synthetic_knowledge_failure BEFORE INSERT ON knowledgeCommands BEGIN SELECT RAISE(ABORT,'Synthetic authoring receipt failure'); END;",
    );
    assert.equal((await f.call(path, f.admin, 'POST', body)).status, 500);
    assert.deepEqual(counts(f.db), before);
    f.db.exec('DROP TRIGGER synthetic_knowledge_failure');
    const saved = await f.call(path, f.admin, 'POST', body);
    assert.equal(saved.status, operation === 'create' ? 201 : 200, JSON.stringify(saved.data));
    assert.equal(saved.data.event.requestId, body.requestId);
  }
});

test('legacy routes keep plain compatible responses while using atomic attributed evidence and withdrawing edited publications', async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "CREATE TRIGGER synthetic_legacy_create_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='knowledge' BEGIN SELECT RAISE(ABORT,'Synthetic legacy create failure'); END;",
  );
  const before = counts(f.db);
  assert.equal(
    (
      await f.call('/knowledge', f.admin, 'POST', {
        ...fields,
        status: 'published',
        injected: 'IGNORED_FIELD',
      })
    ).status,
    500,
  );
  assert.deepEqual(counts(f.db), before);
  f.db.exec('DROP TRIGGER synthetic_legacy_create_failure');
  const created = await f.call('/knowledge', f.admin, 'POST', {
    ...fields,
    status: 'published',
    injected: 'IGNORED_FIELD',
    requestId: randomUUID(),
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'draft');
  assert.equal(created.data.injected, undefined);
  assert.equal(created.data.requestId, undefined);
  assert.equal(created.data.event, undefined);
  const id = created.data.id;
  const published = await f.call(`/knowledge/${id}`, f.admin, 'PATCH', { status: 'published' });
  assert.equal(published.status, 200);
  const approved = await f.detail(id);
  assert.equal(approved.publication!.source, 'legacy-api');
  assert.equal(approved.publication!.requestId, null);
  assert.equal(approved.publication!.createdById, f.admin.user.id);
  const secondReviewer = await f.account('doctor', { name: 'Synthetic second reviewer' });
  const unchanged = await f.call(`/knowledge/${id}`, secondReviewer, 'PATCH', {
    title: fields.title,
  });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.data.authorName, f.admin.user.name);
  const unchangedDetail = await f.detail(id);
  assert.equal(unchangedDetail.publication!.id, approved.publication!.id);
  assert.equal(unchangedDetail.history[0].createdById, secondReviewer.user.id);
  assert.equal(unchangedDetail.history[0].createdByName, secondReviewer.user.name);
  assert.equal(unchangedDetail.history[0].reviewConfirmed, false);
  assert.equal((await f.call(`/public-library/${id}`)).data.authorName, f.admin.user.name);
  const unchangedHtml = await (await fetch(`${f.base}/library/${id}`)).text();
  const attribution = unchangedHtml
    .match(/<p class="public-library-attribution">([\s\S]*?)<\/p>/)?.[1]
    .replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(attribution?.includes(`By ${f.admin.user.name}`));
  assert.ok(!attribution?.includes(secondReviewer.user.name));
  const repeated = await f.call(`/knowledge/${id}`, secondReviewer, 'PATCH', {
    status: 'published',
  });
  assert.equal(repeated.status, 200);
  const repeatedDetail = await f.detail(id);
  assert.notEqual(repeatedDetail.revision, approved.revision);
  assert.equal(repeatedDetail.currentVersion.id, approved.currentVersion.id);
  assert.equal(repeatedDetail.publication!.createdById, secondReviewer.user.id);
  assert.equal(repeatedDetail.publication!.reviewConfirmed, true);
  assert.equal((await f.call(`/public-library/${id}`)).data.authorName, secondReviewer.user.name);
  const approvedHtml = await (await fetch(`${f.base}/library/${id}`)).text();
  assert.ok(
    approvedHtml
      .match(/<p class="public-library-attribution">([\s\S]*?)<\/p>/)?.[1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .includes(`By ${secondReviewer.user.name}`),
  );
  const edit = await f.call(`/knowledge/${id}`, f.admin, 'PATCH', { body: 'Legacy revised draft' });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.status, 'draft');
  assert.equal((await f.call(`/public-library/${id}`)).status, 404);
  const history = await f.call(`/knowledge-authoring/${id}/history`, f.admin);
  assert.ok(
    history.data.items.every(
      (event: { source: string; requestId: string | null }) =>
        event.source === 'legacy-api' && event.requestId === null,
    ),
  );
  assert.equal(count(f.db, 'knowledgeRevisions'), 4);
  assert.equal(count(f.db, 'knowledgeCommands'), 0);
  assert.equal(
    (await f.call(`/knowledge/${id}`, f.admin, 'PATCH', { unexpected: true })).status,
    400,
  );
});

test('legacy imports preserve recorded provenance without inventing authors or approval events and never repeat after restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-knowledge-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'clinic.sqlite'),
    legacy = openDatabase(path);
  legacy.exec(
    'CREATE TABLE knowledge(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE knowledgeRevisions(id TEXT PRIMARY KEY,articleId TEXT NOT NULL REFERENCES knowledge(id),data TEXT NOT NULL);',
  );
  const article: KnowledgeArticle = {
    id: 'legacy-article',
    ...fields,
    body: 'Current published legacy body',
    status: 'published',
    authorName: 'Recorded old author label',
    updatedAt: '2023-05-01T00:00:00.000Z',
  };
  insert(legacy, 'knowledge', article);
  const old = {
    ...article,
    body: 'Legacy earlier draft',
    status: 'draft',
    updatedAt: '2022-01-01T00:00:00.000Z',
  };
  legacy
    .prepare('INSERT INTO knowledgeRevisions(id,articleId,data) VALUES (?,?,?)')
    .run('old-revision-a', article.id, JSON.stringify(old));
  legacy
    .prepare('INSERT INTO knowledgeRevisions(id,articleId,data) VALUES (?,?,?)')
    .run(
      'old-revision-b',
      article.id,
      JSON.stringify({ ...old, body: 'Legacy second retained snapshot' }),
    );
  const originalRows = legacy.prepare('SELECT * FROM knowledgeRevisions ORDER BY rowid').all();
  legacy.close();
  const f = await fixture(t, path),
    detail = await f.detail(article.id);
  assert.deepEqual(detail.article, article);
  assert.equal(detail.publication, null);
  assert.equal(detail.historyTotal, 0);
  assert.equal(detail.versionTotal, 3);
  const versions = await f.call(`/knowledge-authoring/${article.id}/versions`, f.admin);
  assert.deepEqual(
    versions.data.items.map((version: { origin: string }) => version.origin),
    ['legacy-current', 'legacy-snapshot', 'legacy-snapshot'],
  );
  for (const version of versions.data.items) {
    assert.equal(version.createdById, null);
    assert.equal(version.createdByName, null);
    assert.equal(version.createdByRole, null);
    assert.equal(version.createdAt, null);
    assert.equal(version.reason, null);
    assert.equal(version.legacy.authorName, article.authorName);
  }
  assert.equal(versions.data.items[2].legacy.revisionId, 'old-revision-a');
  assert.equal(versions.data.items[2].legacy.updatedAt, old.updatedAt);
  assert.deepEqual(
    f.db.prepare('SELECT * FROM knowledgeRevisions ORDER BY rowid').all(),
    originalRows,
  );
  const currentVersionId = detail.currentVersion.id;
  await f.close();
  const reopened = await fixture(t, path),
    again = await reopened.detail(article.id);
  assert.equal(again.currentVersion.id, currentVersionId);
  assert.equal(again.versionTotal, 3);
  assert.equal(again.historyTotal, 0);
  const restored = await reopened.call(
    `/knowledge-authoring/${article.id}/restore`,
    reopened.admin,
    'POST',
    {
      versionId: versions.data.items[2].id,
      confirmed: true,
      reason: 'Restore retained legacy wording',
      requestId: randomUUID(),
      expectedRevision: again.revision,
    },
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.data.version.origin, 'restored');
  assert.equal(restored.data.version.createdById, reopened.admin.user.id);
  assert.equal(restored.data.detail.article.status, 'draft');
  assert.equal((await reopened.call(`/public-library/${article.id}`)).status, 404);
  assert.deepEqual(
    (
      await reopened.call(
        `/knowledge-authoring/${article.id}/versions/${versions.data.items[2].id}`,
        reopened.admin,
      )
    ).data,
    versions.data.items[2],
  );
});

test('bounded private history retains exact publication outside its first page and validates all paginated queries', async (t) => {
  const f = await fixture(t),
    first = await f.create('published'),
    id = first.detail.article.id;
  for (let index = 0; index < 30; index++) {
    assert.equal(
      (await f.call(`/knowledge/${id}`, f.admin, 'PATCH', { title: fields.title })).status,
      200,
    );
  }
  const current = await f.detail(id);
  assert.equal(current.history.length, 25);
  assert.equal(current.historyTotal, 31);
  assert.equal(current.versionTotal, 1);
  assert.equal(current.publication!.id, first.event.id);
  assert.ok(!current.history.some((event) => event.id === first.event.id));
  const history = await f.call(`/knowledge-authoring/${id}/history?page=999&pageSize=10`, f.admin);
  assert.equal(history.status, 200);
  assert.equal(history.data.page, 4);
  assert.equal(history.data.total, 31);
  assert.equal(history.data.items.length, 1);
  assert.equal(history.data.items[0].id, first.event.id);
  const version = await f.call(`/knowledge-authoring/${id}/versions/${first.version.id}`, f.admin);
  assert.deepEqual(version.data, first.version);
  for (let index = 0; index < 29; index++)
    await f.create(index % 2 ? 'published' : 'draft', {
      fields: {
        ...fields,
        title: `Catalogue ${index}`,
        body: index === 3 ? 'Literal %_\'" NEEDLE' : `Body ${index}`,
      },
    });
  const list = await f.call('/knowledge-authoring?page=999&pageSize=10', f.admin);
  assert.equal(list.status, 200);
  assert.equal(list.data.page, 3);
  assert.equal(list.data.total, 30);
  assert.equal(list.data.items.length, 10);
  assert.ok(
    list.data.items.every(
      (item: Record<string, unknown>) => !('body' in item) && typeof item.revision === 'string',
    ),
  );
  const literal = await f.call(
    `/knowledge-authoring?q=${encodeURIComponent(' %_\'" ')}&status=published`,
    f.admin,
  );
  assert.equal(literal.status, 200);
  assert.equal(literal.data.total, 1);
  assert.equal(literal.data.filters.q, '%_\'"');
  for (const suffix of [
    '?page=0',
    '?page=2&page=1',
    '?pageSize=17',
    '?q[x]=bad',
    '?unknown=1',
    '?status=unknown',
    `?q=${'a'.repeat(201)}`,
  ])
    assert.equal((await f.call(`/knowledge-authoring${suffix}`, f.admin)).status, 400, suffix);
  for (const path of [
    `/knowledge-authoring/${id}?extra=1`,
    `/knowledge-authoring/${id}/versions?page=0`,
    `/knowledge-authoring/${id}/history?pageSize=17`,
    `/knowledge-authoring/${id}/versions/${first.version.id}?extra=1`,
  ])
    assert.equal((await f.call(path, f.admin)).status, 400, path);
  assert.equal((await f.call(`/knowledge-authoring/${randomUUID()}`, f.admin)).status, 404);
  assert.equal(
    (await f.call(`/knowledge-authoring/${id}/versions/${randomUUID()}`, f.admin)).status,
    404,
  );
});

test('two application writers sharing a database accept only one save from the same current revision', async (t) => {
  const first = await fixture(t),
    created = await first.create(),
    id = created.detail.article.id;
  const second = await fixture(t, first.databasePath);
  const [a, b] = await Promise.all([
    first.call(
      `/knowledge-authoring/${id}/save`,
      first.admin,
      'POST',
      first.saveBody(created.detail, { ...fields, body: 'First concurrent writer' }),
    ),
    second.call(
      `/knowledge-authoring/${id}/save`,
      second.admin,
      'POST',
      second.saveBody(created.detail, { ...fields, body: 'Second concurrent writer' }),
    ),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? a : b;
  const current = await first.detail(id);
  assert.equal(current.article.body, winner.data.version.fields.body);
  assert.equal(current.currentVersion.version, 2);
  assert.equal(count(first.db, 'knowledgeCommands'), 2);
  assert.equal(count(second.db, 'knowledgeEvents'), 2);
});

test('a legacy partial edit takes its source under the write lock and preserves a concurrent writer’s unrelated fields', async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    id = created.detail.article.id;
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  let changed = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !changed) {
      external
        .prepare(
          "UPDATE knowledge SET data=json_set(data,'$.title','External writer title') WHERE id=?",
        )
        .run(id);
      changed = true;
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const response = await f.call(`/knowledge/${id}`, f.admin, 'PATCH', {
      body: 'Requested partial body edit',
    });
    assert.equal(changed, true);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.title, 'External writer title');
    assert.equal(response.data.body, 'Requested partial body edit');
    const latestSnapshot = f.db
      .prepare('SELECT data FROM knowledgeRevisions WHERE articleId=? ORDER BY rowid DESC LIMIT 1')
      .get(id)!;
    assert.equal(JSON.parse(String(latestSnapshot.data)).title, 'External writer title');
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('context reads and writes revalidate revoked, expired, changed-role, temporary-password, CSRF and MFA state inside the transaction', async (t) => {
  const changes = ['revoked', 'expired', 'role', 'temporary', 'csrf', 'mfa'] as const;
  for (const change of changes)
    for (const method of ['GET', 'POST']) {
      const f = await fixture(t),
        created = await f.create(),
        id = created.detail.article.id;
      const external = openDatabase(f.databasePath),
        original = f.db.exec.bind(f.db);
      let injected = false;
      f.db.exec = ((sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true;
          if (change === 'revoked')
            external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
          if (change === 'expired')
            external.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(f.admin.user.id);
          if (change === 'csrf')
            external
              .prepare('UPDATE sessions SET csrfToken=? WHERE userId=?')
              .run('concurrently-replaced-csrf', f.admin.user.id);
          if (change === 'role')
            external
              .prepare(
                "UPDATE users SET role='receptionist',data=json_set(data,'$.role','receptionist') WHERE id=?",
              )
              .run(f.admin.user.id);
          if (change === 'temporary')
            external
              .prepare(
                "UPDATE users SET data=json_set(data,'$.mustChangePassword',json('true')) WHERE id=?",
              )
              .run(f.admin.user.id);
          if (change === 'mfa') {
            // A newly enabled factor invalidates an earlier password-only session; no secret is used.
            external
              .prepare(
                'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
              )
              .run(
                f.admin.user.id,
                randomUUID(),
                'Synthetic unused encrypted-source sentinel',
                new Date().toISOString(),
                -1,
              );
          }
        }
        return original(sql);
      }) as typeof f.db.exec;
      try {
        const before = counts(f.db);
        const result = await f.call(
          method === 'GET' ? `/knowledge-authoring/${id}` : `/knowledge-authoring/${id}/save`,
          f.admin,
          method,
          method === 'GET'
            ? undefined
            : f.saveBody(created.detail, { ...fields, body: 'Must not be saved' }),
        );
        assert.equal(injected, true, `${change} ${method}`);
        assert.equal(
          result.status,
          ['role', 'temporary'].includes(change) ? 403 : 401,
          `${change} ${method}: ${JSON.stringify(result.data)}`,
        );
        assert.equal(result.data.article, undefined);
        assert.equal(result.data.currentVersion, undefined);
        assert.deepEqual(counts(f.db), before);
      } finally {
        f.db.exec = original;
        external.close();
      }
    }
});

test('successful saves and their audit use current account attribution rather than stale middleware metadata', async (t) => {
  const f = await fixture(t),
    created = await f.create(),
    id = created.detail.article.id;
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  let changed = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !changed) {
      external
        .prepare(
          "UPDATE users SET data=json_set(data,'$.name','Updated current author') WHERE id=?",
        )
        .run(f.admin.user.id);
      changed = true;
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const result = await f.call(
      `/knowledge-authoring/${id}/save`,
      f.admin,
      'POST',
      f.saveBody(created.detail, { ...fields, title: 'Attributed new title' }),
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.event.createdByName, 'Updated current author');
    assert.equal(result.data.version.createdByName, 'Updated current author');
    assert.equal(result.data.detail.article.authorName, 'Updated current author');
    const audit = f.db
      .prepare(
        "SELECT data FROM audit WHERE json_extract(data,'$.entityType')='knowledge' ORDER BY rowid DESC LIMIT 1",
      )
      .get()!;
    assert.equal(JSON.parse(String(audit.data)).actorName, 'Updated current author');
  } finally {
    f.db.exec = original;
    external.close();
  }
});
