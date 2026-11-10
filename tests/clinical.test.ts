import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser } from '../server/db.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server, base: string;
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  patient: Client = {},
  reception: Client = {},
  admin: Client = {},
  other: Client = {},
  unlinked: Client = {};
async function call(
  path: string,
  { method = 'GET', body, client = {} }: { method?: string; body?: unknown; client?: Client } = {},
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
  return { status: response.status, data };
}
const patientPath = '/patients/patient-ananya/clinical-workflows';
const orderInput = {
  patientId: 'patient-ananya',
  title: 'Test investigation',
  kind: 'laboratory',
  reason: 'Synthetic clinical documentation test.',
  instructions: 'Bring the report to the clinic for review.',
  dueDate: addDays(clinicToday(), 7),
};
const procedureInput = {
  patientId: 'patient-ananya',
  title: 'Test procedure',
  indication: 'Synthetic demonstration indication.',
  benefits: 'Benefits discussed by clinician.',
  risks: 'Risks discussed by clinician.',
  alternatives: 'Alternatives discussed by clinician.',
  aftercare: 'Clinician-entered aftercare instructions.',
  estimatedCost: 'Discussed with the clinic',
};
async function order() {
  const response = await call('/investigations', {
    method: 'POST',
    client: doctor,
    body: orderInput,
  });
  assert.equal(response.status, 201);
  return response.data;
}
async function procedure() {
  const response = await call('/procedures', {
    method: 'POST',
    client: doctor,
    body: procedureInput,
  });
  assert.equal(response.status, 201);
  return response.data;
}
async function report(client: Client, title: string) {
  const dataUrl = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n').toString('base64')}`;
  const response = await call('/documents', {
    method: 'POST',
    client,
    body: { title, originalName: 'report.pdf', dataUrl, consent: true },
  });
  assert.equal(response.status, 201);
  return response.data.id as string;
}
before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const [role, client] of [
    ['doctor', doctor],
    ['patient', patient],
    ['reception', reception],
    ['admin', admin],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', {
          method: 'POST',
          client,
          body: { email: `${role}@derma.demo`, password: 'DemoClinic2026!' },
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call('/auth/register', {
        method: 'POST',
        client: other,
        body: {
          name: 'Other clinical patient',
          email: 'clinical-other@example.test',
          password: 'ClinicalOther2026!',
          phone: '9000000088',
          dob: '1993-02-03',
          gender: 'Other',
        },
      })
    ).status,
    201,
  );
  createUser(
    app.locals.db,
    {
      id: 'clinical-unlinked-admin',
      name: 'Unlinked administrator',
      email: 'clinical-unlinked@example.test',
      role: 'admin',
    },
    'ClinicalAdmin2026!',
  );
  assert.equal(
    (
      await call('/auth/login', {
        method: 'POST',
        client: unlinked,
        body: { email: 'clinical-unlinked@example.test', password: 'ClinicalAdmin2026!' },
      })
    ).status,
    200,
  );
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  app.locals.close();
});

