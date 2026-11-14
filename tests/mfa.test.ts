import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createUser, get, hashPassword, openDatabase, type DB } from '../server/db.ts';
import { initializeMfa, invalidateMfaTransient } from '../server/mfa.ts';
import {
  acceptedTotpStep,
  base32,
  fromBase32,
  mfaEncryptionKey,
  mfaHash,
  openMfa,
  sealMfa,
  totpAt,
} from '../server/mfa-crypto.ts';
import type { MfaPreparation, MfaStatus } from '../shared/mfa.ts';
import type { User } from '../shared/types.ts';

const key = 'ab'.repeat(32),
  otherKey = 'cd'.repeat(32),
  password = 'SyntheticMfa2026!';
type Client = {
  cookies: Map<string, string>;
  csrf?: string;
  challengeCsrf?: string;
  userId?: string;
  email?: string;
};
const client = (): Client => ({ cookies: new Map() });
async function fixture(
  t: TestContext,
  options: { path?: string; key?: string; demo?: boolean } = {},
) {
  const app = createApp({
    databasePath: options.path ?? ':memory:',
    demoMode: options.demo ?? false,
    mfaEncryptionKey: options.key ?? key,
  });
  const db = app.locals.db as DB;
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
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
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Cookie: [...who.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(who.csrf ? { 'X-CSRF-Token': who.csrf } : {}),
        ...(who.challengeCsrf ? { 'X-MFA-CSRF-Token': who.challengeCsrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie()) {
      const [name, ...parts] = value.split(';')[0].split('='),
        token = parts.join('=');
      if (!token) who.cookies.delete(name);
      else who.cookies.set(name, token);
    }
    const data = await response.json();
    if (data.mfaRequired) who.challengeCsrf = data.csrfToken;
    else if (data.csrfToken) who.csrf = data.csrfToken;
    return { status: response.status, data, headers: response.headers };
  }
  async function account(role: User['role'] = 'admin') {
    const id = randomUUID(),
      email = `${id}@example.test`;
    createUser(db, { id, name: 'Synthetic MFA account', email, role }, password);
    const who = client();
    who.userId = id;
    who.email = email;
    const result = await call('/auth/login', who, 'POST', { email, password });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.match(result.headers.getSetCookie()[0], /^derma_session=/);
    return who;
  }
  async function status(who: Client): Promise<MfaStatus> {
    const r = await call('/auth/mfa', who);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  async function prepare(who: Client): Promise<MfaPreparation> {
    const state = await status(who);
    const r = await call('/auth/mfa/enrollment/prepare', who, 'POST', {
      currentPassword: password,
      expectedRevision: state.revision,
      requestId: randomUUID(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  async function enroll(who: Client) {
    const prepared = await prepare(who);
    const input = {
      pendingId: prepared.setup.id,
      code: totpAt(fromBase32(prepared.setup.secret!), Date.now()),
      savedRecoveryCodes: true,
      expectedRevision: prepared.status.revision,
      requestId: randomUUID(),
    };
    const result = await call('/auth/mfa/enrollment/confirm', who, 'POST', input);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return { prepared, input, result };
  }
  async function challenge(who: Client, target = client(), pass = password) {
    const r = await call('/auth/login', target, 'POST', { email: who.email, password: pass });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    assert.equal(r.data.accountId, who.userId);
    assert.equal(r.data.user, undefined);
    return target;
  }
  const verify = (who: Client, code: string, method = 'recovery-code') =>
    call('/auth/mfa/verify', who, 'POST', { proof: { method, code } });
  return { app, db, call, account, status, prepare, enroll, challenge, verify, close };
}
function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-mfa-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'clinic.sqlite');
}

test('TOTP matches RFC 6238 vectors, bounded clock tolerance and malformed proof handling', () => {
  const cases = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ] as const;
  for (const [seconds, sha1, sha256, sha512] of cases) {
    assert.equal(totpAt(Buffer.from('12345678901234567890'), seconds * 1000, 8, 'sha1'), sha1);
    assert.equal(
      totpAt(Buffer.from('12345678901234567890123456789012'), seconds * 1000, 8, 'sha256'),
      sha256,
    );
    assert.equal(
      totpAt(
        Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
        seconds * 1000,
        8,
        'sha512',
      ),
      sha512,
    );
  }
  const bytes = Buffer.from('12345678901234567890'),
    secret = base32(bytes),
    now = 1234567890000,
    step = Math.floor(now / 30000);
  assert.deepEqual(fromBase32(secret), bytes);
  for (const offset of [-1, 0, 1])
    assert.equal(
      acceptedTotpStep(secret, totpAt(bytes, (step + offset) * 30000), now, -1),
      step + offset,
    );
  assert.equal(acceptedTotpStep(secret, totpAt(bytes, now), now, step), null);
  assert.equal(acceptedTotpStep(secret, '123', now, -1), null);
  assert.equal(acceptedTotpStep(secret, totpAt(bytes, (step - 2) * 30000), now, -1), null);
  assert.throws(() => mfaEncryptionKey('bad'), /exactly 64/);
  const sealed = sealMfa(Buffer.from(key, 'hex'), 'account', 'purpose', { secret });
  assert.deepEqual(openMfa(Buffer.from(key, 'hex'), 'account', 'purpose', sealed), { secret });
  assert.throws(() => openMfa(Buffer.from(key, 'hex'), 'other', 'purpose', sealed), /cannot open/);
  assert.throws(
    () => openMfa(Buffer.from(otherKey, 'hex'), 'account', 'purpose', sealed),
    /cannot open/,
  );
});

test('ordinary login and safe own status work without a key; strict schema and temporary sessions cannot enroll', async (t) => {
  const f = await fixture(t, { key: '' }),
    who = await f.account();
  assert.equal((await f.status(who)).available, false);
  assert.equal((await f.call('/auth/mfa')).status, 401);
  assert.equal((await f.call('/auth/mfa?userId=other', who)).status, 400);
  assert.equal(
    (
      await f.call('/auth/mfa/enrollment/prepare', who, 'POST', {
        currentPassword: password,
        expectedRevision: (await f.status(who)).revision,
        requestId: randomUUID(),
      })
    ).status,
    503,
  );
  const user = get<User>(f.db, 'users', who.userId!)!;
  f.db
    .prepare('UPDATE users SET data=? WHERE id=?')
    .run(JSON.stringify({ ...user, mustChangePassword: true }), user.id);
  assert.equal((await f.call('/auth/mfa', who)).status, 403);
});

test('enrollment stages encrypted material, replays exact canonical UUID, isolates sessions and revokes older sessions on confirmation', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    second = client();
  await f.call('/auth/login', second, 'POST', { email: who.email, password });
  const state = await f.status(who),
    requestId = randomUUID();
  const body = {
    currentPassword: password,
    expectedRevision: state.revision,
    requestId: requestId.toUpperCase(),
  };
  const first = await f.call('/auth/mfa/enrollment/prepare', who, 'POST', body);
  assert.equal(first.status, 200);
  assert.equal(first.data.event.requestId, requestId);
  const replay = await f.call('/auth/mfa/enrollment/prepare', who, 'POST', { ...body, requestId });
  assert.deepEqual(replay.data.setup, first.data.setup);
  assert.equal(replay.data.event.id, first.data.event.id);
  assert.equal((await f.status(second)).pending, null);
  assert.equal((await f.call('/auth/mfa/enrollment/prepare', second, 'POST', body)).status, 409);
  assert.equal(
    (
      await f.call('/auth/mfa/enrollment/prepare', who, 'POST', {
        ...body,
        expectedRevision: '0'.repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call('/auth/mfa/enrollment/prepare', who, 'POST', {
        ...body,
        currentPassword: 'wrong',
      })
    ).status,
    400,
  );
  const stored = ['mfaPending', 'mfaEvents', 'mfaCommands', 'audit']
    .map((table) => JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()))
    .join('');
  for (const secret of [password, first.data.setup.secret, ...first.data.setup.recoveryCodes])
    assert.ok(!stored.includes(secret));
  const input = {
    pendingId: first.data.setup.id,
    code: totpAt(fromBase32(first.data.setup.secret), Date.now()),
    savedRecoveryCodes: true,
    expectedRevision: state.revision,
    requestId: randomUUID(),
  };
  assert.equal(
    (
      await f.call('/auth/mfa/enrollment/confirm', who, 'POST', {
        ...input,
        savedRecoveryCodes: false,
      })
    ).status,
    400,
  );
  const result = await f.call('/auth/mfa/enrollment/confirm', who, 'POST', input);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.event.before, { enabled: false, recoveryCodesRemaining: 0 });
  assert.deepEqual(result.data.event.after, { enabled: true, recoveryCodesRemaining: 10 });
  assert.equal((await f.call('/session', second)).data.user, null);
  assert.equal(
    (await f.call('/auth/mfa/enrollment/confirm', who, 'POST', input)).data.event.id,
    result.data.event.id,
  );
  assert.equal((await f.call('/auth/mfa/enrollment/prepare', who, 'POST', body)).status, 410);
  assert.equal(f.db.prepare('SELECT count(*) n FROM mfaPending').get()!.n, 0);
  assert.throws(
    () => f.db.prepare('UPDATE mfaEvents SET operation=?').run('disabled'),
    /immutable/,
  );
  assert.throws(() => f.db.prepare('DELETE FROM mfaCommands').run(), /immutable/);
});

test('expired or superseded preparation cannot reveal retired secrets', async (t) => {
  const f = await fixture(t),
    who = await f.account();
  const body = {
    currentPassword: password,
    expectedRevision: (await f.status(who)).revision,
    requestId: randomUUID(),
  };
  const first = await f.call('/auth/mfa/enrollment/prepare', who, 'POST', body);
  assert.equal(first.status, 200);
  await f.prepare(who);
  assert.equal((await f.call('/auth/mfa/enrollment/prepare', who, 'POST', body)).status, 410);
  const newer = await f.prepare(who);
  f.db.prepare('UPDATE mfaPending SET expiresAt=? WHERE userId=?').run(Date.now() - 1, who.userId!);
  assert.equal(
    (
      await f.call('/auth/mfa/enrollment/confirm', who, 'POST', {
        pendingId: newer.setup.id,
        code: '000000',
        savedRecoveryCodes: true,
        expectedRevision: newer.status.revision,
        requestId: randomUUID(),
      })
    ).status,
    410,
  );
  assert.equal((await f.status(who)).pending, null);
});

test('password challenge clears a prior account session, protects preauth access and uses separate CSRF with one-use codes', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    prior = await f.account();
  const priorToken = prior.cookies.get('derma_session')!,
    { prepared, input } = await f.enroll(who);
  await f.challenge(who, prior);
  assert.equal(prior.cookies.has('derma_session'), false);
  assert.equal(
    f.db.prepare('SELECT 1 FROM sessions WHERE tokenHash=?').get(mfaHash(priorToken)),
    undefined,
  );
  assert.equal((await f.call('/auth/mfa', prior)).status, 401);
  assert.equal((await f.call('/session', prior)).data.user, null);
  const info = await f.call('/auth/mfa/challenge', prior);
  assert.equal(info.data.accountId, who.userId);
  assert.equal(
    (
      await f.call(
        '/auth/mfa/verify',
        prior,
        'POST',
        { proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[0] } },
        { 'X-MFA-CSRF-Token': 'bad' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        '/auth/mfa/verify',
        prior,
        'POST',
        { proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[0] } },
        { Origin: 'https://untrusted.example' },
      )
    ).status,
    403,
  );
  assert.equal((await f.verify(prior, input.code, 'totp')).status, 400);
  const signedIn = await f.verify(
    prior,
    prepared.setup.recoveryCodes[0].toLowerCase().replaceAll('-', ''),
  );
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.user.id, who.userId);
  assert.match(signedIn.headers.getSetCookie()[0], /^derma_session=/);
  assert.equal(prior.cookies.has('derma_mfa_challenge'), false);
  assert.equal((await f.call('/session', prior)).data.user.id, who.userId);
  const next = await f.challenge(who);
  assert.equal((await f.verify(next, prepared.setup.recoveryCodes[0])).status, 400);
  assert.equal((await f.verify(next, prepared.setup.recoveryCodes[1])).status, 200);
});

