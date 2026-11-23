import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import type { ActivityFeed } from '../../shared/activity';
import type {
  Investigation,
  InvestigationResult,
  PatientClinicalWorkflows,
} from '../../shared/clinical';
import type { PatientDocument } from '../../shared/documents';
import type { InvestigationWorkItem } from '../../shared/investigation-worklist';
import type {
  InvestigationResultCommand,
  InvestigationResultResponse,
} from '../../shared/investigation-result-submission';
import type { Session } from '../../shared/types';
import { syntheticPdf } from '../fixtures/report';

const patientId = 'patient-ananya';
const patientRecord = '/my-care/record?tab=workflows';
const workflowPath = '/api/patients/' + patientId + '/clinical-workflows';
const acknowledge = 'I reviewed this result and the reports to share.';
const retry = 'Retry exact result';
const resume = 'Resume result submission';
const current = 'View current investigation';
const patientSave = 'Share result with clinic';
const clinicSave = 'Save result entry';
const path = (order: Investigation) => '/api/investigations/' + order.id;
const submitPath = (order: Investigation) => path(order) + '/results/submit';
const dialog = (page: Page) => page.getByRole('dialog');
const action = (page: Page, name: string) =>
  dialog(page).getByRole('button', { name, exact: true });
const heading = (page: Page, name: string) =>
  dialog(page).getByRole('heading', { name, exact: true });
const field = (page: Page, label: string) => dialog(page).getByLabel(label, { exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
type Actor = { api: APIRequestContext; session: Session };
async function login(api: APIRequestContext, role: 'admin' | 'doctor' | 'patient'): Promise<Actor> {
  const res = await api.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { api, session: await res.json() };
}
// Fixtures create orders as a different account from both submitting browser roles.
const test = base.extend<{ admin: Actor }>({
  admin: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({ baseURL });
    try {
      await use(await login(api, 'admin'));
    } finally {
      await api.dispose();
    }
  },
});
async function read<T>(actor: Actor, url: string): Promise<T> {
  const res = await actor.api.get(url);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}
async function post<T>(actor: Actor, url: string, data: unknown, status = 201): Promise<T> {
  const res = await actor.api.post(url, {
    headers: { 'X-CSRF-Token': actor.session.csrfToken! },
    data,
  });
  expect(res.status(), await res.text()).toBe(status);
  return res.json();
}
function orderFor(admin: Actor) {
  return post<Investigation>(admin, '/api/investigations', {
    patientId,
    title: 'Investigation ' + randomUUID().slice(0, 8),
    kind: 'laboratory',
    reason: 'Synthetic workflow check.',
    instructions: 'Share the synthetic result.',
  });
}
function pdfFor(actor: Actor) {
  return post<PatientDocument>(actor, '/api/documents', {
    patientId,
    title: 'Report ' + randomUUID().slice(0, 8),
    originalName: 'synthetic-report.pdf',
    consent: true,
    dataUrl: 'data:application/pdf;base64,' + syntheticPdf().toString('base64'),
  });
}
async function fromRecord(actor: Actor, order: Investigation) {
  const record = await read<PatientClinicalWorkflows>(actor, workflowPath);
  const match = record.investigations.find((item) => item.id === order.id);
  expect(match).toBeDefined();
  return match!;
}
async function workItem(admin: Actor, order: Investigation) {
  const rows = await read<InvestigationWorkItem[]>(admin, '/api/investigation-worklist?scope=all');
  return rows.find((row) => row.investigationId === order.id)!;
}
async function effects(admin: Actor, order: Investigation, expected: InvestigationResult[]) {
  expect((await fromRecord(admin, order)).results).toEqual(expected);
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=investigation&entityId=' + order.id,
  );
  expect(
    audit.items.filter((row) => row.action === 'submitted unreviewed investigation result'),
  ).toHaveLength(expected.length);
  const activity = await read<ActivityFeed>(admin, '/api/activity?limit=100');
  const href =
    '/clinic/patients/' + patientId + '?tab=workup&investigation=' + order.id + '&result=';
  const ids = activity.items
    .filter(
      (row) =>
        row.title === 'An investigation result is ready for review' && row.href.startsWith(href),
    )
    .map((row) => row.href.slice(href.length));
  expect(ids.sort()).toEqual(expected.map((row) => row.id).sort());
}
function patientCard(page: Page, order: Investigation) {
  return page
    .locator('.patient-investigation-card')
    .filter({ has: page.getByRole('heading', { name: order.title, exact: true }) });
}
async function openPatient(page: Page, order: Investigation, supplement = false) {
  await patientCard(page, order)
    .getByRole('button', {
      name: supplement ? 'Share another result' : 'Share result',
      exact: true,
    })
    .click();
  await expect(heading(page, 'Share an investigation result')).toBeVisible();
}
async function review(page: Page, save: string) {
  await action(page, 'Review result').click();
  await expect(heading(page, 'Review investigation result')).toBeVisible();
  await expect(field(page, acknowledge)).not.toBeChecked();
  await expect(action(page, save)).toBeDisabled();
  await field(page, acknowledge).check();
}
async function send(page: Page, order: Investigation, name: string, expectedStatus: number) {
  const received = page.waitForResponse(
    (r) => new URL(r.url()).pathname === submitPath(order) && r.request().method() === 'POST',
  );
  await action(page, name).click();
  const response = await received;
  expect(response.status()).toBe(expectedStatus);
  return response;
}
async function mobile(page: Page, name: string, image: string) {
  await page.setViewportSize({ width: 320, height: 800 });
  const control = action(page, name);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
    }),
  ).toBe(true);
  expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: image });
}
function selectReport(page: Page, report: PatientDocument) {
  return dialog(page).getByRole('checkbox', { name: new RegExp(report.title) });
}

