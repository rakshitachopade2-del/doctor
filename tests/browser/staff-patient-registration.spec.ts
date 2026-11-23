import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type {
  PatientRegistrationCommand,
  PatientRegistrationResponse,
} from '../../shared/patient-registration';
import type { PatientProfile, PatientAllergyHistory } from '../../shared/patient-profile';
import type { Patient } from '../../shared/types';
import {
  type Actor,
  button,
  checkbox,
  deferred,
  dialog,
  field,
  login,
  mobile,
  post,
  read,
  test,
  title,
} from './workflow-fixtures';

const directory = '/clinic/patients';
const endpoint = '/api/patients/register';
const save = 'Register patient';
const retry = 'Retry exact registration';
const resume = 'Resume patient registration';
const action = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const nameFor = () => 'Synthetic chart ' + randomUUID().slice(0, 8);

async function start(page: Page, name: string, allergy?: string) {
  await action(page, 'Add patient').click();
  await expect(title(page, 'Register a patient')).toBeVisible();
  await field(page, 'Full name').fill(name);
  await field(page, 'Phone number').fill('9000000200');
  if (allergy !== undefined) await field(page, 'Known allergies').fill(allergy);
}

async function review(page: Page) {
  await button(page, 'Review registration').click();
  await expect(title(page, 'Confirm patient registration')).toBeVisible();
  await expect(dialog(page).locator('.patient-registration')).toBeFocused();
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}

async function send(page: Page, label: string, status: number) {
  const received = page.waitForResponse(
    (r) => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST',
  );
  await button(page, label).click();
  const response = await received;
  expect(response.status()).toBe(status);
  return response;
}

async function charts(admin: Actor, name: string) {
  return (await read<Patient[]>(admin, '/api/patients')).filter((p) => p.name === name);
}

async function createdOnce(admin: Actor, patientId: string) {
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=patient&entityId=' + patientId,
  );
  expect(audit.items.filter((row) => row.action === 'created patient')).toHaveLength(1);
}

