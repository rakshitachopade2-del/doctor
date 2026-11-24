import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { Investigation, PatientClinicalWorkflows } from '../../shared/clinical';
import type {
  InvestigationReviewCommand,
  InvestigationReviewReceipt,
} from '../../shared/investigation-review-recording';
import type { ActivityFeed } from '../../shared/activity';
import {
  test,
  login,
  read,
  post,
  button,
  dialog,
  field,
  checkbox,
  deferred,
  mobile,
  type Actor,
} from './workflow-fixtures';

const patientId = 'patient-ananya',
  queue = '/clinic/investigations',
  chart = '/clinic/patients/' + patientId + '?tab=workup';
const save = 'Save clinical review',
  retry = 'Retry same request',
  refresh = 'Refresh latest investigation',
  accept = 'I reviewed the latest record; keep my draft';
const routeFor = (order: Investigation) => '/api/investigations/' + order.id + '/reviews';
const resume = (page: Page, order: Investigation) =>
  page.getByRole('button', { name: 'Resume clinical review: ' + order.title, exact: true });
const row = (page: Page, order: Investigation) =>
  page.locator('.iwq-row').filter({ hasText: order.title });
async function source(admin: Actor, patient: Actor) {
  const order = await post<Investigation>(admin, '/api/investigations', {
    patientId,
    title: 'Synthetic review ' + randomUUID().slice(0, 8),
    kind: 'other',
    reason: 'Synthetic order.',
    instructions: 'Synthetic material.',
  });
  return post<Investigation>(patient, '/api/investigations/' + order.id + '/results', {
    note: 'Original synthetic report.',
  });
}
async function chartReview(page: Page, order: Investigation) {
  const section = page.locator('#investigation-' + order.id);
  await section.getByRole('button', { name: 'Review this result', exact: true }).last().click();
}
async function draft(page: Page, share = false) {
  const findings = 'Synthetic findings ' + randomUUID().slice(0, 8),
    next = 'Synthetic follow-up ' + randomUUID().slice(0, 8);
  await field(page, 'Reviewed findings').fill(findings);
  await field(page, 'Follow-up and next steps').fill(next);
  if (share) await checkbox(page).check();
  return { findings, next };
}
async function send(page: Page, order: Investigation, label: string, status: number) {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === routeFor(order) && r.request().method() === 'POST',
  );
  await button(page, label).click();
  const reply = await response;
  expect(reply.status(), await reply.text()).toBe(status);
  return reply;
}
async function patientOrder(patient: Actor, order: Investigation) {
  return (
    await read<PatientClinicalWorkflows>(
      patient,
      '/api/patients/' + patientId + '/clinical-workflows',
    )
  ).investigations.find((q) => q.id === order.id)!;
}
async function checkEffects(admin: Actor, patient: Actor, order: Investigation, notices: number) {
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=investigation&entityId=' + order.id,
  );
  expect(audit.items.filter((r) => r.action === 'reviewed investigation result')).toHaveLength(1);
  const events = await read<ActivityFeed>(patient, '/api/activity?limit=100');
  expect(
    events.items.filter(
      (item) =>
        item.detail === order.title && item.title === 'Your clinician shared a report review',
    ),
  ).toHaveLength(notices);
}
test('a private interpretation lost from the queue recovers through the patient chart after publication, a supplement and cancellation', async ({
  page,
  admin,
  patient,
}, info) => {
  await login(page.request, 'doctor');
  const order = await source(admin, patient),
    path = routeFor(order);
  await page.goto(chart);
  await page.getByRole('link', { name: 'Investigation review queue' }).click();
  await row(page, order).getByRole('button', { name: 'Review latest result' }).click();
  const typed = await draft(page);
  let receipt!: InvestigationReviewReceipt, command!: InvestigationReviewCommand;
  await page.route('**' + path, async (route) => {
    command = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    receipt = (await response.json()).receipt;
    await route.abort();
  });
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  expect((await patientOrder(patient, order)).reviews).toEqual([]);
  expect(receipt.review.publishedAt).toBeNull();
  expect(receipt.review.summary).toBe(typed.findings);
  const live = await post<Investigation>(
    admin,
    path + '/' + receipt.review.id + '/publish',
    {},
    200,
  );
  await post(patient, '/api/investigations/' + order.id + '/results', {
    note: 'Additional synthetic report.',
  });
  await post(
    admin,
    '/api/investigations/' + order.id + '/cancel',
    { reason: 'Additional arrangements.' },
    200,
  );
  await page.goBack();
  await expect(page).toHaveURL(chart);
  await expect(resume(page, order)).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(queue);
  await expect(row(page, order)).toHaveCount(0);
  await expect(resume(page, order)).toBeVisible();
  await page.goBack();
  await resume(page, order).click();
  await expect(field(page, 'Reviewed findings')).toHaveValue(typed.findings);
  await expect(field(page, 'Follow-up and next steps')).toHaveValue(typed.next);
  await page.unroute('**' + path);
  await page.route('**' + path, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.receipt.review.publishedAt = live.reviews[0].publishedAt;
    await route.fulfill({ response, json: data });
  });
  await send(page, order, retry, 200);
  await expect(button(page, retry)).toBeEnabled();
  await expect(field(page, 'Reviewed findings')).toBeDisabled();
  await page.unroute('**' + path);
  const replay = await send(page, order, retry, 200);
  expect(replay.request().postDataJSON()).toEqual(command);
  expect((await replay.json()).receipt).toEqual(receipt);
  await expect(dialog(page)).toBeHidden();
  await expect(resume(page, order)).toHaveCount(0);
  const visible = await patientOrder(patient, order);
  expect(visible.reviews).toEqual(live.reviews);
  expect(visible.results).toHaveLength(2);
  expect(visible.status).toBe('cancelled');
  await checkEffects(admin, patient, order, 1);
});

