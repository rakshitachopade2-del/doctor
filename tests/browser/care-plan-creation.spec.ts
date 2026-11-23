import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  CarePlanCreationCommand,
  CarePlanCreationResult,
  CarePlanFields,
} from '../../shared/care-plan-creation';
import type { ActivityFeed } from '../../shared/activity';
import type { CarePlan, Session } from '../../shared/types';

const patientId = 'patient-ananya';
const recordPath = '/clinic/patients/' + patientId;
const createPath = '/api/care-plans/create';
const share = 'Save and share care plan';
const retry = 'Retry exact creation';
const modal = (page: Page) => page.getByRole('dialog');
const button = (target: Page | Locator, name: string) =>
  target.getByRole('button', { name, exact: true });
const ack = (page: Page) =>
  modal(page).getByRole('checkbox', {
    name: 'I reviewed this care plan and confirm it is ready to share.',
  });
const shared = (page: Page) =>
  modal(page).getByRole('heading', { name: 'Care plan shared', exact: true });
const field = (page: Page, label: string) => modal(page).getByLabel(label, { exact: true });

function planFields(withItems = false): CarePlanFields {
  return {
    title: 'Synthetic plan ' + randomUUID().slice(0, 8),
    instructions: 'Bring the written questions to the scheduled review.',
    expectations: 'The clinician will review the patient’s notes.',
    warnings: 'Contact the clinic for clarification.',
    cost: 'Discussed separately',
    startDate: '2027-05-12',
    endDate: '2027-05-26',
    followUpDate: '2027-06-02',
    medications: withItems
      ? ['First', 'Second'].map((label) => ({
          name: label + ' synthetic item',
          instructions: label + ' instruction',
          schedule: label + ' schedule',
          duration: label + ' duration',
          warnings: label + ' precaution',
        }))
      : [],
  };
}

async function login(api: APIRequestContext, role: 'doctor' | 'patient') {
  const response = await api.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as Session;
}
async function read<T>(api: APIRequestContext, path: string): Promise<T> {
  const result = await api.get(path);
  expect(result.status(), await result.text()).toBe(200);
  return result.json();
}
async function openDraft(page: Page, fields: CarePlanFields) {
  await button(page, 'Care plan').click();
  await field(page, 'Plan title').fill(' ' + fields.title + ' ');
  await field(page, 'Instructions').fill(fields.instructions);
  await field(page, 'Start date').fill(fields.startDate);
  await field(page, 'End / review date').fill(fields.endDate);
  await field(page, 'Follow-up date').fill(fields.followUpDate);
  await field(page, 'Expected cost').fill(fields.cost);
  await field(page, 'What to expect').fill(fields.expectations);
  await field(page, 'Precautions and when to contact the clinic').fill(fields.warnings);
  for (const [index, item] of fields.medications.entries()) {
    await button(modal(page), 'Add item').click();
    for (const [label, value] of [
      ['Medication / treatment name', item.name],
      ['Dose and instructions', item.instructions],
      ['Schedule', item.schedule],
      ['Duration', item.duration],
      ['Item-specific warnings', item.warnings],
    ])
      await field(page, label)
        .nth(index)
        .fill(' ' + value + ' ');
  }
}
async function review(page: Page) {
  await button(modal(page), 'Review care plan').click();
  await expect(ack(page)).not.toBeChecked();
  await ack(page).check();
}
async function send(page: Page, name: string) {
  const response = page.waitForResponse(
    (res) => new URL(res.url()).pathname === createPath && res.request().method() === 'POST',
  );
  await button(modal(page), name).click();
  return response;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function mobile(page: Page, control: Locator, path: string) {
  await page.setViewportSize({ width: 320, height: 860 });
  await page.evaluate(() => document.fonts.ready);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path });
}