test('a patient reviews ordered PDF links and can deliberately send the same supplemental result after a private clinical review', async ({
  page,
  admin,
}, info) => {
  const patient = await login(page.request, 'patient'),
    order = await orderFor(admin),
    first = await pdfFor(patient),
    second = await pdfFor(admin);
  const note = 'Synthetic patient result with two reports.';
  const documents = [second.id, first.id];
  await page.goto(patientRecord);
  const results: InvestigationResult[] = [];
  const commands: InvestigationResultCommand[] = [];
  for (let i = 0; i < 2; i++) {
    await openPatient(page, order, i > 0);
    await field(page, 'Result note').fill(' ' + note + ' ');
    await selectReport(page, second).check();
    await selectReport(page, first).check();
    await review(page, patientSave);
    await expect(dialog(page)).toContainText(order.title);
    await expect(dialog(page)).toContainText(note);
    await expect(dialog(page)).toContainText(first.title);
    await expect(dialog(page)).toContainText(second.title);
    if (i === 0) {
      await action(page, 'Edit result').click();
      await expect(field(page, 'Result note')).toHaveValue(/Synthetic patient result/);
      await review(page, patientSave);
      await mobile(page, patientSave, info.outputPath('review-320.png'));
    }
    const response = await send(page, order, patientSave, 201);
    const cmd = response.request().postDataJSON() as InvestigationResultCommand;
    expect(cmd).toEqual({
      requestId: expect.any(String),
      investigationId: order.id,
      patientId,
      submittedByRole: 'patient',
      note,
      documentIds: documents,
      reviewedConfirmed: true,
    });
    const { receipt }: InvestigationResultResponse = await response.json();
    expect(receipt).toMatchObject({
      requestId: cmd.requestId,
      actorId: patient.session.user!.id,
      patientId,
      investigationId: order.id,
      result: {
        investigationId: order.id,
        submittedById: patient.session.user!.id,
        submittedByRole: 'patient',
        documentIds: documents,
        note,
      },
    });
    commands.push(cmd);
    results.push(receipt.result);
    await expect(heading(page, 'Result submitted')).toBeVisible();
    if (i === 0) await mobile(page, current, info.outputPath('confirmation-320.png'));
    await action(page, 'Close confirmation').click();
    await effects(admin, order, results);
    expect(await workItem(admin, order)).toMatchObject({
      latestResultId: receipt.result.id,
      needsReview: true,
    });
    if (i === 0) {
      const reviewed = await post<Investigation>(admin, path(order) + '/reviews', {
        resultId: receipt.result.id,
        summary: 'Clinic-only synthetic findings.',
        followUp: 'Private interpretation.',
        publishToPatient: false,
      });
      expect(reviewed.status).toBe('reviewed');
      expect((await fromRecord(patient, order)).reviews).toEqual([]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await button(page, 'Refresh updates').click();
    }
  }
  expect(commands[0].requestId).not.toBe(commands[1].requestId);
  expect(results[0].id).not.toBe(results[1].id);
  const fetched = await patient.api.get(second.url);
  expect(fetched.status()).toBe(200);
  expect(await fetched.body()).toEqual(syntheticPdf());
  const visible = await fromRecord(patient, order);
  expect(visible.results).toEqual(results);
  expect(visible.reviews).toHaveLength(0);
  for (const cmd of commands) expect(JSON.stringify(visible)).not.toContain(cmd.requestId);
});

test('a clinician recovers the original result after a lost reply, a supplement and publication', async ({
  page,
  admin,
}, info) => {
  const clinician = await login(page.request, 'doctor'),
    order = await orderFor(admin),
    pdf = await pdfFor(admin);
  const note = 'Initial clinician result.',
    later = 'Distinct supplemental result.';
  const commands: InvestigationResultCommand[] = [];
  let original!: InvestigationResultResponse;
  await page.goto('/clinic/patients/' + patientId + '?tab=workup&investigation=' + order.id);
  await page
    .locator('#investigation-' + order.id)
    .getByRole('button', { name: 'Add result', exact: true })
    .click();
  await field(page, 'Result entry / source note').fill(note);
  await selectReport(page, pdf).check();
  await review(page, clinicSave);
  await page.route('**' + submitPath(order), async (route) => {
    const n = commands.push(route.request().postDataJSON());
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(n === 1 ? 201 : 200);
    const value: InvestigationResultResponse = await upstream.json();
    if (n === 1) {
      original = value;
      return route.abort('connectionreset');
    }
    if (n === 2)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"receipt":' });
    if (n === 3) value.receipt.result.documentIds = [];
    if (n === 4) value.receipt.actorId = 'other-actor';
    if (n === 5) value.receipt.result.note = later;
    if (n === 6) value.receipt.result.submittedByRole = 'patient';
    if (n === 7) value.receipt.investigationId = randomUUID();
    return route.fulfill({ response: upstream, json: value });
  });
  await action(page, clinicSave).click();
  await expect(action(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('retry-320.png'));
  await action(page, 'Close for now').click();
  const next = await post<Investigation>(clinician, path(order) + '/results', {
    note: later,
    documentIds: [],
  });
  const newer = next.results.at(-1)!;
  const reviewed = await post<Investigation>(admin, path(order) + '/reviews', {
    resultId: newer.id,
    summary: 'Reviewed the supplement.',
    followUp: 'Shared synthetic guidance.',
    publishToPatient: true,
  });
  expect(reviewed.status).toBe('reviewed');
  await expect(button(page, resume)).toBeVisible();
  await button(page, resume).click();
  for (let n = 2; n <= 7; n++) {
    await send(page, order, retry, 200);
    await expect(action(page, retry)).toBeEnabled();
    await expect(heading(page, 'Result submitted')).toHaveCount(0);
    await expect(field(page, 'Result entry / source note')).toHaveCount(0);
  }
  const response = await send(page, order, retry, 200);
  expect(await response.json()).toEqual(original);
  for (const cmd of commands) expect(cmd).toEqual(commands[0]);
  expect(commands[0].submittedByRole).toBe('doctor');
  await expect(heading(page, 'Result submitted')).toBeVisible();
  await expect(dialog(page)).toContainText(note);
  await expect(dialog(page)).not.toContainText(later);
  await page.route(
    '**' + workflowPath,
    async (route) => {
      const upstream = await route.fetch();
      const record: PatientClinicalWorkflows = await upstream.json();
      const target = record.investigations.find((i) => i.id === order.id)!;
      target.results = target.results.filter((r) => r.id !== original.receipt.result.id);
      await route.fulfill({ response: upstream, json: record });
    },
    { times: 1 },
  );
  await action(page, current).click();
  await expect(heading(page, 'Result submitted')).toBeVisible();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await page.route(
    '**/api/documents?patientId=' + patientId,
    async (route) => {
      const upstream = await route.fetch();
      const docs: PatientDocument[] = await upstream.json();
      await route.fulfill({
        response: upstream,
        json: docs.map((d) => (d.id === pdf.id ? { ...d, title: 'Unverified report title' } : d)),
      });
    },
    { times: 1 },
  );
  await action(page, current).click();
  await expect(heading(page, 'Current investigation')).toBeVisible();
  await expect(dialog(page)).toContainText(later);
  await expect(dialog(page)).toContainText(note);
  await expect(dialog(page).getByRole('alert')).toContainText(
    'The private report list could not be verified.',
  );
  await expect(dialog(page).locator('a[href="' + pdf.url + '"]')).toHaveCount(0);
  await expect(dialog(page)).not.toContainText('Unverified report title');
  await action(page, 'Try again').click();
  await expect(dialog(page).getByRole('link', { name: pdf.title, exact: true })).toHaveAttribute(
    'href',
    pdf.url,
  );
  await action(page, 'Back to confirmation').click();
  await expect(dialog(page)).not.toContainText(later);
  await effects(admin, order, [original.receipt.result, newer]);
  expect(await workItem(admin, order)).toMatchObject({
    latestResultId: newer.id,
    needsReview: false,
  });
  const self = (await read<ActivityFeed>(clinician, '/api/activity?limit=100')).items.filter(
    (row) =>
      row.title === 'An investigation result is ready for review' && row.href.includes(order.id),
  );
  expect(self).toHaveLength(0);
});

test('an order cancelled before saving requires a matching refusal to unlock the pending patient result', async ({
  page,
  admin,
}) => {
  const patient = await login(page.request, 'patient'),
    order = await orderFor(admin),
    note = 'Draft on cancelled order.';
  await page.goto(patientRecord);
  await openPatient(page, order);
  await field(page, 'Result note').fill(note);
  await review(page, patientSave);
  await post(
    admin,
    path(order) + '/cancel',
    { reason: 'Synthetic cancellation for this check.' },
    200,
  );
  let attempts = 0;
  let original!: InvestigationResultCommand;
  await page.route('**' + submitPath(order), async (route) => {
    const cmd = route.request().postDataJSON();
    if (attempts === 0) original = cmd;
    else expect(cmd).toEqual(original);
    attempts++;
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(409);
    const value = await upstream.json();
    if (attempts === 1)
      return route.fulfill({ status: 409, json: { error: 'Missing durable proof' } });
    if (attempts === 2) value.actorId = 'another-patient';
    if (attempts === 3) value.command.documentIds = [randomUUID()];
    return route.fulfill({ response: upstream, json: value });
  });
  await send(page, order, patientSave, 409);
  for (let n = 2; n <= 4; n++) {
    await expect(action(page, retry)).toBeEnabled();
    await expect(action(page, 'Refresh investigation')).toHaveCount(0);
    await send(page, order, retry, 409);
  }
  await expect(heading(page, 'Result not submitted')).toBeVisible();
  await action(page, 'Refresh investigation').click();
  await expect(dialog(page)).toContainText(/cancelled/i);
  await expect(field(page, 'Result note')).toHaveValue(note);
  await expect(action(page, 'Review result')).toBeDisabled();
  await expect(action(page, retry)).toHaveCount(0);
  await expect(action(page, patientSave)).toHaveCount(0);
  await effects(admin, order, []);
  expect((await fromRecord(patient, order)).status).toBe('cancelled');
});

test('a missing PDF must be removed before the retained result and replacement PDF can be reviewed again', async ({
  page,
  admin,
}) => {
  const patient = await login(page.request, 'patient'),
    order = await orderFor(admin),
    pdf = await pdfFor(patient);
  const missingId = randomUUID();
  const missing = {
    ...pdf,
    id: missingId,
    title: 'Unavailable report ' + randomUUID().slice(0, 8),
    url: '/api/documents/' + missingId + '/file',
  };
  const note = 'Retained note after confirming the missing PDF.';
  await page.goto(patientRecord);
  await expect(patientCard(page, order)).toBeVisible();
  // The synthetic stale catalogue entry has never existed in the writable database.
  await page.route('**/api/documents?patientId=' + patientId, async (route) => {
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(200);
    await route.fulfill({ response: upstream, json: [...(await upstream.json()), missing] });
  });
  await openPatient(page, order);
  await field(page, 'Result note').fill(note);
  await selectReport(page, missing).check();
  await review(page, patientSave);
  await page.unroute('**/api/documents?patientId=' + patientId);
  const failed = await send(page, order, patientSave, 400);
  const original = failed.request().postDataJSON() as InvestigationResultCommand;
  expect(await failed.json()).toMatchObject({
    code: 'INVESTIGATION_RESULT_NOT_SUBMITTED',
    command: original,
  });
  await expect(heading(page, 'Result not submitted')).toBeVisible();
  await action(page, 'Refresh investigation').click();
  await expect(field(page, 'Result note')).toHaveValue(note);
  await expect(action(page, 'Review result')).toBeDisabled();
  await expect(dialog(page)).toContainText(missing.title);
  await effects(admin, order, []);
  await action(page, 'Remove report').click();
  await selectReport(page, pdf).check();
  await review(page, patientSave);
  const saved = await send(page, order, patientSave, 201);
  const revised = saved.request().postDataJSON();
  expect(revised.requestId).not.toBe(original.requestId);
  expect(revised).toEqual({ ...original, requestId: revised.requestId, documentIds: [pdf.id] });
  await expect(heading(page, 'Result submitted')).toBeVisible();
  const { receipt }: InvestigationResultResponse = await saved.json();
  expect(receipt.result.documentIds).toEqual([pdf.id]);
  await effects(admin, order, [receipt.result]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function enterPatientPanel(page: Page) {
  await page.getByRole('link', { name: 'My health record', exact: true }).click();
  await page.getByRole('tab', { name: 'Tests & procedures', exact: true }).click();
}
async function leavePatientPanel(page: Page) {
  await page.goBack();
  if (new URL(page.url()).pathname !== '/my-care')
    await page.getByRole('link', { name: 'My care', exact: true }).click();
  await expect(page).toHaveURL(/\/my-care$/);
}
type ObservedWindow = Window & { resultMarks?: string[]; resultExpirations?: number };
async function watchReplies(page: Page) {
  await page.addInitScript(() => {
    const w = window as ObservedWindow;
    w.resultMarks = [];
    w.resultExpirations = 0;
    w.addEventListener('derma:session-expired', () => w.resultExpirations!++);
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args),
        marker = response.headers.get('X-Test-Result-Reply');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            w.resultMarks!.push(marker);
          }
        };
      }
      return response;
    };
  });
}
async function consumed(page: Page, marker: string) {
  await expect
    .poll(() => page.evaluate((m) => (window as ObservedWindow).resultMarks?.includes(m), marker))
    .toBe(true);
  expect(await page.evaluate(() => (window as ObservedWindow).resultExpirations)).toBe(0);
}

