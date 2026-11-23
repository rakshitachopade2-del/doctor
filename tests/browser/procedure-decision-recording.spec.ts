import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { ActivityFeed } from '../../shared/activity';
import type {
  PatientClinicalWorkflows,
  ProcedureAgreement,
  ProcedureRecord,
} from '../../shared/clinical';
import type {
  ProcedureDecisionCommand,
  ProcedureDecisionResponse,
} from '../../shared/procedure-decision';
import {
  type Actor,
  test,
  patientId,
  portal,
  clinic,
  workflows,
  path,
  dialog,
  button,
  title,
  field,
  checkbox,
  login,
  read,
  post,
  planFor,
  current,
  card,
  mobile,
  deferred,
} from './procedure-fixtures';

const patientSave = 'Record my decision';
const clinicSave = 'Save patient decision';
const retry = 'Retry exact decision';
const resume = 'Resume procedure decision';
const recordPath = (plan: ProcedureRecord) => path(plan) + '/agreements/record';
async function effects(
  admin: Actor,
  patient: Actor,
  plan: ProcedureRecord,
  decisions: ProcedureAgreement[],
) {
  for (const actor of [admin, patient])
    expect((await current(actor, plan)).agreements).toEqual(decisions);
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=procedure&entityId=' + plan.id,
  );
  expect(
    audit.items.filter((r) => r.action.startsWith('recorded procedure decision: ')),
  ).toHaveLength(decisions.length);
  const clinicianActivity = await read<ActivityFeed>(admin, '/api/activity?limit=100');
  const patientActivity = await read<ActivityFeed>(patient, '/api/activity?limit=100');
  expect(
    clinicianActivity.items.filter(
      (r) =>
        r.title === 'A patient recorded a procedure decision' &&
        r.detail.endsWith(' · ' + plan.title),
    ),
  ).toHaveLength(decisions.filter((r) => r.recordedByRole === 'patient').length);
  expect(
    patientActivity.items.filter(
      (r) => r.title === 'Your procedure discussion was recorded' && r.detail === plan.title,
    ),
  ).toHaveLength(decisions.filter((r) => r.recordedByRole !== 'patient').length);
}
async function open(
  page: Page,
  plan: ProcedureRecord,
  role: 'patient' | 'doctor' = 'patient',
  prior = false,
) {
  await card(page, plan, role)
    .getByRole('button', {
      name:
        role === 'doctor'
          ? 'Record patient decision'
          : prior
            ? 'Update my decision'
            : 'Review and decide',
      exact: true,
    })
    .click();
  await expect(
    title(
      page,
      role === 'patient' ? 'Review your procedure decision' : 'Record the patient’s decision',
    ),
  ).toBeVisible();
}
async function fillPatient(page: Page, choice: 'agreed' | 'declined', note: string) {
  await field(page, 'Your decision').selectOption(choice);
  await field(page, 'Note for your clinic').fill(note);
}
async function review(page: Page, save: string) {
  await button(page, 'Review decision').click();
  await expect(title(page, 'Confirm procedure decision')).toBeVisible();
  await expect(dialog(page).locator('.procedure-decision-form')).toBeFocused();
  await expect(checkbox(page)).not.toBeChecked();
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}
async function send(page: Page, plan: ProcedureRecord, action: string, status: number) {
  const got = page.waitForResponse(
    (r) => new URL(r.url()).pathname === recordPath(plan) && r.request().method() === 'POST',
  );
  await button(page, action).click();
  const response = await got;
  expect(response.status()).toBe(status);
  return response;
}
test('the portal recovers an earlier declined decision after a phone agreement and completion', async ({
  page,
  admin,
}, info) => {
  const patient = await login(page.request, 'patient');
  const plan = await planFor(admin);
  const note = 'I declined the proposal during the portal review.';
  const later = 'Patient subsequently agreed by phone.';
  await page.goto(portal);
  await open(page, plan);
  await expect(field(page, 'Your decision')).toHaveValue('');
  await fillPatient(page, 'declined', ' ' + note + ' ');
  await review(page, patientSave);
  await expect(dialog(page)).toContainText(note);
  await mobile(page, patientSave, info.outputPath('review-320.png'));
  const commands: ProcedureDecisionCommand[] = [];
  let original!: ProcedureDecisionResponse;
  await page.route('**' + recordPath(plan), async (route) => {
    const n = commands.push(route.request().postDataJSON());
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(n === 1 ? 201 : 200);
    const value: ProcedureDecisionResponse = await upstream.json();
    if (n === 1) {
      original = value;
      return route.abort('connectionreset');
    }
    if (n === 2)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"receipt":' });
    if (n === 3) value.receipt.expectedLatestDecisionId = randomUUID();
    if (n === 4) value.receipt.agreement.method = 'phone';
    if (n === 5) value.receipt.agreement.decision = 'agreed';
    if (n === 6) value.receipt.actorId = 'other-author';
    return route.fulfill({ response: upstream, json: value });
  });
  await button(page, patientSave).click();
  await expect(title(page, 'Decision awaiting confirmation')).toBeVisible();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  const after = await post<ProcedureRecord>(admin, path(plan) + '/agreements', {
    decision: 'agreed',
    method: 'phone',
    note: later,
    patientDecisionConfirmed: true,
  });
  await post(
    admin,
    path(plan) + '/complete',
    { outcome: 'Synthetic outcome.', aftercare: 'Synthetic final advice.' },
    200,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Refresh updates', exact: true }).click();
  await expect(
    card(page, plan).getByRole('heading', { name: 'Procedure completed', exact: true }),
  ).toBeVisible();
  await expect(
    card(page, plan).getByRole('button', { name: 'Update my decision', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: resume, exact: true }).click();
  for (let n = 2; n <= 6; n++) {
    await send(page, plan, retry, 200);
    await expect(button(page, retry)).toBeEnabled();
    await expect(title(page, 'Decision recorded')).toHaveCount(0);
  }
  const recovered = await send(page, plan, retry, 200);
  expect(await recovered.json()).toEqual(original);
  expect(commands[0]).toEqual({
    requestId: expect.any(String),
    procedureId: plan.id,
    patientId,
    recordedByRole: 'patient',
    expectedLatestDecisionId: null,
    reviewedConfirmed: true,
    patientDecisionConfirmed: false,
    decision: 'declined',
    method: 'portal',
    note,
  });
  for (const cmd of commands) expect(cmd).toEqual(commands[0]);
  const first = original.receipt.agreement;
  expect(first).toMatchObject({
    recordedById: patient.session.user!.id,
    recordedByRole: 'patient',
    method: 'portal',
    decision: 'declined',
    note,
  });
  await expect(title(page, 'Decision recorded')).toBeVisible();
  await expect(dialog(page)).toContainText(note);
  await expect(dialog(page)).not.toContainText(later);
  await page.route(
    '**' + workflows,
    async (route) => {
      const upstream = await route.fetch();
      const record: PatientClinicalWorkflows = await upstream.json();
      const target = record.procedures.find((item) => item.id === plan.id)!;
      target.agreements = target.agreements.filter((row) => row.id !== first.id);
      await route.fulfill({ response: upstream, json: record });
    },
    { times: 1 },
  );
  await button(page, 'View current procedure').click();
  await expect(title(page, 'Decision recorded')).toBeVisible();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await button(page, 'View current procedure').click();
  await expect(title(page, 'Current procedure')).toBeVisible();
  await expect(dialog(page)).toContainText(later);
  await expect(dialog(page)).toContainText(note);
  await expect(dialog(page)).toContainText(/completed/i);
  await expect(dialog(page)).toContainText('Patient portal');
  await expect(dialog(page)).toContainText('By phone');
  await expect(dialog(page)).toContainText(first.recordedByName);
  await expect(dialog(page)).toContainText(after.agreements.at(-1)!.recordedByName);
  await effects(admin, patient, plan, [first, after.agreements.at(-1)!]);
});

test('a clinician must read an intervening portal decline and attest again before documenting an agreement', async ({
  page,
  admin,
  patient,
}, info) => {
  const doctor = await login(page.request, 'doctor'),
    plan = await planFor(admin);
  const note = 'The patient communicated agreement during our discussion.';
  await page.goto(clinic);
  await open(page, plan, 'doctor');
  await expect(field(page, 'Patient decision')).toHaveValue('');
  await field(page, 'Patient decision').selectOption('agreed');
  await field(page, 'Discussion method').selectOption('in-person');
  await field(page, 'Discussion and decision notes').fill(note);
  await expect(button(page, 'Review decision')).toBeDisabled();
  await checkbox(page).check();
  await review(page, clinicSave);
  await expect(dialog(page)).toContainText(/in person/i);
  const commands: ProcedureDecisionCommand[] = [];
  await page.route('**' + recordPath(plan), async (route) => {
    const n = commands.push(route.request().postDataJSON());
    if (n === 1) return route.abort('connectionreset');
    const upstream = await route.fetch();
    if (n === 2) return route.fulfill({ status: 409, json: { error: 'No acknowledgement' } });
    const value = await upstream.json();
    if (n === 3) value.command.expectedLatestDecisionId = randomUUID();
    return route.fulfill({ response: upstream, json: value });
  });
  await button(page, clinicSave).click();
  await expect(button(page, retry)).toBeEnabled();
  await button(page, 'Close for now').click();
  const declined = await post<ProcedureRecord>(patient, path(plan) + '/agreements', {
    decision: 'declined',
    method: 'portal',
    note: 'I declined through the portal.',
  });
  await page.getByRole('button', { name: resume, exact: true }).click();
  for (let n = 2; n <= 3; n++) {
    await send(page, plan, retry, 409);
    await expect(button(page, retry)).toBeEnabled();
    await expect(button(page, 'Refresh procedure')).toHaveCount(0);
  }
  await send(page, plan, retry, 409);
  await expect(title(page, 'Decision not recorded')).toBeVisible();
  await mobile(page, 'Refresh procedure', info.outputPath('refusal-320.png'));
  await expect(dialog(page)).toContainText(note);
  await page.route(
    '**' + workflows,
    async (route) => {
      const upstream = await route.fetch();
      const stale: PatientClinicalWorkflows = await upstream.json();
      stale.procedures.find((entry) => entry.id === plan.id)!.agreements = [];
      await route.fulfill({ response: upstream, json: stale });
    },
    { times: 1 },
  );
  await button(page, 'Refresh procedure').click();
  await expect(title(page, 'Decision not recorded')).toBeVisible();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(button(page, 'Review decision')).toHaveCount(0);
  await button(page, 'Refresh procedure').click();
  await expect(field(page, 'Discussion and decision notes')).toHaveValue(note);
  await expect(field(page, 'Patient decision')).toHaveValue('agreed');
  await expect(field(page, 'Discussion method')).toHaveValue('in-person');
  await expect(dialog(page)).toContainText('I declined through the portal.');
  await expect(checkbox(page)).not.toBeChecked();
  await expect(button(page, 'Review decision')).toBeDisabled();
  await checkbox(page).check();
  await review(page, clinicSave);
  const saved = await send(page, plan, clinicSave, 201);
  const confirmed: ProcedureDecisionResponse = await saved.json();
  for (const cmd of commands.slice(1, 4)) expect(cmd).toEqual(commands[0]);
  expect(commands[4]).toEqual({
    ...commands[0],
    requestId: expect.any(String),
    expectedLatestDecisionId: declined.agreements[0].id,
  });
  expect(commands[4].requestId).not.toBe(commands[0].requestId);
  expect(commands[4]).toMatchObject({
    recordedByRole: 'doctor',
    patientDecisionConfirmed: true,
    reviewedConfirmed: true,
    method: 'in-person',
    decision: 'agreed',
  });
  expect(confirmed.receipt.agreement).toMatchObject({
    recordedById: doctor.session.user!.id,
    recordedByRole: 'doctor',
    note,
  });
  await expect(title(page, 'Decision recorded')).toBeVisible();
  await button(page, 'Done').click();
  await expect(
    card(page, plan, 'doctor').getByRole('button', { name: 'Document completion', exact: true }),
  ).toBeEnabled();
  await effects(admin, patient, plan, [declined.agreements[0], confirmed.receipt.agreement]);
});

test('an undelivered portal decision can be retried once, and a later intentional decline has a new identity', async ({
  page,
  admin,
}, info) => {
  const patient = await login(page.request, 'patient'),
    plan = await planFor(admin);
  await page.goto(portal);
  await open(page, plan);
  await fillPatient(page, 'agreed', '');
  await review(page, patientSave);
  let first!: ProcedureDecisionCommand;
  await page.route(
    '**' + recordPath(plan),
    async (route) => {
      first = route.request().postDataJSON();
      return route.abort('connectionreset');
    },
    { times: 1 },
  );
  await button(page, patientSave).click();
  await expect(button(page, retry)).toBeEnabled();
  expect((await current(patient, plan)).agreements).toEqual([]);
  await button(page, 'Close for now').click();
  await page.getByRole('button', { name: resume, exact: true }).click();
  const recovered = await send(page, plan, retry, 201);
  expect(recovered.request().postDataJSON()).toEqual(first);
  const original: ProcedureDecisionResponse = await recovered.json();
  await expect(title(page, 'Decision recorded')).toBeVisible();
  await mobile(page, 'Done', info.outputPath('confirmation-320.png'));
  await button(page, 'Done').click();
  await open(page, plan, 'patient', true);
  await expect(field(page, 'Your decision')).toHaveValue('');
  await fillPatient(page, 'declined', 'I changed my decision.');
  await review(page, patientSave);
  const res = await send(page, plan, patientSave, 201);
  expect(res.request().postDataJSON()).toMatchObject({
    decision: 'declined',
    expectedLatestDecisionId: original.receipt.agreement.id,
  });
  expect(res.request().postDataJSON().requestId).not.toBe(first.requestId);
  const changed: ProcedureDecisionResponse = await res.json();
  await button(page, 'Done').click();
  await expect(card(page, plan)).toContainText('Latest recorded choice: Declined');
  await effects(admin, patient, plan, [original.receipt.agreement, changed.receipt.agreement]);
});

test('a cancelled procedure keeps a refused decision out of history and prevents re-review', async ({
  page,
  admin,
}) => {
  const patient = await login(page.request, 'patient'),
    plan = await planFor(admin);
  await page.goto(portal);
  await open(page, plan);
  const note = 'Synthetic draft for a cancelled procedure.';
  await fillPatient(page, 'agreed', note);
  await review(page, patientSave);
  await post(
    admin,
    path(plan) + '/cancel',
    { reason: 'Synthetic cancellation before patient submission.' },
    200,
  );
  await send(page, plan, patientSave, 409);
  await expect(title(page, 'Decision not recorded')).toBeVisible();
  await button(page, 'Refresh procedure').click();
  await expect(dialog(page)).toContainText(/cancelled/i);
  await expect(field(page, 'Note for your clinic')).toHaveCount(0);
  await expect(button(page, 'Review decision')).toHaveCount(0);
  await expect(button(page, patientSave)).toHaveCount(0);
  await expect(button(page, retry)).toHaveCount(0);
  await effects(admin, patient, plan, []);
});

test('unresolved decision notes and request identities clear on reload and sign-out', async ({
  page,
  admin,
}) => {
  const patient = await login(page.request, 'patient'),
    plan = await planFor(admin);
  const attempts: ProcedureDecisionCommand[] = [];
  await page.route('**' + recordPath(plan), (route) => {
    attempts.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
  });
  await page.goto(portal);
  for (const reset of ['reload', 'sign out']) {
    const note = 'Private synthetic draft ' + randomUUID();
    await open(page, plan);
    await fillPatient(page, 'declined', note);
    await review(page, patientSave);
    await send(page, plan, patientSave, 503);
    await expect(button(page, retry)).toBeEnabled();
    const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
    expect(storage).not.toContain(note);
    expect(storage).not.toContain(attempts.at(-1)!.requestId);
    await button(page, 'Close for now').click();
    await expect(page.getByRole('button', { name: resume, exact: true })).toBeVisible();
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL(/\/login|\/$/);
      await login(page.request, 'patient');
      await page.goto(portal);
    }
    await expect(card(page, plan)).toBeVisible();
    await expect(page.getByRole('button', { name: resume, exact: true })).toHaveCount(0);
    await open(page, plan);
    await expect(field(page, 'Note for your clinic')).toHaveValue('');
    await expect(field(page, 'Your decision')).toHaveValue('');
    await button(page, 'Decide later').click();
  }
  expect(attempts[0].requestId).not.toBe(attempts[1].requestId);
  await effects(admin, patient, plan, []);
});

test('a delayed reply for one procedure leaves another procedure’s reviewed decision and session intact', async ({
  page,
  admin,
}) => {
  const patient = await login(page.request, 'patient'),
    first = await planFor(admin),
    second = await planFor(admin);
  await page.goto(portal);
  await open(page, first);
  await fillPatient(page, 'declined', 'Choice for the first procedure.');
  await review(page, patientSave);
  const wrote = deferred(),
    deliver = deferred();
  let original!: ProcedureDecisionResponse;
  await page.route(
    '**' + recordPath(first),
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      original = await response.json();
      wrote.resolve();
      await deliver.promise;
      await route.fulfill({ status: 401, json: { error: 'Late reply for first procedure.' } });
    },
    { times: 1 },
  );
  await button(page, patientSave).click();
  await wrote.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === recordPath(first) && r.status() === 401,
  );
  try {
    await button(page, 'Close for now').click();
    await open(page, second);
    await fillPatient(page, 'agreed', 'Choice for the second procedure.');
    await review(page, patientSave);
  } finally {
    deliver.resolve();
  }
  await (await late).finished();
  const response = await send(page, second, patientSave, 201);
  const other: ProcedureDecisionResponse = await response.json();
  await expect(title(page, 'Decision recorded')).toBeVisible();
  await expect(dialog(page)).not.toContainText(original.receipt.agreement.note);
  await expect(dialog(page)).toContainText(other.receipt.agreement.note);
  await button(page, 'Done').click();
  await page.getByRole('button', { name: resume, exact: true }).click();
  await expect(dialog(page)).toContainText(original.receipt.agreement.note);
  await expect(dialog(page)).not.toContainText(other.receipt.agreement.note);
  expect(await (await send(page, first, retry, 200)).json()).toEqual(original);
  await expect(title(page, 'Decision recorded')).toBeVisible();
  await effects(admin, patient, first, [original.receipt.agreement]);
  await effects(admin, patient, second, [other.receipt.agreement]);
});