async function correct(admin: Actor, p: Patient) {
  const path = '/api/patients/' + p.id;
  const profile = await read<PatientProfile>(admin, path + '/profile');
  const response = await admin.api.patch(path + '/profile', {
    headers: { 'X-CSRF-Token': admin.session.csrfToken! },
    data: {
      ...profile.demographics,
      name: p.name + ' corrected',
      phone: '9000000201',
      expectedRevision: profile.revision,
      reason: 'Synthetic verified demographic correction',
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const allergies = await read<PatientAllergyHistory>(admin, path + '/allergies');
  await post(
    admin,
    path + '/allergies',
    {
      status: 'recorded',
      text: 'Updated synthetic allergy history',
      expectedRevision: allergies.revision,
      reason: 'Synthetic clinician correction',
      requestId: randomUUID(),
    },
    200,
  );
}

test('a clinician recovers the original chart after corrections and opens the current record by its ID', async ({
  page,
  admin,
}, info) => {
  const doctor = await login(page.request, 'doctor');
  const name = nameFor(),
    allergy = 'Original synthetic allergy note.';
  await page.goto(directory);
  await start(page, '  ' + name + '  ', '  ' + allergy + '  ');
  await field(page, 'Email address').fill('Example@EXAMPLE.TEST');
  await field(page, 'Date of birth').fill('1996-04-12');
  await field(page, 'Gender').selectOption('Female');
  await review(page);
  await expect(dialog(page)).toContainText(allergy);
  await mobile(page, save, info.outputPath('review-320.png'));
  const attempts: PatientRegistrationCommand[] = [];
  let original!: PatientRegistrationResponse;
  await page.route('**' + endpoint, async (route) => {
    const n = attempts.push(route.request().postDataJSON());
    const upstream = await route.fetch();
    const data: PatientRegistrationResponse = await upstream.json();
    if (n === 1) {
      original = data;
      return route.abort('connectionreset');
    }
    if (n === 2) data.receipt.actorId = 'other-recording-account';
    if (n === 3) data.receipt.patient.email = 'wrong@example.test';
    if (n === 4) data.receipt.patient.createdAt = 'not-a-timestamp';
    if (n === 5) data.receipt.patient.id = 'invalid-chart-id';
    if (n === 6) data.receipt.registeredByRole = 'receptionist';
    return route.fulfill({ response: upstream, json: data });
  });
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  expect(original.receipt).toMatchObject({
    actorId: doctor.session.user!.id,
    registeredByRole: 'doctor',
    patient: { name, allergies: allergy, allergyStatus: 'recorded', email: 'example@example.test' },
  });
  expect(await charts(admin, name)).toHaveLength(1);
  await correct(admin, original.receipt.patient);
  await action(page, resume).click();
  for (let n = 2; n <= 6; n++) {
    await send(page, retry, 200);
    await expect(button(page, retry)).toBeEnabled();
    await expect(title(page, 'Patient registered')).toHaveCount(0);
    await expect(dialog(page)).not.toContainText('wrong@example.test');
  }
  const saved = await (await send(page, retry, 200)).json();
  expect(saved).toEqual(original);
  await expect(title(page, 'Patient registered')).toBeVisible();
  await expect(dialog(page)).toContainText(original.receipt.patient.id);
  await expect(dialog(page)).toContainText(allergy);
  await expect(dialog(page)).not.toContainText(name + ' corrected');
  await mobile(page, 'Done', info.outputPath('saved-320.png'));
  expect(attempts[0]).toEqual({
    name,
    phone: '9000000200',
    email: 'example@example.test',
    allergies: allergy,
    dob: '1996-04-12',
    gender: 'Female',
    requestId: original.receipt.requestId,
    registeredByRole: 'doctor',
    reviewedConfirmed: true,
  });
  for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
  const link = dialog(page).getByRole('link', { name: 'Open patient record', exact: true });
  await expect(link).toHaveAttribute('href', directory + '/' + original.receipt.patient.id);
  await link.click();
  await expect(page.getByRole('heading', { name: name + ' corrected', exact: true })).toBeVisible();
  expect(await charts(admin, name)).toHaveLength(0);
  expect(await charts(admin, name + ' corrected')).toHaveLength(1);
  await createdOnce(admin, original.receipt.patient.id);
});

test('reception recovers only demographics and opens the correct chart details after a later allergy update', async ({
  page,
  admin,
}) => {
  await login(page.request, 'reception');
  const name = nameFor();
  await page.goto(directory);
  await start(page, name);
  await expect(field(page, 'Known allergies')).toHaveCount(0);
  await review(page);
  const secret = 'Injected clinical text must remain private.';
  let original!: PatientRegistrationResponse;
  let calls = 0;
  await page.route('**' + endpoint, async (route) => {
    const upstream = await route.fetch();
    const data: PatientRegistrationResponse = await upstream.json();
    calls++;
    if (calls === 1) {
      original = data;
      return route.fulfill({ status: 200, json: {} });
    }
    if (calls === 2) data.receipt.patient.allergies = secret;
    if (calls === 3) data.receipt.patient.allergyStatus = 'recorded';
    return route.fulfill({ response: upstream, json: data });
  });
  await send(page, save, 200);
  await expect(button(page, retry)).toBeEnabled();
  expect(original.receipt.patient.allergies).toBe('');
  expect(original.receipt.patient).not.toHaveProperty('allergyStatus');
  await correct(admin, original.receipt.patient);
  for (let i = 2; i <= 3; i++) {
    await send(page, retry, 200);
    await expect(button(page, retry)).toBeEnabled();
    await expect(dialog(page)).not.toContainText(secret);
  }
  expect(await (await send(page, retry, 200)).json()).toEqual(original);
  await expect(title(page, 'Patient registered')).toBeVisible();
  await expect(dialog(page)).not.toContainText(/allerg/i);
  const link = dialog(page).getByRole('link', { name: 'Open patient details', exact: true });
  await expect(link).toHaveAttribute(
    'href',
    directory + '/' + original.receipt.patient.id + '/details',
  );
  await link.click();
  await expect(page.getByText(name + ' corrected', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Updated synthetic allergy history', { exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/patients/' + original.receipt.patient.id)).status()).toBe(
    403,
  );
  await createdOnce(admin, original.receipt.patient.id);
});

test('an undelivered registration can be retried once and a second intended registration can have identical contact details', async ({
  page,
  admin,
}) => {
  await login(page.request, 'reception');
  await page.goto(directory);
  const name = nameFor();
  const attempts: PatientRegistrationCommand[] = [];
  await page.route('**' + endpoint, (route) => {
    if (attempts.push(route.request().postDataJSON()) === 1) return route.abort('failed');
    return route.continue();
  });
  await start(page, name);
  await review(page);
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  expect(await charts(admin, name)).toEqual([]);
  await button(page, 'Close for now').click();
  await action(page, resume).click();
  const first: PatientRegistrationResponse = await (await send(page, retry, 201)).json();
  await button(page, 'Done').click();
  await start(page, name);
  await review(page);
  const second: PatientRegistrationResponse = await (await send(page, save, 201)).json();
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2].requestId).not.toEqual(attempts[1].requestId);
  expect(attempts[2]).toEqual({ ...attempts[1], requestId: attempts[2].requestId });
  await expect(dialog(page)).toContainText(second.receipt.patient.id);
  await expect(dialog(page)).not.toContainText(first.receipt.patient.id);
  expect(second.receipt.patient.id).not.toBe(first.receipt.patient.id);
  expect((await charts(admin, name)).map((row) => row.id).sort()).toEqual(
    [first.receipt.patient.id, second.receipt.patient.id].sort(),
  );
  for (const result of [first, second]) await createdOnce(admin, result.receipt.patient.id);
});

