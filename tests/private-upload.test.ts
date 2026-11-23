import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { DocumentUploadCommand, ImageUploadCommand } from '../shared/private-upload.ts';
import type { User } from '../shared/types.ts';
import { get, openDatabase, type DB } from '../server/db.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
} from './fixtures/care-api.ts';

const imagePath = '/images/upload',
  pdfPath = '/documents/upload',
  patientId = 'patient-ananya';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=',
  'base64',
);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
function encoded(bytes: Buffer, mime: string) {
  return {
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
function image(): ImageUploadCommand {
  return {
    patientId,
    requestId: randomUUID(),
    ...encoded(png, 'image/png'),
    consent: true,
    category: 'clinical',
    caption: 'Synthetic image',
  };
}
function document(): DocumentUploadCommand {
  return {
    patientId,
    requestId: randomUUID(),
    ...encoded(pdf, 'application/pdf'),
    consent: true,
    title: 'Synthetic report',
    originalName: 'original.pdf',
  };
}
function legacy({ requestId, sha256, ...input }: ImageUploadCommand | DocumentUploadCommand) {
  return input;
}
function setImageModule(db: DB, enabled: boolean) {
  db.prepare(
    "UPDATE meta SET value=json_set(value,'$.modules.images',json(?)) WHERE key='settings'",
  ).run(JSON.stringify(enabled));
}
function counts(db: DB) {
  return Object.fromEntries(
    ['images', 'documents', 'privateUploadCommands', 'activity', 'audit'].map((table) => [
      table,
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),
    ]),
  );
}

test('patient and clinician uploads return exact retained provenance and accessible original bytes, and exact replay leaves one audit', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    doctor = await f.login('doctor'),
    reception = await f.login('reception');
  for (const [kind, path, table, input, bytes, user] of [
    ['image', imagePath, 'images', image(), png, patient],
    ['document', pdfPath, 'documents', document(), pdf, doctor],
  ] as const) {
    const before = counts(f.db);
    const submitted =
      'caption' in input
        ? { ...input, caption: ' ' + input.caption + ' ' }
        : {
            ...input,
            title: ' ' + input.title + ' ',
            originalName: ' ' + input.originalName + ' ',
          };
    const initial = await f.call(path, user, {
      ...submitted,
      requestId: input.requestId.toUpperCase(),
    });
    assert.equal(initial.status, 201, JSON.stringify(initial.data));
    const { receipt } = initial.data,
      file = receipt.file;
    const mimeType = kind === 'image' ? 'image/png' : 'application/pdf';
    const details =
      'caption' in input
        ? { caption: input.caption, category: input.category }
        : { title: input.title, originalName: input.originalName };
    assert.match(file.id, /^[a-f0-9-]{36}$/);
    assert.equal(new Date(file.createdAt).toISOString(), file.createdAt);
    assert.deepEqual(receipt, {
      requestId: input.requestId,
      patientId,
      actorId: user.user.id,
      kind,
      file: {
        id: file.id,
        patientId,
        ...details,
        mimeType,
        sha256: input.sha256,
        sizeBytes: bytes.length,
        consent: true,
        createdAt: file.createdAt,
        createdById: user.user.id,
        createdByName: user.user.name,
        createdByRole: user.user.role,
        url: `/api/${table}/${file.id}/file`,
      },
    });
    const retry = await f.call(path, user, Object.fromEntries(Object.entries(input).reverse()));
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.data, initial.data);
    assert.deepEqual(counts(f.db), {
      ...before,
      [table]: before[table] + 1,
      privateUploadCommands: before.privateUploadCommands + 1,
      audit: before.audit + 1,
    });
    const download = (cookie?: string) =>
      fetch(new URL(file.url, f.base), { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal((await download()).status, 401);
    assert.equal((await download(reception.cookie)).status, 403);
    for (const who of [patient, doctor]) {
      const result = await download(who.cookie);
      assert.equal(result.status, 200);
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
      assert.match(result.headers.get('content-type')!, new RegExp(mimeType));
      if (kind === 'document')
        assert.match(result.headers.get('content-disposition')!, /^attachment;/);
    }
    for (const [read, who] of [
      ['/patients/' + patientId, doctor],
      ['/documents', patient],
      ['/patients/' + patientId + '/care-summary', patient],
      ['/activity', patient],
    ] as const) {
      const projection = await f.call(read, who);
      assert.equal(projection.status, 200, read);
      for (const secret of [input.requestId, input.dataUrl, 'payloadHash', 'privateUploadCommands'])
        assert.equal(JSON.stringify(projection.data).includes(secret), false, read);
    }
    const again = await f.call(path, user, { ...input, requestId: randomUUID() });
    assert.equal(again.status, 201);
    assert.notEqual(again.data.receipt.file.id, file.id);
    assert.equal(again.data.receipt.file.sha256, file.sha256);
  }
});

test('both retryable upload routes enforce consent, scope, strict fields, exact file digest, size and existing file rules', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient');
  const before = counts(f.db);
  for (const [path, input] of [
    [imagePath, image()],
    [pdfPath, document()],
  ] as const) {
    for (const patch of [
      { consent: false },
      { extra: true },
      { patientId: undefined },
      { requestId: 'bad' },
      { sha256: input.sha256.toUpperCase() },
      { sha256: '0'.repeat(64) },
      { dataUrl: 'data:text/plain;base64,eA==' },
    ]) {
      const res = await f.call(path, patient, { ...input, ...patch });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.equal(res.data.code, undefined);
    }
    assert.equal((await f.call(path + '?extra=1', patient, input)).status, 400);
    assert.equal((await f.call(path, patient, { ...input, patientId: 'patient-2' })).status, 403);
    assert.equal(
      (await f.call(path, patient, { ...input, patientId: 'patient-2', dataUrl: 'invalid file' }))
        .status,
      403,
    );
    assert.equal((await f.call(path, undefined, input)).status, 401);
  }
  for (const patch of [
    { title: '' },
    { originalName: 'not.pdf/ok.pdf' },
    { originalName: 'original.jpg' },
    encoded(Buffer.from('%PDF-1.7\ntruncated'), 'application/pdf'),
  ])
    assert.equal((await f.call(pdfPath, patient, { ...document(), ...patch })).status, 400);
  for (const patch of [
    { category: 'unknown' },
    { caption: '' },
    encoded(png, 'image/jpeg'),
    encoded(Buffer.from('bad'), 'image/png'),
  ])
    assert.equal((await f.call(imagePath, patient, { ...image(), ...patch })).status, 400);
  for (const [path, input, mime] of [
    [imagePath, image(), 'image/png'],
    [pdfPath, document(), 'application/pdf'],
  ] as const) {
    const res = await f.call(path, patient, {
      ...input,
      ...encoded(Buffer.alloc(5 * 1024 * 1024 + 1), mime),
    });
    assert.equal(res.status, 413);
  }
  assert.deepEqual(counts(f.db), before);
  // Existing plain endpoints still accept omission of a patient's own ID. The legacy
  // image parser strips unknown fields, while the legacy document parser rejects them.
  const legacyImage = await f.call('/images', patient, {
    ...legacy(image()),
    patientId: undefined,
    extra: true,
  });
  const legacyDoc = await f.call('/documents', patient, {
    ...legacy(document()),
    patientId: undefined,
  });
  assert.equal(legacyImage.status, 201);
  assert.equal(legacyDoc.status, 201);
  assert.equal(legacyImage.data.caption, 'Synthetic image');
  assert.equal(legacyDoc.data.originalName, 'original.pdf');
  for (const plain of [legacyImage, legacyDoc]) {
    assert.equal(plain.data.receipt, undefined);
    assert.equal(plain.data.createdById, patient.user.id);
  }
  assert.equal(
    (await f.call('/documents', patient, { ...legacy(document()), extra: true })).status,
    400,
  );
  assert.equal(counts(f.db).privateUploadCommands, before.privateUploadCommands);
  // Use the same signature and size boundaries as the existing storage adapters.
  const limit = 5 * 1024 * 1024;
  const jpeg = Buffer.alloc(limit);
  jpeg.set([0xff, 0xd8, 0xff]);
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const largePdf = Buffer.alloc(limit, 32);
  largePdf.write('%PDF-1.4\n');
  largePdf.write('%%EOF', limit - 5);
  for (const [path, fields, bytes, mime] of [
    [imagePath, image(), jpeg, 'image/jpeg'],
    [imagePath, image(), webp, 'image/webp'],
    [pdfPath, document(), largePdf, 'application/pdf'],
  ] as const) {
    const res = await f.call(path, patient, { ...fields, ...encoded(bytes, mime) });
    assert.equal(res.status, 201);
    assert.equal(res.data.receipt.file.mimeType, mime);
    assert.equal(res.data.receipt.file.sizeBytes, bytes.length);
  }
});

