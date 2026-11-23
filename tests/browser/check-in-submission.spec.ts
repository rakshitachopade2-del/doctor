import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import type { ActivityFeed } from '../../shared/activity';
import type {
  CheckInNotSaved,
  CheckInSubmissionCommand,
  CheckInSubmissionResult,
} from '../../shared/check-in-submission';
import type { FollowUpReview } from '../../shared/follow-up';
import type { CarePlan, CheckIn, PatientRecord, Session } from '../../shared/types';

const patientId = 'patient-ananya';
const recordPath = '/api/patients/' + patientId;
const submitPath = '/api/check-ins/submit';
const save = 'Save check-in',
  retry = 'Retry exact check-in',
  resume = 'Resume check-in';
const noteLabel = 'Anything you want your clinic to know?';
const routine = 'How did your routine go today?',
  feeling = 'How are you feeling compared with before?';
const dialog = (page: Page) => page.getByRole('dialog');
const action = (page: Page, name: string) =>
  dialog(page).getByRole('button', { name, exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => dialog(page).getByLabel(name, { exact: true });
const ack = (page: Page) =>
  field(page, 'I reviewed this report and want to share it with my clinic.');
const card = (page: Page, plan: CarePlan) => page.locator('#care-plan-' + plan.id);
const clinicDate = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
type Actor = { api: APIRequestContext; session: Session };
async function login(api: APIRequestContext, role: 'doctor' | 'patient' | 'admin'): Promise<Actor> {
  const r = await api.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(r.status(), await r.text()).toBe(200);
  return { api, session: await r.json() };
}
async function post<T>(actor: Actor, path: string, data: unknown, status: number) {
  const r = await actor.api.post(path, {
    data,
    headers: { 'X-CSRF-Token': actor.session.csrfToken! },
  });
  expect(r.status(), await r.text()).toBe(status);
  return (await r.json()) as T;
}
async function read<T>(actor: Actor, path: string) {
  const r = await actor.api.get(path);
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as T;
}
const test = base.extend<{ patient: Actor; doctor: Actor; admin: Actor }>({
  patient: async ({ page }, use) => {
    await use(await login(page.request, 'patient'));
  },
  doctor: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({ baseURL });
    try {
      await use(await login(api, 'doctor'));
    } finally {
      await api.dispose();
    }
  },
  admin: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({ baseURL });
    try {
      await use(await login(api, 'admin'));
    } finally {
      await api.dispose();
    }
  },
});
function newPlan(doctor: Actor, daysUntilEnd = 7) {
  const startDate = clinicDate(),
    end = new Date(startDate + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() + daysUntilEnd);
  return post<CarePlan>(
    doctor,
    '/api/care-plans',
    {
      patientId,
      title: 'Daily report ' + randomUUID(),
      instructions: 'Synthetic routine for a browser test.',
      startDate,
      endDate: end.toISOString().slice(0, 10),
      followUpDate: end.toISOString().slice(0, 10),
      medications: [],
    },
    201,
  );
}
async function advancePastClinicMidnight(page: Page, date: string) {
  const nextDay = new Date(date + 'T00:00:01+05:30');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  await page.clock.setFixedTime(nextDay);
}
async function visit(page: Page, plan: CarePlan, update = false) {
  await page.goto('/my-care?plan=' + plan.id);
  await card(page, plan)
    .getByRole('button', { name: update ? 'Update check-in' : 'Daily check-in', exact: true })
    .click();
  await expect(dialog(page).getByRole('heading', { name: 'Your daily check-in' })).toBeVisible();
}
async function review(page: Page) {
  await action(page, 'Review check-in').click();
  await expect(
    dialog(page).getByRole('heading', { name: 'Review your check-in', exact: true }),
  ).toBeVisible();
  await expect(ack(page)).not.toBeChecked();
  await expect(action(page, save)).toBeDisabled();
  await ack(page).check();
}
async function send(page: Page, label = save) {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === submitPath && r.request().method() === 'POST',
  );
  await action(page, label).click();
  return await response;
}
async function saved(page: Page) {
  await expect(
    dialog(page).getByRole('heading', { name: 'Check-in saved', exact: true }),
  ).toBeVisible();
}
async function reports(actor: Actor, plan: CarePlan) {
  return (await read<PatientRecord>(actor, recordPath)).checkIns.filter(
    (c) => c.carePlanId === plan.id,
  );
}
async function existingPlan(doctor: Actor, plan: CarePlan) {
  return (await read<CarePlan[]>(doctor, '/api/care-plans')).find((p) => p.id === plan.id)!;
}
function writeOtherReport(patient: Actor, plan: CarePlan, note: string, status: number) {
  return post<CheckIn>(
    patient,
    '/api/check-ins',
    {
      carePlanId: plan.id,
      date: clinicDate(),
      adherence: 'missed',
      feeling: 'worse',
      note,
    },
    status,
  );
}
const historyPath = (plan: CarePlan) => '/api/care-plans/' + plan.id + '/reviews';
async function clinicianReview(doctor: Actor, plan: CarePlan, complete: boolean) {
  return post<CarePlan>(
    doctor,
    historyPath(plan),
    {
      expectedRevision: (await existingPlan(doctor, plan)).followUpRevision,
      assessment: 'Internal synthetic clinician observation',
      patientInstructions: 'Synthetic follow-up instructions',
      disposition: complete ? 'complete' : 'continue',
      nextReviewDate: complete ? null : plan.followUpDate,
    },
    201,
  );
}
async function evidence(
  doctor: Actor,
  admin: Actor,
  plan: CarePlan,
  reportId: string,
  expectedUpdates: number,
) {
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=checkIn&entityId=' + reportId,
  );
  expect(audit.items.filter((row) => row.action === 'recorded daily check-in')).toHaveLength(1);
  expect(audit.items.filter((row) => row.action === 'updated daily check-in')).toHaveLength(
    expectedUpdates,
  );
  const activity = await read<ActivityFeed>(doctor, '/api/activity?limit=100');
  const notices = activity.items.filter(
    (row) =>
      row.kind === 'check-in' &&
      row.href === '/clinic/patients/' + patientId + '?tab=care&plan=' + plan.id,
  );
  expect(notices.filter((row) => row.title === 'A patient shared a check-in')).toHaveLength(1);
  expect(notices.filter((row) => row.title === 'A patient updated their check-in')).toHaveLength(
    expectedUpdates,
  );
  expect(notices).toHaveLength(1 + expectedUpdates);
}
async function mobile(page: Page, label: string, screenshot: string) {
  await page.setViewportSize({ width: 320, height: 860 });
  const control = action(page, label);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const audit = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: screenshot });
}

