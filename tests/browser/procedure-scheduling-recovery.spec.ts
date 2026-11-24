import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { ProcedureRecord } from '../../shared/clinical';
import type { ActivityFeed } from '../../shared/activity';
import type {
  ProcedureScheduleContext,
  ProcedureScheduleMutation,
} from '../../shared/procedure-scheduling';
import {
  type Actor,
  button,
  card,
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
  post,
  read,
  test,
  title,
} from './procedure-fixtures';

const label = 'Reason for appointment link',
  retry = 'Retry same request',
  worklist = '/clinic/procedures';
const reason = 'Scheduling history for this synthetic appointment change.';
const apiPath = (plan: ProcedureRecord) => path(plan) + '/scheduling';
const resume = (page: Page, p: ProcedureRecord) =>
  page
    .locator('.decision-resume')
    .filter({ hasText: p.id })
    .getByRole('button', { name: 'Resume appointment change', exact: true });
async function openWorklist(page: Page, p: ProcedureRecord) {
  await page.goto(worklist + '?procedure=' + p.id);
  await expect(title(page, 'Procedure appointment')).toBeVisible();
}
async function select(page: Page, position = 0) {
  const radio = dialog(page).getByRole('radio').nth(position);
  await radio.check();
  return radio.getAttribute('aria-label');
}
async function change(page: Page, plan: ProcedureRecord, action: string, status = 200) {
  const reply = page.waitForResponse(
    (r) => new URL(r.url()).pathname === apiPath(plan) && r.request().method() === 'POST',
  );
  await button(page, action).click();
  const result = await reply;
  expect(result.status(), await result.text()).toBe(status);
  return result;
}
async function source(admin: Actor, p: ProcedureRecord) {
  return read<ProcedureScheduleContext>(admin, apiPath(p));
}
async function unlink(admin: Actor, p: ProcedureRecord, text: string) {
  const s = await source(admin, p);
  return post<ProcedureScheduleMutation>(
    admin,
    apiPath(p),
    {
      appointmentId: null,
      expectedAppointmentRevision: null,
      expectedRevision: s.revision,
      removeConfirmed: true,
      reason: text,
      requestId: randomUUID(),
    },
    200,
  );
}
async function gotoSpa(page: Page, url: string) {
  await page.evaluate((url) => {
    history.pushState({ key: crypto.randomUUID() }, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}
let earlierActivity: Set<string>;
test.beforeEach(async ({ patient }) => {
  const feed = await read<ActivityFeed>(patient, '/api/activity?limit=100');
  earlierActivity = new Set(feed.items.map((a) => a.id));
});
async function effects(
  admin: Actor,
  patient: Actor,
  plan: ProcedureRecord,
  operation: string,
  count: number,
) {
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=procedure&entityId=' + plan.id,
  );
  expect(audit.items.filter((a) => a.action === 'procedure appointment ' + operation)).toHaveLength(
    count,
  );
  const feed = await read<ActivityFeed>(patient, '/api/activity?limit=100');
  const notice =
    operation === 'unlink'
      ? 'A procedure appointment link was removed'
      : 'Your procedure plan has an appointment';
  expect(
    feed.items.filter((item) => item.title === notice && !earlierActivity.has(item.id)),
  ).toHaveLength(count);
}
test('reception recovers a saved link after a later unlink and cancellation, with private history and the live association shown separately', async ({
  page,
  admin,
  patient,
}, info) => {
  const desk = await login(page.request, 'reception'),
    plan = await planFor(admin);
  await openWorklist(page, plan);
  await select(page);
  await field(page, label).fill(reason);
  const commands: unknown[] = [];
  let saved!: ProcedureScheduleMutation;
  await page.route('**' + apiPath(plan), async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    const n = commands.push(r.request().postDataJSON());
    const response = await r.fetch();
    expect(response.status()).toBe(200);
    const result: ProcedureScheduleMutation = await response.json();
    if (n === 1) {
      saved = result;
      return r.abort('connectionreset');
    }
    if (n === 2) result.event.createdByRole = 'doctor';
    return r.fulfill({ response, json: result });
  });
  await button(page, 'Link appointment').click();
  await expect(button(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  await unlink(admin, plan, 'Subsequent synthetic unlink.');
  await post(
    admin,
    path(plan) + '/cancel',
    { reason: 'Plan closed after the visit changed.' },
    200,
  );
  await gotoSpa(page, '/clinic/appointments');
  await page.goBack();
  await resume(page, plan).click();
  await expect(field(page, label)).toHaveValue(reason);
  await change(page, plan, retry);
  await expect(button(page, retry)).toBeEnabled();
  await change(page, plan, retry);
  expect(commands).toEqual([commands[0], commands[0], commands[0]]);
  expect(saved.event.createdById).toBe(desk.session.user!.id);
  const original = dialog(page).getByRole('region', { name: 'Original appointment change' });
  await expect(original).toContainText(reason);
  const historical = saved.event.afterAppointment!;
  const start = Date.parse(historical.date + 'T' + historical.time + ':00+05:30');
  const clock = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
  await expect(original).toContainText(
    clock.format(start) + '–' + clock.format(start + historical.durationMinutes * 60000) + ' IST',
  );
  await expect(dialog(page).locator('.procedure-link-current')).toContainText(
    'No appointment is currently linked',
  );
  await expect(dialog(page).locator('.procedure-link-plan')).toContainText('Cancelled');
  await expect(
    dialog(page).getByRole('button', { name: 'Link appointment', exact: true }),
  ).toHaveCount(0);
  expect((await source(admin, plan)).history).toHaveLength(2);
  expect(JSON.stringify(await current(patient, plan))).not.toContain(reason);
  expect((await patient.api.get(apiPath(plan))).status()).toBe(403);
  expect((await desk.api.get('/api/patients/' + patientId + '/clinical-workflows')).status()).toBe(
    403,
  );
  await effects(admin, patient, plan, 'attach', 1);
  await effects(admin, patient, plan, 'unlink', 1);
});

test('a clinic chart submission that never arrived resumes on the worklist and can re-review after a verified refusal', async ({
  page,
  admin,
  patient,
}, info) => {
  await login(page.request, 'doctor');
  const plan = await planFor(admin);
  await page.goto(clinic);
  await card(page, plan, 'doctor').getByRole('button', { name: 'Manage appointment' }).click();
  await select(page);
  await field(page, label).fill(reason);
  let submitted!: Record<string, unknown>;
  await page.route(
    '**' + apiPath(plan),
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted = route.request().postDataJSON();
      return route.abort('connectionreset');
    },
    { times: 1 },
  );
  await button(page, 'Link appointment').click();
  await expect(button(page, retry)).toBeEnabled();
  await button(page, 'Close for now').click();
  await gotoSpa(page, worklist);
  await resume(page, plan).click();
  const concurrent: Record<string, unknown> = {
    ...submitted,
    requestId: randomUUID(),
    reason: 'Private concurrent scheduling.',
  };
  delete concurrent.recoverable;
  await post(admin, apiPath(plan), concurrent, 200);
  await page.route(
    '**' + apiPath(plan),
    async (r) => {
      const response = await r.fetch();
      const data = await response.json();
      data.actorId = 'other-actor';
      await r.fulfill({ response, json: data });
    },
    { times: 1 },
  );
  await change(page, plan, retry, 409);
  await expect(button(page, retry)).toBeEnabled();
  await expect(button(page, 'Refresh latest scheduling')).toHaveCount(0);
  const denied = await change(page, plan, retry, 409);
  expect((await denied.json()).command).toEqual(submitted);
  await mobile(page, 'Refresh latest scheduling', info.outputPath('refusal-320.png'));
  await button(page, 'Refresh latest scheduling').click();
  await expect(dialog(page)).toContainText('Private concurrent scheduling.');
  await button(page, 'I reviewed the latest scheduling; keep my draft').click();
  await expect(field(page, label)).toHaveValue(reason);
  await button(page, 'Remove current link').click();
  await dialog(page).getByRole('checkbox').check();
  const res = await change(page, plan, 'Remove link', 200);
  expect(res.request().postDataJSON().requestId).not.toBe(submitted.requestId);
  expect((await current(patient, plan)).effectiveAppointmentId).toBeNull();
  await effects(admin, patient, plan, 'unlink', 1);
});

test('a late unauthorized response cannot reset the next procedure or its session, and the original change can still be delivered', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'admin');
  const first = await planFor(admin),
    second = await planFor(admin);
  await openWorklist(page, first);
  await select(page);
  await field(page, label).fill(reason);
  const seen = deferred(),
    release = deferred();
  let command!: Record<string, unknown>;
  await page.route(
    '**' + apiPath(first),
    async (r) => {
      command = r.request().postDataJSON();
      seen.resolve();
      await release.promise;
      await r.fulfill({ status: 401, json: { error: 'Late reply for previous request.' } });
    },
    { times: 1 },
  );
  await button(page, 'Link appointment').click();
  await seen.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === apiPath(first) && r.status() === 401,
  );
  try {
    await button(page, 'Close for now').click();
    await gotoSpa(page, clinic);
    await card(page, second, 'doctor').getByRole('button', { name: 'Manage appointment' }).click();
    await field(page, label).fill('Draft for a different plan.');
  } finally {
    release.resolve();
  }
  await (await late).finished();
  await expect(field(page, label)).toHaveValue('Draft for a different plan.');
  await button(page, 'Close').click();
  await resume(page, first).click();
  expect((await change(page, first, retry)).request().postDataJSON()).toEqual(command);
  await expect(
    dialog(page).getByRole('region', { name: 'Original appointment change' }),
  ).toContainText(reason);
  expect((await current(patient, second)).effectiveAppointmentId).toBeNull();
  await effects(admin, patient, first, 'attach', 1);
});

