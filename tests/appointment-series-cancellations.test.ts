import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, get, openDatabase, type DB } from '../server/db.ts';
import type { Appointment, Doctor, Patient, User } from '../shared/types.ts';
import type {
  AppointmentSeriesDetail,
  AppointmentSeriesInput,
} from '../shared/appointment-series.ts';
import type {
  SeriesCancellationInput,
  SeriesCancellationPreview,
} from '../shared/appointment-series-cancellations.ts';

const patientId = 'patient-ananya';
const privateReason = 'PRIVATE_BATCH_CANCELLATION_REASON';
const password = 'DemoClinic2026!';
const allDays = Array.from({ length: 7 }, (_, day) => ({
  day,
  start: '09:00',
  end: '18:00',
  mode: 'both',
}));
type Client = { user: User; cookie: string; csrf: string };
const path = (seriesId: string) => `/appointment-series/${seriesId}/cancellations`;

async function fixture(t: TestContext, database?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-series-cancellations-'));
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
  async function call(url: string, who?: Client, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who ? { Cookie: who.cookie, 'X-CSRF-Token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  async function login(role: string) {
    const result = await call('/auth/login', undefined, 'POST', {
      email: `${role}@derma.demo`,
      password,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return {
      user: result.data.user,
      cookie: result.headers.get('set-cookie')!.split(';')[0],
      csrf: result.data.csrfToken,
    } as Client;
  }
  const admin = await login('admin');
  async function doctor() {
    const created = await call('/doctors', admin, 'POST', {
      name: `Dr. Cancellation ${randomUUID()}`,
      title: 'Synthetic clinician',
      qualifications: 'Synthetic profile',
      specialties: ['General dermatology'],
      experience: 1,
      fee: 600,
      bio: 'Synthetic cancellation fixture.',
      languages: ['English'],
      color: '#b3c7aa',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const configured = await call(`/schedules/${created.data.id}`, admin, 'PUT', {
      durationMinutes: 30,
      windows: allDays,
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.data));
    return created.data as Doctor;
  }
  const clinician = await doctor();
  async function book(overrides: Record<string, unknown> = {}) {
    const input = {
      patientId,
      doctorId: clinician.id,
      mode: 'in-person',
      reason: 'Shared visit reason',
      firstDate: addDays(clinicToday(), 35),
      time: '09:00',
      count: 3,
      intervalWeeks: 1,
      durationPolicy: 'custom',
      durationMinutes: 60,
      ...overrides,
    } as AppointmentSeriesInput;
    const preview = await call('/appointment-series/preview', admin, 'POST', input);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.canBook, true, JSON.stringify(preview.data.visits));
    const body = {
      input,
      expectedRevision: preview.data.revision,
      patientConfirmed: true,
      privateNote: 'PRIVATE_ORIGIN_NOTE',
      requestId: randomUUID(),
    };
    const created = await call('/appointment-series', admin, 'POST', body);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return { ...(created.data as AppointmentSeriesDetail), body };
  }
  async function preview(seriesId: string, appointmentIds: string[], who = admin) {
    const result = await call(`${path(seriesId)}/preview`, who, 'POST', { appointmentIds });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data as SeriesCancellationPreview;
  }
  const command = (value: SeriesCancellationPreview): SeriesCancellationInput => ({
    appointmentIds: value.appointmentIds,
    reason: privateReason,
    expectedRevision: value.revision,
    patientConfirmed: true,
    requestId: randomUUID(),
  });
  async function cancel(seriesId: string, appointmentIds: string[], who = admin) {
    const input = command(await preview(seriesId, appointmentIds, who));
    const result = await call(path(seriesId), who, 'POST', input);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return { ...result.data, input };
  }
  async function resource() {
    const result = await call('/clinic-resources', admin, 'POST', {
      name: `Synthetic room ${randomUUID()}`,
      kind: 'room',
      requestId: randomUUID(),
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.resource.id as string;
  }
  async function allocate(appointmentId: string, resourceIds: string[]) {
    const current = await call(`/appointments/${appointmentId}/resources`, admin);
    assert.equal(current.status, 200);
    const result = await call(`/appointments/${appointmentId}/resources`, admin, 'PUT', {
      resourceIds,
      reason: 'Synthetic reservation',
      expectedRevision: current.data.revision,
      requestId: randomUUID(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  return {
    app,
    db,
    databasePath,
    call,
    login,
    admin,
    clinician,
    doctor,
    book,
    preview,
    command,
    cancel,
    resource,
    allocate,
    close,
  };
}

function changeAppointment(db: DB, appointmentId: string, patch: Partial<Appointment>) {
  const value = { ...get<Appointment>(db, 'appointments', appointmentId)!, ...patch };
  db.prepare('UPDATE appointments SET doctorId=?,date=?,time=?,status=?,data=? WHERE id=?').run(
    value.doctorId,
    value.date,
    value.time,
    value.status,
    JSON.stringify(value),
    appointmentId,
  );
  return value;
}
const count = (db: DB, table: string) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
function state(db: DB) {
  return Object.fromEntries(
    [
      'appointments',
      'appointmentSeries',
      'appointmentSeriesMembers',
      'appointmentSeriesCommands',
      'appointmentSeriesCancellations',
      'resourceReservations',
      'resourceAllocationEvents',
      'resourceEventLinks',
      'audit',
      'activity',
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

test('all staff can preview and cancel selected series members; patients and anonymous callers cannot access any cancellation route', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    doctor = await f.login('doctor'),
    reception = await f.login('reception');
  const booked = await f.book(),
    seriesId = booked.series.id,
    ids = booked.appointments.map((entry) => entry.id);
  const preview = await f.preview(seriesId, ids),
    body = f.command(preview);
  for (const who of [undefined, patient]) {
    for (const [suffix, method, payload] of [
      ['/context', 'GET', undefined],
      ['', 'GET', undefined],
      ['/preview', 'POST', { appointmentIds: ids }],
      ['', 'POST', body],
    ] as const)
      assert.equal(
        (await f.call(`${path(seriesId)}${suffix}`, who, method, payload)).status,
        who ? 403 : 401,
      );
  }
  for (const [index, who] of [f.admin, doctor, reception].entries()) {
    const context = await f.call(`${path(seriesId)}/context`, who);
    assert.equal(context.status, 200);
    assert.match(context.headers.get('cache-control') ?? '', /no-store/);
    assert.match(context.headers.get('x-robots-tag') ?? '', /noindex/);
    const result = await f.cancel(seriesId, [ids[index]], who);
    assert.equal(result.event.createdById, who.user.id);
    assert.equal(result.event.createdByRole, who.user.role);
    assert.equal(result.event.visits[0].position, index + 1);
  }
  assert.equal((await f.call(path(seriesId), reception)).data.total, 3);
});

test('selection, confirmation, reasons and query schemas reject malformed, foreign, duplicate and injected values without writes', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    other = await f.book({ time: '11:00' });
  const seriesId = booked.series.id,
    ids = booked.appointments.map((entry) => entry.id),
    source = await f.preview(seriesId, ids),
    body = f.command(source);
  const before = state(f.db);
  for (const appointmentIds of [
    [],
    [ids[0], ids[0]],
    ['missing'],
    [other.appointments[0].id],
    Array.from({ length: 13 }, () => randomUUID()),
  ])
    assert.equal(
      (await f.call(`${path(seriesId)}/preview`, f.admin, 'POST', { appointmentIds })).status,
      400,
    );
  for (const invalid of [
    { ...body, patientConfirmed: false },
    { ...body, patientConfirmed: undefined },
    { ...body, reason: ' ' },
    { ...body, reason: 'x'.repeat(1001) },
    { ...body, expectedRevision: 'bad' },
    { ...body, requestId: 'bad' },
    { ...body, appointmentIds: [ids[0], ids[0]] },
    { ...body, fee: 0 },
    { ...body, status: 'completed' },
  ])
    assert.equal((await f.call(path(seriesId), f.admin, 'POST', invalid)).status, 400);
  assert.equal(
    (await f.call(path(seriesId), { ...f.admin, csrf: 'wrong' }, 'POST', body)).status,
    403,
  );
  for (const suffix of [
    '/context?unexpected=true',
    '?page=0',
    '?page=1000001',
    '?pageSize=100',
    '?page=1&page=2',
  ])
    assert.equal((await f.call(`${path(seriesId)}${suffix}`, f.admin)).status, 400);
  for (const suffix of ['/preview?unexpected=true', '?unexpected=true'])
    assert.equal(
      (
        await f.call(
          `${path(seriesId)}${suffix}`,
          f.admin,
          'POST',
          suffix.startsWith('/preview') ? { appointmentIds: ids } : body,
        )
      ).status,
      400,
    );
  assert.equal((await f.call(`${path('missing')}/context`, f.admin)).status, 404);
  assert.deepEqual(state(f.db), before);
});

test('current moved and custom-length visits are cancelled status-only in original order while original booking, fees and unrelated members remain unchanged', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    secondDoctor = await f.doctor(),
    [first, second, third] = booked.appointments;
  const moved = await f.call(`/appointments/${first.id}`, f.admin, 'PATCH', {
    date: addDays(first.date, 2),
    time: '10:00',
    doctorId: secondDoctor.id,
    mode: 'online',
  });
  assert.equal(moved.status, 200);
  f.db
    .prepare(
      "UPDATE doctors SET data=json_set(data,'$.fee',999,'$.name','Later renamed clinician') WHERE id=?",
    )
    .run(secondDoctor.id);
  const patient = get<Patient>(f.db, 'patients', patientId)!;
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(
      JSON.stringify({ ...patient, name: 'Current patient label', phone: '9000000888' }),
      patientId,
    );
  const source = await f.preview(booked.series.id, [third.id, first.id]);
  assert.deepEqual(source.appointmentIds, [first.id, third.id]);
  assert.deepEqual(
    source.visits.map((entry) => entry.position),
    [1, 3],
  );
  assert.deepEqual(source.patient, {
    id: patientId,
    name: 'Current patient label',
    phone: '9000000888',
  });
  assert.equal(source.visits[0].appointment.durationMinutes, 60);
  const result = await f.call(path(booked.series.id), f.admin, 'POST', {
    ...f.command(source),
    appointmentIds: [third.id, first.id],
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.event.appointmentIds, [first.id, third.id]);
  for (const visit of result.data.event.visits)
    assert.deepEqual(visit.after, { ...visit.before, status: 'cancelled' });
  assert.deepEqual(result.data.detail.series, booked.series);
  assert.deepEqual(result.data.detail.appointments[1], second);
  assert.equal(result.data.detail.appointments[0].fee, moved.data.fee);
  assert.equal(result.data.detail.appointments[0].doctorName, moved.data.doctorName);
});

test('blocked selections retain every row, and any closed, active or past member prevents the whole cancellation', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    [first, second] = booked.appointments;
  for (const status of [
    'checked-in',
    'in-consultation',
    'completed',
    'cancelled',
    'no-show',
  ] as const) {
    changeAppointment(f.db, first.id, { status });
    const source = await f.preview(booked.series.id, [first.id, second.id]);
    assert.equal(source.visits.length, 2);
    assert.equal(source.visits[0].eligible, false);
    assert.ok(source.visits[0].blockedReason);
    assert.equal(source.visits[1].eligible, true);
    assert.equal(source.canCancel, false);
    const before = state(f.db);
    assert.equal(
      (await f.call(path(booked.series.id), f.admin, 'POST', f.command(source))).status,
      409,
    );
    assert.deepEqual(state(f.db), before);
  }
  changeAppointment(f.db, first.id, { status: 'scheduled', date: addDays(clinicToday(), -1) });
  const source = await f.preview(booked.series.id, [first.id, second.id]);
  assert.match(source.visits[0].blockedReason!, /scheduled start/);
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(source))).status,
    409,
  );
  assert.equal(get<Appointment>(f.db, 'appointments', second.id)!.status, 'scheduled');
});

test('exact IST start and clock changes invalidate a preview while generation time alone does not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-03-01T06:29:58Z') });
  const f = await fixture(t),
    booked = await f.book({ firstDate: clinicToday(), time: '12:00', count: 2 });
  const ids = booked.appointments.map((entry) => entry.id),
    source = await f.preview(booked.series.id, ids);
  assert.equal(source.canCancel, true);
  t.mock.timers.setTime(Date.parse('2027-03-01T06:29:59Z'));
  const later = await f.preview(booked.series.id, ids);
  assert.notEqual(later.generatedAt, source.generatedAt);
  assert.equal(later.revision, source.revision);
  const originalPrepare = f.db.prepare.bind(f.db);
  let crossed = false;
  f.db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (sql.includes('FROM resourceReservations')) {
      const all = statement.all.bind(statement);
      statement.all = ((...parameters: Parameters<typeof statement.all>) => {
        const result = all(...parameters);
        crossed = true;
        t.mock.timers.setTime(Date.parse('2027-03-01T06:30:00Z'));
        return result;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const coherent = await f.call(`${path(booked.series.id)}/context`, f.admin);
    assert.equal(coherent.status, 200);
    assert.equal(crossed, true);
    assert.equal(coherent.data.generatedAt, '2027-03-01T06:29:59.000Z');
    assert.equal(
      coherent.data.visits[0].eligible,
      true,
      'row eligibility uses the same captured instant as generatedAt',
    );
  } finally {
    f.db.prepare = originalPrepare;
  }
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(source))).status,
    409,
  );
  const current = await f.preview(booked.series.id, ids);
  assert.equal(current.visits[0].eligible, false);
  assert.equal(current.visits[1].eligible, true);
  assert.equal(count(f.db, 'appointmentSeriesCancellations'), 0);
});

test('every cancellation path revalidates session, access, temporary-password and MFA state inside the write lock, including exact retries', async (t) => {
  for (const change of [
    'revoked',
    'expired',
    'csrf',
    'inactive',
    'temporary',
    'role',
    'mfa',
  ] as const) {
    const f = await fixture(t),
      booked = await f.book(),
      ids = booked.appointments.map((entry) => entry.id);
    const saved = await f.cancel(booked.series.id, [ids[0]]);
    const input = f.command(await f.preview(booked.series.id, [ids[1]]));
    const external = openDatabase(f.databasePath);
    const account = external
      .prepare('SELECT role,data FROM users WHERE id=?')
      .get(f.admin.user.id)!;
    const session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!;
    const columns = Object.keys(session);
    const original = f.db.exec.bind(f.db);
    try {
      for (const operation of ['context', 'history', 'preview', 'commit', 'retry']) {
        let injected = false;
        f.db.exec = ((sql: string) => {
          if (sql === 'BEGIN IMMEDIATE' && !injected) {
            injected = true;
            if (change === 'revoked')
              external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
            if (change === 'expired')
              external
                .prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?')
                .run(f.admin.user.id);
            if (change === 'csrf')
              external
                .prepare("UPDATE sessions SET csrfToken='replaced-csrf' WHERE userId=?")
                .run(f.admin.user.id);
            if (change === 'inactive')
              external
                .prepare("UPDATE users SET data=json_set(data,'$.active',json('false')) WHERE id=?")
                .run(f.admin.user.id);
            if (change === 'temporary')
              external
                .prepare(
                  "UPDATE users SET data=json_set(data,'$.mustChangePassword',json('true')) WHERE id=?",
                )
                .run(f.admin.user.id);
            if (change === 'role')
              external
                .prepare(
                  "UPDATE users SET role='patient',data=json_set(data,'$.role','patient','$.patientId',?) WHERE id=?",
                )
                .run('patient-2', f.admin.user.id);
            if (change === 'mfa')
              external
                .prepare(
                  'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES(?,?,?,?,?)',
                )
                .run(
                  f.admin.user.id,
                  randomUUID(),
                  'Unused synthetic encrypted source',
                  new Date().toISOString(),
                  -1,
                );
          }
          return original(sql);
        }) as typeof f.db.exec;
        const before = state(f.db);
        const response = await f.call(
          `${path(booked.series.id)}${operation === 'context' ? '/context' : operation === 'preview' ? '/preview' : ''}`,
          f.admin,
          ['preview', 'commit', 'retry'].includes(operation) ? 'POST' : 'GET',
          operation === 'preview'
            ? { appointmentIds: input.appointmentIds }
            : operation === 'commit'
              ? input
              : operation === 'retry'
                ? saved.input
                : undefined,
        );
        assert.equal(injected, true, `${change}/${operation}`);
        assert.equal(
          response.status,
          change === 'temporary' || change === 'role' ? 403 : 401,
          `${change}/${operation}: ${JSON.stringify(response.data)}`,
        );
        assert.equal(response.data.event, undefined);
        assert.equal(response.data.visits, undefined);
        assert.deepEqual(state(f.db), before, `${change}/${operation}`);
        f.db.exec = original;
        external
          .prepare('UPDATE users SET role=?,data=? WHERE id=?')
          .run(account.role, account.data, f.admin.user.id);
        external.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(f.admin.user.id);
        external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
        external
          .prepare(
            `INSERT INTO sessions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((column) => session[column]));
      }
    } finally {
      f.db.exec = original;
      external.close();
    }
  }
});

test('external source changes between middleware and BEGIN reject the old preview and current account names attribute an accepted command', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    first = booked.appointments[0];
  const original = f.db.exec.bind(f.db),
    external = openDatabase(f.databasePath);
  try {
    for (const change of ['appointment', 'patient']) {
      const source = await f.preview(booked.series.id, [first.id]);
      let injected = false;
      f.db.exec = ((sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true;
          if (change === 'appointment') changeAppointment(external, first.id, { time: '10:00' });
          else
            external
              .prepare("UPDATE patients SET data=json_set(data,'$.phone','9000000033') WHERE id=?")
              .run(patientId);
        }
        return original(sql);
      }) as typeof f.db.exec;
      const result = await f.call(path(booked.series.id), f.admin, 'POST', f.command(source));
      f.db.exec = original;
      assert.equal(injected, true);
      assert.equal(result.status, 409);
      assert.equal(count(f.db, 'appointmentSeriesCancellations'), 0);
      assert.equal(get<Appointment>(f.db, 'appointments', first.id)!.status, 'scheduled');
    }
    const source = await f.preview(booked.series.id, [first.id]);
    let injected = false;
    f.db.exec = ((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !injected) {
        injected = true;
        external
          .prepare(
            "UPDATE users SET data=json_set(data,'$.name','Current cancellation actor') WHERE id=?",
          )
          .run(f.admin.user.id);
      }
      return original(sql);
    }) as typeof f.db.exec;
    const result = await f.call(path(booked.series.id), f.admin, 'POST', f.command(source));
    assert.equal(result.status, 201);
    assert.equal(result.data.event.createdByName, 'Current cancellation actor');
    const audit = f.db
      .prepare(
        "SELECT data FROM audit WHERE json_extract(data,'$.action')='cancelled appointment series visits' ORDER BY rowid DESC LIMIT 1",
      )
      .get()!;
    assert.equal(JSON.parse(String(audit.data)).actorName, 'Current cancellation actor');
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('competing application connections serialize exact retries and individual cancellation races without partial batches or duplicate notices', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    second = await fixture(t, f.databasePath);
  const selected = booked.appointments.slice(0, 2).map((entry) => entry.id),
    input = f.command(await f.preview(booked.series.id, selected));
  const [first, repeated] = await Promise.all([
    f.call(path(booked.series.id), f.admin, 'POST', input),
    second.call(path(booked.series.id), f.admin, 'POST', {
      ...input,
      appointmentIds: [...selected].reverse(),
    }),
  ]);
  assert.deepEqual([first.status, repeated.status].sort(), [200, 201]);
  assert.deepEqual(first.data.event, repeated.data.event);
  assert.equal(count(f.db, 'appointmentSeriesCancellations'), 1);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM activity WHERE eventKey LIKE 'appointment-series-cancelled:%'",
      )
      .get()!.n,
    2,
  );
  const another = await f.book({ time: '12:00' });
  const competingInput = f.command(
    await f.preview(
      another.series.id,
      another.appointments.slice(0, 2).map((entry) => entry.id),
    ),
  );
  const [batch, individual] = await Promise.all([
    f.call(path(another.series.id), f.admin, 'POST', competingInput),
    second.call(`/appointments/${another.appointments[0].id}`, second.admin, 'PATCH', {
      status: 'cancelled',
    }),
  ]);
  assert.ok(
    (batch.status === 201 && individual.status === 409) ||
      (batch.status === 409 && individual.status === 200),
  );
  assert.equal(
    get<Appointment>(f.db, 'appointments', another.appointments[0].id)!.status,
    'cancelled',
  );
  assert.equal(
    get<Appointment>(f.db, 'appointments', another.appointments[1].id)!.status,
    batch.status === 201 ? 'cancelled' : 'scheduled',
  );
  assert.equal(
    get<Appointment>(f.db, 'appointments', another.appointments[2].id)!.status,
    'scheduled',
  );
});

test('history is SQL-paged before decoding, clamps pages, and audited reads cannot return data when audit fails', async (t) => {
  const f = await fixture(t),
    booked = await f.book({ count: 12 });
  const recorded = [];
  for (const appointment of booked.appointments)
    recorded.push((await f.cancel(booked.series.id, [appointment.id])).event);
  const prepare = f.db.prepare.bind(f.db);
  let selectedRows = 0;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/SELECT data FROM appointmentSeriesCancellations/.test(sql)) {
      assert.match(sql, /LIMIT \? OFFSET \?/);
      const all = statement.all.bind(statement);
      statement.all = ((...values: Parameters<typeof statement.all>) => {
        const rows = all(...values);
        selectedRows = Math.max(selectedRows, rows.length);
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const first = await f.call(`${path(booked.series.id)}?pageSize=10`, f.admin);
    const last = await f.call(`${path(booked.series.id)}?pageSize=10&page=1000000`, f.admin);
    assert.deepEqual(
      [first.status, first.data.total, first.data.totalPages, first.data.items.length],
      [200, 12, 2, 10],
    );
    assert.deepEqual([last.status, last.data.page, last.data.items.length], [200, 2, 2]);
    assert.equal(selectedRows, 10);
    const ordered = [...recorded].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    assert.deepEqual([...first.data.items, ...last.data.items], ordered);
  } finally {
    f.db.prepare = prepare;
  }
  const plan = f.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT data FROM appointmentSeriesCancellations WHERE seriesId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
    )
    .all(booked.series.id, 10, 0);
  assert.match(JSON.stringify(plan), /appointment_series_cancellations_series_created/);
  f.db.exec(
    "CREATE TRIGGER synthetic_cancel_read_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='appointment-series' BEGIN SELECT RAISE(ABORT,'Synthetic cancellation read audit'); END;",
  );
  const before = state(f.db);
  for (const [suffix, method, body] of [
    ['', 'GET', undefined],
    ['/context', 'GET', undefined],
    ['/preview', 'POST', { appointmentIds: [booked.appointments[0].id] }],
  ] as const) {
    const result = await f.call(`${path(booked.series.id)}${suffix}`, f.admin, method, body);
    assert.equal(result.status, 500);
    assert.equal(result.data.items, undefined);
    assert.equal(result.data.visits, undefined);
    assert.deepEqual(state(f.db), before);
  }
});

test('preexisting series migrate without fabricated cancellation history and immutable receipts survive reopening after later member changes', async (t) => {
  const f = await fixture(t),
    booked = await f.book();
  // Simulate the immediately preceding release, which has series sources but no cancellation table.
  f.db.exec('DROP TABLE appointmentSeriesCancellations');
  const storedOrigin = f.db
    .prepare('SELECT data FROM appointmentSeries WHERE id=?')
    .get(booked.series.id)!.data;
  await f.close();
  const upgraded = await fixture(t, f.databasePath);
  assert.equal((await upgraded.call(path(booked.series.id), upgraded.admin)).data.total, 0);
  assert.equal(
    upgraded.db.prepare('SELECT data FROM appointmentSeries WHERE id=?').get(booked.series.id)!
      .data,
    storedOrigin,
  );
  const saved = await upgraded.cancel(booked.series.id, [booked.appointments[0].id]);
  assert.equal(
    (
      await upgraded.call(`/appointments/${booked.appointments[1].id}`, upgraded.admin, 'PATCH', {
        time: '12:00',
      })
    ).status,
    200,
  );
  for (const sql of [
    'UPDATE appointmentSeriesCancellations SET data=data',
    'DELETE FROM appointmentSeriesCancellations',
    "UPDATE appointmentSeriesCommands SET payload=payload WHERE operation='cancel'",
    "DELETE FROM appointmentSeriesCommands WHERE operation='cancel'",
  ])
    assert.throws(() => upgraded.db.exec(sql), /immutable/);
  await upgraded.close();
  const reopened = await fixture(t, f.databasePath);
  const before = state(reopened.db),
    replay = await reopened.call(path(booked.series.id), reopened.admin, 'POST', saved.input);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.event, saved.event);
  assert.deepEqual(replay.data.detail.series, booked.series);
  assert.equal(replay.data.detail.appointments[1].time, '12:00');
  assert.deepEqual(state(reopened.db), before);
  assert.equal((await reopened.call(path(booked.series.id), reopened.admin)).data.total, 1);
});

test('preview tokens bind current demographics and selected appointments but ignore reads, unselected members and doctor schedule changes', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    first = booked.appointments[0];
  const source = await f.preview(booked.series.id, [first.id]);
  await f.call(`${path(booked.series.id)}/context`, f.admin);
  await f.call(path(booked.series.id), f.admin);
  assert.equal(
    (
      await f.call(`/appointments/${booked.appointments[1].id}`, f.admin, 'PATCH', {
        time: '11:00',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(`/schedules/${f.clinician.id}`, f.admin, 'PUT', {
        durationMinutes: 20,
        windows: allDays,
      })
    ).status,
    200,
  );
  f.db
    .prepare(
      "UPDATE patients SET data=json_set(data,'$.allergies','PRIVATE_ALLERGY_CHANGE') WHERE id=?",
    )
    .run(patientId);
  assert.equal((await f.preview(booked.series.id, [first.id])).revision, source.revision);
  f.db
    .prepare("UPDATE patients SET data=json_set(data,'$.phone','9000000111') WHERE id=?")
    .run(patientId);
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(source))).status,
    409,
  );
  const fresh = await f.preview(booked.series.id, [first.id]);
  assert.notEqual(fresh.revision, source.revision);
  assert.equal(
    (await f.call(`/appointments/${first.id}`, f.admin, 'PATCH', { time: '12:00' })).status,
    200,
  );
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(fresh))).status,
    409,
  );
});

test('resource allocation changes including release-and-reallocate stale previews; successful cancellation releases current reservations and preserves allocation evidence', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    first = booked.appointments[0],
    room = await f.resource(),
    equipment = await f.resource();
  const initial = await f.preview(booked.series.id, [first.id]);
  await f.allocate(first.id, [room, equipment]);
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(initial))).status,
    409,
  );
  const allocated = await f.preview(booked.series.id, [first.id]);
  assert.equal(allocated.visits[0].reservationCount, 2);
  await f.allocate(first.id, []);
  await f.allocate(first.id, [room, equipment]);
  const reallocated = await f.preview(booked.series.id, [first.id]);
  assert.notEqual(
    reallocated.revision,
    allocated.revision,
    'allocation history head prevents a stale identical-looking reservation',
  );
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(allocated))).status,
    409,
  );
  const historyBefore = count(f.db, 'resourceAllocationEvents');
  const result = await f.cancel(booked.series.id, [first.id]);
  assert.equal(result.event.visits[0].releasedReservationCount, 2);
  assert.equal(count(f.db, 'resourceReservations'), 0);
  assert.equal(count(f.db, 'resourceAllocationEvents'), historyBefore + 1);
  const history = await f.call(`/appointments/${first.id}/resources`, f.admin);
  assert.equal(history.data.history[0].source, 'appointment-status');
  assert.deepEqual(history.data.history[0].after.resources, []);
  assert.equal(history.data.history[0].after.appointment.status, 'cancelled');
  const replacement = await f.call('/appointments', f.admin, 'POST', {
    patientId,
    doctorId: f.clinician.id,
    date: first.date,
    time: first.time,
    mode: first.mode,
    reason: 'Replacement visit',
  });
  assert.equal(replacement.status, 201);
  await f.allocate(replacement.data.id, [room, equipment]);
  assert.equal(count(f.db, 'resourceReservations'), 2);
});

test('exact retries normalize UUID and selected order, preserve original evidence after later changes, and reject actor/payload/booking UUID collisions', async (t) => {
  const f = await fixture(t),
    reception = await f.login('reception'),
    booked = await f.book(),
    ids = booked.appointments.slice(0, 2).map((entry) => entry.id);
  const source = await f.preview(booked.series.id, ids),
    input = f.command(source);
  const initial = await f.call(path(booked.series.id), f.admin, 'POST', {
    ...input,
    appointmentIds: [...ids].reverse(),
    requestId: input.requestId.toUpperCase(),
    reason: ` ${privateReason} `,
  });
  assert.equal(initial.status, 201);
  assert.equal(
    (
      await f.call(`/appointments/${booked.appointments[2].id}`, f.admin, 'PATCH', {
        time: '12:00',
      })
    ).status,
    200,
  );
  const before = state(f.db),
    repeated = await f.call(path(booked.series.id), f.admin, 'POST', input);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.data.event, initial.data.event);
  assert.equal(repeated.data.detail.appointments[2].time, '12:00');
  assert.deepEqual(state(f.db), before);
  for (const changed of [
    { ...input, reason: 'Different' },
    { ...input, expectedRevision: '0'.repeat(64) },
    { ...input, appointmentIds: [ids[0]] },
  ])
    assert.equal((await f.call(path(booked.series.id), f.admin, 'POST', changed)).status, 409);
  assert.equal((await f.call(path(booked.series.id), reception, 'POST', input)).status, 409);
  const nextPreview = await f.preview(booked.series.id, [booked.appointments[2].id]);
  assert.equal(
    (
      await f.call(path(booked.series.id), f.admin, 'POST', {
        ...f.command(nextPreview),
        requestId: booked.body.requestId,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call('/appointment-series', f.admin, 'POST', {
        ...booked.body,
        requestId: input.requestId,
      })
    ).status,
    409,
  );
});

test('last-member, resource, event, receipt, audit and notification failures roll back cancellations and release evidence completely', async (t) => {
  for (const failure of ['last-member', 'resource', 'event', 'receipt', 'audit', 'activity']) {
    const f = await fixture(t),
      booked = await f.book(),
      ids = booked.appointments.map((entry) => entry.id),
      room = await f.resource();
    for (const appointmentId of ids) await f.allocate(appointmentId, [room]);
    const source = await f.preview(booked.series.id, ids),
      input = f.command(source);
    const trigger = {
      'last-member': `BEFORE UPDATE ON appointments WHEN NEW.id='${ids[2]}' AND NEW.status='cancelled'`,
      resource: `BEFORE INSERT ON resourceAllocationEvents WHEN NEW.appointmentId='${ids[2]}'`,
      event: 'BEFORE INSERT ON appointmentSeriesCancellations',
      receipt: "BEFORE INSERT ON appointmentSeriesCommands WHEN NEW.operation='cancel'",
      audit:
        "BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='cancelled appointment series visits'",
      activity: `BEFORE INSERT ON activity WHEN NEW.eventKey LIKE 'appointment-series-cancelled:%:${ids[2]}'`,
    }[failure];
    f.db.exec(
      `CREATE TRIGGER synthetic_cancel_failure ${trigger} BEGIN SELECT RAISE(ABORT,'Synthetic cancellation rollback'); END;`,
    );
    const before = state(f.db);
    const failed = await f.call(path(booked.series.id), f.admin, 'POST', input);
    assert.equal(failed.status, 500, `${failure}: ${JSON.stringify(failed.data)}`);
    assert.equal(failed.data.event, undefined);
    assert.deepEqual(state(f.db), before, failure);
    f.db.exec('DROP TRIGGER synthetic_cancel_failure');
    assert.equal((await f.call(path(booked.series.id), f.admin, 'POST', input)).status, 201);
    assert.equal(count(f.db, 'resourceReservations'), 0);
    assert.equal(count(f.db, 'appointmentSeriesCancellations'), 1);
  }
});

test('patients see ordinary cancellation states and generic notices without batch reason, origin, actor or receipt fields; linked clinical and financial sources are untouched', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    booked = await f.book(),
    first = booked.appointments[0];
  const procedure = await f.call('/procedures', f.admin, 'POST', {
    patientId,
    appointmentId: first.id,
    title: 'Synthetic planned procedure',
    indication: 'Recorded patient-specific indication',
    benefits: 'Recorded discussion',
    risks: 'Recorded risks',
    alternatives: 'Recorded alternatives',
    aftercare: 'Recorded instructions',
    estimatedCost: '600',
  });
  assert.equal(procedure.status, 201, JSON.stringify(procedure.data));
  const invoice = await f.call('/invoices', f.admin, 'POST', {
    patientId,
    items: [{ description: 'Recorded charge', quantity: 1, unitAmountPaise: 60000 }],
  });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.data));
  const tables = [
    'procedures',
    'procedureScheduleEvents',
    'invoices',
    'payments',
    'waitlistEvents',
  ];
  const before = Object.fromEntries(
    tables.map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
  const cancelled = await f.cancel(booked.series.id, [first.id]);
  assert.deepEqual(
    Object.fromEntries(
      tables.map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    ),
    before,
  );
  for (const url of [
    '/appointments',
    `/patients/${patientId}/care-summary`,
    '/activity',
    `/appointments/${first.id}/calendar`,
  ]) {
    const result = await f.call(url, patient);
    assert.equal(result.status, 200, url);
    const output = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    for (const secret of [
      privateReason,
      cancelled.event.requestId,
      cancelled.event.expectedRevision,
      cancelled.event.id,
      booked.series.id,
      'PRIVATE_ORIGIN_NOTE',
    ])
      assert.ok(!output.includes(secret), `${url}: ${secret}`);
  }
  const notices = f.db
    .prepare("SELECT data FROM activity WHERE eventKey LIKE 'appointment-series-cancelled:%'")
    .all();
  assert.equal(notices.length, 1);
  assert.ok(!String(notices[0].data).includes(privateReason));
  const summary = await f.call(`/patients/${patientId}/care-summary`, patient);
  assert.equal(
    summary.data.appointments.find((entry: Appointment) => entry.id === first.id).status,
    'cancelled',
  );
  assert.equal(
    summary.data.procedures.find((entry: { id: string }) => entry.id === procedure.data.id)
      .effectiveAppointmentId,
    first.id,
  );
});
