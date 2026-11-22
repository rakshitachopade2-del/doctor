import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { CareMessageCommand, CareMessageResult } from '../../shared/care-message';
import type { ActivityFeed } from '../../shared/activity';
import type { ClinicSettings, Message, Session } from '../../shared/types';

const patientId = 'patient-ananya';
const patientPage = '/my-care/messages';
const clinicPage = `/clinic/patients/${patientId}?tab=messages`;
const thread = `/api/messages?patientId=${patientId}`;
const sendPath = '/api/messages/send';
const sendRoute = `**${sendPath}`;
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const draft = (page: Page, label = 'Your message') =>
  page.getByRole('textbox', { name: label, exact: true });
const retry = (page: Page) => button(page, 'Retry exact message');

async function login(request: APIRequestContext, role: 'patient' | 'doctor' | 'admin') {
  const response = await request.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as Session;
}

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function setMessaging(admin: APIRequestContext, session: Session, enabled: boolean) {
  const { modules } = await get<ClinicSettings>(admin, '/api/settings');
  const response = await admin.patch('/api/settings', {
    headers: { 'X-CSRF-Token': session.csrfToken! },
    data: { modules: { ...modules, followUp: enabled } },
  });
  expect(response.status(), await response.text()).toBe(200);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

async function clickSend(page: Page, label: string) {
  const response = page.waitForResponse(
    (value) => new URL(value.url()).pathname === sendPath && value.request().method() === 'POST',
  );
  await button(page, label).click();
  return response;
}

async function mobileAudit(page: Page, control: Locator, screenshotPath: string) {
  await page.setViewportSize({ width: 320, height: 860 });
  await page.evaluate(() => document.fonts.ready);
  await control.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const audit = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: screenshotPath });
}

test('patient and clinician exchange private messages, retaining the submitted text while a send is pending', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const patient = await login(page.request, 'patient');
  const clinician = await browser.newContext({ baseURL });
  try {
    const doctor = await login(clinician.request, 'doctor');
    await page.goto(patientPage);
    const text = `Private question ${randomUUID()}`;
    await draft(page).fill(`   ${text}   `);
    await mobileAudit(
      page,
      button(page, 'Send message'),
      testInfo.outputPath('patient-message-draft-mobile.png'),
    );
    const seen = deferred(),
      release = deferred();
    await page.route(sendRoute, async (route) => {
      const response = await route.fetch();
      seen.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    const saving = clickSend(page, 'Send message');
    await seen.promise;
    try {
      await expect(draft(page)).not.toBeEditable();
      await expect(draft(page)).toHaveValue(new RegExp(text));
    } finally {
      release.resolve();
    }
    const saved = await saving;
    expect(saved.status()).toBe(201);
    const { receipt } = await saved.json();
    expect(receipt).toMatchObject({
      actorId: patient.user!.id,
      patientId,
      message: {
        body: text,
        patientId,
        authorRole: 'patient',
        authorName: patient.user!.name,
      },
    });
    await expect(draft(page)).toHaveValue('');
    await expect(
      page.locator('.patient-message-thread').getByText(text, { exact: true }),
    ).toBeVisible();
    const clinic = await clinician.newPage();
    await clinic.goto(clinicPage);
    await expect(
      clinic.locator('.clinical-messages').getByText(text, { exact: true }),
    ).toBeVisible();
    const answer = `Private reply ${randomUUID()}`;
    await draft(clinic, 'Message to patient').fill(answer);
    const reply = await clickSend(clinic, 'Send message');
    const original = (await reply.json()).receipt;
    expect(reply.status()).toBe(201);
    expect(original).toMatchObject({
      actorId: doctor.user!.id,
      patientId,
      message: {
        body: answer,
        patientId,
        authorRole: 'doctor',
        authorName: doctor.user!.name,
      },
    });
    await expect(clinic.getByText(/Message saved/).first()).toBeVisible();
    await mobileAudit(
      clinic,
      draft(clinic, 'Message to patient'),
      testInfo.outputPath('clinic-message-confirmed-mobile.png'),
    );
    await button(page, 'Refresh').click();
    await expect(
      page.locator('.patient-message-thread').getByText(answer, { exact: true }),
    ).toBeVisible();
    const summary = await get<unknown>(page.request, `/api/patients/${patientId}/care-summary`);
    const activity = await get<ActivityFeed>(page.request, '/api/activity');
    expect(activity.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'message', href: patientPage })]),
    );
    for (const marker of [text, answer, receipt.requestId, original.requestId]) {
      expect(JSON.stringify(summary)).not.toContain(marker);
      expect(JSON.stringify(activity)).not.toContain(marker);
    }
  } finally {
    await clinician.close();
  }
});

