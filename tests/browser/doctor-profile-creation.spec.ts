import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type {
  DoctorProfileCreationCommand,
  DoctorProfileCreationResponse,
  DoctorProfileFields,
} from '../../shared/doctor-profile-creation';
import type { Doctor } from '../../shared/types';
import {
  type Actor,
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
} from './workflow-fixtures';

const team = '/clinic/settings?tab=team';
const create = '/api/doctors/create';
const add = 'Add doctor';
const save = 'Create doctor profile';
const retry = 'Retry exact creation';
const resume = 'Resume doctor profile creation';
const pending = 'Profile creation awaiting confirmation';
const created = 'Doctor profile created';
const action = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

function candidate(): DoctorProfileFields {
  return {
    name: 'Dr. Synthetic ' + randomUUID().slice(0, 8),
    title: 'Consultant',
    qualifications: 'Synthetic qualification',
    specialties: ['Hair and scalp', 'Acne'],
    experience: 0,
    fee: 0,
    bio: 'Synthetic public biography.',
    languages: ['Marathi', 'English'],
    color: '#665588',
  };
}

async function begin(page: Page, p: DoctorProfileFields) {
  await action(page, add).click();
  await field(page, 'Display name').fill('  ' + p.name + '  ');
  await field(page, 'Professional title').fill(p.title);
  await field(page, 'Qualifications').fill(p.qualifications);
  await field(page, 'Years of experience').fill(String(p.experience));
  await field(page, 'Consultation fee (₹)').fill(String(p.fee));
  await field(page, 'Focus areas').fill(p.specialties.join(',  '));
  await field(page, 'About the doctor').fill(p.bio);
  await field(page, 'Languages').fill(p.languages.join(',  '));
  await field(page, 'Profile color').fill(p.color);
}

async function review(page: Page) {
  await button(page, 'Review profile').click();
  await expect(title(page, 'Confirm doctor profile')).toBeVisible();
  await expect(dialog(page).locator('div[tabindex="-1"]')).toBeFocused();
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}

async function displayedProfile(page: Page, p: DoctorProfileFields) {
  const fields = {
    'Display name': p.name,
    'Professional title': p.title,
    Qualifications: p.qualifications,
    'Years of experience': String(p.experience),
    'Consultation fee (₹)': String(p.fee),
    'Focus areas': p.specialties.join(', '),
    Languages: p.languages.join(', '),
    'About the doctor': p.bio || 'Not provided',
    'Profile color': p.color,
  };
  for (const [label, value] of Object.entries(fields)) {
    const row = dialog(page)
      .locator('dl > div')
      .filter({ has: page.getByText(label, { exact: true }) });
    await expect(row.locator('dd')).toHaveText(value);
  }
}

async function send(page: Page, label: string, status: number) {
  const received = page.waitForResponse(
    (r) => new URL(r.url()).pathname === create && r.request().method() === 'POST',
  );
  await button(page, label).click();
  const response = await received;
  expect(response.status()).toBe(status);
  return response;
}

async function directory(admin: Actor, name: string) {
  return (await read<Doctor[]>(admin, '/api/doctors')).filter((d) => d.name === name);
}

async function createdOnce(admin: Actor, id: string) {
  const audit = await read<{ items: { action: string }[] }>(
    admin,
    '/api/search/audit?entityType=doctor&entityId=' + id,
  );
  expect(audit.items.filter((row) => row.action === 'created doctor profile')).toHaveLength(1);
}

test.beforeEach(async ({ page }) => {
  await login(page.request, 'admin');
  await page.goto(team);
});

