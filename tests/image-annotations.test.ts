import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createUser, openDatabase, seedDemo } from '../server/db.ts';
import { publishedImageAnnotationsForPatient } from '../server/image-annotations.ts';
import type { ClinicalImage } from '../shared/types.ts';
import type {
  AnnotationMarker,
  ImageAnnotationHistory,
  ImageAnnotationVersion,
} from '../shared/image-annotations.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server, base: string;
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  nextDoctor: Client = {},
  admin: Client = {},
  patient: Client = {},
  other: Client = {},
  reception: Client = {},
  unlinked: Client = {};
const encodedImage =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nkYAAAAASUVORK5CYII=';
const originalBytes = Buffer.from(encodedImage, 'base64');
const imageHash = createHash('sha256').update(originalBytes).digest('hex');
async function call(
  path: string,
  client: Client = {},
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
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  if (data?.csrfToken) client.csrf = data.csrfToken;
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
async function upload(
  client = patient,
  overrides: Record<string, unknown> = {},
): Promise<ClinicalImage> {
  const result = await call('/images', client, 'POST', {
    patientId: 'patient-ananya',
    caption: 'Synthetic annotation image',
    category: 'clinical',
    consent: true,
    dataUrl: `data:image/png;base64,${encodedImage}`,
    ...overrides,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
function marker(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type: 'rectangle',
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
    color: 'red',
    label: 'Clinician-marked region',
    ...overrides,
  };
}
async function history(image: ClinicalImage, client = doctor): Promise<ImageAnnotationHistory> {
  const result = await call(`/images/${image.id}/annotations`, client);
  assert.equal(result.status, 200);
  return result.data;
}
async function save(
  image: ClinicalImage,
  overrides: Record<string, unknown> = {},
  client = doctor,
) {
  const current = await history(image, doctor);
  return call(`/images/${image.id}/annotations`, client, 'POST', {
    expectedRevision: current.revision,
    note: 'Clinician note for this marked image.',
    markers: [marker()],
    ...overrides,
  });
}
async function publish(
  image: ClinicalImage,
  versionId: string,
  overrides: Record<string, unknown> = {},
  client = doctor,
) {
  const current = await history(image, doctor);
  return call(`/images/${image.id}/annotations/${versionId}/publish`, client, 'POST', {
    expectedRevision: current.revision,
    patientSharingConfirmed: true,
    ...overrides,
  });
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'annotation-unlinked-admin',
      name: 'Operations administrator',
      email: 'annotation-unlinked@example.test',
      role: 'admin',
    },
    'AnnotationAdmin2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'annotation-next-doctor',
      name: 'Dr. Arjun Rao',
      email: 'annotation-arjun@example.test',
      role: 'doctor',
      doctorId: 'doctor-arjun',
    },
    'AnnotationDoctor2026!',
  );
  ({ server, base } = await listen(app));
  for (const [role, client] of [
    ['doctor', doctor],
    ['admin', admin],
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
  assert.equal(
    (
      await call('/auth/login', unlinked, 'POST', {
        email: 'annotation-unlinked@example.test',
        password: 'AnnotationAdmin2026!',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call('/auth/login', nextDoctor, 'POST', {
        email: 'annotation-arjun@example.test',
        password: 'AnnotationDoctor2026!',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call('/auth/register', other, 'POST', {
        name: 'Other annotation patient',
        email: 'annotation-other@example.test',
        password: 'AnnotationOther2026!',
        phone: '9000000071',
        dob: '1992-01-02',
        gender: 'Other',
      })
    ).status,
    201,
  );
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('original image provenance is server-derived and annotations do not alter stored image bytes or metadata', async () => {
  const image = await upload(patient, { createdById: 'forged-uploader', sha256: 'forged-digest' });
  assert.equal(image.sha256, imageHash);
  assert.equal(image.sizeBytes, originalBytes.length);
  assert.equal(image.createdById, 'user-patient');
  assert.equal(image.createdByRole, 'patient');
  const initial = await call(image.url.replace('/api', ''), patient);
  assert.deepEqual(initial.data, originalBytes);
  const saved = await save(image);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.versions[0].imageSha256, imageHash);
  assert.equal((await publish(image, saved.data.versions[0].id)).status, 200);
  const after = await call(image.url.replace('/api', ''), patient);
  assert.deepEqual(after.data, originalBytes);
  assert.deepEqual(
    JSON.parse(app.locals.db.prepare('SELECT data FROM images WHERE id=?').get(image.id).data),
    image,
  );
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE images SET bytes=? WHERE id=?')
        .run(Buffer.from('replacement'), image.id),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('UPDATE images SET data=? WHERE id=?').run('{}', image.id),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM images WHERE id=?').run(image.id),
    /immutable/,
  );
});

test('annotation history isolates patients and reception while clinical authorship requires a linked doctor', async () => {
  const image = await upload();
  const route = `/images/${image.id}/annotations`;
  assert.equal((await call(route)).status, 401);
  assert.equal((await call(route, reception)).status, 403);
  assert.equal((await call(route, other)).status, 403);
  assert.deepEqual(await history(image, patient), {
    imageId: image.id,
    revision: null,
    versions: [],
  });
  assert.match((await history(image, unlinked)).revision!, /^[a-f0-9]{64}$/);
  for (const client of [patient, other, reception])
    assert.equal((await save(image, {}, client)).status, 403);
  assert.equal((await save(image, {}, unlinked)).status, 400);
  const saved = await save(image);
  assert.equal(saved.status, 201);
  const version = saved.data.versions[0] as ImageAnnotationVersion;
  assert.equal(version.doctorId, 'doctor-meera');
  assert.equal(version.doctorName, 'Dr. Meera Shah');
  assert.equal(version.publishedAt, null);
  assert.ok(!('createdById' in version));
  for (const client of [patient, other, reception])
    assert.equal((await publish(image, version.id, {}, client)).status, 403);
  assert.equal((await publish(image, version.id, {}, unlinked)).status, 400);
  assert.equal((await call(image.url.replace('/api', ''), other)).status, 403);
  assert.equal((await call(route, doctor)).headers.get('cache-control'), 'no-store');
});

test('normalized rectangles, ellipses and arrows retain bounded labels and canonical six-decimal geometry', async () => {
  const image = await upload(doctor, { category: 'report' });
  const rectangle = marker({ x: 0.1234567, width: 0.1111111 });
  const ellipse = marker({
    type: 'ellipse',
    color: 'white',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    label: '',
  });
  const arrow = {
    id: randomUUID(),
    type: 'arrow',
    x1: 0,
    y1: 1,
    x2: 1,
    y2: 0,
    color: 'blue',
    label: 'Direction marked by the clinician',
  };
  const result = await save(image, { note: '', markers: [rectangle, ellipse, arrow] });
  assert.equal(result.status, 201);
  const markers = result.data.versions[0].markers as AnnotationMarker[];
  assert.equal(markers.length, 3);
  assert.equal(markers[0].type, 'rectangle');
  assert.equal((markers[0] as any).x, 0.123457);
  assert.equal((markers[0] as any).width, 0.111111);
  assert.deepEqual(markers[1], ellipse);
  assert.deepEqual(markers[2], arrow);
  assert.equal(
    (
      await save(image, {
        note: 'A note-only version preserves the image without overlays.',
        markers: [],
      })
    ).status,
    201,
  );
});

test('geometry validation rejects out-of-bounds, degenerate, duplicate, oversized and unsupported annotation payloads', async () => {
  const image = await upload();
  const duplicate = marker();
  const arrow = {
    id: randomUUID(),
    type: 'arrow',
    x1: 0.5,
    y1: 0.5,
    x2: 0.5,
    y2: 0.5,
    color: 'green',
    label: '',
  };
  const invalidMarkers = [
    [marker({ x: -0.1 })],
    [marker({ y: 1.1 })],
    [marker({ width: 0 })],
    [marker({ height: 0.0000001 })],
    [marker({ x: 0.9, width: 0.2 })],
    [marker({ y: 0.9, height: 0.2 })],
    [marker({ width: null })],
    [marker({ color: 'url(javascript:alert(1))' })],
    [marker({ label: 'x'.repeat(201) })],
    [marker({ type: 'freehand' })],
    [marker({ id: 'not-a-uuid' })],
    [marker({ measurementUnit: 'mm' })],
    [arrow],
    [{ ...arrow, x2: 0.50000001 }],
    [{ ...arrow, x2: 2 }],
    [duplicate, { ...duplicate, id: duplicate.id.toUpperCase() }],
    Array.from({ length: 51 }, () => marker()),
  ];
  for (const markers of invalidMarkers) {
    const result = await save(image, { markers });
    assert.equal(result.status, 400, JSON.stringify(markers));
  }
  for (const overrides of [
    { note: '', markers: [] },
    { note: 'x'.repeat(4001) },
    { doctorId: 'doctor-arjun' },
    { publishedAt: new Date().toISOString() },
    { expectedRevision: 'invalid' },
  ])
    assert.equal((await save(image, overrides)).status, 400);
  assert.equal((await history(image)).versions.length, 0);
});

test('private versions never leak through patient history or summary helpers and earlier shared versions remain visible', async () => {
  const image = await upload();
  const baseline = await history(image, patient);
  const first = await save(image, { note: 'First private image note.' });
  assert.deepEqual(await history(image, patient), baseline);
  assert.ok(
    !publishedImageAnnotationsForPatient(app.locals.db, image.patientId).some(
      (version) => version.imageId === image.id,
    ),
  );
  const published = await publish(image, first.data.versions[0].id, {}, nextDoctor);
  assert.equal(published.status, 200);
  const patientFirst = await history(image, patient);
  assert.equal(patientFirst.revision, null);
  assert.equal(patientFirst.versions.length, 1);
  assert.equal(patientFirst.versions[0].publishedByDoctorId, 'doctor-arjun');
  assert.equal(patientFirst.versions[0].doctorId, 'doctor-meera');
  const second = await save(image, {
    note: 'New private text must remain unavailable until expressly shared.',
  });
  assert.equal(second.status, 201);
  assert.deepEqual(await history(image, patient), patientFirst);
  const exported = publishedImageAnnotationsForPatient(app.locals.db, image.patientId).filter(
    (version) => version.imageId === image.id,
  );
  assert.deepEqual(exported, patientFirst.versions);
  assert.ok(!JSON.stringify(exported).includes(second.data.versions[0].id));
  assert.ok(!JSON.stringify(exported).includes('New private text'));
  assert.deepEqual(publishedImageAnnotationsForPatient(app.locals.db, 'patient-2'), []);
  assert.equal((await publish(image, second.data.versions[0].id)).status, 200);
  const patientSecond = await history(image, patient);
  assert.equal(patientSecond.versions.length, 2);
  assert.deepEqual(patientSecond.versions[1], patientFirst.versions[0]);
});

test('publishing requires explicit confirmation, the latest saved version and a current revision', async () => {
  const image = await upload();
  const first = await save(image);
  const second = await save(image, { note: 'Latest saved annotation.' });
  assert.equal((await publish(image, first.data.versions[0].id)).status, 409);
  assert.equal(
    (await publish(image, second.data.versions[0].id, { expectedRevision: first.data.revision }))
      .status,
    409,
  );
  assert.equal(
    (await publish(image, second.data.versions[0].id, { patientSharingConfirmed: undefined }))
      .status,
    400,
  );
  assert.equal(
    (await publish(image, second.data.versions[0].id, { patientSharingConfirmed: false })).status,
    400,
  );
  const anotherImage = await upload();
  assert.equal((await publish(anotherImage, second.data.versions[0].id)).status, 404);
  assert.equal((await publish(image, 'missing-version')).status, 404);
  assert.deepEqual((await history(image, patient)).versions, []);
  const published = await publish(image, second.data.versions[0].id);
  assert.equal(published.status, 200);
  assert.notEqual(published.data.revision, second.data.revision);
});

test('publication retries preserve the first timestamp and create only one generic patient notification', async () => {
  const image = await upload();
  const saved = await save(image, {
    note: 'Private note content that is never copied to activity.',
  });
  const version = saved.data.versions[0];
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM activity WHERE eventKey=?')
      .get(`image-annotation-published:${version.id}`).n,
    0,
  );
  const first = await publish(image, version.id);
  const second = await publish(image, version.id, { expectedRevision: saved.data.revision });
  assert.equal(second.status, 200);
  assert.deepEqual(second.data, first.data);
  const notifications = app.locals.db
    .prepare('SELECT userId,data FROM activity WHERE eventKey=?')
    .all(`image-annotation-published:${version.id}`);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].userId, 'user-patient');
  assert.ok(!notifications[0].data.includes(version.note));
  assert.equal(
    JSON.parse(notifications[0].data).href,
    `/my-care/record?tab=images&image=${image.id}`,
  );
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE imageAnnotationVersions SET data=? WHERE id=?')
        .run('{}', version.id),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM imageAnnotationVersions WHERE id=?').run(version.id),
    /immutable/,
  );
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE imageAnnotationPublications SET publishedAt=? WHERE versionId=?')
        .run('changed', version.id),
    /immutable/,
  );
  assert.throws(
    () =>
      app.locals.db
        .prepare('DELETE FROM imageAnnotationPublications WHERE versionId=?')
        .run(version.id),
    /immutable/,
  );
});

