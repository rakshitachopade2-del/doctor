import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { ProcedureRecord } from '../../shared/clinical';
import type { ActivityFeed } from '../../shared/activity';
import type {
  ProcedureCancellationCommand,
  ProcedureCancellationContext,
  ProcedureCancellationResponse,
} from '../../shared/procedure-cancellation';
import type { Appointment } from '../../shared/types';
import type { ProcedureScheduleContext } from '../../shared/procedure-scheduling';
import {
  type Actor,
  button,
  card,
  checkbox,
  clinic,
  current,
  deferred,
  dialog,
  field,
  login,
  mobile,
  path,
  patientId,
  planFor,
  portal,
  post,
  read,
  test,
  title,
} from './procedure-fixtures';

const save = 'Confirm cancellation',
  retry = 'Retry exact cancellation',
  refresh = 'Refresh procedure';
const label = 'Reason for cancellation';
const reason = 'The clinic and patient agreed to cancel this synthetic plan.';
const endpoint = (plan: ProcedureRecord) => path(plan) + '/cancellation';
const sourcePath = (plan: ProcedureRecord) => path(plan) + '/cancellation-context';
const resume = (page: Page, plan: ProcedureRecord) =>
  page
    .locator('.decision-resume')
    .filter({ hasText: plan.id })
    .getByRole('button', { name: 'Resume procedure cancellation', exact: true });
async function open(page: Page, plan: ProcedureRecord) {
  await card(page, plan, 'doctor')
    .getByRole('button', { name: 'Cancel procedure', exact: true })
    .click();
  await expect(title(page, 'Cancel procedure')).toBeVisible();
}
async function review(page: Page, text = reason) {
  await field(page, label).fill(text);
  await button(page, 'Review cancellation').click();
  await expect(title(page, 'Review procedure cancellation')).toBeVisible();
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}
async function send(page: Page, plan: ProcedureRecord, action: string, status: number) {
  const reply = page.waitForResponse(
    (r) => new URL(r.url()).pathname === endpoint(plan) && r.request().method() === 'POST',
  );
  await button(page, action).click();
  const response = await reply;
  expect(response.status(), await response.text()).toBe(status);
  return response;
}
async function choice(patient: Actor, plan: ProcedureRecord, decision: 'agreed' | 'declined') {
  return post<ProcedureRecord>(patient, path(plan) + '/agreements', {
    decision,
    method: 'portal',
    note: 'Synthetic ' + decision + ' decision.',
  });
}
async function visit(admin: Actor, tag: string) {
  const result = (await read<Appointment[]>(admin, '/api/appointments')).find(
    (v) => v.patientId === patientId && v.reason === 'E2E state ' + tag,
  );
  expect(result).toBeTruthy();
  return result!;
}
async function effects(admin: Actor, patient: Actor, plan: ProcedureRecord, count: number) {
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=procedure&entityId=' + plan.id,
  );
  expect(audit.items.filter((row) => row.action === 'cancelled procedure')).toHaveLength(count);
  const feed = await read<ActivityFeed>(patient, '/api/activity?limit=100');
  const notices = feed.items.filter(
    (row) => row.title === 'A procedure plan was cancelled' && row.detail === plan.title,
  );
  expect(notices).toHaveLength(count);
  if (count) expect(notices[0].href).toBe('/my-care/record?tab=workflows');
}