test('a lost committed patient send survives malformed receipts, navigation and a module pause without another message or notice', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  await login(page.request, 'patient');
  const admin = await playwright.request.newContext({ baseURL });
  const staff = await login(admin, 'admin');
  const history = await admin.post(sendPath, {
    headers: { 'X-CSRF-Token': staff.csrfToken! },
    data: { requestId: randomUUID(), patientId, body: 'Earlier private conversation. '.repeat(55) },
  });
  expect(history.status()).toBe(201);
  const before = await get<ActivityFeed>(admin, '/api/activity');
  const body = `Exact recovered message ${randomUUID()}`;
  const commands: CareMessageCommand[] = [];
  let original!: CareMessageResult;
  try {
    await page.goto(patientPage);
    await draft(page).fill(body);
    await page.route(sendRoute, async (route) => {
      commands.push(route.request().postDataJSON());
      if (commands.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        original = await response.json();
        await route.abort('failed');
        return;
      }
      const receipt = original.receipt;
      switch (commands.length) {
        case 2:
          return route.fulfill({ status: 200, json: {} });
        case 3:
          return route.fulfill({
            status: 200,
            json: { receipt: { ...receipt, actorId: 'other-account' } },
          });
        case 4:
          return route.fulfill({
            status: 200,
            json: {
              receipt: {
                ...receipt,
                message: { ...receipt.message, body: 'Other submitted text' },
              },
            },
          });
        case 5:
          return route.fulfill({
            status: 200,
            json: {
              receipt: {
                ...receipt,
                message: { ...receipt.message, authorName: 'Another patient' },
              },
            },
          });
        default:
          return route.continue();
      }
    });
    await button(page, 'Send message').click();
    await expect(retry(page)).toBeEnabled();
    await mobileAudit(page, retry(page), testInfo.outputPath('patient-message-retry-mobile.png'));
    await page.setViewportSize({ width: 1280, height: 720 });
    for (let attempt = 2; attempt <= 5; attempt++) {
      await clickSend(page, 'Retry exact message');
      await expect(retry(page)).toBeEnabled();
      await expect(draft(page)).not.toBeEditable();
      await expect(draft(page)).toHaveValue(body);
    }
    await setMessaging(admin, staff, false);
    await page.getByRole('link', { name: 'My care', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Hello,/ })).toBeVisible();
    const refreshedSettings = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === '/api/settings' && value.request().method() === 'GET',
    );
    await page.goBack();
    expect((await (await refreshedSettings).json()).modules.followUp).toBe(false);
    await expect(page).toHaveURL(/\/my-care\/messages$/);
    await expect(draft(page)).toHaveValue(body);
    await expect(retry(page)).toBeEnabled();
    const replay = await clickSend(page, 'Retry exact message');
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(original);
    await expect(retry(page)).toHaveCount(0);
    await expect(page.getByText(/Message saved/).first()).toBeVisible();
    await expect(button(page, 'Send message')).toHaveCount(0);
    const messages = await get<Message[]>(page.request, thread);
    expect(messages.filter((message) => message.body === body)).toEqual([original.receipt.message]);
    const after = await get<ActivityFeed>(admin, '/api/activity');
    const newNotices = after.items.filter(
      (item) => !before.items.some((old) => old.id === item.id),
    );
    expect(newNotices).toEqual([expect.objectContaining({ kind: 'message', href: clinicPage })]);
    expect(JSON.stringify(newNotices)).not.toContain(body);
    expect(commands).toHaveLength(6);
    for (const command of commands) expect(command).toEqual(commands[0]);
  } finally {
    await setMessaging(admin, staff, true);
    await admin.dispose();
  }
});

