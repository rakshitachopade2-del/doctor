import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { ActivityFeed } from '../../shared/activity';
import type { Investigation, PatientClinicalWorkflows } from '../../shared/clinical';
import type {
  InvestigationOrderCommand,
  InvestigationOrderResponse,
} from '../../shared/investigation-order';
import type { Doctor } from '../../shared/types';
import {
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
  type Actor,
} from './workflow-fixtures';

const patientId = 'patient-ananya';
const chart = (id = patientId) => '/clinic/patients/' + id + '?tab=workup';
const path = '/api/investigations/order';
const orderButton = 'Order investigation',
  save = 'Save investigation order',
  resume = 'Resume investigation order';
const retry = 'Retry exact order',
  savedTitle = 'Investigation ordered';
const launch = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const details = () => ({
  title: 'Synthetic request ' + randomUUID().slice(0, 8),
  kind: 'other' as const,
  reason: 'Synthetic documentation check.',
  instructions: 'Use the synthetic patient portal fixture.',
  dueDate: null as string | null,
});
type Draft = ReturnType<typeof details>;

async function enter(page: Page, role: 'admin' | 'doctor' = 'doctor') {
  const who = await login(page.request, role);
  await page.goto(chart());
  return who;
}
async function draft(page: Page, fields: Draft) {
  await launch(page, orderButton).click();
  await field(page, 'Investigation name').fill(' ' + fields.title + ' ');
  await field(page, 'Investigation type').selectOption(fields.kind);
  await field(page, 'Clinical question / reason').fill(fields.reason);
  await field(page, 'Instructions for the patient').fill(fields.instructions);
  if (fields.dueDate) await dialog(page).locator('input[type=date]').fill(fields.dueDate);
}
async function review(page: Page) {
  await button(page, 'Review order').click();
  await expect(title(page, 'Review investigation order')).toBeVisible();
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}
async function send(page: Page, label: string, status: number) {
  const reply = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
  );
  await button(page, label).click();
  const response = await reply;
  expect(response.status(), await response.text()).toBe(status);
  return response;
}
async function matches(who: Actor, name: string, id = patientId) {
  const data = await read<PatientClinicalWorkflows>(
    who,
    '/api/patients/' + id + '/clinical-workflows',
  );
  return data.investigations.filter((order) => order.title === name);
}
async function checkEffects(admin: Actor, patient: Actor, name: string, ids: string[]) {
  expect((await matches(patient, name)).map((order) => order.id).sort()).toEqual([...ids].sort());
  const feed = await read<ActivityFeed>(patient, '/api/activity?limit=100');
  const notices = feed.items.filter(
    (item) => item.title === 'Your clinician requested an investigation' && item.detail === name,
  );
  expect(notices).toHaveLength(ids.length);
  expect(new Set(notices.map((item) => item.id)).size).toBe(ids.length);
  for (const id of ids) {
    const audit = await read<{ items: { action: string }[] }>(
      admin,
      '/api/search/audit?entityType=investigation&entityId=' + id,
    );
    expect(audit.items.filter((item) => item.action === 'ordered investigation')).toHaveLength(1);
  }
}
async function navigate(page: Page, id: string) {
  await page.evaluate((url) => {
    history.pushState({ key: crypto.randomUUID() }, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, chart(id));
}

test('a linked administrator reviews the order and intentionally records two distinct requests with the same details', async ({
  page,
  admin,
  patient,
  browser,
}, info) => {
  const who = await enter(page, 'admin'),
    fields = details();
  fields.dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const ids: string[] = [],
    requests: string[] = [];
  for (let i = 0; i < 2; i++) {
    await draft(page, fields);
    await review(page);
    const displayed = {
      Patient: 'Ananya Sharma · ' + patientId,
      'Ordering clinician': 'Dr. Meera Shah · ' + who.session.user!.doctorId,
      'Investigation name': fields.title,
      'Investigation type': 'Other',
      'Requested by date': fields.dueDate,
      'Clinical question / reason': fields.reason,
      'Instructions for the patient': fields.instructions,
    };
    for (const [label, value] of Object.entries(displayed)) {
      await expect(
        dialog(page).getByText(label, { exact: true }).locator('xpath=following-sibling::dd'),
      ).toHaveText(value);
    }
    if (!i) await mobile(page, save, info.outputPath('review-320.png'));
    const reply = await send(page, save, 201);
    const cmd = reply.request().postDataJSON(),
      { receipt } = await reply.json();
    expect(cmd).toEqual({
      ...fields,
      patientId,
      doctorId: who.session.user!.doctorId,
      orderedByRole: 'admin',
      reviewedConfirmed: true,
      requestId: expect.any(String),
    });
    expect(receipt).toEqual({
      actorId: who.session.user!.id,
      requestId: cmd.requestId,
      orderedByRole: 'admin',
      order: {
        ...fields,
        patientId,
        doctorId: cmd.doctorId,
        doctorName: expect.any(String),
        id: expect.any(String),
        createdAt: expect.any(String),
        status: 'ordered',
        cancellationReason: null,
        results: [],
        reviews: [],
      },
    });
    ids.push(receipt.order.id);
    requests.push(cmd.requestId);
    await expect(title(page, savedTitle)).toBeVisible();
    await expect(dialog(page)).toContainText(receipt.order.id);
    await button(page, 'Done').click();
    await expect(
      page
        .locator('.cw-investigation')
        .filter({ has: page.getByRole('heading', { name: fields.title, exact: true }) }),
    ).toHaveCount(i + 1);
  }
  expect(new Set(ids).size).toBe(2);
  expect(new Set(requests).size).toBe(2);
  await checkEffects(admin, patient, fields.title, ids);
  const portal = await browser.newPage({ baseURL: info.project.use.baseURL });
  try {
    await login(portal.request, 'patient');
    await portal.goto('/my-care/record?tab=workflows');
    await expect(portal.getByRole('heading', { name: fields.title, exact: true })).toHaveCount(2);
    await expect(launch(portal, orderButton)).toHaveCount(0);
  } finally {
    await portal.close();
  }
});

test('the exact original confirmation survives a lost response, a published result and malformed recovery replies', async ({
  page,
  admin,
  patient,
}, info) => {
  const who = await enter(page),
    fields = details();
  const commands: InvestigationOrderCommand[] = [];
  let original!: InvestigationOrderResponse;
  await page.route('**' + path, async (route) => {
    commands.push(route.request().postDataJSON());
    const upstream = await route.fetch(),
      data = await upstream.json();
    expect(upstream.status()).toBe(commands.length === 1 ? 201 : 200);
    if (commands.length === 1) {
      original = data;
      return route.abort('connectionreset');
    }
    if (commands.length === 2) data.receipt.actorId = 'another-clinician';
    if (commands.length === 3) data.receipt.order.instructions = 'Different instructions';
    if (commands.length === 4) data.receipt.order.status = 'reviewed';
    if (commands.length === 5) data.receipt.order.results = [{ id: randomUUID() }];
    return route.fulfill({ response: upstream, json: data });
  });
  await draft(page, fields);
  await review(page);
  const profile = (await read<Doctor[]>(admin, '/api/doctors')).find(
    (p) => p.id === who.session.user!.doctorId,
  )!;
  async function rename(name: string) {
    const res = await admin.api.patch('/api/doctors/' + profile.id, {
      headers: { 'X-CSRF-Token': admin.session.csrfToken! },
      data: { ...profile, name },
    });
    expect(res.status(), await res.text()).toBe(200);
  }
  const atCreation = 'Synthetic clinician at ordering';
  await rename(atCreation);
  try {
    await button(page, save).click();
    await expect(button(page, retry)).toBeEnabled();
    expect(original.receipt.order.doctorName).toBe(atCreation);
  } finally {
    await rename(profile.name);
  }
  await mobile(page, retry, info.outputPath('pending-320.png'));
  await button(page, 'Close for now').click();
  const order = original.receipt.order;
  const result = await post<Investigation>(
    patient,
    '/api/investigations/' + order.id + '/results',
    { note: 'Synthetic report entry', documentIds: [] },
  );
  await post(who, '/api/investigations/' + order.id + '/reviews', {
    resultId: result.results[0].id,
    summary: 'Synthetic review entry',
    followUp: 'Synthetic follow-up entry',
    publishToPatient: true,
  });
  await launch(page, resume).click();
  for (let i = 2; i <= 5; i++) {
    await send(page, retry, 200);
    await expect(title(page, savedTitle)).toHaveCount(0);
    await expect(button(page, retry)).toBeEnabled();
  }
  expect(await (await send(page, retry, 200)).json()).toEqual(original);
  expect(commands).toHaveLength(6);
  for (const command of commands) expect(command).toEqual(commands[0]);
  await expect(title(page, savedTitle)).toBeVisible();
  await expect(dialog(page)).toContainText(order.id);
  await expect(dialog(page)).toContainText(atCreation);
  await expect(dialog(page)).not.toContainText('Synthetic review entry');
  await mobile(page, 'Done', info.outputPath('saved-320.png'));
  await button(page, 'Done').click();
  expect((await matches(patient, fields.title))[0]).toMatchObject({
    status: 'reviewed',
    reviews: [{ summary: 'Synthetic review entry' }],
  });
  await checkEffects(admin, patient, fields.title, [order.id]);
});

test('only a matching elapsed-date refusal unlocks the draft for a corrected review', async ({
  page,
  admin,
  patient,
}, info) => {
  const yesterday = new Date(Date.now() - 4 * 86400000);
  await page.clock.setFixedTime(yesterday);
  await enter(page);
  const fields = details();
  fields.dueDate = new Date(yesterday.getTime() + 86400000).toISOString().slice(0, 10);
  let attempted = 0;
  await page.route('**' + path, async (route) => {
    const upstream = await route.fetch(),
      data = await upstream.json();
    if (++attempted === 1) {
      expect(data.code).toBe('INVESTIGATION_NOT_ORDERED');
      data.command.patientId = 'patient-2';
    }
    await route.fulfill({ response: upstream, json: data });
  });
  await draft(page, fields);
  await review(page);
  const rejected = await send(page, save, 409);
  await expect(button(page, retry)).toBeEnabled();
  await expect(button(page, 'Edit order details')).toHaveCount(0);
  const verified = await send(page, retry, 409);
  expect(verified.request().postDataJSON()).toEqual(rejected.request().postDataJSON());
  await expect(title(page, 'Investigation not ordered')).toBeVisible();
  await mobile(page, 'Edit order details', info.outputPath('refused-320.png'));
  expect(await matches(patient, fields.title)).toEqual([]);
  await button(page, 'Edit order details').click();
  await expect(field(page, 'Investigation name')).toHaveValue(fields.title);
  await expect(field(page, 'Instructions for the patient')).toHaveValue(fields.instructions);
  await dialog(page).locator('input[type=date]').fill('');
  await review(page);
  const fresh = await send(page, save, 201),
    cmd = fresh.request().postDataJSON();
  expect(cmd).toEqual({
    ...rejected.request().postDataJSON(),
    dueDate: null,
    requestId: expect.any(String),
  });
  expect(cmd.requestId).not.toBe(rejected.request().postDataJSON().requestId);
  await expect(title(page, savedTitle)).toBeVisible();
  await checkEffects(admin, patient, fields.title, [(await fresh.json()).receipt.order.id]);
});

test('a delayed response for one chart leaves another chart usable and an undelivered order can still be recorded once', async ({
  page,
  admin,
  patient,
}) => {
  await enter(page);
  const fields = details(),
    seen = deferred(),
    release = deferred();
  let initial!: unknown;
  await page.route(
    '**' + path,
    async (route) => {
      initial = route.request().postDataJSON();
      seen.resolve();
      await release.promise;
      await route.fulfill({ status: 401, json: { error: 'Synthetic delayed reply.' } });
    },
    { times: 1 },
  );
  await draft(page, fields);
  await review(page);
  await button(page, save).click();
  await seen.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.status() === 401,
  );
  try {
    await button(page, 'Close for now').click();
    await navigate(page, 'patient-2');
    await expect(page.getByRole('heading', { name: 'Rohan Patel', exact: true })).toBeVisible();
    await launch(page, orderButton).click();
  } finally {
    release.resolve();
  }
  await (await late).finished();
  await expect(title(page, 'Order an investigation')).toBeVisible();
  await expect(field(page, 'Investigation name')).toHaveValue('');
  await expect(launch(page, resume)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goBack();
  await launch(page, resume).click();
  expect(await matches(patient, fields.title)).toEqual([]);
  const response = await send(page, retry, 201);
  expect(response.request().postDataJSON()).toEqual(initial);
  await expect(title(page, savedTitle)).toBeVisible();
  expect(await matches(admin, fields.title, 'patient-2')).toEqual([]);
  await checkEffects(admin, patient, fields.title, [(await response.json()).receipt.order.id]);
});

test('unresolved orders stay in memory and clear on reload or a new sign-in', async ({
  page,
  patient,
}) => {
  await enter(page);
  const fields = details();
  await page.route('**' + path, (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic uncertain outcome.' } }),
  );
  for (const reset of ['reload', 'sign out']) {
    await draft(page, fields);
    await review(page);
    const failed = await send(page, save, 503);
    await expect(button(page, retry)).toBeEnabled();
    await button(page, 'Close for now').click();
    await expect(launch(page, resume)).toBeVisible();
    const stored = await page.evaluate(() =>
      JSON.stringify([
        window.history.state,
        location.href,
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    );
    for (const value of [fields.title, failed.request().postDataJSON().requestId])
      expect(stored).not.toContain(value);
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL('/login');
      await page.getByRole('button', { name: 'Doctor', exact: true }).click();
      await expect(page).toHaveURL('/clinic');
      await navigate(page, patientId);
    }
    await expect(launch(page, orderButton)).toBeVisible();
    await expect(launch(page, resume)).toHaveCount(0);
  }
  expect(await matches(patient, fields.title)).toEqual([]);
});
