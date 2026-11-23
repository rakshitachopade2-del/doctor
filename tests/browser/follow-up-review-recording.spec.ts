import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import type { ActivityFeed } from '../../shared/activity';
import type { FollowUpReview, FollowUpWorkItem } from '../../shared/follow-up';
import type {
  FollowUpReviewCommand,
  FollowUpReviewContext,
  FollowUpReviewResult,
} from '../../shared/follow-up-review-recording';
import type { CarePlan, CheckIn, ClinicSettings, Session } from '../../shared/types';

const patientId = 'patient-ananya';
const worklist = '/clinic/follow-ups';
const save = 'Save review & share instructions';
const retry = 'Retry exact review';
const resume = 'Resume follow-up review';
const refresh = 'Refresh review context';
const viewCurrent = 'View current review context';
const ackLabel = 'I reviewed this assessment and the instructions to share with the patient.';
const historyPath = (plan: CarePlan) => '/api/care-plans/' + plan.id + '/reviews';
const writePath = (plan: CarePlan) => historyPath(plan) + '/record';
const sourcePath = (plan: CarePlan) => '/api/care-plans/' + plan.id + '/review-context';
const recordUrl = (plan: CarePlan) => '/clinic/patients/' + patientId + '?tab=care&plan=' + plan.id;
const card = (page: Page, plan: CarePlan) => page.locator('#care-plan-' + plan.id);
const dialog = (page: Page) => page.getByRole('dialog');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const action = (page: Page, name: string) =>
  dialog(page).getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => dialog(page).getByLabel(name, { exact: true });
const heading = (page: Page, name: string) =>
  dialog(page).getByRole('heading', { name, exact: true });
