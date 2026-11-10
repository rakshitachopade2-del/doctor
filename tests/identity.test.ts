import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createUser, get, openDatabase } from '../server/db.ts';
import type { User } from '../shared/types.ts';

type Client = { cookie?: string; csrf?: string; userId?: string };
const initialPassword = 'DemoClinic2026!';
const replacementPassword = 'PersonalPassword2026!';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function harness(t: TestContext, databasePath = ':memory:', demoMode = true) {
  const app = createApp({ databasePath, demoMode });
  let server: Server;
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    app.locals.close();
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function call(
    path: string,
    client: Client = {},
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(client.cookie ? { Cookie: client.cookie } : {}),
        ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (response.headers.get('set-cookie'))
      client.cookie = response.headers.get('set-cookie')!.split(';')[0];
    if (data.csrfToken) client.csrf = data.csrfToken;
    if (data.user?.id) client.userId = data.user.id;
    return { status: response.status, data, response };
  }
  async function login(email: string, password = initialPassword, userAgent?: string) {
    const client: Client = {};
    const result = await call(
      '/auth/login',
      client,
      'POST',
      { email: email.includes('@') ? email : `${email}@derma.demo`, password },
      userAgent ? { 'User-Agent': userAgent } : {},
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return client;
  }
  return { app, db: app.locals.db as ReturnType<typeof openDatabase>, call, login };
}

test('account administration enforces role linkage and protects the last administrator and patient identity', async (t) => {
  const { call, login } = await harness(t);
  const admin = await login('admin'),
    patient = await login('patient'),
    reception = await login('reception');
  const accounts = await call('/accounts', admin);
  assert.equal(accounts.status, 200);
  assert.equal(accounts.data.length, 4);
  assert.ok(
    accounts.data.every(
      (account: any) =>
        account.active === true && account.mustChangePassword === false && !('password' in account),
    ),
  );
  assert.equal((await call('/accounts?role=patient&search=ananya', admin)).data.length, 1);
  assert.equal((await call('/accounts?role=invalid', admin)).status, 400);
  assert.equal((await call('/accounts', patient)).status, 403);
  assert.equal((await call('/accounts', reception)).status, 403);
  assert.equal(
    (await call(`/accounts/${admin.userId}`, admin, 'PATCH', { active: false })).status,
    400,
  );
  assert.equal(
    (
      await call(`/accounts/${admin.userId}`, admin, 'PATCH', {
        role: 'receptionist',
        doctorId: null,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(`/accounts/${patient.userId}`, admin, 'PATCH', { role: 'admin' })).status,
    400,
  );
  assert.equal(
    (await call(`/accounts/${reception.userId}`, admin, 'PATCH', { role: 'patient' })).status,
    400,
  );
  assert.equal(
    (await call(`/accounts/${patient.userId}`, admin, 'PATCH', { doctorId: 'doctor-meera' }))
      .status,
    400,
  );
  assert.equal(
    (await call(`/accounts/${reception.userId}`, admin, 'PATCH', { role: 'doctor' })).status,
    400,
  );
  assert.equal(
    (
      await call(`/accounts/${reception.userId}`, admin, 'PATCH', {
        role: 'doctor',
        doctorId: 'missing-doctor',
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(`/accounts/${reception.userId}`, admin, 'PATCH', { doctorId: 'doctor-meera' }))
      .status,
    400,
  );
  assert.equal(
    (await call(`/accounts/${reception.userId}`, admin, 'PATCH', { name: '' })).status,
    400,
  );
  assert.equal((await call(`/accounts/${reception.userId}`, admin, 'PATCH', {})).status, 400);
  assert.equal(
    (await call(`/accounts/${reception.userId}`, patient, 'PATCH', { name: 'Unauthorized' }))
      .status,
    403,
  );
  const renamed = await call(`/accounts/${reception.userId}`, admin, 'PATCH', {
    name: 'Renamed receptionist',
  });
  assert.equal(renamed.status, 200);
  assert.equal((await call('/session', reception)).data.user.name, 'Renamed receptionist');
});

test('temporary staff passwords restrict private APIs until changed while session controls remain available', async (t) => {
  const { call, login } = await harness(t);
  const admin = await login('admin');
  const created = await call('/users', admin, 'POST', {
    name: 'New receptionist',
    email: 'temporary@example.test',
    password: initialPassword,
    role: 'receptionist',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.mustChangePassword, true);
  assert.equal(created.data.active, true);
  const first = await login('temporary@example.test'),
    second = await login('temporary@example.test');
  assert.equal((await call('/session', first)).data.user.mustChangePassword, true);
  for (const path of [
    '/dashboard',
    '/patients',
    '/appointments',
    '/invoices',
    '/accounts',
    '/knowledge/manage',
  ]) {
    const denied = await call(path, first);
    assert.equal(denied.status, 403, path);
    assert.match(denied.data.error, /temporary password/);
  }
  for (const path of [
    '/session',
    '/doctors',
    '/settings',
    '/knowledge',
    '/health',
    '/auth/sessions',
  ])
    assert.equal((await call(path, first)).status, 200, path);
  assert.equal((await call('/auth/sessions/revoke-others', first, 'POST', {})).status, 200);
  assert.equal((await call('/session', second)).data.user, null);
  assert.equal(
    (
      await call('/auth/password', first, 'POST', {
        currentPassword: initialPassword,
        newPassword: initialPassword,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('/auth/password', first, 'POST', {
        currentPassword: 'wrong-password',
        newPassword: replacementPassword,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('/auth/password', first, 'POST', {
        currentPassword: initialPassword,
        newPassword: replacementPassword,
      })
    ).status,
    200,
  );
  assert.equal((await call('/session', first)).data.user.mustChangePassword, false);
  assert.equal((await call('/dashboard', first)).status, 200);
  assert.equal(
    (
      await call('/auth/login', {}, 'POST', {
        email: 'temporary@example.test',
        password: initialPassword,
      })
    ).status,
    401,
  );
});

test('session inventory exposes safe metadata, confines revocation to the owner, and signs out the current session', async (t) => {
  const { call, login } = await harness(t);
  const first = await login(
    'patient',
    initialPassword,
    'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
  );
  const second = await login('patient', initialPassword, 'untrusted <script> string');
  const doctor = await login('doctor');
  const sessions = (await call('/auth/sessions', first)).data;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((session: any) => session.current).length, 1);
  assert.ok(
    sessions.every(
      (session: any) =>
        /^[a-f0-9]{64}$/.test(session.id) &&
        !Number.isNaN(Date.parse(session.createdAt)) &&
        Date.parse(session.expiresAt) > Date.parse(session.createdAt),
    ),
  );
  assert.equal(sessions.find((session: any) => session.current).label, 'Chrome browser');
  assert.equal(sessions.find((session: any) => !session.current).label, 'Browser session');
  assert.ok(!JSON.stringify(sessions).includes('<script>'));
  const doctorId = (await call('/auth/sessions', doctor)).data[0].id;
  assert.equal((await call(`/auth/sessions/${doctorId}`, first, 'DELETE', {})).status, 404);
  const currentId = sessions.find((session: any) => session.current).id;
  assert.equal(
    (await call('/patients', { cookie: `derma_session=${currentId}` })).status,
    401,
    'Session hashes are not bearer tokens',
  );
  const otherId = sessions.find((session: any) => !session.current).id;
  assert.equal((await call(`/auth/sessions/${otherId}`, first, 'DELETE', {})).status, 200);
  assert.equal((await call('/session', second)).data.user, null);
  assert.equal((await call('/session', doctor)).data.user.role, 'doctor');
  const revoked = await call(`/auth/sessions/${currentId}`, first, 'DELETE', {});
  assert.equal(revoked.status, 200);
  assert.match(revoked.response.headers.get('set-cookie')!, /derma_session=;/);
  assert.equal((await call('/session', first)).data.user, null);
});

test('deactivation and role changes revoke sessions and recovery access while preserving records', async (t) => {
  const { call, login, db } = await harness(t);
  const admin = await login('admin'),
    patient = await login('patient'),
    doctor = await login('doctor');
  const originalRecord = (await call('/patients/patient-ananya', patient)).data;
  const grant = await call(`/accounts/${patient.userId}/recovery`, admin, 'POST', {
    identityVerified: true,
  });
  assert.equal(grant.status, 201);
  assert.equal(
    (await call(`/accounts/${patient.userId}`, admin, 'PATCH', { active: false })).status,
    200,
  );
  assert.equal((await call('/session', patient)).data.user, null);
  const deniedLogin = await call('/auth/login', {}, 'POST', {
    email: 'patient@derma.demo',
    password: initialPassword,
  });
  assert.equal(deniedLogin.status, 401);
  assert.equal(deniedLogin.data.error, 'Email or password is incorrect.');
  assert.equal(
    (await call(`/accounts/${patient.userId}/recovery`, admin, 'POST', { identityVerified: true }))
      .status,
    409,
  );
  assert.equal(
    (
      await call('/auth/recover', {}, 'POST', {
        token: grant.data.token,
        password: replacementPassword,
      })
    ).status,
    400,
  );
  const retained = (await call('/patients/patient-ananya', admin)).data;
  assert.deepEqual(retained.patient, originalRecord.patient);
  assert.equal(retained.appointments.length, originalRecord.appointments.length);
  assert.equal(retained.carePlans.length, originalRecord.carePlans.length);
  assert.equal(
    (await call(`/accounts/${patient.userId}`, admin, 'PATCH', { active: true })).status,
    200,
  );
  const reactivated = await login('patient');
  assert.equal((await call('/session', reactivated)).data.user.active, true);
  const roleChange = await call(`/accounts/${doctor.userId}`, admin, 'PATCH', {
    role: 'receptionist',
    doctorId: null,
  });
  assert.equal(roleChange.status, 200);
  assert.equal(roleChange.data.doctorId, undefined);
  assert.equal((await call('/session', doctor)).data.user, null);
  assert.equal((await login('doctor')).userId, doctor.userId);
  // Middleware also rejects an account made inactive outside the management endpoint.
  const current = get<User>(db, 'users', reactivated.userId!)!;
  db.prepare('UPDATE users SET data=? WHERE id=?').run(
    JSON.stringify({ ...current, active: false }),
    current.id,
  );
  assert.equal((await call('/session', reactivated)).data.user, null);
  assert.equal(
    db.prepare('SELECT count(*) AS count FROM sessions WHERE userId=?').get(current.id)!.count,
    0,
  );
});

test('an administrator can hand over their role only when another active administrator remains', async (t) => {
  const { call, login } = await harness(t);
  const admin = await login('admin');
  const backup = await call('/users', admin, 'POST', {
    name: 'Backup administrator',
    email: 'backup@example.test',
    password: initialPassword,
    role: 'admin',
  });
  assert.equal(backup.status, 201);
  const doctors = (await call('/doctors')).data;
  const changed = await call(`/accounts/${admin.userId}`, admin, 'PATCH', {
    role: 'doctor',
    doctorId: doctors[0].id,
  });
  assert.equal(changed.status, 200);
  assert.equal((await call('/session', admin)).data.user, null);
  const nextAdmin = await login('backup@example.test');
  assert.equal(
    (
      await call('/auth/password', nextAdmin, 'POST', {
        currentPassword: initialPassword,
        newPassword: replacementPassword,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(`/accounts/${nextAdmin.userId}`, nextAdmin, 'PATCH', { role: 'receptionist' }))
      .status,
    409,
  );
});

test('verified recovery tokens are hashed, one-use, origin-protected, and revoke every previous session', async (t) => {
  const { call, login, db } = await harness(t);
  const admin = await login('admin'),
    patient = await login('patient'),
    second = await login('patient');
  assert.equal(
    (await call(`/accounts/${patient.userId}/recovery`, admin, 'POST', { identityVerified: false }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(`/accounts/${patient.userId}/recovery`, patient, 'POST', {
        identityVerified: true,
      })
    ).status,
    403,
  );
  const grant = await call(`/accounts/${patient.userId}/recovery`, admin, 'POST', {
    identityVerified: true,
  });
  assert.equal(grant.status, 201);
  assert.match(grant.data.token, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(grant.data.expiresAt) > Date.now() + 29 * 60000);
  const stored = db.prepare('SELECT * FROM recoveryGrants WHERE userId=?').get(patient.userId!);
  assert.equal(stored!.tokenHash, digest(grant.data.token));
  assert.ok(!JSON.stringify(stored).includes(grant.data.token));
  assert.ok(!JSON.stringify((await call('/audit', admin)).data).includes(grant.data.token));
  assert.equal(
    (
      await call(
        '/auth/recover',
        {},
        'POST',
        { token: grant.data.token, password: replacementPassword },
        { Origin: 'https://untrusted.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await call('/auth/recover', {}, 'POST', { token: grant.data.token, password: 'too-short' }))
      .status,
    400,
  );
  const results = await Promise.all([
    call('/auth/recover', {}, 'POST', { token: grant.data.token, password: replacementPassword }),
    call('/auth/recover', {}, 'POST', { token: grant.data.token, password: replacementPassword }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  const success = results.find((result) => result.status === 200)!;
  assert.deepEqual(success.data, { ok: true });
  assert.equal(
    success.response.headers.get('set-cookie'),
    null,
    'Recovery does not log the browser in',
  );
  assert.equal((await call('/session', patient)).data.user, null);
  assert.equal((await call('/session', second)).data.user, null);
  assert.equal(
    (
      await call('/auth/login', {}, 'POST', {
        email: 'patient@derma.demo',
        password: initialPassword,
      })
    ).status,
    401,
  );
  const recovered = await login('patient', replacementPassword);
  assert.equal((await call('/session', recovered)).data.user.mustChangePassword, false);
  assert.equal(
    (
      await call('/auth/recover', {}, 'POST', {
        token: grant.data.token,
        password: 'AnotherPassword2026!',
      })
    ).status,
    400,
  );
});

test('recovery grants expire, supersede older links, and are invalidated by an authenticated password change', async (t) => {
  const { call, login, db } = await harness(t);
  const admin = await login('admin'),
    patient = await login('patient');
  const issue = () =>
    call(`/accounts/${patient.userId}/recovery`, admin, 'POST', { identityVerified: true });
  const first = await issue(),
    second = await issue();
  assert.equal(
    (
      await call('/auth/recover', {}, 'POST', {
        token: first.data.token,
        password: replacementPassword,
      })
    ).status,
    400,
  );
  db.prepare('UPDATE recoveryGrants SET expiresAt=? WHERE tokenHash=?').run(
    Date.now() - 1,
    digest(second.data.token),
  );
  assert.equal(
    (
      await call('/auth/recover', {}, 'POST', {
        token: second.data.token,
        password: replacementPassword,
      })
    ).status,
    400,
  );
  const third = await issue();
  assert.equal(
    (
      await call('/auth/password', patient, 'POST', {
        currentPassword: initialPassword,
        newPassword: replacementPassword,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call('/auth/recover', {}, 'POST', {
        token: third.data.token,
        password: 'AnotherPassword2026!',
      })
    ).status,
    400,
  );
  const fourth = await issue();
  const user = get<User>(db, 'users', patient.userId!)!;
  db.prepare('UPDATE users SET data=? WHERE id=?').run(
    JSON.stringify({ ...user, active: false }),
    user.id,
  );
  assert.equal(
    (
      await call('/auth/recover', {}, 'POST', {
        token: fourth.data.token,
        password: 'AnotherPassword2026!',
      })
    ).status,
    400,
  );
});

test('anonymous recovery is rate limited even when presented with plausible invalid tokens', async (t) => {
  const { call } = await harness(t);
  for (let i = 0; i < 20; i++)
    assert.equal(
      (
        await call('/auth/recover', {}, 'POST', {
          token: randomBytes(32).toString('hex'),
          password: replacementPassword,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await call('/auth/recover', {}, 'POST', {
        token: randomBytes(32).toString('hex'),
        password: replacementPassword,
      })
    ).status,
    429,
  );
});

test('legacy sessions and accounts migrate without granting extra privilege or forcing an unexpected password change', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-identity-'));
  const file = join(directory, 'legacy.sqlite');
  const db = openDatabase(file);
  createUser(
    db,
    { id: 'legacy-admin', name: 'Legacy admin', email: 'legacy@example.test', role: 'admin' },
    initialPassword,
  );
  const rawToken = randomBytes(32).toString('hex'),
    expiresAt = Date.now() + 3600000;
  db.prepare('INSERT INTO sessions(tokenHash,userId,csrfToken,expiresAt) VALUES (?,?,?,?)').run(
    digest(rawToken),
    'legacy-admin',
    'legacy-csrf',
    expiresAt,
  );
  db.close();
  const { call, app } = await harness(t, file, false);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = { cookie: `derma_session=${rawToken}`, csrf: 'legacy-csrf' };
  const session = await call('/session', client);
  assert.equal(session.data.user.active, true);
  assert.equal(session.data.user.mustChangePassword, false);
  assert.equal((await call('/accounts', client)).status, 200);
  const inventory = (await call('/auth/sessions', client)).data;
  assert.equal(inventory[0].label, 'Browser session');
  assert.equal(inventory[0].current, true);
  assert.equal(Date.parse(inventory[0].createdAt), expiresAt - 12 * 3600000);
  assert.ok(
    app.locals.db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .some((column: any) => column.name === 'createdAt'),
  );
});

test('clinic-provisioned patient accounts require initial password rotation and retain their original record linkage', async (t) => {
  const { call, login } = await harness(t);
  const admin = await login('admin');
  const created = await call('/patients', admin, 'POST', {
    name: 'Portal patient',
    email: '',
    phone: '9000000000',
    dob: '',
    gender: 'Prefer not to say',
    allergies: '',
  });
  assert.equal(created.status, 201);
  const provisioned = await call(`/patients/${created.data.id}/portal-account`, admin, 'POST', {
    email: 'portal@example.test',
    password: initialPassword,
    identityVerified: true,
  });
  assert.equal(provisioned.status, 201);
  assert.equal(provisioned.data.mustChangePassword, true);
  const patient = await login('portal@example.test');
  assert.equal((await call(`/patients/${created.data.id}`, patient)).status, 403);
  assert.equal(
    (
      await call('/auth/password', patient, 'POST', {
        currentPassword: initialPassword,
        newPassword: replacementPassword,
      })
    ).status,
    200,
  );
  assert.equal((await call(`/patients/${created.data.id}`, patient)).status, 200);
  assert.equal((await call('/patients/patient-ananya', patient)).status, 403);
});
