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
    await call(source, '/accounts/recovery-admin', admin, 'PATCH', { doctorId: doctor.id });
    await call(source, '/auth/login', admin, 'POST', {
      email: 'recovery-admin@example.test',
      password,
    });
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
    const cancellationBooking = await call(
      source,
      '/appointment-bookings',
      patient,
      'POST',
      { ...ordinaryCommand, time: '11:00', requestId: randomUUID() },
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
    const cancellationBase = `/appointments/${cancellationBooking.appointment.id}`;
    const cancellationContext = await call(
      source,
      `${cancellationBase}/cancellation-context`,
      patient,
    );
    const rejectedCancellationCommand = {
      expectedRevision: 'a'.repeat(64),
      cancellationConfirmed: true,
      requestId: randomUUID(),
    };
    const rejectedCancellation = await call(
      source,
      `${cancellationBase}/cancellations`,
      patient,
      'POST',
      rejectedCancellationCommand,
      409,
    );
    assert.equal(rejectedCancellation.cancellationOutcome, 'not-applied');
    const cancellationCommand = {
      ...rejectedCancellationCommand,
      expectedRevision: cancellationContext.revision,
      requestId: randomUUID(),
    };
    const cancellation = await call(
      source,
      `${cancellationBase}/cancellations`,
      patient,
      'POST',
      cancellationCommand,
      201,
    );
    assert.deepEqual(cancellation.appointment, {
      ...cancellationBooking.appointment,
      status: 'cancelled',
    });
    const retainedCancellationContext = await call(
      source,
      `${cancellationBase}/cancellation-context`,
      patient,
    );
    // Historical synthetic row in this isolated rehearsal database. Public booking
    // correctly refuses past dates; no application fixture endpoint is introduced.
    const stateVisit = {
      ...ordinary.appointment,
      id: randomUUID(),
      date: addDays(clinicToday(), -1),
      time: '09:00',
      reason: 'Synthetic historical recovery state visit',
    };
    db.prepare(
      'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
    ).run(
      stateVisit.id,
      stateVisit.patientId,
      stateVisit.doctorId,
      stateVisit.date,
      stateVisit.time,
      stateVisit.status,
      JSON.stringify(stateVisit),
    );
    const stateBase = `/appointments/${stateVisit.id}`;
    const stateCommand = {
      status: 'checked-in',
      expectedRevision: (await call(source, `${stateBase}/state-context`, admin)).revision,
      changeConfirmed: true,
      requestId: randomUUID(),
    };
    const stateCheckedIn = await call(
      source,
      `${stateBase}/state-changes`,
      admin,
      'POST',
      stateCommand,
      201,
    );
    const stateRejectedCommand = { ...stateCommand, status: 'no-show', requestId: randomUUID() };
    const stateRejected = await call(
      source,
      `${stateBase}/state-changes`,
      admin,
      'POST',
      stateRejectedCommand,
      409,
    );
    assert.equal(stateRejected.stateChangeOutcome, 'not-applied');
    let stateCurrent = stateCheckedIn.appointment;
    for (const status of ['in-consultation', 'completed']) {
      const context = await call(source, `${stateBase}/state-context`, admin);
      stateCurrent = (
        await call(
          source,
          `${stateBase}/state-changes`,
          admin,
          'POST',
          {
            status,
            expectedRevision: context.revision,
            changeConfirmed: true,
            requestId: randomUUID(),
          },
          201,
        )
      ).appointment;
    }
    const retainedStateContext = await call(source, `${stateBase}/state-context`, admin);

    const consultationInput = {
      patientId,
      appointmentId: stateVisit.id,
      history: 'PRIVATE synthetic recovery consultation history',
      examination: '',
      assessment: 'PRIVATE synthetic recovery assessment',
      investigations: '',
      plan: 'PRIVATE synthetic recovery plan',
      reviewedConfirmed: true,
      requestId: randomUUID(),
    };
    const consultationRejectedInput = {
      ...consultationInput,
      appointmentId: randomUUID(),
      requestId: randomUUID(),
    };
    const consultationRejected = await call(
      source,
      '/consultation-notes',
      admin,
      'POST',
      consultationRejectedInput,
      400,
    );
    assert.equal(consultationRejected.consultationOutcome, 'not-recorded');
    const consultation = await call(
      source,
      '/consultation-notes',
      admin,
      'POST',
      consultationInput,
      201,
    );
    const consultationAmendmentPath = `/encounters/${consultation.encounter.id}/amendment-recordings`;
    const consultationAmendmentInput = {
      reason: 'PRIVATE synthetic recovery clarification',
      text: 'PRIVATE synthetic retained amendment',
      reviewedConfirmed: true,
      requestId: randomUUID(),
    };
    const consultationAmendment = await call(
      source,
      consultationAmendmentPath,
      admin,
      'POST',
      consultationAmendmentInput,
      201,
    );
    assert.deepEqual(consultationAmendment.encounter, consultation.encounter);

    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
      'base64',
    );
    const pdfBytes = Buffer.from('%PDF-1.7\nSynthetic recovery report only.\n%%EOF\n');
    const imageCommand = {
      patientId,
      requestId: randomUUID(),
      caption: 'Synthetic recovery photograph',
      category: 'clinical',
      consent: true,
      sha256: createHash('sha256').update(imageBytes).digest('hex'),
      dataUrl: `data:image/png;base64,${imageBytes.toString('base64')}`,
    };
    const pdfCommand = {
      patientId,
      requestId: randomUUID(),
      title: 'Synthetic recovery report',
      originalName: 'synthetic-report.pdf',
      consent: true,
      sha256: createHash('sha256').update(pdfBytes).digest('hex'),
      dataUrl: `data:application/pdf;base64,${pdfBytes.toString('base64')}`,
    };
    const imageUpload = await call(source, '/images/upload', patient, 'POST', imageCommand, 201);
    const pdfUpload = await call(source, '/documents/upload', patient, 'POST', pdfCommand, 201);
    const image = imageUpload.receipt.file;
    const document = pdfUpload.receipt.file;
    const order = await call(
      source,
      '/investigations',
      admin,
      'POST',
      {
        patientId,
        title: 'Synthetic recovery investigation',
        kind: 'laboratory',
        reason: 'Synthetic order',
        instructions: 'Synthetic instructions',
      },
      201,
    );
    const investigationPath = `/investigations/${order.id}`;
    const resultPath = investigationPath + '/results/submit';
    const resultCommand = {
      requestId: randomUUID(),
      patientId,
      investigationId: order.id,
      submittedByRole: 'patient',
      note: 'Synthetic patient result.',
      documentIds: [document.id],
      reviewedConfirmed: true,
    };
    const originalSubmission = await call(source, resultPath, patient, 'POST', resultCommand, 201);
    const originalInvestigationResult = originalSubmission.receipt.result;
    const privateInterpretation = 'Unpublished synthetic investigation interpretation.';
    const reviewedOrder = await call(
      source,
      investigationPath + '/reviews',
      admin,
      'POST',
      {
        resultId: originalInvestigationResult.id,
        summary: privateInterpretation,
        followUp: 'Synthetic follow-up.',
        publishToPatient: false,
      },
      201,
    );
    const staffSupplement = {
      ...resultCommand,
      requestId: randomUUID(),
      submittedByRole: 'admin',
      note: 'Staff-recorded supplemental result.',
    };
    const supplementalSubmission = await call(
      source,
      resultPath,
      admin,
      'POST',
      staffSupplement,
      201,
    );
    await call(source, investigationPath + '/cancel', admin, 'POST', {
      reason: 'Synthetic cancellation after supplement.',
    });
    const closedCommand = { ...resultCommand, requestId: randomUUID() };
    const closedResult = await call(source, resultPath, patient, 'POST', closedCommand, 409);
    assert.equal(closedResult.code, 'INVESTIGATION_RESULT_NOT_SUBMITTED');
    const intakePath = '/intakes/submit';
    const intakeCommand = {
      patientId,
      requestId: randomUUID(),
      concern: 'Synthetic history retained through recovery',
      location: 'Arm',
      duration: 'Three days',
      symptoms: 'A change recorded by the patient',
      triggers: '',
      previousTreatment: '',
      medications: '',
      allergies: '',
      goals: 'Discuss at the next visit',
      consent: true,
    };
    const intakeResult = await call(source, intakePath, patient, 'POST', intakeCommand, 201);
    const planPath = '/care-plans/create';
    const planCommand = {
      patientId,
      doctorId: doctor.id,
      requestId: randomUUID(),
      reviewedConfirmed: true,
      title: 'Synthetic retained care plan',
      instructions: 'Rehearsal entry.',
      warnings: '',
      expectations: '',
      cost: '',
      startDate: clinicToday(),
      endDate: visitDate,
      followUpDate: visitDate,
      medications: [],
    };
    const createdPlan = await call(source, planPath, admin, 'POST', planCommand, 201);
    const originalPlan = createdPlan.receipt.plan;
    assert.equal(originalPlan.status, 'active');
    const checkInPath = '/check-ins/submit';
    const reportCommand = {
      requestId: randomUUID(),
      patientId,
      carePlanId: originalPlan.id,
      date: planCommand.startDate,
      adherence: 'partial',
      feeling: 'same',
      note: 'Original synthetic report.',
      expectedUpdatedAt: null,
      reviewedConfirmed: true,
    };
    const reported = await call(source, checkInPath, patient, 'POST', reportCommand, 201);
    const originalReport = reported.receipt.checkIn;
    const reviewHistoryPath = `/care-plans/${originalPlan.id}/reviews`;
    const reviewRecordPath = reviewHistoryPath + '/record';
    const reviewContext = await call(
      source,
      `/care-plans/${originalPlan.id}/review-context`,
      admin,
    );
    const reviewCommand = {
      requestId: randomUUID(),
      patientId,
      carePlanId: originalPlan.id,
      doctorId: doctor.id,
      expectedRevision: reviewContext.item.revision,
      assessment: 'Private recovery follow-up assessment.',
      patientInstructions: 'Shared recovery follow-up instructions.',
      disposition: 'visit-requested',
      nextReviewDate: visitDate,
      reviewedConfirmed: true,
    };
    const reviewResult = await call(source, reviewRecordPath, admin, 'POST', reviewCommand, 201);
    assert.deepEqual(reviewResult.receipt.review.checkInSnapshots, reviewContext.checkInSnapshots);
    assert.deepEqual(reviewResult.receipt.review.checkInSnapshots[0].snapshot, originalReport);
    const staleReviewCommand = { ...reviewCommand, requestId: randomUUID() };
    const staleReview = await call(
      source,
      reviewRecordPath,
      admin,
      'POST',
      staleReviewCommand,
      409,
    );
    assert.equal(staleReview.code, 'FOLLOW_UP_REVIEW_NOT_RECORDED');
    const correctionCommand = {
      ...reportCommand,
      requestId: randomUUID(),
      expectedUpdatedAt: originalReport.createdAt,
      adherence: 'taken',
      note: 'Corrected synthetic report.',
    };
    const corrected = await call(source, checkInPath, patient, 'POST', correctionCommand, 201);
    assert.equal(corrected.receipt.checkIn.id, originalReport.id);
    assert.ok(corrected.receipt.checkIn.createdAt > originalReport.createdAt);
    const staleCheckInCommand = {
      ...correctionCommand,
      requestId: randomUUID(),
      note: 'Stale synthetic draft.',
    };
    const staleCheckIn = await call(source, checkInPath, patient, 'POST', staleCheckInCommand, 409);
    assert.equal(staleCheckIn.code, 'CHECK_IN_NOT_SAVED');
    await call(source, `/care-plans/${originalPlan.id}`, admin, 'PATCH', { status: 'completed' });
    const rejectedPlanCommand = { ...planCommand, doctorId: randomUUID(), requestId: randomUUID() };
    const rejectedPlan = await call(source, planPath, admin, 'POST', rejectedPlanCommand, 409);
    assert.equal(rejectedPlan.code, 'CARE_PLAN_NOT_CREATED');
    const issuancePath = '/invoices/issue';
    const issuanceCommand = {
      requestId: randomUUID(),
      patientId,
      reviewedConfirmed: true,
      items: [
        { description: 'Synthetic visit', quantity: 1, unitAmountPaise: 3000 },
        { description: 'Synthetic supplies', quantity: 2, unitAmountPaise: 250 },
      ],
    };
    const issuance = await call(source, issuancePath, admin, 'POST', issuanceCommand, 201);
    const issued = issuance.receipt.invoice;
    assert.equal(issued.status, 'unpaid');
    assert.equal(issued.paidPaise, 0);
    assert.equal(issued.totalPaise, 3500);
    const invoicePath = `/invoices/${issued.id}`;
    const recordingPath = invoicePath + '/payments/record';
    const paymentCommand = {
      requestId: randomUUID(),
      patientId,
      receivedExternallyConfirmed: true,
      expectedRevision: (await call(source, invoicePath, admin)).revision,
      amountPaise: 500,
      method: 'upi',
      reference: 'Synthetic entry',
    };
    const recorded = await call(source, recordingPath, admin, 'POST', paymentCommand, 201);
    assert.equal(recorded.receipt.afterPaidPaise, 500);
    assert.equal(recorded.receipt.totalPaise, 3500);
    const stalePaymentCommand = { ...paymentCommand, amountPaise: 100, requestId: randomUUID() };
    const stalePayment = await call(source, recordingPath, admin, 'POST', stalePaymentCommand, 409);
    assert.equal(stalePayment.code, 'PAYMENT_NOT_RECORDED');
    const recordedDetail = await call(source, invoicePath, admin);
    const partialPayment = await call(source, invoicePath + '/corrections', admin, 'POST', {
      items: [{ description: 'Corrected synthetic visit', quantity: 1, unitAmountPaise: 4000 }],
      reason: 'Synthetic corrected charges',
      requestId: randomUUID(),
      expectedRevision: recordedDetail.revision,
    });
    assert.equal(partialPayment.invoice.status, 'partial');
    assert.equal(partialPayment.invoice.totalPaise, 4000);
    const rejectedIssuanceCommand = {
      ...issuanceCommand,
      requestId: randomUUID(),
      procedureId: randomUUID(),
    };
    const rejectedIssuance = await call(
      source,
      issuancePath,
      admin,
      'POST',
      rejectedIssuanceCommand,
      400,
    );
    assert.equal(rejectedIssuance.code, 'INVOICE_NOT_ISSUED');
    const summaryPath = `/patients/${patientId}/care-summary`;
    const summary = await call(source, summaryPath, patient);
    const copyInput = { expectedRevision: summary.revision, requestId: randomUUID() };
    const copy = await call(source, `${summaryPath}/copies`, patient, 'POST', copyInput, 201);
    const copyPath = `${summaryPath}/copies/${copy.copy.id}/download`;
    const copyBytes = await call(source, copyPath, patient, 'GET', undefined, 200, true);
    const messagePath = '/messages/send';
    const messageCommand = {
      requestId: randomUUID(),
      patientId,
      body: 'Private synthetic message retained through recovery',
    };
    const sentMessage = await call(source, messagePath, patient, 'POST', messageCommand, 201);
    const { modules } = await call(source, '/settings', admin);
    await call(source, '/settings', admin, 'PATCH', {
      modules: { ...modules, intake: false, followUp: false, images: false },
    });
    const pausedImageCommand = { ...imageCommand, requestId: randomUUID() };
    const pausedImage = await call(
      source,
      '/images/upload',
      patient,
      'POST',
      pausedImageCommand,
      403,
    );
    assert.equal(pausedImage.code, 'UPLOAD_NOT_SAVED');
    const pausedIntakeCommand = {
      ...intakeCommand,
      concern: 'Unsubmitted synthetic history',
      requestId: randomUUID(),
    };
    const pausedIntake = await call(source, intakePath, patient, 'POST', pausedIntakeCommand, 403);
    assert.equal(pausedIntake.code, 'INTAKE_NOT_SUBMITTED');
    const pausedMessageCommand = {
      ...messageCommand,
      requestId: randomUUID(),
      body: 'Synthetic draft submitted while messaging was paused',
    };
    const pausedMessage = await call(
      source,
      messagePath,
      patient,
      'POST',
      pausedMessageCommand,
      403,
    );
    assert.equal(pausedMessage.code, 'MESSAGE_NOT_SENT');
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
    assert.deepEqual(
      await call(target, '/images/upload', newPatient, 'POST', imageCommand),
      imageUpload,
    );
    assert.deepEqual(
      await call(target, '/documents/upload', newPatient, 'POST', pdfCommand),
      pdfUpload,
    );
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
    assert.deepEqual(
      await call(
        target,
        `${cancellationBase}/cancellations`,
        newPatient,
        'POST',
        cancellationCommand,
      ),
      cancellation,
    );
    assert.deepEqual(
      await call(
        target,
        `${cancellationBase}/cancellations`,
        newPatient,
        'POST',
        rejectedCancellationCommand,
        409,
      ),
      rejectedCancellation,
    );
    assert.deepEqual(
      await call(target, `${cancellationBase}/cancellation-context`, newPatient),
      retainedCancellationContext,
    );
    assert.deepEqual(
      await call(target, '/consultation-notes', newAdmin, 'POST', consultationInput),
      consultation,
    );
    assert.deepEqual(
      await call(target, consultationAmendmentPath, newAdmin, 'POST', consultationAmendmentInput),
      consultationAmendment,
    );
    assert.deepEqual(
      await call(target, '/consultation-notes', newAdmin, 'POST', consultationRejectedInput, 400),
      consultationRejected,
    );
    assert.deepEqual(await call(target, issuancePath, newAdmin, 'POST', issuanceCommand), issuance);
    assert.deepEqual(
      await call(target, issuancePath, newAdmin, 'POST', rejectedIssuanceCommand, 400),
      rejectedIssuance,
    );
    assert.deepEqual(await call(target, recordingPath, newAdmin, 'POST', paymentCommand), recorded);
    assert.deepEqual(
      await call(target, recordingPath, newAdmin, 'POST', stalePaymentCommand, 409),
      stalePayment,
    );
    const patientInvoice = await call(target, invoicePath, newPatient);
    assert.deepEqual(patientInvoice.invoice, partialPayment.invoice);
    assert.deepEqual(patientInvoice.payments, partialPayment.payments);
    const restoredInvoices = await call(target, '/invoices', newPatient);
    assert.deepEqual(restoredInvoices, [partialPayment.invoice]);
    const issueAudit = await call(
      target,
      `/search/audit?entityType=invoice&entityId=${issued.id}`,
      newAdmin,
    );
    assert.equal(issueAudit.items.filter((row) => row.action === 'created invoice').length, 1);
    const invoiceActivity = await call(target, '/activity?limit=100', newPatient);
    assert.equal(
      invoiceActivity.items.filter(
        (row) =>
          row.kind === 'billing' &&
          row.href === `/my-care/invoices?invoice=${issued.id}` &&
          row.title === 'Your clinic created an invoice',
      ).length,
      1,
    );
    assert.equal(
      issueAudit.items.filter((row) => row.action === 'recorded manual payment').length,
      1,
    );
    assert.equal(
      invoiceActivity.items.filter(
        (row) =>
          row.title === 'Your clinic recorded a received payment' &&
          row.href === `/my-care/invoices?invoice=${issued.id}`,
      ).length,
      1,
    );
    assert.equal(patientInvoice.payments.length, 1);
    for (const command of [paymentCommand, stalePaymentCommand])
      assert.equal(JSON.stringify(patientInvoice).includes(command.requestId), false);
    const restoredClinicalRecord = await call(target, `/patients/${patientId}`, newAdmin);
    assert.deepEqual(restoredClinicalRecord.encounters, [consultation.encounter]);
    assert.deepEqual(await call(target, planPath, newAdmin, 'POST', planCommand), createdPlan);
    assert.deepEqual(
      await call(target, planPath, newAdmin, 'POST', rejectedPlanCommand, 409),
      rejectedPlan,
    );
    assert.deepEqual(await call(target, checkInPath, newPatient, 'POST', reportCommand), reported);
    assert.deepEqual(
      await call(target, checkInPath, newPatient, 'POST', correctionCommand),
      corrected,
    );
    assert.deepEqual(
      await call(target, checkInPath, newPatient, 'POST', staleCheckInCommand, 409),
      staleCheckIn,
    );
    assert.deepEqual(
      restoredClinicalRecord.checkIns.filter((row) => row.carePlanId === originalPlan.id),
      [corrected.receipt.checkIn],
    );
    assert.deepEqual(
      await call(target, reviewRecordPath, newAdmin, 'POST', reviewCommand),
      reviewResult,
    );
    assert.deepEqual(
      await call(target, reviewRecordPath, newAdmin, 'POST', staleReviewCommand, 409),
      staleReview,
    );
    const reviewedReports = await call(target, reviewHistoryPath, newAdmin);
    assert.deepEqual(
      reviewedReports.filter((row) => row.source === 'clinical-review'),
      [reviewResult.receipt.review],
    );
    const sharedReviews = await call(target, reviewHistoryPath, newPatient);
    assert.equal(
      sharedReviews.find((row) => row.id === reviewResult.receipt.review.id).patientInstructions,
      reviewCommand.patientInstructions,
    );
    const restoredReviewNotices = invoiceActivity.items.filter(
      (row) =>
        row.title === 'Your clinic reviewed your follow-up' &&
        row.href === `/my-care?plan=${originalPlan.id}`,
    );
    assert.equal(restoredReviewNotices.length, 1);
    assert.deepEqual(reviewedReports[0].checkInSnapshots[0].snapshot, corrected.receipt.checkIn);
    const reportAudit = await call(
      target,
      `/search/audit?entityType=checkIn&entityId=${originalReport.id}`,
      newAdmin,
    );
    for (const action of ['recorded daily check-in', 'updated daily check-in'])
      assert.equal(reportAudit.items.filter((row) => row.action === action).length, 1);
    const patientPlans = await call(target, '/care-plans', newPatient);
    assert.equal(patientPlans.length, 1);
    assert.equal(patientPlans[0].id, originalPlan.id);
    assert.equal(patientPlans[0].effectiveStatus, 'completed');
    assert.equal(patientPlans[0].latestReview.source, 'status-change');
    assert.deepEqual(
      await call(target, intakePath, newPatient, 'POST', intakeCommand),
      intakeResult,
    );
    assert.deepEqual(
      await call(target, messagePath, newPatient, 'POST', messageCommand),
      sentMessage,
    );
    await call(target, '/settings', newAdmin, 'PATCH', { modules });
    assert.deepEqual(
      await call(target, '/images/upload', newPatient, 'POST', pausedImageCommand, 403),
      pausedImage,
    );
    for (const table of ['images', 'documents'])
      assert.equal(
        restoredDb
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE patientId=?`)
          .get(patientId).count,
        1,
      );

    assert.deepEqual(
      await call(target, intakePath, newPatient, 'POST', pausedIntakeCommand, 403),
      pausedIntake,
    );
    assert.deepEqual(
      await call(target, messagePath, newPatient, 'POST', pausedMessageCommand, 403),
      pausedMessage,
    );
    const thread = await call(target, `/messages?patientId=${patientId}`, newPatient);
    assert.deepEqual(thread, [sentMessage.receipt.message]);
    const restoredSummary = await call(target, summaryPath, newPatient);
    assert.equal(restoredSummary.revision, summary.revision);
    for (const projection of [restoredSummary, restoredClinicalRecord, patientPlans]) {
      const json = JSON.stringify(projection);
      assert.equal(json.includes(planCommand.requestId), false);
      assert.equal(json.includes(rejectedPlanCommand.requestId), false);
    }
    for (const projection of [
      sharedReviews,
      patientPlans,
      restoredSummary,
      restoredReviewNotices,
    ]) {
      const json = JSON.stringify(projection);
      for (const privateValue of [
        reviewCommand.assessment,
        reviewCommand.requestId,
        staleReviewCommand.requestId,
        'checkInSnapshots',
      ])
        assert.equal(json.includes(privateValue), false);
    }
    assert.deepEqual(restoredSummary.intakes, [intakeResult.receipt.intake]);
    assert.deepEqual(restoredClinicalRecord.intakes, restoredSummary.intakes);
    for (const projection of [restoredSummary, restoredClinicalRecord]) {
      const json = JSON.stringify(projection);
      for (const value of [
        reportCommand.requestId,
        correctionCommand.requestId,
        staleCheckInCommand.requestId,
        paymentCommand.requestId,
        stalePaymentCommand.requestId,
        issuanceCommand.requestId,
        rejectedIssuanceCommand.requestId,
        imageCommand.requestId,
        pdfCommand.requestId,
        pausedImageCommand.requestId,
        intakeCommand.requestId,
        pausedIntakeCommand.requestId,
        pausedIntakeCommand.concern,
      ])
        assert.equal(json.includes(value), false);
    }
    for (const command of [messageCommand, pausedMessageCommand]) {
      assert.equal(JSON.stringify(restoredSummary).includes(command.body), false);
      assert.equal(JSON.stringify(restoredClinicalRecord).includes(command.requestId), false);
    }
    const restoredWorkflows = await call(
      target,
      `/patients/${patientId}/clinical-workflows`,
      newAdmin,
    );
    assert.deepEqual(restoredWorkflows.amendments, [consultationAmendment.amendment]);
    assert.deepEqual(
      await call(target, resultPath, newPatient, 'POST', resultCommand),
      originalSubmission,
    );
    assert.deepEqual(
      await call(target, resultPath, newAdmin, 'POST', staffSupplement),
      supplementalSubmission,
    );
    assert.deepEqual(
      await call(target, resultPath, newPatient, 'POST', closedCommand, 409),
      closedResult,
    );
    const restoredOrder = restoredWorkflows.investigations.find((row) => row.id === order.id);
    assert.deepEqual(restoredOrder.results, [
      originalInvestigationResult,
      supplementalSubmission.receipt.result,
    ]);
    assert.deepEqual(restoredOrder.reviews, reviewedOrder.reviews);
    assert.equal(restoredOrder.status, 'cancelled');
    const restoredPatientOrder = (
      await call(target, `/patients/${patientId}/clinical-workflows`, newPatient)
    ).investigations.find((row) => row.id === order.id);
    assert.deepEqual(restoredPatientOrder.reviews, []);
    assert.deepEqual(restoredPatientOrder.results, restoredOrder.results);
    for (const data of [restoredSummary, restoredPatientOrder]) {
      const json = JSON.stringify(data);
      for (const hidden of [
        privateInterpretation,
        resultCommand.requestId,
        staffSupplement.requestId,
        closedCommand.requestId,
      ])
        assert.equal(json.includes(hidden), false);
    }
    const resultAudit = await call(
      target,
      `/search/audit?entityType=investigation&entityId=${order.id}`,
      newAdmin,
    );
    assert.equal(
      resultAudit.items.filter(
        (entry) => entry.action === 'submitted unreviewed investigation result',
      ).length,
      2,
    );
    assert.equal(
      restoredDb.prepare('SELECT COUNT(*) count FROM consultationRecordingCommands').get().count,
      3,
    );
    for (const projection of [
      await call(target, `/patients/${patientId}`, newPatient),
      await call(target, summaryPath, newPatient),
    ])
      for (const value of [
        consultationInput.history,
        consultationAmendmentInput.text,
        consultationInput.requestId,
        consultationAmendmentInput.requestId,
      ])
        assert.equal(JSON.stringify(projection).includes(value), false);
    const retainedAppointments = await call(target, '/appointments', newPatient);
    assert.deepEqual(
      await call(target, `${stateBase}/state-changes`, newAdmin, 'POST', stateCommand),
      { ...stateCheckedIn, appointment: stateCurrent },
    );
    assert.deepEqual(
      await call(target, `${stateBase}/state-changes`, newAdmin, 'POST', stateRejectedCommand, 409),
      stateRejected,
    );
    const restoredStateContext = await call(target, `${stateBase}/state-context`, newAdmin);
    assert.equal(restoredStateContext.revision, retainedStateContext.revision);
    assert.deepEqual(restoredStateContext.appointment, stateCurrent);
    assert.ok(restoredStateContext.actions.every((action) => !action.allowed));
    const stateAudit = await call(
      target,
      `/search/audit?entityType=appointment&entityId=${stateVisit.id}`,
      newAdmin,
    );
    for (const status of ['checked-in', 'in-consultation', 'completed'])
      assert.equal(
        stateAudit.items.filter((entry) => entry.action === `appointment ${status}`).length,
        1,
      );
    assert.equal(retainedAppointments.length, 3);
    assert.equal(retainedAppointments.filter((value) => value.status === 'cancelled').length, 1);
    assert.equal(retainedAppointments.filter((value) => value.status === 'completed').length, 1);
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
      'Recovery rehearsal passed: online backup, verified new-file restore, original preservation, private files and saved-copy bytes, booking, rescheduling, cancellation and staff progression receipts, private consultation originals/amendments and terminal rejections, daily check-ins and original follow-up reviews with preserved stale rejections, investigation result receipts and linked PDFs, retired sessions/recovery access, retained MFA with fresh authenticator sign-in, and recovery audit.',
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