test('clinician reviews dates, ordered treatment items and attribution and the patient receives the exact shared plan', async ({
  page,
  browser,
  baseURL,
}, info) => {
  const account = await login(page.request, 'doctor');
  const patient = await browser.newContext({ baseURL });
  try {
    await login(patient.request, 'patient');
    const plan = planFields(true);
    await page.goto(recordPath);
    await openDraft(page, plan);
    await field(page, 'Follow-up date').fill('2027-05-11');
    await button(modal(page), 'Review care plan').click();
    await expect(ack(page)).toHaveCount(0);
    await field(page, 'Follow-up date').fill(plan.followUpDate);
    await review(page);
    await expect(modal(page)).toContainText('Dr. Meera Shah');
    await expect(modal(page)).toContainText('Ananya Sharma');
    for (const value of [
      plan.title,
      plan.instructions,
      plan.expectations,
      plan.cost,
      plan.warnings,
      ...plan.medications.flatMap((item) => Object.values(item)),
    ])
      await expect(modal(page)).toContainText(value);
    await button(modal(page), 'Edit plan').click();
    plan.instructions += ' Bring a copy.';
    await field(page, 'Instructions').fill(plan.instructions);
    await review(page);
    await mobile(page, button(modal(page), share), info.outputPath('care-plan-review-mobile.png'));
    const response = await send(page, share);
    expect(response.status()).toBe(201);
    const result: CarePlanCreationResult = await response.json();
    const command = response.request().postDataJSON();
    expect(command).toEqual({
      ...plan,
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      patientId,
      doctorId: account.user!.doctorId,
      reviewedConfirmed: true,
    });
    expect(result.receipt).toMatchObject({
      actorId: account.user!.id,
      patientId,
      doctorId: command.doctorId,
      requestId: command.requestId,
      plan: {
        ...plan,
        patientId,
        doctorId: command.doctorId,
        patientName: 'Ananya Sharma',
        doctorName: 'Dr. Meera Shah',
        status: 'active',
      },
    });
    await expect(shared(page)).toBeVisible();
    await expect(modal(page)).toContainText(plan.instructions);
    await mobile(
      page,
      button(modal(page), 'Close care plan'),
      info.outputPath('care-plan-confirmed-mobile.png'),
    );
    await button(modal(page), 'Close care plan').click();
    await expect(page.getByRole('heading', { name: plan.title, exact: true })).toBeVisible();
    const notices = (
      await read<ActivityFeed>(patient.request, '/api/activity?limit=100')
    ).items.filter((item) => item.detail === plan.title);
    expect(notices).toEqual([
      expect.objectContaining({
        kind: 'care-plan',
        href: '/my-care?plan=' + result.receipt.plan.id,
      }),
    ]);
    const portal = await patient.newPage();
    await portal.goto(notices[0].href);
    const card = portal.getByRole('region', { name: plan.title + ' treatment plan' });
    await expect(card.getByRole('heading', { name: plan.title })).toBeVisible();
    for (const item of plan.medications) await expect(card).toContainText(item.name);
    const summary = await read<{ carePlans: CarePlan[] }>(
      patient.request,
      '/api/patients/' + patientId + '/care-summary',
    );
    expect(summary.carePlans.filter((item) => item.title === plan.title)).toEqual([
      expect.objectContaining({ medications: plan.medications, instructions: plan.instructions }),
    ]);
    expect(JSON.stringify(summary)).not.toContain(command.requestId);
  } finally {
    await patient.close();
  }
});

