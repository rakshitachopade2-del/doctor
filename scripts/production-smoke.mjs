import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32 } from 'node:zlib';

const imageIndex = process.argv.indexOf('--image');
const image = imageIndex >= 0 ? process.argv[imageIndex + 1] : undefined;
if (imageIndex >= 0 && !image) throw new Error('Pass a container image after --image.');
const email = 'smoke-admin@example.test';
const publicOrigin = 'https://clinic.example.test';
const password = randomBytes(24).toString('base64url');
const mfaKey = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'derma-production-'));
const container = `derma-smoke-${randomUUID()}`;
let child;
let containerStarted = false;
let runtimeLog = '';

// Independent authenticator calculation for this synthetic startup check.
function authenticatorCode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret]
    .map((letter) => alphabet.indexOf(letter).toString(2).padStart(5, '0'))
    .join('');
  const bytes = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// Read the ZIP central directory independently of the application's archive writer.
function storedZipEntries(bytes) {
  const end = bytes.length - 22;
  assert.ok(end >= 0);
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt32LE(end + 4), 0);
  assert.equal(bytes.readUInt16LE(end + 20), 0);
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  assert.ok(count >= 3 && count <= 22);
  const start = bytes.readUInt32LE(end + 16);
  assert.equal(start + bytes.readUInt32LE(end + 12), end);
  let cursor = start;
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 10), 0);
    assert.equal(bytes.readUInt16LE(cursor + 8) & 1, 0);
    const length = bytes.readUInt32LE(cursor + 24);
    assert.equal(bytes.readUInt32LE(cursor + 20), length);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.match(
      name,
      /^(?:care-summary\.json|manifest\.json|attachments\/(?:image|document)-[a-f0-9]{64}\.(?:png|jpg|webp|pdf))$/,
    );
    assert.equal(entries.has(name), false);
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 8), 0);
    const localNameLength = bytes.readUInt16LE(local + 26);
    assert.equal(bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8'), name);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    assert.ok(dataStart + length <= start);
    const data = bytes.subarray(dataStart, dataStart + length);
    assert.equal(crc32(data), bytes.readUInt32LE(cursor + 16));
    assert.equal(crc32(data), bytes.readUInt32LE(local + 14));
    entries.set(name, data);
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  return entries;
}

function command(binary, args, env = process.env, input = '') {
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    process.stdout.on('data', (chunk) => {
      output += chunk;
    });
    process.stderr.on('data', (chunk) => {
      output += chunk;
    });
    process.once('error', reject);
    process.once('exit', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`${binary} failed (${code}): ${output}`)),
    );
    process.stdin.end(input);
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Seed historical synthetic visits only in this disposable smoke database. The
// public booking API correctly refuses past visits; production has no fixture route.
async function historicalStateFixtures(appointments, resource) {
  const script = `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[2]);
    const { appointments, resource } = JSON.parse(Buffer.from(process.argv[3], 'base64url'));
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      for (const appointment of appointments) {
        assert.ok(appointment.reason.startsWith('Synthetic historical state smoke'));
        db.prepare('INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)')
          .run(appointment.id, appointment.patientId, appointment.doctorId, appointment.date, appointment.time, appointment.status, JSON.stringify(appointment));
        const snapshot = Object.fromEntries(['id','patientId','patientName','doctorId','doctorName','date','time','mode','status','durationMinutes'].map(key => [key, appointment[key]]));
        const room = Object.fromEntries(['id','name','kind','location'].map(key => [key, resource[key]]));
        const start = Date.parse(appointment.date + 'T' + appointment.time + ':00+05:30');
        db.prepare('INSERT INTO resourceReservations(appointmentId,resourceId,startAt,endAt,data) VALUES (?,?,?,?,?)')
          .run(appointment.id, resource.id, start, start + appointment.durationMinutes * 60000, JSON.stringify({ resource: room, appointment: snapshot }));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  `;
  const payload = Buffer.from(JSON.stringify({ appointments, resource })).toString('base64url');
  if (image)
    await command(
      'docker',
      [
        'exec',
        '-i',
        container,
        'node',
        '--input-type=module',
        '-',
        '/app/data/clinic.sqlite',
        payload,
      ],
      process.env,
      script,
    );
  else
    await command(
      process.execPath,
      ['--input-type=module', '-', join(directory, 'clinic.sqlite'), payload],
      process.env,
      script,
    );
}

