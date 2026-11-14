import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { createUser, get, openDatabase, type DB } from '../server/db.ts';
import type { Patient, User, ClinicalImage } from '../shared/types.ts';
import type { CareSummary } from '../shared/care-summary.ts';
import type { CareSummaryCopyResult } from '../shared/care-summary-copies.ts';
import { syntheticPdf } from './fixtures/report.ts';

import type {
  CareSummaryBundlePreview,
  CareSummaryAttachmentSelection,
} from '../shared/care-summary-bundles.ts';
import type { PatientDocument } from '../shared/documents.ts';

const password = 'DemoClinic2026!';
const patientId = 'patient-ananya';
const summaryPath = (id = patientId) => `/patients/${id}/care-summary`;
const copiesPath = (id = patientId) => `${summaryPath(id)}/copies`;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Client = { user: User; cookie: string; csrf: string };

async function fixture(t: TestContext, database?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-summary-bundles-'));
  const databasePath = database ?? join(directory, 'clinic.sqlite');
  const app = createApp({ databasePath, demoMode: true, production: false });
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
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    const data = response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(text)
      : text;
    return { status: response.status, data, bytes, headers: response.headers };
  }
  async function login(role: string) {
    const result = await call('/auth/login', undefined, 'POST', {
      email: role.includes('@') ? role : `${role}@derma.demo`,
      password,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return {
      user: result.data.user,
      csrf: result.data.csrfToken,
      cookie: result.headers.get('set-cookie')!.split(';')[0],
    } as Client;
  }
  const admin = await login('admin');
  async function account(role: User['role'], overrides: Partial<User> = {}) {
    const id = randomUUID(),
      email = `${id}@example.test`;
    createUser(
      db,
      { id, email, role, name: `Synthetic ${role}`, active: true, ...overrides },
      password,
    );
    return login(email);
  }
  async function live(who = admin, id = patientId): Promise<CareSummary> {
    const result = await call(summaryPath(id), who);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  async function save(who = admin, id = patientId, revision?: string) {
    const body = {
      expectedRevision: revision ?? (await live(who, id)).revision,
      requestId: randomUUID(),
    };
    const result = await call(copiesPath(id), who, 'POST', body);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return { ...(result.data as CareSummaryCopyResult), body };
  }
  async function post(path: string, body: unknown, who = admin, expected = 201) {
    const result = await call(path, who, 'POST', body);
    assert.equal(result.status, expected, JSON.stringify(result.data));
    return result.data;
  }
  return { app, db, base, databasePath, call, login, account, admin, live, save, post, close };
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
type Fixture = Awaited<ReturnType<typeof fixture>>;
function addImage(
  f: Fixture,
  options: {
    id?: string;
    patientId?: string;
    bytes?: Buffer;
    legacy?: boolean;
    metadata?: Partial<ClinicalImage>;
  } = {},
) {
  const bytes = options.bytes ?? png;
  const value: ClinicalImage = {
    id: options.id ?? randomUUID(),
    patientId: options.patientId ?? patientId,
    caption: 'Synthetic नमस्ते image',
    category: 'clinical',
    mimeType: 'image/png',
    createdAt: '2026-01-01T01:00:00.000Z',
    consent: true,
    url: 'https://invalid.example.test/never-fetch',
    ...(!options.legacy
      ? {
          sha256: digest(bytes),
          sizeBytes: bytes.length,
          createdById: f.admin.user.id,
          createdByName: f.admin.user.name,
          createdByRole: 'admin' as const,
        }
      : {}),
    ...options.metadata,
  };
  f.db
    .prepare('INSERT INTO images(id,patientId,data,bytes) VALUES(?,?,?,?)')
    .run(value.id, value.patientId, JSON.stringify(value), bytes);
  return { value, bytes, selection: { type: 'image' as const, id: value.id } };
}
function addDocument(
  f: Fixture,
  options: {
    id?: string;
    patientId?: string;
    bytes?: Buffer;
    metadata?: Partial<PatientDocument>;
  } = {},
) {
  const bytes = options.bytes ?? syntheticPdf();
  const value: PatientDocument = {
    id: options.id ?? randomUUID(),
    patientId: options.patientId ?? patientId,
    title: 'Synthetic PDF report',
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: bytes.length,
    sha256: digest(bytes),
    createdById: f.admin.user.id,
    createdByName: f.admin.user.name,
    createdByRole: 'admin',
    createdAt: '2026-01-01T01:00:00.000Z',
    url: 'file:///never-read-this-path',
    consent: true,
    ...options.metadata,
  };
  f.db
    .prepare('INSERT INTO documents(id,patientId,data,bytes) VALUES(?,?,?,?)')
    .run(value.id, value.patientId, JSON.stringify(value), bytes);
  return { value, bytes, selection: { type: 'document' as const, id: value.id } };
}
const bundlePath = (copyId: string, pid = patientId) => `${copiesPath(pid)}/${copyId}/bundle`;
const count = (db: DB, table: string) =>
  Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
async function prepare(
  f: Fixture,
  copyId: string,
  attachments: CareSummaryAttachmentSelection[],
  who = f.admin,
) {
  const result = await f.call(`${bundlePath(copyId)}/preview`, who, 'POST', { attachments });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data as CareSummaryBundlePreview;
}
async function download(f: Fixture, preview: CareSummaryBundlePreview, who = f.admin) {
  return f.call(`${bundlePath(preview.copy.id)}/download`, who, 'POST', {
    attachments: preview.selection,
    expectedRevision: preview.revision,
  });
}
function inspectWithPython(bytes: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-zip-verify-'));
  try {
    const filename = join(directory, 'bundle.zip');
    writeFileSync(filename, bytes);
    const result = execFileSync(
      'python3',
      [
        '-c',
        `import sys,zipfile,json,hashlib,base64
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps([dict(name=i.filename,method=i.compress_type,flag=i.flag_bits,date=i.date_time,size=i.file_size,sha256=hashlib.sha256(z.read(i)).hexdigest(),body=base64.b64encode(z.read(i)).decode()) for i in z.infolist()]))`,
        filename,
      ],
      { maxBuffer: 60 * 1024 * 1024 },
    );
    return JSON.parse(result.toString()) as {
      name: string;
      method: number;
      flag: number;
      date: number[];
      size: number;
      sha256: string;
      body: string;
    }[];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('deterministic STORE archive independently verifies with Python: unchanged frozen JSON, exact originals, safe paths, manifest hashes and headers', async (t) => {
  const f = await fixture(t),
    image = addImage(f, { metadata: { caption: '../unsafe/path — नमस्ते' } }),
    document = addDocument(f, {
      metadata: { originalName: '../../unsafe.pdf', title: 'Unicode résumé report' },
    });
  const saved = await f.save(),
    preview = await prepare(f, saved.copy.id, [image.selection, document.selection]);
  const response = await download(f, preview);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(
    response.headers.get('content-disposition'),
    `attachment; filename="${preview.filename}"`,
  );
  assert.equal(response.headers.get('content-length'), String(preview.byteLength));
  assert.equal(response.headers.get('x-content-sha256'), preview.contentSha256);
  assert.equal(response.headers.get('x-bundle-revision'), preview.revision);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.match(response.headers.get('content-security-policy')!, /sandbox/);
  assert.match(response.headers.get('x-robots-tag')!, /noindex/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(digest(response.bytes), preview.contentSha256);
  assert.equal(response.bytes.length, preview.byteLength);
  const entries = inspectWithPython(response.bytes);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['care-summary.json', 'manifest.json', ...preview.manifest.files.map((file) => file.path)],
  );
  for (const entry of entries) {
    assert.equal(entry.method, 0);
    assert.equal(entry.flag, 2048);
    assert.deepEqual(entry.date, [1980, 1, 1, 0, 0, 0]);
    assert.ok(!entry.name.includes('..'));
    assert.ok(!entry.name.includes('unsafe'));
    assert.ok(!entry.name.includes('\\'));
  }
  const original = await f.call(`${copiesPath()}/${saved.copy.id}/download`, f.admin);
  assert.deepEqual(Buffer.from(entries[0].body, 'base64'), original.bytes);
  assert.equal(entries[0].sha256, saved.copy.contentSha256);
  const manifestBytes = Buffer.from(entries[1].body, 'base64');
  assert.deepEqual(JSON.parse(manifestBytes.toString()), preview.manifest);
  assert.equal(digest(manifestBytes), preview.revision);
  assert.deepEqual(manifestBytes, Buffer.from(JSON.stringify(preview.manifest, null, 2) + '\n'));
  for (const file of preview.manifest.files) {
    const entry = entries.find((entry) => entry.name === file.path)!;
    const source = file.type === 'document' ? document : image;
    assert.deepEqual(Buffer.from(entry.body, 'base64'), source.bytes);
    assert.equal(entry.sha256, file.sha256);
    assert.equal(entry.size, file.byteLength);
    assert.equal(file.verification, 'saved-sha256');
    assert.equal(
      file.path,
      `attachments/${file.type}-${digest(`${file.type}:${file.id}`)}.${file.type === 'document' ? 'pdf' : 'png'}`,
    );
  }
  assert.equal(JSON.stringify(preview.manifest).includes(f.admin.user.id), false);
  assert.equal(JSON.stringify(preview.manifest).includes('https://invalid'), false);
  assert.deepEqual(
    (await prepare(f, saved.copy.id, [document.selection, image.selection])).selection,
    preview.selection,
  );
  assert.deepEqual(
    (await download(f, await prepare(f, saved.copy.id, [document.selection, image.selection])))
      .bytes,
    response.bytes,
  );
});

test('only own patients and clinical roles can access each route; selected files must belong to this frozen copy and patient', async (t) => {
  const f = await fixture(t),
    image = addImage(f),
    foreign = addDocument(f, { patientId: 'patient-2' }),
    saved = await f.save();
  const later = addDocument(f),
    preview = await prepare(f, saved.copy.id, [image.selection]);
  const patient = await f.login('patient'),
    doctor = await f.login('doctor'),
    reception = await f.login('reception'),
    other = await f.account('patient', { patientId: 'patient-2' });
  for (const [suffix, method, body] of [
    ['/attachments', 'GET', undefined],
    ['/preview', 'POST', { attachments: preview.selection }],
    ['/download', 'POST', { attachments: preview.selection, expectedRevision: preview.revision }],
  ] as const) {
    for (const user of [undefined, reception, other]) {
      const response = await f.call(`${bundlePath(saved.copy.id)}${suffix}`, user, method, body);
      assert.equal(response.status, user ? 403 : 401);
      assert.equal(response.headers.get('content-disposition'), null);
    }
    for (const user of [patient, doctor, f.admin])
      assert.equal(
        (await f.call(`${bundlePath(saved.copy.id)}${suffix}`, user, method, body)).status,
        200,
      );
    assert.equal(
      (await f.call(`${bundlePath(saved.copy.id, 'patient-2')}${suffix}`, f.admin, method, body))
        .status,
      404,
    );
  }
  for (const selection of [foreign.selection, later.selection, { type: 'image', id: 'unknown' }]) {
    const response = await f.call(`${bundlePath(saved.copy.id)}/preview`, f.admin, 'POST', {
      attachments: [selection],
    });
    assert.equal(response.status, 400);
    assert.equal(response.data.copy, undefined);
  }
  assert.deepEqual(
    (await download(f, preview, patient)).bytes,
    (await download(f, preview, doctor)).bytes,
  );
});

test('strict schemas reject zero, duplicate, excess and unknown selection or query fields; hash and pagination boundaries are explicit', async (t) => {
  const f = await fixture(t),
    image = addImage(f),
    saved = await f.save();
  const base = bundlePath(saved.copy.id),
    before = count(f.db, 'audit');
  for (const body of [
    {},
    { attachments: [] },
    { attachments: [image.selection, image.selection] },
    { attachments: [{ ...image.selection, url: '/etc/passwd' }] },
    { attachments: [{ type: 'other', id: image.value.id }] },
    { attachments: [{ type: 'image', id: '' }] },
    { attachments: [image.selection], patientId: 'patient-2' },
    { attachments: Array.from({ length: 21 }, (_, i) => ({ type: 'image', id: `${i}` })) },
  ])
    assert.equal((await f.call(`${base}/preview`, f.admin, 'POST', body)).status, 400);
  for (const query of ['?extra=x', '?page=0', '?page=1000001', '?pageSize=100', '?page=1&page=2'])
    assert.equal((await f.call(`${base}/attachments${query}`, f.admin)).status, 400);
  assert.equal(
    (await f.call(`${base}/preview?unknown=x`, f.admin, 'POST', { attachments: [image.selection] }))
      .status,
    400,
  );
  for (const expectedRevision of ['', 'ABC', 'A'.repeat(64)])
    assert.equal(
      (
        await f.call(`${base}/download`, f.admin, 'POST', {
          attachments: [image.selection],
          expectedRevision,
        })
      ).status,
      400,
    );
  assert.equal(count(f.db, 'audit'), before);
});

test('later shared and private changes, module pauses and account renames do not alter frozen bundle or rebuild live care records', async (t) => {
  const f = await fixture(t),
    image = addImage(f),
    saved = await f.save(),
    preview = await prepare(f, saved.copy.id, [image.selection]),
    original = await download(f, preview);
  const patient = get<Patient>(f.db, 'patients', patientId)!;
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify({ ...patient, name: 'Later name', phone: '0000000000' }), patientId);
  f.db
    .prepare("UPDATE users SET data=json_set(data,'$.name','Later saver name') WHERE id=?")
    .run(f.admin.user.id);
  const settings = JSON.parse(
    String(f.db.prepare("SELECT value FROM meta WHERE key='settings'").get()!.value),
  );
  settings.modules.images = false;
  f.db.prepare("UPDATE meta SET value=? WHERE key='settings'").run(JSON.stringify(settings));
  addDocument(f);
  const prepareSQL = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => {
    if (/\bFROM\s+(?:encounters|carePlans|checkIns|invoices|messages)\b/i.test(sql))
      throw new Error('Historical bundle must not rebuild live care');
    return prepareSQL(sql);
  }) as typeof f.db.prepare;
  try {
    const later = await prepare(f, saved.copy.id, preview.selection);
    assert.deepEqual(later, preview);
    assert.deepEqual((await download(f, later)).bytes, original.bytes);
  } finally {
    f.db.prepare = prepareSQL;
  }
});

test('legacy image attribution is not invented and changed legacy bytes require a new preview; PDFs require saved integrity metadata', async (t) => {
  const f = await fixture(t),
    image = addImage(f, { legacy: true }),
    saved = await f.save(),
    preview = await prepare(f, saved.copy.id, [image.selection]);
  const catalogue = await f.call(`${bundlePath(saved.copy.id)}/attachments`, f.admin);
  assert.equal(catalogue.data.items[0].recordedByteLength, null);
  assert.equal(catalogue.data.items[0].recordedSha256, null);
  assert.equal(catalogue.data.items[0].uploadedBy, null);
  assert.equal(preview.manifest.files[0].verification, 'computed-at-export');
  assert.equal(preview.manifest.files[0].uploadedBy, null);
  f.db.exec('DROP TRIGGER image_original_no_update');
  f.db
    .prepare('UPDATE images SET bytes=? WHERE id=?')
    .run(Buffer.concat([png, Buffer.from('different legacy original')]), image.value.id);
  const stale = await download(f, preview);
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get('content-disposition'), null);
  assert.equal(stale.headers.get('x-content-sha256'), null);
  const changed = await prepare(f, saved.copy.id, [image.selection]);
  assert.notEqual(changed.revision, preview.revision);
  assert.equal((await download(f, changed)).status, 200);
  const document = addDocument(f, { metadata: { sha256: undefined as unknown as string } }),
    second = await f.save();
  const result = await f.call(`${bundlePath(second.copy.id)}/preview`, f.admin, 'POST', {
    attachments: [document.selection],
  });
  assert.equal(result.status, 409);
});

test('missing, cross-patient, mismatched and malformed originals fail the entire selection without attachment headers or successful audit', async (t) => {
  for (const fault of ['missing', 'patient', 'mime', 'signature', 'hash', 'size', 'json']) {
    const f = await fixture(t),
      image = addImage(f),
      document = addDocument(f),
      saved = await f.save(),
      preview = await prepare(f, saved.copy.id, [image.selection, document.selection]);
    f.db.exec('DROP TRIGGER prevent_document_update; DROP TRIGGER prevent_document_delete');
    if (fault === 'missing')
      f.db.prepare('DELETE FROM documents WHERE id=?').run(document.value.id);
    if (fault === 'patient')
      f.db
        .prepare('UPDATE documents SET patientId=? WHERE id=?')
        .run('patient-2', document.value.id);
    if (fault === 'mime')
      f.db
        .prepare("UPDATE documents SET data=json_set(data,'$.mimeType','image/png') WHERE id=?")
        .run(document.value.id);
    if (fault === 'signature')
      f.db
        .prepare('UPDATE documents SET bytes=? WHERE id=?')
        .run(Buffer.alloc(document.bytes.length), document.value.id);
    if (fault === 'hash') {
      const bytes = Buffer.from(document.bytes);
      bytes[25] ^= 1;
      f.db.prepare('UPDATE documents SET bytes=? WHERE id=?').run(bytes, document.value.id);
    }
    if (fault === 'size')
      f.db
        .prepare('UPDATE documents SET bytes=? WHERE id=?')
        .run(Buffer.concat([Buffer.from('%PDF-1.4\n'), document.bytes]), document.value.id);
    if (fault === 'json')
      f.db.prepare('UPDATE documents SET data=? WHERE id=?').run('{bad', document.value.id);
    const before = count(f.db, 'audit'),
      response = await download(f, preview);
    assert.equal(response.status, 409, fault);
    assert.equal(response.headers.get('content-disposition'), null, fault);
    assert.equal(response.headers.get('x-bundle-revision'), null);
    assert.equal(count(f.db, 'audit'), before);
    assert.equal(response.data.manifest, undefined);
  }
});

test('per-file cap rejects before BLOB retrieval; whole ZIP cap includes manifest and directory overhead, never silently drops files', async (t) => {
  const f = await fixture(t),
    huge = Buffer.alloc(5 * 1024 * 1024 + 1, 32);
  huge.write('%PDF-1.4\n');
  huge.write('\n%%EOF\n', huge.length - 7);
  const document = addDocument(f, { bytes: huge }),
    saved = await f.save();
  const prepareSQL = f.db.prepare.bind(f.db);
  let blobReads = 0;
  f.db.prepare = ((sql: string) => {
    if (/SELECT data,bytes FROM documents/i.test(sql)) {
      blobReads++;
      throw new Error('Oversized BLOB must not be retrieved');
    }
    return prepareSQL(sql);
  }) as typeof f.db.prepare;
  try {
    const catalogue = await f.call(`${bundlePath(saved.copy.id)}/attachments`, f.admin);
    assert.equal(catalogue.data.items[0].availability, 'too-large');
    assert.equal(
      (
        await f.call(`${bundlePath(saved.copy.id)}/preview`, f.admin, 'POST', {
          attachments: [document.selection],
        })
      ).status,
      413,
    );
    assert.equal(blobReads, 0);
  } finally {
    f.db.prepare = prepareSQL;
  }
  const g = await fixture(t);
  const sizedPdf = (length: number) => {
    const bytes = Buffer.alloc(length, 32);
    bytes.write('%PDF-1.4\n');
    bytes.write('\n%%EOF\n', length - 7);
    return bytes;
  };
  const files = Array.from({ length: 5 }, () =>
    addDocument(g, { bytes: sizedPdf(5 * 1024 * 1024 - 10000) }),
  );
  const initial = await g.save();
  g.db.exec('DROP TRIGGER prevent_document_update');
  const max = 5 * 1024 * 1024,
    remaining = 25 * 1024 * 1024 - initial.copy.byteLength - 200 - 4 * max;
  for (let i = 0; i < files.length; i++) {
    const bytes = sizedPdf(i < 4 ? max : remaining),
      value = { ...files[i].value, sha256: digest(bytes), sizeBytes: bytes.length };
    g.db
      .prepare('UPDATE documents SET data=?,bytes=? WHERE id=?')
      .run(JSON.stringify(value), bytes, value.id);
  }
  const current = await g.save();
  assert.equal(current.copy.byteLength, initial.copy.byteLength);
  assert.ok(
    current.copy.byteLength + 4 * max + remaining < 25 * 1024 * 1024,
    'Payload fits; archive metadata must cause rejection',
  );
  const before = count(g.db, 'audit');
  const response = await g.call(`${bundlePath(current.copy.id)}/preview`, g.admin, 'POST', {
    attachments: files.map((file) => file.selection),
  });
  assert.equal(response.status, 413);
  assert.equal(count(g.db, 'audit'), before);
  assert.equal(response.data.selection, undefined);
  const subset = await prepare(
    g,
    current.copy.id,
    files.slice(0, 4).map((file) => file.selection),
  );
  assert.equal(subset.manifest.files.length, 4);
  assert.ok(subset.byteLength < 25 * 1024 * 1024);
});

test('paged catalogue reads only page-sized file metadata; all twenty selected files work without unrelated source or remote/path reads', async (t) => {
  const f = await fixture(t);
  const images = Array.from({ length: 63 }, (_, i) =>
    addImage(f, { id: `synthetic-image-${String(i).padStart(3, '0')}` }),
  );
  addImage(f, { patientId: 'patient-2' });
  const saved = await f.save();
  const original = f.db.prepare.bind(f.db),
    queries: string[] = [];
  f.db.prepare = ((sql: string) => {
    queries.push(sql);
    if (/SELECT (?:\*|data,bytes|bytes) FROM (?:images|documents)/i.test(sql))
      throw new Error('Catalogue must not retrieve original BLOBs or source JSON');
    return original(sql);
  }) as typeof f.db.prepare;
  try {
    const response = await f.call(
      `${bundlePath(saved.copy.id)}/attachments?page=3&pageSize=10`,
      f.admin,
    );
    assert.equal(response.status, 200);
    assert.equal(response.data.total, 63);
    assert.equal(response.data.page, 3);
    assert.equal(response.data.totalPages, 7);
    assert.deepEqual(
      response.data.items.map((item: { id: string }) => item.id),
      images.slice(20, 30).map((image) => image.value.id),
    );
    assert.equal(queries.filter((sql) => /length\(bytes\)/.test(sql)).length, 10);
    const clamped = await f.call(
      `${bundlePath(saved.copy.id)}/attachments?page=1000000&pageSize=25`,
      f.admin,
    );
    assert.equal(clamped.data.page, 3);
    assert.equal(clamped.data.items.length, 13);
  } finally {
    f.db.prepare = original;
  }
  const preview = await prepare(
    f,
    saved.copy.id,
    images.slice(0, 20).map((image) => image.selection),
  );
  assert.equal(preview.manifest.files.length, 20);
  assert.equal((await download(f, preview)).status, 200);
});

test('all three routes revalidate session, account, CSRF and MFA after middleware under the same database lock', async (t) => {
  for (const fault of [
    'revoked',
    'expired',
    'csrf',
    'inactive',
    'temporary',
    'role',
    'mfa',
  ] as const) {
    for (const operation of ['attachments', 'preview', 'download']) {
      const f = await fixture(t),
        image = addImage(f),
        saved = await f.save(),
        preview = await prepare(f, saved.copy.id, [image.selection]);
      const external = openDatabase(f.databasePath),
        original = f.db.exec.bind(f.db);
      let injected = false;
      f.db.exec = ((sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true;
          if (fault === 'revoked')
            external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
          if (fault === 'expired')
            external.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(f.admin.user.id);
          if (fault === 'csrf')
            external
              .prepare('UPDATE sessions SET csrfToken=? WHERE userId=?')
              .run('changed-source-token', f.admin.user.id);
          if (fault === 'inactive')
            external
              .prepare("UPDATE users SET data=json_set(data,'$.active',json('false')) WHERE id=?")
              .run(f.admin.user.id);
          if (fault === 'temporary')
            external
              .prepare(
                "UPDATE users SET data=json_set(data,'$.mustChangePassword',json('true')) WHERE id=?",
              )
              .run(f.admin.user.id);
          if (fault === 'role')
            external
              .prepare(
                "UPDATE users SET role='receptionist',data=json_set(data,'$.role','receptionist') WHERE id=?",
              )
              .run(f.admin.user.id);
          if (fault === 'mfa')
            external
              .prepare(
                'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES(?,?,?,?,?)',
              )
              .run(
                f.admin.user.id,
                randomUUID(),
                'Synthetic unused ciphertext',
                new Date().toISOString(),
                -1,
              );
        }
        return original(sql);
      }) as typeof f.db.exec;
      try {
        const before = count(f.db, 'audit');
        const response = await f.call(
          `${bundlePath(saved.copy.id)}/${operation}`,
          f.admin,
          operation === 'attachments' ? 'GET' : 'POST',
          operation === 'attachments'
            ? undefined
            : {
                attachments: preview.selection,
                ...(operation === 'download' ? { expectedRevision: preview.revision } : {}),
              },
        );
        assert.equal(injected, true);
        assert.equal(
          response.status,
          ['temporary', 'role'].includes(fault) ? 403 : 401,
          `${fault}/${operation}`,
        );
        assert.equal(response.headers.get('content-disposition'), null);
        assert.equal(response.data.copy, undefined);
        assert.equal(count(f.db, 'audit'), before);
      } finally {
        f.db.exec = original;
        external.close();
      }
    }
  }
});

test('current patient ownership is checked under lock on catalogue, preview and download', async (t) => {
  for (const operation of ['attachments', 'preview', 'download']) {
    const f = await fixture(t),
      image = addImage(f),
      saved = await f.save(),
      preview = await prepare(f, saved.copy.id, [image.selection]),
      patient = await f.login('patient');
    const external = openDatabase(f.databasePath),
      original = f.db.exec.bind(f.db);
    let injected = false;
    f.db.exec = ((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !injected) {
        injected = true;
        external
          .prepare("UPDATE users SET data=json_set(data,'$.patientId','patient-2') WHERE id=?")
          .run(patient.user.id);
      }
      return original(sql);
    }) as typeof f.db.exec;
    try {
      const response = await f.call(
        `${bundlePath(saved.copy.id)}/${operation}`,
        patient,
        operation === 'attachments' ? 'GET' : 'POST',
        operation === 'attachments'
          ? undefined
          : {
              attachments: preview.selection,
              ...(operation === 'download' ? { expectedRevision: preview.revision } : {}),
            },
      );
      assert.equal(injected, true);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('content-disposition'), null);
    } finally {
      f.db.exec = original;
      external.close();
    }
  }
});

