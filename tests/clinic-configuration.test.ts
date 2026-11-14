import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createUser, get, openDatabase, defaultSettings, type DB } from '../server/db.ts';
import type { User, ClinicSettings } from '../shared/types.ts';
import type {
  ClinicConfigurationContext,
  ClinicProfile,
  ClinicConfigurationMutation,
} from '../shared/clinic-configuration.ts';

type Client = { cookie: string; csrf: string; user: User };
const basePath = '/clinic-configuration';
const privateReason = 'PRIVATE_ADMIN_CONFIGURATION_REASON';
const profileOf = (value: ClinicSettings): ClinicProfile => {
  const { modules: _, ...profile } = value;
  return profile;
};
async function fixture(t: TestContext, database?: string, fresh = false) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-clinic-configuration-')),
    databasePath = database ?? join(directory, 'clinic.sqlite');
  const app = createApp({ databasePath, demoMode: !fresh, production: false }),
    db = app.locals.db as DB;
  if (fresh)
    createUser(
      db,
      {
        id: randomUUID(),
        name: 'Initial synthetic admin',
        email: 'admin@derma.demo',
        role: 'admin',
        active: true,
      },
      'DemoClinic2026!',
    );
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
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
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
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(role: string) {
    const r = await call('/auth/login', undefined, 'POST', {
      email: `${role}@derma.demo`,
      password: 'DemoClinic2026!',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return {
      cookie: r.headers.get('set-cookie')!.split(';')[0],
      csrf: r.data.csrfToken,
      user: r.data.user,
    } as Client;
  }
  const admin = await login('admin');
  async function context(): Promise<ClinicConfigurationContext> {
    const r = await call(basePath, admin);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  async function profileBody(
    fields: Partial<ClinicProfile> = {},
    extra: Record<string, unknown> = {},
  ) {
    const c = await context();
    return {
      profile: { ...profileOf(c.settings), name: 'Updated clinic profile', ...fields },
      reason: privateReason,
      expectedRevision: c.profileRevision,
      requestId: randomUUID(),
      ...extra,
    };
  }
  async function modulesBody(
    fields: Partial<ClinicSettings['modules']> = {},
    extra: Record<string, unknown> = {},
  ) {
    const c = await context();
    return {
      modules: { ...c.settings.modules, followUp: !c.settings.modules.followUp, ...fields },
      reason: privateReason,
      expectedRevision: c.modulesRevision,
      requestId: randomUUID(),
      ...extra,
    };
  }
  async function saveProfile(fields: Partial<ClinicProfile> = {}) {
    const body = await profileBody(fields),
      r = await call(`${basePath}/profile`, admin, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { body, value: r.data as ClinicConfigurationMutation };
  }
  async function saveModules(fields: Partial<ClinicSettings['modules']> = {}) {
    const body = await modulesBody(fields),
      r = await call(`${basePath}/modules`, admin, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { body, value: r.data as ClinicConfigurationMutation };
  }
  function state() {
    const count = (table: string) =>
      Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    return {
      settings: db.prepare("SELECT value FROM meta WHERE key='settings'").get()!.value,
      clinicConfigurationChanges: count('clinicConfigurationChanges'),
      clinicConfigurationCommands: count('clinicConfigurationCommands'),
      audit: count('audit'),
    };
  }
  return {
    app,
    db,
    databasePath,
    base,
    admin,
    call,
    login,
    context,
    profileBody,
    modulesBody,
    saveProfile,
    saveModules,
    state,
    close,
  };
}

test('fresh and existing installations expose unchanged public values, independent revisions and no invented history', async (t) => {
  const f = await fixture(t, undefined, true),
    c = await f.context();
  assert.deepEqual(c.settings, defaultSettings);
  assert.match(c.profileRevision, /^[a-f0-9]{64}$/);
  assert.match(c.modulesRevision, /^[a-f0-9]{64}$/);
  assert.equal(c.latestProfileChange, null);
  assert.equal(c.latestModulesChange, null);
  const history = await f.call(`${basePath}/history`, f.admin);
  assert.deepEqual(history.data, { items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 });
  const publicRead = await f.call('/settings');
  assert.equal(publicRead.status, 200);
  assert.deepEqual(publicRead.data, defaultSettings);
  assert.match(history.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM doctors').get()!.n, 0);
});

test('scoped saves protect a concurrent module pause from an older profile form and preserve the other revision', async (t) => {
  const f = await fixture(t),
    initial = await f.context(),
    profile = await f.profileBody({ phone: '9000000001' }),
    modules = await f.modulesBody({ followUp: false });
  const paused = await f.call(`${basePath}/modules`, f.admin, 'POST', modules);
  assert.equal(paused.status, 201);
  assert.equal(paused.data.context.profileRevision, initial.profileRevision);
  assert.notEqual(paused.data.context.modulesRevision, initial.modulesRevision);
  const saved = await f.call(`${basePath}/profile`, f.admin, 'POST', profile);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.context.settings.modules.followUp, false);
  assert.equal(saved.data.context.modulesRevision, paused.data.context.modulesRevision);
  assert.equal(saved.data.context.settings.phone, '9000000001');
  assert.deepEqual(saved.data.change.before, profileOf(initial.settings));
  assert.deepEqual(saved.data.change.after, profile.profile);
  const moduleDraft = await f.modulesBody({ images: false }),
    later = await f.saveProfile({ address: 'Updated address' });
  const moduleSave = await f.call(`${basePath}/modules`, f.admin, 'POST', moduleDraft);
  assert.equal(moduleSave.status, 201);
  assert.equal(moduleSave.data.context.settings.address, 'Updated address');
  assert.equal(moduleSave.data.context.profileRevision, later.value.context.profileRevision);
});

test('A-to-B-to-A changes advance the scoped head and reject an old same-value revision', async (t) => {
  const f = await fixture(t),
    initial = await f.context(),
    stale = await f.profileBody({ name: 'Pending stale profile' });
  await f.saveProfile({ name: 'B clinic' });
  await f.saveProfile(profileOf(initial.settings));
  const restored = await f.context();
  assert.deepEqual(restored.settings, initial.settings);
  assert.notEqual(restored.profileRevision, initial.profileRevision);
  assert.equal(restored.modulesRevision, initial.modulesRevision);
  assert.equal((await f.call(`${basePath}/profile`, f.admin, 'POST', stale)).status, 409);
  const modulesStale = await f.modulesBody({ images: false });
  await f.saveModules({ followUp: false });
  await f.saveModules({ followUp: true });
  const after = await f.context();
  assert.deepEqual(after.settings.modules, initial.settings.modules);
  assert.notEqual(after.modulesRevision, initial.modulesRevision);
  assert.equal((await f.call(`${basePath}/modules`, f.admin, 'POST', modulesStale)).status, 409);
});

test('new commands are strict full-group schemas with compatible limits, normalization and no-op rejection', async (t) => {
  const f = await fixture(t),
    c = await f.context(),
    profile = await f.profileBody();
  for (const fields of [
    { name: '' },
    { name: 'x'.repeat(301) },
    { phone: 'x'.repeat(301) },
    { address: 'x'.repeat(301) },
    { hours: 'x'.repeat(301) },
    { tagline: 'x'.repeat(301) },
    { email: 'not-an-email' },
    { timezone: 'UTC' },
    { modules: c.settings.modules },
    { extra: 'private' },
  ]) {
    const before = f.state();
    assert.equal(
      (
        await f.call(`${basePath}/profile`, f.admin, 'POST', {
          ...profile,
          profile: { ...profile.profile, ...fields },
        })
      ).status,
      400,
    );
    assert.deepEqual(f.state(), before);
  }
  const { hours: _, ...missing } = profile.profile;
  assert.equal(
    (await f.call(`${basePath}/profile`, f.admin, 'POST', { ...profile, profile: missing })).status,
    400,
  );
  for (const fields of [
    { reason: '' },
    { reason: ' '.repeat(10) },
    { reason: 'x'.repeat(1001) },
    { requestId: 'bad' },
    { expectedRevision: 'A'.repeat(64) },
    { extra: true },
  ])
    assert.equal(
      (await f.call(`${basePath}/profile`, f.admin, 'POST', { ...profile, ...fields })).status,
      400,
    );
  const moduleBody = await f.modulesBody();
  for (const modules of [
    { intake: true, images: true },
    { ...c.settings.modules, followUp: 'false' },
    { ...c.settings.modules, extra: true },
  ])
    assert.equal(
      (await f.call(`${basePath}/modules`, f.admin, 'POST', { ...moduleBody, modules })).status,
      400,
    );
  for (const url of [
    `${basePath}?extra=1`,
    `${basePath}/history?scope=invalid`,
    `${basePath}/history?page=0`,
    `${basePath}/history?page=1000001`,
    `${basePath}/history?pageSize=100`,
  ])
    assert.equal((await f.call(url, f.admin)).status, 400);
  assert.equal((await f.call(`${basePath}/profile?extra=1`, f.admin, 'POST', profile)).status, 400);
  const normalized = await f.call(`${basePath}/profile`, f.admin, 'POST', {
    ...profile,
    profile: {
      ...profile.profile,
      name: '  ' + 'n'.repeat(300) + '  ',
      tagline: '',
      phone: '',
      address: '',
      hours: '',
      email: '  CLINIC@EXAMPLE.TEST  ',
    },
    reason: '  Reviewed updated contact  ',
  });
  assert.equal(normalized.status, 201);
  assert.equal(normalized.data.context.settings.name.length, 300);
  assert.equal(normalized.data.context.settings.email, 'clinic@example.test');
  assert.equal(normalized.data.change.reason, 'Reviewed updated contact');
  const unchanged = await f.profileBody(profileOf(normalized.data.context.settings));
  const before = f.state();
  assert.equal((await f.call(`${basePath}/profile`, f.admin, 'POST', unchanged)).status, 400);
  assert.deepEqual(f.state(), before);
  const noModules = { ...moduleBody, modules: c.settings.modules };
  assert.equal((await f.call(`${basePath}/modules`, f.admin, 'POST', noModules)).status, 400);
});

test('exact retries preserve original event/receipt while returning newer context; UUID collisions bind actor/scope/payload/revision', async (t) => {
  const f = await fixture(t),
    first = await f.saveProfile({ name: 'Original reviewed clinic' });
  await f.saveProfile({ name: 'Later clinic' });
  await f.saveModules();
  const user = get<User>(f.db, 'users', f.admin.user.id)!;
  f.db
    .prepare('UPDATE users SET data=? WHERE id=?')
    .run(JSON.stringify({ ...user, name: 'Renamed admin' }), user.id);
  const retry = await f.call(`${basePath}/profile`, f.admin, 'POST', {
    ...first.body,
    requestId: first.body.requestId.toUpperCase(),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.change, first.value.change);
  assert.deepEqual(retry.data.receipt, first.value.receipt);
  assert.equal(retry.data.context.settings.name, 'Later clinic');
  assert.equal(retry.data.context.settings.modules.followUp, false);
  assert.deepEqual(first.value.receipt, {
    requestId: first.body.requestId,
    actorId: user.id,
    scope: 'profile',
    expectedRevision: first.body.expectedRevision,
    changeId: first.value.change.id,
  });
  for (const fields of [
    { reason: 'Different reason' },
    { expectedRevision: retry.data.context.profileRevision },
    { profile: { ...first.body.profile, name: 'Another name' } },
  ])
    assert.equal(
      (await f.call(`${basePath}/profile`, f.admin, 'POST', { ...first.body, ...fields })).status,
      409,
    );
  assert.equal(
    (
      await f.call(
        `${basePath}/modules`,
        f.admin,
        'POST',
        await f.modulesBody({}, { requestId: first.body.requestId }),
      )
    ).status,
    409,
  );
  const doctor = await f.login('doctor'),
    account = get<User>(f.db, 'users', doctor.user.id)!;
  f.db
    .prepare("UPDATE users SET role='admin',data=? WHERE id=?")
    .run(JSON.stringify({ ...account, role: 'admin' }), account.id);
  assert.equal((await f.call(`${basePath}/profile`, doctor, 'POST', first.body)).status, 409);
});

test('legacy partial PATCH remains compatible, records only changed scopes, strips unknown fields and creates no invented review', async (t) => {
  const f = await fixture(t),
    initial = await f.context();
  let r = await f.call('/settings', f.admin, 'PATCH', {
    name: 'Legacy clinic',
    unknown: 'ignored',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Legacy clinic');
  assert.equal('unknown' in r.data, false);
  const profile = await f.context();
  assert.notEqual(profile.profileRevision, initial.profileRevision);
  assert.equal(profile.modulesRevision, initial.modulesRevision);
  assert.equal(profile.latestProfileChange!.source, 'legacy');
  assert.equal(profile.latestProfileChange!.reason, null);
  assert.equal(f.state().clinicConfigurationCommands, 0);
  assert.equal(f.state().clinicConfigurationChanges, 1);
  r = await f.call('/settings', f.admin, 'PATCH', {
    modules: { intake: false, images: false, followUp: false, extra: true },
  });
  assert.equal(r.status, 200);
  const modules = await f.context();
  assert.equal(modules.profileRevision, profile.profileRevision);
  assert.notEqual(modules.modulesRevision, profile.modulesRevision);
  assert.deepEqual(r.data.modules, { intake: false, images: false, followUp: false });
  assert.equal(modules.latestModulesChange!.source, 'legacy');
  r = await f.call('/settings', f.admin, 'PATCH', {
    phone: '123',
    modules: { intake: true, images: true, followUp: true },
  });
  assert.equal(r.status, 200);
  assert.equal(f.state().clinicConfigurationChanges, 4);
  const before = await f.context(),
    count = f.state().clinicConfigurationChanges;
  r = await f.call('/settings', f.admin, 'PATCH', { ignored: true });
  assert.equal(r.status, 200);
  const after = await f.context();
  assert.equal(after.profileRevision, before.profileRevision);
  assert.equal(after.modulesRevision, before.modulesRevision);
  assert.equal(f.state().clinicConfigurationChanges, count);
  assert.equal(
    (await f.call('/settings', f.admin, 'PATCH', { modules: { images: false } })).status,
    400,
  );
});

test('only current administrators read operational history; public settings and care summaries never contain private reason/receipt data', async (t) => {
  const f = await fixture(t),
    body = await f.profileBody();
  for (const role of ['doctor', 'reception', 'patient']) {
    const who = await f.login(role);
    for (const url of [basePath, `${basePath}/history`])
      assert.equal((await f.call(url, who)).status, 403);
    assert.equal((await f.call(`${basePath}/profile`, who, 'POST', body)).status, 403);
    assert.equal((await f.call('/settings', who, 'PATCH', {})).status, 403);
  }
  assert.equal((await f.call(basePath)).status, 401);
  assert.equal(
    (await f.call(`${basePath}/profile`, { ...f.admin, csrf: '' }, 'POST', body)).status,
    403,
  );
  const saved = await f.saveProfile({ name: 'Publicly updated clinic' }),
    patient = await f.login('patient');
  f.db
    .prepare(
      "UPDATE meta SET value=json_set(value,'$.privateMetadata','SECRET_META','$.modules.internal','SECRET_MODULE') WHERE key='settings'",
    )
    .run();
  const publicRead = await f.call('/settings');
  assert.equal(publicRead.data.name, 'Publicly updated clinic');
  assert.deepEqual(
    Object.keys(publicRead.data).sort(),
    ['name', 'tagline', 'phone', 'email', 'address', 'hours', 'timezone', 'modules'].sort(),
  );
  assert.deepEqual(
    Object.keys(publicRead.data.modules).sort(),
    ['intake', 'images', 'followUp'].sort(),
  );
  assert.equal(JSON.stringify(publicRead.data).includes('SECRET'), false);
  const summary = await f.call('/patients/patient-ananya/care-summary', patient);
  assert.equal(summary.status, 200);
  assert.equal(summary.data.clinic.name, 'Publicly updated clinic');
  assert.equal(JSON.stringify(summary.data).includes(privateReason), false);
  assert.equal(JSON.stringify(summary.data).includes(saved.body.requestId), false);
  const history = await f.call(`${basePath}/history`, f.admin);
  for (const value of history.data.items) {
    assert.equal('createdById' in value, false);
    assert.equal('requestId' in value, false);
    assert.equal('expectedRevision' in value, false);
  }
  const publicHTML = await fetch(`${f.base}/library`);
  assert.equal(publicHTML.status, 200);
  const html = await publicHTML.text();
  assert.ok(html.includes('Publicly updated clinic'));
  assert.equal(html.includes(privateReason), false);
  assert.equal(html.includes('SECRET_META'), false);
});

test('all admin read/write/replay paths revalidate session, role, active state, CSRF and MFA inside the transaction', async (t) => {
  const f = await fixture(t),
    profile = await f.saveProfile(),
    modules = await f.saveModules();
  const routes: [string, string, unknown?][] = [
    [basePath, 'GET'],
    [`${basePath}/history`, 'GET'],
    [`${basePath}/profile`, 'POST', profile.body],
    [`${basePath}/profile`, 'POST', await f.profileBody({ name: 'Pending profile' })],
    [`${basePath}/modules`, 'POST', modules.body],
    [`${basePath}/modules`, 'POST', await f.modulesBody()],
    ['/settings', 'PATCH', { name: 'Pending legacy' }],
  ];
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db),
    account = external.prepare('SELECT role,data FROM users WHERE id=?').get(f.admin.user.id)!;
  const session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!,
    columns = Object.keys(session);
  try {
    for (const change of ['revoked', 'expired', 'csrf', 'inactive', 'temporary', 'role', 'mfa'])
      for (const [url, method, body] of routes) {
        let fired = false;
        f.db.exec = ((sql: string) => {
          if (sql === 'BEGIN IMMEDIATE' && !fired) {
            fired = true;
            if (change === 'revoked')
              external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
            if (change === 'expired')
              external
                .prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?')
                .run(f.admin.user.id);
            if (change === 'csrf')
              external
                .prepare("UPDATE sessions SET csrfToken='replaced' WHERE userId=?")
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
                  "UPDATE users SET role='doctor',data=json_set(data,'$.role','doctor') WHERE id=?",
                )
                .run(f.admin.user.id);
            if (change === 'mfa')
              external
                .prepare(
                  'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
                )
                .run(
                  f.admin.user.id,
                  randomUUID(),
                  'synthetic-fixture',
                  new Date().toISOString(),
                  -1,
                );
          }
          return original(sql);
        }) as typeof f.db.exec;
        const before = f.state(),
          r = await f.call(url, f.admin, method, body);
        assert.ok(fired);
        assert.ok([401, 403].includes(r.status), `${change}:${url}:${r.status}`);
        assert.deepEqual(f.state(), before);
        f.db.exec = original;
        external
          .prepare('UPDATE users SET role=?,data=? WHERE id=?')
          .run(account.role as string, account.data as string, f.admin.user.id);
        external.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(f.admin.user.id);
        external
          .prepare(
            `INSERT OR REPLACE INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((key) => session[key]));
      }
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('new mutations and both-group legacy adapter roll back metadata, history, commands and audits at every write boundary', async (t) => {
  for (const point of [
    'meta',
    'event',
    'command',
    'audit',
    'response',
    'legacy-second-event',
    'legacy-general-audit',
  ]) {
    const f = await fixture(t),
      legacy = point.startsWith('legacy'),
      body = legacy
        ? { name: 'Legacy replacement', modules: { intake: false, images: false, followUp: false } }
        : await f.profileBody(),
      original = f.db.prepare.bind(f.db);
    if (point === 'response')
      f.db.prepare = ((sql: string) => {
        const statement = original(sql);
        if (
          sql ===
          'SELECT data FROM clinicConfigurationChanges WHERE scope=? ORDER BY rowid DESC LIMIT 1'
        ) {
          const getter = statement.get.bind(statement);
          statement.get = ((...params: Parameters<typeof statement.get>) => {
            const row = getter(...params);
            if (row) throw new Error('Synthetic context response failure');
            return row;
          }) as typeof statement.get;
        }
        return statement;
      }) as typeof f.db.prepare;
    else {
      const table =
        point === 'meta'
          ? 'meta'
          : point === 'event' || point === 'legacy-second-event'
            ? 'clinicConfigurationChanges'
            : point === 'command'
              ? 'clinicConfigurationCommands'
              : 'audit';
      const condition =
        point === 'meta'
          ? "NEW.key='settings'"
          : point === 'legacy-second-event'
            ? "NEW.scope='modules'"
            : point === 'legacy-general-audit'
              ? "json_extract(NEW.data,'$.action')='updated clinic settings'"
              : point === 'audit'
                ? "json_extract(NEW.data,'$.entityType')='clinic-configuration'"
                : '1';
      f.db.exec(
        `CREATE TRIGGER fail_configuration BEFORE ${point === 'meta' ? 'UPDATE' : 'INSERT'} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic configuration failure'); END`,
      );
    }
    const before = f.state();
    try {
      const r = await f.call(
        legacy ? '/settings' : `${basePath}/profile`,
        f.admin,
        legacy ? 'PATCH' : 'POST',
        body,
      );
      assert.equal(r.status, 500, point);
      assert.deepEqual(f.state(), before, point);
    } finally {
      f.db.prepare = original;
      if (point !== 'response') f.db.exec('DROP TRIGGER fail_configuration');
    }
    const retry = await f.call(
      legacy ? '/settings' : `${basePath}/profile`,
      f.admin,
      legacy ? 'PATCH' : 'POST',
      body,
    );
    assert.equal(retry.status, legacy ? 200 : 201);
    assert.equal(f.state().clinicConfigurationChanges, legacy ? 2 : 1);
    await f.close();
  }
});

test('source reads and legacy merging occur after the write lock, so a concurrent module change is preserved', async (t) => {
  const f = await fixture(t),
    body = await f.profileBody(),
    external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  let fired = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !fired) {
      fired = true;
      external
        .prepare(
          "UPDATE meta SET value=json_set(value,'$.modules.followUp',json('false')) WHERE key='settings'",
        )
        .run();
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const r = await f.call(`${basePath}/profile`, f.admin, 'POST', body);
    assert.equal(r.status, 201);
    assert.ok(fired);
    assert.equal(r.data.context.settings.modules.followUp, false);
  } finally {
    f.db.exec = original;
  }
  fired = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !fired) {
      fired = true;
      external
        .prepare(
          "UPDATE meta SET value=json_set(value,'$.modules.images',json('false')) WHERE key='settings'",
        )
        .run();
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const r = await f.call('/settings', f.admin, 'PATCH', { phone: '9876543210' });
    assert.equal(r.status, 200);
    assert.ok(fired);
    assert.equal(r.data.modules.images, false);
    assert.equal(r.data.modules.followUp, false);
  } finally {
    f.db.exec = original;
    external.close();
  }
  const context = await f.context();
  assert.equal(context.latestModulesChange, null);
  assert.equal(context.latestProfileChange!.source, 'legacy');
});

test('independent application connections preserve different scopes and serialize duplicates or competing same-scope writes', async (t) => {
  const f = await fixture(t),
    g = await fixture(t, f.databasePath),
    profile = await f.profileBody(),
    modules = await f.modulesBody({ images: false });
  const independent = await Promise.all([
    f.call(`${basePath}/profile`, f.admin, 'POST', profile),
    g.call(`${basePath}/modules`, f.admin, 'POST', modules),
  ]);
  assert.deepEqual(
    independent.map((r) => r.status),
    [201, 201],
  );
  const current = await f.context();
  assert.equal(current.settings.name, profile.profile.name);
  assert.deepEqual(current.settings.modules, modules.modules);
  const replayBody = await f.profileBody({ name: 'Same exact command' }),
    duplicates = await Promise.all([
      f.call(`${basePath}/profile`, f.admin, 'POST', replayBody),
      g.call(`${basePath}/profile`, f.admin, 'POST', replayBody),
    ]);
  assert.deepEqual(duplicates.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(duplicates[0].data, duplicates[1].data);
  const source = await f.profileBody({ name: 'First competing clinic' }),
    competing = await Promise.all([
      f.call(`${basePath}/profile`, f.admin, 'POST', source),
      g.call(`${basePath}/profile`, f.admin, 'POST', {
        ...source,
        profile: { ...source.profile, name: 'Second competing clinic' },
        requestId: randomUUID(),
      }),
    ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  assert.equal(f.state().clinicConfigurationChanges, 4);
});

test('history filters and pagination decode only bounded rows, have deterministic ordering, and use scope/history indexes', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 55; i++) {
    await f.saveProfile({ name: `Synthetic clinic ${i}` });
    if (i % 5 === 0) await f.saveModules();
  }
  const original = f.db.prepare.bind(f.db),
    counts: number[] = [],
    queries: { sql: string; params: Parameters<ReturnType<DB['prepare']>['all']> }[] = [];
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (
      sql.startsWith('SELECT data FROM clinicConfigurationChanges') &&
      sql.includes('LIMIT ? OFFSET ?')
    ) {
      const all = statement.all.bind(statement);
      statement.all = ((...params: Parameters<typeof statement.all>) => {
        const rows = all(...params);
        counts.push(rows.length);
        queries.push({ sql, params });
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const all = await f.call(`${basePath}/history?pageSize=25`, f.admin);
    assert.equal(all.data.total, 66);
    assert.equal(all.data.items.length, 25);
    const profile = await f.call(
      `${basePath}/history?scope=profile&page=1000000&pageSize=10`,
      f.admin,
    );
    assert.equal(profile.data.total, 55);
    assert.equal(profile.data.page, 6);
    assert.equal(profile.data.items.length, 5);
    assert.ok(profile.data.items.every((x: { scope: string }) => x.scope === 'profile'));
    const modules = await f.call(`${basePath}/history?scope=modules&pageSize=50`, f.admin);
    assert.equal(modules.data.total, 11);
    assert.equal(modules.data.items.length, 11);
    const expected = original(
      'SELECT id FROM clinicConfigurationChanges ORDER BY createdAt DESC,id DESC LIMIT 25',
    )
      .all()
      .map((row) => row.id);
    assert.deepEqual(
      all.data.items.map((x: { id: string }) => x.id),
      expected,
    );
    assert.ok(counts.every((n) => n <= 25));
    const unfiltered = queries.find((q) => !q.sql.includes('WHERE scope'))!,
      filtered = queries.find((q) => q.sql.includes('WHERE scope'))!;
    assert.match(
      JSON.stringify(original(`EXPLAIN QUERY PLAN ${unfiltered.sql}`).all(...unfiltered.params)),
      /clinic_configuration_history/,
    );
    assert.match(
      JSON.stringify(original(`EXPLAIN QUERY PLAN ${filtered.sql}`).all(...filtered.params)),
      /clinic_configuration_scope_history/,
    );
    const headPlan = original(
      'EXPLAIN QUERY PLAN SELECT data FROM clinicConfigurationChanges WHERE scope=? ORDER BY rowid DESC LIMIT 1',
    ).all('profile');
    assert.match(JSON.stringify(headPlan), /clinic_configuration_scope/);
    assert.doesNotMatch(JSON.stringify(headPlan), /TEMP B-TREE/);
  } finally {
    f.db.prepare = original;
  }
  const external = openDatabase(f.databasePath);
  external.exec('PRAGMA busy_timeout=0');
  let locked = false;
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (sql === 'SELECT count(*) AS n FROM clinicConfigurationChanges') {
      const getter = statement.get.bind(statement);
      statement.get = ((...params: Parameters<typeof statement.get>) => {
        const row = getter(...params);
        assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/);
        locked = true;
        return row;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    assert.equal((await f.call(`${basePath}/history`, f.admin)).status, 200);
    assert.ok(locked);
  } finally {
    f.db.prepare = original;
    external.close();
  }
});

test('profile opening-hours edits never change bookable schedules; module pauses remain enforced by existing care routes', async (t) => {
  const f = await fixture(t),
    doctor = await f.login('doctor'),
    patient = await f.login('patient'),
    before = await f.call('/scheduling', doctor);
  assert.equal(before.status, 200);
  await f.saveProfile({
    hours: 'Informational hours deliberately differ',
    address: 'Updated clinic address',
  });
  const after = await f.call('/scheduling', doctor);
  assert.deepEqual(after.data, before.data);
  await f.saveModules({ intake: false, images: false, followUp: false });
  for (const [url, who] of [
    ['/intakes', patient],
    ['/images', doctor],
    ['/check-ins', patient],
  ] as const) {
    const r = await f.call(url, who, 'POST', {});
    assert.equal(r.status, 403);
    assert.match(r.data.error, /disabled/);
  }
  const record = await f.call('/patients/patient-ananya', doctor);
  assert.equal(record.status, 200);
  assert.ok(record.data.carePlans.length > 0);
  assert.ok(record.data.intakes.length > 0);
});

test('immutable changes and receipts persist across restart without rewriting existing settings or inventing a legacy baseline', async (t) => {
  const f = await fixture(t),
    initial = await f.context(),
    saved = await f.saveProfile({ name: 'Persistent clinic' });
  await f.saveModules();
  const stored = f.db.prepare("SELECT value FROM meta WHERE key='settings'").get()!.value;
  await f.close();
  const g = await fixture(t, f.databasePath);
  const retry = await g.call(`${basePath}/profile`, f.admin, 'POST', saved.body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.change, saved.value.change);
  assert.deepEqual(retry.data.receipt, saved.value.receipt);
  assert.equal(retry.data.context.settings.modules.followUp, false);
  assert.equal(g.db.prepare("SELECT value FROM meta WHERE key='settings'").get()!.value, stored);
  assert.equal(g.state().clinicConfigurationChanges, 2);
  for (const table of ['clinicConfigurationChanges', 'clinicConfigurationCommands']) {
    assert.throws(
      () =>
        g.db.exec(
          `UPDATE ${table} SET ${table.endsWith('Commands') ? 'payload=payload' : 'data=data'}`,
        ),
      /immutable/,
    );
    assert.throws(() => g.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  assert.deepEqual(saved.value.change.before, profileOf(initial.settings));
  assert.equal(saved.value.change.source, 'reviewed');
  const h = await fixture(t);
  h.db
    .prepare(
      "UPDATE meta SET value=json_set(value,'$.name','Established legacy clinic','$.phone','1234567') WHERE key='settings'",
    )
    .run();
  const raw = h.db.prepare("SELECT value FROM meta WHERE key='settings'").get()!.value;
  await h.close();
  const migrated = await fixture(t, h.databasePath),
    c = await migrated.context();
  assert.equal(c.settings.name, 'Established legacy clinic');
  assert.equal(c.latestProfileChange, null);
  assert.equal(c.latestModulesChange, null);
  assert.equal(migrated.state().clinicConfigurationChanges, 0);
  assert.equal(
    migrated.db.prepare("SELECT value FROM meta WHERE key='settings'").get()!.value,
    raw,
  );
});
