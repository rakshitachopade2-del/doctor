import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
  await visitWrite(
    `/schedules/${visitDoctor.id}`,
    {
      durationMinutes: 20,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '09:00',
        end: '18:00',
        mode: 'both',
      })),
    },
    200,
    'PUT',
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
  const invoice = await billingWrite(
    '/invoices',
    {
      patientId: patient.id,
      requestId: randomUUID(),
      procedureId: procedurePlan.id,
      items: [{ description: 'Synthetic verification charge', quantity: 1, unitAmountPaise: 1000 }],
    },
    201,
  );
  const payment = await billingWrite(
    `/invoices/${invoice.id}/payments`,
    {
      amountPaise: 400,
      method: 'cash',
      reference: 'Synthetic entry only',
      requestId: randomUUID(),
    },
    201,
  );
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
  const summaryUrl = `${base}/api/patients/${patient.id}/care-summary`;
  const summaryResponse = await fetch(summaryUrl, { headers: apiHeaders });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.audience, 'patient');
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
  const newestCopy = await visitWrite(
    copiesPath,
    { expectedRevision: laterSummary.revision, requestId: randomUUID() },
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
  assert.equal((await fetch(summaryUrl, { headers: apiHeaders })).status, 401);
  for (const privateCopyUrl of [copiesUrl, copyUrl, `${copyUrl}/download`])
    assert.equal((await fetch(privateCopyUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${base}/api/inventory/items`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${base}/api/clinic-resources`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${base}/api/search/patients`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(attendanceUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(durationUrl, { headers: apiHeaders })).status, 401);
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
  const duplicateRegistration = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({ ...registrationBody, email: registrationBody.email.toUpperCase() }),
  });
  assert.equal(duplicateRegistration.status, 409);
  assert.deepEqual(duplicateRegistration.headers.getSetCookie(), []);
  const patientLogout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: patientHeaders,
    body: '{}',
  });
  assert.equal(patientLogout.status, 200);
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
  console.log(
    `Production smoke passed (${image ? 'container' : 'local'}): fresh bootstrap, no demo data, secure session, migrations, private API guards, built SPA, recurring appointment series/cancellations/rescheduling/retries, immutable care-summary copies/downloads/retries, public library HTML/publication/sitemap, versioned knowledge edits/restoration/retries, security headers, registration, audited logout, password throttling.`,
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (containerStarted) await command('docker', ['stop', '--time', '10', container]);
  await rm(directory, { recursive: true, force: true });
}