test('lost cancellation recovers the reason, clinician, decision and original visit while the patient retains the invoice and visit', async ({
  page,
  admin,
  patient,
  browser,
}, info) => {
  const doctor = await login(page.request, 'doctor'),
    linked = await visit(admin, 'already-started');
  const plan = await choice(patient, await planFor(admin, linked.id), 'agreed');
  const ctx = await read<ProcedureCancellationContext>(doctor, sourcePath(plan));
  const invoice = await post<{ id: string }>(admin, '/api/invoices', {
    patientId,
    procedureId: plan.id,
    requestId: randomUUID(),
    items: [{ description: 'Synthetic charge', quantity: 1, unitAmountPaise: 10000 }],
  });
  const invoiceDetail = await read(patient, '/api/invoices/' + invoice.id);
  await page.goto(clinic);
  await open(page, plan);
  await review(page, ' ' + reason + ' ');
  for (const value of [
    plan.title,
    ctx.doctorName,
    plan.agreements[0].note,
    linked.doctorName,
    reason,
  ])
    await expect(dialog(page)).toContainText(value);
  await mobile(page, save, info.outputPath('review-320.png'));
  const commands: ProcedureCancellationCommand[] = [];
  let original!: ProcedureCancellationResponse;
  await page.route('**' + endpoint(plan), async (route) => {
    const n = commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(n === 1 ? 201 : 200);
    const result: ProcedureCancellationResponse = await response.json();
    if (n === 1) {
      original = result;
      return route.abort('connectionreset');
    }
    if (n === 2) result.receipt.expectedDecisionId = randomUUID();
    if (n === 3) result.receipt.appointment = null;
    if (n === 4) result.receipt.reason = 'Different reason';
    if (n === 5) result.receipt.doctorName = 'Different clinician';
    return route.fulfill({ response, json: result });
  });
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  expect(await current(patient, plan)).toMatchObject({
    status: 'cancelled',
    cancellationReason: reason,
    agreements: plan.agreements,
    scheduledAppointment: plan.scheduledAppointment,
  });
  expect(await read(patient, '/api/invoices/' + invoice.id)).toEqual(invoiceDetail);
  const updated = await admin.api.patch('/api/appointments/' + linked.id, {
    headers: { 'X-CSRF-Token': admin.session.csrfToken! },
    data: { status: 'completed' },
  });
  expect(updated.status(), await updated.text()).toBe(200);
  await resume(page, plan).click();
  for (let i = 0; i < 4; i++) {
    await send(page, plan, retry, 200);
    await expect(button(page, retry)).toBeEnabled();
    await expect(title(page, 'Procedure cancelled')).toHaveCount(0);
  }
  expect(await (await send(page, plan, retry, 200)).json()).toEqual(original);
  for (const command of commands)
    expect(command).toEqual({
      ...commands[0],
      expectedDecisionId: plan.agreements[0].id,
      expectedRevision: ctx.revision,
      reason,
    });
  expect(original.receipt).toMatchObject({
    procedureId: plan.id,
    title: plan.title,
    actorId: doctor.session.user!.id,
    doctorId: ctx.doctorId,
    appointment: plan.scheduledAppointment,
    reason,
  });
  await expect(title(page, 'Procedure cancelled')).toBeVisible();
  await expect(dialog(page)).toContainText(
    'Appointment status: ' + linked.status.replaceAll('-', ' '),
  );
  expect(
    await dialog(page)
      .locator('time[datetime="' + original.receipt.cancelledAt + '"]')
      .count(),
  ).toBe(1);
  await mobile(page, 'Done', info.outputPath('saved-320.png'));
  await button(page, 'Done').click();
  await effects(admin, patient, plan, 1);
  const portalPage = await browser.newPage({ baseURL: info.project.use.baseURL });
  try {
    await login(portalPage.request, 'patient');
    await portalPage.goto(portal);
    await expect(card(portalPage, plan)).toContainText(reason);
    await expect(card(portalPage, plan)).toContainText(plan.agreements[0].note);
    await expect(
      card(portalPage, plan).getByRole('button', { name: 'Cancel procedure' }),
    ).toHaveCount(0);
  } finally {
    await portalPage.close();
  }
});

test('withdrawn agreement requires a verified refusal, the latest decision and fresh review', async ({
  page,
  admin,
  patient,
}, info) => {
  const doctor = await login(page.request, 'doctor'),
    plan = await choice(patient, await planFor(admin), 'agreed');
  const old = await read<ProcedureCancellationContext>(doctor, sourcePath(plan));
  await page.goto(clinic);
  await open(page, plan);
  await review(page);
  const latest = await choice(patient, plan, 'declined');
  await page.route(
    '**' + endpoint(plan),
    async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.command.expectedDecisionId = 'different';
      await route.fulfill({ response, json: data });
    },
    { times: 1 },
  );
  const stale = await send(page, plan, save, 409);
  await expect(button(page, retry)).toBeEnabled();
  await expect(button(page, refresh)).toHaveCount(0);
  await send(page, plan, retry, 409);
  await expect(title(page, 'Procedure not cancelled')).toBeVisible();
  await mobile(page, refresh, info.outputPath('refused-320.png'));
  await page.route('**' + sourcePath(plan), (r) => r.fulfill({ json: old }), { times: 1 });
  await button(page, refresh).click();
  await expect(dialog(page)).toContainText('The updated decision and visit could not be verified.');
  await expect(button(page, 'Review cancellation')).toHaveCount(0);
  await dialog(page)
    .getByRole('button', { name: /try again/i })
    .click();
  await expect(field(page, label)).toHaveValue(reason);
  await expect(dialog(page)).toContainText(latest.agreements.at(-1)!.note);
  await review(page);
  const fresh = await send(page, plan, save, 201);
  expect(fresh.request().postDataJSON().requestId).not.toBe(
    stale.request().postDataJSON().requestId,
  );
  expect(fresh.request().postDataJSON().expectedDecisionId).toBe(latest.agreements.at(-1)!.id);
  expect((await current(patient, plan)).agreements).toEqual(latest.agreements);
  await effects(admin, patient, plan, 1);
});