test('retry identity binds uploader, patient, operation, actual file bytes and normalized file metadata for successes and rejections', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    admin = await f.login('admin');
  for (const enabled of [true, false]) {
    setImageModule(f.db, enabled);
    const upload = image(),
      initial = await f.call(imagePath, doctor, upload);
    assert.equal(initial.status, enabled ? 201 : 403);
    const before = counts(f.db);
    for (const [path, who, body] of [
      [imagePath, admin, upload],
      [imagePath, doctor, { ...upload, patientId: 'patient-2' }],
      [pdfPath, doctor, { ...document(), requestId: upload.requestId }],
      [imagePath, doctor, { ...upload, caption: 'Different' }],
      [imagePath, doctor, { ...upload, category: 'report' }],
      [
        imagePath,
        doctor,
        { ...upload, ...encoded(Buffer.concat([png, Buffer.from('x')]), 'image/png') },
      ],
    ] as const) {
      const res = await f.call(path, who, body);
      assert.equal(res.status, 409);
      assert.equal(res.data.code, undefined);
      assert.equal(res.data.receipt, undefined);
    }
    assert.deepEqual(counts(f.db), before);
  }
  const upload = document(),
    initial = await f.call(pdfPath, doctor, upload);
  assert.equal(initial.status, 201);
  const before = counts(f.db);
  for (const patch of [
    { title: 'Different' },
    { originalName: 'different.pdf' },
    { patientId: 'patient-2' },
    encoded(Buffer.from('%PDF-1.4\nother\n%%EOF'), 'application/pdf'),
  ]) {
    assert.equal((await f.call(pdfPath, doctor, { ...upload, ...patch })).status, 409);
  }
  assert.equal((await f.call(pdfPath, admin, upload)).status, 409);
  assert.equal(
    (await f.call(imagePath, doctor, { ...image(), requestId: upload.requestId })).status,
    409,
  );
  assert.deepEqual(counts(f.db), before);
});