test('a patient reviews a report and deliberately corrects it with new evidence for their clinician', async ({
  page,
  patient,
  doctor,
  admin,
}, info) => {
  const plan = await newPlan(doctor);
  await visit(page, plan);
  await field(page, routine).selectOption('partial');
  await field(page, feeling).selectOption('better');
  await field(page, noteLabel).fill('Draft before review');
  await review(page);
  await action(page, 'Edit check-in').click();
  const originalNote = 'Reviewed synthetic report';
  await field(page, noteLabel).fill(' ' + originalNote + ' ');
  await review(page);
  await expect(dialog(page)).toContainText(originalNote);
  await mobile(page, save, info.outputPath('daily-report-review-320.png'));
  const first = await send(page);
  expect(first.status()).toBe(201);
  const command: CheckInSubmissionCommand = first.request().postDataJSON();
  expect(command).toEqual({
    requestId: expect.any(String),
    patientId,
    carePlanId: plan.id,
    date: clinicDate(),
    expectedUpdatedAt: null,
    adherence: 'partial',
    feeling: 'better',
    note: originalNote,
    reviewedConfirmed: true,
  });
  const { receipt } = (await first.json()) as CheckInSubmissionResult;
  expect(receipt).toEqual({
    requestId: command.requestId,
    actorId: patient.session.user!.id,
    patientId,
    carePlanId: plan.id,
    date: command.date,
    expectedUpdatedAt: null,
    operation: 'created',
    checkIn: {
      id: expect.any(String),
      carePlanId: plan.id,
      patientId,
      date: command.date,
      adherence: 'partial',
      feeling: 'better',
      note: originalNote,
      createdAt: expect.any(String),
    },
  });
  await saved(page);
  await mobile(page, 'View current report', info.outputPath('daily-report-saved-320.png'));
  await action(page, 'Close confirmation').click();
  await evidence(doctor, admin, plan, receipt.checkIn.id, 0);
  await clinicianReview(doctor, plan, false);
  await visit(page, plan, true);
  await expect(field(page, noteLabel)).toHaveValue(originalNote);
  await field(page, noteLabel).fill('Intentional correction');
  await field(page, feeling).selectOption('same');
  await review(page);
  const corrected = await send(page);
  expect(corrected.status()).toBe(201);
  const fresh = corrected.request().postDataJSON() as CheckInSubmissionCommand;
  expect(fresh).toEqual({
    ...command,
    requestId: expect.any(String),
    expectedUpdatedAt: receipt.checkIn.createdAt,
    note: 'Intentional correction',
    feeling: 'same',
  });
  expect(fresh.requestId).not.toBe(command.requestId);
  const next = ((await corrected.json()) as CheckInSubmissionResult).receipt;
  expect(next).toEqual({
    ...receipt,
    requestId: fresh.requestId,
    expectedUpdatedAt: receipt.checkIn.createdAt,
    operation: 'corrected',
    checkIn: {
      ...receipt.checkIn,
      feeling: 'same',
      note: fresh.note,
      createdAt: expect.any(String),
    },
  });
  expect(Date.parse(next.checkIn.createdAt)).toBeGreaterThan(Date.parse(receipt.checkIn.createdAt));
  await saved(page);
  expect(await reports(patient, plan)).toEqual([next.checkIn]);
  expect(await reports(doctor, plan)).toEqual([next.checkIn]);
  const history = await read<FollowUpReview[]>(doctor, historyPath(plan));
  expect(history).toHaveLength(1);
  expect(history[0].checkInSnapshots.map((x) => x.snapshot)).toEqual([receipt.checkIn]);
  const shared = await read<FollowUpReview[]>(patient, historyPath(plan));
  expect(shared[0]).not.toHaveProperty('assessment');
  expect(shared[0]).not.toHaveProperty('checkInSnapshots');
  await evidence(doctor, admin, plan, receipt.checkIn.id, 1);
});

