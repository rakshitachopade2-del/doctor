import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { createUser, hashPassword, openDatabase, type DB } from '../server/db.ts';
import type { User } from '../shared/types.ts';

const password = 'SyntheticAuthSecurity2026!';
const mfaKey = '87'.repeat(32);
type Client = { cookies: Map<string, string>; csrf?: string; challengeCsrf?: string };
const client = (): Client => ({ cookies: new Map() });

function databasePath(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-auth-security-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'clinic.sqlite');
}

async function fixture(t: TestContext, path = ':memory:', trustProxy = true) {
  const app = createApp({ databasePath: path, demoMode: false, mfaEncryptionKey: mfaKey });
  // Each synthetic network is explicit. A separate test retains the default untrusted proxy.
  app.set('trust proxy', trustProxy ? 1 : false);
  const db = app.locals.db as DB;
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
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
  async function call(
    path: string,
    who = client(),
    method = 'GET',
    body?: unknown,
    network = '192.0.2.1',
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Cookie: [...who.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(who.csrf ? { 'X-CSRF-Token': who.csrf } : {}),
        ...(who.challengeCsrf ? { 'X-MFA-CSRF-Token': who.challengeCsrf } : {}),
        'X-Forwarded-For': network,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie()) {
      const [name, ...parts] = value.split(';')[0].split('='),
        token = parts.join('=');
      if (token) who.cookies.set(name, token);
      else who.cookies.delete(name);
    }
    const data = await response.json();
    if (data.mfaRequired) who.challengeCsrf = data.csrfToken;
    else if (data.csrfToken) who.csrf = data.csrfToken;
    return { status: response.status, headers: response.headers, data };
  }
  function account(overrides: Partial<User> = {}) {
    const id = randomUUID();
    const user: User = {
      id,
      name: 'Synthetic security account',
      email: `security-${id}@example.test`,
      role: 'admin',
      active: true,
      ...overrides,
    };
    createUser(db, user, password);
    return user;
  }
  const login = (
    email: string,
    attemptedPassword = password,
    network = '192.0.2.1',
    who = client(),
  ) => call('/auth/login', who, 'POST', { email, password: attemptedPassword }, network);
  return { app, db, call, account, login, close };
}

const registration = (email: string) => ({
  name: 'Synthetic registration',
  email,
  phone: '9000012345',
  dob: '1990-01-02',
  gender: 'Prefer not to say',
  password,
});

const count = (db: DB, table: string) =>
  Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

function securityAudit(db: DB) {
  return db
    .prepare("SELECT data FROM audit WHERE json_extract(data,'$.entityType')='auth-security'")
    .all()
    .map((row) => JSON.parse(String(row.data)));
}

function subject(db: DB, kind: 'network' | 'identifier', value: string) {
  const key = String(
    db.prepare('SELECT value FROM meta WHERE key=?').get('auth-security-hmac-key-v1')!.value,
  );
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`auth-security-v1:${kind}:${value}`)
    .digest('hex');
}

function budget(db: DB, scope: string, value: string) {
  return db
    .prepare('SELECT * FROM authRateLimits WHERE scope=? AND subjectHash=?')
    .get(scope, subject(db, scope.startsWith('network:') ? 'network' : 'identifier', value));
}

function expireBudgets(db: DB) {
  db.prepare('UPDATE authRateLimits SET windowStart=?').run(Date.now() - 15 * 60_000 - 1);
}