test('challenge cookies are bounded and expiry/cancel/unknown queries cannot authenticate', async (t) => {
  const f = await fixture(t),
    who = await f.account();
  await f.enroll(who);
  const other = client(),
    login = await f.call('/auth/login', other, 'POST', { email: who.email, password });
  const cookie = login.headers.getSetCookie().find((v) => v.startsWith('derma_mfa_challenge='))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/auth\/mfa/);
  assert.match(cookie, /Max-Age=300/);
  assert.equal((await f.call('/auth/mfa/challenge?extra=1', other)).status, 400);
  assert.equal((await f.call('/auth/mfa/challenge/cancel', other, 'POST', {})).status, 200);
  assert.equal((await f.call('/auth/mfa/challenge', other)).status, 401);
  await f.challenge(who, other);
  f.db.prepare('UPDATE mfaChallenges SET expiresAt=?').run(Date.now() - 1);
  assert.equal((await f.call('/auth/mfa/challenge', other)).status, 401);
});

test('recovery replacement is staged, accepts an explicit refreshed revision and retires old codes only on confirmation', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    { prepared } = await f.enroll(who);
  const body = {
    currentPassword: password,
    proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[0] },
    expectedRevision: (await f.status(who)).revision,
    requestId: randomUUID(),
  };
  const pending = await f.call('/auth/mfa/recovery-codes/prepare', who, 'POST', body);
  assert.equal(pending.status, 200);
  assert.equal(pending.data.setup.secret, undefined);
  assert.equal(pending.data.event.before.recoveryCodesRemaining, 10);
  assert.equal(pending.data.event.after.recoveryCodesRemaining, 9);
  assert.deepEqual(
    (await f.call('/auth/mfa/recovery-codes/prepare', who, 'POST', body)).data.setup,
    pending.data.setup,
  );
  const other = await f.challenge(who);
  assert.equal((await f.verify(other, prepared.setup.recoveryCodes[1])).status, 200);
  const input = {
    pendingId: pending.data.setup.id,
    savedRecoveryCodes: true,
    expectedRevision: pending.data.status.revision,
    requestId: randomUUID(),
  };
  assert.equal((await f.call('/auth/mfa/recovery-codes/confirm', who, 'POST', input)).status, 409);
  const updated = {
    ...input,
    expectedRevision: (await f.status(who)).revision,
    requestId: randomUUID(),
  };
  const confirmed = await f.call('/auth/mfa/recovery-codes/confirm', who, 'POST', updated);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.event.before.recoveryCodesRemaining, 8);
  assert.equal(confirmed.data.event.after.recoveryCodesRemaining, 10);
  assert.equal((await f.call('/session', other)).data.user, null);
  assert.equal(
    (await f.call('/auth/mfa/recovery-codes/confirm', who, 'POST', updated)).data.event.id,
    confirmed.data.event.id,
  );
  const fresh = await f.challenge(who);
  assert.equal((await f.verify(fresh, prepared.setup.recoveryCodes[2])).status, 400);
  assert.equal((await f.verify(fresh, pending.data.setup.recoveryCodes[0])).status, 200);
});