test('an undelivered chart review receiving a late 401 leaves a different queue dialog intact and can be recorded once from the queue', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const order = await source(admin, patient),
    other = await source(admin, patient),
    path = routeFor(order);
  await page.goto(queue);
  await row(page, order).locator('a.iwq-record-link').click();
  await chartReview(page, order);
  const typed = await draft(page, true);
  const arrived = deferred(),
    release = deferred(),
    done = deferred();
  let command!: InvestigationReviewCommand;
  await page.route('**' + path, async (route) => {
    command = route.request().postDataJSON();
    arrived.resolve();
    await release.promise;
    try {
      await route.fulfill({ status: 401, json: { error: 'Synthetic expired session.' } });
    } finally {
      done.resolve();
    }
  });
  await button(page, save).click();
  await arrived.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL(queue);
    await row(page, other).getByRole('button', { name: 'Review latest result' }).click();
    await field(page, 'Reviewed findings').fill('Separate live draft.');
  } finally {
    release.resolve();
  }
  await done.promise;
  await expect(field(page, 'Reviewed findings')).toHaveValue('Separate live draft.');
  await button(page, 'Cancel review').click();
  await page.unroute('**' + path);
  await resume(page, order).click();
  await expect(checkbox(page)).toBeChecked();
  const res = await send(page, order, retry, 201);
  expect(res.request().postDataJSON()).toEqual(command);
  const r: InvestigationReviewReceipt = (await res.json()).receipt;
  expect(r.review.publishedAt).toBeTruthy();
  expect(r.review.summary).toBe(typed.findings);
  await expect(dialog(page)).toBeHidden();
  await checkEffects(admin, patient, order, 1);
  expect((await patientOrder(patient, order)).reviews).toEqual([r.review]);
  expect((await patientOrder(patient, other)).reviews).toEqual([]);
});

test('only the matching retained refusal unlocks a fresh review of a supplemental report and sharing requires another choice', async ({
  page,
  admin,
  patient,
}, info) => {
  await login(page.request, 'doctor');
  const order = await source(admin, patient),
    path = routeFor(order);
  await page.goto(chart);
  await chartReview(page, order);
  const typed = await draft(page, true);
  const replacement = await post<Investigation>(
    patient,
    '/api/investigations/' + order.id + '/results',
    { note: 'Synthetic replacement source.' },
  );
  let cmd!: InvestigationReviewCommand;
  await page.route('**' + path, async (route) => {
    cmd = route.request().postDataJSON();
    const r = await route.fetch();
    expect(r.status()).toBe(409);
    const d = await r.json();
    expect(d.code).toBe('INVESTIGATION_REVIEW_NOT_RECORDED');
    d.command.resultId = replacement.results.at(-1)!.id;
    await route.fulfill({ response: r, json: d });
  });
  await send(page, order, save, 409);
  await expect(button(page, retry)).toBeEnabled();
  await expect(field(page, 'Reviewed findings')).toBeDisabled();
  await page.unroute('**' + path);
  await page.route('**' + path, (route) =>
    route.fulfill({ status: 409, json: { error: 'Unattributed conflict.' } }),
  );
  await send(page, order, retry, 409);
  await expect(button(page, retry)).toBeEnabled();
  await expect(button(page, refresh)).toHaveCount(0);
  await page.unroute('**' + path);
  const refused = await send(page, order, retry, 409);
  const stored = await refused.json();
  expect(stored.command).toEqual(cmd);
  await expect(checkbox(page)).not.toBeChecked();
  await expect(field(page, 'Reviewed findings')).toHaveValue(typed.findings);
  await mobile(page, refresh, info.outputPath('refresh-320.png'));
  await button(page, refresh).click();
  await expect(dialog(page)).toContainText('Synthetic replacement source.');
  await button(page, accept).click();
  await expect(checkbox(page)).not.toBeChecked();
  const accepted = await send(page, order, save, 201);
  const next = accepted.request().postDataJSON();
  expect(next.requestId).not.toBe(cmd.requestId);
  expect(next.resultId).toBe(replacement.results.at(-1)!.id);
  expect(next.publishToPatient).toBe(false);
  expect(next.summary).toBe(typed.findings);
  await expect(dialog(page)).toBeHidden();
  expect((await patientOrder(patient, order)).reviews).toEqual([]);
  await checkEffects(admin, patient, order, 0);
});

test('unresolved private review drafts are isolated to the current signed-in tab and cleared by reload or sign-out', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'doctor');
  const order = await source(admin, patient),
    path = routeFor(order);
  await page.goto(chart);
  await page.route('**' + path, (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic unavailable response.' } }),
  );
  for (const reset of ['reload', 'sign out']) {
    await chartReview(page, order);
    const v = await draft(page);
    const r = await send(page, order, save, 503);
    await expect(button(page, retry)).toBeEnabled();
    await button(page, 'Close for now').click();
    await expect(resume(page, order)).toBeVisible();
    const stored = await page.evaluate(() =>
      JSON.stringify([
        location.href,
        history.state,
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    );
    expect(stored).not.toContain(v.findings);
    expect(stored).not.toContain(r.request().postDataJSON().requestId);
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL('/login');
      await login(page.request, 'doctor');
      await page.goto(chart);
    }
    await chartReview(page, order);
    await expect(field(page, 'Reviewed findings')).toHaveValue('');
    await button(page, 'Cancel review').click();
    await expect(resume(page, order)).toHaveCount(0);
  }
});