test('network login budget is shared by app instances and restart, with bounded throttle evidence and fixed expiry', async (t) => {
  const path = databasePath(t),
    a = await fixture(t, path),
    b = await fixture(t, path);
  const network = '192.0.2.21';
  const originalKey = a.db
    .prepare('SELECT value FROM meta WHERE key=?')
    .get('auth-security-hmac-key-v1')!.value;
  for (let attempt = 0; attempt < 20; attempt++) {
    const f = attempt % 2 ? a : b;
    assert.equal(
      (await f.login(`absent-${attempt}@example.test`, 'IncorrectSyntheticPassword!', network))
        .status,
      401,
    );
  }
  const full = budget(a.db, 'network:login', network)!;
  assert.equal(full.attempts, 20);
  assert.equal((await b.login('another@example.test', password, network)).status, 429);
  const afterFirstBlock = securityAudit(a.db).length;
  for (let attempt = 0; attempt < 4; attempt++) {
    const blocked = await a.login(`blocked-${attempt}@example.test`, password, network);
    assert.equal(blocked.status, 429);
    const seconds = Number(blocked.headers.get('retry-after'));
    assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 900);
    assert.match(blocked.data.error, new RegExp(`Wait at least ${seconds} seconds`));
  }
  assert.equal(securityAudit(a.db).length, afterFirstBlock);
  assert.equal(budget(a.db, 'network:login', network)!.windowStart, full.windowStart);
  assert.equal(budget(a.db, 'network:login', network)!.attempts, 20);
  await a.close();
  await b.close();
  const restarted = await fixture(t, path);
  assert.equal(
    restarted.db.prepare('SELECT value FROM meta WHERE key=?').get('auth-security-hmac-key-v1')!
      .value,
    originalKey,
  );
  assert.equal((await restarted.login('restart@example.test', password, network)).status, 429);
  expireBudgets(restarted.db);
  assert.equal((await restarted.login('restart@example.test', password, network)).status, 401);
  assert.equal(budget(restarted.db, 'network:login', network)!.attempts, 1);
  assert.equal(budget(restarted.db, 'network:login', network)!.throttleLogged, 0);
});

test('normalized identifier failures span networks and restart and a correct password cannot bypass the fixed lock', async (t) => {
  const path = databasePath(t),
    a = await fixture(t, path),
    b = await fixture(t, path);
  const user = a.account({ email: 'protected-person@example.test' });
  for (let attempt = 0; attempt < 10; attempt++) {
    const f = attempt % 2 ? a : b;
    const email = attempt % 2 ? `  ${user.email.toUpperCase()}  ` : user.email;
    assert.equal(
      (await f.login(email, 'IncorrectSyntheticPassword!', `198.51.100.${attempt + 1}`)).status,
      401,
    );
  }
  assert.equal(budget(a.db, 'identifier:login', user.email)!.attempts, 10);
  assert.equal(
    securityAudit(a.db).filter((event) => event.action === 'authentication failed').length,
    1,
  );
  assert.equal(
    securityAudit(a.db).filter((event) => event.action === 'authentication failure limit reached')
      .length,
    1,
  );
  const blocked = await b.login(user.email, password, '198.51.100.99');
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.headers.getSetCookie(), []);
  await a.close();
  await b.close();
  const restarted = await fixture(t, path);
  assert.equal((await restarted.login(user.email, password, '198.51.100.100')).status, 429);
  restarted.db
    .prepare('UPDATE authRateLimits SET windowStart=? WHERE scope=?')
    .run(Date.now() - 15 * 60_000 - 1, 'identifier:login');
  assert.equal((await restarted.login(user.email, password, '198.51.100.100')).status, 200);
  assert.equal(budget(restarted.db, 'identifier:login', user.email), undefined);
});