function day(offset = 0) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const instant = new Date(date + 'T12:00:00Z');
  instant.setUTCDate(instant.getUTCDate() + offset);
  return instant.toISOString().slice(0, 10);
}
type Actor = { api: APIRequestContext; session: Session };
async function login(api: APIRequestContext, role: 'admin' | 'patient') {
  const res = await api.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { api, session: (await res.json()) as Session };
}
const test = base.extend<{ clinician: Actor; patient: Actor }>({
  clinician: async ({ page }, use) => {
    await use(await login(page.request, 'admin'));
  },
  patient: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({ baseURL });
    try {
      await use(await login(ctx, 'patient'));
    } finally {
      await ctx.dispose();
    }
  },
});
async function read<T>(actor: Actor, path: string) {
  const res = await actor.api.get(path);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as T;
}
async function write<T>(actor: Actor, path: string, data: unknown, status = 201) {
  const res = await actor.api.post(path, {
    headers: { 'X-CSRF-Token': actor.session.csrfToken! },
    data,
  });
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}
function planFor(clinician: Actor) {
  return write<CarePlan>(clinician, '/api/care-plans', {
    patientId,
    title: 'Follow-up ' + randomUUID(),
    instructions: 'Synthetic care plan for a browser test.',
    startDate: day(-3),
    endDate: day(3),
    followUpDate: day(),
    medications: [],
  });
}
async function itemFor(clinician: Actor, plan: CarePlan) {
  const all = await read<FollowUpWorkItem[]>(clinician, '/api/follow-up-worklist?scope=all');
  return all.find((item) => item.carePlan.id === plan.id)!;
}
function addReport(patient: Actor, plan: CarePlan, note: string, date = day(), status = 201) {
  return write<CheckIn>(
    patient,
    '/api/check-ins',
    { carePlanId: plan.id, date, adherence: 'partial', feeling: 'same', note },
    status,
  );
}
async function otherReview(clinician: Actor, plan: CarePlan, complete = false) {
  return write<CarePlan>(clinician, historyPath(plan), {
    expectedRevision: (await itemFor(clinician, plan)).revision,
    assessment: 'Separate clinician assessment',
    patientInstructions: 'Separate shared instructions',
    disposition: complete ? 'complete' : 'continue',
    nextReviewDate: complete ? null : day(6),
  });
}
async function setEnabled(clinician: Actor, enabled: boolean) {
  const settings = await read<ClinicSettings>(clinician, '/api/settings');
  const r = await clinician.api.patch('/api/settings', {
    headers: { 'X-CSRF-Token': clinician.session.csrfToken! },
    data: { modules: { ...settings.modules, followUp: enabled } },
  });
  expect(r.status(), await r.text()).toBe(200);
}
async function openReview(page: Page, plan: CarePlan, record = false) {
  if (record) {
    await page.goto(recordUrl(plan));
    await card(page, plan).getByRole('button', { name: 'Review progress', exact: true }).click();
  } else {
    await page.goto(worklist);
    await button(page, 'All plans').click();
    await page
      .getByRole('row')
      .filter({ hasText: plan.title })
      .getByRole('button', { name: 'Review progress', exact: true })
      .click();
  }
  await expect(field(page, 'Clinician assessment')).toBeEditable();
}
function draft() {
  return {
    assessment: 'Private assessment ' + randomUUID(),
    patientInstructions: 'Shared instructions ' + randomUUID(),
  };
}
async function fill(
  page: Page,
  values: ReturnType<typeof draft>,
  disposition: FollowUpReview['disposition'] = 'continue',
) {
  await field(page, 'Clinician assessment').fill(values.assessment);
  await field(page, 'Instructions for the patient').fill(values.patientInstructions);
  await field(page, 'Review outcome').selectOption(disposition);
  if (disposition !== 'complete') await field(page, 'Next review date').fill(day(8));
}
async function review(page: Page) {
  await action(page, 'Review before sharing').click();
  await expect(heading(page, 'Confirm follow-up review')).toBeVisible();
  await expect(field(page, ackLabel)).not.toBeChecked();
  await expect(action(page, save)).toBeDisabled();
  await field(page, ackLabel).check();
}
async function send(page: Page, plan: CarePlan, name = save) {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === writePath(plan) && r.request().method() === 'POST',
  );
  await action(page, name).click();
  return await response;
}
async function effects(clinician: Actor, patient: Actor, plan: CarePlan, count: number) {
  const history = await read<FollowUpReview[]>(clinician, historyPath(plan));
  expect(history).toHaveLength(count);
  const audits = await read<{ items: { action: string }[] }>(
    clinician,
    '/api/search/audit?entityType=carePlan&entityId=' + plan.id,
  );
  expect(
    audits.items.filter(
      (row) => row.action === 'reviewed follow-up and shared patient instructions',
    ),
  ).toHaveLength(count);
  const notices = (await read<ActivityFeed>(patient, '/api/activity?limit=100')).items.filter(
    (row) =>
      row.href === '/my-care?plan=' + plan.id &&
      row.title === 'Your clinic reviewed your follow-up',
  );
  expect(notices).toHaveLength(count);
  return history;
}
async function mobile(page: Page, name: string, output: string) {
  await page.setViewportSize({ width: 320, height: 800 });
  const control = action(page, name);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
  await page.screenshot({ path: output });
}
test('clinician checks the report versions and patient instructions before recording a follow-up', async ({
  page,
  clinician,
  patient,
}, info) => {
  test.setTimeout(60000);
  const plan = await planFor(clinician);
  const prior = await addReport(patient, plan, 'Report retained from an earlier review', day(-1));
  await otherReview(clinician, plan);
  const latest = await addReport(patient, plan, 'New patient report for this review');
  const source = await itemFor(clinician, plan);
  expect(source.unreviewedCheckIns).toEqual([latest]);
  await page.route('**' + sourcePath(plan), async (route) => {
    const response = await route.fetch();
    const context: FollowUpReviewContext = await response.json();
    context.checkInSnapshots = context.checkInSnapshots.filter(
      (version) => version.id !== prior.id,
    );
    await route.fulfill({ response, json: context });
  });
  await page.goto(worklist);
  await button(page, 'All plans').click();
  await page
    .getByRole('row')
    .filter({ hasText: plan.title })
    .getByRole('button', { name: 'Review progress', exact: true })
    .click();
  await expect(action(page, 'Try again')).toBeVisible();
  await expect(field(page, 'Clinician assessment')).toHaveCount(0);
  await page.unroute('**' + sourcePath(plan));
  await action(page, 'Try again').click();
  await expect(field(page, 'Clinician assessment')).toBeEditable();
  const values = draft();
  await fill(page, values, 'visit-requested');
  await review(page);
  await action(page, 'Edit review').click();
  await expect(field(page, 'Clinician assessment')).toHaveValue(values.assessment);
  await review(page);
  await expect(dialog(page)).toContainText(plan.title);
  await expect(dialog(page)).toContainText(values.patientInstructions);
  await expect(dialog(page)).toContainText(values.assessment);
  const evidence = dialog(page).getByText('Patient reports included in this review (2)', {
    exact: true,
  });
  await evidence.click();
  await expect(dialog(page).getByText(prior.note, { exact: true })).toBeVisible();
  await expect(dialog(page).getByText(latest.note, { exact: true })).toBeVisible();
  await evidence.click();
  await mobile(page, save, info.outputPath('review-320.png'));
  const saved = await send(page, plan);
  expect(saved.status()).toBe(201);
  const command: FollowUpReviewCommand = saved.request().postDataJSON();
  expect(command).toEqual({
    requestId: expect.stringMatching(/^[\da-f-]{36}$/i),
    patientId,
    carePlanId: plan.id,
    doctorId: clinician.session.user!.doctorId,
    expectedRevision: source.revision,
    reviewedConfirmed: true,
    ...values,
    disposition: 'visit-requested',
    nextReviewDate: day(8),
  });
  const { receipt }: FollowUpReviewResult = await saved.json();
  expect(receipt).toMatchObject({
    requestId: command.requestId,
    actorId: clinician.session.user!.id,
    patientId,
    carePlanId: plan.id,
    doctorId: command.doctorId,
    expectedRevision: source.revision,
  });
  expect(receipt.review.checkInSnapshots.map((s) => s.snapshot)).toEqual([prior, latest]);
  await expect(heading(page, 'Follow-up review recorded')).toBeVisible();
  await expect(dialog(page)).toContainText(values.patientInstructions);
  await mobile(page, viewCurrent, info.outputPath('confirmation-320.png'));
  expect((await effects(clinician, patient, plan, 2))[0]).toEqual(receipt.review);
  const current = await itemFor(clinician, plan);
  expect(current.unreviewedCount).toBe(0);
  expect(current.carePlan.effectiveFollowUpDate).toBe(day(8));
  const publicHistory = await read<Pick<FollowUpReview, 'patientInstructions'>[]>(
    patient,
    historyPath(plan),
  );
  expect(publicHistory[0].patientInstructions).toBe(values.patientInstructions);
  const projections = [
    publicHistory,
    await read(patient, '/api/patients/' + patientId),
    await read(patient, '/api/patients/' + patientId + '/care-summary'),
    await read(patient, '/api/activity?limit=100'),
  ];
  for (const projection of projections) {
    const data = JSON.stringify(projection);
    expect(data).not.toContain(values.assessment);
    expect(data).not.toContain(command.requestId);
    expect(data).not.toContain(receipt.review.checkInSnapshots[0].contentHash);
  }
});