test('unresolved registration clears on reload and on sign-out without retaining private fields in browser storage', async ({
  page,
  admin,
}) => {
  await login(page.request, 'doctor');
  await page.goto(directory);
  const attempts: PatientRegistrationCommand[] = [];
  await page.route('**' + endpoint, (route) => {
    attempts.push(route.request().postDataJSON());
    return route.fulfill({
      status: 409,
      json: { message: 'Synthetic unrelated request conflict.' },
    });
  });
  for (const reset of ['reload', 'sign out']) {
    const name = nameFor(),
      allergy = 'Private allergy ' + randomUUID();
    await start(page, name, allergy);
    await review(page);
    await send(page, save, 409);
    await expect(button(page, retry)).toBeEnabled();
    const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    for (const value of [name, allergy, attempts.at(-1)!.requestId])
      expect(storage).not.toContain(value);
    await button(page, 'Close for now').click();
    await expect(action(page, resume)).toBeVisible();
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL(/\/login|\/$/);
      await login(page.request, 'reception');
      await page.goto(directory);
    }
    await expect(action(page, 'Add patient')).toBeEnabled();
    await expect(action(page, resume)).toHaveCount(0);
    await expect(page.getByText(allergy, { exact: true })).toHaveCount(0);
    expect(await charts(admin, name)).toHaveLength(0);
  }
});

test('a late registration response cannot expire a different route or erase the same-tab recovery', async ({
  page,
  admin,
}) => {
  await login(page.request, 'doctor');
  await page.goto(directory);
  const name = nameFor(),
    reached = deferred(),
    deliver = deferred();
  let original!: PatientRegistrationResponse;
  await page.route(
    '**' + endpoint,
    async (route) => {
      const upstream = await route.fetch();
      original = await upstream.json();
      reached.resolve();
      await deliver.promise;
      return route.fulfill({ status: 401, json: { error: 'Synthetic old session response' } });
    },
    { times: 1 },
  );
  await start(page, name, 'Private clinical note.');
  await review(page);
  await button(page, save).click();
  await reached.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === endpoint && r.status() === 401,
  );
  try {
    await button(page, 'Close for now').click();
    await page.getByRole('link', { name: 'Appointments', exact: true }).first().click();
    await expect(page).toHaveURL(/\/clinic\/appointments/);
  } finally {
    deliver.resolve();
  }
  await (await late).finished();
  await expect(page).toHaveURL(/\/clinic\/appointments/);
  await expect(page.getByText('Private clinical note.', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Patients', exact: true }).first().click();
  await action(page, resume).click();
  expect(await (await send(page, retry, 200)).json()).toEqual(original);
  await expect(title(page, 'Patient registered')).toBeVisible();
  await createdOnce(admin, original.receipt.patient.id);
});

test('editing after review requires fresh confirmation and submits only the displayed final details', async ({
  page,
  admin,
}) => {
  await login(page.request, 'admin');
  await page.goto(directory);
  const name = nameFor(),
    corrected = name + ' revised';
  await start(page, '   ', 'Draft allergy');
  await button(page, 'Review registration').click();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(title(page, 'Register a patient')).toBeVisible();
  await expect(field(page, 'Known allergies')).toHaveValue('Draft allergy');
  await field(page, 'Full name').fill(name);
  await review(page);
  await button(page, 'Edit details').click();
  await field(page, 'Full name').fill(corrected);
  await field(page, 'Known allergies').fill('');
  await review(page);
  await expect(dialog(page)).not.toContainText('Draft allergy');
  const result: PatientRegistrationResponse = await (await send(page, save, 201)).json();
  expect(result.receipt.patient).toMatchObject({
    name: corrected,
    allergies: '',
    allergyStatus: 'not-recorded',
  });
  expect(await charts(admin, name)).toHaveLength(0);
  const ids = (await charts(admin, corrected)).map((p) => p.id);
  expect(ids).toEqual([result.receipt.patient.id]);
});
