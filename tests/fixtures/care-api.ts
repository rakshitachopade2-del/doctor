import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createApp } from '../../server/app.ts';
import type { DB } from '../../server/db.ts';
import type { User } from '../../shared/types.ts';

export type Client = { cookie: string; csrf: string; user: User };

export async function careApiFixture(t: TestContext, path?: string) {
  const dir = path ? undefined : mkdtempSync(join(tmpdir(), 'derma-care-api-'));
  const databasePath = path ?? join(dir!, 'clinic.sqlite');
  const app = createApp({ databasePath, demoMode: true, production: false });
  const db: DB = app.locals.db;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function close() {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    app.locals.close();
  }
  t.after(async () => {
    await close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  async function call(route: string, who?: Client, body?: unknown) {
    const res = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(who && { Cookie: who.cookie, 'X-CSRF-Token': who.csrf }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, data: await res.json() };
  }
  async function login(role: string): Promise<Client> {
    const r = await call('/auth/login', undefined, {
      email: `${role}@derma.demo`,
      password: 'DemoClinic2026!',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return {
      cookie: r.headers.get('set-cookie')!.split(';')[0],
      csrf: r.data.csrfToken,
      user: r.data.user,
    };
  }
  return { db, databasePath, base, call, login, close };
}

export function changeUser(db: DB, original: User, patch: Partial<User>) {
  const user = { ...original, ...patch };
  db.prepare('UPDATE users SET role=?,data=? WHERE id=?').run(
    user.role,
    JSON.stringify(user),
    user.id,
  );
}

/** A second SQLite connection commits the fixture change after request middleware,
 * immediately before the handler opens its read snapshot or takes its writer lock. */
export async function beforeTransaction<T>(
  db: DB,
  start: string,
  change: () => void,
  request: () => Promise<T>,
) {
  const exec = db.exec;
  let applied = false;
  db.exec = function (sql: string) {
    if (!applied && sql === start) {
      change();
      applied = true;
    }
    return exec.call(db, sql);
  };
  try {
    const result = await request();
    assert.ok(applied, 'the handler opened the expected transaction');
    return result;
  } finally {
    db.exec = exec;
  }
}

/** Exercise both SQLite writers on independent event loops against the same database. */
export async function simultaneousCareRequests(
  fixture: Awaited<ReturnType<typeof careApiFixture>>,
  route: string,
  who: Client,
  body: unknown,
) {
  const program = `
    import { createApp } from './server/app.ts';
    const app = createApp({databasePath: process.argv[1], demoMode: true, production: false});
    const server = app.listen(0, '127.0.0.1', () => process.send(server.address().port));
    process.on('disconnect', () => { server.close(() => app.locals.close()); server.closeAllConnections(); });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program, fixture.databasePath],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  const exited = once(child, 'exit');
  try {
    const port = await Promise.race([
      once(child, 'message').then(([port]) => Number(port)),
      exited.then(() => {
        throw new Error('Second test server exited before startup.');
      }),
    ]);
    const second = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: who.cookie,
          'X-CSRF-Token': who.csrf,
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };
    return await Promise.all([fixture.call(route, who, body), second()]);
  } finally {
    if (child.connected) child.disconnect();
    await exited;
  }
}