test('an exact retry recovers the original report after a correction, clinical review and plan completion', async ({
  page,
  patient,
  doctor,
  admin,
}, info) => {
  test.setTimeout(60000);
  const plan = await newPlan(doctor);
  await page.goto('/my-care/messages');
  await page.getByRole('link', { name: 'My care', exact: true }).click();
  await card(page, plan).getByRole('button', { name: 'Daily check-in', exact: true }).click();
  await field(page, noteLabel).fill('Original report before a later correction');
  await review(page);
  const commands: CheckInSubmissionCommand[] = [];
  let original!: CheckInSubmissionResult;
  await page.route('**' + submitPath, async (route) => {
    commands.push(route.request().postDataJSON());
    const n = commands.length;
    if (n === 2)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"receipt":' });
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(n === 1 ? 201 : 200);
    const result: CheckInSubmissionResult = await upstream.json();
    if (n === 1) {
      original = result;
      return route.abort('connectionreset');
    }
    if (n === 3) result.receipt.actorId = 'another-patient';
    if (n === 4) result.receipt.carePlanId = randomUUID();
    if (n === 5) result.receipt.checkIn.note = 'Different report';
    if (n === 6) result.receipt.operation = 'corrected';
    if (n === 7) result.receipt.date = '2000-01-01';
    if (n === 8) result.receipt.checkIn.createdAt = 'invalid';
    if (n === 9) result.receipt.checkIn.id = commands[0].requestId;
    if (n === 10) result.receipt.requestId = randomUUID();
    return route.fulfill({ response: upstream, json: result });
  });
  await action(page, save).click();
  await expect(action(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('daily-report-retry-320.png'));
  await page.setViewportSize({ width: 1280, height: 860 });
  await action(page, 'Close for now').click();
  await page.goBack();
  await expect(page).toHaveURL('/my-care/messages');
  const current = await writeOtherReport(patient, plan, 'Newer same-day report', 200);
  const completed = await clinicianReview(doctor, plan, true);
  expect(completed.effectiveStatus).toBe('completed');
  const before = await read<FollowUpReview[]>(doctor, historyPath(plan));
  expect(before[0].checkInSnapshots.map((s) => s.snapshot)).toEqual([current]);
  await advancePastClinicMidnight(page, commands[0].date);
  await page.getByRole('link', { name: 'My care', exact: true }).click();
  await button(page, resume).click();
  await expect(dialog(page).locator('time').first()).toHaveAttribute('datetime', commands[0].date);
  for (let n = 2; n <= 10; n++) {
    await send(page, retry);
    await expect(action(page, retry)).toBeEnabled();
    await expect(action(page, 'Review latest report')).toHaveCount(0);
    await expect(action(page, 'Edit check-in')).toHaveCount(0);
  }
  const recovered = await send(page, retry);
  expect(recovered.status()).toBe(200);
  expect(await recovered.json()).toEqual(original);
  expect(commands).toHaveLength(11);
  for (const command of commands) expect(command).toEqual(commands[0]);
  await saved(page);
  await expect(dialog(page)).toContainText(commands[0].note);
  await expect(dialog(page)).not.toContainText(current.note);
  for (const invalid of ['missing', 'older']) {
    await page.route(
      '**' + recordPath,
      async (route) => {
        const upstream = await route.fetch();
        const record = (await upstream.json()) as PatientRecord;
        if (invalid === 'missing')
          record.checkIns = record.checkIns.filter((row) => row.id !== current.id);
        else {
          const entry = record.checkIns.find((row) => row.id === current.id)!;
          entry.createdAt = new Date(
            Date.parse(original.receipt.checkIn.createdAt) - 1,
          ).toISOString();
        }
        await route.fulfill({ response: upstream, json: record });
      },
      { times: 1 },
    );
    await action(page, 'View current report').click();
    await expect(dialog(page).getByRole('alert')).toBeVisible();
    await saved(page);
    await expect(dialog(page)).toContainText(commands[0].note);
  }
  await action(page, 'View current report').click();
  await expect(dialog(page).getByRole('heading', { name: 'Current saved report' })).toBeVisible();
  await expect(dialog(page).locator('time').first()).toHaveAttribute('datetime', commands[0].date);
  await expect(dialog(page)).toContainText(current.note);
  expect(await reports(patient, plan)).toEqual([current]);
  expect((await existingPlan(doctor, plan)).followUpRevision).toBe(completed.followUpRevision);
  expect(await read<FollowUpReview[]>(doctor, historyPath(plan))).toEqual(before);
  await evidence(doctor, admin, plan, current.id, 1);
});

test('a competing correction on the final plan day requires fresh review and keeps that date after midnight', async ({
  page,
  patient,
  doctor,
  admin,
}) => {
  const plan = await newPlan(doctor, 0);
  const first = await writeOtherReport(patient, plan, 'Original wording', 201);
  await visit(page, plan, true);
  await field(page, noteLabel).fill('Draft kept through conflicting writes');
  await field(page, routine).selectOption('taken');
  await review(page);
  const competing = await writeOtherReport(
    patient,
    plan,
    'Competing correction from another tab',
    200,
  );
  const commands: CheckInSubmissionCommand[] = [];
  let rejection!: CheckInNotSaved;
  await page.route('**' + submitPath, async (route) => {
    commands.push(route.request().postDataJSON());
    const n = commands.length;
    if (n === 1) {
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(409);
      rejection = await upstream.json();
      expect(rejection).toMatchObject({
        actorId: patient.session.user!.id,
        code: 'CHECK_IN_NOT_SAVED',
        command: commands[0],
        message: expect.any(String),
      });
      return route.fulfill({ status: 409, json: { error: rejection.message } });
    }
    if (n === 2)
      return route.fulfill({ status: 400, json: { ...rejection, actorId: 'different-user' } });
    if (n === 3)
      return route.fulfill({
        status: 409,
        json: { ...rejection, command: { ...rejection.command, carePlanId: 'other-plan' } },
      });
    if (n === 4)
      return route.fulfill({
        status: 409,
        json: {
          ...rejection,
          command: { ...rejection.command, expectedUpdatedAt: competing.createdAt },
        },
      });
    if (n === 5)
      return route.fulfill({
        status: 403,
        json: { ...rejection, command: { ...rejection.command, note: 'Other draft' } },
      });
    return route.continue();
  });
  await send(page);
  await expect(action(page, retry)).toBeEnabled();
  for (let n = 2; n <= 5; n++) {
    await send(page, retry);
    await expect(action(page, retry)).toBeEnabled();
    await expect(action(page, 'Review latest report')).toHaveCount(0);
  }
  const rejected = await send(page, retry);
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toEqual(rejection);
  await expect(
    dialog(page).getByRole('heading', { name: 'Check-in not saved', exact: true }),
  ).toBeVisible();
  expect(commands[0].date).toBe(plan.endDate);
  await advancePastClinicMidnight(page, plan.endDate);
  await page.route(
    '**' + recordPath,
    async (route) => {
      const upstream = await route.fetch();
      const record = (await upstream.json()) as PatientRecord;
      record.patient.id = 'other-patient';
      await route.fulfill({ response: upstream, json: record });
    },
    { times: 1 },
  );
  await action(page, 'Review latest report').click();
  await expect(dialog(page).getByRole('alert')).toContainText(
    'could not confirm the current report',
  );
  await expect(action(page, 'Review check-in')).toHaveCount(0);
  await action(page, 'Review latest report').click();
  await expect(dialog(page)).toContainText(competing.note);
  await expect(dialog(page)).toContainText('Your draft');
  await expect(field(page, noteLabel)).toHaveValue(commands[0].note);
  await expect(field(page, routine)).toHaveValue('taken');
  await expect(field(page, feeling)).toHaveValue(competing.feeling);
  await field(page, noteLabel).fill('Reconciled after reading the current report');
  await review(page);
  await expect(dialog(page).locator('time').first()).toHaveAttribute('datetime', plan.endDate);
  const confirmed = await send(page);
  expect(confirmed.status()).toBe(201);
  expect(commands[0].expectedUpdatedAt).toBe(first.createdAt);
  for (const command of commands.slice(0, -1)) expect(command).toEqual(commands[0]);
  const fresh = commands.at(-1)!;
  expect(fresh.requestId).not.toBe(commands[0].requestId);
  expect(fresh).toMatchObject({
    date: plan.endDate,
    expectedUpdatedAt: competing.createdAt,
    note: 'Reconciled after reading the current report',
    reviewedConfirmed: true,
  });
  await saved(page);
  const { receipt } = (await confirmed.json()) as CheckInSubmissionResult;
  expect(receipt.checkIn).toMatchObject({
    id: first.id,
    date: plan.endDate,
    note: fresh.note,
    adherence: 'taken',
  });
  expect(await reports(patient, plan)).toEqual([receipt.checkIn]);
  await evidence(doctor, admin, plan, first.id, 2);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
type ReplyObserver = Window & { checkInReplies?: string[]; checkInExpirations?: number };
async function observeReplies(page: Page) {
  await page.evaluate(() => {
    const state = window as ReplyObserver;
    state.checkInReplies = [];
    state.checkInExpirations = 0;
    window.addEventListener('derma:session-expired', () => state.checkInExpirations!++);
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args),
        marker = response.headers.get('X-Test-Check-In-Reply');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.checkInReplies!.push(marker);
          }
        };
      }
      return response;
    };
  });
}
async function consumed(page: Page, marker: string) {
  await expect
    .poll(() => page.evaluate((m) => (window as ReplyObserver).checkInReplies?.includes(m), marker))
    .toBe(true);
  expect(await page.evaluate(() => (window as ReplyObserver).checkInExpirations)).toBe(0);
}

