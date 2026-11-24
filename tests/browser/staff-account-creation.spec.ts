import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type {
  StaffAccountCreationReview,
  StaffAccountCreationResponse,
} from '../../shared/staff-account-creation';
import type { Session, User } from '../../shared/types';
import {
  button,
  checkbox,
  deferred,
  dialog,
  field,
  login,
  mobile,
  read,
  test,
  title,
  type Actor,
} from './workflow-fixtures';

const team = '/clinic/settings?tab=team';
const createEndpoint = '/api/users/create';
const outcomeEndpoint = '/api/users/creation-outcome';
const save = 'Create account';
const check = 'Check creation outcome';
const resume = 'Resume staff account creation';
const created = 'Staff account created';
const refused = 'Staff account not created';
const uncertain = 'Account creation awaiting confirmation';
const action = (page: Page, label: string) =>
  page.getByRole('button', { name: label, exact: true });
const identity = () => {
  const suffix = randomUUID().slice(0, 8);
  return { name: 'Synthetic staff ' + suffix, email: 'staff-' + suffix + '@example.test' };
};
const syntheticPassword = () => 'Synthetic-only-' + randomUUID();
type Candidate = ReturnType<typeof identity>;

async function begin(page: Page, candidate: Candidate, password: string) {
  await action(page, 'Add team member').click();
  await field(page, 'Full name').fill(candidate.name);
  await field(page, 'Email address').fill(candidate.email);
  await field(page, 'Initial password').fill(password);
}

async function focusedState(page: Page, label: string) {
  await expect(title(page, label)).toBeVisible();
  await expect(dialog(page).locator('div[tabindex="-1"]')).toBeFocused();
}

async function review(page: Page) {
  await button(page, 'Review account').click();
  await focusedState(page, 'Confirm staff account');
  await expect(dialog(page).locator('input[type=password]')).toHaveCount(0);
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}

async function send(page: Page, label: string, path: string, status: number) {
  const received = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
  );
  await button(page, label).click();
  const response = await received;
  expect(response.status()).toBe(status);
  return response;
}

async function privateBrowserState(page: Page, values: string[]) {
  const state = await page.evaluate(() =>
    JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      history: history.state,
      url: location.href,
    }),
  );
  expect(values.every((value) => !state.includes(value))).toBe(true);
}

async function accounts(admin: Actor, email: string) {
  return read<User[]>(admin, '/api/accounts?search=' + encodeURIComponent(email));
}

async function createdOnce(admin: Actor, id: string) {
  const { items } = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=user&entityId=' + id,
  );
  expect(items.filter((row) => row.action === 'created staff account')).toHaveLength(1);
}

test.beforeEach(async ({ page }) => {
  await login(page.request, 'admin');
  await page.goto(team);
});