test('a lost review confirmation survives patient corrections, completion, a module pause and altered replay receipts', async ({
  page,
  clinician,
  patient,
}, info) => {
  test.setTimeout(60000);
  const plan = await planFor(clinician);
  const first = await addReport(patient, plan, 'Report in the originally confirmed review');
  await openReview(page, plan, true);
  const values = draft();
  await fill(page, values);
  await review(page);
  const commands: FollowUpReviewCommand[] = [];
  let original!: FollowUpReviewResult;
  await page.route('**' + writePath(plan), async (route) => {
    commands.push(route.request().postDataJSON());
    const n = commands.length;
    const res = await route.fetch();
    expect(res.status()).toBe(n === 1 ? 201 : 200);
    const result: FollowUpReviewResult = await res.json();
    if (n === 1) {
      original = result;
      return route.abort('connectionreset');
    }
    if (n === 2)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"receipt":' });
    if (n === 3) result.receipt.actorId = 'other-staff';
    if (n === 4) result.receipt.expectedRevision = '0'.repeat(64);
    if (n === 5) result.receipt.review.checkInSnapshots[0].snapshot.note = 'Unrelated report';
    if (n === 6) result.receipt.review.checkInSnapshots[0].contentHash = '0'.repeat(64);
    if (n === 7) result.receipt.review.checkInSnapshots = [];
    await route.fulfill({ status: 200, json: result });
  });
  await action(page, save).click();
  await expect(action(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('retry-320.png'));
  await page.setViewportSize({ width: 1280, height: 840 });
  await action(page, 'Close for now').click();
  const corrected = await addReport(
    patient,
    plan,
    'Patient correction after the first review',
    day(),
    200,
  );
  await otherReview(clinician, plan, true);
  try {
    await setEnabled(clinician, false);
    await page.getByRole('link', { name: 'Follow-up care', exact: true }).click();
    await button(page, resume).click();
    for (let i = 2; i <= 7; i++) {
      await send(page, plan, retry);
      await expect(action(page, retry)).toBeEnabled();
      await expect(action(page, 'Edit review')).toHaveCount(0);
      await expect(action(page, refresh)).toHaveCount(0);
    }
    const recovered = await send(page, plan, retry);
    expect(recovered.status()).toBe(200);
    expect(await recovered.json()).toEqual(original);
    expect(commands).toHaveLength(8);
    expect(commands.every((c) => JSON.stringify(c) === JSON.stringify(commands[0]))).toBe(true);
    await expect(heading(page, 'Follow-up review recorded')).toBeVisible();
    await expect(dialog(page)).toContainText(values.assessment);
    expect(original.receipt.review.checkInSnapshots[0].snapshot).toEqual(first);
    await action(page, viewCurrent).click();
    await expect(heading(page, 'Current follow-up context')).toBeVisible();
    await dialog(page)
      .getByText(/^Previous review ·/)
      .click();
    await expect(
      dialog(page).getByText('Separate shared instructions', { exact: true }),
    ).toBeVisible();
    const history = await effects(clinician, patient, plan, 2);
    expect(history[0].checkInSnapshots[0].snapshot).toEqual(corrected);
    expect(history[1]).toEqual(original.receipt.review);
  } finally {
    await setEnabled(clinician, true);
  }
});

test('only the matching stale rejection opens a draft for fresh review of the latest patient report', async ({
  page,
  clinician,
  patient,
}) => {
  const plan = await planFor(clinician);
  const first = await addReport(patient, plan, 'Report before correction');
  await openReview(page, plan, true);
  const values = draft();
  await fill(page, values, 'complete');
  await review(page);
  const corrected = await addReport(
    patient,
    plan,
    'New report while clinician was writing',
    day(),
    200,
  );
  expect(corrected.id).toBe(first.id);
  const commands: FollowUpReviewCommand[] = [];
  await page.route('**' + writePath(plan), async (route) => {
    commands.push(route.request().postDataJSON());
    const n = commands.length;
    const response = await route.fetch();
    expect(response.status()).toBe(n <= 4 ? 409 : 201);
    const json = await response.json();
    if (n === 1) return route.fulfill({ status: 409, json: { error: 'Unknown outcome' } });
    if (n === 2) json.actorId = 'other-clinician';
    if (n === 3) json.command.assessment = 'A different assessment';
    await route.fulfill({ response, json });
  });
  for (let i = 0; i < 3; i++) {
    await send(page, plan, i === 0 ? save : retry);
    await expect(action(page, retry)).toBeEnabled();
    await expect(action(page, refresh)).toHaveCount(0);
  }
  await send(page, plan, retry);
  await expect(heading(page, 'Follow-up review not recorded')).toBeVisible();
  await page.route(
    '**' + sourcePath(plan),
    (route) => route.fulfill({ status: 503, json: { error: 'Temporary read failure' } }),
    { times: 1 },
  );
  await action(page, refresh).click();
  await expect(action(page, refresh)).toBeEnabled();
  await expect(field(page, 'Clinician assessment')).toHaveCount(0);
  await action(page, refresh).click();
  await expect(field(page, 'Clinician assessment')).toHaveValue(values.assessment);
  await expect(field(page, 'Instructions for the patient')).toHaveValue(values.patientInstructions);
  await expect(dialog(page)).toContainText(corrected.note);
  await review(page);
  const response = await send(page, plan);
  expect(response.status()).toBe(201);
  expect(commands).toHaveLength(5);
  expect(commands.slice(0, 4)).toEqual(Array(4).fill(commands[0]));
  expect(commands[4].requestId).not.toBe(commands[0].requestId);
  expect(commands[4].expectedRevision).not.toBe(commands[0].expectedRevision);
  expect(commands[4]).toMatchObject({
    ...values,
    disposition: 'complete',
    nextReviewDate: null,
    reviewedConfirmed: true,
  });
  expect((await effects(clinician, patient, plan, 1))[0].checkInSnapshots[0].snapshot).toEqual(
    corrected,
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type ObservedReplies = Window & { followUpReplyMarks?: string[]; followUpExpirations?: number };
async function observe(page: Page) {
  await page.evaluate(() => {
    const w = window as ObservedReplies;
    w.followUpReplyMarks = [];
    w.followUpExpirations = 0;
    w.addEventListener('derma:session-expired', () => w.followUpExpirations!++);
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      const marker = response.headers.get('X-Test-Review-Reply');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            w.followUpReplyMarks!.push(marker);
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
      page.evaluate((m) => (window as ObservedReplies).followUpReplyMarks?.includes(m), marker),
    )
    .toBe(true);
  expect(await page.evaluate(() => (window as ObservedReplies).followUpExpirations)).toBe(0);
}
test('late review reads and writes leave the active route and clinician session intact', async ({
  page,
  clinician,
}) => {
  const first = await planFor(clinician),
    second = await planFor(clinician);
  await page.goto('/clinic');
  await page.getByRole('link', { name: 'Follow-up care', exact: true }).click();
  await observe(page);
  const seen = deferred(),
    release = deferred();
  const readMarks: string[] = [];
  await page.route('**' + sourcePath(first), async (route) => {
    const mark = 'context-' + readMarks.length;
    readMarks.push(mark);
    seen.resolve();
    await release.promise;
    await route.fulfill({
      status: 401,
      headers: { 'X-Test-Review-Reply': mark },
      json: { error: 'Late context' },
    });
  });
  const row = (plan: CarePlan) => page.getByRole('row').filter({ hasText: plan.title });
  await row(first).getByRole('button', { name: 'Review progress', exact: true }).click();
  await seen.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL(/\/clinic$/);
    await page.getByRole('link', { name: 'Follow-up care', exact: true }).click();
    await row(second).getByRole('button', { name: 'Review progress', exact: true }).click();
    await fill(page, draft());
  } finally {
    release.resolve();
  }
  for (const mark of readMarks) await consumed(page, mark);
  await expect(dialog(page)).toContainText(second.title);
  await review(page);
  const committed = deferred(),
    deliver = deferred();
  let original!: FollowUpReviewResult;
  await page.route(
    '**' + writePath(second),
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      original = await response.json();
      committed.resolve();
      await deliver.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Review-Reply': 'save' },
        json: { error: 'Late write' },
      });
    },
    { times: 1 },
  );
  await action(page, save).click();
  await committed.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL(/\/clinic$/);
    await page.getByRole('link', { name: 'Follow-up care', exact: true }).click();
    await button(page, resume).click();
  } finally {
    deliver.resolve();
  }
  await consumed(page, 'save');
  await expect(action(page, retry)).toBeEnabled();
  const recovered = await send(page, second, retry);
  expect(recovered.status()).toBe(200);
  expect(await recovered.json()).toEqual(original);
  await expect(heading(page, 'Follow-up review recorded')).toBeVisible();
  expect(await read<FollowUpReview[]>(clinician, historyPath(first))).toHaveLength(0);
});