test('disable requires password and factor, returns replayable evidence and clears outstanding recovery access', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    { prepared } = await f.enroll(who);
  f.db
    .prepare('INSERT INTO recoveryGrants VALUES (?,?,?,?)')
    .run('grant', who.userId!, Date.now(), Date.now() + 60000);
  const body = {
    currentPassword: password,
    proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[0] },
    expectedRevision: (await f.status(who)).revision,
    requestId: randomUUID(),
  };
  const result = await f.call('/auth/mfa/disable', who, 'POST', body);
  assert.equal(result.status, 200);
  assert.equal(result.data.event.before.recoveryCodesRemaining, 10);
  assert.deepEqual(result.data.event.after, { enabled: false, recoveryCodesRemaining: 0 });
  assert.equal(
    (await f.call('/auth/mfa/disable', who, 'POST', body)).data.event.id,
    result.data.event.id,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM recoveryGrants').get()!.n, 0);
  const fresh = client();
  assert.equal(
    (await f.call('/auth/login', fresh, 'POST', { email: who.email, password })).status,
    200,
  );
});

test('failed-proof audit persistence rolls back code, challenge and session without emitting successful cookies', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    { prepared } = await f.enroll(who),
    guest = await f.challenge(who);
  const beforeSessions = f.db.prepare('SELECT count(*) n FROM sessions').get()!.n;
  f.db.exec(
    "CREATE TRIGGER mfa_test_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='signed in with MFA' BEGIN SELECT RAISE(ABORT,'Synthetic MFA audit failure'); END",
  );
  const failed = await f.verify(guest, prepared.setup.recoveryCodes[0]);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.headers.getSetCookie(), []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get()!.n, beforeSessions);
  assert.equal((await f.status(who)).recoveryCodesRemaining, 10);
  assert.equal((await f.call('/auth/mfa/challenge', guest)).status, 200);
  f.db.exec('DROP TRIGGER mfa_test_audit_failure');
  assert.equal((await f.verify(guest, prepared.setup.recoveryCodes[0])).status, 200);
});

