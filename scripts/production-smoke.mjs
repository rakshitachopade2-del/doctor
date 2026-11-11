import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
const password = randomBytes(24).toString('base64url');
const directory = await mkdtemp(join(tmpdir(), 'derma-production-'));
const container = `derma-smoke-${randomUUID()}`;
let child;
let containerStarted = false;
let runtimeLog = '';

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
    await command('docker', [
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
      '-p',
      '127.0.0.1::3001',
      image,
    ]);
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
      TRUST_PROXY: 'false',
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
  const cookie = login.headers.get('set-cookie');
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
  const schedules = await fetch(`${base}/api/scheduling`, { headers: apiHeaders });
  assert.deepEqual((await schedules.json()).schedules, []);
  const activity = await fetch(`${base}/api/activity`, { headers: apiHeaders });
  assert.equal(activity.status, 200);
  assert.deepEqual((await activity.json()).items, []);
  const followUps = await fetch(`${base}/api/follow-up-worklist`, { headers: apiHeaders });
  assert.equal(followUps.status, 200);
  assert.deepEqual(await followUps.json(), []);
  const range = 'from=2026-01-01&to=2026-01-01';
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
  assert.deepEqual(summary.carePlans, []);
  const summaryDownload = await fetch(`${summaryUrl}/download?revision=${summary.revision}`, {
    headers: apiHeaders,
  });
  assert.equal(summaryDownload.status, 200);
  assert.match(summaryDownload.headers.get('content-disposition'), /attachment/);
  assert.match(summaryDownload.headers.get('cache-control'), /no-store/);
  assert.equal((await summaryDownload.json()).revision, summary.revision);
  assert.equal(
    (await fetch(`${base}/api/documents?patientId=missing`, { headers: apiHeaders })).status,
    404,
  );
  const spa = await fetch(`${base}/clinic/scheduling`);
  assert.equal(spa.status, 200);
  const html = await spa.text();
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /\/assets\/index-/);
  assert.match(spa.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(spa.headers.get('x-content-type-options'), 'nosniff');
  assert.match(spa.headers.get('strict-transport-security'), /max-age=31536000/);
  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: apiHeaders,
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${base}/api/accounts`, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(summaryUrl, { headers: apiHeaders })).status, 401);
  assert.equal((await fetch(`${base}/api/inventory/items`, { headers: apiHeaders })).status, 401);
  assert.equal(
    (await fetch(`${base}/api/insights/export?${range}`, { headers: apiHeaders })).status,
    401,
  );
  console.log(
    `Production smoke passed (${image ? 'container' : 'local'}): fresh bootstrap, no demo data, secure session, migrations, private API guards, built SPA, security headers, logout.`,
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (containerStarted) await command('docker', ['stop', '--time', '10', container]);
  await rm(directory, { recursive: true, force: true });
}