test('concurrent saves and competing publication versus save cannot overwrite a newer revision', async () => {
  const image = await upload();
  const revision = (await history(image)).revision;
  const outcomes = await Promise.all([
    save(image, { expectedRevision: revision, note: 'First competing save.' }),
    save(image, { expectedRevision: revision, note: 'Second competing save.' }),
  ]);
  assert.deepEqual(outcomes.map((value) => value.status).sort(), [201, 409]);
  assert.equal((await history(image)).versions.length, 1);
  const current = await history(image);
  const version = current.versions[0];
  const race = await Promise.all([
    save(image, {
      expectedRevision: current.revision,
      note: 'New draft competing with publication.',
    }),
    publish(image, version.id, { expectedRevision: current.revision }),
  ]);
  assert.equal(race.filter((value) => value.status === 409).length, 1);
  assert.equal(race.filter((value) => value.status === 200 || value.status === 201).length, 1);
  const visible = await history(image, patient);
  assert.equal(visible.versions.length, race[1].status === 200 ? 1 : 0);
});

test('pausing the image module blocks new annotation writes while preserving originals and shared history', async () => {
  const image = await upload();
  const saved = await save(image);
  await publish(image, saved.data.versions[0].id);
  const settings = (await call('/settings', admin)).data;
  assert.equal(
    (await call('/settings', admin, 'PATCH', { modules: { ...settings.modules, images: false } }))
      .status,
    200,
  );
  try {
    assert.equal((await save(image)).status, 403);
    assert.equal((await publish(image, saved.data.versions[0].id)).status, 403);
    assert.equal((await history(image, patient)).versions.length, 1);
    assert.equal((await history(image)).versions.length, 1);
    assert.deepEqual((await call(image.url.replace('/api', ''), patient)).data, originalBytes);
  } finally {
    assert.equal(
      (await call('/settings', admin, 'PATCH', { modules: settings.modules })).status,
      200,
    );
  }
});