test('an administrator checks a lost creation receipt after password rotation and account edits without resending a credential', async ({
  page,
  admin,
  playwright,
}, info) => {
  const who = identity(),
    password = syntheticPassword(),
    replacement = syntheticPassword();
  let original!: StaffAccountCreationResponse;
  let reviewed!: StaffAccountCreationReview;
  let creations = 0;
  const checks: StaffAccountCreationReview[] = [];
  await page.route('**' + createEndpoint, async (route) => {
    const { password: supplied, ...details } = route.request().postDataJSON();
    expect(supplied === password).toBe(true);
    reviewed = details;
    creations++;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    original = await response.json();
    return route.abort('connectionreset');
  });
  await page.route('**' + outcomeEndpoint, async (route) => {
    const attempt = checks.push(route.request().postDataJSON());
    const response = await route.fetch();
    const data: StaffAccountCreationResponse = await response.json();
    if (attempt === 1) data.receipt.actorId = 'another-administrator';
    if (attempt === 2) data.receipt.account.mustChangePassword = false;
    if (attempt === 3) data.receipt.account.doctorId = 'doctor-arjun';
    if (attempt === 4) data.receipt.account.email = 'other@example.test';
    return route.fulfill({ response, json: data });
  });
  await begin(
    page,
    { ...who, name: '  ' + who.name + '  ', email: who.email.toUpperCase() },
    password,
  );
  await field(page, 'Role').selectOption('doctor');
  await field(page, 'Linked doctor profile').selectOption('doctor-meera');
  await review(page);
  await expect(dialog(page)).toContainText(who.email);
  await expect(dialog(page)).not.toContainText(password);
  await mobile(page, save, info.outputPath('review-320.png'));
  await button(page, save).click();
  await focusedState(page, uncertain);
  await expect(button(page, check)).toBeEnabled();
  expect(reviewed).toEqual({
    ...who,
    requestId: original.receipt.requestId,
    role: 'doctor',
    doctorId: 'doctor-meera',
    reviewedConfirmed: true,
  });
  await mobile(page, check, info.outputPath('uncertain-320.png'));
  await privateBrowserState(page, [password, who.email, who.name, reviewed.requestId]);
  await button(page, 'Close for now').click();
  const user = original.receipt.account;
  expect(user).toEqual({
    ...who,
    id: expect.any(String),
    role: 'doctor',
    doctorId: 'doctor-meera',
    active: true,
    mustChangePassword: true,
  });
  const person = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    const signedIn = await person.post('/api/auth/login', { data: { email: who.email, password } });
    expect(signedIn.status()).toBe(200);
    const session: Session = await signedIn.json();
    expect(session.user?.mustChangePassword).toBe(true);
    const changed = await person.post('/api/auth/password', {
      headers: { 'X-CSRF-Token': session.csrfToken! },
      data: { currentPassword: password, newPassword: replacement },
    });
    expect(changed.status()).toBe(200);
    const amended = await admin.api.patch('/api/accounts/' + user.id, {
      headers: { 'X-CSRF-Token': admin.session.csrfToken! },
      data: { name: who.name + ' amended', role: 'receptionist', doctorId: null },
    });
    expect(amended.status()).toBe(200);
    await action(page, resume).click();
    for (let i = 0; i < 4; i++) {
      await send(page, check, outcomeEndpoint, 200);
      await expect(button(page, check)).toBeEnabled();
      await expect(title(page, created)).toHaveCount(0);
    }
    const receipt = await (await send(page, check, outcomeEndpoint, 200)).json();
    expect(receipt).toEqual(original);
    await focusedState(page, created);
    await expect(dialog(page)).toContainText(user.id);
    await expect(dialog(page)).toContainText(who.email);
    await expect(dialog(page)).toContainText('doctor-meera');
    await expect(dialog(page)).toContainText('Password change required');
    await expect(dialog(page).getByRole('link', { name: 'View current accounts' })).toHaveAttribute(
      'href',
      '/clinic/accounts',
    );
    await expect(dialog(page)).not.toContainText(who.name + ' amended');
    await mobile(page, 'Done', info.outputPath('created-320.png'));
    expect(checks).toHaveLength(5);
    for (const body of checks) expect(body).toEqual(reviewed);
    expect(creations).toBe(1);
    await button(page, 'Done').click();
    await expect(page.getByText(who.name + ' amended', { exact: true })).toBeVisible();
    const current = await accounts(admin, who.email);
    expect(current).toEqual([
      {
        ...who,
        id: user.id,
        name: who.name + ' amended',
        role: 'receptionist',
        active: true,
        mustChangePassword: false,
      },
    ]);
    const teamMembers = await read<User[]>(admin, '/api/users');
    expect(teamMembers.find((row) => row.id === user.id)).toEqual(current[0]);
    await createdOnce(admin, user.id);
    expect(
      (await person.post('/api/auth/login', { data: { email: who.email, password } })).status(),
    ).toBe(401);
    expect(
      (
        await person.post('/api/auth/login', { data: { email: who.email, password: replacement } })
      ).status(),
    ).toBe(200);
  } finally {
    await person.dispose();
  }
});

test('an undelivered request is closed before a fresh review and password can create a replacement', async ({
  page,
  admin,
  playwright,
}, info) => {
  const who = identity(),
    first = syntheticPassword(),
    second = syntheticPassword();
  const attempts: StaffAccountCreationReview[] = [];
  await page.route('**' + createEndpoint, async (route) => {
    const { password, ...details } = route.request().postDataJSON();
    const n = attempts.push(details);
    expect(password === (n === 1 ? first : second)).toBe(true);
    return n === 1 ? route.abort('failed') : route.continue();
  });
  let checks = 0;
  await page.route('**' + outcomeEndpoint, async (route) => {
    expect(route.request().postDataJSON()).toEqual(attempts[0]);
    const response = await route.fetch();
    const data = await response.json();
    if (++checks === 1) data.review.email = 'wrong-person@example.test';
    return route.fulfill({ response, json: data });
  });
  await begin(page, who, first);
  await review(page);
  await button(page, save).click();
  await focusedState(page, uncertain);
  await send(page, check, outcomeEndpoint, 409);
  await expect(button(page, check)).toBeEnabled();
  await expect(title(page, refused)).toHaveCount(0);
  const refusal = await (await send(page, check, outcomeEndpoint, 409)).json();
  await focusedState(page, refused);
  await mobile(page, 'Edit account details', info.outputPath('not-created-320.png'));
  expect(attempts).toHaveLength(1);
  expect(await accounts(admin, who.email)).toEqual([]);
  const delayed = await admin.api.post(createEndpoint, {
    headers: { 'X-CSRF-Token': admin.session.csrfToken! },
    data: { ...attempts[0], password: first },
  });
  expect(delayed.status()).toBe(409);
  expect(await delayed.json()).toEqual(refusal);
  await button(page, 'Edit account details').click();
  await expect(field(page, 'Email address')).toHaveValue(who.email);
  await expect(field(page, 'Initial password')).toHaveValue('');
  await field(page, 'Initial password').fill(second);
  await review(page);
  const saved: StaffAccountCreationResponse = await (
    await send(page, save, createEndpoint, 201)
  ).json();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual({ ...attempts[0], requestId: saved.receipt.requestId });
  expect(attempts[1].requestId).not.toBe(attempts[0].requestId);
  await focusedState(page, created);
  expect(await accounts(admin, who.email)).toEqual([saved.receipt.account]);
  await createdOnce(admin, saved.receipt.account.id);
  const person = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    expect(
      (
        await person.post('/api/auth/login', { data: { email: who.email, password: first } })
      ).status(),
    ).toBe(401);
    expect(
      (
        await person.post('/api/auth/login', { data: { email: who.email, password: second } })
      ).status(),
    ).toBe(200);
  } finally {
    await person.dispose();
  }
});