test('lost confirmation recovers the original public profile after an edit and checks each returned receipt against the review', async ({
  page,
  admin,
}, info) => {
  const p = candidate();
  const commands: DoctorProfileCreationCommand[] = [];
  let original!: DoctorProfileCreationResponse;
  await page.route('**' + create, async (route) => {
    const n = commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    const data = await response.json();
    expect(response.status()).toBe(n === 1 ? 201 : 200);
    if (n === 1) {
      original = data;
      return route.abort('connectionreset');
    }
    if (n === 2) data.receipt.actorId = 'another-admin';
    if (n === 3) data.receipt.requestId = randomUUID();
    if (n === 4) data.receipt.doctor.specialties.reverse();
    if (n === 5) data.receipt.doctor.fee = 300;
    if (n === 6) data.receipt.doctor.acceptingNewBookings = true;
    return route.fulfill({ response, json: data });
  });
  await begin(page, p);
  await review(page);
  await displayedProfile(page, p);
  await mobile(page, save, info.outputPath('review-320.png'));
  await button(page, save).click();
  await expect(title(page, pending)).toBeVisible();
  await expect(button(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('pending-320.png'));
  expect(commands[0]).toEqual({
    ...p,
    reviewedConfirmed: true,
    requestId: original.receipt.requestId,
  });
  expect(original.receipt.doctor).toEqual({ ...p, id: expect.any(String) });
  const id = original.receipt.doctor.id;
  const update = {
    ...p,
    name: p.name + ' amended',
    fee: 650,
    bio: 'Synthetic revised biography.',
    languages: ['Hindi'],
  };
  const amended = await admin.api.patch('/api/doctors/' + id, {
    headers: { 'X-CSRF-Token': admin.session.csrfToken! },
    data: update,
  });
  expect(amended.status()).toBe(200);
  await button(page, 'Close for now').click();
  await action(page, resume).click();
  for (let i = 0; i < 5; i++) {
    await send(page, retry, 200);
    await expect(button(page, retry)).toBeEnabled();
    await expect(title(page, created)).toHaveCount(0);
  }
  expect(await (await send(page, retry, 200)).json()).toEqual(original);
  for (const cmd of commands) expect(cmd).toEqual(commands[0]);
  await expect(title(page, created)).toBeVisible();
  await expect(dialog(page)).toContainText(id);
  await displayedProfile(page, p);
  await expect(dialog(page)).not.toContainText(update.bio);
  await mobile(page, 'Done', info.outputPath('saved-320.png'));
  await button(page, 'Done').click();
  await expect(page.locator('[data-doctor-id="' + id + '"]')).toContainText(update.name);
  expect(await directory(admin, p.name)).toHaveLength(0);
  expect(await directory(admin, update.name)).toEqual([
    { ...update, id, appointmentDurationMinutes: 30, acceptingNewBookings: true },
  ]);
  await createdOnce(admin, id);
});

test('an undelivered creation retries once and a second reviewed matching profile has its own public booking link', async ({
  page,
  admin,
  browser,
}, info) => {
  const p = candidate();
  const commands: DoctorProfileCreationCommand[] = [];
  await page.route('**' + create, async (route) => {
    if (commands.push(route.request().postDataJSON()) === 1) return route.abort('failed');
    return route.continue();
  });
  await begin(page, p);
  await review(page);
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  expect(await directory(admin, p.name)).toHaveLength(0);
  const first: DoctorProfileCreationResponse = await (await send(page, retry, 201)).json();
  await button(page, 'Done').click();
  await begin(page, p);
  await review(page);
  const second: DoctorProfileCreationResponse = await (await send(page, save, 201)).json();
  await expect(title(page, created)).toBeVisible();
  const ids = [first.receipt.doctor.id, second.receipt.doctor.id];
  expect(ids[0]).not.toBe(ids[1]);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[2]).toEqual({ ...commands[0], requestId: second.receipt.requestId });
  expect(second.receipt.requestId).not.toBe(first.receipt.requestId);
  const visitor = await browser.newPage({ baseURL: info.project.use.baseURL });
  try {
    await visitor.goto('/');
    await visitor
      .getByRole('textbox', { name: 'Search doctors, concerns, or languages' })
      .fill(p.name);
    await expect(visitor.getByRole('heading', { name: p.name, exact: true })).toHaveCount(2);
    const bookingLinks = visitor.getByRole('link', { name: 'View availability' });
    await expect(bookingLinks).toHaveCount(2);
    for (const id of ids) {
      await expect(visitor.locator('a[href="/book?doctor=' + id + '"]')).toBeVisible();
      await createdOnce(admin, id);
    }
  } finally {
    await visitor.close();
  }
});