test('enrollment and code mutation audit failure retains pending material and leaves no partial active factor', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    pending = await f.prepare(who);
  const body = {
    pendingId: pending.setup.id,
    code: totpAt(fromBase32(pending.setup.secret!), Date.now()),
    savedRecoveryCodes: true,
    expectedRevision: pending.status.revision,
    requestId: randomUUID(),
  };
  f.db.exec(
    "CREATE TRIGGER mfa_test_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='MFA enabled' BEGIN SELECT RAISE(ABORT,'Synthetic MFA audit failure'); END",
  );
  assert.equal((await f.call('/auth/mfa/enrollment/confirm', who, 'POST', body)).status, 500);
  assert.equal((await f.status(who)).enabled, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM mfaCredentials').get()!.n, 0);
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM mfaCommands WHERE requestId=?').get(body.requestId)!.n,
    0,
  );
  f.db.exec('DROP TRIGGER mfa_test_audit_failure');
  assert.equal((await f.call('/auth/mfa/enrollment/confirm', who, 'POST', body)).status, 200);
});

test('proof failures remain account-bound across challenges and restart, and the fixed window resets after fifteen minutes', async (t) => {
  const path = directory(t),
    f = await fixture(t, { path }),
    who = await f.account(),
    { prepared } = await f.enroll(who);
  let guest = await f.challenge(who);
  for (let n = 0; n < 10; n++) {
    if (n === 5) guest = await f.challenge(who);
    assert.equal((await f.verify(guest, '00'.repeat(16))).status, 400);
  }
  assert.equal(
    f.db.prepare('SELECT failures FROM mfaAttempts WHERE userId=?').get(who.userId!)!.failures,
    10,
  );
  assert.equal((await f.verify(guest, prepared.setup.recoveryCodes[0])).status, 429);
  await f.close();
  const restarted = await fixture(t, { path });
  assert.equal(
    (await restarted.call('/auth/login', client(), 'POST', { email: who.email, password })).status,
    429,
  );
  restarted.db.prepare('UPDATE mfaAttempts SET windowStart=?').run(Date.now() - 15 * 60000 - 1);
  guest = await restarted.challenge(who);
  assert.equal((await restarted.verify(guest, prepared.setup.recoveryCodes[0])).status, 200);
});