test('doctor linkage and duplicate-email corrections require an explicit review of the final staff role', async ({
  page,
  admin,
}) => {
  const who = identity();
  const previous = await accounts(admin, 'admin@derma.demo');
  await begin(page, { ...who, email: 'admin@derma.demo' }, syntheticPassword());
  await field(page, 'Role').selectOption('doctor');
  await button(page, 'Review account').click();
  await expect(title(page, 'Confirm staff account')).toHaveCount(0);
  await field(page, 'Linked doctor profile').selectOption('doctor-arjun');
  await field(page, 'Role').selectOption('receptionist');
  await review(page);
  const outcome = await (await send(page, save, createEndpoint, 409)).json();
  await focusedState(page, refused);
  expect(outcome.review).toMatchObject({
    role: 'receptionist',
    doctorId: null,
    email: 'admin@derma.demo',
  });
  expect(await accounts(admin, 'admin@derma.demo')).toEqual(previous);
  await button(page, 'Edit account details').click();
  await field(page, 'Email address').fill(who.email);
  await expect(field(page, 'Initial password')).toHaveValue('');
  await field(page, 'Initial password').fill(syntheticPassword());
  await field(page, 'Role').selectOption('admin');
  await field(page, 'Linked doctor profile').selectOption('doctor-arjun');
  await review(page);
  const saved: StaffAccountCreationResponse = await (
    await send(page, save, createEndpoint, 201)
  ).json();
  await focusedState(page, created);
  expect(saved.receipt.account).toMatchObject({ ...who, role: 'admin', doctorId: 'doctor-arjun' });
  expect(saved.receipt.requestId).not.toEqual(outcome.review.requestId);
  await createdOnce(admin, saved.receipt.account.id);
});

test('a late response on another settings tab cannot expire the session or erase the pending review', async ({
  page,
  admin,
}) => {
  const who = identity(),
    reached = deferred(),
    deliver = deferred();
  await page.route('**' + createEndpoint, async (route) => {
    const actual = await route.fetch();
    expect(actual.status()).toBe(201);
    reached.resolve();
    await deliver.promise;
    return route.fulfill({ status: 401, json: { message: 'Synthetic expired response' } });
  });
  await begin(page, who, syntheticPassword());
  await review(page);
  await button(page, save).click();
  await reached.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === createEndpoint && r.status() === 401,
  );
  try {
    await button(page, 'Close for now').click();
    await page.getByRole('tab', { name: 'Clinic profile' }).click();
    await expect(page.getByRole('tab', { name: 'Clinic profile' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  } finally {
    deliver.resolve();
  }
  await (await late).finished();
  await expect(page).toHaveURL(/clinic\/settings/);
  await expect(page.getByText(who.email, { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Your team' }).click();
  await action(page, resume).click();
  const saved: StaffAccountCreationResponse = await (
    await send(page, check, outcomeEndpoint, 200)
  ).json();
  await focusedState(page, created);
  expect(saved.receipt.account).toMatchObject(who);
  await createdOnce(admin, saved.receipt.account.id);
});

test('a malformed confirmation retains only a same-session review and clears on reload or sign-out', async ({
  page,
  admin,
}) => {
  let reviewId = '';
  await page.route('**' + createEndpoint, async (route) => {
    reviewId = route.request().postDataJSON().requestId;
    return route.fulfill({ status: 200, json: { receipt: { requestId: reviewId } } });
  });
  for (const reset of ['reload', 'sign out']) {
    const who = identity(),
      password = syntheticPassword();
    await begin(page, who, password);
    await review(page);
    await send(page, save, createEndpoint, 200);
    await focusedState(page, uncertain);
    await expect(dialog(page)).not.toContainText(password);
    await expect(dialog(page).locator('input[type=password]')).toHaveCount(0);
    await privateBrowserState(page, [who.name, who.email, password, reviewId]);
    await button(page, 'Close for now').click();
    await expect(action(page, resume)).toBeVisible();
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL('/login');
      await page.getByRole('button', { name: 'Admin', exact: true }).click();
      await expect(page).toHaveURL('/clinic');
      await page.getByRole('link', { name: 'Clinic settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Your team' }).click();
    }
    await expect(action(page, 'Add team member')).toBeEnabled();
    await expect(action(page, resume)).toHaveCount(0);
    await expect(page.getByText(who.email, { exact: true })).toHaveCount(0);
    expect(await accounts(admin, who.email)).toEqual([]);
  }
});