test('lost commits, unrelated errors and incorrect receipts recover the original creation after completion with one plan and one notice', async ({
  page,
  playwright,
  baseURL,
}, info) => {
  const account = await login(page.request, 'doctor');
  const patient = await playwright.request.newContext({ baseURL });
  try {
    await login(patient, 'patient');
    const plan = planFields(true);
    await page.goto(recordPath);
    await openDraft(page, plan);
    await review(page);
    let saved!: CarePlanCreationResult;
    const commands: CarePlanCreationCommand[] = [];
    await page.route('**' + createPath, async (route) => {
      commands.push(route.request().postDataJSON());
      if (commands.length === 1) {
        const upstream = await route.fetch();
        expect(upstream.status()).toBe(201);
        saved = await upstream.json();
        return route.abort('failed');
      }
      const { receipt } = saved;
      switch (commands.length) {
        case 2:
          return route.fulfill({ json: {} });
        case 3:
          return route.fulfill({ json: { receipt: { ...receipt, actorId: 'other-account' } } });
        case 4:
          return route.fulfill({ json: { receipt: { ...receipt, doctorId: 'doctor-arjun' } } });
        case 5:
          return route.fulfill({
            json: {
              receipt: {
                ...receipt,
                plan: { ...receipt.plan, medications: [...receipt.plan.medications].reverse() },
              },
            },
          });
        case 6:
          return route.fulfill({
            status: 409,
            json: { error: 'This request ID has already been used.' },
          });
        default:
          return route.continue();
      }
    });
    await button(modal(page), share).click();
    await expect(button(modal(page), retry)).toBeEnabled();
    await expect(button(modal(page), 'Edit plan')).toHaveCount(0);
    await mobile(page, button(modal(page), retry), info.outputPath('care-plan-retry-mobile.png'));
    await button(modal(page), 'Close dialog').click();
    await button(page, 'Resume care plan').click();
    for (let n = 2; n <= 6; n++) {
      await send(page, retry);
      await expect(button(modal(page), retry)).toBeEnabled();
      await expect(shared(page)).toHaveCount(0);
    }
    const complete = await page.request.patch('/api/care-plans/' + saved.receipt.plan.id, {
      headers: { 'X-CSRF-Token': account.csrfToken! },
      data: { status: 'completed' },
    });
    expect(complete.status(), await complete.text()).toBe(200);
    expect((await complete.json()).effectiveStatus).toBe('completed');
    const recovered = await send(page, retry);
    expect(recovered.status()).toBe(200);
    expect(await recovered.json()).toEqual(saved);
    await expect(shared(page)).toBeVisible();
    const current = (await read<CarePlan[]>(patient, '/api/care-plans')).filter(
      (item) => item.title === plan.title,
    );
    expect(current).toEqual([
      expect.objectContaining({ id: saved.receipt.plan.id, effectiveStatus: 'completed' }),
    ]);
    const notices = (await read<ActivityFeed>(patient, '/api/activity?limit=100')).items.filter(
      (item) => item.title === 'Your care plan is ready' && item.detail === plan.title,
    );
    expect(notices).toHaveLength(1);
    expect(commands).toHaveLength(7);
    for (const cmd of commands) expect(cmd).toEqual(commands[0]);
  } finally {
    await patient.dispose();
  }
});

test('a stale reviewed professional requires a durable matching rejection and explicit review under the current professional', async ({
  page,
}) => {
  const account = await login(page.request, 'doctor');
  // Keep the real session authorized while reproducing stale professional data already shown in the tab.
  await page.route('**/api/session', async (route) => {
    const upstream = await route.fetch();
    const session = await upstream.json();
    await route.fulfill({
      response: upstream,
      json: { ...session, user: { ...session.user, doctorId: 'doctor-arjun' } },
    });
  });
  await page.goto(recordPath);
  const plan = planFields();
  await openDraft(page, plan);
  await review(page);
  await expect(modal(page)).toContainText('Dr. Arjun Rao');
  await page.unroute('**/api/session');
  const commands: CarePlanCreationCommand[] = [];
  let rejection!: Record<string, unknown>;
  await page.route('**' + createPath, async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    if (commands.length === 1) {
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(409);
      rejection = await upstream.json();
      expect(rejection).toMatchObject({
        code: 'CARE_PLAN_NOT_CREATED',
        actorId: account.user!.id,
        command,
      });
      return route.abort('failed');
    }
    if (commands.length === 2)
      return route.fulfill({
        status: 409,
        json: { ...rejection, command: { ...command, title: 'Different plan' } },
      });
    return route.continue();
  });
  await button(modal(page), share).click();
  await expect(button(modal(page), retry)).toBeEnabled();
  await send(page, retry);
  await expect(button(modal(page), retry)).toBeEnabled();
  await expect(button(modal(page), 'Review draft')).toHaveCount(0);
  const denied = await send(page, retry);
  expect(denied.status()).toBe(409);
  expect(await denied.json()).toEqual(rejection);
  await expect(modal(page).getByRole('alert')).toContainText('Care plan was not created');
  await button(modal(page), 'Review draft').click();
  await expect(field(page, 'Plan title')).toHaveValue(plan.title);
  await expect(field(page, 'Instructions')).toHaveValue(plan.instructions);
  await review(page);
  await expect(modal(page)).toContainText('Dr. Meera Shah');
  const created = await send(page, share);
  expect(created.status()).toBe(201);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[1]).toEqual(commands[2]);
  expect(commands[3].requestId).not.toBe(commands[2].requestId);
  expect(commands[3].doctorId).toBe(account.user!.doctorId);
  await expect(shared(page)).toBeVisible();
});