test('failure counter is recorded while the write lock remains held, including the tenth failure', async (t) => {
  const path = directory(t),
    f = await fixture(t, { path }),
    who = await f.account();
  await f.enroll(who);
  const guest = await f.challenge(who);
  f.db.prepare('INSERT INTO mfaAttempts VALUES (?,?,?)').run(who.userId!, Date.now(), 9);
  const external = openDatabase(path);
  external.exec('PRAGMA busy_timeout=0');
  t.after(() => external.close());
  const original = f.db.prepare.bind(f.db);
  let sawLock = false;
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (sql.includes('INSERT INTO mfaAttempts')) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: Parameters<typeof run>) => {
        assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/);
        sawLock = true;
        return run(...args);
      }) as typeof statement.run;
    }
    return statement;
  }) as typeof f.db.prepare;
  assert.equal((await f.verify(guest, '00'.repeat(16))).status, 400);
  f.db.prepare = original;
  assert.equal(sawLock, true);
  assert.equal((await f.verify(guest, '00'.repeat(16))).status, 429);
  assert.equal(external.prepare('SELECT failures FROM mfaAttempts').get()!.failures, 10);
});

test('password recovery preserves the factor while clearing challenges, preparations and prior sessions', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    { prepared } = await f.enroll(who),
    guest = await f.challenge(who);
  await f.call('/auth/mfa/recovery-codes/prepare', who, 'POST', {
    currentPassword: password,
    proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[0] },
    expectedRevision: (await f.status(who)).revision,
    requestId: randomUUID(),
  });
  const token = 'ef'.repeat(32);
  f.db
    .prepare('INSERT INTO recoveryGrants VALUES (?,?,?,?)')
    .run(mfaHash(token), who.userId!, Date.now(), Date.now() + 60000);
  const updatedPassword = 'SyntheticReplacement2026!';
  assert.equal(
    (await f.call('/auth/recover', client(), 'POST', { token, password: updatedPassword })).status,
    200,
  );
  assert.equal((await f.call('/session', who)).data.user, null);
  assert.equal((await f.call('/auth/mfa/challenge', guest)).status, 401);
  assert.equal(f.db.prepare('SELECT count(*) n FROM mfaPending').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM mfaCredentials').get()!.n, 1);
  const next = await f.challenge(who, client(), updatedPassword);
  assert.equal((await f.verify(next, prepared.setup.recoveryCodes[1])).status, 200);
});