test('image upload and private annotation creation roll back if their audit write fails', async () => {
  const image = await upload();
  const before = await history(image);
  const imageCount = app.locals.db.prepare('SELECT count(*) AS n FROM images').get().n;
  app.locals.db.exec(
    "CREATE TRIGGER synthetic_image_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') IN ('uploaded private image','saved private image annotation version') BEGIN SELECT RAISE(ABORT,'Synthetic image audit failure'); END;",
  );
  try {
    assert.equal((await save(image)).status, 500);
    assert.deepEqual(await history(image), before);
    const failedUpload = await call('/images', patient, 'POST', {
      caption: 'Must roll back upload',
      category: 'clinical',
      consent: true,
      dataUrl: `data:image/png;base64,${encodedImage}`,
    });
    assert.equal(failedUpload.status, 500);
    assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM images').get().n, imageCount);
  } finally {
    app.locals.db.exec('DROP TRIGGER synthetic_image_audit_failure');
  }
});

test('publication rolls back its visibility, revision, audit and notification after any transactional failure', async () => {
  const image = await upload();
  const saved = await save(image);
  const version = saved.data.versions[0];
  for (const trigger of [
    "CREATE TRIGGER synthetic_publication_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='shared image annotation version with patient' BEGIN SELECT RAISE(ABORT,'Synthetic publication audit failure'); END;",
    "CREATE TRIGGER synthetic_publication_failure BEFORE INSERT ON activity WHEN json_extract(NEW.data,'$.kind')='image-annotation' BEGIN SELECT RAISE(ABORT,'Synthetic publication activity failure'); END;",
  ]) {
    app.locals.db.exec(trigger);
    try {
      assert.equal((await publish(image, version.id)).status, 500);
      assert.deepEqual(await history(image), saved.data);
      assert.deepEqual((await history(image, patient)).versions, []);
      assert.equal(
        app.locals.db
          .prepare('SELECT count(*) AS n FROM imageAnnotationPublications WHERE versionId=?')
          .get(version.id).n,
        0,
      );
      assert.equal(
        app.locals.db
          .prepare('SELECT count(*) AS n FROM activity WHERE eventKey=?')
          .get(`image-annotation-published:${version.id}`).n,
        0,
      );
      assert.equal(
        app.locals.db
          .prepare(
            "SELECT count(*) AS n FROM audit WHERE json_extract(data,'$.entityId')=? AND json_extract(data,'$.action')='shared image annotation version with patient'",
          )
          .get(version.id).n,
        0,
      );
    } finally {
      app.locals.db.exec('DROP TRIGGER synthetic_publication_failure');
    }
  }
  assert.equal((await publish(image, version.id)).status, 200);
});