test('unlinking a future visit after review preserves the appointment and requires fresh cancellation without it', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const linked = await visit(admin, 'future'),
    plan = await planFor(admin, linked.id);
  await page.goto(clinic);
  await open(page, plan);
  await review(page);
  await expect(dialog(page)).toContainText('No patient decision has been recorded.');
  const url = path(plan) + '/scheduling',
    src = await read<ProcedureScheduleContext>(admin, url);
  await post(
    admin,
    url,
    {
      requestId: randomUUID(),
      expectedRevision: src.revision,
      expectedAppointmentRevision: null,
      appointmentId: null,
      removeConfirmed: true,
      reason: 'New visit arrangement.',
    },
    200,
  );
  await send(page, plan, save, 409);
  await button(page, refresh).click();
  await expect(dialog(page)).toContainText('No appointment is currently linked');
  await review(page);
  const result: ProcedureCancellationResponse = await (await send(page, plan, save, 201)).json();
  expect(result.receipt.appointment).toBeNull();
  expect(result.receipt.expectedDecisionId).toBeNull();
  expect(
    (await read<Appointment[]>(admin, '/api/appointments')).find((a) => a.id === linked.id),
  ).toEqual(linked);
  await effects(admin, patient, plan, 1);
});

test('another clinician completing or cancelling the plan closes the form and preserves the actual outcome', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  for (const completed of [true, false]) {
    const plan = await choice(patient, await planFor(admin), 'agreed');
    await page.goto(clinic);
    await open(page, plan);
    await review(page);
    const original = completed ? 'Original completion' : 'Other cancellation';
    await post(
      admin,
      path(plan) + (completed ? '/complete' : '/cancel'),
      completed ? { outcome: original, aftercare: 'Recorded aftercare.' } : { reason: original },
      200,
    );
    await send(page, plan, save, 409);
    await button(page, refresh).click();
    await expect(title(page, 'Current procedure')).toBeVisible();
    await expect(dialog(page)).toContainText(original);
    await expect(button(page, 'Review cancellation')).toHaveCount(0);
    expect((await current(patient, plan)).status).toBe(completed ? 'completed' : 'cancelled');
    await effects(admin, patient, plan, completed ? 0 : 1);
  }
});

test('an undelivered cancellation resumes after navigating away and a late 401 leaves the second form intact', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const first = await planFor(admin),
    second = await planFor(admin);
  const sent = deferred(),
    release = deferred();
  let command!: ProcedureCancellationCommand;
  await page.route(
    '**' + endpoint(first),
    async (r) => {
      command = r.request().postDataJSON();
      sent.resolve();
      await release.promise;
      await r.fulfill({ status: 401, json: { error: 'Earlier synthetic reply.' } });
    },
    { times: 1 },
  );
  await page.goto(clinic);
  await open(page, first);
  await review(page);
  await button(page, save).click();
  await sent.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === endpoint(first) && r.status() === 401,
  );
  try {
    await button(page, 'Close for now').click();
    await page.evaluate(() => {
      history.pushState({ key: crypto.randomUUID() }, '', '/clinic/patients/patient-2?tab=workup');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(resume(page, first)).toHaveCount(0);
    await page.goBack();
    await open(page, second);
    await field(page, label).fill('Other plan draft');
  } finally {
    release.resolve();
  }
  await (await late).finished();
  await expect(field(page, label)).toHaveValue('Other plan draft');
  await button(page, 'Close').click();
  await resume(page, first).click();
  const saved = await send(page, first, retry, 201);
  expect(saved.request().postDataJSON()).toEqual(command);
  await effects(admin, patient, first, 1);
  expect((await current(patient, second)).status).toBe('planned');
});

test('a page reload clears the pending cancellation and leaves an undelivered plan open', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const plan = await planFor(admin);
  await page.route('**' + endpoint(plan), (r) => r.abort(), { times: 1 });
  await page.goto(clinic);
  await open(page, plan);
  await review(page);
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await button(page, 'Close for now').click();
  await expect(resume(page, plan)).toBeVisible();
  await page.reload();
  await expect(resume(page, plan)).toHaveCount(0);
  await open(page, plan);
  await expect(field(page, label)).toHaveValue('');
  await effects(admin, patient, plan, 0);
});