async function watchLateReplies(page: Page) {
  await page.evaluate(() => {
    const state = window as Window & { planReplies?: string[]; planExpirations?: number };
    state.planReplies = [];
    state.planExpirations = 0;
    window.addEventListener('derma:session-expired', () => state.planExpirations!++);
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await fetch(...args);
      const marker = res.headers.get('X-Test-Plan-Reply');
      if (marker) {
        const decode = res.json.bind(res);
        res.json = async () => {
          try {
            return await decode();
          } finally {
            state.planReplies!.push(marker);
          }
        };
      }
      return res;
    };
  });
}
async function consumed(page: Page, marker: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (value) => (window as Window & { planReplies?: string[] }).planReplies?.includes(value),
        marker,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => (window as Window & { planExpirations?: number }).planExpirations),
  ).toBe(0);
}

test('dismissing a draft guards the next dialog against an obsolete authorization response from the author lookup', async ({
  page,
}) => {
  await login(page.request, 'doctor');
  await page.goto(recordPath);
  await expect(button(page, 'Care plan')).toBeEnabled();
  await watchLateReplies(page);
  const seen = deferred(),
    release = deferred();
  await page.route(
    '**/api/doctors',
    async (route) => {
      seen.resolve();
      await release.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Plan-Reply': 'old-author' },
        json: { error: 'Obsolete author lookup.' },
      });
    },
    { times: 1 },
  );
  await button(page, 'Care plan').click();
  await seen.promise;
  try {
    await button(modal(page), 'Close dialog').click();
    await openDraft(page, planFields());
    await field(page, 'Plan title').fill('Next draft');
  } finally {
    release.resolve();
  }
  await consumed(page, 'old-author');
  await expect(field(page, 'Plan title')).toHaveValue('Next draft');
  await review(page);
  await expect(modal(page)).toContainText('Dr. Meera Shah');
});

test('a late write cannot dismiss or unlock the recovered command after navigation and Back', async ({
  page,
}) => {
  await login(page.request, 'doctor');
  await page.goto(recordPath);
  await watchLateReplies(page);
  const plan = planFields();
  await openDraft(page, plan);
  await review(page);
  const first = deferred(),
    finishFirst = deferred(),
    second = deferred(),
    finishSecond = deferred();
  const commands: CarePlanCreationCommand[] = [];
  await page.route('**' + createPath, async (route) => {
    commands.push(route.request().postDataJSON());
    const upstream = await route.fetch();
    if (commands.length === 1) {
      expect(upstream.status()).toBe(201);
      first.resolve();
      await finishFirst.promise;
      return route.fulfill({
        status: 401,
        headers: { 'X-Test-Plan-Reply': 'old-write' },
        json: { error: 'Obsolete creation response.' },
      });
    }
    expect(upstream.status()).toBe(200);
    second.resolve();
    await finishSecond.promise;
    await route.fulfill({ response: upstream });
  });
  await button(modal(page), share).click();
  await first.promise;
  try {
    await button(modal(page), 'Close dialog').click();
    await page.getByRole('link', { name: 'All patients', exact: true }).click();
    await expect(page.getByLabel('Search patient directory', { exact: true })).toBeVisible();
    await page.goBack();
    await button(page, 'Resume care plan').click();
    await button(modal(page), retry).click();
    await second.promise;
    finishFirst.resolve();
    await consumed(page, 'old-write');
    await expect(shared(page)).toHaveCount(0);
    await expect(button(modal(page), 'Sharing…')).toBeDisabled();
    await expect(button(modal(page), 'Edit plan')).toHaveCount(0);
  } finally {
    finishFirst.resolve();
    finishSecond.resolve();
  }
  await expect(shared(page)).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  const plans = await read<CarePlan[]>(page.request, '/api/care-plans');
  expect(plans.filter((value) => value.title === plan.title)).toHaveLength(1);
});