test('late current-report and save responses cannot expire a later route or display an obsolete confirmation', async ({
  page,
  patient,
  doctor,
}) => {
  const first = await newPlan(doctor),
    second = await newPlan(doctor);
  await page.goto('/my-care/messages');
  await page.getByRole('link', { name: 'My care', exact: true }).click();
  await card(page, first).getByRole('button', { name: 'Daily check-in', exact: true }).click();
  await field(page, noteLabel).fill('Earlier report');
  await review(page);
  await send(page);
  await saved(page);
  await observeReplies(page);
  const seenRead = deferred(),
    releaseRead = deferred();
  await page.route(
    '**' + recordPath,
    async (route) => {
      seenRead.resolve();
      await releaseRead.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Check-In-Reply': 'read' },
        json: { error: 'Late patient record response.' },
      });
    },
    { times: 1 },
  );
  await action(page, 'View current report').click();
  await seenRead.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL('/my-care/messages');
    await page.getByRole('link', { name: 'My care', exact: true }).click();
    await card(page, second).getByRole('button', { name: 'Daily check-in', exact: true }).click();
    await field(page, noteLabel).fill('Second plan report');
    await review(page);
  } finally {
    releaseRead.resolve();
  }
  await consumed(page, 'read');
  await expect(dialog(page)).toContainText('Second plan report');
  const seenWrite = deferred(),
    releaseWrite = deferred();
  let command!: CheckInSubmissionCommand, result!: CheckInSubmissionResult;
  await page.route(
    '**' + submitPath,
    async (route) => {
      command = route.request().postDataJSON();
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(201);
      result = await upstream.json();
      seenWrite.resolve();
      await releaseWrite.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Check-In-Reply': 'write' },
        json: { error: 'Late check-in response.' },
      });
    },
    { times: 1 },
  );
  await action(page, save).click();
  await seenWrite.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL('/my-care/messages');
    await page.getByRole('link', { name: 'My care', exact: true }).click();
    await button(page, resume).click();
    await expect(action(page, retry)).toBeEnabled();
  } finally {
    releaseWrite.resolve();
  }
  await consumed(page, 'write');
  await expect(action(page, retry)).toBeEnabled();
  const replay = await send(page, retry);
  expect(replay.status()).toBe(200);
  expect(replay.request().postDataJSON()).toEqual(command);
  expect(await replay.json()).toEqual(result);
  await saved(page);
  await expect(dialog(page)).toContainText('Second plan report');
  expect(await reports(patient, second)).toEqual([result.receipt.checkIn]);
  expect((await reports(patient, first)).map((c) => c.note)).toEqual(['Earlier report']);
});

test('reloading or signing out clears an unresolved report and its private draft', async ({
  page,
  patient,
  doctor,
}) => {
  const plan = await newPlan(doctor);
  await page.route('**' + submitPath, (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic offline test.' } }),
  );
  for (const reset of ['reload', 'sign out']) {
    await visit(page, plan);
    const draft = 'Private synthetic note ' + randomUUID();
    await field(page, noteLabel).fill(draft);
    await review(page);
    await send(page);
    await expect(action(page, retry)).toBeEnabled();
    await action(page, 'Close for now').click();
    await expect(button(page, resume)).toBeEnabled();
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL(/\/login|\/$/);
      await page.goto('/login');
      await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
      await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
      await button(page, 'Sign in').click();
      await expect(page).toHaveURL('/my-care');
    }
    const create = card(page, plan).getByRole('button', { name: 'Daily check-in', exact: true });
    await expect(create).toBeVisible();
    await expect(button(page, resume)).toHaveCount(0);
    await expect(page.getByText(draft, { exact: true })).toHaveCount(0);
    await create.click();
    await expect(field(page, noteLabel)).toHaveValue('');
  }
  expect(await reports(patient, plan)).toEqual([]);
});