test('editing before confirmation retains zero values and sends only the corrected public details', async ({
  page,
  admin,
}) => {
  const draft = candidate();
  await begin(page, draft);
  await field(page, 'Focus areas').fill(', ,');
  await button(page, 'Review profile').click();
  await expect(title(page, 'Add a doctor')).toBeVisible();
  await field(page, 'Focus areas').fill(draft.specialties.join(', '));
  await review(page);
  await button(page, 'Edit details').click();
  await expect(field(page, 'Years of experience')).toHaveValue('0');
  await expect(field(page, 'Consultation fee (₹)')).toHaveValue('0');
  await expect(field(page, 'Profile color')).toHaveValue(draft.color);
  const final = {
    ...draft,
    name: draft.name + ' revised',
    specialties: ['Dermatology', 'Dermatoscopy'],
    languages: ['French', 'English'],
    fee: 1250.75,
    experience: 80,
    bio: '',
  };
  await field(page, 'Display name').fill(final.name);
  await field(page, 'About the doctor').fill(final.bio);
  await field(page, 'Focus areas').fill(final.specialties.join(', '));
  await field(page, 'Languages').fill(final.languages.join(', '));
  await field(page, 'Consultation fee (₹)').fill(String(final.fee));
  await field(page, 'Years of experience').fill(String(final.experience));
  await review(page);
  await displayedProfile(page, final);
  const result: DoctorProfileCreationResponse = await (await send(page, save, 201)).json();
  expect(result.receipt.doctor).toEqual({ ...final, id: expect.any(String) });
  expect(await directory(admin, draft.name)).toEqual([]);
  expect(await directory(admin, final.name)).toHaveLength(1);
  await button(page, 'Done').click();
  const row = page.locator('[data-doctor-id="' + result.receipt.doctor.id + '"]');
  await row.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await field(page, 'Professional title').fill('Revised consultant title');
  await button(page, 'Save doctor').click();
  await expect(dialog(page)).toHaveCount(0);
  const [current] = await directory(admin, final.name);
  expect(current).toMatchObject({ ...result.receipt.doctor, title: 'Revised consultant title' });
});

test('a late unauthorized response on a different tab leaves the signed-in administrator able to recover the exact profile', async ({
  page,
  admin,
}) => {
  const p = candidate(),
    reached = deferred(),
    deliver = deferred();
  let original!: DoctorProfileCreationResponse;
  await page.route(
    '**' + create,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      original = await response.json();
      reached.resolve();
      await deliver.promise;
      return route.fulfill({ status: 401, json: { error: 'Synthetic stale response.' } });
    },
    { times: 1 },
  );
  await begin(page, p);
  await review(page);
  await button(page, save).click();
  await reached.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === create && r.status() === 401,
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
  await expect(page.getByText(p.name, { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Your team' }).click();
  await action(page, resume).click();
  expect(await (await send(page, retry, 200)).json()).toEqual(original);
  await expect(title(page, created)).toBeVisible();
  await createdOnce(admin, original.receipt.doctor.id);
});

test('an unconfirmed review stays within the signed-in tab and clears on reload and sign-out', async ({
  page,
  admin,
}) => {
  const commands: DoctorProfileCreationCommand[] = [];
  await page.route('**' + create, (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: 'Synthetic request conflict.' } });
  });
  for (const reset of ['reload', 'sign out']) {
    const p = candidate();
    await begin(page, p);
    await review(page);
    await send(page, save, 409);
    await expect(button(page, retry)).toBeEnabled();
    await button(page, 'Close for now').click();
    await expect(action(page, resume)).toBeVisible();
    const state = await page.evaluate(() =>
      JSON.stringify([
        location.href,
        history.state,
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    );
    for (const value of [p.name, commands.at(-1)!.requestId]) expect(state).not.toContain(value);
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL('/login');
      await action(page, 'Admin').click();
      await expect(page).toHaveURL('/clinic');
      await page.getByRole('link', { name: 'Clinic settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Your team' }).click();
    }
    await expect(action(page, add)).toBeEnabled();
    await expect(action(page, resume)).toHaveCount(0);
    expect(await directory(admin, p.name)).toHaveLength(0);
  }
});
