import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Encounter, PatientRecord, Session } from '../../shared/types';
import type { PatientClinicalWorkflows } from '../../shared/clinical';
import type {
  ConsultationNoteInput,
  ConsultationAmendmentInput,
  ConsultationRecordingResult,
} from '../../shared/consultation-recording';
import type { CareSummary } from '../../shared/care-summary';

const notes = '/api/consultation-notes';
const amendments = (id: string) => `/api/encounters/${id}/amendment-recordings`;
const noteAgreement = 'I reviewed this clinical note and confirm it is ready to record.';
const amendmentAgreement = 'I reviewed the original note and this amendment before recording it.';
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  url: string,
  data: unknown,
  code = 201,
): Promise<T> {
  const response = await request.post(url, { headers, data });
  expect(response.status(), await response.text()).toBe(code);
  return response.json();
}
async function audit(page: Page) {
  await page.setViewportSize({ width: 320, height: 860 });
  await page.evaluate(() => document.fonts.ready);
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}
async function unobscured(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return !!hit && element.contains(hit);
      }),
    )
    .toBe(true);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function navigate(page: Page, url: string) {
  await page.evaluate((url) => {
    window.history.pushState({ key: crypto.randomUUID() }, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}
async function observeResponses(page: Page) {
  await page.evaluate(() => {
    const original = window.fetch.bind(window),
      state = window as Window & { consultationConsumed?: string[]; consultationExpired?: number };
    state.consultationConsumed = [];
    state.consultationExpired = 0;
    window.addEventListener('derma:session-expired', () => state.consultationExpired!++);
    window.fetch = async (...args) => {
      const response = await original(...args),
        marker = response.headers.get('X-Test-Consultation-Settled');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.consultationConsumed!.push(marker);
          }
        };
      }
      return response;
    };
  });
}
async function consumed(page: Page, marker: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (marker) =>
          (window as Window & { consultationConsumed?: string[] }).consultationConsumed?.includes(
            marker,
          ),
        marker,
      ),
    )
    .toBe(true);
}