test('unknown, inactive and wrong-password failures are generic, redacted and never attributed to an unrelated session', async (t) => {
  const f = await fixture(t),
    signedIn = f.account({ name: 'Unrelated signed-in administrator' });
  const active = f.account({ email: 'sensitive-active@example.test' });
  const inactive = f.account({ email: 'sensitive-inactive@example.test', active: false });
  const who = client();
  assert.equal((await f.login(signedIn.email, password, '203.0.113.1', who)).status, 200);
  const attemptedPassword = 'SecretPasswordMustNeverBeLogged!';
  const emails = [active.email, inactive.email, 'sensitive-unknown@example.test'];
  const responses = [];
  for (const email of emails) {
    responses.push(
      await f.call(
        '/auth/login',
        who,
        'POST',
        { email, password: email === inactive.email ? password : attemptedPassword },
        '203.0.113.92',
        { 'User-Agent': 'Sensitive raw browser identifier' },
      ),
    );
  }
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.deepEqual(response.data, { error: 'Email or password is incorrect.' });
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
  const events = securityAudit(f.db);
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.actorName, 'Unauthenticated');
    assert.equal(event.entityType, 'auth-security');
    assert.match(event.entityId, /^identifier:login:[a-f0-9]{64}$/);
  }
  const persisted = JSON.stringify({
    counters: f.db.prepare('SELECT * FROM authRateLimits').all(),
    events,
  });
  for (const secret of [
    ...emails,
    password,
    attemptedPassword,
    '203.0.113.92',
    'Sensitive raw browser identifier',
    signedIn.name,
    who.csrf!,
    ...who.cookies.values(),
  ]) {
    assert.ok(
      !persisted.includes(secret),
      `Authentication evidence leaked ${secret === attemptedPassword ? 'submitted password' : 'private input'}`,
    );
  }
  for (const row of f.db.prepare('SELECT subjectHash FROM authRateLimits').all())
    assert.match(String(row.subjectHash), /^[a-f0-9]{64}$/);
  assert.equal((await f.call('/session', who)).data.user.id, signedIn.id);
});

test('untrusted forwarding headers cannot split the network budget and trusted mapped IPv4 aliases share it', async (t) => {
  const untrusted = await fixture(t, ':memory:', false);
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(
      (await untrusted.login(`proxy-${attempt}@example.test`, password, `192.0.2.${attempt + 1}`))
        .status,
      401,
    );
  }
  assert.equal(
    (await untrusted.login('proxy-next@example.test', password, '198.51.100.200')).status,
    429,
  );
  assert.equal(count(untrusted.db, 'authRateLimits'), 21);
  const trusted = await fixture(t);
  assert.equal((await trusted.login('mapped-one@example.test', password, '192.0.2.7')).status, 401);
  assert.equal(
    (await trusted.login('mapped-two@example.test', password, '::ffff:192.0.2.7')).status,
    401,
  );
  assert.equal(budget(trusted.db, 'network:login', '192.0.2.7')!.attempts, 2);
  assert.equal(
    (await trusted.login('v6-first@example.test', password, '2001:0db8:0:0:0:0:0:2')).status,
    401,
  );
  assert.equal(
    (await trusted.login('v6-second@example.test', password, '2001:db8::2')).status,
    401,
  );
  assert.equal(budget(trusted.db, 'network:login', '2001:db8::2')!.attempts, 2);
  assert.equal(
    trusted.db.prepare("SELECT count(*) n FROM authRateLimits WHERE scope='network:login'").get()!
      .n,
    2,
  );
});

test('successful password login clears only its identifier failures and retains the network and other-account budgets', async (t) => {
  const f = await fixture(t),
    user = f.account(),
    other = f.account();
  for (let attempt = 0; attempt < 4; attempt++)
    assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
  assert.equal((await f.login(other.email, 'WrongSyntheticPassword!')).status, 401);
  const who = client();
  assert.equal((await f.login(user.email, password, '192.0.2.1', who)).status, 200);
  assert.equal(budget(f.db, 'identifier:login', user.email), undefined);
  assert.equal(budget(f.db, 'identifier:login', other.email)!.attempts, 1);
  assert.equal(budget(f.db, 'network:login', '192.0.2.1')!.attempts, 6);
  assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
  assert.equal(budget(f.db, 'identifier:login', user.email)!.attempts, 1);
  assert.equal(
    securityAudit(f.db).filter((entry) => entry.action === 'authentication failed').length,
    3,
  );
});