test('leaving a result form isolates late source and save replies from a later investigation and session', async ({
  page,
  admin,
}) => {
  const patient = await login(page.request, 'patient'),
    first = await orderFor(admin),
    second = await orderFor(admin);
  await watchReplies(page);
  await page.goto('/my-care');
  await enterPatientPanel(page);
  const seen = deferred(),
    release = deferred();
  await page.route(
    '**' + workflowPath,
    async (route) => {
      await route.fetch();
      seen.resolve();
      await release.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Result-Reply': 'source' },
        json: { error: 'Late source' },
      });
    },
    { times: 1 },
  );
  await openPatient(page, first);
  await seen.promise;
  try {
    await leavePatientPanel(page);
    await enterPatientPanel(page);
    await openPatient(page, second);
    await field(page, 'Result note').fill('Current order draft.');
  } finally {
    release.resolve();
  }
  await consumed(page, 'source');
  await expect(field(page, 'Result note')).toHaveValue('Current order draft.');
  await review(page, patientSave);
  const wrote = deferred(),
    deliver = deferred();
  let original!: InvestigationResultResponse;
  await page.route(
    '**' + submitPath(second),
    async (route) => {
      const res = await route.fetch();
      expect(res.status()).toBe(201);
      original = await res.json();
      wrote.resolve();
      await deliver.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Result-Reply': 'write' },
        json: { error: 'Late save' },
      });
    },
    { times: 1 },
  );
  await action(page, patientSave).click();
  await wrote.promise;
  try {
    await leavePatientPanel(page);
    await enterPatientPanel(page);
    await button(page, resume).click();
  } finally {
    deliver.resolve();
  }
  await consumed(page, 'write');
  const recovered = await send(page, second, retry, 200);
  expect(await recovered.json()).toEqual(original);
  await expect(heading(page, 'Result submitted')).toBeVisible();
  expect((await fromRecord(patient, first)).results).toEqual([]);
  await effects(admin, second, [original.receipt.result]);
});