async function newPatient(request: APIRequestContext, headers: Record<string, string>) {
  return post<{ id: string; name: string }>(request, headers, '/api/patients', {
    name: `Synthetic note patient ${randomUUID().slice(0, 8)}`,
    email: '',
    phone: '+91 9000000191',
    dob: '',
    gender: '',
  });
}
function content(prefix = randomUUID()) {
  return {
    history: `PRIVATE history ${prefix}`,
    examination: `PRIVATE examination ${prefix}`,
    assessment: `PRIVATE assessment ${prefix}`,
    investigations: `PRIVATE investigation context ${prefix}`,
    plan: `PRIVATE care decisions ${prefix}`,
  };
}
async function fillNote(dialog: Locator, values: ReturnType<typeof content>) {
  for (const [label, key] of [
    ['History', 'history'],
    ['Examination', 'examination'],
    ['Assessment', 'assessment'],
    ['Investigations', 'investigations'],
    ['Plan and next steps', 'plan'],
  ] as const)
    await dialog.getByLabel(label, { exact: true }).fill(values[key]);
}
async function openCreate(page: Page, patientId: string) {
  await page.goto(`/clinic/patients/${patientId}`);
  await page.getByRole('button', { name: 'Add visit note', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Document consultation', exact: true });
  await expect(dialog.getByLabel('Assessment', { exact: true })).toBeVisible();
  return dialog;
}
async function openAmend(page: Page, encounter: Encounter) {
  await page.goto(`/clinic/patients/${encounter.patientId}?tab=visits`);
  const card = page
    .locator('.card')
    .filter({ has: page.getByText(encounter.assessment, { exact: true }) });
  await card.getByRole('button', { name: 'Add amendment', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Amend the consultation record', exact: true });
  await expect(dialog.getByLabel('Reason for amendment', { exact: true })).toBeVisible();
  return dialog;
}
async function send(page: Page, dialog: Locator, path: string, button: string, status = 201) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: button, exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(status);
  return response;
}
async function closeRecorded(dialog: Locator, amendment = false) {
  await expect(
    dialog.getByRole('heading', {
      name: amendment ? 'Amendment recorded' : 'Clinical note recorded',
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close clinical record', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function linkedVisit(
  request: APIRequestContext,
  headers: Record<string, string>,
  patientId: string,
) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  for (let offset = 120; offset < 130; offset++) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000)
      .toISOString()
      .slice(0, 10);
    const slots = await get<string[]>(
      request,
      `/api/slots?doctorId=doctor-meera&date=${date}&mode=in-person`,
    );
    if (slots.length)
      return post<Appointment>(request, headers, '/api/appointments', {
        patientId,
        doctorId: 'doctor-meera',
        date,
        time: slots[0],
        mode: 'in-person',
        reason: `Synthetic consultation link ${randomUUID()}`,
      });
  }
  throw new Error('No fixture appointment slot available');
}

test('a clinician explicitly records standalone and linked notes with an attributed amendment while internal documentation stays outside patient summaries', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    values = content(),
    linked = await linkedVisit(page.request, admin.headers, 'patient-ananya');
  let dialog = await openCreate(page, 'patient-ananya');
  await fillNote(dialog, values);
  await expect(
    dialog.getByRole('button', { name: 'Save clinical note', exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel(noteAgreement, { exact: true }).check();
  await audit(page);
  const save = dialog.getByRole('button', { name: 'Save clinical note', exact: true });
  await dialog
    .locator('.consultation-recording-confirm')
    .evaluate((label) => label.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await unobscured(save);
  await unobscured(dialog.getByLabel(noteAgreement, { exact: true }));
  await page.screenshot({
    path: testInfo.outputPath('consultation-note-review-mobile.png'),
    fullPage: false,
  });
  const standalone = (await (
    await send(page, dialog, notes, 'Save clinical note')
  ).json()) as ConsultationRecordingResult;
  expect(standalone.encounter).toMatchObject({
    ...values,
    patientId: 'patient-ananya',
    doctorId: admin.session.user!.doctorId,
  });
  expect(standalone.encounter).not.toHaveProperty('appointmentId');
  expect(standalone.amendment).toBeNull();
  await closeRecorded(dialog);
  const linkedValues = content();
  dialog = await openCreate(page, 'patient-ananya');
  await fillNote(dialog, linkedValues);
  await dialog.getByLabel('Linked appointment', { exact: true }).selectOption(linked.id);
  await dialog.getByLabel(noteAgreement, { exact: true }).check();
  const saved = (await (
    await send(page, dialog, notes, 'Save clinical note')
  ).json()) as ConsultationRecordingResult;
  expect(saved.encounter.appointmentId).toBe(linked.id);
  await closeRecorded(dialog);
  const correction = {
    reason: `PRIVATE clarification ${randomUUID()}`,
    text: `PRIVATE additional context ${randomUUID()}`,
  };
  dialog = await openAmend(page, saved.encounter);
  await expect(dialog.locator('.consultation-recording-source')).toContainText(
    linkedValues.assessment,
  );
  await dialog.getByLabel('Reason for amendment', { exact: true }).fill(correction.reason);
  await dialog
    .getByLabel('Correction or additional information', { exact: true })
    .fill(correction.text);
  await expect(dialog.getByRole('button', { name: 'Save amendment', exact: true })).toBeDisabled();
  await dialog.getByLabel(amendmentAgreement, { exact: true }).check();
  const amended = (await (
    await send(page, dialog, amendments(saved.encounter.id), 'Save amendment')
  ).json()) as ConsultationRecordingResult;
  expect(amended.encounter).toEqual(saved.encounter);
  expect(amended.amendment).toMatchObject({
    ...correction,
    encounterId: saved.encounter.id,
    patientId: 'patient-ananya',
    doctorId: admin.session.user!.doctorId,
  });
  expect(amended.receipt.operation).toBe('amend');
  await closeRecorded(dialog, true);
  await expect(page.getByText(linkedValues.assessment, { exact: true })).toBeVisible();
  await expect(page.getByText(correction.text, { exact: true })).toBeVisible();
  const record = await get<PatientRecord>(page.request, '/api/patients/patient-ananya');
  expect(record.encounters.find((value) => value.id === saved.encounter.id)).toEqual(
    saved.encounter,
  );
  expect(
    (await get<Appointment[]>(page.request, '/api/appointments')).find(
      (value) => value.id === linked.id,
    ),
  ).toEqual(linked);
  const own = await browser.newContext({ baseURL }),
    reception = await browser.newContext({ baseURL });
  try {
    const patientActor = await login(own.request, 'patient@derma.demo');
    const receptionActor = await login(reception.request, 'reception@derma.demo');
    const shared = await get<PatientRecord>(own.request, '/api/patients/patient-ananya');
    expect(shared.encounters).toEqual([]);
    const safe = await get<PatientClinicalWorkflows>(
      own.request,
      '/api/patients/patient-ananya/clinical-workflows',
    );
    expect(safe.amendments).toEqual([]);
    const summary = await get<CareSummary>(
      own.request,
      '/api/patients/patient-ananya/care-summary',
    );
    for (const marker of [
      values.assessment,
      linkedValues.assessment,
      correction.text,
      amended.receipt.requestId,
    ])
      expect(JSON.stringify(summary)).not.toContain(marker);
    const deniedRecord = await reception.request.get('/api/patients/patient-ananya');
    expect(deniedRecord.status()).toBe(403);
    expect(await deniedRecord.text()).not.toContain(linkedValues.assessment);
    expect(
      (
        await own.request.post(notes, {
          headers: patientActor.headers,
          data: {
            ...values,
            patientId: 'patient-ananya',
            reviewedConfirmed: true,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await reception.request.post(amendments(saved.encounter.id), {
          headers: receptionActor.headers,
          data: { ...correction, reviewedConfirmed: true, requestId: randomUUID() },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await own.close();
    await reception.close();
  }
});

test('an uncertain new note keeps its exact reviewed content through malformed, wrong-author and wrong-operation receipts after the linked appointment closes', async ({
  page,
}, testInfo) => {
  const admin = await login(page.request),
    patient = await newPatient(page.request, admin.headers),
    visit = await linkedVisit(page.request, admin.headers, patient.id),
    values = content();
  let dialog = await openCreate(page, patient.id);
  await fillNote(dialog, values);
  await dialog.getByLabel('Linked appointment', { exact: true }).selectOption(visit.id);
  await dialog.getByLabel(noteAgreement, { exact: true }).check();
  const attempts: ConsultationNoteInput[] = [];
  let first!: ConsultationRecordingResult;
  await page.route(`**${notes}`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      first = await response.json();
      await route.fulfill({
        status: 200,
        json: { ...first, encounter: { ...first.encounter, assessment: null } },
      });
    } else if (attempts.length === 2)
      await route.fulfill({
        status: 400,
        json: { error: 'A later validation response does not resolve the uncertain note.' },
      });
    else if (attempts.length === 3)
      await route.fulfill({
        status: 200,
        json: { ...first, receipt: { ...first.receipt, actorId: 'user-reception' } },
      });
    else if (attempts.length === 4)
      await route.fulfill({
        status: 200,
        json: {
          ...first,
          encounter: { ...first.encounter, doctorId: 'doctor-arjun' },
          receipt: { ...first.receipt, doctorId: 'doctor-arjun' },
        },
      });
    else if (attempts.length === 5)
      await route.fulfill({
        status: 200,
        json: { ...first, receipt: { ...first.receipt, operation: 'amend' } },
      });
    else if (attempts.length === 6)
      await route.fulfill({
        status: 409,
        json: { error: 'This request ID was already used for a different consultation recording.' },
      });
    else await route.continue();
  });
  await send(page, dialog, notes, 'Save clinical note', 200);
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByLabel('Assessment', { exact: true })).toBeDisabled();
  await audit(page);
  const retry = dialog.getByRole('button', { name: 'Retry same request', exact: true });
  await dialog
    .locator('.notice-warning')
    .evaluate((notice) => notice.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await unobscured(retry);
  await unobscured(dialog.locator('.notice-warning'));
  await page.screenshot({
    path: testInfo.outputPath('consultation-note-pending-mobile.png'),
    fullPage: false,
  });
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Add visit note', exact: true }).first(),
  ).toBeDisabled();
  await page.getByRole('tab', { name: /^Visits \(/ }).click();
  await expect(page).toHaveURL(new RegExp(`/clinic/patients/${patient.id}\\?tab=visits$`));
  await expect(
    page.getByRole('button', { name: 'Resume clinical record', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Resume clinical record', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Document consultation', exact: true });
  expect(
    (
      await page.request.patch(`/api/appointments/${visit.id}`, {
        headers: admin.headers,
        data: { status: 'cancelled' },
      })
    ).status(),
  ).toBe(200);
  await post(page.request, admin.headers, `/api/encounters/${first.encounter.id}/amendments`, {
    reason: 'PRIVATE later recorded clarification',
    text: 'PRIVATE later amendment does not alter the original note receipt.',
  });
  for (const status of [400, 200, 200, 200, 409]) {
    await send(page, dialog, notes, 'Retry same request', status);
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByLabel('Assessment', { exact: true })).toHaveValue(values.assessment);
    await expect(dialog.getByLabel('Assessment', { exact: true })).toBeDisabled();
  }
  const replay = (await (
    await send(page, dialog, notes, 'Retry same request', 200)
  ).json()) as ConsultationRecordingResult;
  expect(replay).toEqual(first);
  expect(attempts).toHaveLength(7);
  for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
  await closeRecorded(dialog);
  const record = await get<PatientRecord>(page.request, `/api/patients/${patient.id}`);
  expect(record.encounters).toEqual([first.encounter]);
  expect(
    (
      await get<PatientClinicalWorkflows>(
        page.request,
        `/api/patients/${patient.id}/clinical-workflows`,
      )
    ).amendments,
  ).toHaveLength(1);
});

test('an amendment retains the original note and exact addition while rejecting wrong-source or operation receipts and surviving later amendments', async ({
  page,
}, testInfo) => {
  const admin = await login(page.request),
    patient = await newPatient(page.request, admin.headers),
    values = content();
  const source = await post<ConsultationRecordingResult>(page.request, admin.headers, notes, {
    ...values,
    patientId: patient.id,
    reviewedConfirmed: true,
    requestId: randomUUID(),
  });
  let dialog = await openAmend(page, source.encounter);
  const correction = {
    reason: `PRIVATE attributed correction ${randomUUID()}`,
    text: `PRIVATE corrected source statement ${randomUUID()}`,
  };
  await dialog.getByLabel('Reason for amendment', { exact: true }).fill(correction.reason);
  await dialog
    .getByLabel('Correction or additional information', { exact: true })
    .fill(correction.text);
  await dialog.getByLabel(amendmentAgreement, { exact: true }).check();
  const attempts: ConsultationAmendmentInput[] = [];
  let first!: ConsultationRecordingResult;
  await page.route(`**${amendments(source.encounter.id)}`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      first = await response.json();
      await route.fulfill({ status: 200, json: { ...first, amendment: null } });
    } else if (attempts.length === 2)
      await route.fulfill({
        status: 200,
        json: {
          ...first,
          encounter: {
            ...first.encounter,
            assessment: 'An unrelated note must not confirm this amendment.',
          },
        },
      });
    else if (attempts.length === 3)
      await route.fulfill({
        status: 200,
        json: { ...first, amendment: { ...first.amendment, encounterId: randomUUID() } },
      });
    else if (attempts.length === 4)
      await route.fulfill({
        status: 200,
        json: { ...first, receipt: { ...first.receipt, operation: 'create' } },
      });
    else await route.continue();
  });
  await send(page, dialog, amendments(source.encounter.id), 'Save amendment', 200);
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await page.getByRole('button', { name: 'Resume clinical record', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Amend the consultation record', exact: true });
  await post(page.request, admin.headers, `/api/encounters/${source.encounter.id}/amendments`, {
    reason: 'Later independent clarification',
    text: 'Additional information recorded separately.',
  });
  for (let i = 0; i < 3; i++) {
    await send(page, dialog, amendments(source.encounter.id), 'Retry same request', 200);
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(
      dialog.getByLabel('Correction or additional information', { exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByLabel('Correction or additional information', { exact: true }),
    ).toHaveValue(correction.text);
  }
  const replay = (await (
    await send(page, dialog, amendments(source.encounter.id), 'Retry same request', 200)
  ).json()) as ConsultationRecordingResult;
  expect(replay).toEqual(first);
  expect(replay.encounter).toEqual(source.encounter);
  expect(attempts).toHaveLength(5);
  for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
  await expect(
    dialog.getByRole('heading', { name: 'Amendment recorded', exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('.consultation-recording-amendment')).toContainText(correction.text);
  await audit(page);
  const close = dialog.getByRole('button', { name: 'Close clinical record', exact: true });
  await dialog
    .locator('.consultation-recording-amendment')
    .evaluate((record) => record.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await unobscured(close);
  await unobscured(dialog.locator('.consultation-recording-amendment'));
  await page.screenshot({
    path: testInfo.outputPath('consultation-amendment-confirmed-mobile.png'),
    fullPage: false,
  });
  await closeRecorded(dialog, true);
  const current = await get<PatientRecord>(page.request, `/api/patients/${patient.id}`);
  expect(current.encounters).toEqual([source.encounter]);
  const amendmentsNow = (
    await get<PatientClinicalWorkflows>(
      page.request,
      `/api/patients/${patient.id}/clinical-workflows`,
    )
  ).amendments;
  expect(amendmentsNow).toHaveLength(2);
  expect(amendmentsNow.filter((value) => value.text === correction.text)).toEqual([
    first.amendment,
  ]);
});

test('an uncommitted note stays locked for an unrelated outcome marker, then a real terminal rejection permits an explicitly reviewed corrected draft with a new UUID', async ({
  page,
}) => {
  const admin = await login(page.request),
    patient = await newPatient(page.request, admin.headers),
    visit = await linkedVisit(page.request, admin.headers, patient.id),
    values = content();
  const staleVisit = { ...visit, id: randomUUID() };
  // A stale own-record response offers a link that no longer exists. The real service
  // authorizes the patient first and records a definitive missing-link rejection.
  await page.route(`**/api/patients/${patient.id}`, async (route) => {
    const response = await route.fetch(),
      record = (await response.json()) as PatientRecord;
    await route.fulfill({
      response,
      json: { ...record, appointments: [staleVisit, ...record.appointments] },
    });
  });
  const dialog = await openCreate(page, patient.id);
  await fillNote(dialog, values);
  await dialog.getByLabel('Linked appointment', { exact: true }).selectOption(staleVisit.id);
  await dialog.getByLabel(noteAgreement, { exact: true }).check();
  const attempts: ConsultationNoteInput[] = [];
  await page.route(`**${notes}`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) await route.abort('failed');
    else if (attempts.length === 2)
      await route.fulfill({
        status: 400,
        json: {
          error: 'An outcome belonging to another account must not unlock this note.',
          consultationOutcome: 'not-recorded',
          requestId: attempts[0].requestId,
          actorId: 'user-reception',
          operation: 'create',
          patientId: patient.id,
          encounterId: null,
        },
      });
    else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save clinical note', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await send(page, dialog, notes, 'Retry same request', 400);
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByLabel('Assessment', { exact: true })).toBeDisabled();
  const rejection = await send(page, dialog, notes, 'Retry same request', 400);
  expect(await rejection.json()).toMatchObject({
    consultationOutcome: 'not-recorded',
    requestId: attempts[0].requestId,
    actorId: admin.session.user!.id,
    operation: 'create',
    patientId: patient.id,
    encounterId: null,
  });
  await expect(dialog.getByRole('button', { name: 'Retry same request', exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByLabel('Assessment', { exact: true })).toHaveValue(values.assessment);
  await expect(dialog.getByLabel('Assessment', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Review draft again', exact: true }).click();
  await expect(dialog.getByLabel('Assessment', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel(noteAgreement, { exact: true })).not.toBeChecked();
  await dialog.getByLabel('Linked appointment', { exact: true }).selectOption('');
  await dialog.getByLabel(noteAgreement, { exact: true }).check();
  const rejected = await page.request.post(notes, { headers: admin.headers, data: attempts[0] });
  expect(rejected.status()).toBe(400);
  expect(await rejected.json()).toMatchObject({
    consultationOutcome: 'not-recorded',
    requestId: attempts[0].requestId,
  });
  const saved = (await (
    await send(page, dialog, notes, 'Save clinical note')
  ).json()) as ConsultationRecordingResult;
  expect(saved.encounter).toMatchObject(values);
  expect(saved.encounter).not.toHaveProperty('appointmentId');
  expect(attempts.slice(0, 3)).toEqual([attempts[0], attempts[0], attempts[0]]);
  expect(attempts[3].requestId).not.toBe(attempts[0].requestId);
  // Closing reloads the patient record. Let the mock finish before that read.
  await page.unrouteAll({ behavior: 'wait' });
  await closeRecorded(dialog);
  expect(
    (await get<PatientRecord>(page.request, `/api/patients/${patient.id}`)).encounters,
  ).toEqual([saved.encounter]);
});

test('read recovery and native navigation suppress late consultation confirmations and authorization errors without reviving old drafts', async ({
  page,
}) => {
  const admin = await login(page.request),
    patient = await newPatient(page.request, admin.headers),
    other = await newPatient(page.request, admin.headers),
    values = content();
  const recordRoute = `**/api/patients/${patient.id}`;
  let failRead = true;
  await page.route(recordRoute, (route) =>
    failRead
      ? route.fulfill({
          status: 503,
          json: { error: 'Synthetic consultation record is temporarily unavailable.' },
        })
      : route.continue(),
  );
  await page.goto(`/clinic/patients/${patient.id}`);
  await expect(
    page.getByText('Synthetic consultation record is temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  failRead = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: patient.name, exact: true })).toBeVisible();
  await page.unroute(recordRoute);
  await observeResponses(page);
  await page.getByRole('button', { name: 'Add visit note', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Document consultation', exact: true });
  await fillNote(dialog, values);
  await dialog.getByLabel(noteAgreement, { exact: true }).check();
  const seen = deferred(),
    release = deferred();
  let recorded!: ConsultationRecordingResult;
  await page.route(`**${notes}`, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    recorded = await response.json();
    seen.resolve();
    await release.promise;
    await route
      .fulfill({
        response,
        headers: { ...response.headers(), 'X-Test-Consultation-Settled': 'old-created-note' },
      })
      .catch(() => undefined);
  });
  await dialog.getByRole('button', { name: 'Save clinical note', exact: true }).click();
  await seen.promise;
  await expect(dialog.getByLabel('Assessment', { exact: true })).toBeDisabled();
  await navigate(page, '/clinic/patients');
  await expect(page.getByLabel('Search patient directory', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: patient.name, exact: true })).toBeVisible();
  const returned = page.url();
  release.resolve();
  await consumed(page, 'old-created-note');
  await expect(page).toHaveURL(returned);
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Clinical note recorded', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Resume clinical record', exact: true }),
  ).toHaveCount(0);
  expect(
    (await get<PatientRecord>(page.request, `/api/patients/${patient.id}`)).encounters,
  ).toEqual([recorded.encounter]);
  await page.unroute(`**${notes}`);
  // New form starts clean even after Back returns to the exact old URL.
  await page.getByRole('button', { name: 'Add visit note', exact: true }).first().click();
  await expect(dialog.getByLabel('Assessment', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  dialog = await openAmend(page, recorded.encounter);
  await observeResponses(page);
  await dialog
    .getByLabel('Reason for amendment', { exact: true })
    .fill('Discarded draft after navigation');
  await dialog
    .getByLabel('Correction or additional information', { exact: true })
    .fill('This intercepted request never reached the server.');
  await dialog.getByLabel(amendmentAgreement, { exact: true }).check();
  const amendmentSeen = deferred(),
    amendmentRelease = deferred();
  await page.route(`**${amendments(recorded.encounter.id)}`, async (route) => {
    amendmentSeen.resolve();
    await amendmentRelease.promise;
    await route
      .fulfill({
        status: 401,
        json: { error: 'Obsolete amendment reply must not expire the current session.' },
        headers: { 'X-Test-Consultation-Settled': 'old-amendment-401' },
      })
      .catch(() => undefined);
  });
  await dialog.getByRole('button', { name: 'Save amendment', exact: true }).click();
  await amendmentSeen.promise;
  await navigate(page, `/clinic/patients/${other.id}`);
  await expect(page.getByRole('heading', { name: other.name, exact: true })).toBeVisible();
  amendmentRelease.resolve();
  await consumed(page, 'old-amendment-401');
  expect(
    await page.evaluate(
      () => (window as Window & { consultationExpired?: number }).consultationExpired,
    ),
  ).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/clinic/patients/${other.id}$`));
  await expect(
    page.getByText('Obsolete amendment reply must not expire the current session.', {
      exact: true,
    }),
  ).toHaveCount(0);
  const recordSeen = deferred(),
    recordRelease = deferred();
  await page.route(recordRoute, async (route) => {
    recordSeen.resolve();
    await recordRelease.promise;
    await route
      .fulfill({
        status: 401,
        json: { error: 'Obsolete source record must not expire the current session.' },
        headers: { 'X-Test-Consultation-Settled': 'old-source-401' },
      })
      .catch(() => undefined);
  });
  await navigate(page, `/clinic/patients/${patient.id}`);
  await recordSeen.promise;
  await navigate(page, '/account');
  await expect(
    page.getByRole('heading', { name: 'Your account & security', exact: true }),
  ).toBeVisible();
  recordRelease.resolve();
  await consumed(page, 'old-source-401');
  expect(
    await page.evaluate(
      () => (window as Window & { consultationExpired?: number }).consultationExpired,
    ),
  ).toBe(0);
  await expect(page).toHaveURL(/\/account$/);
  expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(admin.session.user!.id);
});
