import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { Investigation } from '../../shared/clinical';
import type {
  InvestigationHandoverCommand,
  InvestigationHandoverReceipt,
  InvestigationReviewContext,
} from '../../shared/investigation-worklist';
import {
  button,
  deferred,
  dialog,
  field,
  login,
  mobile,
  post,
  read,
  test,
  type Actor,
} from './workflow-fixtures';

const queue = '/clinic/investigations',
  owner = 'New investigation owner',
  note = 'Reason for handover',
  save = 'Save assignment',
  retry = 'Retry same request',
  refresh = 'Refresh assignment context';
const resume = (page: Page) =>
  page.getByRole('button', { name: 'Resume pending assignment', exact: true });
const root = (order: Investigation) => '/api/investigations/' + order.id;
const path = (order: Investigation) => root(order) + '/assignment';
const snapshot = (a: Actor, order: Investigation) =>
  read<InvestigationReviewContext>(a, root(order) + '/review-context');
let receiver: { id: string; name: string };
test.beforeAll(async ({ admin }) => {
  const suffix = randomUUID().slice(0, 8);
  receiver = await post(admin, '/api/doctors', {
    name: 'Dr. Handover ' + suffix,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 3,
    fee: 600,
    bio: 'Synthetic clinician.',
    languages: ['English'],
  });
  await post(admin, '/api/users', {
    name: receiver.name,
    email: 'handover-' + suffix + '@example.test',
    password: 'SyntheticClinician2026!',
    role: 'doctor',
    doctorId: receiver.id,
  });
});
async function investigation(admin: Actor, patient: Actor) {
  const order = await post<Investigation>(admin, '/api/investigations', {
    patientId: 'patient-ananya',
    title: 'Handover ' + randomUUID().slice(0, 8),
    kind: 'laboratory',
    reason: 'Synthetic investigation.',
    instructions: 'Submit the synthetic report.',
  });
  return post<Investigation>(patient, root(order) + '/results', {
    note: 'Initial synthetic result.',
  });
}
const row = (page: Page, o: Investigation) => page.locator('.iwq-row').filter({ hasText: o.title });
async function draft(page: Page, order: Investigation) {
  await row(page, order).getByRole('button', { name: 'Owner & history', exact: true }).click();
  await field(page, owner).selectOption(receiver.id);
  const reason = 'Private synthetic handover ' + randomUUID().slice(0, 8);
  await field(page, note).fill(reason);
  return reason;
}
async function directory(page: Page) {
  await page.getByRole('link', { name: 'Patients', exact: true }).first().click();
  await expect(page).toHaveURL(/\/clinic\/patients$/);
  await expect(page.getByRole('heading', { name: 'Patients', exact: true }).first()).toBeVisible();
}
async function responseTo(page: Page, o: Investigation, action: string, status: number) {
  const result = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path(o) && r.request().method() === 'POST',
  );
  await button(page, action).click();
  const reply = await result;
  expect(reply.status(), await reply.text()).toBe(status);
  return reply;
}
test('a delivered handover recovers its own event after reassignment and keeps the current owner and patient view accurate', async ({
  page,
  admin,
  patient,
}, info) => {
  const doctor = await login(page.request, 'doctor');
  const order = await investigation(admin, patient);
  await page.goto(queue);
  const reason = await draft(page, order);
  let command!: InvestigationHandoverCommand, receipt!: InvestigationHandoverReceipt;
  await page.route(
    '**' + path(order),
    async (r) => {
      command = r.request().postDataJSON();
      const res = await r.fetch();
      expect(res.status()).toBe(201);
      receipt = (await res.json()).receipt;
      await r.abort();
    },
    { times: 1 },
  );
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  expect(receipt.actorId).toBe(doctor.session.user!.id);
  await button(page, 'Close for now').click();
  await directory(page);
  const handed = await snapshot(admin, order);
  const live = await post<InvestigationReviewContext>(admin, path(order), {
    requestId: randomUUID(),
    expectedRevision: handed.revision,
    doctorId: order.doctorId,
    reason: 'Return the case to the original clinician.',
  });
  expect(live.assignments).toHaveLength(2);
  await page.goBack();
  await resume(page).click();
  await expect(field(page, note)).toHaveValue(reason);
  await expect(field(page, owner).locator('option:checked')).toHaveText(receiver.name);
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await page.route(
    '**' + path(order),
    async (r) => {
      const res = await r.fetch(),
        data = await res.json();
      data.receipt.requestId = randomUUID();
      await r.fulfill({ response: res, json: data });
    },
    { times: 1 },
  );
  await responseTo(page, order, retry, 200);
  await expect(button(page, retry)).toBeEnabled();
  const recovered = await responseTo(page, order, retry, 200);
  expect(recovered.request().postDataJSON()).toEqual(command);
  expect((await recovered.json()).receipt).toEqual(receipt);
  const confirmed = dialog(page).getByRole('region', { name: 'Confirmed handover' });
  await expect(confirmed).toContainText(receiver.name);
  await expect(confirmed).toContainText(reason);
  await expect(confirmed).toContainText(receipt.assignment.assignedByName);
  await expect(dialog(page).locator('.iwq-assignment-context dd').first()).toHaveText(
    live.ownerDoctorName,
  );
  expect((await snapshot(admin, order)).assignments).toEqual(live.assignments);
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=investigation&entityId=' + order.id,
  );
  expect(
    audit.items.filter((e) => e.action === 'assigned investigation responsibility'),
  ).toHaveLength(2);
  expect((await patient.api.get(root(order) + '/review-context')).status()).toBe(403);
  const patientRecord = await patient.api.get(
    '/api/patients/' + order.patientId + '/clinical-workflows',
  );
  expect(patientRecord.status()).toBe(200);
  expect(await patientRecord.text()).not.toContain(reason);
});
test('an undelivered draft returns from Patients with its original command and reopens for editing only after a matched stale refusal', async ({
  page,
  admin,
  patient,
}, info) => {
  await login(page.request, 'admin');
  const order = await investigation(admin, patient);
  await page.goto(queue);
  const reason = await draft(page, order);
  await button(page, 'Close for now').click();
  await directory(page);
  await page.goBack();
  await resume(page).click();
  await expect(field(page, note)).toHaveValue(reason);
  let command!: InvestigationHandoverCommand;
  await page.route(
    '**' + path(order),
    async (r) => {
      command = r.request().postDataJSON();
      await r.abort();
    },
    { times: 1 },
  );
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await button(page, 'Close for now').click();
  await directory(page);
  await post(patient, root(order) + '/results', { note: 'A later synthetic result.' });
  await page.goBack();
  await resume(page).click();
  await page.route(
    '**' + path(order),
    async (r) => {
      const res = await r.fetch(),
        data = await res.json();
      expect(data.command).toEqual(command);
      data.command.reason = 'A different refusal.';
      await r.fulfill({ response: res, json: data });
    },
    { times: 1 },
  );
  await responseTo(page, order, retry, 409);
  await expect(button(page, retry)).toBeEnabled();
  await expect(field(page, note)).toBeDisabled();
  const denied = await responseTo(page, order, retry, 409);
  expect((await denied.json()).command).toEqual(command);
  expect((await snapshot(admin, order)).assignments).toHaveLength(0);
  await mobile(page, refresh, info.outputPath('refusal-320.png'));
  await button(page, refresh).click();
  await button(page, 'I reviewed the latest context; keep my draft').click();
  await expect(field(page, note)).toHaveValue(reason);
  await expect(field(page, owner)).toHaveValue(receiver.id);
  const saved = await responseTo(page, order, save, 201);
  expect(saved.request().postDataJSON().requestId).not.toBe(command.requestId);
  expect((await snapshot(admin, order)).assignments).toHaveLength(1);
});
test('a late 401 from a departed handover leaves another investigation intact and the exact request stays recoverable', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'admin');
  const first = await investigation(admin, patient),
    second = await investigation(admin, patient);
  await page.goto(queue);
  const reason = await draft(page, first);
  const seen = deferred(),
    release = deferred(),
    done = deferred();
  let command!: InvestigationHandoverCommand;
  await page.route(
    '**' + path(first),
    async (r) => {
      command = r.request().postDataJSON();
      seen.resolve();
      await release.promise;
      try {
        await r.fulfill({ status: 401, json: { error: 'Late sign-in response.' } });
      } finally {
        done.resolve();
      }
    },
    { times: 1 },
  );
  await button(page, save).click();
  await seen.promise;
  try {
    await button(page, 'Close for now').click();
    await directory(page);
    await page.goBack();
    await row(page, second).getByRole('button', { name: 'Owner & history' }).click();
    await expect(dialog(page)).toContainText(second.title);
  } finally {
    release.resolve();
  }
  await done.promise;
  await expect(dialog(page)).toContainText(second.title);
  await expect(dialog(page)).not.toContainText(reason);
  await resume(page).click();
  const sent = await responseTo(page, first, retry, 201);
  expect(sent.request().postDataJSON()).toEqual(command);
  const after = await snapshot(admin, first);
  expect(after.assignments).toHaveLength(1);
  expect((await snapshot(admin, second)).assignments).toHaveLength(0);
  await expect(dialog(page).getByRole('region', { name: 'Confirmed handover' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).last().click();
  const seenRead = deferred(),
    releaseRead = deferred();
  const readPath = root(second) + '/review-context';
  await page.route(
    '**' + readPath,
    async (r) => {
      seenRead.resolve();
      await releaseRead.promise;
      await r.fulfill({ status: 401, json: { error: 'Late supporting read.' } });
    },
    { times: 1 },
  );
  await row(page, second).getByRole('button', { name: 'Owner & history' }).click();
  await seenRead.promise;
  const lateRead = page.waitForResponse(
    (r) => new URL(r.url()).pathname === readPath && r.status() === 401,
  );
  try {
    await page.keyboard.press('Escape');
    await directory(page);
  } finally {
    releaseRead.resolve();
  }
  await lateRead;
  await page.goBack();
  await expect(row(page, second)).toBeVisible();
  await row(page, second).getByRole('button', { name: 'Owner & history' }).click();
  await expect(dialog(page)).toContainText(second.title);
});
test('reloading and signing out discard an undelivered private handover and selecting a different account starts clean', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'admin');
  const order = await investigation(admin, patient);
  await page.goto(queue);
  const reason = await draft(page, order);
  await page.route('**' + path(order), (r) => r.abort(), { times: 2 });
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await page.reload();
  await expect(field(page, note)).toHaveValue('');
  await expect(field(page, owner)).toHaveValue('');
  await field(page, owner).selectOption(receiver.id);
  await field(page, note).fill(reason);
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await button(page, 'Close for now').click();
  await expect(resume(page)).toBeVisible();
  await page.getByTitle('Sign out', { exact: true }).click();
  await login(page.request, 'doctor');
  await page.goto(queue);
  await expect(row(page, order)).toBeVisible();
  await expect(resume(page)).toHaveCount(0);
  await row(page, order).getByRole('button', { name: 'Owner & history' }).click();
  await expect(field(page, note)).toHaveValue('');
  expect((await snapshot(admin, order)).assignments).toHaveLength(0);
});