test('image pauses retain original successes and durable rejections while new PDF uploads and existing file access remain available', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    db = openDatabase(f.databasePath);
  t.after(() => db.close());
  const first = image(),
    success = await f.call(imagePath, patient, first);
  assert.equal(success.status, 201);
  const rejected = image(),
    before = counts(f.db);
  const denied = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => setImageModule(db, false),
    () => f.call(imagePath, patient, rejected),
  );
  assert.equal(denied.status, 403);
  const { dataUrl, ...expected } = rejected;
  assert.deepEqual(denied.data, {
    ...expected,
    actorId: patient.user.id,
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: png.length,
    code: 'UPLOAD_NOT_SAVED',
    message: 'This module is currently disabled by the clinic.',
  });
  assert.deepEqual(counts(f.db), {
    ...before,
    privateUploadCommands: before.privateUploadCommands + 1,
  });
  const retry = await f.call(imagePath, patient, first);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, success.data);
  const plain = await f.call('/images', patient, legacy(image()));
  assert.equal(plain.status, 403);
  assert.equal(plain.data.code, undefined);
  assert.equal((await f.call(pdfPath, patient, document())).status, 201);
  assert.equal((await f.call('/documents', patient, legacy(document()))).status, 201);
  const download = await fetch(new URL(success.data.receipt.file.url, f.base), {
    headers: { Cookie: patient.cookie },
  });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  setImageModule(db, true);
  const rechecked = await f.call(imagePath, patient, rejected);
  assert.equal(rechecked.status, 403);
  assert.deepEqual(rechecked.data, denied.data);
  assert.equal(
    (await f.call(imagePath, patient, { ...rejected, requestId: randomUUID() })).status,
    201,
  );
  const pausedLegacy = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => setImageModule(db, false),
    () => f.call('/images', patient, legacy(image())),
  );
  assert.equal(pausedLegacy.status, 403);
  assert.equal(pausedLegacy.data.code, undefined);
});

test('failed file, audit, receipt and rejection inserts roll back all upload paths and preserve exact retry', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient');
  for (const [route, table, input, retryable] of [
    [imagePath, 'images', image(), true],
    [pdfPath, 'documents', document(), true],
    ['/images', 'images', legacy(image()), false],
    ['/documents', 'documents', legacy(document()), false],
  ] as const) {
    const before = counts(f.db);
    for (const target of [table, 'audit', ...(retryable ? ['privateUploadCommands'] : [])]) {
      f.db.exec(
        `CREATE TRIGGER synthetic_upload_failure BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'Synthetic upload failure'); END;`,
      );
      try {
        const res = await f.call(route, patient, input);
        assert.equal(res.status, 500);
        assert.equal(res.data.code, undefined);
        assert.equal(res.data.receipt, undefined);
        assert.deepEqual(counts(f.db), before);
      } finally {
        f.db.exec('DROP TRIGGER synthetic_upload_failure');
      }
    }
    assert.equal((await f.call(route, patient, input)).status, 201);
  }
  const input = image(),
    before = counts(f.db);
  setImageModule(f.db, false);
  f.db.exec(
    "CREATE TRIGGER synthetic_rejection_failure BEFORE INSERT ON privateUploadCommands WHEN NEW.rejection IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic rejection failure'); END;",
  );
  const failed = await f.call(imagePath, patient, input);
  assert.equal(failed.status, 500);
  assert.equal(failed.data.code, undefined);
  assert.deepEqual(counts(f.db), before);
  f.db.exec('DROP TRIGGER synthetic_rejection_failure');
  setImageModule(f.db, true);
  assert.equal((await f.call(imagePath, patient, input)).status, 201);
});