test('an uncertain clinician send can be edited only after a matching durable rejection and the next send uses a fresh identity', async ({
  page,
  playwright,
  baseURL,
}) => {
  const doctor = await login(page.request, 'doctor');
  const admin = await playwright.request.newContext({ baseURL });
  const staff = await login(admin, 'admin');
  const body = `Retained clinic draft ${randomUUID()}`;
  const commands: CareMessageCommand[] = [];
  try {
    await page.goto(clinicPage);
    const input = draft(page, 'Message to patient');
    await input.fill(body);
    await page.route(sendRoute, (route) => {
      const command = route.request().postDataJSON();
      commands.push(command);
      if (commands.length === 1) return route.abort('failed');
      if (commands.length === 2)
        return route.fulfill({ status: 403, json: { error: 'No proof of outcome' } });
      if (commands.length === 3)
        return route.fulfill({
          status: 403,
          json: {
            code: 'MESSAGE_NOT_SENT',
            ...command,
            actorId: doctor.user!.id,
            body: 'Different command body',
            message: 'Messaging is paused.',
          },
        });
      return route.continue();
    });
    await button(page, 'Send message').click();
    await expect(retry(page)).toBeEnabled();
    await setMessaging(admin, staff, false);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await clickSend(page, 'Retry exact message');
      await expect(retry(page)).toBeEnabled();
      await expect(input).not.toBeEditable();
      await expect(input).toHaveValue(body);
      await expect(button(page, 'Edit draft')).toHaveCount(0);
    }
    const rejected = await clickSend(page, 'Retry exact message');
    expect(rejected.status()).toBe(403);
    const evidence = await rejected.json();
    expect(evidence).toMatchObject({
      ...commands[0],
      actorId: doctor.user!.id,
      code: 'MESSAGE_NOT_SENT',
    });
    await expect(button(page, 'Edit draft')).toBeVisible();
    await expect(retry(page)).toHaveCount(0);
    await expect(input).toHaveValue(body);
    await setMessaging(admin, staff, true);
    const same = await page.request.post(sendPath, {
      headers: { 'X-CSRF-Token': doctor.csrfToken! },
      data: commands[0],
    });
    expect(same.status()).toBe(403);
    expect(await same.json()).toEqual(evidence);
    await button(page, 'Edit draft').click();
    await expect(input).toBeEditable();
    await expect(input).toHaveValue(body);
    await input.fill(body + ' edited');
    const next = await clickSend(page, 'Send message');
    expect(next.status()).toBe(201);
    expect(commands.slice(0, 4)).toEqual(Array(4).fill(commands[0]));
    expect(commands[4].requestId).not.toBe(commands[0].requestId);
    const messages = await get<Message[]>(page.request, thread);
    expect(messages.filter((message) => message.body.startsWith(body))).toEqual([
      (await next.json()).receipt.message,
    ]);
  } finally {
    await setMessaging(admin, staff, true);
    await admin.dispose();
  }
});

// Mark a response when the app has parsed it. Waiting for the route to be fulfilled
// alone can let a stale-session test finish before the global 401 handler runs.
async function observeReplies(page: Page) {
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const state = window as Window & { messageReplies?: string[]; expiredSessions?: number };
    state.messageReplies = [];
    state.expiredSessions = 0;
    window.addEventListener('derma:session-expired', () => state.expiredSessions!++);
    window.fetch = async (...args) => {
      const response = await original(...args);
      const marker = response.headers.get('X-Test-Message-Response');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.messageReplies!.push(marker);
          }
        };
      }
      return response;
    };
  });
}
async function expectConsumed(page: Page, marker: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          (window as Window & { messageReplies?: string[] }).messageReplies?.includes(value),
        marker,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => (window as Window & { expiredSessions?: number }).expiredSessions),
  ).toBe(0);
}