test('legacy image authorship remains unknown while published overlay history and immutable bytes survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-image-annotations-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = openDatabase(path);
  seedDemo(legacy);
  const original: ClinicalImage = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    caption: 'Historical image without recorded uploader',
    category: 'clinical',
    mimeType: 'image/png',
    createdAt: '2023-01-01T10:00:00.000Z',
    url: '',
    consent: true,
  };
  original.url = `/api/images/${original.id}/file`;
  legacy
    .prepare('INSERT INTO images(id,patientId,data,bytes) VALUES(?,?,?,?)')
    .run(original.id, original.patientId, JSON.stringify(original), originalBytes);
  legacy.close();
  let migrated: ReturnType<typeof createApp> | undefined, live: Server | undefined;
  try {
    migrated = createApp({ databasePath: path, demoMode: true });
    const started = await listen(migrated);
    live = started.server;
    const client: Client = {};
    await call(
      '/auth/login',
      client,
      'POST',
      { email: 'doctor@derma.demo', password: 'DemoClinic2026!' },
      started.base,
    );
    const route = `/images/${original.id}/annotations`;
    const initial = await call(route, client, 'GET', undefined, started.base);
    assert.equal(initial.status, 200);
    const saved = await call(
      route,
      client,
      'POST',
      {
        expectedRevision: initial.data.revision,
        note: 'Clinical note added to legacy image.',
        markers: [],
      },
      started.base,
    );
    assert.equal(saved.status, 201);
    const published = await call(
      `${route}/${saved.data.versions[0].id}/publish`,
      client,
      'POST',
      { expectedRevision: saved.data.revision, patientSharingConfirmed: true },
      started.base,
    );
    assert.equal(published.status, 200);
    assert.equal(published.data.versions[0].imageSha256, imageHash);
    assert.deepEqual(
      JSON.parse(
        migrated.locals.db.prepare('SELECT data FROM images WHERE id=?').get(original.id).data,
      ),
      original,
    );
    await close(live);
    live = undefined;
    migrated.locals.close();
    migrated = undefined;
    migrated = createApp({ databasePath: path, demoMode: true });
    const restarted = await listen(migrated);
    live = restarted.server;
    const restored = await call(route, client, 'GET', undefined, restarted.base);
    assert.deepEqual(restored.data, published.data);
    assert.deepEqual(
      publishedImageAnnotationsForPatient(migrated.locals.db, original.patientId),
      published.data.versions,
    );
    assert.deepEqual(
      (await call(original.url.replace('/api', ''), client, 'GET', undefined, restarted.base)).data,
      originalBytes,
    );
    const metadata = JSON.parse(
      migrated.locals.db.prepare('SELECT data FROM images WHERE id=?').get(original.id).data,
    );
    assert.ok(!('createdById' in metadata));
    assert.ok(!('sha256' in metadata));
    assert.equal(migrated.locals.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    if (live) await close(live);
    migrated?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