test('current password change and account access changes invalidate staged setup and MFA challenges', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    pending = await f.prepare(who);
  assert.equal(
    (
      await f.call('/auth/password', who, 'POST', {
        currentPassword: password,
        newPassword: 'ChangedSynthetic2026!',
      })
    ).status,
    200,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM mfaPending').get()!.n, 0);
  assert.equal(
    (
      await f.call('/auth/mfa/enrollment/confirm', who, 'POST', {
        pendingId: pending.setup.id,
        code: '000000',
        savedRecoveryCodes: true,
        expectedRevision: pending.status.revision,
        requestId: randomUUID(),
      })
    ).status,
    410,
  );
  const other = await f.account();
  await f.enroll(other);
  const guest = await f.challenge(other);
  const user = get<User>(f.db, 'users', other.userId!)!;
  f.db
    .prepare('UPDATE users SET data=? WHERE id=?')
    .run(JSON.stringify({ ...user, active: false }), user.id);
  invalidateMfaTransient(f.db, user.id);
  assert.equal((await f.call('/auth/mfa/challenge', guest)).status, 401);
});

test('missing or wrong keys fail closed on restart; operator reset removes lost-key material and revokes all recovery access', async (t) => {
  const path = directory(t),
    f = await fixture(t, { path }),
    who = await f.account();
  await f.enroll(who);
  f.db
    .prepare('INSERT INTO recoveryGrants VALUES (?,?,?,?)')
    .run('stale-grant', who.userId!, Date.now(), Date.now() + 60000);
  await f.close();
  assert.throws(
    () => createApp({ databasePath: path, demoMode: false, mfaEncryptionKey: '' }),
    /required/,
  );
  assert.throws(
    () => createApp({ databasePath: path, demoMode: false, mfaEncryptionKey: otherKey }),
    /does not match/,
  );
  const env = {
    ...process.env,
    DATABASE_PATH: path,
    MFA_RESET_EMAIL: who.email!,
    MFA_RESET_IDENTITY_VERIFIED: 'true',
    MFA_RESET_REASON: 'Synthetic verified operator reset',
  };
  const denied = spawnSync(process.execPath, ['--import', 'tsx', 'server/reset-mfa.ts'], {
    env: { ...env, MFA_RESET_IDENTITY_VERIFIED: 'false' },
    encoding: 'utf8',
  });
  assert.equal(denied.status, 1);
  const reset = spawnSync(process.execPath, ['--import', 'tsx', 'server/reset-mfa.ts'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /MFA reset recorded/);
  const fresh = await fixture(t, { path, key: otherKey });
  assert.equal(fresh.db.prepare('SELECT count(*) n FROM recoveryGrants').get()!.n, 0);
  assert.equal(fresh.db.prepare('SELECT count(*) n FROM sessions').get()!.n, 0);
  assert.equal(fresh.db.prepare('SELECT count(*) n FROM mfaCredentials').get()!.n, 0);
  const login = client();
  const result = await fresh.call('/auth/login', login, 'POST', { email: who.email, password });
  assert.equal(result.status, 200);
  assert.equal(result.data.user.mustChangePassword, true);
  assert.equal((await fresh.call('/auth/mfa', login)).status, 403);
  assert.equal(
    (
      await fresh.call('/auth/password', login, 'POST', {
        currentPassword: password,
        newPassword: 'OperatorRotated2026!',
      })
    ).status,
    200,
  );
  const state = await fresh.status(login);
  const next = await fresh.call('/auth/mfa/enrollment/prepare', login, 'POST', {
    currentPassword: 'OperatorRotated2026!',
    expectedRevision: state.revision,
    requestId: randomUUID(),
  });
  assert.equal(next.status, 200);
  assert.equal(state.history[0].operation, 'operator-reset');
  assert.equal(state.history[0].createdById, null);
});

test('two live applications cannot create mixed-key MFA data in a previously empty database', async (t) => {
  const path = directory(t),
    first = await fixture(t, { path }),
    second = await fixture(t, { path, key: otherKey });
  const a = await first.account(),
    b = await second.account();
  await first.prepare(a);
  const result = await second.call('/auth/mfa/enrollment/prepare', b, 'POST', {
    currentPassword: password,
    expectedRevision: '0'.repeat(64),
    requestId: randomUUID(),
  });
  assert.equal(result.status, 503);
  assert.equal(first.db.prepare('SELECT count(*) n FROM mfaPending').get()!.n, 1);
  assert.doesNotThrow(() => initializeMfa(first.db, Buffer.from(key, 'hex')));
});

test('revoked full session is rechecked inside management transaction before staged secret replay', async (t) => {
  const path = directory(t),
    f = await fixture(t, { path }),
    who = await f.account(),
    prepared = await f.prepare(who);
  const external = openDatabase(path);
  t.after(() => external.close());
  const original = f.db.exec.bind(f.db);
  let interrupted = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !interrupted) {
      interrupted = true;
      external.prepare('DELETE FROM sessions WHERE userId=?').run(who.userId!);
    }
    return original(sql);
  }) as typeof f.db.exec;
  const result = await f.call('/auth/mfa/enrollment/prepare', who, 'POST', {
    currentPassword: password,
    expectedRevision: prepared.event.expectedRevision,
    requestId: prepared.event.requestId,
  });
  f.db.exec = original;
  assert.equal(interrupted, true);
  assert.equal(result.status, 401);
  assert.equal(result.data.setup, undefined);
});