test('reloading or signing out clears the unresolved review and its private assessment', async ({
  page,
  clinician,
}) => {
  const plan = await planFor(clinician);
  await page.route('**' + writePath(plan), (route) =>
    route.fulfill({ status: 503, json: { error: 'Unconfirmed' } }),
  );
  for (const reset of ['reload', 'sign out']) {
    await openReview(page, plan);
    const values = draft();
    await fill(page, values);
    await review(page);
    await send(page, plan);
    await expect(action(page, retry)).toBeEnabled();
    await action(page, 'Close for now').click();
    await expect(button(page, resume)).toBeVisible();
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL(/\/login|\/$/);
      if (new URL(page.url()).pathname !== '/login')
        await page.getByRole('link', { name: 'Sign in', exact: true }).click();
      await page.getByLabel('Email address', { exact: true }).fill('admin@derma.demo');
      await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
      await button(page, 'Sign in').click();
      await page.getByRole('link', { name: 'Follow-up care', exact: true }).click();
    }
    await button(page, 'All plans').click();
    await expect(button(page, resume)).toHaveCount(0);
    await page
      .getByRole('row')
      .filter({ hasText: plan.title })
      .getByRole('button', { name: 'Review progress', exact: true })
      .click();
    await expect(field(page, 'Clinician assessment')).toHaveValue('');
    await expect(field(page, 'Instructions for the patient')).toHaveValue('');
  }
  expect(await read<FollowUpReview[]>(clinician, historyPath(plan))).toHaveLength(0);
});