test('independent process writers each retain one image or PDF and immutable evidence survives restart without copying the original bytes', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor');
  const originals = [];
  for (const [path, table, input] of [
    [imagePath, 'images', image()],
    [pdfPath, 'documents', document()],
  ] as const) {
    const before = counts(f.db);
    const results = await simultaneousCareRequests(f, path, doctor, input);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
    assert.deepEqual(results[0].data, results[1].data);
    assert.deepEqual(counts(f.db), {
      ...before,
      [table]: before[table] + 1,
      audit: before.audit + 1,
      privateUploadCommands: before.privateUploadCommands + 1,
    });
    originals.push({ path, input, receipt: results[0].data });
    const row = f.db
      .prepare('SELECT * FROM privateUploadCommands WHERE requestId=?')
      .get(input.requestId)!;
    assert.equal(row.imageId ?? row.documentId, results[0].data.receipt.file.id);
    assert.equal(row.rejection, null);
    assert.match(String(row.payloadHash), /^[a-f0-9]{64}$/);
    assert.ok(
      Object.values(row).every(
        (value) => value === null || (typeof value === 'string' && value.length <= 64),
      ),
    );
  }
  const denied = image();
  setImageModule(f.db, false);
  const denial = await f.call(imagePath, doctor, denied);
  assert.equal(denial.status, 403);
  assert.throws(() => f.db.exec('UPDATE privateUploadCommands SET rowid=rowid'), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM privateUploadCommands'), /immutable/);
  await f.close();
  const restored = await careApiFixture(t, f.databasePath);
  changeUser(restored.db, get<User>(restored.db, 'users', doctor.user.id)!, {
    name: 'Renamed uploader',
  });
  const before = counts(restored.db);
  for (const { path, input, receipt } of originals) {
    const replay = await restored.call(path, doctor, input);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, receipt);
    const download = await fetch(new URL(receipt.receipt.file.url, restored.base), {
      headers: { Cookie: doctor.cookie },
    });
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), path === imagePath ? png : pdf);
  }
  setImageModule(restored.db, true);
  const replay = await restored.call(imagePath, doctor, denied);
  assert.equal(replay.status, 403);
  assert.deepEqual(replay.data, denial.data);
  assert.deepEqual(counts(restored.db), { ...before, audit: before.audit + 2 });
  await restored.close();
});

test('both upload writers, both legacy adapters and outcome replays check current session, account, MFA and patient ownership under the write lock', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const user = get<User>(other, 'users', patient.user.id)!;
  const session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const first = image(),
    savedPDF = document(),
    denied = image();
  assert.equal((await f.call(imagePath, patient, first)).status, 201);
  assert.equal((await f.call(pdfPath, patient, savedPDF)).status, 201);
  setImageModule(other, false);
  assert.equal((await f.call(imagePath, patient, denied)).data.code, 'UPLOAD_NOT_SAVED');
  setImageModule(other, true);
  const before = counts(f.db);
  const changes: [string, number, () => unknown][] = [
    ['logout', 401, () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)],
    [
      'expiry',
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id),
    ],
    [
      'CSRF',
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='different' WHERE userId=?").run(user.id),
    ],
    [
      'MFA',
      401,
      () =>
        other
          .prepare(
            'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
          )
          .run(user.id, randomUUID(), 'synthetic', new Date().toISOString(), -1),
    ],
    ['suspension', 401, () => changeUser(other, user, { active: false })],
    ['password', 403, () => changeUser(other, user, { mustChangePassword: true })],
    [
      'reception',
      403,
      () => changeUser(other, user, { role: 'receptionist', patientId: undefined }),
    ],
    ['another patient', 403, () => changeUser(other, user, { patientId: 'patient-2' })],
  ];
  for (const [path, input] of [
    [imagePath, image()],
    [imagePath, first],
    [pdfPath, document()],
    [pdfPath, savedPDF],
    [imagePath, denied],
    ['/images', { ...legacy(image()), patientId: undefined }],
    ['/documents', { ...legacy(document()), patientId: undefined }],
  ] as const) {
    for (const [label, status, change] of changes) {
      const res = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', change, () =>
        f.call(path, patient, input),
      );
      assert.equal(res.status, status, path + ' ' + label);
      assert.equal(res.data.receipt, undefined);
      assert.equal(res.data.code, undefined);
      assert.deepEqual(counts(f.db), before);
      changeUser(other, user, {});
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      const columns = Object.keys(session);
      other
        .prepare(
          `INSERT INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        )
        .run(...Object.values(session));
    }
  }
  const created = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => changeUser(other, user, { name: 'Current uploader' }),
    () => f.call(imagePath, patient, image()),
  );
  assert.equal(created.status, 201);
  assert.equal(created.data.receipt.file.createdByName, 'Current uploader');
});