test('password verification cannot issue a challenge after a concurrent password replacement', async (t) => {
  const path = directory(t),
    f = await fixture(t, { path }),
    who = await f.account();
  await f.enroll(who);
  const external = openDatabase(path);
  t.after(() => external.close());
  const replacement = hashPassword('ExternalNewPassword2026!'),
    original = f.db.exec.bind(f.db);
  let interrupted = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !interrupted) {
      interrupted = true;
      external.prepare('UPDATE users SET password=? WHERE id=?').run(replacement, who.userId!);
    }
    return original(sql);
  }) as typeof f.db.exec;
  const result = await f.call('/auth/login', client(), 'POST', { email: who.email, password });
  f.db.exec = original;
  assert.equal(interrupted, true);
  assert.equal(result.status, 409);
  assert.deepEqual(result.headers.getSetCookie(), []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM mfaChallenges').get()!.n, 0);
});

test('concurrent recovery verification has a single winner and keeps the source proof single-use', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    { prepared } = await f.enroll(who),
    guest = await f.challenge(who);
  const copy: Client = { ...guest, cookies: new Map(guest.cookies) };
  const results = await Promise.all([
    f.verify(guest, prepared.setup.recoveryCodes[0]),
    f.verify(copy, prepared.setup.recoveryCodes[0]),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  assert.equal((await f.status(who)).recoveryCodesRemaining, 9);
});

test('startup key verification holds the writer lock and rebuilds a missing verifier only after decrypting retained material', async (t) => {
  const path = directory(t),
    f = await fixture(t, { path }),
    who = await f.account();
  await f.prepare(who);
  const external = openDatabase(path);
  external.exec('PRAGMA busy_timeout=0');
  t.after(() => external.close());
  f.db.prepare('DELETE FROM meta WHERE key=?').run('mfa-key-check-v1');
  assert.equal((await f.call('/auth/mfa', who)).status, 503);
  assert.throws(() => initializeMfa(f.db, Buffer.from(otherKey, 'hex')), /cannot open/);
  assert.equal(
    f.db.prepare('SELECT value FROM meta WHERE key=?').get('mfa-key-check-v1'),
    undefined,
  );
  const prepare = f.db.prepare.bind(f.db);
  let locked = false;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql === 'SELECT userId,id,secret FROM mfaCredentials') {
      const all = statement.all.bind(statement);
      statement.all = ((...args: Parameters<typeof all>) => {
        assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/);
        locked = true;
        return all(...args);
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  initializeMfa(f.db, Buffer.from(key, 'hex'));
  f.db.prepare = prepare;
  assert.equal(locked, true);
  assert.ok(f.db.prepare('SELECT value FROM meta WHERE key=?').get('mfa-key-check-v1'));
  assert.equal((await f.call('/auth/mfa', who)).status, 200);
});

test('password change cannot resurrect externally revoked access and preserves fresh account metadata', async (t) => {
  const path = directory(t),
    f = await fixture(t, { path }),
    who = await f.account();
  const external = openDatabase(path);
  t.after(() => external.close());
  const user = get<User>(f.db, 'users', who.userId!)!,
    oldPassword = f.db.prepare('SELECT password FROM users WHERE id=?').get(user.id)!.password;
  const exec = f.db.exec.bind(f.db);
  let interrupted = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !interrupted) {
      interrupted = true;
      external.exec('BEGIN IMMEDIATE');
      external
        .prepare('UPDATE users SET data=? WHERE id=?')
        .run(JSON.stringify({ ...user, active: false }), user.id);
      external.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      external.exec('COMMIT');
    }
    return exec(sql);
  }) as typeof f.db.exec;
  const result = await f.call('/auth/password', who, 'POST', {
    currentPassword: password,
    newPassword: 'RejectedReplacement2026!',
  });
  f.db.exec = exec;
  assert.equal(result.status, 401);
  assert.equal(get<User>(f.db, 'users', user.id)!.active, false);
  assert.equal(
    f.db.prepare('SELECT password FROM users WHERE id=?').get(user.id)!.password,
    oldPassword,
  );
  const other = await f.account();
  interrupted = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !interrupted) {
      interrupted = true;
      const current = get<User>(external, 'users', other.userId!)!;
      external
        .prepare('UPDATE users SET data=? WHERE id=?')
        .run(JSON.stringify({ ...current, name: 'Fresh concurrent account name' }), current.id);
    }
    return exec(sql);
  }) as typeof f.db.exec;
  assert.equal(
    (
      await f.call('/auth/password', other, 'POST', {
        currentPassword: password,
        newPassword: 'AcceptedReplacement2026!',
      })
    ).status,
    200,
  );
  f.db.exec = exec;
  assert.equal(get<User>(f.db, 'users', other.userId!)!.name, 'Fresh concurrent account name');
});

test('a newer accepted TOTP step is consumed globally across login and factor-management routes', async (t) => {
  const f = await fixture(t),
    who = await f.account(),
    { prepared } = await f.enroll(who);
  // Start before the current step without sleeping: this changes only the synthetic test credential's replay watermark.
  f.db
    .prepare('UPDATE mfaCredentials SET lastStep=? WHERE userId=?')
    .run(Math.floor(Date.now() / 30000) - 2, who.userId!);
  const code = totpAt(fromBase32(prepared.setup.secret!), Date.now()),
    guest = await f.challenge(who);
  assert.equal((await f.verify(guest, code, 'totp')).status, 200);
  const result = await f.call('/auth/mfa/recovery-codes/prepare', who, 'POST', {
    currentPassword: password,
    proof: { method: 'totp', code },
    expectedRevision: (await f.status(who)).revision,
    requestId: randomUUID(),
  });
  assert.equal(result.status, 400);
  assert.equal((await f.status(who)).recoveryCodesRemaining, 10);
});