test('reloading or signing out clears an unresolved note, selected reports and retry identity', async ({
  page,
  admin,
}) => {
  const patient = await login(page.request, 'patient'),
    order = await orderFor(admin),
    pdf = await pdfFor(patient);
  await page.route('**' + submitPath(order), (route) =>
    route.fulfill({ status: 503, json: { error: 'Unconfirmed' } }),
  );
  await page.goto(patientRecord);
  for (const reset of ['reload', 'sign out']) {
    const secret = 'Synthetic pending note ' + randomUUID();
    await openPatient(page, order);
    await field(page, 'Result note').fill(secret);
    await selectReport(page, pdf).check();
    await review(page, patientSave);
    await send(page, order, patientSave, 503);
    await expect(action(page, retry)).toBeEnabled();
    await action(page, 'Close for now').click();
    await expect(button(page, resume)).toBeVisible();
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL(/\/login|\/$/);
      if (new URL(page.url()).pathname !== '/login')
        await page.getByRole('link', { name: 'Sign in', exact: true }).click();
      await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
      await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
      await button(page, 'Sign in').click();
      await enterPatientPanel(page);
    }
    await expect(patientCard(page, order)).toBeVisible();
    await expect(button(page, resume)).toHaveCount(0);
    await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
    await openPatient(page, order);
    await expect(field(page, 'Result note')).toHaveValue('');
    await expect(selectReport(page, pdf)).not.toBeChecked();
    await action(page, 'Cancel').click();
  }
  await effects(admin, order, []);
});