test('failed audit rolls back catalogue, preview and download without file headers or source changes', async (t) => {
  const f = await fixture(t),
    image = addImage(f),
    saved = await f.save(),
    preview = await prepare(f, saved.copy.id, [image.selection]);
  const tables = [
    'images',
    'documents',
    'careSummaryCopies',
    'careSummaryCopyCommands',
    'activity',
    'audit',
  ];
  const counts = () => tables.map((table) => count(f.db, table)),
    before = counts();
  f.db
    .exec(`CREATE TRIGGER bundle_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') LIKE '%saved care summary%'
    BEGIN SELECT RAISE(ABORT,'Synthetic bundle audit failure'); END;`);
  for (const operation of ['attachments', 'preview', 'download']) {
    const response = await f.call(
      `${bundlePath(saved.copy.id)}/${operation}`,
      f.admin,
      operation === 'attachments' ? 'GET' : 'POST',
      operation === 'attachments'
        ? undefined
        : {
            attachments: preview.selection,
            ...(operation === 'download' ? { expectedRevision: preview.revision } : {}),
          },
    );
    assert.equal(response.status, 500, operation);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.equal(response.headers.get('x-content-sha256'), null);
    assert.equal(response.data.copy, undefined);
    assert.equal(response.data.manifest, undefined);
    assert.deepEqual(counts(), before);
  }
  f.db.exec('DROP TRIGGER bundle_audit_failure');
  assert.equal((await download(f, preview)).status, 200);
});