test('malformed logins use only the network budget and retry hints account for the longest existing block', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call('/auth/login', client(), 'POST', { email: 'not-an-email', password: '' })).status,
    400,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM authRateLimits WHERE scope='identifier:login'").get()!.n,
    0,
  );
  assert.equal(budget(f.db, 'network:login', '192.0.2.1')!.attempts, 1);
  const user = f.account();
  assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
  const current = Date.now();
  f.db
    .prepare("UPDATE authRateLimits SET attempts=20,windowStart=? WHERE scope='network:login'")
    .run(current - 840_000);
  f.db
    .prepare("UPDATE authRateLimits SET attempts=10,windowStart=? WHERE scope='identifier:login'")
    .run(current - 300_000);
  const blocked = await f.login(user.email);
  assert.equal(blocked.status, 429);
  const seconds = Number(blocked.headers.get('retry-after'));
  assert.ok(
    seconds >= 595 && seconds <= 600,
    `Expected identifier's remaining window, got ${seconds}`,
  );
  assert.match(blocked.data.error, new RegExp(`Wait at least ${seconds} seconds`));
});

test('authentication evidence failures roll back the failure counter and never permit a successful response', async (t) => {
  const f = await fixture(t),
    user = f.account();
  f.db.exec(
    "CREATE TRIGGER synthetic_auth_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='auth-security' BEGIN SELECT RAISE(ABORT,'Synthetic authentication evidence failure'); END;",
  );
  const rejected = await f.login(user.email, 'WrongSyntheticPassword!');
  assert.equal(rejected.status, 500);
  assert.deepEqual(rejected.headers.getSetCookie(), []);
  assert.equal(budget(f.db, 'identifier:login', user.email), undefined);
  assert.equal(securityAudit(f.db).length, 0);
  assert.equal(count(f.db, 'sessions'), 0);
  f.db.exec('DROP TRIGGER synthetic_auth_audit_failure');
  assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
  assert.equal(budget(f.db, 'identifier:login', user.email)!.attempts, 1);
  f.db.prepare("UPDATE authRateLimits SET attempts=9 WHERE scope='identifier:login'").run();
  f.db.exec(
    "CREATE TRIGGER synthetic_auth_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='auth-security' BEGIN SELECT RAISE(ABORT,'Synthetic authentication evidence failure'); END;",
  );
  assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 500);
  assert.equal(budget(f.db, 'identifier:login', user.email)!.attempts, 9);
  f.db.exec('DROP TRIGGER synthetic_auth_audit_failure');
  assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
  assert.equal(budget(f.db, 'identifier:login', user.email)!.attempts, 10);
  f.db.exec(
    "CREATE TRIGGER synthetic_auth_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='auth-security' BEGIN SELECT RAISE(ABORT,'Synthetic authentication evidence failure'); END;",
  );
  assert.equal((await f.login(user.email)).status, 500);
  assert.equal(budget(f.db, 'identifier:login', user.email)!.throttleLogged, 0);
  f.db.exec('DROP TRIGGER synthetic_auth_audit_failure');
  assert.equal((await f.login(user.email)).status, 429);
  assert.equal(budget(f.db, 'identifier:login', user.email)!.throttleLogged, 1);
  assert.equal(
    securityAudit(f.db).filter((event) => event.action === 'authentication throttled').length,
    1,
  );
});

for (const failure of ['audit', 'sessions'] as const) {
  test(`failed ${failure} persistence during successful login does not erase prior identifier failures`, async (t) => {
    const f = await fixture(t),
      user = f.account();
    assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
    f.db.exec(`CREATE TRIGGER synthetic_login_failure BEFORE INSERT ON ${failure}
      ${failure === 'audit' ? "WHEN json_extract(NEW.data,'$.action')='signed in'" : ''}
      BEGIN SELECT RAISE(ABORT,'Synthetic successful-login persistence failure'); END;`);
    const failed = await f.login(user.email);
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.headers.getSetCookie(), []);
    assert.equal(budget(f.db, 'identifier:login', user.email)!.attempts, 1);
    assert.equal(count(f.db, 'sessions'), 0);
    f.db.exec('DROP TRIGGER synthetic_login_failure');
    assert.equal((await f.login(user.email)).status, 200);
    assert.equal(budget(f.db, 'identifier:login', user.email), undefined);
  });
}