test('reloading discards an undelivered private scheduling request and a new sign-in sees no pending reason', async ({
  page,
  admin,
  patient,
}) => {
  await login(page.request, 'reception');
  const plan = await planFor(admin);
  await openWorklist(page, plan);
  await select(page);
  await field(page, label).fill(reason);
  await page.route('**' + apiPath(plan), (r) => r.abort(), { times: 1 });
  await button(page, 'Link appointment').click();
  await expect(button(page, retry)).toBeEnabled();
  await button(page, 'Close for now').click();
  await expect(resume(page, plan)).toBeVisible();
  await page.reload();
  await expect(resume(page, plan)).toHaveCount(0);
  await openWorklist(page, plan);
  await expect(field(page, label)).toHaveValue('');
  await select(page);
  await field(page, label).fill(reason);
  await page.route('**' + apiPath(plan), (r) => r.abort(), { times: 1 });
  await button(page, 'Link appointment').click();
  await expect(button(page, retry)).toBeEnabled();
  await button(page, 'Close for now').click();
  await page.getByTitle('Sign out', { exact: true }).click();
  await login(page.request, 'doctor');
  await page.goto(worklist);
  await expect(resume(page, plan)).toHaveCount(0);
  await effects(admin, patient, plan, 'attach', 0);
});