test('saved summary integrity and patient mismatch are checked before exposing an archive', async (t) => {
  for (const fault of ['hash', 'summary-patient', 'duplicate', 'foreign-reference']) {
    const f = await fixture(t),
      image = addImage(f),
      saved = await f.save();
    const row = f.db
      .prepare('SELECT data,body FROM careSummaryCopies WHERE id=?')
      .get(saved.copy.id)!;
    const summary = JSON.parse(Buffer.from(row.body as Uint8Array).toString()),
      metadata = JSON.parse(String(row.data));
    if (fault === 'hash') metadata.contentSha256 = '0'.repeat(64);
    if (fault === 'summary-patient') summary.patient.id = 'patient-2';
    if (fault === 'duplicate') summary.images.push(summary.images[0]);
    if (fault === 'foreign-reference') summary.images[0].patientId = 'patient-2';
    const body = Buffer.from(JSON.stringify(summary, null, 2) + '\n');
    if (fault !== 'hash') {
      metadata.contentSha256 = digest(body);
      metadata.byteLength = body.length;
    }
    f.db.exec('DROP TRIGGER careSummaryCopies_immutable_update');
    f.db
      .prepare('UPDATE careSummaryCopies SET data=?,body=? WHERE id=?')
      .run(JSON.stringify(metadata), body, saved.copy.id);
    for (const operation of ['attachments', 'preview']) {
      const response = await f.call(
        `${bundlePath(saved.copy.id)}/${operation}`,
        f.admin,
        operation === 'attachments' ? 'GET' : 'POST',
        operation === 'attachments' ? undefined : { attachments: [image.selection] },
      );
      assert.equal(response.status, 409, `${fault}/${operation}`);
      assert.equal(response.headers.get('content-disposition'), null);
    }
  }
});