test('a held clinic success requires an exact retry after Back and a pause on the open conversation disables new sends', async ({
  page,
  playwright,
  baseURL,
}) => {
  await login(page.request, 'doctor');
  await page.goto(clinicPage);
  const body = `Returning clinic conversation ${randomUUID()}`;
  await draft(page, 'Message to patient').fill(body);
  await observeReplies(page);
  const seen = deferred(),
    release = deferred();
  await page.route(
    sendRoute,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      seen.resolve();
      await release.promise;
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'X-Test-Message-Response': 'old-success' },
      });
    },
    { times: 1 },
  );
  await button(page, 'Send message').click();
  await seen.promise;
  try {
    await page.getByRole('link', { name: 'Patients', exact: true }).first().click();
    await expect(page.getByLabel('Search patient directory', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp('/clinic/patients/' + patientId + '\\?tab=messages$'));
    await expect(retry(page)).toBeEnabled();
    await expect(draft(page, 'Message to patient')).toHaveValue(body);
  } finally {
    release.resolve();
  }
  await expectConsumed(page, 'old-success');
  await expect(retry(page)).toBeEnabled();
  await expect(page.getByText(/Message saved/)).toHaveCount(0);
  const admin = await playwright.request.newContext({ baseURL });
  const staff = await login(admin, 'admin');
  try {
    // The clinician stays on the same conversation while a different session pauses messaging.
    await setMessaging(admin, staff, false);
    const checking = deferred(),
      settleCheck = deferred();
    await page.route(
      (url) => url.pathname === '/api/settings',
      async (route) => {
        checking.resolve();
        await settleCheck.promise;
        await route.fulfill({ status: 503, json: { error: 'Settings temporarily unavailable.' } });
      },
      { times: 1 },
    );
    const replay = await clickSend(page, 'Retry exact message');
    expect(replay.status()).toBe(200);
    await checking.promise;
    try {
      await expect(page.getByText(/Message saved by/)).toBeVisible();
      await expect(retry(page)).toHaveCount(0);
      await expect(button(page, 'Send message')).toHaveCount(0);
    } finally {
      settleCheck.resolve();
    }
    await expect(button(page, 'Check availability')).toBeEnabled();
    await expect(page.getByText(/Message saved by/)).toBeVisible();
    await expect(button(page, 'Send message')).toHaveCount(0);
    const refreshedSettings = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === '/api/settings' && value.request().method() === 'GET',
    );
    await button(page, 'Check availability').click();
    expect((await (await refreshedSettings).json()).modules.followUp).toBe(false);
    await expect(page.getByText(/New messages are paused/)).toBeVisible();
    await expect(page.getByText(/Message saved by/)).toBeVisible();
    await expect(button(page, 'Send message')).toHaveCount(0);
    expect(
      (await get<Message[]>(page.request, thread)).filter((message) => message.body === body),
    ).toEqual([(await replay.json()).receipt.message]);
  } finally {
    await setMessaging(admin, staff, true);
    await admin.dispose();
  }
});

test('late conversation reads and writes cannot expire a patient session after leaving and returning', async ({
  page,
}) => {
  const patient = await login(page.request, 'patient');
  await page.goto(patientPage);
  await expect(draft(page)).toBeEditable();
  await observeReplies(page);
  const readSeen = deferred(),
    readRelease = deferred();
  await page.route(
    (url) => url.pathname === '/api/messages',
    async (route) => {
      readSeen.resolve();
      await readRelease.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Message-Response': 'old-read' },
        json: { error: 'Obsolete conversation read.' },
      });
    },
    { times: 1 },
  );
  await button(page, 'Refresh').click();
  await readSeen.promise;
  try {
    await page.getByRole('link', { name: 'My care', exact: true }).click();
    await expect(page).toHaveURL(/\/my-care$/);
    await page.goBack();
    await expect(draft(page)).toBeEditable();
    await draft(page).fill('Draft typed after returning');
  } finally {
    readRelease.resolve();
  }
  await expectConsumed(page, 'old-read');
  await expect(page).toHaveURL(/\/my-care\/messages$/);
  await expect(draft(page)).toHaveValue('Draft typed after returning');
  const sendSeen = deferred(),
    sendRelease = deferred();
  await page.route(
    sendRoute,
    async (route) => {
      sendSeen.resolve();
      await sendRelease.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Message-Response': 'old-write' },
        json: { error: 'Obsolete conversation write.' },
      });
    },
    { times: 1 },
  );
  await button(page, 'Send message').click();
  await sendSeen.promise;
  try {
    await page.getByRole('link', { name: 'Account & security', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Your account & security', exact: true }),
    ).toBeVisible();
  } finally {
    sendRelease.resolve();
  }
  await expectConsumed(page, 'old-write');
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText('Obsolete conversation write.', { exact: true })).toHaveCount(0);
  expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(patient.user!.id);
  await page.goBack();
  await expect(retry(page)).toBeEnabled();
  await page.getByTitle('Sign out', { exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
  await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
  await button(page, 'Sign in').click();
  await page.getByRole('link', { name: 'Clinic messages', exact: true }).click();
  await expect(draft(page)).toHaveValue('');
  await expect(draft(page)).toBeEditable();
  await expect(retry(page)).toHaveCount(0);
});