for (const failure of ['audit', 'sessions'] as const) {
  test(`registration rolls back patient, account, audit and session when ${failure} persistence fails`, async (t) => {
    const f = await fixture(t);
    const input = registration(`rollback-${failure}@example.test`);
    const before = ['patients', 'users', 'audit', 'sessions'].map((table) => count(f.db, table));
    f.db.exec(`CREATE TRIGGER synthetic_signup_failure BEFORE INSERT ON ${failure}
      ${failure === 'audit' ? "WHEN json_extract(NEW.data,'$.action')='registered'" : ''}
      BEGIN SELECT RAISE(ABORT,'Synthetic signup persistence failure'); END;`);
    const rejected = await f.call('/auth/register', client(), 'POST', input);
    assert.equal(rejected.status, 500);
    assert.deepEqual(rejected.headers.getSetCookie(), []);
    assert.deepEqual(
      ['patients', 'users', 'audit', 'sessions'].map((table) => count(f.db, table)),
      before,
    );
    f.db.exec('DROP TRIGGER synthetic_signup_failure');
    const who = client();
    const saved = await f.call('/auth/register', who, 'POST', input);
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal(saved.data.user.role, 'patient');
    assert.equal(saved.data.user.email, input.email);
    assert.equal(count(f.db, 'patients'), 1);
    assert.equal(count(f.db, 'users'), 1);
    assert.equal(count(f.db, 'sessions'), 1);
    assert.equal((await f.call('/session', who)).data.user.id, saved.data.user.id);
    const audits = f.db
      .prepare('SELECT data FROM audit')
      .all()
      .map((row) => JSON.parse(String(row.data)));
    assert.equal(audits.filter((entry) => entry.action === 'registered').length, 1);
  });
}

test('simultaneous case-variant registrations across app instances create one linked patient account', async (t) => {
  const path = databasePath(t),
    a = await fixture(t, path),
    b = await fixture(t, path);
  const email = 'concurrent-registration@example.test';
  const responses = await Promise.all([
    a.call('/auth/register', client(), 'POST', registration(email)),
    b.call('/auth/register', client(), 'POST', registration(email.toUpperCase())),
  ]);
  assert.deepEqual(responses.map((value) => value.status).sort(), [201, 409]);
  const created = responses.find((value) => value.status === 201)!;
  const denied = responses.find((value) => value.status === 409)!;
  assert.deepEqual(denied.headers.getSetCookie(), []);
  assert.equal(count(a.db, 'patients'), 1);
  assert.equal(count(b.db, 'users'), 1);
  assert.equal(count(a.db, 'sessions'), 1);
  const patient = a.db
    .prepare('SELECT data FROM patients WHERE id=?')
    .get(created.data.user.patientId)!;
  assert.equal(JSON.parse(String(patient.data)).email, email);
  assert.equal((await a.login(email)).status, 200);
});

test('registration, password changes and recovery routes retain independent network limits across restart', async (t) => {
  const path = databasePath(t),
    f = await fixture(t, path),
    user = f.account(),
    who = client();
  assert.equal((await f.login(user.email, password, '192.0.2.66', who)).status, 200);
  const routes = [
    { path: '/auth/register', scope: 'register', limit: 10, body: {} },
    {
      path: '/auth/password',
      scope: 'change-password',
      limit: 10,
      body: {
        currentPassword: 'IncorrectSyntheticPassword!',
        newPassword: 'ChangedSyntheticPassword2026!',
      },
    },
    {
      path: `/accounts/${user.id}/recovery`,
      scope: 'issue-recovery',
      limit: 10,
      body: { identityVerified: false },
    },
    {
      path: '/auth/recover',
      scope: 'redeem-recovery',
      limit: 20,
      body: { token: 'invalid-token', password },
    },
  ];
  for (const route of routes) {
    for (let attempt = 0; attempt < route.limit; attempt++) {
      const response = await f.call(route.path, who, 'POST', route.body, '192.0.2.66');
      assert.equal(
        response.status,
        400,
        `${route.scope} attempt ${attempt + 1}: ${JSON.stringify(response.data)}`,
      );
    }
    assert.equal((await f.call(route.path, who, 'POST', route.body, '192.0.2.66')).status, 429);
    assert.equal(budget(f.db, `network:${route.scope}`, '192.0.2.66')!.attempts, route.limit);
  }
  await f.close();
  const restarted = await fixture(t, path);
  for (const route of routes)
    assert.equal(
      (await restarted.call(route.path, who, 'POST', route.body, '192.0.2.66')).status,
      429,
    );
  assert.equal((await restarted.call('/session', who)).data.user.id, user.id);
  assert.equal(count(restarted.db, 'patients'), 0);
  assert.equal(count(restarted.db, 'recoveryGrants'), 0);
});