test('coherent bundle read holds its lock through originals and audit, and restart preserves exact ZIP bytes without new storage', async (t) => {
  const f = await fixture(t),
    image = addImage(f),
    document = addDocument(f),
    saved = await f.save(),
    preview = await prepare(f, saved.copy.id, [image.selection, document.selection]);
  const external = openDatabase(f.databasePath),
    prepareSQL = f.db.prepare.bind(f.db);
  external.exec('PRAGMA busy_timeout=0');
  let checked = false;
  f.db.prepare = ((sql: string) => {
    if (/SELECT data,bytes FROM/.test(sql) && !checked) {
      checked = true;
      assert.throws(
        () =>
          external
            .prepare(
              "UPDATE patients SET data=json_set(data,'$.name','Concurrent name') WHERE id=?",
            )
            .run(patientId),
        /locked/,
      );
    }
    return prepareSQL(sql);
  }) as typeof f.db.prepare;
  let original: Buffer;
  try {
    const response = await download(f, preview);
    assert.equal(response.status, 200);
    original = response.bytes;
    assert.equal(checked, true);
  } finally {
    f.db.prepare = prepareSQL;
    external.close();
  }
  const path = f.databasePath;
  await f.close();
  const restarted = await fixture(t, path),
    later = await prepare(restarted, saved.copy.id, [document.selection, image.selection]);
  assert.deepEqual(later, preview);
  assert.deepEqual((await download(restarted, later)).bytes, original!);
  assert.equal(count(restarted.db, 'careSummaryCopies'), 1);
  assert.equal(count(restarted.db, 'careSummaryCopyCommands'), 1);
});

test('real API image/PDF uploads export unchanged originals without interpreting annotation content or fetching saved URLs', async (t) => {
  const f = await fixture(t),
    pdf = syntheticPdf('Uploaded PDF round trip');
  const image = await f.post('/images', {
    patientId,
    caption: 'Original upload',
    category: 'clinical',
    consent: true,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  });
  const document = await f.post('/documents', {
    patientId,
    title: 'Original PDF',
    originalName: 'synthetic.pdf',
    consent: true,
    dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`,
  });
  const saved = await f.save(),
    preview = await prepare(f, saved.copy.id, [
      { type: 'image', id: image.id },
      { type: 'document', id: document.id },
    ]);
  const entries = inspectWithPython((await download(f, preview)).bytes);
  for (const file of preview.manifest.files)
    assert.deepEqual(
      Buffer.from(entries.find((entry) => entry.name === file.path)!.body, 'base64'),
      file.type === 'image' ? png : pdf,
    );
  assert.equal(
    preview.manifest.files.every((file) => file.verification === 'saved-sha256'),
    true,
  );
});