try {
  let base;
  if (image) {
    await command(
      'docker',
      [
        'run',
        '--rm',
        '-d',
        '--name',
        container,
        '--init',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '-e',
        'FOLLOW_UP_ESCALATION_AUTO=true',
        '-e',
        'APPOINTMENT_REMINDERS_AUTO=true',
        '-e',
        'MFA_ENCRYPTION_KEY',
        '-e',
        `PUBLIC_SITE_ORIGIN=${publicOrigin}`,
        '-e',
        'PUBLIC_INDEXING_ENABLED=true',
        '-p',
        '127.0.0.1::3001',
        image,
      ],
      { ...process.env, MFA_ENCRYPTION_KEY: mfaKey },
    );
    containerStarted = true;
    const address = await command('docker', ['port', container, '3001/tcp']);
    base = `http://${address}`;
    await command(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        `ADMIN_EMAIL=${email}`,
        '-e',
        'ADMIN_NAME=Smoke Administrator',
        container,
        'node',
        '--import',
        'tsx',
        'server/create-admin.ts',
      ],
      process.env,
      `${password}\n`,
    );
  } else {
    const port = await freePort();
    const env = {
      ...process.env,
      DATABASE_PATH: join(directory, 'clinic.sqlite'),
      DEMO_MODE: 'false',
      NODE_ENV: 'production',
      ADMIN_EMAIL: email,
      ADMIN_NAME: 'Smoke Administrator',
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_ORIGIN: '',
      PUBLIC_SITE_ORIGIN: publicOrigin,
      PUBLIC_INDEXING_ENABLED: 'true',
      TRUST_PROXY: 'false',
      FOLLOW_UP_ESCALATION_AUTO: 'true',
      APPOINTMENT_REMINDERS_AUTO: 'true',
      MFA_ENCRYPTION_KEY: mfaKey,
    };
    await command(
      process.execPath,
      ['--import', 'tsx', 'server/create-admin.ts'],
      env,
      `${password}\n`,
    );
    child = spawn(process.execPath, ['--import', 'tsx', 'server/production.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      runtimeLog += chunk;
    });
    child.stderr.on('data', (chunk) => {
      runtimeLog += chunk;
    });
    base = `http://127.0.0.1:${port}`;
  }
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {}
    if (ready) break;
    await delay(250);
  }
  assert.ok(ready, `Production service did not become ready. ${runtimeLog}`);
  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.demoMode, false);
  assert.equal(session.user, null);
  assert.deepEqual(await (await fetch(`${base}/api/doctors`)).json(), []);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().find((value) => value.startsWith('derma_session='));
  assert.match(cookie, /; Secure/i);
  assert.match(cookie, /; HttpOnly/i);
  assert.match(cookie, /; SameSite=Lax/i);
  const account = await login.json();
  assert.equal(account.user.role, 'admin');
  assert.equal(account.user.mustChangePassword, false);
  const apiHeaders = {
    Cookie: cookie.split(';')[0],
    'X-CSRF-Token': account.csrfToken,
    'Content-Type': 'application/json',
    Origin: base,
  };
  const accounts = await fetch(`${base}/api/accounts`, { headers: apiHeaders });
  assert.equal(accounts.status, 200);
  assert.equal((await accounts.json()).length, 1);
  for (const category of ['patients', 'appointments']) {
    const search = await fetch(`${base}/api/search/${category}`, { headers: apiHeaders });
    assert.equal(search.status, 200);
    assert.match(search.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await search.json(), {
      items: [],
      page: 1,
      pageSize: 25,
      total: 0,
      totalPages: 1,
    });
    assert.equal((await fetch(`${base}/api/search/${category}`)).status, 401);
  }
  const auditSearch = await fetch(`${base}/api/search/audit?action=signed%20in&pageSize=1`, {
    headers: apiHeaders,
  });
  assert.equal(auditSearch.status, 200);
  const auditPage = await auditSearch.json();
  assert.equal(auditPage.items.length, 1);
  assert.equal(auditPage.items[0].action, 'signed in');
  assert.equal(auditPage.items[0].actorName, 'Smoke Administrator');
  assert.equal((await fetch(`${base}/api/search/audit`)).status, 401);
  const configurationPath = '/api/clinic-configuration';
  const privateConfigurationReason = 'Synthetic private clinic configuration reason';
  async function configurationRead(path = configurationPath, headers = apiHeaders) {
    const response = await fetch(`${base}${path}`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('cache-control'), /no-store/);
    return response.json();
  }
  async function configurationWrite(path, body, status = 201, method = 'POST') {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: apiHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }
  const initialConfiguration = await configurationRead();
  assert.equal(initialConfiguration.latestProfileChange, null);
  assert.equal(initialConfiguration.latestModulesChange, null);
  assert.equal((await configurationRead(`${configurationPath}/history`)).total, 0);
  const { modules: initialModules, ...initialProfile } = initialConfiguration.settings;
  const pausedModulesCommand = {
    modules: { ...initialModules, images: false },
    reason: privateConfigurationReason,
    expectedRevision: initialConfiguration.modulesRevision,
    requestId: randomUUID(),
  };
  const pausedModules = await configurationWrite(
    `${configurationPath}/modules`,
    pausedModulesCommand,
  );
  assert.equal(pausedModules.context.profileRevision, initialConfiguration.profileRevision);
  const profileCommand = {
    profile: {
      ...initialProfile,
      name: 'Synthetic Verification Clinic',
      phone: '9000000291',
      email: 'configuration@example.test',
      address: 'Synthetic verification clinic address',
      hours: 'Synthetic public hours; consult the booking calendar',
    },
    reason: privateConfigurationReason,
    expectedRevision: initialConfiguration.profileRevision,
    requestId: randomUUID(),
  };
  const configuredProfile = await configurationWrite(
    `${configurationPath}/profile`,
    profileCommand,
  );
  assert.equal(configuredProfile.context.settings.modules.images, false);
  assert.equal(configuredProfile.context.modulesRevision, pausedModules.context.modulesRevision);
  assert.equal(configuredProfile.change.scope, 'profile');
  assert.equal(configuredProfile.change.source, 'reviewed');
  assert.equal(configuredProfile.receipt.requestId, profileCommand.requestId);
  const legacyConfiguration = await configurationWrite(
    '/api/settings',
    {
      phone: '9000000292',
      ignoredPrivateField: 'MUST_NOT_ENTER_PUBLIC_SETTINGS',
    },
    200,
    'PATCH',
  );
  assert.equal(legacyConfiguration.phone, '9000000292');
  assert.equal(legacyConfiguration.modules.images, false);
  const afterLegacyConfiguration = await configurationRead();
  assert.equal(afterLegacyConfiguration.modulesRevision, pausedModules.context.modulesRevision);
  assert.notEqual(
    afterLegacyConfiguration.profileRevision,
    configuredProfile.context.profileRevision,
  );
  assert.equal(afterLegacyConfiguration.latestProfileChange.source, 'legacy');
  assert.equal(afterLegacyConfiguration.latestProfileChange.reason, null);
  await configurationWrite(
    `${configurationPath}/profile`,
    {
      ...profileCommand,
      requestId: randomUUID(),
      profile: { ...profileCommand.profile, phone: 'STALE' },
    },
    409,
  );
  const restoredModules = await configurationWrite(`${configurationPath}/modules`, {
    modules: initialModules,
    reason: 'Synthetic module restoration after independent profile save',
    expectedRevision: pausedModules.context.modulesRevision,
    requestId: randomUUID(),
  });
  assert.deepEqual(restoredModules.context.settings.modules, initialModules);
  assert.notEqual(restoredModules.context.modulesRevision, initialConfiguration.modulesRevision);
  assert.equal(restoredModules.context.profileRevision, afterLegacyConfiguration.profileRevision);
  await configurationWrite(
    `${configurationPath}/modules`,
    {
      ...pausedModulesCommand,
      requestId: randomUUID(),
    },
    409,
  );
  const configurationReplay = await configurationWrite(
    `${configurationPath}/profile`,
    profileCommand,
    200,
  );
  assert.deepEqual(configurationReplay.change, configuredProfile.change);
  assert.deepEqual(configurationReplay.receipt, configuredProfile.receipt);
  assert.equal(configurationReplay.context.settings.phone, '9000000292');
  assert.deepEqual(configurationReplay.context.settings.modules, initialModules);
  assert.equal((await configurationRead(`${configurationPath}/history?pageSize=10`)).total, 4);
  assert.equal((await configurationRead(`${configurationPath}/history?scope=profile`)).total, 2);
  assert.equal((await configurationRead(`${configurationPath}/history?scope=modules`)).total, 2);
  await configurationWrite('/api/settings', {}, 200, 'PATCH');
  assert.equal((await configurationRead(`${configurationPath}/history`)).total, 4);
  const publicConfiguration = await (await fetch(`${base}/api/settings`)).json();
  assert.deepEqual(publicConfiguration, configurationReplay.context.settings);
  assert.deepEqual(Object.keys(publicConfiguration).sort(), [
    'address',
    'email',
    'hours',
    'modules',
    'name',
    'phone',
    'tagline',
    'timezone',
  ]);
  for (const secret of [
    privateConfigurationReason,
    profileCommand.requestId,
    configuredProfile.change.id,
    'MUST_NOT_ENTER_PUBLIC_SETTINGS',
  ])
    assert.equal(JSON.stringify(publicConfiguration).includes(secret), false);
  for (const path of [configurationPath, `${configurationPath}/history`])
    assert.equal((await fetch(`${base}${path}`)).status, 401);
  const attendanceUrl = `${base}/api/attendance/me`;
  const attendanceResponse = await fetch(attendanceUrl, { headers: apiHeaders });
  assert.equal(attendanceResponse.status, 200);
  assert.match(attendanceResponse.headers.get('cache-control'), /no-store/);
  const attendanceContext = await attendanceResponse.json();
  assert.equal(attendanceContext.staff.id, account.user.id);
  assert.equal(attendanceContext.openShift, null);
  assert.equal((await fetch(attendanceUrl)).status, 401);
  const attendanceDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
  }).format(new Date(attendanceContext.serverNow));
  const attendanceQuery = `from=${attendanceDay}&to=${attendanceDay}`;
  const emptyAttendance = await fetch(`${base}/api/attendance?${attendanceQuery}`, {
    headers: apiHeaders,
  });
  assert.equal(emptyAttendance.status, 200);
  assert.equal((await emptyAttendance.json()).total, 0);
  const clockInBody = {
    requestId: randomUUID(),
    expectedRevision: attendanceContext.revision,
  };
  const clockIn = await fetch(`${base}/api/attendance/clock-in`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify(clockInBody),
  });
  assert.equal(clockIn.status, 201);
  const startedAttendance = await clockIn.json();
  assert.equal(startedAttendance.shift.status, 'open');
  assert.equal(startedAttendance.event.requestId, clockInBody.requestId);
  const repeatedClockIn = await fetch(`${base}/api/attendance/clock-in`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify(clockInBody),
  });
  assert.equal(repeatedClockIn.status, 200);
  assert.equal((await repeatedClockIn.json()).event.id, startedAttendance.event.id);
  const openAttendance = await (await fetch(attendanceUrl, { headers: apiHeaders })).json();
  const clockOut = await fetch(
    `${base}/api/attendance/shifts/${startedAttendance.shift.id}/clock-out`,
    {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: openAttendance.revision,
      }),
    },
  );
  assert.equal(clockOut.status, 200);
  assert.equal((await clockOut.json()).shift.status, 'closed');
  const attendanceHistory = await fetch(
    `${base}/api/attendance/shifts/${startedAttendance.shift.id}`,
    { headers: apiHeaders },
  );
  assert.equal(attendanceHistory.status, 200);
  assert.equal((await attendanceHistory.json()).events.length, 2);
  const schedules = await fetch(`${base}/api/scheduling`, { headers: apiHeaders });
  assert.deepEqual((await schedules.json()).schedules, []);
  const activity = await fetch(`${base}/api/activity`, { headers: apiHeaders });
  assert.equal(activity.status, 200);
  assert.deepEqual((await activity.json()).items, []);
  const followUps = await fetch(`${base}/api/follow-up-worklist`, { headers: apiHeaders });
  assert.equal(followUps.status, 200);
  assert.deepEqual(await followUps.json(), []);
  const escalationPolicyUrl = `${base}/api/follow-up-escalation-policy`;
  const escalationPreviewUrl = `${base}/api/follow-up-escalations/preview`;
  const escalationPolicyResponse = await fetch(escalationPolicyUrl, { headers: apiHeaders });
  assert.equal(escalationPolicyResponse.status, 200);
  assert.match(escalationPolicyResponse.headers.get('cache-control'), /no-store/);
  const escalationPolicy = await escalationPolicyResponse.json();
  assert.deepEqual(escalationPolicy.policy, {
    enabled: false,
    ownerAfterDays: 3,
    clinicAfterDays: 7,
  });
  assert.deepEqual(escalationPolicy.history, []);
  assert.equal(escalationPolicy.worker.automaticEnabled, true);
  assert.equal(escalationPolicy.worker.intervalSeconds, 900);
  assert.ok(escalationPolicy.worker.lastCheckedAt);
  const emptyEscalationPreview = await fetch(escalationPreviewUrl, { headers: apiHeaders });
  assert.equal(emptyEscalationPreview.status, 200);
  assert.equal((await emptyEscalationPreview.json()).status, 'disabled');
  assert.equal((await fetch(escalationPolicyUrl)).status, 401);
  assert.equal((await fetch(escalationPreviewUrl)).status, 401);
  const investigations = await fetch(`${base}/api/investigation-worklist`, { headers: apiHeaders });
  assert.equal(investigations.status, 200);
  const procedureSchedulingUrl = `${base}/api/procedure-scheduling`;
  const emptyProcedureScheduling = await fetch(procedureSchedulingUrl, { headers: apiHeaders });
  assert.equal(emptyProcedureScheduling.status, 200);
  assert.match(emptyProcedureScheduling.headers.get('cache-control'), /no-store/);
  assert.equal((await emptyProcedureScheduling.json()).total, 0);
  assert.equal((await fetch(procedureSchedulingUrl)).status, 401);
  const catalogueUrl = `${base}/api/procedure-catalogue`;
  const emptyCatalogue = await fetch(catalogueUrl, { headers: apiHeaders });
  assert.equal(emptyCatalogue.status, 200);
  assert.match(emptyCatalogue.headers.get('cache-control'), /no-store/);
  assert.equal((await emptyCatalogue.json()).total, 0);
  assert.equal((await fetch(catalogueUrl)).status, 401);
  assert.match(investigations.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await investigations.json(), []);
  const investigationOwners = await fetch(`${base}/api/investigation-owners`, {
    headers: apiHeaders,
  });
  assert.equal(investigationOwners.status, 200);
  assert.deepEqual(await investigationOwners.json(), []);
  assert.equal((await fetch(`${base}/api/investigation-worklist`)).status, 401);
  const resources = await fetch(`${base}/api/clinic-resources`, { headers: apiHeaders });
  assert.equal(resources.status, 200);
  assert.match(resources.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await resources.json(), []);
  assert.equal((await fetch(`${base}/api/clinic-resources`)).status, 401);
  const resourceResponse = await fetch(`${base}/api/clinic-resources`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({
      name: 'Synthetic smoke room',
      kind: 'room',
      location: 'Local test only',
      notes: 'Disposable fixture',
      requestId: randomUUID(),
    }),
  });
  assert.equal(resourceResponse.status, 201);
  const resource = await resourceResponse.json();
  assert.equal(resource.resource.capacity, 1);
  const resourceUpdate = await fetch(`${base}/api/clinic-resources/${resource.resource.id}`, {
    method: 'PATCH',
    headers: apiHeaders,
    body: JSON.stringify({
      active: false,
      reason: 'Archive synthetic test room',
      expectedRevision: resource.resource.revision,
      requestId: randomUUID(),
    }),
  });
  assert.equal(resourceUpdate.status, 200);
  const archivedResource = await resourceUpdate.json();
  assert.equal(archivedResource.resource.active, false);
  assert.equal(archivedResource.changes.length, 2);
  const range = 'from=2026-01-01&to=2026-01-01';
  const reservations = await fetch(`${base}/api/resource-reservations?${range}`, {
    headers: apiHeaders,
  });
  assert.equal(reservations.status, 200);
  assert.deepEqual((await reservations.json()).reservations, []);
  assert.equal((await fetch(`${base}/api/resource-reservations?${range}`)).status, 401);
  const expenses = await fetch(`${base}/api/expenses?${range}`, { headers: apiHeaders });
  assert.equal(expenses.status, 200);
  assert.deepEqual(await expenses.json(), []);
  const insights = await fetch(`${base}/api/insights?${range}`, { headers: apiHeaders });
  assert.equal(insights.status, 200);
  assert.match(insights.headers.get('cache-control'), /no-store/);
  const report = await insights.json();
  assert.equal(report.totals.expensesPaise, 0);
  assert.equal(report.totals.collectionsPaise, 0);
  assert.equal(report.daily.length, 1);
  const exported = await fetch(`${base}/api/insights/export?${range}`, { headers: apiHeaders });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  const inventory = await fetch(`${base}/api/inventory/items`, { headers: apiHeaders });
  assert.equal(inventory.status, 200);
  assert.deepEqual(await inventory.json(), []);
  const itemResponse = await fetch(`${base}/api/inventory/items`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({
      sku: 'SMOKE-SYNTHETIC',
      name: 'Synthetic Smoke Consumable',
      category: 'protective-equipment',
      unit: 'box',
      reorderLevel: 2,
      requestId: randomUUID(),
    }),
  });
  assert.equal(itemResponse.status, 201);
  const item = await itemResponse.json();
  const receiptResponse = await fetch(`${base}/api/inventory/items/${item.item.id}/receipts`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({
      quantity: 5,
      lotCode: 'SMOKE',
      expiryDate: null,
      reason: 'Synthetic production check',
      expectedRevision: item.item.revision,
      requestId: randomUUID(),
    }),
  });
  assert.equal(receiptResponse.status, 201);
  const receipt = await receiptResponse.json();
  assert.equal(receipt.detail.item.onHandQuantity, 5);
  const useResponse = await fetch(`${base}/api/inventory/lots/${receipt.movement.lotId}/use`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({
      quantity: 2,
      reason: 'Synthetic production check',
      expectedRevision: receipt.detail.item.revision,
      requestId: randomUUID(),
    }),
  });
  assert.equal(useResponse.status, 201);
  assert.equal((await useResponse.json()).detail.item.onHandQuantity, 3);
  const createdPatient = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({ name: 'Synthetic Smoke Patient', phone: '9000000099' }),
  });
  assert.equal(createdPatient.status, 201);
  const patient = await createdPatient.json();
  const foundPatient = await fetch(`${base}/api/search/patients?q=Synthetic%20Smoke`, {
    headers: apiHeaders,
  });
  assert.equal(foundPatient.status, 200);
  const patientPage = await foundPatient.json();
  assert.equal(patientPage.total, 1);
  assert.equal(patientPage.items[0].id, patient.id);
  assert.equal('allergies' in patientPage.items[0], false);
  const profileUrl = `${base}/api/patients/${patient.id}/profile`;
  const profileResponse = await fetch(profileUrl, { headers: apiHeaders });
  assert.equal(profileResponse.status, 200);
  const profile = await profileResponse.json();
  const correction = await fetch(profileUrl, {
    method: 'PATCH',
    headers: apiHeaders,
    body: JSON.stringify({
      ...profile.demographics,
      phone: '9000000088',
      reason: 'Synthetic contact correction',
      expectedRevision: profile.revision,
      requestId: randomUUID(),
    }),
  });
  assert.equal(correction.status, 200);
  assert.equal((await correction.json()).changes.length, 1);
  async function visitWrite(path, body, expectedStatus = 200, method = 'POST') {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: apiHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, expectedStatus);
    return response.json();
  }
  const visitDoctor = await visitWrite(
    '/doctors',
    {
      name: 'Synthetic Duration Doctor',
      title: 'Dermatologist',
      qualifications: 'Synthetic verification profile',
      specialties: ['General dermatology'],
      experience: 1,
      fee: 600,
      bio: 'Temporary production verification only.',
      languages: ['English'],
    },
    201,
  );
  const availabilityPath = `/schedules/${visitDoctor.id}/availability`;
  const availabilityUrl = `${base}/api${availabilityPath}`;
  const privateAvailabilityReason = 'Synthetic private weekly availability review';
  async function availabilityRead(suffix = '') {
    const response = await fetch(`${availabilityUrl}${suffix}`, { headers: apiHeaders });
    assert.equal(response.status, 200);
    return response.json();
  }
  const inheritedAvailability = await availabilityRead();
  assert.equal(inheritedAvailability.source, 'inherited');
  assert.equal(inheritedAvailability.latestChange, null);
  assert.equal(inheritedAvailability.schedule.updatedAt, '');
  assert.equal((await availabilityRead('/history')).total, 0);
  const availabilityCommand = {
    schedule: {
      durationMinutes: inheritedAvailability.schedule.durationMinutes,
      windows: inheritedAvailability.schedule.windows,
    },
    reason: privateAvailabilityReason,
    expectedRevision: inheritedAvailability.revision,
    requestId: randomUUID(),
  };
  const firstAvailability = await visitWrite(availabilityPath, availabilityCommand, 201);
  assert.equal(firstAvailability.change.before.source, 'inherited');
  assert.equal(firstAvailability.change.after.source, 'explicit');
  assert.equal(firstAvailability.context.source, 'explicit');
  assert.equal(firstAvailability.receipt.actorId, account.user.id);
  assert.equal(firstAvailability.receipt.doctorId, visitDoctor.id);
  await visitWrite(
    availabilityPath,
    {
      ...availabilityCommand,
      expectedRevision: firstAvailability.context.revision,
      requestId: randomUUID(),
    },
    400,
  );
  const weeklyValues = {
    durationMinutes: 20,
    windows: Array.from({ length: 7 }, (_, day) => ({
      day,
      start: '09:00',
      end: '18:00',
      mode: 'both',
    })),
  };
  const legacyAvailability = await visitWrite(
    `/schedules/${visitDoctor.id}`,
    weeklyValues,
    200,
    'PUT',
  );
  const legacyAvailabilityContext = await availabilityRead();
  assert.deepEqual(legacyAvailabilityContext.schedule, legacyAvailability);
  assert.equal(legacyAvailabilityContext.latestChange.source, 'legacy');
  assert.equal(legacyAvailabilityContext.latestChange.reason, null);
  assert.deepEqual(
    await visitWrite(`/schedules/${visitDoctor.id}`, weeklyValues, 200, 'PUT'),
    legacyAvailability,
  );
  assert.deepEqual(await availabilityRead(), legacyAvailabilityContext);
  const alternateAvailability = await visitWrite(
    availabilityPath,
    {
      schedule: { ...weeklyValues, durationMinutes: 30 },
      reason: privateAvailabilityReason,
      expectedRevision: legacyAvailabilityContext.revision,
      requestId: randomUUID(),
    },
    201,
  );
  const restoredAvailability = await visitWrite(
    availabilityPath,
    {
      schedule: weeklyValues,
      reason: 'Synthetic return to reviewed twenty-minute weekly sessions',
      expectedRevision: alternateAvailability.context.revision,
      requestId: randomUUID(),
    },
    201,
  );
  assert.notEqual(restoredAvailability.context.revision, legacyAvailabilityContext.revision);
  await visitWrite(
    availabilityPath,
    {
      schedule: { ...weeklyValues, durationMinutes: 30 },
      reason: privateAvailabilityReason,
      expectedRevision: legacyAvailabilityContext.revision,
      requestId: randomUUID(),
    },
    409,
  );
  const availabilityReplay = await visitWrite(availabilityPath, availabilityCommand);
  assert.deepEqual(availabilityReplay.change, firstAvailability.change);
  assert.deepEqual(availabilityReplay.receipt, firstAvailability.receipt);
  assert.deepEqual(availabilityReplay.context, restoredAvailability.context);
  const availabilityHistory = await availabilityRead('/history?pageSize=10');
  assert.equal(availabilityHistory.total, 4);
  assert.equal(availabilityHistory.items.filter((item) => item.source === 'legacy').length, 1);
  for (const path of [availabilityUrl, `${availabilityUrl}/history`])
    assert.equal((await fetch(path)).status, 401);
  const operationalAvailability = await (
    await fetch(`${base}/api/scheduling`, { headers: apiHeaders })
  ).json();
  assert.equal(JSON.stringify(operationalAvailability).includes(privateAvailabilityReason), false);
  assert.equal(
    JSON.stringify(operationalAvailability).includes(firstAvailability.change.id),
    false,
  );
  const publicDoctorsAfterAvailability = await (await fetch(`${base}/api/doctors`)).json();
  assert.equal(
    publicDoctorsAfterAvailability.find((item) => item.id === visitDoctor.id)
      .appointmentDurationMinutes,
    20,
  );
  assert.equal(
    JSON.stringify(publicDoctorsAfterAvailability).includes(privateAvailabilityReason),
    false,
  );
  const visitDay = new Date(Date.parse(`${attendanceDay}T12:00:00Z`) + 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  const customBookingBody = {
    patientId: patient.id,
    doctorId: visitDoctor.id,
    date: visitDay,
    time: '09:05',
    mode: 'in-person',
    reason: 'Synthetic extended visit',
    durationMinutes: 90,
    requestId: randomUUID(),
  };
  const customVisit = await visitWrite('/visit-duration/bookings', customBookingBody, 201);
  assert.equal(customVisit.appointment.durationPolicy, 'custom');
  assert.equal(customVisit.appointment.durationMinutes, 90);
  const beforeBlockedAvailability = await availabilityRead();
  await visitWrite(
    availabilityPath,
    {
      schedule: {
        ...weeklyValues,
        windows: weeklyValues.windows.map((window) => ({ ...window, end: '10:00' })),
      },
      reason: 'Synthetic rejected change that would shorten a booked ninety-minute visit',
      expectedRevision: beforeBlockedAvailability.revision,
      requestId: randomUUID(),
    },
    409,
  );
  assert.deepEqual(await availabilityRead(), beforeBlockedAvailability);
  assert.equal((await availabilityRead('/history')).total, 4);
  const protectedVisit = await (
    await fetch(`${base}/api/appointments/${customVisit.appointment.id}/duration`, {
      headers: apiHeaders,
    })
  ).json();
  assert.deepEqual(protectedVisit.appointment, customVisit.appointment);

  const timeOffListUrl = `${base}/api/time-off?doctorId=${visitDoctor.id}&filter=all`;
  const timeOffCommand = {
    closure: {
      doctorId: visitDoctor.id,
      startDate: visitDay,
      endDate: visitDay,
      startTime: '11:00',
      endTime: '12:00',
      reason: 'Synthetic staff-visible time-off label',
    },
    requestId: randomUUID(),
  };
  const createdTimeOff = await visitWrite('/time-off', timeOffCommand, 201);
  const timeOffPath = `/time-off/${createdTimeOff.context.closure.id}`;
  const timeOffUrl = `${base}/api${timeOffPath}`;
  const privateTimeOffReason = 'Synthetic private time-off adjustment';
  async function timeOffRead(suffix = '') {
    const response = await fetch(`${timeOffUrl}${suffix}`, { headers: apiHeaders });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    return response.json();
  }
  async function timeOffSlots() {
    const response = await fetch(
      `${base}/api/slots?doctorId=${visitDoctor.id}&date=${visitDay}&mode=in-person`,
    );
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.equal(createdTimeOff.context.status, 'active');
  assert.equal(createdTimeOff.change.action, 'created');
  assert.equal(createdTimeOff.change.source, 'reviewed');
  assert.equal(createdTimeOff.change.before, null);
  assert.equal(createdTimeOff.change.changeReason, null);
  assert.equal(createdTimeOff.receipt.actorId, account.user.id);
  assert.equal(createdTimeOff.receipt.expectedRevision, null);
  assert.equal((await timeOffSlots()).includes('11:00'), false);
  const timeOffEdit = {
    closure: {
      startDate: visitDay,
      endDate: visitDay,
      startTime: '10:40',
      endTime: '12:00',
      reason: timeOffCommand.closure.reason,
    },
    changeReason: privateTimeOffReason,
    expectedRevision: createdTimeOff.context.revision,
    requestId: randomUUID(),
  };
  await visitWrite(
    `${timeOffPath}/changes`,
    {
      ...timeOffEdit,
      closure: { ...timeOffEdit.closure, startTime: '10:20' },
      requestId: randomUUID(),
    },
    409,
  );
  assert.deepEqual(await timeOffRead(), createdTimeOff.context);
  assert.equal((await timeOffRead('/history')).total, 1);
  const editedTimeOff = await visitWrite(`${timeOffPath}/changes`, timeOffEdit, 201);
  assert.equal(editedTimeOff.context.closure.id, createdTimeOff.context.closure.id);
  assert.equal(editedTimeOff.context.closure.createdAt, createdTimeOff.context.closure.createdAt);
  assert.equal(editedTimeOff.change.changeReason, privateTimeOffReason);
  assert.deepEqual(editedTimeOff.change.before.closure, createdTimeOff.context.closure);
  assert.equal((await timeOffSlots()).includes('10:40'), false);
  await visitWrite(`${timeOffPath}/changes`, { ...timeOffEdit, requestId: randomUUID() }, 409);
  const overlappingClosure = await visitWrite(
    '/schedule-closures',
    {
      ...timeOffCommand.closure,
      startTime: '11:40',
      endTime: '12:20',
      reason: 'Synthetic overlapping compatibility closure',
    },
    201,
  );
  const timeOffCancelCommand = {
    changeReason: 'Synthetic private time-off cancellation',
    expectedRevision: editedTimeOff.context.revision,
    requestId: randomUUID(),
  };
  const cancelledTimeOff = await visitWrite(`${timeOffPath}/cancel`, timeOffCancelCommand, 201);
  assert.equal(cancelledTimeOff.context.status, 'cancelled');
  assert.deepEqual(cancelledTimeOff.context.closure, editedTimeOff.context.closure);
  const remainingTimeOffSlots = await timeOffSlots();
  assert.ok(remainingTimeOffSlots.includes('10:40'));
  assert.equal(remainingTimeOffSlots.includes('11:40'), false);
  assert.ok(remainingTimeOffSlots.includes('12:20'));
  const originalTimeOffReplay = await visitWrite('/time-off', timeOffCommand);
  assert.deepEqual(originalTimeOffReplay.change, createdTimeOff.change);
  assert.deepEqual(originalTimeOffReplay.receipt, createdTimeOff.receipt);
  assert.deepEqual(originalTimeOffReplay.context, cancelledTimeOff.context);
  const editedTimeOffReplay = await visitWrite(`${timeOffPath}/changes`, timeOffEdit);
  assert.deepEqual(editedTimeOffReplay.change, editedTimeOff.change);
  assert.deepEqual(editedTimeOffReplay.context, cancelledTimeOff.context);
  assert.deepEqual(
    await visitWrite(`${timeOffPath}/cancel`, timeOffCancelCommand),
    cancelledTimeOff,
  );
  const timeOffHistory = await timeOffRead('/history?pageSize=10');
  assert.equal(timeOffHistory.total, 3);
  assert.deepEqual(timeOffHistory.items.map((item) => item.action).sort(), [
    'cancelled',
    'created',
    'edited',
  ]);
  await visitWrite(`/schedule-closures/${overlappingClosure.id}`, {}, 200, 'DELETE');
  assert.ok((await timeOffSlots()).includes('11:40'));
  const legacyTimeOffContext = await (
    await fetch(`${base}/api/time-off/${overlappingClosure.id}`, { headers: apiHeaders })
  ).json();
  assert.equal(legacyTimeOffContext.status, 'cancelled');
  assert.equal(legacyTimeOffContext.latestChange.source, 'legacy');
  assert.equal(legacyTimeOffContext.latestChange.changeReason, null);
  const safeTimeOffList = await (await fetch(timeOffListUrl, { headers: apiHeaders })).json();
  assert.equal(safeTimeOffList.total, 2);
  assert.ok(safeTimeOffList.items.every((item) => item.status === 'cancelled'));
  for (const value of [
    privateTimeOffReason,
    timeOffCancelCommand.changeReason,
    timeOffCommand.requestId,
    createdTimeOff.change.id,
  ])
    assert.equal(JSON.stringify(safeTimeOffList).includes(value), false);
  const afterTimeOffScheduling = await (
    await fetch(`${base}/api/scheduling`, { headers: apiHeaders })
  ).json();
  assert.equal(afterTimeOffScheduling.closures.length, 0);
  assert.deepEqual(await availabilityRead(), beforeBlockedAvailability);
  const timeOffProtectedVisit = await (
    await fetch(`${base}/api/appointments/${customVisit.appointment.id}/duration`, {
      headers: apiHeaders,
    })
  ).json();
  assert.deepEqual(timeOffProtectedVisit.appointment, customVisit.appointment);
  for (const path of [timeOffListUrl, timeOffUrl, `${timeOffUrl}/history`])
    assert.equal((await fetch(path)).status, 401);

  const doctorBookingPath = `/doctors/${visitDoctor.id}/booking-status`;
  const doctorBookingUrl = `${base}/api${doctorBookingPath}`;
  const privateDoctorBookingReason = 'Synthetic private pause of new doctor bookings';
  const pausedBookingError =
    'This doctor is not accepting new bookings. Choose another doctor or contact the clinic.';
  async function doctorBookingRead(suffix = '') {
    const response = await fetch(`${doctorBookingUrl}${suffix}`, { headers: apiHeaders });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    return response.json();
  }
  const acceptingDoctor = await doctorBookingRead();
  assert.equal(acceptingDoctor.acceptingNewBookings, true);
  assert.equal(acceptingDoctor.latestChange, null);
  assert.equal((await doctorBookingRead('/history')).total, 0);
  const pausedDoctorCommand = {
    acceptingNewBookings: false,
    reason: privateDoctorBookingReason,
    expectedRevision: acceptingDoctor.revision,
    requestId: randomUUID(),
  };
  await visitWrite(
    doctorBookingPath,
    { ...pausedDoctorCommand, acceptingNewBookings: true, requestId: randomUUID() },
    400,
  );
  const retainedWaiting = await visitWrite(
    '/waitlist',
    {
      patientId: patient.id,
      doctorId: visitDoctor.id,
      mode: 'in-person',
      startDate: visitDay,
      endDate: visitDay,
      reason: 'Synthetic retained waiting request',
    },
    201,
  );
  const bookingPolicySeriesInput = {
    patientId: patient.id,
    doctorId: visitDoctor.id,
    firstDate: visitDay,
    time: '14:05',
    mode: 'in-person',
    reason: 'Synthetic series for doctor booking status',
    count: 2,
    intervalWeeks: 1,
    durationPolicy: 'custom',
    durationMinutes: 45,
  };
  const beforePauseSeries = await visitWrite(
    '/appointment-series/preview',
    bookingPolicySeriesInput,
  );
  assert.equal(beforePauseSeries.canBook, true);
  const pausedDoctor = await visitWrite(doctorBookingPath, pausedDoctorCommand, 201);
  assert.equal(pausedDoctor.context.acceptingNewBookings, false);
  assert.equal(pausedDoctor.change.before, true);
  assert.equal(pausedDoctor.change.after, false);
  assert.equal(pausedDoctor.receipt.actorId, account.user.id);
  const pausedPublicDoctors = await (await fetch(`${base}/api/doctors`)).json();
  assert.equal(
    pausedPublicDoctors.find((doctor) => doctor.id === visitDoctor.id).acceptingNewBookings,
    false,
  );
  for (const privateValue of [
    privateDoctorBookingReason,
    pausedDoctorCommand.requestId,
    pausedDoctor.change.id,
  ])
    assert.equal(JSON.stringify(pausedPublicDoctors).includes(privateValue), false);
  assert.deepEqual(await timeOffSlots(), []);
  const sameDoctorSlots = await (
    await fetch(
      `${base}/api/slots?doctorId=${visitDoctor.id}&date=${visitDay}&mode=in-person&excludeAppointmentId=${customVisit.appointment.id}`,
      { headers: apiHeaders },
    )
  ).json();
  assert.ok(sameDoctorSlots.includes('09:05'));
  assert.ok(sameDoctorSlots.includes('09:10'));
  const deniedNewBooking = await visitWrite(
    '/appointments',
    {
      patientId: patient.id,
      doctorId: visitDoctor.id,
      date: visitDay,
      time: '12:00',
      mode: 'in-person',
      reason: 'Synthetic blocked new appointment',
      waitlistId: retainedWaiting.id,
      patientConfirmed: true,
    },
    409,
  );
  assert.equal(deniedNewBooking.error, pausedBookingError);
  assert.equal(
    (
      await visitWrite(
        '/visit-duration/bookings',
        { ...customBookingBody, time: '12:05', requestId: randomUUID() },
        409,
      )
    ).error,
    pausedBookingError,
  );
  assert.equal(
    (
      await visitWrite(
        '/waitlist',
        {
          patientId: patient.id,
          doctorId: visitDoctor.id,
          mode: 'online',
          startDate: visitDay,
          endDate: visitDay,
          reason: 'Synthetic blocked new waiting request',
        },
        409,
      )
    ).error,
    pausedBookingError,
  );
  const waitingWhilePaused = await (
    await fetch(`${base}/api/waitlist`, { headers: apiHeaders })
  ).json();
  assert.deepEqual(
    waitingWhilePaused.find((entry) => entry.id === retainedWaiting.id),
    retainedWaiting,
  );
  const pausedSeriesPreview = await visitWrite(
    '/appointment-series/preview',
    bookingPolicySeriesInput,
  );
  assert.equal(pausedSeriesPreview.canBook, false);
  assert.ok(
    pausedSeriesPreview.visits.every((visit) => visit.blockedReason === pausedBookingError),
  );
  await visitWrite(`/doctors/${visitDoctor.id}`, visitDoctor, 200, 'PATCH');
  assert.deepEqual(await doctorBookingRead(), pausedDoctor.context);
  const resumedDoctor = await visitWrite(
    doctorBookingPath,
    {
      acceptingNewBookings: true,
      reason: 'Synthetic resume for booking-status preview review',
      expectedRevision: pausedDoctor.context.revision,
      requestId: randomUUID(),
    },
    201,
  );
  const afterResumeSeries = await visitWrite(
    '/appointment-series/preview',
    bookingPolicySeriesInput,
  );
  assert.equal(afterResumeSeries.canBook, true);
  assert.notEqual(afterResumeSeries.revision, beforePauseSeries.revision);
  await visitWrite(
    '/appointment-series',
    {
      input: bookingPolicySeriesInput,
      expectedRevision: beforePauseSeries.revision,
      patientConfirmed: true,
      privateNote: '',
      requestId: randomUUID(),
    },
    409,
  );
  const pausedDoctorAgain = await visitWrite(
    doctorBookingPath,
    {
      ...pausedDoctorCommand,
      expectedRevision: resumedDoctor.context.revision,
      requestId: randomUUID(),
    },
    201,
  );
  assert.deepEqual(await availabilityRead(), beforeBlockedAvailability);
  assert.deepEqual(await timeOffRead(), cancelledTimeOff.context);
  for (const path of [doctorBookingUrl, `${doctorBookingUrl}/history`])
    assert.equal((await fetch(path)).status, 401);

  const customReplay = await visitWrite('/visit-duration/bookings', customBookingBody);
  assert.equal(customReplay.event.id, customVisit.event.id);
  const movedVisit = await visitWrite(
    `/appointments/${customVisit.appointment.id}`,
    {
      date: visitDay,
      time: '09:10',
    },
    200,
    'PATCH',
  );
  assert.equal(movedVisit.durationMinutes, 90);
  const calendar = await fetch(`${base}/api/appointments/${movedVisit.id}/calendar`, {
    headers: apiHeaders,
  });
  assert.equal(calendar.status, 200);
  const calendarText = await calendar.text();
  const calendarStamp = (value) =>
    new Date(value)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  const visitStart = Date.parse(`${visitDay}T09:10:00+05:30`);
  assert.ok(calendarText.includes(`DTSTART:${calendarStamp(visitStart)}`));
  assert.ok(calendarText.includes(`LOCATION:${profileCommand.profile.address}`));
  assert.equal(calendarText.includes(privateAvailabilityReason), false);
  assert.equal(calendarText.includes(privateTimeOffReason), false);
  assert.equal(calendarText.includes(privateDoctorBookingReason), false);
  assert.ok(calendarText.includes(`DTEND:${calendarStamp(visitStart + 90 * 60000)}`));
  const durationUrl = `${base}/api/appointments/${movedVisit.id}/duration`;
  const durationResponse = await fetch(durationUrl, { headers: apiHeaders });
  assert.equal(durationResponse.status, 200);
  assert.match(durationResponse.headers.get('cache-control'), /no-store/);
  const durationContext = await durationResponse.json();
  const privateDurationReason = 'Synthetic private duration adjustment reason';
  const restoredDuration = await visitWrite(`/appointments/${movedVisit.id}/duration`, {
    durationPolicy: 'schedule',
    date: visitDay,
    time: '09:20',
    reason: privateDurationReason,
    expectedRevision: durationContext.revision,
    requestId: randomUUID(),
  });
  assert.equal(restoredDuration.appointment.durationMinutes, 20);
  assert.equal(restoredDuration.appointment.durationPolicy, 'schedule');
  assert.deepEqual(await doctorBookingRead(), pausedDoctorAgain.context);
  const finalResumedDoctor = await visitWrite(
    doctorBookingPath,
    {
      acceptingNewBookings: true,
      reason: 'Synthetic resume after existing-visit continuity checks',
      expectedRevision: pausedDoctorAgain.context.revision,
      requestId: randomUUID(),
    },
    201,
  );
  const originalPauseReplay = await visitWrite(doctorBookingPath, pausedDoctorCommand);
  assert.deepEqual(originalPauseReplay.change, pausedDoctor.change);
  assert.deepEqual(originalPauseReplay.receipt, pausedDoctor.receipt);
  assert.deepEqual(originalPauseReplay.context, finalResumedDoctor.context);
  assert.equal((await doctorBookingRead('/history?pageSize=10')).total, 4);
  assert.ok((await timeOffSlots()).includes('12:00'));
  await visitWrite(`/waitlist/${retainedWaiting.id}/cancel`, {
    reason: 'Synthetic waiting request withdrawn after pause verification',
  });
  assert.equal((await fetch(durationUrl)).status, 401);
  const privateSeriesNote = 'Synthetic private recurring booking note';
  const seriesInput = {
    patientId: patient.id,
    doctorId: visitDoctor.id,
    firstDate: visitDay,
    time: '14:05',
    mode: 'in-person',
    reason: 'Synthetic recurring clinic visits',
    count: 3,
    intervalWeeks: 1,
    durationPolicy: 'custom',
    durationMinutes: 45,
  };
  const seriesPreview = await visitWrite('/appointment-series/preview', seriesInput);
  assert.equal(seriesPreview.canBook, true);
  assert.equal(seriesPreview.visits.length, 3);
  assert.equal(seriesPreview.durationMinutes, 45);
  assert.ok(seriesPreview.visits.every((visit) => visit.available && visit.endTime === '14:50'));
  const seriesCommand = {
    input: seriesInput,
    expectedRevision: seriesPreview.revision,
    patientConfirmed: true,
    privateNote: privateSeriesNote,
    requestId: randomUUID(),
  };
  const seriesCreated = await visitWrite('/appointment-series', seriesCommand, 201);
  assert.equal(seriesCreated.appointments.length, 3);
  assert.equal(seriesCreated.series.bookedAppointments.length, 3);
  assert.equal(new Set(seriesCreated.appointments.map((visit) => visit.id)).size, 3);
  assert.ok(seriesCreated.appointments.every((visit) => visit.durationPolicy === 'custom'));
  const seriesUrl = `${base}/api/appointment-series/${seriesCreated.series.id}`;
  assert.equal((await fetch(seriesUrl)).status, 401);
  await visitWrite(
    `/appointments/${seriesCreated.appointments[0].id}`,
    {
      date: visitDay,
      time: '15:05',
    },
    200,
    'PATCH',
  );
  await visitWrite(
    `/appointments/${seriesCreated.appointments[1].id}`,
    {
      status: 'cancelled',
    },
    200,
    'PATCH',
  );
  const seriesReplay = await visitWrite('/appointment-series', seriesCommand);
  assert.deepEqual(seriesReplay.series, seriesCreated.series);
  assert.equal(seriesReplay.appointments[0].time, '15:05');
  assert.equal(seriesReplay.appointments[0].durationMinutes, 45);
  assert.equal(seriesReplay.appointments[1].status, 'cancelled');
  assert.equal(seriesReplay.series.bookedAppointments[0].time, '14:05');
  assert.equal(seriesReplay.series.bookedAppointments[1].status, 'scheduled');
  await visitWrite('/appointment-series', { ...seriesCommand, requestId: randomUUID() }, 409);
  const seriesBlocked = await visitWrite('/appointment-series/preview', seriesInput);
  assert.equal(seriesBlocked.canBook, false);
  assert.equal(seriesBlocked.visits[2].available, false);
  await visitWrite(
    '/appointment-series',
    {
      ...seriesCommand,
      expectedRevision: seriesBlocked.revision,
      requestId: randomUUID(),
    },
    409,
  );
  const seriesListResponse = await fetch(`${base}/api/appointment-series?patientId=${patient.id}`, {
    headers: apiHeaders,
  });
  assert.equal(seriesListResponse.status, 200);
  assert.match(seriesListResponse.headers.get('cache-control'), /no-store/);
  assert.equal((await seriesListResponse.json()).total, 1);
  const seriesDetailsResponse = await fetch(seriesUrl, { headers: apiHeaders });
  assert.equal(seriesDetailsResponse.status, 200);
  assert.deepEqual((await seriesDetailsResponse.json()).series, seriesCreated.series);
  const ordinaryAppointments = await (
    await fetch(`${base}/api/appointments`, { headers: apiHeaders })
  ).json();
  assert.equal(ordinaryAppointments.length, 4);
  assert.equal(JSON.stringify(ordinaryAppointments).includes(privateSeriesNote), false);
  assert.equal(JSON.stringify(ordinaryAppointments).includes(seriesCommand.requestId), false);
  const seriesShell = await fetch(`${base}/clinic/appointment-series`);
  assert.equal(seriesShell.status, 200);
  assert.match(seriesShell.headers.get('x-robots-tag'), /noindex/);
  const cancellationPath = `/appointment-series/${seriesCreated.series.id}/cancellations`;
  const cancellationUrl = `${base}/api${cancellationPath}`;
  const cancellationContextResponse = await fetch(`${cancellationUrl}/context`, {
    headers: apiHeaders,
  });
  assert.equal(cancellationContextResponse.status, 200);
  assert.match(cancellationContextResponse.headers.get('cache-control'), /no-store/);
  const cancellationContext = await cancellationContextResponse.json();
  assert.deepEqual(
    cancellationContext.visits.map((visit) => visit.eligible),
    [true, false, true],
  );
  assert.equal(cancellationContext.visits[0].appointment.time, '15:05');
  const blockedCancellation = await visitWrite(`${cancellationPath}/preview`, {
    appointmentIds: seriesCreated.appointments.slice(0, 2).map((visit) => visit.id),
  });
  assert.equal(blockedCancellation.canCancel, false);
  assert.equal(blockedCancellation.visits.length, 2);
  assert.equal(blockedCancellation.visits[1].eligible, false);
  const privateCancellationReason = 'Synthetic private recurring cancellation reason';
  await visitWrite(
    cancellationPath,
    {
      appointmentIds: blockedCancellation.appointmentIds,
      expectedRevision: blockedCancellation.revision,
      reason: privateCancellationReason,
      patientConfirmed: true,
      requestId: randomUUID(),
    },
    409,
  );
  const selectedVisitIds = [seriesCreated.appointments[2].id, seriesCreated.appointments[0].id];
  const cancellationPreview = await visitWrite(`${cancellationPath}/preview`, {
    appointmentIds: selectedVisitIds,
  });
  assert.equal(cancellationPreview.canCancel, true);
  const cancellationRoom = await visitWrite(
    '/clinic-resources',
    {
      name: 'Synthetic series cancellation room',
      kind: 'room',
      location: 'Disposable local verification',
      notes: '',
      requestId: randomUUID(),
    },
    201,
  );
  const reservationPath = `/appointments/${seriesCreated.appointments[0].id}/resources`;
  const reservationContext = await (
    await fetch(`${base}/api${reservationPath}`, {
      headers: apiHeaders,
    })
  ).json();
  await visitWrite(
    reservationPath,
    {
      resourceIds: [cancellationRoom.resource.id],
      reason: 'Synthetic reservation before cancelling',
      expectedRevision: reservationContext.revision,
      requestId: randomUUID(),
    },
    200,
    'PUT',
  );
  const cancellationCommand = {
    appointmentIds: selectedVisitIds,
    reason: privateCancellationReason,
    expectedRevision: cancellationPreview.revision,
    patientConfirmed: true,
    requestId: randomUUID(),
  };
  await visitWrite(cancellationPath, cancellationCommand, 409);
  const beforeCancellation = await (await fetch(seriesUrl, { headers: apiHeaders })).json();
  assert.equal(beforeCancellation.appointments[0].status, 'scheduled');
  assert.equal(beforeCancellation.appointments[2].status, 'scheduled');
  const refreshedCancellation = await visitWrite(`${cancellationPath}/preview`, {
    appointmentIds: selectedVisitIds,
  });
  assert.deepEqual(
    refreshedCancellation.visits.map((visit) => visit.reservationCount),
    [1, 0],
  );
  cancellationCommand.expectedRevision = refreshedCancellation.revision;
  const cancellation = await visitWrite(cancellationPath, cancellationCommand, 201);
  assert.deepEqual(cancellation.event.appointmentIds, [...selectedVisitIds].reverse());
  assert.deepEqual(
    cancellation.event.visits.map((visit) => visit.releasedReservationCount),
    [1, 0],
  );
  assert.ok(
    cancellation.event.visits.every(
      (visit) => visit.before.status === 'scheduled' && visit.after.status === 'cancelled',
    ),
  );
  assert.ok(cancellation.detail.appointments.every((visit) => visit.status === 'cancelled'));
  assert.deepEqual(cancellation.detail.series, seriesCreated.series);
  const releasedReservations = await (
    await fetch(`${base}/api${reservationPath}`, {
      headers: apiHeaders,
    })
  ).json();
  assert.deepEqual(releasedReservations.resourceIds, []);
  assert.equal(releasedReservations.history[0].source, 'appointment-status');
  const cancellationReplay = await visitWrite(cancellationPath, {
    ...cancellationCommand,
    appointmentIds: [...selectedVisitIds].reverse(),
  });
  assert.deepEqual(cancellationReplay.event, cancellation.event);
  const cancellationHistory = await (await fetch(cancellationUrl, { headers: apiHeaders })).json();
  assert.equal(cancellationHistory.total, 1);
  assert.deepEqual(cancellationHistory.items[0], cancellation.event);
  const bookingAfterCancellation = await visitWrite('/appointment-series', seriesCommand);
  assert.deepEqual(bookingAfterCancellation.series, seriesCreated.series);
  assert.ok(bookingAfterCancellation.appointments.every((visit) => visit.status === 'cancelled'));
  const cancellationAppointments = await (
    await fetch(`${base}/api/appointments`, {
      headers: apiHeaders,
    })
  ).json();
  assert.equal(JSON.stringify(cancellationAppointments).includes(privateCancellationReason), false);
  assert.equal(
    JSON.stringify(cancellationAppointments).includes(cancellationCommand.requestId),
    false,
  );
  for (const privateCancellationUrl of [cancellationUrl, `${cancellationUrl}/context`])
    assert.equal((await fetch(privateCancellationUrl)).status, 401);
  const rescheduleInput = { ...seriesInput, time: '11:05' };
  const rescheduleBookingPreview = await visitWrite('/appointment-series/preview', rescheduleInput);
  assert.equal(rescheduleBookingPreview.canBook, true);
  const rescheduleBooking = {
    input: rescheduleInput,
    expectedRevision: rescheduleBookingPreview.revision,
    patientConfirmed: true,
    privateNote: privateSeriesNote,
    requestId: randomUUID(),
  };
  const rescheduleSeries = await visitWrite('/appointment-series', rescheduleBooking, 201);
  const [firstMove, secondMove, untouchedMove] = rescheduleSeries.appointments;
  const reschedulePath = `/appointment-series/${rescheduleSeries.series.id}/reschedules`;
  const rescheduleUrl = `${base}/api${reschedulePath}`;
  const rescheduleContextResponse = await fetch(`${rescheduleUrl}/context`, {
    headers: apiHeaders,
  });
  assert.equal(rescheduleContextResponse.status, 200);
  assert.match(rescheduleContextResponse.headers.get('cache-control'), /no-store/);
  const rescheduleContext = await rescheduleContextResponse.json();
  assert.ok(rescheduleContext.visits.every((visit) => visit.eligible));
  const blockedMoves = [firstMove, secondMove].map((visit) => ({
    appointmentId: visit.id,
    date: untouchedMove.date,
    time: '12:05',
  }));
  const blockedReschedule = await visitWrite(`${reschedulePath}/preview`, { moves: blockedMoves });
  assert.equal(blockedReschedule.canReschedule, false);
  assert.ok(blockedReschedule.visits.every((visit) => !visit.eligible));
  const privateRescheduleReason = 'Synthetic private series rescheduling reason';
  await visitWrite(
    reschedulePath,
    {
      moves: blockedMoves,
      expectedRevision: blockedReschedule.revision,
      reason: privateRescheduleReason,
      patientConfirmed: true,
      requestId: randomUUID(),
    },
    409,
  );
  const swapMoves = [
    { appointmentId: secondMove.id, date: firstMove.date, time: firstMove.time },
    { appointmentId: firstMove.id, date: secondMove.date, time: secondMove.time },
  ];
  const swapPreview = await visitWrite(`${reschedulePath}/preview`, { moves: swapMoves });
  assert.equal(swapPreview.canReschedule, true);
  for (const visit of [firstMove, secondMove]) {
    const path = `/appointments/${visit.id}/resources`;
    const context = await (await fetch(`${base}/api${path}`, { headers: apiHeaders })).json();
    await visitWrite(
      path,
      {
        resourceIds: [cancellationRoom.resource.id],
        reason: 'Synthetic room retained through date swap',
        expectedRevision: context.revision,
        requestId: randomUUID(),
      },
      200,
      'PUT',
    );
  }
  const rescheduleCommand = {
    moves: swapMoves,
    expectedRevision: swapPreview.revision,
    reason: privateRescheduleReason,
    patientConfirmed: true,
    requestId: randomUUID(),
  };
  await visitWrite(reschedulePath, rescheduleCommand, 409);
  const beforeSwap = await (
    await fetch(`${base}/api/appointment-series/${rescheduleSeries.series.id}`, {
      headers: apiHeaders,
    })
  ).json();
  assert.deepEqual(beforeSwap.appointments, rescheduleSeries.appointments);
  const refreshedSwap = await visitWrite(`${reschedulePath}/preview`, { moves: swapMoves });
  assert.equal(refreshedSwap.canReschedule, true);
  assert.deepEqual(
    refreshedSwap.visits.map((visit) => visit.reservationCount),
    [1, 1],
  );
  assert.ok(
    refreshedSwap.visits.every(
      (visit) => visit.after.durationMinutes === 45 && visit.endTime === '11:50',
    ),
  );
  rescheduleCommand.expectedRevision = refreshedSwap.revision;
  const swapped = await visitWrite(reschedulePath, rescheduleCommand, 201);
  assert.deepEqual(swapped.event.moves, [...swapMoves].reverse());
  assert.deepEqual(
    swapped.event.visits.map((visit) => visit.retainedReservationCount),
    [1, 1],
  );
  assert.equal(swapped.detail.appointments[0].date, secondMove.date);
  assert.equal(swapped.detail.appointments[1].date, firstMove.date);
  assert.deepEqual(swapped.detail.appointments[2], untouchedMove);
  assert.deepEqual(swapped.detail.series, rescheduleSeries.series);
  for (const visit of swapped.detail.appointments.slice(0, 2)) {
    assert.equal(visit.status, 'scheduled');
    assert.equal(visit.durationMinutes, 45);
    assert.equal(visit.durationPolicy, 'custom');
    const context = await (
      await fetch(`${base}/api/appointments/${visit.id}/resources`, {
        headers: apiHeaders,
      })
    ).json();
    assert.deepEqual(context.resourceIds, [cancellationRoom.resource.id]);
    assert.equal(context.history[0].source, 'appointment-rescheduled');
    const movedCalendar = await fetch(`${base}/api/appointments/${visit.id}/calendar`, {
      headers: apiHeaders,
    });
    assert.equal(movedCalendar.status, 200);
    const content = await movedCalendar.text();
    const start = Date.parse(`${visit.date}T${visit.time}:00+05:30`);
    assert.ok(content.includes(`DTSTART:${calendarStamp(start)}`));
    assert.ok(content.includes(`DTEND:${calendarStamp(start + 45 * 60000)}`));
  }
  await visitWrite(
    `/appointments/${firstMove.id}`,
    { date: secondMove.date, time: '16:05' },
    200,
    'PATCH',
  );
  const rescheduleReplay = await visitWrite(reschedulePath, {
    ...rescheduleCommand,
    moves: [...swapMoves].reverse(),
  });
  assert.deepEqual(rescheduleReplay.event, swapped.event);
  assert.equal(rescheduleReplay.detail.appointments[0].time, '16:05');
  const rescheduleHistory = await (await fetch(rescheduleUrl, { headers: apiHeaders })).json();
  assert.equal(rescheduleHistory.total, 1);
  assert.deepEqual(rescheduleHistory.items[0], swapped.event);
  const bookingAfterSwap = await visitWrite('/appointment-series', rescheduleBooking);
  assert.deepEqual(bookingAfterSwap.series, rescheduleSeries.series);
  assert.equal(bookingAfterSwap.appointments[0].time, '16:05');
  const movedAppointments = await (
    await fetch(`${base}/api/appointments`, { headers: apiHeaders })
  ).text();
  for (const privateValue of [
    privateRescheduleReason,
    rescheduleCommand.requestId,
    swapped.event.id,
  ])
    assert.equal(movedAppointments.includes(privateValue), false);
  for (const privateRescheduleUrl of [rescheduleUrl, `${rescheduleUrl}/context`])
    assert.equal((await fetch(privateRescheduleUrl)).status, 401);
  // Give the synthetic administrator a clinician profile in this disposable
  // database, then refresh the session invalidated by that access change.
  await visitWrite(`/accounts/${account.user.id}`, { doctorId: visitDoctor.id }, 200, 'PATCH');
  const clinicianLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(clinicianLogin.status, 200);
  apiHeaders.Cookie = clinicianLogin.headers
    .getSetCookie()
    .find((value) => value.startsWith('derma_session='))
    .split(';')[0];
  apiHeaders['X-CSRF-Token'] = (await clinicianLogin.json()).csrfToken;
  const overdueDate = new Date(Date.parse(`${attendanceDay}T12:00:00Z`) - 10 * 86400000)
    .toISOString()
    .slice(0, 10);
  const escalationPlan = await visitWrite(
    '/care-plans',
    {
      patientId: patient.id,
      title: 'Synthetic overdue review',
      instructions: 'Synthetic clinician-entered instructions',
      startDate: overdueDate,
      endDate: attendanceDay,
      followUpDate: overdueDate,
      medications: [],
    },
    201,
  );
  const privateEscalationReason = 'Synthetic private escalation policy reason';
  const enabledPolicy = await visitWrite('/follow-up-escalation-policy', {
    enabled: true,
    ownerAfterDays: 3,
    clinicAfterDays: 7,
    reason: privateEscalationReason,
    expectedRevision: escalationPolicy.revision,
    requestId: randomUUID(),
  });
  assert.equal(enabledPolicy.context.policy.enabled, true);
  const noticePreview = await (await fetch(escalationPreviewUrl, { headers: apiHeaders })).json();
  assert.equal(noticePreview.status, 'ready');
  assert.equal(noticePreview.items.length, 1);
  assert.equal(noticePreview.items[0].carePlanId, escalationPlan.id);
  assert.equal(noticePreview.items[0].stage, 'clinic');
  assert.deepEqual(
    noticePreview.items[0].recipients.map((recipient) => recipient.userId),
    [account.user.id],
  );
  const noticeCommand = {
    expectedPreviewRevision: noticePreview.revision,
    expectedPolicyRevision: noticePreview.policyRevision,
    requestId: randomUUID(),
  };
  const noticeRun = await visitWrite('/follow-up-escalations/run', noticeCommand);
  assert.equal(noticeRun.notifiedPlans, 1);
  assert.equal(noticeRun.recipientCount, 1);
  assert.equal(noticeRun.events[0].episodeId, noticePreview.items[0].episodeId);
  const noticeReplay = await visitWrite('/follow-up-escalations/run', noticeCommand);
  assert.deepEqual(noticeReplay, noticeRun);
  const recordedPreview = await (await fetch(escalationPreviewUrl, { headers: apiHeaders })).json();
  assert.equal(recordedPreview.readyTotal, 0);
  assert.equal(recordedPreview.alreadyNotifiedTotal, 1);
  const escalationHistoryUrl = `${base}/api/care-plans/${escalationPlan.id}/escalations`;
  const recordedHistory = await fetch(escalationHistoryUrl, { headers: apiHeaders });
  assert.equal(recordedHistory.status, 200);
  assert.equal((await recordedHistory.json()).events.length, 1);
  const escalationActivity = await (
    await fetch(`${base}/api/activity`, { headers: apiHeaders })
  ).json();
  const recordedNotices = escalationActivity.items.filter(
    (item) => item.href === `/clinic/follow-ups?escalation=${escalationPlan.id}`,
  );
  assert.equal(recordedNotices.length, 1);
  assert.equal(JSON.stringify(recordedNotices).includes(privateEscalationReason), false);
  const templateFields = {
    title: 'Synthetic scheduling plan',
    benefits: 'Synthetic discussion',
    risks: 'Synthetic discussion',
    alternatives: 'Synthetic discussion',
    aftercare: 'Synthetic aftercare',
    estimatedCost: 'Not a charge',
  };
  const privateCatalogueReason = 'Synthetic private catalogue review reason';
  const templateCreated = await visitWrite(
    '/procedure-catalogue',
    {
      fields: templateFields,
      reason: privateCatalogueReason,
      requestId: randomUUID(),
    },
    201,
  );
  const templateId = templateCreated.detail.template.id;
  assert.equal(templateCreated.detail.publishedVersion, null);
  const publishedTemplate = await visitWrite(`/procedure-catalogue/${templateId}/publish`, {
    versionId: templateCreated.detail.latestVersion.id,
    reviewed: true,
    reason: privateCatalogueReason,
    expectedRevision: templateCreated.detail.template.revision,
    requestId: randomUUID(),
  });
  const procedureBody = {
    ...templateFields,
    patientId: patient.id,
    indication: 'Synthetic clinician-entered patient-specific indication',
    risks: 'Synthetic patient-specific discussion',
    templateSelection: {
      templateId,
      versionId: publishedTemplate.detail.publishedVersion.id,
      expectedSelectionRevision: publishedTemplate.detail.template.selectionRevision,
    },
    reviewedForPatient: true,
    requestId: randomUUID(),
  };
  const createdProcedure = await visitWrite('/procedures', procedureBody, 201);
  const procedurePlan = createdProcedure.procedure;
  assert.equal(createdProcedure.receipt.requestId, procedureBody.requestId);
  assert.equal(createdProcedure.receipt.createdById, account.user.id);
  assert.equal(procedurePlan.templateSource.version, 1);
  assert.deepEqual(procedurePlan.templateSource.customizedFields, ['risks']);
  const nextDraft = await visitWrite(`/procedure-catalogue/${templateId}/versions`, {
    fields: { ...templateFields, risks: 'Synthetic later template wording' },
    reason: privateCatalogueReason,
    expectedRevision: publishedTemplate.detail.template.revision,
    requestId: randomUUID(),
  });
  assert.equal(
    nextDraft.detail.template.selectionRevision,
    publishedTemplate.detail.template.selectionRevision,
  );
  const publishedNext = await visitWrite(`/procedure-catalogue/${templateId}/publish`, {
    versionId: nextDraft.detail.latestVersion.id,
    reviewed: true,
    reason: privateCatalogueReason,
    expectedRevision: nextDraft.detail.template.revision,
    requestId: randomUUID(),
  });
  assert.notEqual(
    publishedNext.detail.template.selectionRevision,
    publishedTemplate.detail.template.selectionRevision,
  );
  await visitWrite('/procedures', { ...procedureBody, requestId: randomUUID() }, 409);
  const archivedTemplate = await visitWrite(`/procedure-catalogue/${templateId}/availability`, {
    active: false,
    reason: privateCatalogueReason,
    expectedRevision: publishedNext.detail.template.revision,
    requestId: randomUUID(),
  });
  assert.equal(archivedTemplate.detail.template.active, false);
  const procedureReplay = await visitWrite('/procedures', procedureBody);
  assert.equal(procedureReplay.procedure.id, procedurePlan.id);
  assert.equal(procedureReplay.procedure.risks, procedureBody.risks);
  assert.deepEqual(procedureReplay.procedure.templateSource, procedurePlan.templateSource);
  assert.equal(JSON.stringify(procedureReplay.procedure).includes(privateCatalogueReason), false);
  const procedureScheduleUrl = `${base}/api/procedures/${procedurePlan.id}/scheduling`;
  const scheduleRead = await fetch(procedureScheduleUrl, { headers: apiHeaders });
  assert.equal(scheduleRead.status, 200);
  const scheduleContext = await scheduleRead.json();
  assert.equal(scheduleContext.procedure.originalAppointmentId, null);
  assert.equal(scheduleContext.procedure.effectiveAppointmentId, null);
  const candidateResponse = await fetch(
    `${procedureScheduleUrl}/candidates?from=${visitDay}&to=${visitDay}`,
    { headers: apiHeaders },
  );
  assert.equal(candidateResponse.status, 200);
  const selectedVisit = (await candidateResponse.json()).items.find(
    (item) => item.appointment.id === movedVisit.id,
  );
  assert.ok(selectedVisit);
  const privateSchedulingReason = 'Synthetic private procedure scheduling reason';
  const associationBody = {
    appointmentId: movedVisit.id,
    expectedAppointmentRevision: selectedVisit.revision,
    expectedRevision: scheduleContext.revision,
    requestId: randomUUID(),
    reason: privateSchedulingReason,
  };
  const associated = await visitWrite(
    `/procedures/${procedurePlan.id}/scheduling`,
    associationBody,
  );
  assert.equal(associated.context.procedure.effectiveAppointmentId, movedVisit.id);
  assert.equal(associated.context.procedure.originalAppointmentId, null);
  const associationReplay = await visitWrite(
    `/procedures/${procedurePlan.id}/scheduling`,
    associationBody,
  );
  assert.equal(associationReplay.event.id, associated.event.id);
  assert.equal(associationReplay.context.history.length, 1);
  const removed = await visitWrite(`/procedures/${procedurePlan.id}/scheduling`, {
    appointmentId: null,
    expectedAppointmentRevision: null,
    expectedRevision: associated.context.revision,
    requestId: randomUUID(),
    reason: 'Synthetic private removal reason',
    removeConfirmed: true,
  });
  assert.equal(removed.context.procedure.effectiveAppointmentId, null);
  const laterReplay = await visitWrite(
    `/procedures/${procedurePlan.id}/scheduling`,
    associationBody,
  );
  assert.equal(laterReplay.event.id, associated.event.id);
  assert.equal(laterReplay.context.procedure.effectiveAppointmentId, null);
  const relinked = await visitWrite(`/procedures/${procedurePlan.id}/scheduling`, {
    ...associationBody,
    expectedRevision: removed.context.revision,
    requestId: randomUUID(),
  });
  assert.equal(relinked.context.history.length, 3);
  const retainedVisit = await fetch(`${base}/api/appointments/${movedVisit.id}/duration`, {
    headers: apiHeaders,
  });
  assert.equal((await retainedVisit.json()).appointment.status, 'scheduled');
  assert.equal((await fetch(procedureScheduleUrl)).status, 401);
  async function billingWrite(path, body, status = 200) {
    const response = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    return response.json();
  }
  const issuePath = '/invoices/issue';
  const issuanceCommand = {
    patientId: patient.id,
    requestId: randomUUID(),
    procedureId: procedurePlan.id,
    reviewedConfirmed: true,
    items: [{ description: 'Synthetic verification charge', quantity: 1, unitAmountPaise: 1000 }],
  };
  const issuance = await billingWrite(issuePath, issuanceCommand, 201);
  const invoice = issuance.receipt.invoice;
  assert.match(invoice.id, /^[a-f0-9-]{36}$/);
  assert.match(invoice.number, /^INV-\d{6,}$/);
  assert.equal(new Date(invoice.createdAt).toISOString(), invoice.createdAt);
  assert.deepEqual(issuance.receipt, {
    requestId: issuanceCommand.requestId,
    actorId: account.user.id,
    patientId: patient.id,
    invoice: {
      id: invoice.id,
      number: invoice.number,
      createdAt: invoice.createdAt,
      patientId: patient.id,
      patientName: patient.name,
      procedureId: procedurePlan.id,
      procedureTitle: procedurePlan.title,
      items: issuanceCommand.items,
      status: 'unpaid',
      paidPaise: 0,
      totalPaise: 1000,
    },
  });
  const secondProcedureIssue = { ...issuanceCommand, requestId: randomUUID() };
  const procedureIssueRejected = await billingWrite(issuePath, secondProcedureIssue, 409);
  assert.equal(procedureIssueRejected.code, 'INVOICE_NOT_ISSUED');
  assert.equal(procedureIssueRejected.actorId, account.user.id);
  assert.deepEqual(procedureIssueRejected.command, secondProcedureIssue);
  const invoiceDetailPath = `/invoices/${invoice.id}`;
  async function readRecordedInvoice() {
    const response = await fetch(`${base}/api${invoiceDetailPath}`, { headers: apiHeaders });
    assert.equal(response.status, 200);
    return response.json();
  }
  const recordingPath = invoiceDetailPath + '/payments/record';
  const paymentCommand = {
    patientId: patient.id,
    expectedRevision: (await readRecordedInvoice()).revision,
    amountPaise: 400,
    method: 'cash',
    reference: 'Synthetic entry only',
    requestId: randomUUID(),
    receivedExternallyConfirmed: true,
  };
  const recorded = await billingWrite(recordingPath, paymentCommand, 201);
  const originalEntry = recorded.receipt.payment;
  assert.match(originalEntry.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(originalEntry.createdAt).toISOString(), originalEntry.createdAt);
  assert.deepEqual(recorded.receipt, {
    requestId: paymentCommand.requestId,
    actorId: account.user.id,
    invoiceId: invoice.id,
    patientId: patient.id,
    expectedRevision: paymentCommand.expectedRevision,
    invoiceNumber: invoice.number,
    totalPaise: 1000,
    beforePaidPaise: 0,
    afterPaidPaise: 400,
    payment: {
      id: originalEntry.id,
      invoiceId: invoice.id,
      createdAt: originalEntry.createdAt,
      amountPaise: 400,
      method: 'cash',
      reference: paymentCommand.reference,
    },
  });
  const stalePaymentCommand = { ...paymentCommand, requestId: randomUUID(), amountPaise: 100 };
  const stalePayment = await billingWrite(recordingPath, stalePaymentCommand, 409);
  assert.equal(stalePayment.code, 'PAYMENT_NOT_RECORDED');
  assert.equal(stalePayment.invoiceId, invoice.id);
  assert.deepEqual(stalePayment.command, stalePaymentCommand);
  const payment = await readRecordedInvoice();
  assert.equal(payment.payments.length, 1);
  assert.equal(payment.payments[0].id, originalEntry.id);
  assert.notEqual(payment.payments[0].requestId, paymentCommand.requestId);
  const revisedCharges = await billingWrite(`/invoices/${invoice.id}/corrections`, {
    items: [{ description: 'Corrected synthetic charge', quantity: 1, unitAmountPaise: 800 }],
    reason: 'Synthetic charge correction',
    expectedRevision: payment.revision,
    requestId: randomUUID(),
  });
  assert.equal(revisedCharges.invoice.totalPaise, 800);
  const reversed = await billingWrite(
    `/invoices/${invoice.id}/payments/${payment.payments[0].id}/reverse`,
    {
      reason: 'Synthetic erroneous entry',
      entryErrorConfirmed: true,
      expectedRevision: revisedCharges.revision,
      requestId: randomUUID(),
    },
  );
  assert.equal(reversed.invoice.paidPaise, 0);
  const noCharges = await billingWrite(`/invoices/${invoice.id}/corrections`, {
    items: [],
    reason: 'Remove synthetic charges',
    removeAllChargesConfirmed: true,
    expectedRevision: reversed.revision,
    requestId: randomUUID(),
  });
  assert.equal(noCharges.invoice.status, 'no-charge');
  assert.equal(noCharges.issuedCharges.totalPaise, 1000);
  assert.equal(noCharges.corrections.length, 2);
  assert.equal(noCharges.reversals.length, 1);
  assert.deepEqual(await billingWrite(recordingPath, paymentCommand), recorded);
  assert.deepEqual(await billingWrite(recordingPath, stalePaymentCommand, 409), stalePayment);
  assert.deepEqual(await billingWrite(issuePath, issuanceCommand), issuance);
  assert.deepEqual(
    await billingWrite(issuePath, secondProcedureIssue, 409),
    procedureIssueRejected,
  );
  const currentPaymentDetail = await readRecordedInvoice();
  assert.equal(currentPaymentDetail.payments.length, 1);
  assert.equal(currentPaymentDetail.reversals.length, 1);
  assert.equal(currentPaymentDetail.invoice.paidPaise, 0);
  assert.equal(currentPaymentDetail.invoice.status, 'no-charge');
  for (const command of [paymentCommand, stalePaymentCommand])
    assert.equal(JSON.stringify(currentPaymentDetail).includes(command.requestId), false);
  assert.deepEqual(currentPaymentDetail.invoice, noCharges.invoice);
  const issueAudit = await fetch(
    `${base}/api/search/audit?entityType=invoice&entityId=${invoice.id}`,
    { headers: apiHeaders },
  );
  assert.equal(issueAudit.status, 200);
  const auditItems = (await issueAudit.json()).items;
  for (const action of ['created invoice', 'recorded manual payment'])
    assert.equal(auditItems.filter((row) => row.action === action).length, 1);
  const bundleImageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
    'base64',
  );
  const bundlePdfBytes = Buffer.from('%PDF-1.7\nSynthetic portable report only.\n%%EOF\n');
  const imageCommand = {
    requestId: randomUUID(),
    patientId: patient.id,
    caption: 'Synthetic portable photograph',
    category: 'clinical',
    consent: true,
    sha256: createHash('sha256').update(bundleImageBytes).digest('hex'),
    dataUrl: `data:image/png;base64,${bundleImageBytes.toString('base64')}`,
  };
  const documentCommand = {
    requestId: randomUUID(),
    patientId: patient.id,
    title: 'Synthetic portable report',
    originalName: 'synthetic-report.pdf',
    consent: true,
    sha256: createHash('sha256').update(bundlePdfBytes).digest('hex'),
    dataUrl: `data:application/pdf;base64,${bundlePdfBytes.toString('base64')}`,
  };
  const imageUpload = await visitWrite('/images/upload', imageCommand, 201);
  const documentUpload = await visitWrite('/documents/upload', documentCommand, 201);
  const bundleImage = imageUpload.receipt.file;
  const bundleDocument = documentUpload.receipt.file;
  for (const [path, kind, command, result, originalBytes, action] of [
    [
      '/images/upload',
      'image',
      imageCommand,
      imageUpload,
      bundleImageBytes,
      'uploaded private image',
    ],
    [
      '/documents/upload',
      'document',
      documentCommand,
      documentUpload,
      bundlePdfBytes,
      'uploaded private report document',
    ],
  ]) {
    assert.deepEqual(await visitWrite(path, command), result);
    const file = result.receipt.file;
    assert.deepEqual(result.receipt, {
      requestId: command.requestId,
      actorId: account.user.id,
      patientId: patient.id,
      kind,
      file,
    });
    assert.equal(file.sha256, command.sha256);
    assert.equal(file.sizeBytes, originalBytes.length);
    assert.equal(file.createdById, account.user.id);
    assert.equal(file.consent, true);
    const download = await fetch(`${base}${file.url}`, { headers: apiHeaders });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), originalBytes);
    const audit = await fetch(`${base}/api/search/audit?entityType=${kind}&entityId=${file.id}`, {
      headers: apiHeaders,
    });
    assert.equal(audit.status, 200);
    assert.equal((await audit.json()).items.filter((entry) => entry.action === action).length, 1);
  }
  const summaryUrl = `${base}/api/patients/${patient.id}/care-summary`;
  const summaryResponse = await fetch(summaryUrl, { headers: apiHeaders });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.audience, 'patient');
  for (const command of [
    issuanceCommand,
    secondProcedureIssue,
    paymentCommand,
    stalePaymentCommand,
  ])
    assert.equal(JSON.stringify(summary).includes(command.requestId), false);

  for (const command of [imageCommand, documentCommand])
    assert.equal(JSON.stringify(summary).includes(command.requestId), false);
  assert.equal(summary.clinic.name, profileCommand.profile.name);
  assert.equal(summary.clinic.phone, legacyConfiguration.phone);
  assert.equal(JSON.stringify(summary).includes(privateConfigurationReason), false);
  assert.equal(JSON.stringify(summary).includes(profileCommand.requestId), false);
  assert.equal(summary.patient.id, patient.id);
  assert.equal(summary.patient.phone, '9000000088');
  assert.equal(summary.patient.allergyStatus, 'not-recorded');
  assert.deepEqual(summary.allergyHistory, []);
  assert.equal(summary.invoiceHistories[0].issuedCharges.totalPaise, 1000);
  assert.equal(summary.invoices[0].status, 'no-charge');
  assert.deepEqual(summary.imageAnnotations, []);
  assert.equal(summary.carePlans.length, 1);
  assert.equal(summary.carePlans[0].id, escalationPlan.id);
  assert.equal('escalation' in summary.carePlans[0], false);
  assert.equal(JSON.stringify(summary).includes(privateEscalationReason), false);
  assert.equal(JSON.stringify(summary).includes(noticeRun.events[0].id), false);
  assert.equal(JSON.stringify(summary).includes(privateDurationReason), false);
  assert.equal(JSON.stringify(summary).includes(privateAvailabilityReason), false);
  assert.equal(JSON.stringify(summary).includes(availabilityCommand.requestId), false);
  assert.equal(JSON.stringify(summary).includes(firstAvailability.change.id), false);
  assert.equal(JSON.stringify(summary).includes(privateTimeOffReason), false);
  assert.equal(JSON.stringify(summary).includes(timeOffCommand.requestId), false);
  assert.equal(JSON.stringify(summary).includes(createdTimeOff.change.id), false);
  assert.equal(JSON.stringify(summary).includes(privateDoctorBookingReason), false);
  assert.equal(JSON.stringify(summary).includes(pausedDoctorCommand.requestId), false);
  assert.equal(JSON.stringify(summary).includes(pausedDoctor.change.id), false);
  assert.equal(JSON.stringify(summary).includes(privateSchedulingReason), false);
  assert.equal(JSON.stringify(summary).includes(privateSeriesNote), false);
  assert.equal(JSON.stringify(summary).includes(privateCancellationReason), false);
  assert.equal(JSON.stringify(summary).includes(privateRescheduleReason), false);
  assert.equal(JSON.stringify(summary).includes(rescheduleCommand.requestId), false);
  assert.equal(JSON.stringify(summary).includes(cancellationCommand.requestId), false);
  assert.equal(JSON.stringify(summary).includes(seriesCommand.requestId), false);
  assert.equal(JSON.stringify(summary).includes('Synthetic private removal reason'), false);
  const sharedProcedure = summary.procedures.find((item) => item.id === procedurePlan.id);
  assert.equal(sharedProcedure.appointmentId, null);
  assert.equal(sharedProcedure.effectiveAppointmentId, movedVisit.id);
  assert.equal(sharedProcedure.scheduledAppointment.durationMinutes, 20);
  assert.equal(sharedProcedure.risks, procedureBody.risks);
  assert.deepEqual(sharedProcedure.templateSource, procedurePlan.templateSource);
  assert.equal(JSON.stringify(summary).includes(privateCatalogueReason), false);
  assert.equal(JSON.stringify(summary).includes(procedureBody.requestId), false);
  assert.equal(JSON.stringify(summary).includes('Synthetic later template wording'), false);
  assert.equal(summary.invoices[0].procedureId, procedurePlan.id);
  const summaryDownload = await fetch(`${summaryUrl}/download?revision=${summary.revision}`, {
    headers: apiHeaders,
  });
  assert.equal(summaryDownload.status, 200);
  assert.match(summaryDownload.headers.get('content-disposition'), /attachment/);
  assert.match(summaryDownload.headers.get('cache-control'), /no-store/);
  assert.equal((await summaryDownload.json()).revision, summary.revision);
  const copiesPath = `/patients/${patient.id}/care-summary/copies`;
  const copiesUrl = `${base}/api${copiesPath}`;
  assert.equal((await fetch(copiesUrl)).status, 401);
  const emptyCopies = await fetch(copiesUrl, { headers: apiHeaders });
  assert.equal(emptyCopies.status, 200);
  assert.equal((await emptyCopies.json()).total, 0);
  const copyCommand = { expectedRevision: summary.revision, requestId: randomUUID() };
  const savedCopy = await visitWrite(copiesPath, copyCommand, 201);
  assert.equal(savedCopy.copy.patientId, patient.id);
  assert.equal(savedCopy.copy.patientName, summary.patient.name);
  assert.equal(savedCopy.copy.sourceRevision, summary.revision);
  assert.equal(savedCopy.copy.savedBy.role, 'admin');
  assert.equal(savedCopy.receipt.requestId, copyCommand.requestId);
  assert.equal(savedCopy.receipt.copyId, savedCopy.copy.id);
  const copyUrl = `${copiesUrl}/${savedCopy.copy.id}`;
  const copyResponse = await fetch(copyUrl, { headers: apiHeaders });
  assert.equal(copyResponse.status, 200);
  const originalCopy = await copyResponse.json();
  assert.deepEqual(originalCopy.copy, savedCopy.copy);
  assert.deepEqual(originalCopy.summary, {
    ...summary,
    generatedAt: savedCopy.copy.generatedAt,
  });
  const copyDownload = await fetch(`${copyUrl}/download`, { headers: apiHeaders });
  assert.equal(copyDownload.status, 200);
  assert.match(copyDownload.headers.get('content-disposition'), /attachment/);
  assert.match(copyDownload.headers.get('cache-control'), /no-store/);
  assert.equal(copyDownload.headers.get('x-content-type-options'), 'nosniff');
  const copyBytes = Buffer.from(await copyDownload.arrayBuffer());
  assert.equal(copyBytes.length, savedCopy.copy.byteLength);
  assert.equal(createHash('sha256').update(copyBytes).digest('hex'), savedCopy.copy.contentSha256);
  assert.deepEqual(JSON.parse(copyBytes.toString('utf8')), originalCopy.summary);
  const bundlePath = `${copiesPath}/${savedCopy.copy.id}/bundle`;
  const bundleUrl = `${base}/api${bundlePath}`;
  assert.equal((await fetch(`${bundleUrl}/attachments`)).status, 401);
  const bundleCatalogueResponse = await fetch(`${bundleUrl}/attachments?pageSize=10`, {
    headers: apiHeaders,
  });
  assert.equal(bundleCatalogueResponse.status, 200);
  const bundleCatalogue = await bundleCatalogueResponse.json();
  assert.equal(bundleCatalogue.total, 2);
  assert.ok(bundleCatalogue.items.every((item) => item.availability === 'present'));
  assert.deepEqual(bundleCatalogue.copy, savedCopy.copy);
  assert.deepEqual(bundleCatalogue.limits, {
    maxAttachments: 20,
    maxFileBytes: 5242880,
    maxBundleBytes: 26214400,
  });
  const bundleSelection = [
    { type: 'image', id: bundleImage.id },
    { type: 'document', id: bundleDocument.id },
  ];
  const bundlePreview = await visitWrite(`${bundlePath}/preview`, { attachments: bundleSelection });
  assert.deepEqual(bundlePreview.copy, savedCopy.copy);
  assert.equal(bundlePreview.manifest.summary.sha256, savedCopy.copy.contentSha256);
  assert.equal(bundlePreview.manifest.files.length, 2);
  assert.ok(bundlePreview.manifest.files.every((file) => file.verification === 'saved-sha256'));
  assert.equal(JSON.stringify(bundlePreview).includes(privateConfigurationReason), false);
  assert.deepEqual(
    await visitWrite(`${bundlePath}/preview`, { attachments: [...bundleSelection].reverse() }),
    bundlePreview,
  );
  await visitWrite(
    `${bundlePath}/preview`,
    { attachments: [bundleSelection[0], bundleSelection[0]] },
    400,
  );
  await visitWrite(`${bundlePath}/preview`, { attachments: [] }, 400);
  await visitWrite(
    `${bundlePath}/preview`,
    { attachments: [{ type: 'image', id: randomUUID() }] },
    400,
  );
  await visitWrite(
    `${bundlePath}/download`,
    { attachments: bundleSelection, expectedRevision: '0'.repeat(64) },
    409,
  );

  await billingWrite(`/invoices/${invoice.id}/corrections`, {
    items: [{ description: 'Later synthetic charge', quantity: 1, unitAmountPaise: 900 }],
    reason: 'Synthetic change after saving the care-summary copy',
    expectedRevision: noCharges.revision,
    requestId: randomUUID(),
  });
  const laterSummary = await (await fetch(summaryUrl, { headers: apiHeaders })).json();
  assert.notEqual(laterSummary.revision, summary.revision);
  assert.equal(laterSummary.invoices[0].totalPaise, 900);
  await visitWrite(copiesPath, { ...copyCommand, requestId: randomUUID() }, 409);
  assert.deepEqual(await visitWrite(copiesPath, copyCommand), savedCopy);
  assert.deepEqual(await (await fetch(copyUrl, { headers: apiHeaders })).json(), originalCopy);
  const laterDownload = await fetch(`${copyUrl}/download`, { headers: apiHeaders });
  assert.equal(laterDownload.status, 200);
  assert.deepEqual(Buffer.from(await laterDownload.arrayBuffer()), copyBytes);
  const bundleDownloadBody = {
    attachments: bundleSelection,
    expectedRevision: bundlePreview.revision,
  };
  async function fetchBundle(headers = apiHeaders) {
    return fetch(`${bundleUrl}/download`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bundleDownloadBody),
    });
  }
  const bundleDownload = await fetchBundle();
  assert.equal(bundleDownload.status, 200);
  assert.equal(bundleDownload.headers.get('content-type'), 'application/zip');
  assert.equal(
    bundleDownload.headers.get('content-disposition'),
    `attachment; filename="${bundlePreview.filename}"`,
  );
  assert.match(bundleDownload.headers.get('cache-control'), /no-store/);
  assert.equal(bundleDownload.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(bundleDownload.headers.get('x-bundle-revision'), bundlePreview.revision);
  assert.equal(bundleDownload.headers.get('x-content-sha256'), bundlePreview.contentSha256);
  assert.equal(Number(bundleDownload.headers.get('content-length')), bundlePreview.byteLength);
  const bundleBytes = Buffer.from(await bundleDownload.arrayBuffer());
  assert.equal(bundleBytes.length, bundlePreview.byteLength);
  assert.equal(createHash('sha256').update(bundleBytes).digest('hex'), bundlePreview.contentSha256);
  const bundleEntries = storedZipEntries(bundleBytes);
  assert.equal(bundleEntries.size, 4);
  assert.deepEqual(bundleEntries.get('care-summary.json'), copyBytes);
  assert.deepEqual(
    JSON.parse(bundleEntries.get('manifest.json').toString('utf8')),
    bundlePreview.manifest,
  );
  for (const file of bundlePreview.manifest.files) {
    const fileBytes = bundleEntries.get(file.path);
    assert.deepEqual(fileBytes, file.type === 'image' ? bundleImageBytes : bundlePdfBytes);
    assert.equal(fileBytes.length, file.byteLength);
    assert.equal(createHash('sha256').update(fileBytes).digest('hex'), file.sha256);
  }
  const repeatBundle = await fetchBundle();
  assert.equal(repeatBundle.status, 200);
  assert.deepEqual(Buffer.from(await repeatBundle.arrayBuffer()), bundleBytes);
  const secondImageUpload = await visitWrite(
    '/images/upload',
    { ...imageCommand, requestId: randomUUID() },
    201,
  );
  const laterBundleImage = secondImageUpload.receipt.file;
  assert.notEqual(laterBundleImage.id, bundleImage.id);
  assert.equal(laterBundleImage.sha256, bundleImage.sha256);
  await visitWrite(
    `${bundlePath}/preview`,
    { attachments: [{ type: 'image', id: laterBundleImage.id }] },
    400,
  );
  const unchangedCatalogue = await (
    await fetch(`${bundleUrl}/attachments`, { headers: apiHeaders })
  ).json();
  assert.equal(unchangedCatalogue.total, 2);

  const newestCopy = await visitWrite(
    copiesPath,
    {
      expectedRevision: (await (await fetch(summaryUrl, { headers: apiHeaders })).json()).revision,
      requestId: randomUUID(),
    },
    201,
  );
  const copiesPage = await (
    await fetch(`${copiesUrl}?pageSize=10`, { headers: apiHeaders })
  ).json();
  assert.equal(copiesPage.total, 2);
  assert.equal(copiesPage.items[0].id, newestCopy.copy.id);
  assert.equal(copiesPage.items[1].id, savedCopy.copy.id);
  assert.ok(copiesPage.items.every((item) => !('summary' in item) && !('receipt' in item)));
  const savedSummaryRoute = await fetch(
    `${base}/clinic/patients/${patient.id}/summary?view=copies&copy=${savedCopy.copy.id}`,
  );
  assert.equal(savedSummaryRoute.status, 200);
  assert.match(savedSummaryRoute.headers.get('x-robots-tag'), /noindex/);
  assert.equal(
    (await fetch(`${base}/api/documents?patientId=missing`, { headers: apiHeaders })).status,
    404,
  );
  const emptyLibrary = await fetch(`${base}/api/public-library`);
  assert.equal(emptyLibrary.status, 200);
  assert.equal((await emptyLibrary.json()).total, 0);
  const privateKnowledgeReason = 'Synthetic private knowledge review note.';
  const libraryCreateBody = {
    fields: {
      title: 'Synthetic public clinic guide',
      category: 'Clinic information',
      body: 'Synthetic public reading paragraph.\nSecond line <script>synthetic</script> & details.',
    },
    publication: 'draft',
    reason: privateKnowledgeReason,
    requestId: randomUUID(),
  };
  const libraryCreated = await visitWrite('/knowledge-authoring', libraryCreateBody, 201);
  const libraryDraft = libraryCreated.detail.article;
  assert.equal(libraryCreated.event.operation, 'created');
  assert.equal(libraryCreated.version.version, 1);
  const authoringUrl = `${base}/api/knowledge-authoring/${libraryDraft.id}`;
  assert.equal((await fetch(authoringUrl)).status, 401);
  const articleUrl = `${base}/library/${libraryDraft.id}`;
  assert.equal((await fetch(articleUrl)).status, 404);
  assert.equal((await fetch(`${base}/api/public-library/${libraryDraft.id}`)).status, 404);
  const libraryPublished = await visitWrite(`/knowledge-authoring/${libraryDraft.id}/publication`, {
    published: true,
    reviewed: true,
    expectedRevision: libraryCreated.detail.revision,
    requestId: randomUUID(),
  });
  const libraryCreateReplay = await visitWrite('/knowledge-authoring', libraryCreateBody);
  assert.equal(libraryCreateReplay.event.id, libraryCreated.event.id);
  assert.equal(libraryCreateReplay.version.id, libraryCreated.version.id);
  assert.equal(libraryCreateReplay.detail.article.status, 'published');
  const publicArticleResponse = await fetch(articleUrl);
  assert.equal(publicArticleResponse.status, 200);
  assert.match(publicArticleResponse.headers.get('content-type'), /text\/html/);
  assert.match(publicArticleResponse.headers.get('cache-control'), /no-store/);
  assert.equal(publicArticleResponse.headers.get('etag'), null);
  const articleHtml = await publicArticleResponse.text();
  assert.match(articleHtml, /<h1[^>]*>Synthetic public clinic guide<\/h1>/);
  assert.ok(articleHtml.includes('Synthetic public reading paragraph.'));
  assert.ok(articleHtml.includes('&lt;script&gt;synthetic&lt;/script&gt;'));
  assert.ok(!articleHtml.includes('<script>synthetic</script>'));
  const bootstrapMatch = articleHtml.match(
    /<script\b[^>]*id="public-library-data"[^>]*>([\s\S]*?)<\/script>/,
  );
  assert.ok(bootstrapMatch);
  const libraryBootstrap = JSON.parse(bootstrapMatch[1]);
  assert.equal(libraryBootstrap.pageType, 'article');
  assert.equal(libraryBootstrap.article.id, libraryDraft.id);
  assert.equal(libraryBootstrap.indexable, true);
  assert.equal(libraryBootstrap.canonicalUrl, `${publicOrigin}/library/${libraryDraft.id}`);
  for (const value of [
    patient.id,
    privateDurationReason,
    privateSchedulingReason,
    account.csrfToken,
    privateKnowledgeReason,
    libraryCreateBody.requestId,
    libraryCreated.version.id,
  ])
    assert.equal(articleHtml.includes(value), false);
  const libraryHtmlResponse = await fetch(`${base}/library`);
  assert.equal(libraryHtmlResponse.status, 200);
  assert.match(await libraryHtmlResponse.text(), new RegExp(`href="/library/${libraryDraft.id}"`));
  const searchedLibrary = await fetch(`${base}/library?q=Synthetic`);
  assert.equal(searchedLibrary.status, 200);
  assert.match(searchedLibrary.headers.get('x-robots-tag'), /noindex/);
  const sitemapResponse = await fetch(`${base}/sitemap.xml`);
  assert.equal(sitemapResponse.status, 200);
  const sitemap = await sitemapResponse.text();
  assert.ok(sitemap.includes(`<loc>${publicOrigin}/library/${libraryDraft.id}</loc>`));
  for (const privatePath of ['/my-care', '/clinic/', '/account', patient.id])
    assert.equal(sitemap.includes(privatePath), false);
  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.ok(robots.includes(`Sitemap: ${publicOrigin}/sitemap.xml`));
  const librarySaveBody = {
    fields: {
      ...libraryCreateBody.fields,
      title: 'Synthetic revised public guide',
      body: 'Synthetic private revision awaiting review.',
    },
    publication: 'draft',
    expectedRevision: libraryPublished.detail.revision,
    requestId: randomUUID(),
  };
  const librarySaved = await visitWrite(
    `/knowledge-authoring/${libraryDraft.id}/save`,
    librarySaveBody,
  );
  assert.equal(librarySaved.version.version, 2);
  await visitWrite(
    `/knowledge-authoring/${libraryDraft.id}/save`,
    {
      ...librarySaveBody,
      fields: { ...librarySaveBody.fields, body: 'Stale text must not replace the latest draft.' },
      requestId: randomUUID(),
    },
    409,
  );
  const withdrawn = await fetch(articleUrl, { headers: { 'If-None-Match': '*' } });
  assert.equal(withdrawn.status, 404);
  const withdrawnHtml = await withdrawn.text();
  assert.ok(!withdrawnHtml.includes('Synthetic private revision'));
  assert.ok(!withdrawnHtml.includes(libraryDraft.title));
  assert.ok(!(await (await fetch(`${base}/sitemap.xml`)).text()).includes(libraryDraft.id));
  const libraryRepublished = await visitWrite(
    `/knowledge-authoring/${libraryDraft.id}/publication`,
    {
      published: true,
      reviewed: true,
      expectedRevision: librarySaved.detail.revision,
      requestId: randomUUID(),
    },
  );
  const republished = await fetch(articleUrl);
  assert.equal(republished.status, 200);
  assert.match(await republished.text(), /<h1[^>]*>Synthetic revised public guide<\/h1>/);
  const libraryRestoreBody = {
    versionId: libraryCreated.version.id,
    confirmed: true,
    reason: 'Synthetic restoration for fresh review.',
    expectedRevision: libraryRepublished.detail.revision,
    requestId: randomUUID(),
  };
  const libraryRestored = await visitWrite(
    `/knowledge-authoring/${libraryDraft.id}/restore`,
    libraryRestoreBody,
  );
  assert.equal(libraryRestored.version.version, 3);
  assert.equal(libraryRestored.version.restoredFromVersionId, libraryCreated.version.id);
  assert.equal(libraryRestored.detail.article.status, 'draft');
  assert.equal(libraryRestored.detail.publication, null);
  assert.deepEqual(libraryRestored.version.fields, libraryCreateBody.fields);
  assert.equal((await fetch(articleUrl)).status, 404);
  const libraryRestoreReplay = await visitWrite(
    `/knowledge-authoring/${libraryDraft.id}/restore`,
    libraryRestoreBody,
  );
  assert.equal(libraryRestoreReplay.event.id, libraryRestored.event.id);
  const libraryHistoryResponse = await fetch(`${authoringUrl}/history`, { headers: apiHeaders });
  assert.equal(libraryHistoryResponse.status, 200);
  assert.match(libraryHistoryResponse.headers.get('cache-control'), /no-store/);
  const libraryHistory = await libraryHistoryResponse.json();
  assert.equal(libraryHistory.total, 5);
  assert.equal(libraryHistory.items[0].operation, 'restored');
  const libraryVersions = await (
    await fetch(`${authoringUrl}/versions`, { headers: apiHeaders })
  ).json();
  assert.equal(libraryVersions.total, 3);
  assert.equal(libraryVersions.items[2].id, libraryCreated.version.id);
  await visitWrite(`/knowledge-authoring/${libraryDraft.id}/publication`, {
    published: true,
    reviewed: true,
    expectedRevision: libraryRestored.detail.revision,
    requestId: randomUUID(),
  });
  assert.match(
    await (await fetch(articleUrl)).text(),
    /<h1[^>]*>Synthetic public clinic guide<\/h1>/,
  );
  assert.equal((await fetch(`${base}/missing-public-page`)).status, 404);
  assert.equal((await fetch(`${base}/assets/missing-test.js`)).status, 404);
  const spa = await fetch(`${base}/clinic/scheduling`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('x-robots-tag'), /noindex/);
  const html = await spa.text();
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /\/assets\/index-/);
  assert.match(spa.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(spa.headers.get('x-content-type-options'), 'nosniff');
  assert.match(spa.headers.get('strict-transport-security'), /max-age=31536000/);
  const mfaUrl = `${base}/api/auth/mfa`;
  const mfaStatusResponse = await fetch(mfaUrl, { headers: apiHeaders });
  assert.equal(mfaStatusResponse.status, 200);
  assert.match(mfaStatusResponse.headers.get('cache-control'), /no-store/);
  const mfaStatus = await mfaStatusResponse.json();
  assert.equal(mfaStatus.available, true);
  assert.equal(mfaStatus.enabled, false);
  assert.deepEqual(mfaStatus.history, []);
  const mfaPreparation = await visitWrite('/auth/mfa/enrollment/prepare', {
    currentPassword: password,
    expectedRevision: mfaStatus.revision,
    requestId: randomUUID(),
  });
  assert.equal(mfaPreparation.setup.kind, 'enrollment');
  assert.equal(mfaPreparation.setup.recoveryCodes.length, 10);
  const enrollmentBody = {
    pendingId: mfaPreparation.setup.id,
    code: authenticatorCode(mfaPreparation.setup.secret),
    savedRecoveryCodes: true,
    expectedRevision: mfaPreparation.status.revision,
    requestId: randomUUID(),
  };
  const mfaEnabled = await visitWrite('/auth/mfa/enrollment/confirm', enrollmentBody);
  assert.equal(mfaEnabled.status.enabled, true);
  assert.equal(mfaEnabled.status.recoveryCodesRemaining, 10);
  assert.equal(mfaEnabled.event.operation, 'enabled');
  const enrollmentReplay = await visitWrite('/auth/mfa/enrollment/confirm', enrollmentBody);
  assert.equal(enrollmentReplay.event.id, mfaEnabled.event.id);
  assert.equal(JSON.stringify(mfaEnabled).includes(mfaPreparation.setup.secret), false);
  assert.equal(JSON.stringify(mfaEnabled).includes(mfaPreparation.setup.recoveryCodes[0]), false);
  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: apiHeaders,
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${base}/api/accounts`, { headers: apiHeaders })).status, 401);
  for (const path of [configurationPath, `${configurationPath}/history`])
    assert.equal((await fetch(`${base}${path}`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(summaryUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${bundleUrl}/attachments`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetchBundle()).status, 401);
  for (const privateCopyUrl of [copiesUrl, copyUrl, `${copyUrl}/download`])
    assert.equal((await fetch(privateCopyUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${base}/api/inventory/items`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${base}/api/clinic-resources`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${base}/api/search/patients`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(attendanceUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(durationUrl, { headers: apiHeaders })).status, 401);
  for (const path of [availabilityUrl, `${availabilityUrl}/history`])
    assert.equal((await fetch(path, { headers: apiHeaders })).status, 401);
  for (const path of [timeOffListUrl, timeOffUrl, `${timeOffUrl}/history`])
    assert.equal((await fetch(path, { headers: apiHeaders })).status, 401);
  for (const path of [doctorBookingUrl, `${doctorBookingUrl}/history`])
    assert.equal((await fetch(path, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(seriesUrl, { headers: apiHeaders })).status, 401);
  for (const privateCancellationUrl of [cancellationUrl, `${cancellationUrl}/context`])
    assert.equal((await fetch(privateCancellationUrl, { headers: apiHeaders })).status, 401);
  for (const privateRescheduleUrl of [rescheduleUrl, `${rescheduleUrl}/context`])
    assert.equal((await fetch(privateRescheduleUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(procedureScheduleUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(procedureSchedulingUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(catalogueUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(authoringUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${authoringUrl}/history`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(escalationPolicyUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(escalationPreviewUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(escalationHistoryUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(mfaUrl, { headers: apiHeaders })).status, 401);
  assert.equal(
    (await fetch(`${base}/api/insights/export?${range}`, { headers: apiHeaders })).status,
    401,
  );
  const challenged = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(challenged.status, 202);
  const challenge = await challenged.json();
  assert.equal(challenge.mfaRequired, true);
  assert.equal(challenge.accountId, account.user.id);
  assert.equal('user' in challenge, false);
  const challengeCookie = challenged.headers
    .getSetCookie()
    .find((value) => value.startsWith('derma_mfa_challenge='));
  assert.match(challengeCookie, /; HttpOnly/i);
  assert.match(challengeCookie, /; Secure/i);
  const challengeHeaders = {
    Cookie: challengeCookie.split(';')[0],
    'X-MFA-CSRF-Token': challenge.csrfToken,
    'Content-Type': 'application/json',
    Origin: base,
  };
  assert.equal((await fetch(`${base}/api/accounts`, { headers: challengeHeaders })).status, 401);
  const proofBody = {
    proof: { method: 'recovery-code', code: mfaPreparation.setup.recoveryCodes[0] },
  };
  const proof = await fetch(`${base}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: challengeHeaders,
    body: JSON.stringify(proofBody),
  });
  assert.equal(proof.status, 200);
  const verified = await proof.json();
  assert.equal(verified.user.id, account.user.id);
  const verifiedCookie = proof.headers
    .getSetCookie()
    .find((value) => value.startsWith('derma_session='));
  const verifiedHeaders = {
    ...apiHeaders,
    Cookie: verifiedCookie.split(';')[0],
    'X-CSRF-Token': verified.csrfToken,
  };
  const remaining = await (await fetch(mfaUrl, { headers: verifiedHeaders })).json();
  assert.equal(remaining.enabled, true);
  assert.equal(remaining.recoveryCodesRemaining, 9);
  const proofReplay = await fetch(`${base}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: challengeHeaders,
    body: JSON.stringify(proofBody),
  });
  assert.equal(proofReplay.status, 401);

  // Use a separate synthetic patient to check registration, logout evidence and
  // failed-password controls without changing any earlier empty-clinic checks.
  const registrationBody = {
    name: 'Synthetic authentication patient',
    email: 'smoke-auth-patient@example.test',
    password: randomBytes(24).toString('base64url'),
    phone: '9000000199',
    dob: '1994-06-15',
  };
  const publicHeaders = { 'Content-Type': 'application/json', Origin: base };
  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify(registrationBody),
  });
  assert.equal(registered.status, 201);
  const registeredSession = await registered.json();
  assert.equal(registeredSession.user.role, 'patient');
  const patientCookie = registered.headers
    .getSetCookie()
    .find((value) => value.startsWith('derma_session='));
  assert.match(patientCookie, /; Secure/i);
  assert.match(patientCookie, /; HttpOnly/i);
  const patientHeaders = {
    ...publicHeaders,
    Cookie: patientCookie.split(';')[0],
    'X-CSRF-Token': registeredSession.csrfToken,
  };
  for (const path of [configurationPath, `${configurationPath}/history`])
    assert.equal((await fetch(`${base}${path}`, { headers: patientHeaders })).status, 403);
  assert.equal((await fetch(`${bundleUrl}/attachments`, { headers: patientHeaders })).status, 403);
  assert.equal((await fetchBundle(patientHeaders)).status, 403);
  for (const path of [availabilityUrl, `${availabilityUrl}/history`])
    assert.equal((await fetch(path, { headers: patientHeaders })).status, 403);
  for (const path of [timeOffListUrl, timeOffUrl, `${timeOffUrl}/history`])
    assert.equal((await fetch(path, { headers: patientHeaders })).status, 403);
  for (const path of [doctorBookingUrl, `${doctorBookingUrl}/history`])
    assert.equal((await fetch(path, { headers: patientHeaders })).status, 403);
  const patientBookingStatusWrite = await fetch(doctorBookingUrl, {
    method: 'POST',
    headers: patientHeaders,
    body: JSON.stringify(pausedDoctorCommand),
  });
  assert.equal(patientBookingStatusWrite.status, 403);
  const patientTimeOffWrite = await fetch(`${base}/api/time-off`, {
    method: 'POST',
    headers: patientHeaders,
    body: JSON.stringify(timeOffCommand),
  });
  assert.equal(patientTimeOffWrite.status, 403);
  const patientAvailabilityWrite = await fetch(availabilityUrl, {
    method: 'POST',
    headers: patientHeaders,
    body: JSON.stringify(availabilityCommand),
  });
  assert.equal(patientAvailabilityWrite.status, 403);
  const patientConfigurationWrite = await fetch(`${base}${configurationPath}/profile`, {
    method: 'POST',
    headers: patientHeaders,
    body: JSON.stringify(profileCommand),
  });
  assert.equal(patientConfigurationWrite.status, 403);
  const duplicateRegistration = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({ ...registrationBody, email: registrationBody.email.toUpperCase() }),
  });
  assert.equal(duplicateRegistration.status, 409);
  assert.deepEqual(duplicateRegistration.headers.getSetCookie(), []);
  async function reminderRead(path, headers = verifiedHeaders) {
    const response = await fetch(`${base}/api${path}`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('cache-control'), /no-store/);
    return response.json();
  }
  async function reminderWrite(path, body, status = 200, method = 'POST') {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: verifiedHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }
  const reminderPolicyPath = '/appointment-reminder-policy';
  const reminderPreviewPath = '/appointment-reminders/preview';
  const reminderRunPath = '/appointment-reminders/run';
  const initialReminderPolicy = await reminderRead(reminderPolicyPath);
  assert.deepEqual(initialReminderPolicy.policy, { enabled: false, leadHours: 24 });
  assert.equal(initialReminderPolicy.latestChange, null);
  assert.equal(initialReminderPolicy.worker.automaticEnabled, true);
  assert.equal(initialReminderPolicy.worker.intervalSeconds, 300);
  assert.ok(initialReminderPolicy.worker.lastCheckedAt);
  const disabledReminders = await reminderRead(reminderPreviewPath);
  assert.equal(disabledReminders.status, 'disabled');
  assert.equal(disabledReminders.readyTotal, 0);
  assert.deepEqual(disabledReminders.items, []);
  const reminderDay = new Date(Date.parse(`${attendanceDay}T12:00:00Z`) + 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const reminderBooking = await reminderWrite(
    '/visit-duration/bookings',
    {
      patientId: registeredSession.user.patientId,
      doctorId: visitDoctor.id,
      date: reminderDay,
      time: '10:05',
      mode: 'in-person',
      reason: 'Synthetic shared upcoming appointment',
      durationMinutes: 45,
      requestId: randomUUID(),
    },
    201,
  );
  const reminderAppointment = reminderBooking.appointment;
  await reminderWrite(
    '/appointments',
    {
      patientId: patient.id,
      doctorId: visitDoctor.id,
      date: reminderDay,
      time: '14:00',
      mode: 'in-person',
      reason: 'Synthetic visit without a portal account',
    },
    201,
  );
  const privateReminderReason = 'Synthetic private appointment reminder policy reason';
  const reminderPolicyCommand = {
    enabled: true,
    leadHours: 72,
    reason: privateReminderReason,
    expectedRevision: initialReminderPolicy.revision,
    requestId: randomUUID(),
  };
  const enabledReminders = await reminderWrite(reminderPolicyPath, reminderPolicyCommand, 201);
  assert.deepEqual(enabledReminders.change.after, { enabled: true, leadHours: 72 });
  assert.deepEqual(
    (await reminderWrite(reminderPolicyPath, reminderPolicyCommand)).change,
    enabledReminders.change,
  );
  const initialReminderPreview = await reminderRead(reminderPreviewPath);
  assert.equal(initialReminderPreview.status, 'ready');
  assert.equal(initialReminderPreview.readyTotal, 1);
  assert.ok(initialReminderPreview.unroutableTotal >= 1);
  assert.equal(initialReminderPreview.items[0].appointment.id, reminderAppointment.id);
  assert.equal(initialReminderPreview.items[0].recipient.id, registeredSession.user.id);
  assert.equal(initialReminderPreview.items[0].appointment.durationMinutes, 45);
  assert.equal('reason' in initialReminderPreview.items[0].appointment, false);
  assert.equal('fee' in initialReminderPreview.items[0].appointment, false);
  const reminderCommand = {
    expectedPreviewRevision: initialReminderPreview.revision,
    expectedPolicyRevision: initialReminderPreview.policyRevision,
    confirmed: true,
    requestId: randomUUID(),
  };
  await reminderWrite(`/appointments/${reminderAppointment.id}`, { time: '10:10' }, 200, 'PATCH');
  await reminderWrite(reminderRunPath, reminderCommand, 409);
  const refreshedReminders = await reminderRead(reminderPreviewPath);
  reminderCommand.expectedPreviewRevision = refreshedReminders.revision;
  const reminderSummaryPath = `/patients/${registeredSession.user.patientId}/care-summary`;
  const beforeReminderSummary = await reminderRead(reminderSummaryPath, patientHeaders);
  const reminderRun = await reminderWrite(reminderRunPath, reminderCommand, 201);
  assert.equal(reminderRun.noticeCount, 1);
  assert.equal(reminderRun.events.length, 1);
  assert.equal(reminderRun.events[0].appointment.time, '10:10');
  assert.equal(reminderRun.events[0].recipient.id, registeredSession.user.id);
  assert.equal(reminderRun.source, 'manual');
  assert.equal(reminderRun.createdById, account.user.id);
  assert.deepEqual(await reminderWrite(reminderRunPath, reminderCommand), reminderRun);
  const afterReminderSummary = await reminderRead(reminderSummaryPath, patientHeaders);
  assert.equal(afterReminderSummary.revision, beforeReminderSummary.revision);
  const recordedReminderPreview = await reminderRead(reminderPreviewPath);
  assert.equal(recordedReminderPreview.readyTotal, 0);
  assert.equal(recordedReminderPreview.alreadyRecordedTotal, 1);
  const reminderHistoryPath = `/appointments/${reminderAppointment.id}/reminders`;
  const reminderHistory = await reminderRead(reminderHistoryPath);
  assert.equal(reminderHistory.current.state, 'recorded');
  assert.equal(reminderHistory.total, 1);
  assert.deepEqual(reminderHistory.items[0], reminderRun.events[0]);
  const reminderRuns = await reminderRead('/appointment-reminders/runs');
  assert.equal(reminderRuns.total, 1);
  assert.equal('events' in reminderRuns.items[0], false);
  assert.deepEqual(
    await reminderRead(`/appointment-reminders/runs/${reminderRun.id}`),
    reminderRun,
  );
  const reminderActivity = await reminderRead('/activity?limit=100', patientHeaders);
  const patientReminders = reminderActivity.items.filter(
    (item) => item.title === 'Upcoming appointment reminder',
  );
  assert.equal(patientReminders.length, 1);
  assert.equal(patientReminders[0].href, `/my-care?appointment=${reminderAppointment.id}`);
  for (const value of [reminderActivity, afterReminderSummary])
    for (const privateValue of [
      privateReminderReason,
      reminderPolicyCommand.requestId,
      reminderCommand.requestId,
      reminderRun.id,
    ])
      assert.equal(JSON.stringify(value).includes(privateValue), false);
  for (const path of [
    reminderPolicyPath,
    `${reminderPolicyPath}/history`,
    reminderPreviewPath,
    '/appointment-reminders/runs',
    `/appointment-reminders/runs/${reminderRun.id}`,
    reminderHistoryPath,
  ]) {
    assert.equal((await fetch(`${base}/api${path}`)).status, 401);
    assert.equal((await fetch(`${base}/api${path}`, { headers: patientHeaders })).status, 403);
  }
  const reminderDuration = await reminderRead(`/appointments/${reminderAppointment.id}/duration`);
  await reminderWrite(`/appointments/${reminderAppointment.id}/duration`, {
    durationPolicy: 'custom',
    durationMinutes: 60,
    date: reminderDay,
    time: '10:10',
    reason: 'Synthetic duration adjustment without another reminder',
    expectedRevision: reminderDuration.revision,
    requestId: randomUUID(),
  });
  assert.equal((await reminderRead(reminderPreviewPath)).readyTotal, 0);
  await reminderWrite(`/appointments/${reminderAppointment.id}`, { time: '10:20' }, 200, 'PATCH');
  const laterReminderPreview = await reminderRead(reminderPreviewPath);
  assert.equal(laterReminderPreview.readyTotal, 1);
  const laterReminderRun = await reminderWrite(
    reminderRunPath,
    {
      expectedPreviewRevision: laterReminderPreview.revision,
      expectedPolicyRevision: laterReminderPreview.policyRevision,
      confirmed: true,
      requestId: randomUUID(),
    },
    201,
  );
  assert.equal(laterReminderRun.events[0].appointment.durationMinutes, 60);
  await reminderWrite(`/appointments/${reminderAppointment.id}`, { time: '10:10' }, 200, 'PATCH');
  assert.equal((await reminderRead(reminderPreviewPath)).readyTotal, 0);
  await reminderWrite(
    `/appointments/${reminderAppointment.id}`,
    { status: 'cancelled' },
    200,
    'PATCH',
  );
  const cancelledReminderHistory = await reminderRead(reminderHistoryPath);
  assert.equal(cancelledReminderHistory.current.state, 'not-scheduled');
  assert.equal(cancelledReminderHistory.total, 2);
  assert.deepEqual(await reminderWrite(reminderRunPath, reminderCommand), reminderRun);
  const finalReminderActivity = await reminderRead('/activity?limit=100', patientHeaders);
  assert.equal(
    finalReminderActivity.items.filter((item) => item.title === 'Upcoming appointment reminder')
      .length,
    2,
  );
  const finalReminderPolicy = await reminderRead(reminderPolicyPath);
  await reminderWrite(
    reminderPolicyPath,
    {
      enabled: false,
      leadHours: 72,
      reason: 'Finish disposable reminder verification',
      expectedRevision: finalReminderPolicy.revision,
      requestId: randomUUID(),
    },
    201,
  );
  const oldPolicyReplay = await reminderWrite(reminderPolicyPath, reminderPolicyCommand);
  assert.equal(oldPolicyReplay.context.policy.enabled, false);
  assert.deepEqual(oldPolicyReplay.change, enabledReminders.change);
  assert.equal((await reminderRead(`${reminderPolicyPath}/history`)).total, 2);
  // Refunds record externally returned synthetic money; no payment provider is contacted.
  const refundInvoice = await reminderWrite(
    '/invoices',
    {
      patientId: registeredSession.user.patientId,
      requestId: randomUUID(),
      items: [{ description: 'Synthetic refundable service', quantity: 1, unitAmountPaise: 10000 }],
    },
    201,
  );
  const refundPayment = await reminderWrite(
    `/invoices/${refundInvoice.id}/payments`,
    {
      amountPaise: 10000,
      method: 'card',
      reference: 'Synthetic original receipt',
      requestId: randomUUID(),
    },
    201,
  );
  const refundPath = `/invoices/${refundInvoice.id}/payments/${refundPayment.payments[0].id}/refunds`;
  const refundSummaryPath = `/patients/${registeredSession.user.patientId}/care-summary`;
  const beforeRefundSummary = await reminderRead(refundSummaryPath, patientHeaders);
  const refundCopiesPath = `${refundSummaryPath}/copies`;
  const beforeRefundCopy = await reminderWrite(
    refundCopiesPath,
    {
      expectedRevision: beforeRefundSummary.revision,
      requestId: randomUUID(),
    },
    201,
  );
  const beforeRefundCopyUrl = `${base}/api${refundCopiesPath}/${beforeRefundCopy.copy.id}/download`;
  const beforeRefundBytes = Buffer.from(
    await (await fetch(beforeRefundCopyUrl, { headers: patientHeaders })).arrayBuffer(),
  );
  const refundCommand = {
    amountPaise: 4001,
    method: 'bank',
    reference: 'Synthetic external refund reference',
    reason: 'Synthetic partial service refund',
    refundedExternallyConfirmed: true,
    expectedRevision: refundPayment.revision,
    requestId: randomUUID(),
  };
  const refundRecorded = await reminderWrite(refundPath, refundCommand, 201);
  assert.equal(refundRecorded.detail.invoice.paidPaise, 5999);
  assert.equal(refundRecorded.detail.invoice.totalPaise, 10000);
  assert.equal(refundRecorded.detail.invoice.status, 'partial');
  assert.equal(refundRecorded.receipt.requestId, refundCommand.requestId);
  assert.equal(refundRecorded.detail.refunds.length, 1);
  await reminderWrite(refundPath, { ...refundCommand, requestId: randomUUID() }, 409);
  await reminderWrite(
    refundPath,
    {
      ...refundCommand,
      amountPaise: 6000,
      expectedRevision: refundRecorded.detail.revision,
      requestId: randomUUID(),
    },
    409,
  );
  await reminderWrite(
    `/invoices/${refundInvoice.id}/payments/${refundPayment.payments[0].id}/reverse`,
    {
      reason: 'Refunded payment is not an entry mistake',
      entryErrorConfirmed: true,
      expectedRevision: refundRecorded.detail.revision,
      requestId: randomUUID(),
    },
    409,
  );
  const refundFinal = await reminderWrite(
    refundPath,
    {
      ...refundCommand,
      amountPaise: 5999,
      method: 'cash',
      reference: '',
      reason: 'Synthetic remaining refund',
      expectedRevision: refundRecorded.detail.revision,
      requestId: randomUUID(),
    },
    201,
  );
  assert.equal(refundFinal.detail.invoice.paidPaise, 0);
  assert.equal(refundFinal.detail.invoice.status, 'unpaid');
  const refundedNoCharge = await reminderWrite(`/invoices/${refundInvoice.id}/corrections`, {
    items: [],
    reason: 'Synthetic cancelled service charges',
    removeAllChargesConfirmed: true,
    expectedRevision: refundFinal.detail.revision,
    requestId: randomUUID(),
  });
  assert.equal(refundedNoCharge.invoice.status, 'no-charge');
  const refundReplay = await reminderWrite(refundPath, refundCommand);
  assert.deepEqual(refundReplay.refund, refundRecorded.refund);
  assert.deepEqual(refundReplay.receipt, refundRecorded.receipt);
  assert.equal(refundReplay.detail.invoice.status, 'no-charge');
  assert.equal(refundReplay.detail.refunds.length, 2);
  const patientRefundDetail = await reminderRead(`/invoices/${refundInvoice.id}`, patientHeaders);
  assert.deepEqual(patientRefundDetail.refunds, refundReplay.detail.refunds);
  for (const entry of patientRefundDetail.refunds) {
    assert.equal('createdById' in entry, false);
    assert.equal('requestId' in entry, false);
    assert.equal('expectedRevision' in entry, false);
  }
  const afterRefundSummary = await reminderRead(refundSummaryPath, patientHeaders);
  assert.notEqual(afterRefundSummary.revision, beforeRefundSummary.revision);
  assert.deepEqual(
    afterRefundSummary.invoiceHistories.find((entry) => entry.invoiceId === refundInvoice.id)
      .refunds,
    patientRefundDetail.refunds,
  );
  assert.deepEqual(
    Buffer.from(
      await (await fetch(beforeRefundCopyUrl, { headers: patientHeaders })).arrayBuffer(),
    ),
    beforeRefundBytes,
  );
  const refundActivity = await reminderRead('/activity?limit=100', patientHeaders);
  assert.equal(
    refundActivity.items.filter(
      (entry) => entry.title === 'Your clinic recorded a refund completed outside the app',
    ).length,
    2,
  );
  const refundDate = (timestamp) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestamp));
  const refundRange = `from=${refundDate(refundPayment.payments[0].createdAt)}&to=${refundDate(refundFinal.refund.createdAt)}`;
  const refundReport = await reminderRead(`/insights?${refundRange}`);
  assert.equal(refundReport.totals.refundCount, 2);
  assert.equal(refundReport.totals.refundsPaise, 10000);
  assert.equal(refundReport.totals.collectionsPaise, 10000);
  assert.equal(refundReport.totals.netCollectionsPaise, 0);
  const refundCsv = await fetch(`${base}/api/insights/export?${refundRange}`, {
    headers: verifiedHeaders,
  });
  assert.equal(refundCsv.status, 200);
  assert.match(await refundCsv.text(), /"refundsPaise","","","10000"/);
  for (const [headers, status] of [
    [publicHeaders, 401],
    [patientHeaders, 403],
  ]) {
    const denied = await fetch(`${base}/api${refundPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(refundCommand),
    });
    assert.equal(denied.status, status);
  }
  // A mistaken refund is corrected without deleting the recorded return or moving money.
  const afterRefundCopy = await reminderWrite(
    refundCopiesPath,
    {
      expectedRevision: afterRefundSummary.revision,
      requestId: randomUUID(),
    },
    201,
  );
  const afterRefundCopyUrl = `${base}/api${refundCopiesPath}/${afterRefundCopy.copy.id}/download`;
  const afterRefundBytes = Buffer.from(
    await (await fetch(afterRefundCopyUrl, { headers: patientHeaders })).arrayBuffer(),
  );
  const refundVoidPath = `/invoices/${refundInvoice.id}/refunds/${refundRecorded.refund.id}/void`;
  const blockedVoid = {
    reason: 'Synthetic refund entered in error',
    entryErrorConfirmed: true,
    expectedRevision: refundedNoCharge.revision,
    requestId: randomUUID(),
  };
  await reminderWrite(refundVoidPath, blockedVoid, 409);
  const unchangedAfterBlockedVoid = await reminderRead(
    `/invoices/${refundInvoice.id}`,
    patientHeaders,
  );
  assert.equal(unchangedAfterBlockedVoid.invoice.paidPaise, 0);
  assert.deepEqual(unchangedAfterBlockedVoid.refundVoids, []);
  const restoredCharges = await reminderWrite(`/invoices/${refundInvoice.id}/corrections`, {
    items: refundInvoice.items,
    reason: 'Synthetic restoration of charges before correcting refund',
    expectedRevision: unchangedAfterBlockedVoid.revision,
    requestId: randomUUID(),
  });
  const refundVoidCommand = {
    ...blockedVoid,
    expectedRevision: restoredCharges.revision,
    requestId: randomUUID(),
  };
  const firstVoid = await reminderWrite(refundVoidPath, refundVoidCommand, 201);
  assert.equal(firstVoid.detail.invoice.paidPaise, 4001);
  assert.equal(firstVoid.detail.invoice.totalPaise, 10000);
  assert.equal(firstVoid.detail.invoice.status, 'partial');
  assert.deepEqual(firstVoid.detail.refunds, patientRefundDetail.refunds);
  assert.equal(firstVoid.detail.refundVoids.length, 1);
  assert.equal(firstVoid.void.amountPaise, 4001);
  assert.equal(firstVoid.receipt.requestId, refundVoidCommand.requestId);
  await reminderWrite(refundVoidPath, { ...refundVoidCommand, requestId: randomUUID() }, 409);
  const afterFirstVoidReport = await reminderRead(`/insights?${refundRange}`);
  assert.equal(afterFirstVoidReport.totals.collectionsPaise, 10000);
  assert.equal(afterFirstVoidReport.totals.refundsPaise, 5999);
  assert.equal(afterFirstVoidReport.totals.refundCount, 1);
  assert.equal(afterFirstVoidReport.totals.netCollectionsPaise, 4001);
  const secondVoid = await reminderWrite(
    `/invoices/${refundInvoice.id}/refunds/${refundFinal.refund.id}/void`,
    {
      reason: 'Synthetic second erroneous refund',
      entryErrorConfirmed: true,
      expectedRevision: firstVoid.detail.revision,
      requestId: randomUUID(),
    },
    201,
  );
  assert.equal(secondVoid.detail.invoice.paidPaise, 10000);
  assert.equal(secondVoid.detail.invoice.status, 'paid');
  assert.equal(secondVoid.detail.refundVoids.length, 2);
  const refundPaymentReversed = await reminderWrite(
    `/invoices/${refundInvoice.id}/payments/${refundPayment.payments[0].id}/reverse`,
    {
      reason: 'Synthetic original receipt also entered by mistake',
      entryErrorConfirmed: true,
      expectedRevision: secondVoid.detail.revision,
      requestId: randomUUID(),
    },
  );
  assert.equal(refundPaymentReversed.invoice.paidPaise, 0);
  assert.equal(refundPaymentReversed.invoice.status, 'unpaid');
  const voidReplay = await reminderWrite(refundVoidPath, refundVoidCommand);
  assert.deepEqual(voidReplay.void, firstVoid.void);
  assert.deepEqual(voidReplay.receipt, firstVoid.receipt);
  assert.equal(voidReplay.detail.invoice.paidPaise, 0);
  assert.equal(voidReplay.detail.refundVoids.length, 2);
  const originalRefundReplayAfterVoid = await reminderWrite(refundPath, refundCommand);
  assert.deepEqual(originalRefundReplayAfterVoid.refund, refundRecorded.refund);
  assert.equal(originalRefundReplayAfterVoid.detail.refundVoids.length, 2);
  await reminderWrite(
    refundPath,
    {
      ...refundCommand,
      expectedRevision: refundPaymentReversed.revision,
      requestId: randomUUID(),
    },
    409,
  );
  const voidedPatientDetail = await reminderRead(`/invoices/${refundInvoice.id}`, patientHeaders);
  assert.deepEqual(voidedPatientDetail.refundVoids, secondVoid.detail.refundVoids);
  for (const entry of voidedPatientDetail.refundVoids) {
    assert.equal('createdById' in entry, false);
    assert.equal('requestId' in entry, false);
    assert.equal('expectedRevision' in entry, false);
  }
  const voidedSummary = await reminderRead(refundSummaryPath, patientHeaders);
  assert.notEqual(voidedSummary.revision, afterRefundSummary.revision);
  assert.deepEqual(
    voidedSummary.invoiceHistories.find((entry) => entry.invoiceId === refundInvoice.id)
      .refundVoids,
    voidedPatientDetail.refundVoids,
  );
  assert.deepEqual(
    Buffer.from(await (await fetch(afterRefundCopyUrl, { headers: patientHeaders })).arrayBuffer()),
    afterRefundBytes,
  );
  const voidedReport = await reminderRead(`/insights?${refundRange}`);
  assert.equal(voidedReport.totals.refundCount, 0);
  assert.equal(voidedReport.totals.refundsPaise, 0);
  assert.equal(voidedReport.totals.collectionsPaise, 0);
  assert.equal(voidedReport.totals.netCollectionsPaise, 0);
  const voidedCsv = await fetch(`${base}/api/insights/export?${refundRange}`, {
    headers: verifiedHeaders,
  });
  assert.equal(voidedCsv.status, 200);
  assert.match(await voidedCsv.text(), /currently voided erroneous entries excluded/);
  for (const [headers, status] of [
    [publicHeaders, 401],
    [patientHeaders, 403],
  ]) {
    const denied = await fetch(`${base}/api${refundVoidPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(refundVoidCommand),
    });
    assert.equal(denied.status, status);
  }
  // Ordinary booking receipts remain definitive through later clinical operations.
  const ordinaryPath = '/appointment-bookings';
  async function ordinaryWrite(
    path,
    body,
    headers = verifiedHeaders,
    status = 201,
    method = 'POST',
  ) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status, `Unexpected ordinary-booking response: ${path}`);
    return response.json();
  }
  const ordinaryDoctor = await ordinaryWrite('/doctors', {
    name: 'Synthetic ordinary booking doctor',
    title: 'Dermatologist',
    qualifications: 'Synthetic only',
    specialties: ['General dermatology'],
    experience: 1,
    fee: 350,
    bio: 'Disposable booking recovery verification.',
    languages: ['English'],
  });
  await ordinaryWrite(
    `/schedules/${ordinaryDoctor.id}`,
    {
      durationMinutes: 30,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '09:00',
        end: '18:00',
        mode: 'both',
      })),
    },
    verifiedHeaders,
    200,
    'PUT',
  );
  const ordinaryDay = new Date(Date.parse(`${attendanceDay}T12:00:00Z`) + 130 * 86400000)
    .toISOString()
    .slice(0, 10);
  const ordinaryCommand = {
    patientId: registeredSession.user.patientId,
    doctorId: ordinaryDoctor.id,
    date: ordinaryDay,
    time: '09:30',
    mode: 'in-person',
    reason: 'Synthetic ordinary booking',
    requestId: randomUUID(),
  };
  const ordinaryBooked = await ordinaryWrite(ordinaryPath, ordinaryCommand, patientHeaders);
  assert.equal(ordinaryBooked.receipt.actorId, registeredSession.user.id);
  assert.equal(ordinaryBooked.receipt.patientId, ordinaryCommand.patientId);
  assert.equal(ordinaryBooked.receipt.requestId, ordinaryCommand.requestId);
  assert.equal(ordinaryBooked.booking.appointment.id, ordinaryBooked.appointment.id);
  assert.equal(ordinaryBooked.booking.appointment.fee, 350);
  assert.equal(ordinaryBooked.booking.waitlistId, null);
  assert.equal(ordinaryBooked.booking.patientConfirmed, false);
  assert.deepEqual(
    await ordinaryWrite(ordinaryPath, ordinaryCommand, patientHeaders, 200),
    ordinaryBooked,
  );
  const collision = await ordinaryWrite(
    ordinaryPath,
    { ...ordinaryCommand, time: '10:30' },
    patientHeaders,
    409,
  );
  assert.equal(collision.bookingOutcome, undefined);
  const otherActor = await ordinaryWrite(ordinaryPath, ordinaryCommand, verifiedHeaders, 409);
  assert.equal(otherActor.bookingOutcome, undefined);
  await ordinaryWrite(
    `/doctors/${ordinaryDoctor.id}`,
    {
      ...ordinaryDoctor,
      name: 'Renamed synthetic booking doctor',
      fee: 850,
    },
    verifiedHeaders,
    200,
    'PATCH',
  );
  const movedOrdinary = await ordinaryWrite(
    `/appointments/${ordinaryBooked.appointment.id}`,
    {
      date: ordinaryDay,
      time: '10:00',
      doctorId: ordinaryDoctor.id,
    },
    patientHeaders,
    200,
    'PATCH',
  );
  assert.equal(movedOrdinary.fee, 850);
  const ordinaryStatusPath = `/doctors/${ordinaryDoctor.id}/booking-status`;
  async function ordinaryAcceptance(acceptingNewBookings) {
    const context = await reminderRead(ordinaryStatusPath);
    return ordinaryWrite(ordinaryStatusPath, {
      acceptingNewBookings,
      reason: 'Synthetic booking-receipt lifecycle check',
      expectedRevision: context.revision,
      requestId: randomUUID(),
    });
  }
  await ordinaryAcceptance(false);
  const movedReplay = await ordinaryWrite(ordinaryPath, ordinaryCommand, patientHeaders, 200);
  assert.deepEqual(movedReplay.booking, ordinaryBooked.booking);
  assert.deepEqual(movedReplay.receipt, ordinaryBooked.receipt);
  assert.equal(movedReplay.appointment.time, '10:00');
  assert.equal(movedReplay.appointment.fee, 850);
  const rejectedCommand = { ...ordinaryCommand, time: '11:00', requestId: randomUUID() };
  const rejectedBooking = await ordinaryWrite(ordinaryPath, rejectedCommand, patientHeaders, 409);
  assert.deepEqual(rejectedBooking, {
    error:
      'This doctor is not accepting new bookings. Choose another doctor or contact the clinic.',
    bookingOutcome: 'not-created',
    requestId: rejectedCommand.requestId,
    actorId: registeredSession.user.id,
    patientId: ordinaryCommand.patientId,
  });
  await ordinaryAcceptance(true);
  assert.deepEqual(
    await ordinaryWrite(ordinaryPath, rejectedCommand, patientHeaders, 409),
    rejectedBooking,
  );
  const rejectedCollision = await ordinaryWrite(
    ordinaryPath,
    { ...rejectedCommand, time: '12:00' },
    patientHeaders,
    409,
  );
  assert.equal(rejectedCollision.bookingOutcome, undefined);
  const freshOrdinary = await ordinaryWrite(
    ordinaryPath,
    { ...rejectedCommand, requestId: randomUUID() },
    patientHeaders,
  );
  assert.notEqual(freshOrdinary.appointment.id, ordinaryBooked.appointment.id);
  const waiting = await ordinaryWrite(
    '/waitlist',
    {
      doctorId: ordinaryDoctor.id,
      mode: 'online',
      startDate: ordinaryDay,
      endDate: ordinaryDay,
      reason: 'Synthetic retry-safe waitlist fulfillment',
    },
    patientHeaders,
  );
  const waitlistBookingCommand = {
    ...ordinaryCommand,
    mode: 'online',
    time: '14:00',
    waitlistId: waiting.id,
    patientConfirmed: true,
    requestId: randomUUID(),
  };
  const waitlistBooked = await ordinaryWrite(ordinaryPath, waitlistBookingCommand);
  assert.equal(waitlistBooked.receipt.actorId, account.user.id);
  assert.equal(waitlistBooked.booking.waitlistId, waiting.id);
  assert.equal(waitlistBooked.booking.patientConfirmed, true);
  const closedWaiting = (await reminderRead('/waitlist', patientHeaders)).find(
    (entry) => entry.id === waiting.id,
  );
  assert.equal(closedWaiting.status, 'booked');
  assert.equal(closedWaiting.appointmentId, waitlistBooked.appointment.id);
  await ordinaryWrite(
    `/appointments/${waitlistBooked.appointment.id}`,
    { status: 'cancelled' },
    verifiedHeaders,
    200,
    'PATCH',
  );
  await ordinaryWrite(
    `/appointments/${ordinaryBooked.appointment.id}`,
    { status: 'cancelled' },
    patientHeaders,
    200,
    'PATCH',
  );
  await ordinaryAcceptance(false);
  const waitlistReplay = await ordinaryWrite(
    ordinaryPath,
    waitlistBookingCommand,
    verifiedHeaders,
    200,
  );
  assert.deepEqual(waitlistReplay.booking, waitlistBooked.booking);
  assert.deepEqual(waitlistReplay.receipt, waitlistBooked.receipt);
  assert.equal(waitlistReplay.appointment.status, 'cancelled');
  const cancelledReplay = await ordinaryWrite(ordinaryPath, ordinaryCommand, patientHeaders, 200);
  assert.deepEqual(cancelledReplay.booking, ordinaryBooked.booking);
  assert.equal(cancelledReplay.appointment.status, 'cancelled');
  const retryOrdinaryAppointments = await reminderRead('/appointments', patientHeaders);
  assert.equal(
    retryOrdinaryAppointments.filter((value) => value.doctorId === ordinaryDoctor.id).length,
    3,
  );
  const ordinaryAudit = await reminderRead(
    `/search/audit?entityType=appointment&entityId=${ordinaryBooked.appointment.id}`,
  );
  assert.equal(
    ordinaryAudit.items.filter((value) => value.action === 'booked appointment').length,
    1,
  );
  const waitlistAudit = await reminderRead(
    `/search/audit?entityType=waitlist&entityId=${waiting.id}`,
  );
  assert.equal(
    waitlistAudit.items.filter((value) => value.action === 'booked confirmed waitlist request')
      .length,
    1,
  );
  for (const projection of [
    retryOrdinaryAppointments,
    await reminderRead(reminderSummaryPath, patientHeaders),
  ]) {
    for (const privateValue of [
      ordinaryCommand.requestId,
      ordinaryBooked.booking.id,
      rejectedCommand.requestId,
      waitlistBookingCommand.requestId,
    ])
      assert.equal(JSON.stringify(projection).includes(privateValue), false);
  }
  const unauthenticatedBooking = await ordinaryWrite(
    ordinaryPath,
    ordinaryCommand,
    publicHeaders,
    401,
  );
  assert.equal(unauthenticatedBooking.bookingOutcome, undefined);

  // Reviewed single-visit moves retain resources and cannot overwrite a changed preview.
  const moveId = freshOrdinary.appointment.id;
  const moveBase = `/appointments/${moveId}`;
  const moveRoom = await ordinaryWrite('/clinic-resources', {
    name: 'Synthetic individual rescheduling room',
    kind: 'room',
    location: 'Disposable local verification',
    notes: '',
    requestId: randomUUID(),
  });
  const moveResources = await reminderRead(`${moveBase}/resources`);
  await ordinaryWrite(
    `${moveBase}/resources`,
    {
      resourceIds: [moveRoom.resource.id],
      reason: 'Synthetic room retained through a reviewed move',
      expectedRevision: moveResources.revision,
      requestId: randomUUID(),
    },
    verifiedHeaders,
    200,
    'PUT',
  );
  const moveContext = await reminderRead(`${moveBase}/reschedule-context`, patientHeaders);
  assert.equal(moveContext.canReschedule, true);
  const moveTarget = {
    doctorId: ordinaryDoctor.id,
    date: ordinaryDay,
    time: '12:00',
    mode: 'online',
  };
  const movePreview = await ordinaryWrite(
    `${moveBase}/reschedule-preview`,
    { ...moveTarget, expectedSourceRevision: moveContext.sourceRevision },
    patientHeaders,
    200,
  );
  assert.equal(movePreview.canReschedule, true);
  assert.equal(movePreview.before.time, '11:00');
  assert.equal(movePreview.after.fee, 850);
  assert.equal(JSON.stringify(movePreview).includes(moveRoom.resource.id), false);
  const staleMoveCommand = {
    ...moveTarget,
    expectedRevision: movePreview.revision,
    patientConfirmed: true,
    requestId: randomUUID(),
  };
  await ordinaryWrite(
    `/doctors/${ordinaryDoctor.id}`,
    { ...ordinaryDoctor, name: 'Reviewed individual move doctor', fee: 950 },
    verifiedHeaders,
    200,
    'PATCH',
  );
  const staleMove = await ordinaryWrite(
    `${moveBase}/reschedules`,
    staleMoveCommand,
    patientHeaders,
    409,
  );
  assert.equal(staleMove.rescheduleOutcome, 'not-applied');
  assert.equal(staleMove.requestId, staleMoveCommand.requestId);
  assert.equal(staleMove.actorId, registeredSession.user.id);
  assert.equal(staleMove.patientId, ordinaryCommand.patientId);
  assert.equal(staleMove.appointmentId, moveId);
  const freshMovePreview = await ordinaryWrite(
    `${moveBase}/reschedule-preview`,
    { ...moveTarget, expectedSourceRevision: moveContext.sourceRevision },
    patientHeaders,
    200,
  );
  assert.equal(freshMovePreview.before.time, '11:00');
  assert.equal(freshMovePreview.after.fee, 950);
  assert.notEqual(freshMovePreview.revision, movePreview.revision);
  assert.deepEqual(
    await ordinaryWrite(`${moveBase}/reschedules`, staleMoveCommand, patientHeaders, 409),
    staleMove,
  );
  const moveCommand = {
    ...staleMoveCommand,
    expectedRevision: freshMovePreview.revision,
    requestId: randomUUID(),
  };
  const moved = await ordinaryWrite(`${moveBase}/reschedules`, moveCommand, patientHeaders);
  assert.equal(moved.receipt.requestId, moveCommand.requestId);
  assert.equal(moved.receipt.actorId, registeredSession.user.id);
  assert.equal(moved.receipt.appointmentId, moveId);
  assert.equal(moved.event.before.time, '11:00');
  assert.equal(moved.event.before.fee, 850);
  assert.equal(moved.event.after.time, '12:00');
  assert.equal(moved.event.after.mode, 'online');
  assert.equal(moved.event.after.fee, 950);
  assert.deepEqual(moved.event.after, moved.appointment);
  assert.deepEqual(
    await ordinaryWrite(`${moveBase}/reschedules`, moveCommand, patientHeaders, 200),
    moved,
  );
  const retainedRoom = await reminderRead(`${moveBase}/resources`);
  assert.deepEqual(retainedRoom.resourceIds, [moveRoom.resource.id]);
  assert.equal(retainedRoom.appointment.time, '12:00');
  const moveCollision = await ordinaryWrite(
    `${moveBase}/reschedules`,
    moveCommand,
    verifiedHeaders,
    409,
  );
  assert.equal(moveCollision.rescheduleOutcome, undefined);
  await ordinaryWrite(moveBase, { time: '12:30' }, patientHeaders, 200, 'PATCH');
  await ordinaryWrite(moveBase, { status: 'cancelled' }, patientHeaders, 200, 'PATCH');
  const closedMoveReplay = await ordinaryWrite(
    `${moveBase}/reschedules`,
    moveCommand,
    patientHeaders,
    200,
  );
  assert.deepEqual(closedMoveReplay.event, moved.event);
  assert.deepEqual(closedMoveReplay.receipt, moved.receipt);
  assert.equal(closedMoveReplay.appointment.time, '12:30');
  assert.equal(closedMoveReplay.appointment.status, 'cancelled');
  assert.equal(
    (await reminderRead(`${moveBase}/reschedule-context`, patientHeaders)).canReschedule,
    false,
  );
  assert.deepEqual((await reminderRead(`${moveBase}/resources`)).resourceIds, []);
  const moveAudit = await reminderRead(`/search/audit?entityType=appointment&entityId=${moveId}`);
  assert.equal(
    moveAudit.items.filter((value) => value.action === 'rescheduled appointment').length,
    2,
  );
  for (const projection of [
    await reminderRead('/appointments', patientHeaders),
    await reminderRead(reminderSummaryPath, patientHeaders),
  ]) {
    for (const privateValue of [moveCommand.requestId, moved.event.id, staleMoveCommand.requestId])
      assert.equal(JSON.stringify(projection).includes(privateValue), false);
  }
  const anonymousMove = await ordinaryWrite(
    `${moveBase}/reschedules`,
    moveCommand,
    publicHeaders,
    401,
  );
  assert.equal(anonymousMove.rescheduleOutcome, undefined);

  // Individual cancellation reviews the exact visit and retained allocations.
  await ordinaryAcceptance(true);
  const individualCancellationBooking = await ordinaryWrite('/visit-duration/bookings', {
    patientId: ordinaryCommand.patientId,
    doctorId: ordinaryDoctor.id,
    date: ordinaryDay,
    time: '15:00',
    mode: 'in-person',
    reason: 'Synthetic reviewed cancellation with a retained custom length',
    durationMinutes: 90,
    requestId: randomUUID(),
  });
  const individualCancellationBase = `/appointments/${individualCancellationBooking.appointment.id}`;
  const unallocatedCancellation = await reminderRead(
    `${individualCancellationBase}/cancellation-context`,
    patientHeaders,
  );
  assert.equal(unallocatedCancellation.canCancel, true);
  const individualCancellationResources = await reminderRead(
    `${individualCancellationBase}/resources`,
  );
  await ordinaryWrite(
    `${individualCancellationBase}/resources`,
    {
      resourceIds: [moveRoom.resource.id],
      reason: 'Synthetic cancellation releases the retained room',
      expectedRevision: individualCancellationResources.revision,
      requestId: randomUUID(),
    },
    verifiedHeaders,
    200,
    'PUT',
  );
  const staleCancellationCommand = {
    expectedRevision: unallocatedCancellation.revision,
    cancellationConfirmed: true,
    requestId: randomUUID(),
  };
  const rejectedCancellation = await ordinaryWrite(
    `${individualCancellationBase}/cancellations`,
    staleCancellationCommand,
    patientHeaders,
    409,
  );
  assert.equal(rejectedCancellation.cancellationOutcome, 'not-applied');
  assert.equal(rejectedCancellation.requestId, staleCancellationCommand.requestId);
  assert.equal(rejectedCancellation.actorId, registeredSession.user.id);
  assert.equal(rejectedCancellation.patientId, ordinaryCommand.patientId);
  assert.equal(rejectedCancellation.appointmentId, individualCancellationBooking.appointment.id);
  const allocatedCancellation = await reminderRead(
    `${individualCancellationBase}/cancellation-context`,
    patientHeaders,
  );
  assert.notEqual(allocatedCancellation.revision, unallocatedCancellation.revision);
  await ordinaryWrite(individualCancellationBase, { time: '15:30' }, patientHeaders, 200, 'PATCH');
  await ordinaryWrite(individualCancellationBase, { time: '15:00' }, patientHeaders, 200, 'PATCH');
  const returnedCancellation = await reminderRead(
    `${individualCancellationBase}/cancellation-context`,
    patientHeaders,
  );
  assert.deepEqual(returnedCancellation.appointment, allocatedCancellation.appointment);
  assert.notEqual(returnedCancellation.revision, allocatedCancellation.revision);
  const staleMovedCancellation = await ordinaryWrite(
    `${individualCancellationBase}/cancellations`,
    {
      expectedRevision: allocatedCancellation.revision,
      cancellationConfirmed: true,
      requestId: randomUUID(),
    },
    patientHeaders,
    409,
  );
  assert.equal(staleMovedCancellation.cancellationOutcome, 'not-applied');
  await ordinaryAcceptance(false);
  await ordinaryWrite(
    `/doctors/${ordinaryDoctor.id}`,
    { ...ordinaryDoctor, name: 'Later cancellation profile', fee: 1250 },
    verifiedHeaders,
    200,
    'PATCH',
  );
  const individualCancellationContext = await reminderRead(
    `${individualCancellationBase}/cancellation-context`,
    patientHeaders,
  );
  assert.equal(individualCancellationContext.revision, returnedCancellation.revision);
  assert.equal(JSON.stringify(individualCancellationContext).includes(moveRoom.resource.id), false);
  const individualCancellationCommand = {
    expectedRevision: individualCancellationContext.revision,
    cancellationConfirmed: true,
    requestId: randomUUID(),
  };
  const waitingBeforeCancellation = await reminderRead('/waitlist', patientHeaders);
  const individualCancellation = await ordinaryWrite(
    `${individualCancellationBase}/cancellations`,
    individualCancellationCommand,
    patientHeaders,
  );
  assert.deepEqual(individualCancellation.event.before, individualCancellationContext.appointment);
  assert.deepEqual(individualCancellation.event.after, {
    ...individualCancellationContext.appointment,
    status: 'cancelled',
  });
  assert.deepEqual(individualCancellation.appointment, individualCancellation.event.after);
  assert.equal(individualCancellation.appointment.durationMinutes, 90);
  assert.equal(individualCancellation.appointment.fee, 950);
  assert.equal(individualCancellation.receipt.actorId, registeredSession.user.id);
  assert.equal(individualCancellation.receipt.requestId, individualCancellationCommand.requestId);
  assert.equal(individualCancellation.receipt.eventId, individualCancellation.event.id);
  assert.deepEqual((await reminderRead(`${individualCancellationBase}/resources`)).resourceIds, []);
  assert.deepEqual(
    await ordinaryWrite(
      `${individualCancellationBase}/cancellations`,
      individualCancellationCommand,
      patientHeaders,
      200,
    ),
    individualCancellation,
  );
  assert.deepEqual(
    await ordinaryWrite(
      `${individualCancellationBase}/cancellations`,
      staleCancellationCommand,
      patientHeaders,
      409,
    ),
    rejectedCancellation,
  );
  assert.deepEqual(await reminderRead('/waitlist', patientHeaders), waitingBeforeCancellation);
  const cancelledCalendar = await fetch(`${base}/api${individualCancellationBase}/calendar`, {
    headers: patientHeaders,
  });
  assert.equal(cancelledCalendar.status, 200);
  assert.match(await cancelledCalendar.text(), /STATUS:CANCELLED/);
  const individualCancellationAudit = await reminderRead(
    `/search/audit?entityType=appointment&entityId=${individualCancellation.appointment.id}`,
  );
  assert.equal(
    individualCancellationAudit.items.filter((entry) => entry.action === 'appointment cancelled')
      .length,
    1,
  );
  const individualCancellationCollision = await ordinaryWrite(
    `${individualCancellationBase}/cancellations`,
    individualCancellationCommand,
    verifiedHeaders,
    409,
  );
  assert.equal(individualCancellationCollision.cancellationOutcome, undefined);
  for (const projection of [
    await reminderRead('/appointments', patientHeaders),
    await reminderRead(reminderSummaryPath, patientHeaders),
  ]) {
    for (const value of [
      individualCancellationCommand.requestId,
      individualCancellation.event.id,
      staleCancellationCommand.requestId,
    ])
      assert.equal(JSON.stringify(projection).includes(value), false);
  }
  const anonymousCancellation = await ordinaryWrite(
    `${individualCancellationBase}/cancellations`,
    individualCancellationCommand,
    publicHeaders,
    401,
  );
  assert.equal(anonymousCancellation.cancellationOutcome, undefined);

  // Staff progression retains the booked interval; no-show releases that interval.
  // Synthetic historical fixtures make this proof independent of time of day.
  const stateSmokeDay = new Date(Date.parse(`${refundDate(new Date())}T12:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const stateSmokeVisits = ['09:00', '11:00'].map((time) => ({
    ...individualCancellationBooking.appointment,
    id: randomUUID(),
    date: stateSmokeDay,
    time,
    status: 'scheduled',
    reason: 'Synthetic historical state smoke only',
  }));
  await historicalStateFixtures(stateSmokeVisits, moveRoom.resource);
  const stateSmokeBase = `/appointments/${stateSmokeVisits[0].id}`;
  const stateSmokeContext = await reminderRead(`${stateSmokeBase}/state-context`);
  assert.equal(
    stateSmokeContext.actions.find((action) => action.status === 'checked-in').allowed,
    true,
  );
  const stateSmokeCommand = {
    status: 'checked-in',
    expectedRevision: stateSmokeContext.revision,
    changeConfirmed: true,
    requestId: randomUUID(),
  };
  const stateSmokeCheckedIn = await ordinaryWrite(
    `${stateSmokeBase}/state-changes`,
    stateSmokeCommand,
  );
  assert.deepEqual(stateSmokeCheckedIn.event.before, stateSmokeVisits[0]);
  assert.deepEqual(stateSmokeCheckedIn.event.after, {
    ...stateSmokeVisits[0],
    status: 'checked-in',
  });
  assert.equal(stateSmokeCheckedIn.receipt.status, 'checked-in');
  assert.equal(stateSmokeCheckedIn.receipt.actorId, account.user.id);
  const stateSmokeRejectedCommand = {
    ...stateSmokeCommand,
    status: 'no-show',
    requestId: randomUUID(),
  };
  const stateSmokeRejected = await ordinaryWrite(
    `${stateSmokeBase}/state-changes`,
    stateSmokeRejectedCommand,
    verifiedHeaders,
    409,
  );
  assert.equal(stateSmokeRejected.stateChangeOutcome, 'not-applied');
  let stateSmokeLatest = stateSmokeCheckedIn;
  for (const status of ['in-consultation', 'completed']) {
    const context = await reminderRead(`${stateSmokeBase}/state-context`);
    stateSmokeLatest = await ordinaryWrite(`${stateSmokeBase}/state-changes`, {
      status,
      expectedRevision: context.revision,
      changeConfirmed: true,
      requestId: randomUUID(),
    });
    assert.deepEqual(stateSmokeLatest.appointment, { ...stateSmokeVisits[0], status });
  }
  const stateSmokeResources = await reminderRead(`${stateSmokeBase}/resources`);
  assert.deepEqual(stateSmokeResources.resourceIds, [moveRoom.resource.id]);
  assert.equal(stateSmokeResources.history.length, 3);
  assert.ok(stateSmokeResources.history.every((entry) => entry.source === 'appointment-status'));
  assert.deepEqual(
    await ordinaryWrite(`${stateSmokeBase}/state-changes`, stateSmokeCommand, verifiedHeaders, 200),
    { ...stateSmokeCheckedIn, appointment: stateSmokeLatest.appointment },
  );
  assert.deepEqual(
    await ordinaryWrite(
      `${stateSmokeBase}/state-changes`,
      stateSmokeRejectedCommand,
      verifiedHeaders,
      409,
    ),
    stateSmokeRejected,
  );
  const stateSmokeCollision = await ordinaryWrite(
    `${stateSmokeBase}/state-changes`,
    { ...stateSmokeCommand, status: 'completed' },
    verifiedHeaders,
    409,
  );
  assert.equal(stateSmokeCollision.stateChangeOutcome, undefined);
  const stateSmokeNoShowBase = `/appointments/${stateSmokeVisits[1].id}`;
  const stateSmokeNoShowCommand = {
    status: 'no-show',
    expectedRevision: (await reminderRead(`${stateSmokeNoShowBase}/state-context`)).revision,
    changeConfirmed: true,
    requestId: randomUUID(),
  };
  const stateSmokeNoShow = await ordinaryWrite(
    `${stateSmokeNoShowBase}/state-changes`,
    stateSmokeNoShowCommand,
  );
  assert.deepEqual(stateSmokeNoShow.appointment, { ...stateSmokeVisits[1], status: 'no-show' });
  assert.deepEqual((await reminderRead(`${stateSmokeNoShowBase}/resources`)).resourceIds, []);
  assert.deepEqual(
    await ordinaryWrite(
      `${stateSmokeNoShowBase}/state-changes`,
      stateSmokeNoShowCommand,
      verifiedHeaders,
      200,
    ),
    stateSmokeNoShow,
  );
  const stateSmokeAudit = await reminderRead(
    `/search/audit?entityType=appointment&entityId=${stateSmokeVisits[0].id}`,
  );
  for (const status of ['checked-in', 'in-consultation', 'completed'])
    assert.equal(
      stateSmokeAudit.items.filter((entry) => entry.action === `appointment ${status}`).length,
      1,
    );
  for (const projection of [
    await reminderRead('/appointments', patientHeaders),
    await reminderRead(reminderSummaryPath, patientHeaders),
  ])
    for (const value of [
      stateSmokeCommand.requestId,
      stateSmokeCheckedIn.event.id,
      stateSmokeRejectedCommand.requestId,
    ])
      assert.equal(JSON.stringify(projection).includes(value), false);
  for (const [headers, status] of [
    [publicHeaders, 401],
    [patientHeaders, 403],
  ]) {
    assert.equal(
      (await fetch(`${base}/api${stateSmokeBase}/state-context`, { headers })).status,
      status,
    );
    const denied = await ordinaryWrite(
      `${stateSmokeBase}/state-changes`,
      stateSmokeCommand,
      headers,
      status,
    );
    assert.equal(denied.stateChangeOutcome, undefined);
  }

  // Original consultation text and amendments are permanent private records.
  // Exact retries must recover their evidence without creating duplicate notes.
  const consultationSmokePath = '/consultation-notes';
  const consultationSmokePatient = registeredSession.user.patientId;
  const consultationSmokeSummary = await reminderRead(reminderSummaryPath, patientHeaders);
  const consultationSmokeInput = {
    patientId: consultationSmokePatient,
    appointmentId: stateSmokeVisits[0].id,
    history: 'PRIVATE synthetic consultation history for smoke verification',
    examination: 'PRIVATE synthetic observed findings, no clinical advice',
    assessment: 'PRIVATE synthetic clinician-entered assessment',
    investigations: '',
    plan: 'PRIVATE synthetic documentation plan',
    reviewedConfirmed: true,
    requestId: randomUUID(),
  };
  const consultationSmokeRejectedInput = {
    ...consultationSmokeInput,
    appointmentId: randomUUID(),
    requestId: randomUUID(),
  };
  const consultationSmokeRejected = await ordinaryWrite(
    consultationSmokePath,
    consultationSmokeRejectedInput,
    verifiedHeaders,
    400,
  );
  assert.equal(consultationSmokeRejected.consultationOutcome, 'not-recorded');
  assert.equal(consultationSmokeRejected.encounterId, null);
  const consultationSmokeCreated = await ordinaryWrite(
    consultationSmokePath,
    consultationSmokeInput,
  );
  assert.equal(consultationSmokeCreated.encounter.patientId, consultationSmokePatient);
  assert.equal(consultationSmokeCreated.encounter.appointmentId, stateSmokeVisits[0].id);
  assert.equal(consultationSmokeCreated.encounter.doctorId, visitDoctor.id);
  assert.equal(consultationSmokeCreated.encounter.assessment, consultationSmokeInput.assessment);
  assert.equal(consultationSmokeCreated.amendment, null);
  assert.deepEqual(consultationSmokeCreated.receipt, {
    requestId: consultationSmokeInput.requestId,
    actorId: account.user.id,
    operation: 'create',
    patientId: consultationSmokePatient,
    encounterId: consultationSmokeCreated.encounter.id,
    amendmentId: null,
    doctorId: visitDoctor.id,
  });
  const consultationSmokeAuthor = (await reminderRead('/doctors')).find(
    (doctor) => doctor.id === visitDoctor.id,
  );
  await ordinaryWrite(
    `/doctors/${visitDoctor.id}`,
    {
      ...consultationSmokeAuthor,
      name: 'Later synthetic consultation author',
    },
    verifiedHeaders,
    200,
    'PATCH',
  );
  const consultationSmokeAmendmentPath = `/encounters/${consultationSmokeCreated.encounter.id}/amendment-recordings`;
  const consultationSmokeAmendmentInput = {
    reason: 'PRIVATE synthetic correction reason',
    text: 'PRIVATE synthetic attributed correction without replacing the original',
    reviewedConfirmed: true,
    requestId: randomUUID(),
  };
  const consultationSmokeAmended = await ordinaryWrite(
    consultationSmokeAmendmentPath,
    consultationSmokeAmendmentInput,
  );
  assert.deepEqual(consultationSmokeAmended.encounter, consultationSmokeCreated.encounter);
  assert.equal(
    consultationSmokeAmended.amendment.doctorName,
    'Later synthetic consultation author',
  );
  assert.equal(consultationSmokeAmended.amendment.text, consultationSmokeAmendmentInput.text);
  assert.equal(consultationSmokeAmended.receipt.operation, 'amend');
  assert.equal(consultationSmokeAmended.receipt.amendmentId, consultationSmokeAmended.amendment.id);
  await ordinaryWrite(`/encounters/${consultationSmokeCreated.encounter.id}/amendments`, {
    reason: 'PRIVATE synthetic later legacy clarification',
    text: 'PRIVATE synthetic legacy amendment',
  });
  const { appointmentId: consultationSmokeLinkedId, ...consultationSmokeStandaloneInput } =
    consultationSmokeInput;
  assert.equal(consultationSmokeLinkedId, stateSmokeVisits[0].id);
  const consultationSmokeStandalone = await ordinaryWrite(consultationSmokePath, {
    ...consultationSmokeStandaloneInput,
    requestId: randomUUID(),
  });
  assert.equal('appointmentId' in consultationSmokeStandalone.encounter, false);
  assert.deepEqual(
    await ordinaryWrite(consultationSmokePath, consultationSmokeInput, verifiedHeaders, 200),
    consultationSmokeCreated,
  );
  assert.deepEqual(
    await ordinaryWrite(
      consultationSmokeAmendmentPath,
      consultationSmokeAmendmentInput,
      verifiedHeaders,
      200,
    ),
    consultationSmokeAmended,
  );
  assert.deepEqual(
    await ordinaryWrite(
      consultationSmokePath,
      consultationSmokeRejectedInput,
      verifiedHeaders,
      400,
    ),
    consultationSmokeRejected,
  );
  const consultationSmokeCollision = await ordinaryWrite(
    consultationSmokeAmendmentPath,
    {
      ...consultationSmokeAmendmentInput,
      requestId: consultationSmokeInput.requestId,
    },
    verifiedHeaders,
    409,
  );
  assert.equal(consultationSmokeCollision.consultationOutcome, undefined);
  const consultationSmokeRecord = await reminderRead(`/patients/${consultationSmokePatient}`);
  assert.deepEqual(
    consultationSmokeRecord.encounters.find(
      (note) => note.id === consultationSmokeCreated.encounter.id,
    ),
    consultationSmokeCreated.encounter,
  );
  assert.equal(consultationSmokeRecord.encounters.length, 2);
  const consultationSmokeWorkflows = await reminderRead(
    `/patients/${consultationSmokePatient}/clinical-workflows`,
  );
  assert.equal(
    consultationSmokeWorkflows.amendments.filter(
      (entry) => entry.encounterId === consultationSmokeCreated.encounter.id,
    ).length,
    2,
  );
  const consultationSmokeAudit = await reminderRead(
    `/search/audit?entityType=encounter&entityId=${consultationSmokeCreated.encounter.id}`,
  );
  assert.equal(
    consultationSmokeAudit.items.filter((entry) => entry.action === 'recorded consultation').length,
    1,
  );
  assert.equal(
    consultationSmokeAudit.items.filter((entry) => entry.action === 'added consultation amendment')
      .length,
    2,
  );
  assert.equal(
    (await reminderRead(reminderSummaryPath, patientHeaders)).revision,
    consultationSmokeSummary.revision,
  );
  for (const projection of [
    await reminderRead(`/patients/${consultationSmokePatient}`, patientHeaders),
    await reminderRead(`/patients/${consultationSmokePatient}/clinical-workflows`, patientHeaders),
    await reminderRead(reminderSummaryPath, patientHeaders),
    consultationSmokeAudit,
  ])
    for (const value of [
      consultationSmokeInput.history,
      consultationSmokeAmendmentInput.text,
      consultationSmokeInput.requestId,
      consultationSmokeAmendmentInput.requestId,
    ])
      assert.equal(JSON.stringify(projection).includes(value), false);
  for (const [headers, status] of [
    [publicHeaders, 401],
    [patientHeaders, 403],
  ])
    for (const [path, body] of [
      [consultationSmokePath, consultationSmokeInput],
      [consultationSmokeAmendmentPath, consultationSmokeAmendmentInput],
    ]) {
      const denied = await ordinaryWrite(path, body, headers, status);
      assert.equal(denied.consultationOutcome, undefined);
    }

  const messagePath = '/messages/send';
  const threadPath = `/messages?patientId=${registeredSession.user.patientId}`;
  const threadBefore = await reminderRead(threadPath, patientHeaders);
  for (const [sender, headers, recipientHeaders] of [
    [registeredSession.user, patientHeaders, verifiedHeaders],
    [verified.user, verifiedHeaders, patientHeaders],
  ]) {
    const body = `Private synthetic message from ${sender.role}`;
    const command = { patientId: registeredSession.user.patientId, body, requestId: randomUUID() };
    const inboxPath = '/activity?limit=1';
    const previousInbox = await reminderRead(inboxPath, recipientHeaders);
    const saved = await ordinaryWrite(messagePath, command, headers);
    const { message } = saved.receipt;
    assert.match(message.id, /^[a-f0-9-]{36}$/);
    assert.equal(new Date(message.createdAt).toISOString(), message.createdAt);
    assert.deepEqual(saved.receipt, {
      requestId: command.requestId,
      actorId: sender.id,
      actorName: sender.name,
      actorRole: sender.role,
      patientId: command.patientId,
      message: {
        id: message.id,
        patientId: command.patientId,
        body,
        authorName: sender.name,
        authorRole: sender.role,
        createdAt: message.createdAt,
      },
    });
    assert.deepEqual(await ordinaryWrite(messagePath, command, headers, 200), saved);
    const inbox = await reminderRead(inboxPath, recipientHeaders);
    assert.equal(inbox.unreadCount, previousInbox.unreadCount + 1);
    assert.equal(inbox.items[0].kind, 'message');
    assert.equal(JSON.stringify(inbox).includes(body), false);
    const thread = await reminderRead(threadPath, patientHeaders);
    assert.deepEqual(
      thread.filter((item) => item.id === message.id),
      [message],
    );
    const audits = await reminderRead(`/search/audit?entityType=message&entityId=${message.id}`);
    assert.deepEqual(
      audits.items.map((item) => item.action),
      ['sent care message'],
    );
    const summary = await reminderRead(reminderSummaryPath, patientHeaders);
    assert.equal(summary.revision, consultationSmokeSummary.revision);
    assert.equal(JSON.stringify(summary).includes(body), false);
    assert.equal(JSON.stringify(thread).includes(command.requestId), false);
  }
  assert.equal((await reminderRead(threadPath)).length, threadBefore.length + 2);

  const intakePath = '/intakes/submit';
  const intakeAnswers = {
    concern: 'Synthetic patient history',
    location: 'Forearm',
    duration: 'Two days',
    symptoms: 'Patient-reported change',
    triggers: '',
    previousTreatment: '',
    medications: '',
    allergies: 'A patient-reported sensitivity',
    goals: 'Discuss the change at the next visit',
    consent: true,
  };
  const intakeCommand = {
    ...intakeAnswers,
    goals: `  ${intakeAnswers.goals}  `,
    requestId: randomUUID(),
    patientId: registeredSession.user.patientId,
  };
  const intakeResult = await ordinaryWrite(intakePath, intakeCommand, patientHeaders);
  const { intake } = intakeResult.receipt;
  assert.match(intake.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(intake.createdAt).toISOString(), intake.createdAt);
  assert.deepEqual(intakeResult.receipt, {
    requestId: intakeCommand.requestId,
    patientId: intakeCommand.patientId,
    actorId: registeredSession.user.id,
    intake: {
      ...intakeAnswers,
      id: intake.id,
      patientId: intakeCommand.patientId,
      createdAt: intake.createdAt,
    },
  });
  assert.deepEqual(
    await ordinaryWrite(intakePath, intakeCommand, patientHeaders, 200),
    intakeResult,
  );
  const intakeSummary = await reminderRead(reminderSummaryPath, patientHeaders);
  assert.deepEqual(intakeSummary.intakes, [intake]);
  assert.notEqual(intakeSummary.revision, consultationSmokeSummary.revision);
  assert.deepEqual(intakeSummary.patient, consultationSmokeSummary.patient);
  assert.equal(JSON.stringify(intakeSummary).includes(intakeCommand.requestId), false);
  const clinicRecord = await reminderRead(`/patients/${intake.patientId}`);
  assert.deepEqual(clinicRecord.intakes, [intake]);
  const intakeAudit = await reminderRead(`/search/audit?entityType=intake&entityId=${intake.id}`);
  assert.deepEqual(
    intakeAudit.items.map((entry) => entry.action),
    ['submitted intake'],
  );

  const creationPath = '/care-plans/create';
  const planFields = {
    title: 'Synthetic plan reviewed with the patient',
    instructions: 'Synthetic instructions recorded for this test.',
    expectations: 'Review at the next visit.',
    warnings: 'Synthetic clinician-entered precautions.',
    cost: 'Discussed at the visit',
    startDate: visitDay,
    endDate: visitDay,
    followUpDate: visitDay,
    medications: [
      {
        name: 'Synthetic item',
        instructions: 'Test entry only.',
        schedule: 'As recorded',
        duration: 'One visit',
        warnings: '',
      },
    ],
  };
  const planCommand = {
    ...planFields,
    requestId: randomUUID(),
    patientId: registeredSession.user.patientId,
    doctorId: visitDoctor.id,
    reviewedConfirmed: true,
  };
  const createdPlan = await ordinaryWrite(creationPath, planCommand);
  const originalPlan = createdPlan.receipt.plan;
  assert.match(originalPlan.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(originalPlan.createdAt).toISOString(), originalPlan.createdAt);
  const planAuthor = (await reminderRead('/doctors')).find((d) => d.id === visitDoctor.id);
  assert.deepEqual(createdPlan.receipt, {
    requestId: planCommand.requestId,
    actorId: verified.user.id,
    patientId: planCommand.patientId,
    doctorId: planCommand.doctorId,
    plan: {
      ...planFields,
      id: originalPlan.id,
      createdAt: originalPlan.createdAt,
      status: 'active',
      patientId: planCommand.patientId,
      patientName: intakeSummary.patient.name,
      doctorId: planAuthor.id,
      doctorName: planAuthor.name,
    },
  });
  const completedPlan = await ordinaryWrite(
    `/care-plans/${originalPlan.id}`,
    { status: 'completed' },
    verifiedHeaders,
    200,
    'PATCH',
  );
  assert.equal(completedPlan.effectiveStatus, 'completed');
  assert.deepEqual(
    await ordinaryWrite(creationPath, planCommand, verifiedHeaders, 200),
    createdPlan,
  );
  const patientPlans = await reminderRead('/care-plans', patientHeaders);
  const matchingPlans = patientPlans.filter((plan) => plan.id === originalPlan.id);
  assert.equal(matchingPlans.length, 1);
  assert.equal(matchingPlans[0].status, 'completed');
  assert.deepEqual(matchingPlans[0].medications, planFields.medications);
  const planNotice = (await reminderRead('/activity?limit=100', patientHeaders)).items.filter(
    (notice) => notice.kind === 'care-plan' && notice.href === `/my-care?plan=${originalPlan.id}`,
  );
  assert.equal(planNotice.length, 1);
  const planAudit = await reminderRead(
    `/search/audit?entityType=carePlan&entityId=${originalPlan.id}`,
  );
  assert.equal(planAudit.items.filter((entry) => entry.action === 'created care plan').length, 1);
  const stalePlan = { ...planCommand, doctorId: ordinaryDoctor.id, requestId: randomUUID() };
  const rejection = await ordinaryWrite(creationPath, stalePlan, verifiedHeaders, 409);
  assert.equal(rejection.code, 'CARE_PLAN_NOT_CREATED');
  assert.deepEqual(rejection.command, stalePlan);
  assert.deepEqual(await ordinaryWrite(creationPath, stalePlan, verifiedHeaders, 409), rejection);
  const planSummary = await reminderRead(reminderSummaryPath, patientHeaders);
  for (const projection of [patientPlans, planSummary, planNotice]) {
    const json = JSON.stringify(projection);
    assert.equal(json.includes(planCommand.requestId), false);
    assert.equal(json.includes(stalePlan.requestId), false);
  }

  const patientLogout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: patientHeaders,
    body: '{}',
  });
  assert.equal(patientLogout.status, 200);
  const deniedIntake = await ordinaryWrite(intakePath, intakeCommand, patientHeaders, 401);
  assert.equal(deniedIntake.receipt, undefined);
  assert.equal(deniedIntake.code, undefined);
  const loggedOutBooking = await ordinaryWrite(ordinaryPath, ordinaryCommand, patientHeaders, 401);
  assert.equal(loggedOutBooking.bookingOutcome, undefined);
  const loggedOutMove = await ordinaryWrite(
    `${moveBase}/reschedules`,
    moveCommand,
    patientHeaders,
    401,
  );
  assert.equal(loggedOutMove.rescheduleOutcome, undefined);
  const loggedOutCancellation = await ordinaryWrite(
    `${individualCancellationBase}/cancellations`,
    individualCancellationCommand,
    patientHeaders,
    401,
  );
  assert.equal(loggedOutCancellation.cancellationOutcome, undefined);
  assert.equal(
    (await (await fetch(`${base}/api/session`, { headers: patientHeaders })).json()).user,
    null,
  );
  const patientAudit = await fetch(
    `${base}/api/search/audit?entityType=user&entityId=${registeredSession.user.id}`,
    { headers: verifiedHeaders },
  );
  assert.equal(patientAudit.status, 200);
  assert.deepEqual((await patientAudit.json()).items.map((entry) => entry.action).sort(), [
    'registered',
    'signed out',
  ]);
  const failedPassword = 'SyntheticIncorrectPassword2026!';
  for (let attempt = 0; attempt < 10; attempt++) {
    const rejected = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: publicHeaders,
      body: JSON.stringify({ email: registrationBody.email, password: failedPassword }),
    });
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), { error: 'Email or password is incorrect.' });
  }
  const throttled = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({
      email: registrationBody.email.toUpperCase(),
      password: registrationBody.password,
    }),
  });
  assert.equal(throttled.status, 429);
  const retryAfter = Number(throttled.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 900);
  assert.match((await throttled.json()).error, new RegExp(`Wait at least ${retryAfter} seconds`));
  assert.deepEqual(throttled.headers.getSetCookie(), []);
  const securityResponse = await fetch(`${base}/api/search/audit?entityType=auth-security`, {
    headers: verifiedHeaders,
  });
  assert.equal(securityResponse.status, 200);
  const securityEvidence = await securityResponse.json();
  assert.equal(securityEvidence.total, 3);
  assert.deepEqual(
    securityEvidence.items.map((entry) => entry.action).sort(),
    [
      'authentication failed',
      'authentication failure limit reached',
      'authentication throttled',
    ].sort(),
  );
  assert.ok(securityEvidence.items.every((entry) => entry.actorName === 'Unauthenticated'));
  assert.ok(
    securityEvidence.items.every((entry) => /^identifier:login:[a-f0-9]{64}$/.test(entry.entityId)),
  );
  for (const secret of [
    registrationBody.email,
    registrationBody.password,
    failedPassword,
    '127.0.0.1',
  ])
    assert.equal(JSON.stringify(securityEvidence).includes(secret), false);

  assert.equal(
    (
      await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: verifiedHeaders,
        body: '{}',
      })
    ).status,
    200,
  );
  assert.equal((await fetch(mfaUrl, { headers: verifiedHeaders })).status, 401);
  const stateSmokeLoggedOut = await ordinaryWrite(
    `${stateSmokeBase}/state-changes`,
    stateSmokeCommand,
    verifiedHeaders,
    401,
  );
  assert.equal(stateSmokeLoggedOut.stateChangeOutcome, undefined);
  for (const [path, body] of [
    [consultationSmokePath, consultationSmokeInput],
    [consultationSmokeAmendmentPath, consultationSmokeAmendmentInput],
  ]) {
    const denied = await ordinaryWrite(path, body, verifiedHeaders, 401);
    assert.equal(denied.consultationOutcome, undefined);
  }
  assert.equal(
    (await fetch(`${base}/api${reminderPolicyPath}`, { headers: verifiedHeaders })).status,
    401,
  );
  assert.equal(
    (await fetch(`${base}/api${reminderHistoryPath}`, { headers: verifiedHeaders })).status,
    401,
  );
  console.log(
    `Production smoke passed (${image ? 'container' : 'local'}): fresh bootstrap, no demo data, secure session, migrations, private API guards, built SPA, independent versioned clinic settings/history/retries, reviewed weekly availability/history/booking protection, retained time-off edits/cancellation/overlap protection/retries, doctor booking pause/resume and existing-visit continuity, ordinary and waitlist booking receipts with definitive rejected-command retries, reviewed individual rescheduling and cancellation with retained-resource history and safe outcome retries, reviewed staff progression/no-show with exact outcomes after completion, permanent consultation notes/amendments with exact receipts and private projections, recurring appointment series/cancellations/rescheduling/retries, upcoming in-app reminders/deduplication/history/retries, external refunds/entry voids/corrected balances/reports, immutable care-summary copies/downloads/retries/selected attachment ZIPs, public library HTML/publication/sitemap, versioned knowledge edits/restoration/retries, security headers, registration, audited logout, password throttling.`,
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (containerStarted) await command('docker', ['stop', '--time', '10', container]);
  await rm(directory, { recursive: true, force: true });
}
