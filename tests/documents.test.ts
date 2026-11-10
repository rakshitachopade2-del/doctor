import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { syntheticPdf } from './fixtures/report.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server;
let base: string;
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  patient: Client = {},
  reception: Client = {},
  other: Client = {};
async function request(path: string, client: Client = {}, method = 'GET', body?: unknown) {
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
  return response;
}
async function call(path: string, client: Client = {}, method = 'GET', body?: unknown) {
  const response = await request(path, client, method, body);
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
  return { status: response.status, data };
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
  ] as const) {
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
  assert.equal(
    (
      await call('/auth/register', other, 'POST', {
        name: 'Separate Report Patient',
        email: 'document-other@example.test',
        password: 'OtherReport2026!',
        phone: '9000000011',
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

const pdf = syntheticPdf();
const body = {
  title: 'Synthetic laboratory report',
  originalName: 'synthetic-report.pdf',
  dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`,
  consent: true,
};
let documentId: string;
test('report uploads preserve exact private bytes, patient scope, and authenticated provenance', async () => {
  const created = await call('/documents', patient, 'POST', body);
  assert.equal(created.status, 201);
  documentId = created.data.id;
  assert.equal(created.data.patientId, 'patient-ananya');
  assert.equal(created.data.createdById, 'user-patient');
  assert.equal(created.data.createdByRole, 'patient');
  assert.equal(created.data.sha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal(created.data.sizeBytes, pdf.length);
  const listed = await call('/documents', patient);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].id, documentId);
  assert.ok(!('bytes' in listed.data[0]));
  const downloaded = await request(`/documents/${documentId}/file`, doctor);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);
  assert.equal(downloaded.headers.get('content-type'), 'application/pdf');
  assert.match(
    downloaded.headers.get('content-disposition')!,
    /^attachment; filename="clinic-report-/,
  );
  assert.match(downloaded.headers.get('content-security-policy')!, /sandbox/);
  assert.equal(downloaded.headers.get('cache-control'), 'no-store');
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
});
test('anonymous, reception and another patient cannot list or download a private report', async () => {
  assert.equal((await call(`/documents?patientId=patient-ananya`)).status, 401);
  assert.equal((await call(`/documents?patientId=patient-ananya`, reception)).status, 403);
  assert.equal((await call(`/documents?patientId=patient-ananya`, other)).status, 403);
  assert.deepEqual((await call('/documents', other)).data, []);
  for (const [client, expected] of [
    [{}, 401],
    [reception, 403],
    [other, 403],
  ] as const)
    assert.equal((await request(`/documents/${documentId}/file`, client)).status, expected);
  assert.equal(
    (await call('/documents', patient, 'POST', { ...body, patientId: 'patient-2' })).status,
    403,
  );
  assert.equal(
    (await call('/documents', reception, 'POST', { ...body, patientId: 'patient-ananya' })).status,
    403,
  );
});
test('report upload validates agreement, content, filenames, and rejects forged authorship', async () => {
  for (const overrides of [
    { consent: false },
    { consent: undefined },
    { title: '' },
    { originalName: '../report.pdf' },
    { originalName: 'report.pdf\r\nInjected: header' },
    { originalName: 'report.html' },
    { createdByRole: 'doctor' },
    { dataUrl: 'data:text/html;base64,PGgxPkhlbGxvPC9oMT4=' },
    {
      dataUrl: `data:application/pdf;base64,${Buffer.from('<html>Not a PDF</html>').toString('base64')}`,
    },
    {
      dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\ntruncated').toString('base64')}`,
    },
    { dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}=` },
    {
      dataUrl: `data:application/pdf;base64,${Buffer.from(pdf.map((byte) => byte | 0x80)).toString('base64')}`,
    },
  ])
    assert.equal(
      (await call('/documents', patient, 'POST', { ...body, ...overrides })).status,
      400,
    );
});
test('oversized PDFs are rejected without writing a document', async () => {
  const before = app.locals.db.prepare('SELECT count(*) AS n FROM documents').get().n;
  const huge = Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.alloc(5 * 1024 * 1024, 32),
    Buffer.from('\n%%EOF'),
  ]);
  assert.equal(
    (
      await call('/documents', patient, 'POST', {
        ...body,
        dataUrl: `data:application/pdf;base64,${huge.toString('base64')}`,
      })
    ).status,
    413,
  );
  assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM documents').get().n, before);
});
test('report originals are immutable and upload/download events are audited without contents', async () => {
  assert.throws(
    () => app.locals.db.prepare('UPDATE documents SET data=? WHERE id=?').run('{}', documentId),
    /append-only/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM documents WHERE id=?').run(documentId),
    /append-only/,
  );
  const events = app.locals.db
    .prepare("SELECT data FROM audit WHERE json_extract(data,'$.entityId')=?")
    .all(documentId)
    .map((row: { data: string }) => JSON.parse(row.data));
  assert.ok(
    events.some((event: { action: string }) => event.action === 'uploaded private report document'),
  );
  assert.ok(
    events.some(
      (event: { action: string }) => event.action === 'downloaded private report document',
    ),
  );
  assert.ok(!JSON.stringify(events).includes(body.title));
  assert.ok(!JSON.stringify(events).includes(pdf.toString('base64')));
});