function referenceTotp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    assert.ok(index >= 0);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8)
    bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('a committed MFA password challenge clears password failures but cannot clear the separate factor budget or grant a session', async (t) => {
  const f = await fixture(t),
    user = f.account(),
    who = client();
  assert.equal((await f.login(user.email, password, '192.0.2.1', who)).status, 200);
  const state = await f.call('/auth/mfa', who);
  const prepared = await f.call('/auth/mfa/enrollment/prepare', who, 'POST', {
    currentPassword: password,
    expectedRevision: state.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const enabled = await f.call('/auth/mfa/enrollment/confirm', who, 'POST', {
    pendingId: prepared.data.setup.id,
    code: referenceTotp(prepared.data.setup.secret),
    savedRecoveryCodes: true,
    expectedRevision: prepared.data.status.revision,
    requestId: randomUUID(),
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
  assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
  f.db
    .prepare('INSERT INTO mfaAttempts(userId,windowStart,failures) VALUES (?,?,?)')
    .run(user.id, Date.now(), 9);
  const guest = client();
  const challenge = await f.login(user.email, password, '192.0.2.1', guest);
  assert.equal(challenge.status, 202, JSON.stringify(challenge.data));
  assert.equal(challenge.data.accountId, user.id);
  assert.equal(challenge.data.user, undefined);
  assert.equal(budget(f.db, 'identifier:login', user.email), undefined);
  assert.equal(
    f.db.prepare('SELECT failures FROM mfaAttempts WHERE userId=?').get(user.id)!.failures,
    9,
  );
  assert.equal((await f.call('/session', guest)).data.user, null);
  assert.equal((await f.call('/patients', guest)).status, 401);
  const proof = await f.call('/auth/mfa/verify', guest, 'POST', {
    proof: { method: 'recovery-code', code: '0'.repeat(32) },
  });
  assert.equal(proof.status, 400);
  assert.equal(
    f.db.prepare('SELECT failures FROM mfaAttempts WHERE userId=?').get(user.id)!.failures,
    10,
  );
  const validButLocked = await f.call('/auth/mfa/verify', guest, 'POST', {
    proof: { method: 'recovery-code', code: prepared.data.setup.recoveryCodes[0] },
  });
  assert.equal(validButLocked.status, 429);
  assert.equal((await f.call('/session', guest)).data.user, null);
});

test('logout audit failure preserves the session and pending setup; successful logout revokes only that session atomically', async (t) => {
  const f = await fixture(t),
    user = f.account(),
    who = client(),
    other = client();
  assert.equal((await f.login(user.email, password, '192.0.2.1', who)).status, 200);
  assert.equal((await f.login(user.email, password, '192.0.2.1', other)).status, 200);
  const state = await f.call('/auth/mfa', who);
  const prepared = await f.call('/auth/mfa/enrollment/prepare', who, 'POST', {
    currentPassword: password,
    expectedRevision: state.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const bearer = who.cookies.get('derma_session')!;
  const sessionHash = createHash('sha256').update(bearer).digest('hex');
  assert.ok(f.db.prepare('SELECT id FROM mfaPending WHERE sessionHash=?').get(sessionHash));
  const beforeSessions = count(f.db, 'sessions');
  f.db.exec(
    "CREATE TRIGGER synthetic_logout_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='signed out' BEGIN SELECT RAISE(ABORT,'Synthetic logout audit failure'); END;",
  );
  const failed = await f.call('/auth/logout', who, 'POST', {});
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.headers.getSetCookie(), []);
  assert.equal(who.cookies.get('derma_session'), bearer);
  assert.equal(count(f.db, 'sessions'), beforeSessions);
  assert.ok(f.db.prepare('SELECT id FROM mfaPending WHERE sessionHash=?').get(sessionHash));
  assert.equal((await f.call('/session', who)).data.user.id, user.id);
  f.db.exec('DROP TRIGGER synthetic_logout_audit_failure');
  const loggedOut = await f.call('/auth/logout', who, 'POST', {});
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(loggedOut.data, { ok: true });
  assert.ok(loggedOut.headers.getSetCookie().some((cookie) => /^derma_session=;/.test(cookie)));
  assert.equal(
    f.db.prepare('SELECT tokenHash FROM sessions WHERE tokenHash=?').get(sessionHash),
    undefined,
  );
  assert.equal(
    f.db.prepare('SELECT id FROM mfaPending WHERE sessionHash=?').get(sessionHash),
    undefined,
  );
  assert.equal((await f.call('/session', other)).data.user.id, user.id);
  const replayedCookie = client();
  replayedCookie.cookies.set('derma_session', bearer);
  replayedCookie.csrf = who.csrf;
  assert.equal((await f.call('/patients', replayedCookie)).status, 401);
  assert.equal((await f.call('/auth/logout', replayedCookie, 'POST', {})).status, 401);
  const logoutEvents = f.db
    .prepare("SELECT data FROM audit WHERE json_extract(data,'$.action')='signed out'")
    .all();
  assert.equal(logoutEvents.length, 1);
  assert.equal(JSON.parse(String(logoutEvents[0].data)).actorName, user.name);
  assert.equal(JSON.parse(String(logoutEvents[0].data)).entityId, user.id);
});

for (const failure of ['corrupt', 'missing'] as const) {
  test(`a ${failure} durable limiter key with existing counters fails closed instead of resetting the protection`, async (t) => {
    const path = databasePath(t),
      f = await fixture(t, path);
    assert.equal((await f.login('key-check@example.test', password)).status, 401);
    if (failure === 'corrupt')
      f.db
        .prepare('UPDATE meta SET value=? WHERE key=?')
        .run('not-a-valid-hmac-key', 'auth-security-hmac-key-v1');
    else f.db.prepare('DELETE FROM meta WHERE key=?').run('auth-security-hmac-key-v1');
    await f.close();
    assert.throws(
      () => createApp({ databasePath: path, demoMode: false, mfaEncryptionKey: mfaKey }),
      /auth|authentication|security|key/i,
    );
  });
}

test('bounded expired-counter cleanup cannot retain an expired block for the active network or identifier', async (t) => {
  const f = await fixture(t),
    network = '192.0.2.110',
    email = 'cleanup-target@example.test',
    current = Date.now();
  const write = f.db.prepare(
    'INSERT INTO authRateLimits(scope,subjectHash,windowStart,attempts,throttleLogged) VALUES (?,?,?,?,?)',
  );
  f.db.exec('BEGIN');
  for (let index = 0; index < 1200; index++)
    write.run(
      'network:login',
      createHash('sha256').update(`expired-${index}`).digest('hex'),
      current - 1_800_000 + index,
      20,
      1,
    );
  write.run('network:login', subject(f.db, 'network', network), current - 905_000, 20, 1);
  write.run('identifier:login', subject(f.db, 'identifier', email), current - 903_000, 10, 1);
  f.db.exec('COMMIT');
  assert.equal((await f.login(email, 'WrongSyntheticPassword!', network)).status, 401);
  for (const [scope, value] of [
    ['network:login', network],
    ['identifier:login', email],
  ]) {
    const row = budget(f.db, scope, value)!;
    assert.equal(row.attempts, 1);
    assert.equal(row.throttleLogged, 0);
    assert.ok(Number(row.windowStart) >= current);
  }
  const remaining = Number(
    f.db
      .prepare('SELECT count(*) n FROM authRateLimits WHERE windowStart<=?')
      .get(current - 900_000)!.n,
  );
  assert.ok(
    remaining >= 1200 - 512 && remaining < 1200,
    `Cleanup should be bounded across two limiter transactions, got ${remaining}`,
  );
  assert.equal(securityAudit(f.db).length, 1);
});

for (const concurrentChange of ['password', 'failure-lock'] as const) {
  test(`a concurrent ${concurrentChange} after password verification prevents issuance without clearing failure evidence`, async (t) => {
    const path = databasePath(t),
      f = await fixture(t, path),
      user = f.account();
    assert.equal((await f.login(user.email, 'WrongSyntheticPassword!')).status, 401);
    const external = openDatabase(path);
    external.exec('PRAGMA busy_timeout=0');
    const originalPrepare = f.db.prepare.bind(f.db),
      originalExec = f.db.exec.bind(f.db);
    let verifiedSourceRead = false,
      changed = false,
      sawPasswordLock = false;
    f.db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes('securityVersion FROM users WHERE email=')) {
        const get = statement.get.bind(statement);
        statement.get = ((...args: Parameters<typeof get>) => {
          const row = get(...args);
          assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/);
          sawPasswordLock = true;
          verifiedSourceRead = true;
          return row;
        }) as typeof statement.get;
      }
      return statement;
    }) as typeof f.db.prepare;
    f.db.exec = ((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && verifiedSourceRead && !changed) {
        changed = true;
        if (concurrentChange === 'password')
          external
            .prepare('UPDATE users SET password=? WHERE id=?')
            .run(hashPassword('ConcurrentReplacementPassword2026!'), user.id);
        else
          external
            .prepare("UPDATE authRateLimits SET attempts=10 WHERE scope='identifier:login'")
            .run();
      }
      return originalExec(sql);
    }) as typeof f.db.exec;
    try {
      const response = await f.login(user.email);
      assert.equal(sawPasswordLock, true);
      assert.equal(changed, true);
      assert.equal(
        response.status,
        concurrentChange === 'password' ? 409 : 429,
        JSON.stringify(response.data),
      );
      assert.deepEqual(response.headers.getSetCookie(), []);
      assert.equal(count(f.db, 'sessions'), 0);
      assert.equal(
        budget(f.db, 'identifier:login', user.email)!.attempts,
        concurrentChange === 'password' ? 1 : 10,
      );
      if (concurrentChange === 'failure-lock') {
        assert.ok(Number(response.headers.get('retry-after')) > 0);
        assert.equal(
          securityAudit(f.db).filter((event) => event.action === 'authentication throttled').length,
          1,
        );
      }
    } finally {
      f.db.prepare = originalPrepare;
      f.db.exec = originalExec;
      external.close();
    }
  });
}

test('logout after concurrent session revocation is a no-op success and does not invent an audit event', async (t) => {
  const path = databasePath(t),
    f = await fixture(t, path),
    user = f.account(),
    who = client();
  assert.equal((await f.login(user.email, password, '192.0.2.1', who)).status, 200);
  const tokenHash = createHash('sha256').update(who.cookies.get('derma_session')!).digest('hex');
  const external = openDatabase(path),
    originalExec = f.db.exec.bind(f.db);
  let revoked = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !revoked) {
      external.prepare('DELETE FROM sessions WHERE tokenHash=?').run(tokenHash);
      revoked = true;
    }
    return originalExec(sql);
  }) as typeof f.db.exec;
  try {
    const response = await f.call('/auth/logout', who, 'POST', {});
    assert.equal(revoked, true);
    assert.equal(response.status, 200);
    assert.equal(count(f.db, 'sessions'), 0);
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM audit WHERE json_extract(data,'$.action')='signed out'")
        .get()!.n,
      0,
    );
    assert.equal((await f.call('/session', who)).data.user, null);
  } finally {
    f.db.exec = originalExec;
    external.close();
  }
});