test('clinical workflow access separates patients, reception and linked clinician authorship', async () => {
  assert.equal((await call(patientPath)).status, 401);
  assert.equal((await call(patientPath, { client: other })).status, 403);
  assert.equal((await call(patientPath, { client: reception })).status, 403);
  assert.equal((await call(patientPath, { client: patient })).status, 200);
  assert.equal((await call(patientPath, { client: unlinked })).status, 200);
  for (const [path, body] of [
    ['/investigations', orderInput],
    ['/procedures', procedureInput],
  ] as const) {
    assert.equal((await call(path, { method: 'POST', client: patient, body })).status, 403);
    assert.equal((await call(path, { method: 'POST', client: reception, body })).status, 403);
    assert.equal((await call(path, { method: 'POST', client: unlinked, body })).status, 400);
  }
  assert.equal(
    (
      await call('/investigations', {
        method: 'POST',
        client: doctor,
        body: { ...orderInput, dueDate: addDays(clinicToday(), -1) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('/procedures', {
        method: 'POST',
        client: doctor,
        body: { ...procedureInput, risks: '' },
      })
    ).status,
    400,
  );
});
let investigationId: string, resultId: string, reviewId: string;
test('investigation results retain author provenance and only link the same patient reports', async () => {
  const created = await order();
  investigationId = created.id;
  assert.equal(created.status, 'ordered');
  assert.equal(created.doctorId, 'doctor-meera');
  const ownReport = await report(patient, 'Own test report'),
    otherReport = await report(other, 'Other test report');
  assert.equal(
    (
      await call(`/investigations/${investigationId}/results`, {
        method: 'POST',
        client: patient,
        body: { note: '', documentIds: [] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/investigations/${investigationId}/results`, {
        method: 'POST',
        client: patient,
        body: { note: '', documentIds: [otherReport] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/investigations/${investigationId}/results`, {
        method: 'POST',
        client: other,
        body: { note: 'Wrong patient' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/investigations/${investigationId}/results`, {
        method: 'POST',
        client: reception,
        body: { note: 'Reception is not clinical' },
      })
    ).status,
    403,
  );
  const submitted = await call(`/investigations/${investigationId}/results`, {
    method: 'POST',
    client: patient,
    body: {
      note: 'Patient-submitted report for review.',
      documentIds: [ownReport],
      submittedByRole: 'doctor',
    },
  });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.status, 'result-received');
  assert.equal(submitted.data.results[0].submittedByRole, 'patient');
  assert.equal(submitted.data.results[0].submittedById, 'user-patient');
  assert.deepEqual(submitted.data.results[0].documentIds, [ownReport]);
  resultId = submitted.data.results[0].id;
});
test('review requires the latest result and explicit publication keeps internal summaries private', async () => {
  const input = {
    resultId,
    summary: 'Internal review pending patient communication.',
    followUp: 'Follow-up discussion.',
    publishToPatient: false,
  };
  assert.equal(
    (
      await call(`/investigations/${investigationId}/reviews`, {
        method: 'POST',
        client: patient,
        body: input,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/investigations/${investigationId}/reviews`, {
        method: 'POST',
        client: unlinked,
        body: input,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/investigations/${investigationId}/reviews`, {
        method: 'POST',
        client: doctor,
        body: { ...input, resultId: 'unknown-result' },
      })
    ).status,
    409,
  );
  const reviewed = await call(`/investigations/${investigationId}/reviews`, {
    method: 'POST',
    client: doctor,
    body: input,
  });
  assert.equal(reviewed.status, 201);
  assert.equal(reviewed.data.status, 'reviewed');
  assert.equal(reviewed.data.reviews[0].publishedAt, null);
  reviewId = reviewed.data.reviews[0].id;
  const own = await call(patientPath, { client: patient });
  const view = own.data.investigations.find((entry: any) => entry.id === investigationId);
  assert.equal(view.status, 'reviewed');
  assert.deepEqual(view.reviews, []);
  assert.ok(!JSON.stringify(own.data).includes(input.summary));
  assert.equal(
    (
      await call(`/investigations/${investigationId}/reviews/${reviewId}/publish`, {
        method: 'POST',
        client: patient,
        body: {},
      })
    ).status,
    403,
  );
  const published = await call(`/investigations/${investigationId}/reviews/${reviewId}/publish`, {
    method: 'POST',
    client: doctor,
    body: {},
  });
  assert.equal(published.status, 200);
  assert.ok(published.data.reviews[0].publishedAt);
  const again = await call(`/investigations/${investigationId}/reviews/${reviewId}/publish`, {
    method: 'POST',
    client: doctor,
    body: {},
  });
  assert.equal(again.data.reviews[0].publishedAt, published.data.reviews[0].publishedAt);
  const visible = (await call(patientPath, { client: patient })).data.investigations.find(
    (entry: any) => entry.id === investigationId,
  );
  assert.equal(visible.reviews[0].summary, input.summary);
});
test('new results reopen review status without changing prior results or clinician interpretations', async () => {
  const added = await call(`/investigations/${investigationId}/results`, {
    method: 'POST',
    client: doctor,
    body: { note: 'Additional result supplied to the clinic.', documentIds: [] },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.status, 'result-received');
  assert.equal(added.data.results.length, 2);
  assert.equal(added.data.results[0].id, resultId);
  assert.equal(added.data.reviews[0].id, reviewId);
  assert.equal(
    (
      await call(`/investigations/${investigationId}/reviews`, {
        method: 'POST',
        client: doctor,
        body: { resultId, summary: 'Stale review', publishToPatient: true },
      })
    ).status,
    409,
  );
  const latest = added.data.results.at(-1).id;
  const reviewed = await call(`/investigations/${investigationId}/reviews`, {
    method: 'POST',
    client: doctor,
    body: {
      resultId: latest,
      summary: 'Updated clinician interpretation.',
      followUp: 'Review discussed.',
      publishToPatient: true,
    },
  });
  assert.equal(reviewed.status, 201);
  assert.equal(reviewed.data.status, 'reviewed');
  assert.equal(reviewed.data.reviews.length, 2);
  assert.throws(
    () => app.locals.db.exec("UPDATE investigationResults SET data='{}'"),
    /append-only/,
  );
  assert.throws(() => app.locals.db.exec('DELETE FROM investigationReviews'), /append-only/);
});
test('cancelled investigations keep their history and reject new activity', async () => {
  const created = await order();
  assert.equal(
    (
      await call(`/investigations/${created.id}/cancel`, {
        method: 'POST',
        client: patient,
        body: { reason: 'Patient cannot cancel clinical orders' },
      })
    ).status,
    403,
  );
  const cancelled = await call(`/investigations/${created.id}/cancel`, {
    method: 'POST',
    client: doctor,
    body: { reason: 'No longer requested after discussion.' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.title, created.title);
  assert.equal(
    (
      await call(`/investigations/${created.id}/results`, {
        method: 'POST',
        client: patient,
        body: { note: 'Late report' },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/investigations/${created.id}/cancel`, {
        method: 'POST',
        client: doctor,
        body: { reason: 'Again' },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/investigations/${investigationId}/cancel`, {
        method: 'POST',
        client: doctor,
        body: { reason: 'Cannot cancel reviewed result' },
      })
    ).status,
    409,
  );
});
test('encounter amendments are immutable, reasoned, clinician-only additions to the original note', async () => {
  const encounter = await call('/encounters', {
    method: 'POST',
    client: doctor,
    body: {
      patientId: 'patient-ananya',
      assessment: 'Original assessment remains intact.',
      plan: 'Original plan remains intact.',
    },
  });
  assert.equal(encounter.status, 201);
  const input = {
    reason: 'Correcting a documentation omission.',
    text: 'Additional context recorded after the visit.',
  };
  assert.equal(
    (
      await call(`/encounters/${encounter.data.id}/amendments`, {
        method: 'POST',
        client: patient,
        body: input,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/encounters/${encounter.data.id}/amendments`, {
        method: 'POST',
        client: doctor,
        body: { ...input, reason: '' },
      })
    ).status,
    400,
  );
  const amendment = await call(`/encounters/${encounter.data.id}/amendments`, {
    method: 'POST',
    client: doctor,
    body: input,
  });
  assert.equal(amendment.status, 201);
  assert.equal(amendment.data.doctorId, 'doctor-meera');
  assert.equal(
    (await call('/patients/patient-ananya', { client: doctor })).data.encounters.find(
      (entry: any) => entry.id === encounter.data.id,
    ).assessment,
    encounter.data.assessment,
  );
  assert.ok(
    (await call(patientPath, { client: doctor })).data.amendments.some(
      (entry: any) => entry.id === amendment.data.id,
    ),
  );
  assert.deepEqual((await call(patientPath, { client: patient })).data.amendments, []);
  assert.throws(() => app.locals.db.exec('DELETE FROM encounterAmendments'), /append-only/);
});
test('procedure decisions distinguish patient portal acknowledgements from clinician-recorded discussion', async () => {
  const plan = await procedure();
  assert.equal(plan.status, 'planned');
  const complete = {
    outcome: 'Procedure outcome documented.',
    aftercare: 'Aftercare explained by clinician.',
  };
  assert.equal(
    (
      await call(`/procedures/${plan.id}/complete`, {
        method: 'POST',
        client: doctor,
        body: complete,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/procedures/${plan.id}/agreements`, {
        method: 'POST',
        client: other,
        body: { decision: 'agreed', method: 'portal' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/procedures/${plan.id}/agreements`, {
        method: 'POST',
        client: patient,
        body: { decision: 'agreed', method: 'phone' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/procedures/${plan.id}/agreements`, {
        method: 'POST',
        client: doctor,
        body: { decision: 'agreed', method: 'portal' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/procedures/${plan.id}/agreements`, {
        method: 'POST',
        client: doctor,
        body: { decision: 'agreed', method: 'in-person', note: 'Patient decision discussed.' },
      })
    ).status,
    400,
  );
  const recorded = await call(`/procedures/${plan.id}/agreements`, {
    method: 'POST',
    client: doctor,
    body: {
      decision: 'agreed',
      method: 'in-person',
      note: 'Patient decision discussed and confirmed.',
      patientDecisionConfirmed: true,
    },
  });
  assert.equal(recorded.status, 201);
  assert.equal(recorded.data.agreements[0].recordedByRole, 'doctor');
  assert.equal(recorded.data.agreements[0].method, 'in-person');
  const declined = await call(`/procedures/${plan.id}/agreements`, {
    method: 'POST',
    client: patient,
    body: {
      decision: 'declined',
      method: 'portal',
      note: 'I would like to discuss an alternative.',
    },
  });
  assert.equal(declined.status, 201);
  assert.equal(declined.data.agreements.at(-1).decision, 'declined');
  assert.equal(
    (
      await call(`/procedures/${plan.id}/complete`, {
        method: 'POST',
        client: doctor,
        body: complete,
      })
    ).status,
    409,
  );
  const agreed = await call(`/procedures/${plan.id}/agreements`, {
    method: 'POST',
    client: patient,
    body: { decision: 'agreed', method: 'portal', note: 'I have reviewed the plan.' },
  });
  assert.equal(agreed.status, 201);
  assert.equal(agreed.data.agreements.at(-1).recordedByRole, 'patient');
  const completed = await call(`/procedures/${plan.id}/complete`, {
    method: 'POST',
    client: doctor,
    body: complete,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.status, 'completed');
  assert.equal(completed.data.completion.doctorId, 'doctor-meera');
  assert.equal(completed.data.risks, procedureInput.risks);
  assert.equal(completed.data.agreements.length, 3);
  for (const path of ['complete', 'agreements', 'cancel'])
    assert.equal(
      (
        await call(`/procedures/${plan.id}/${path}`, {
          method: 'POST',
          client: doctor,
          body:
            path === 'complete'
              ? complete
              : path === 'cancel'
                ? { reason: 'Late cancel' }
                : {
                    decision: 'agreed',
                    method: 'phone',
                    note: 'Another decision',
                    patientDecisionConfirmed: true,
                  },
        })
      ).status,
      409,
    );
  assert.throws(() => app.locals.db.exec("UPDATE procedures SET data='{}'"), /append-only/);
  assert.throws(() => app.locals.db.exec('DELETE FROM procedureAgreements'), /append-only/);
});
test('procedure appointment linkage validates patient ownership and does not modify the appointment', async () => {
  const appointments = (await call('/appointments', { client: doctor })).data;
  const wrong = appointments.find((item: any) => item.patientId !== 'patient-ananya');
  assert.equal(
    (
      await call('/procedures', {
        method: 'POST',
        client: doctor,
        body: { ...procedureInput, appointmentId: wrong.id },
      })
    ).status,
    400,
  );
  let day = addDays(clinicToday(), 50);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() === 0) day = addDays(day, 1);
  const booked = await call('/appointments', {
    method: 'POST',
    client: patient,
    body: {
      doctorId: 'doctor-meera',
      date: day,
      time: '14:00',
      mode: 'in-person',
      reason: 'Procedure discussion',
    },
  });
  assert.equal(booked.status, 201);
  const planned = await call('/procedures', {
    method: 'POST',
    client: doctor,
    body: { ...procedureInput, appointmentId: booked.data.id },
  });
  assert.equal(planned.status, 201);
  assert.equal(
    (
      await call(`/procedures/${planned.data.id}/agreements`, {
        method: 'POST',
        client: patient,
        body: { decision: 'agreed', method: 'portal' },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call(`/procedures/${planned.data.id}/complete`, {
        method: 'POST',
        client: doctor,
        body: { outcome: 'Too early', aftercare: 'Future visit' },
      })
    ).status,
    409,
  );
  const cancelled = await call(`/procedures/${planned.data.id}/cancel`, {
    method: 'POST',
    client: doctor,
    body: { reason: 'A different procedure will be planned.' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(
    (await call('/appointments', { client: patient })).data.find(
      (item: any) => item.id === booked.data.id,
    ).status,
    'scheduled',
  );
});
test('concurrent decision withdrawal and completion cannot produce a completed procedure with a latest decline', async () => {
  const plan = await procedure();
  await call(`/procedures/${plan.id}/agreements`, {
    method: 'POST',
    client: patient,
    body: { decision: 'agreed', method: 'portal' },
  });
  const responses = await Promise.all([
    call(`/procedures/${plan.id}/agreements`, {
      method: 'POST',
      client: patient,
      body: { decision: 'declined', method: 'portal' },
    }),
    call(`/procedures/${plan.id}/complete`, {
      method: 'POST',
      client: doctor,
      body: { outcome: 'Recorded outcome', aftercare: 'Recorded aftercare' },
    }),
  ]);
  assert.ok(responses.some((response) => response.status === 409));
  const actual = (await call(patientPath, { client: doctor })).data.procedures.find(
    (item: any) => item.id === plan.id,
  );
  assert.ok(
    actual.status === 'completed'
      ? actual.agreements.at(-1).decision === 'agreed'
      : actual.agreements.at(-1).decision === 'declined',
  );
  const audit = (await call('/audit', { client: admin })).data;
  for (const action of [
    'ordered investigation',
    'reviewed investigation result',
    'published investigation review to patient',
    'added consultation amendment',
    'completed procedure and recorded aftercare',
  ])
    assert.ok(
      audit.some((entry: any) => entry.action === action),
      action,
    );
});

test('a linked procedure cannot complete before today’s scheduled visit starts', async (context) => {
  const day = clinicToday();
  const early = Date.parse(`${day}T09:00:00+05:30`),
    visit = Date.parse(`${day}T16:00:00+05:30`);
  const sessionExpirations = app.locals.db
    .prepare('SELECT tokenHash, expiresAt FROM sessions')
    .all() as { tokenHash: string; expiresAt: number }[];
  app.locals.db.prepare('UPDATE sessions SET expiresAt=?').run(visit + 86400000);
  context.mock.timers.enable({ apis: ['Date'], now: early });
  try {
    const appointment = {
      id: 'procedure-future-today',
      patientId: 'patient-ananya',
      doctorId: 'doctor-meera',
      date: day,
      time: '16:00',
      mode: 'in-person',
      reason: 'Same-day procedure discussion',
      status: 'scheduled',
      patientName: 'Ananya Sharma',
      doctorName: 'Dr. Meera Shah',
      fee: 800,
      durationMinutes: 30,
      createdAt: new Date().toISOString(),
    };
    app.locals.db
      .prepare(
        'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        appointment.id,
        appointment.patientId,
        appointment.doctorId,
        appointment.date,
        appointment.time,
        appointment.status,
        JSON.stringify(appointment),
      );
    const planned = await call('/procedures', {
      method: 'POST',
      client: doctor,
      body: { ...procedureInput, appointmentId: appointment.id },
    });
    assert.equal(planned.status, 201);
    assert.equal(
      (
        await call(`/procedures/${planned.data.id}/agreements`, {
          method: 'POST',
          client: patient,
          body: { decision: 'agreed', method: 'portal' },
        })
      ).status,
      201,
    );
    const completion = {
      outcome: 'Recorded after the visit started.',
      aftercare: 'Clinician aftercare.',
    };
    assert.equal(
      (
        await call(`/procedures/${planned.data.id}/complete`, {
          method: 'POST',
          client: doctor,
          body: completion,
        })
      ).status,
      409,
    );
    context.mock.timers.setTime(visit);
    assert.equal(
      (
        await call(`/procedures/${planned.data.id}/complete`, {
          method: 'POST',
          client: doctor,
          body: completion,
        })
      ).status,
      200,
    );
  } finally {
    context.mock.timers.reset();
    for (const session of sessionExpirations)
      app.locals.db
        .prepare('UPDATE sessions SET expiresAt=? WHERE tokenHash=?')
        .run(session.expiresAt, session.tokenHash);
  }
});
