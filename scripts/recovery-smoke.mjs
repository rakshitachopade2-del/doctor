import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function command(binary, args, { env = process.env, input = '' } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveCommand(output.trim())
        : reject(new Error(`Recovery rehearsal command failed (${code}): ${errors}`)),
    );
    child.stdin.end(input);
  });
}

// The same rehearsal runs inside a disposable image without exposing any port.
const imageIndex = process.argv.indexOf('--image');
if (imageIndex >= 0) {
  const image = process.argv[imageIndex + 1];
  if (!image || process.argv.length !== 4)
    throw new Error('Usage: npm run test:recovery -- --image IMAGE');
  const container = `derma-recovery-${randomUUID()}`;
  try {
    console.log(
      await command(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          '--name',
          container,
          '--init',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--entrypoint',
          'node',
          image,
          '--import',
          'tsx',
          '--input-type=module',
          '-',
        ],
        { input: await readFile(new URL(import.meta.url), 'utf8') },
      ),
    );
  } finally {
    await command('docker', ['rm', '-f', container]).catch(() => {});
  }
} else {
  await rehearseRecovery();
}

async function rehearseRecovery() {
  const { createApp } = await import(pathToFileURL(resolve('server/app.ts')).href);
  const { createUser, clinicToday, addDays } = await import(
    pathToFileURL(resolve('server/db.ts')).href
  );
  const { fromBase32, totpAt } = await import(pathToFileURL(resolve('server/mfa-crypto.ts')).href);
  const directory = await mkdtemp(join(tmpdir(), 'derma-recovery-rehearsal-'));
  const original = join(directory, 'original.sqlite');
  const snapshot = join(directory, 'snapshot.sqlite');
  const restored = join(directory, 'restored.sqlite');
  const password = randomBytes(24).toString('base64url');
  const mfaKey = randomBytes(32).toString('hex');
  const runtimes = [];
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const cli = async (...args) =>
    JSON.parse(await command(process.execPath, ['--import', 'tsx', 'server/restore.ts', ...args]));
  async function open(path) {
    const app = createApp({
      databasePath: path,
      production: true,
      demoMode: false,
      mfaEncryptionKey: mfaKey,
    });
    let server;
    try {
      server = await new Promise((resolveServer, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolveServer(listener));
        listener.once('error', reject);
      });
    } catch (error) {
      app.locals.close();
      throw error;
    }
    const runtime = {
      app,
      base: `http://127.0.0.1:${server.address().port}`,
      close: async () => {
        if (runtime.closed) return;
        runtime.closed = true;
        try {
          await new Promise((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          );
        } finally {
          app.locals.close();
        }
      },
    };
    runtimes.push(runtime);
    return runtime;
  }
  const client = () => ({ cookies: new Map() });
  async function call(
    runtime,
    path,
    who = client(),
    method = 'GET',
    body,
    expected = 200,
    raw = false,
  ) {
    const response = await fetch(`${runtime.base}/api${path}`, {
      method,
      headers: {
        Origin: runtime.base,
        Cookie: [...who.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who.csrf ? { 'X-CSRF-Token': who.csrf } : {}),
        ...(who.challengeCsrf ? { 'X-MFA-CSRF-Token': who.challengeCsrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const data =
      !raw && response.headers.get('content-type')?.includes('application/json')
        ? JSON.parse(bytes.toString())
        : bytes;
    assert.equal(response.status, expected, `${method} ${path}: unexpected response status`);
    for (const cookie of response.headers.getSetCookie()) {
      const [name, ...parts] = cookie.split(';')[0].split('=');
      const value = parts.join('=');
      if (value) who.cookies.set(name, value);
      else who.cookies.delete(name);
    }
    if (data.mfaRequired) who.challengeCsrf = data.csrfToken;
    else if (data.csrfToken) who.csrf = data.csrfToken;
    return data;
  }
  try {
    const source = await open(original);
    const db = source.app.locals.db;
    createUser(
      db,
      {
        id: 'recovery-admin',
        name: 'Synthetic recovery administrator',
        email: 'recovery-admin@example.test',
        role: 'admin',
        active: true,
      },
      password,
    );
    createUser(
      db,
      {
        id: 'recovery-mfa',
        name: 'Synthetic authenticator account',
        email: 'recovery-mfa@example.test',
        role: 'doctor',
        active: true,
      },
      password,
    );
    const admin = client(),
      patient = client(),
      mfa = client();
    await call(source, '/auth/login', admin, 'POST', {
      email: 'recovery-admin@example.test',
      password,
    });
    const registered = await call(
      source,
      '/auth/register',
      patient,
      'POST',
      {
        name: 'Synthetic recovery patient',
        email: 'recovery-patient@example.test',
        password,
        phone: '9000000149',
        dob: '1994-05-16',
      },
      201,
    );
    const patientId = registered.user.patientId;
    const doctor = await call(
      source,
      '/doctors',
      admin,
      'POST',
      {
        name: 'Synthetic recovery doctor',
        title: 'Dermatologist',
        qualifications: 'Synthetic only',
        specialties: ['General dermatology'],
        experience: 1,
        fee: 500,
        bio: 'Local recovery rehearsal only.',
        languages: ['English'],
      },
      201,
    );
    let visitDate = addDays(clinicToday(), 20);
    if (new Date(`${visitDate}T12:00:00Z`).getUTCDay() === 0) visitDate = addDays(visitDate, 1);
    const ordinaryCommand = {
      patientId,
      doctorId: doctor.id,
      date: visitDate,
      time: '09:00',
      mode: 'in-person',
      reason: 'Synthetic retained ordinary booking',
      requestId: randomUUID(),
    };
    const ordinary = await call(
      source,
      '/appointment-bookings',
      patient,
      'POST',
      ordinaryCommand,
      201,
    );
    const bookingPath = `/doctors/${doctor.id}/booking-status`;
    const bookingContext = await call(source, bookingPath, admin);
    const pauseInput = {
      acceptingNewBookings: false,
      reason: 'Synthetic retained booking pause',
      expectedRevision: bookingContext.revision,
      requestId: randomUUID(),
    };
    const pause = await call(source, bookingPath, admin, 'POST', pauseInput, 201);
    const rejectedCommand = { ...ordinaryCommand, time: '10:00', requestId: randomUUID() };
    const rejected = await call(
      source,
      '/appointment-bookings',
      patient,
      'POST',
      rejectedCommand,
      409,
    );
    assert.equal(rejected.bookingOutcome, 'not-created');
    const rescheduleBase = `/appointments/${ordinary.appointment.id}`;
    const rescheduleSource = await call(source, `${rescheduleBase}/reschedule-context`, patient);
    const rescheduleTarget = {
      doctorId: doctor.id,
      date: visitDate,
      time: '09:30',
      mode: 'online',
    };
    const reschedulePreview = await call(
      source,
      `${rescheduleBase}/reschedule-preview`,
      patient,
      'POST',
      { ...rescheduleTarget, expectedSourceRevision: rescheduleSource.sourceRevision },
    );
    assert.equal(reschedulePreview.canReschedule, true);
    const rescheduleCommand = {
      ...rescheduleTarget,
      expectedRevision: reschedulePreview.revision,
      patientConfirmed: true,
      requestId: randomUUID(),
    };
    const rescheduled = await call(
      source,
      `${rescheduleBase}/reschedules`,
      patient,
      'POST',
      rescheduleCommand,
      201,
    );
    const rescheduleRejectedCommand = {
      ...rescheduleCommand,
      time: '10:30',
      requestId: randomUUID(),
    };
    const rescheduleRejected = await call(
      source,
      `${rescheduleBase}/reschedules`,
      patient,
      'POST',
      rescheduleRejectedCommand,
      409,
    );
    assert.equal(rescheduleRejected.rescheduleOutcome, 'not-applied');
    const retainedRescheduleSource = await call(
      source,
      `${rescheduleBase}/reschedule-context`,
      patient,
    );
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
      'base64',
    );
    const pdfBytes = Buffer.from('%PDF-1.7\nSynthetic recovery report only.\n%%EOF\n');
    const image = await call(
      source,
      '/images',
      patient,
      'POST',
      {
        caption: 'Synthetic recovery photograph',
        category: 'clinical',
        consent: true,
        dataUrl: `data:image/png;base64,${imageBytes.toString('base64')}`,
      },
      201,
    );
    const document = await call(
      source,
      '/documents',
      patient,
      'POST',
      {
        title: 'Synthetic recovery report',
        originalName: 'synthetic-report.pdf',
        consent: true,
        dataUrl: `data:application/pdf;base64,${pdfBytes.toString('base64')}`,
      },
      201,
    );
    const summaryPath = `/patients/${patientId}/care-summary`;
    const summary = await call(source, summaryPath, patient);
    const copyInput = { expectedRevision: summary.revision, requestId: randomUUID() };
    const copy = await call(source, `${summaryPath}/copies`, patient, 'POST', copyInput, 201);
    const copyPath = `${summaryPath}/copies/${copy.copy.id}/download`;
    const copyBytes = await call(source, copyPath, patient, 'GET', undefined, 200, true);
    const grant = await call(
      source,
      `/accounts/${registered.user.id}/recovery`,
      admin,
      'POST',
      { identityVerified: true },
      201,
    );

    await call(source, '/auth/login', mfa, 'POST', {
      email: 'recovery-mfa@example.test',
      password,
    });
    const mfaStatus = await call(source, '/auth/mfa', mfa);
    const setup = await call(source, '/auth/mfa/enrollment/prepare', mfa, 'POST', {
      currentPassword: password,
      expectedRevision: mfaStatus.revision,
      requestId: randomUUID(),
    });
    await call(source, '/auth/mfa/enrollment/confirm', mfa, 'POST', {
      pendingId: setup.setup.id,
      code: totpAt(fromBase32(setup.setup.secret), Date.now()),
      savedRecoveryCodes: true,
      expectedRevision: setup.status.revision,
      requestId: randomUUID(),
    });
    const oldChallenge = client();
    await call(
      source,
      '/auth/login',
      oldChallenge,
      'POST',
      { email: 'recovery-mfa@example.test', password },
      202,
    );
    const enrolled = await call(source, '/auth/mfa', mfa);
    await call(source, '/auth/mfa/recovery-codes/prepare', mfa, 'POST', {
      currentPassword: password,
      proof: { method: 'recovery-code', code: setup.setup.recoveryCodes[0] },
      expectedRevision: enrolled.revision,
      requestId: randomUUID(),
    });
    const preservedCredential = db
      .prepare('SELECT userId,id,secret,enabledAt FROM mfaCredentials')
      .get();
    const preservedUsers = db.prepare('SELECT * FROM users ORDER BY id').all();
    const oldPatient = { ...patient, cookies: new Map(patient.cookies) };
    const oldAdmin = { ...admin, cookies: new Map(admin.cookies) };
    const oldMfa = { ...mfa, cookies: new Map(mfa.cookies) };
    await command(process.execPath, ['--import', 'tsx', 'server/backup.ts', snapshot], {
      env: { ...process.env, DATABASE_PATH: original },
    });
    const snapshotHash = hash(await readFile(snapshot));
    const verified = await cli('verify', snapshot);
    assert.equal(verified.source.sha256, snapshotHash);
    assert.equal(verified.counts.mfaEnrolledAccounts, 1);
    assert.equal(verified.counts.tables.patients, 1);
    assert.equal(verified.counts.tables.mfaPending, 1);
    const recovered = await cli(
      'restore',
      snapshot,
      restored,
      '--reason',
      'Synthetic isolated recovery rehearsal',
    );
    assert.equal(recovered.checks.preservation, 'ok');
    assert.equal(recovered.source.sha256, snapshotHash);
    assert.equal(recovered.destination.sha256, hash(await readFile(restored)));
    assert.equal(recovered.mfaReplayProtectedCount, 1);
    for (const table of [
      'sessions',
      'recoveryGrants',
      'mfaChallenges',
      'mfaPending',
      'mfaRecoveryCodes',
    ]) {
      assert.ok(recovered.retired[table] > 0, `Expected ${table} to be exercised`);
      assert.equal(recovered.countsAfter[table], 0);
    }
    assert.equal(hash(await readFile(snapshot)), snapshotHash);
    // Recovery only prepared a new copy; the live original remains usable.
    assert.equal((await call(source, '/session', oldPatient)).user.id, registered.user.id);
    assert.equal((await call(source, '/session', oldAdmin)).user.id, 'recovery-admin');
    await source.close();

    const target = await open(restored);
    const restoredDb = target.app.locals.db;
    assert.deepEqual(
      restoredDb.prepare('SELECT userId,id,secret,enabledAt FROM mfaCredentials').get(),
      preservedCredential,
    );
    assert.deepEqual(restoredDb.prepare('SELECT * FROM users ORDER BY id').all(), preservedUsers);
    assert.equal((await call(target, '/health')).status, 'ok');
    for (const old of [oldPatient, oldAdmin, oldMfa]) {
      assert.equal((await call(target, '/session', old)).user, null);
      await call(target, '/activity', old, 'GET', undefined, 401);
    }
    await call(
      target,
      '/auth/recover',
      client(),
      'POST',
      { token: grant.token, password: randomBytes(24).toString('base64url') },
      400,
    );
    await call(
      target,
      '/auth/mfa/verify',
      oldChallenge,
      'POST',
      { proof: { method: 'recovery-code', code: setup.setup.recoveryCodes[1] } },
      401,
    );
    const newPatient = client(),
      newAdmin = client(),
      newMfa = client();
    await call(target, '/auth/login', newPatient, 'POST', {
      email: 'recovery-patient@example.test',
      password,
    });
    await call(target, '/auth/login', newAdmin, 'POST', {
      email: 'recovery-admin@example.test',
      password,
    });
    assert.deepEqual(await call(target, `/images/${image.id}/file`, newPatient), imageBytes);
    assert.deepEqual(await call(target, `/documents/${document.id}/file`, newPatient), pdfBytes);
    assert.deepEqual(
      await call(target, copyPath, newPatient, 'GET', undefined, 200, true),
      copyBytes,
    );
    assert.deepEqual(
      (await call(target, `${summaryPath}/copies`, newPatient, 'POST', copyInput, 200)).copy,
      copy.copy,
    );
    assert.deepEqual(
      (await call(target, bookingPath, newAdmin, 'POST', pauseInput, 200)).change,
      pause.change,
    );
    assert.equal((await call(target, '/doctors'))[0].acceptingNewBookings, false);
    assert.deepEqual(
      await call(target, '/appointment-bookings', newPatient, 'POST', ordinaryCommand),
      { ...ordinary, appointment: rescheduled.appointment },
    );
    assert.deepEqual(
      await call(target, `${rescheduleBase}/reschedules`, newPatient, 'POST', rescheduleCommand),
      rescheduled,
    );
    assert.equal(
      (await call(target, `${rescheduleBase}/reschedule-context`, newPatient)).sourceRevision,
      retainedRescheduleSource.sourceRevision,
    );
    await call(
      target,
      bookingPath,
      newAdmin,
      'POST',
      {
        acceptingNewBookings: true,
        reason: 'Synthetic restored clinic resumes booking',
        expectedRevision: (await call(target, bookingPath, newAdmin)).revision,
        requestId: randomUUID(),
      },
      201,
    );
    assert.deepEqual(
      await call(target, '/appointment-bookings', newPatient, 'POST', rejectedCommand, 409),
      rejected,
    );
    assert.deepEqual(
      await call(
        target,
        `${rescheduleBase}/reschedules`,
        newPatient,
        'POST',
        rescheduleRejectedCommand,
        409,
      ),
      rescheduleRejected,
    );
    assert.equal((await call(target, '/appointments', newPatient)).length, 1);
    const audit = await call(target, '/search/audit?entityType=database-recovery', newAdmin);
    assert.equal(audit.total, 1);
    assert.equal(audit.items[0].id, recovered.auditId);
    await call(
      target,
      '/auth/login',
      newMfa,
      'POST',
      { email: 'recovery-mfa@example.test', password },
      202,
    );
    await call(
      target,
      '/auth/mfa/verify',
      newMfa,
      'POST',
      { proof: { method: 'recovery-code', code: setup.setup.recoveryCodes[1] } },
      400,
    );
    // Wait for a fresh real authenticator step after the conservative restore guard.
    const lastStep = Number(
      restoredDb.prepare('SELECT lastStep FROM mfaCredentials').get().lastStep,
    );
    console.log(
      'Recovery preservation and retired-credential checks passed; waiting for a fresh authenticator code.',
    );
    while (Math.floor(Date.now() / 30000) <= lastStep)
      await delay(Math.min(10000, (lastStep + 1) * 30000 - Date.now() + 25));
    await call(target, '/auth/mfa/verify', newMfa, 'POST', {
      proof: { method: 'totp', code: totpAt(fromBase32(setup.setup.secret), Date.now()) },
    });
    const recoveredMfa = await call(target, '/auth/mfa', newMfa);
    assert.equal(recoveredMfa.enabled, true);
    assert.equal(recoveredMfa.recoveryCodesRemaining, 0);
    assert.equal(hash(await readFile(snapshot)), snapshotHash);
    console.log(
      'Recovery rehearsal passed: online backup, verified new-file restore, original preservation, private files and saved-copy bytes, booking and rescheduling receipts, retired sessions/recovery access, retained MFA with fresh authenticator sign-in, and recovery audit.',
    );
  } finally {
    const closed = await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    await rm(directory, { recursive: true, force: true });
    const failures = closed.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Recovery rehearsal cleanup failed.',
      );
  }
}
