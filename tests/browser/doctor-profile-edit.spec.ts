import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import type { DoctorProfileFields } from '../../shared/doctor-profile-creation';
import type {
  DoctorProfileSnapshot as Profile,
  DoctorProfileEditResponse,
} from '../../shared/doctor-profile-edit';
import type { Session } from '../../shared/types';
import {
  type Actor,
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
} from './workflow-fixtures';

const team = '/clinic/settings?tab=team';
const save = 'Save profile changes';
const retry = 'Retry exact edit';
const done = 'Doctor profile updated';
const resume = 'Resume profile edit';
const conflict = 'Profile changed since review';
const row = (page: Page, id: string) => page.locator('[data-doctor-id="' + id + '"]');
const path = (id: string) => '/api/doctors/' + id + '/profile-changes';
const historyPath = (id: string) => '/api/doctors/' + id + '/profile-history';

async function seed(admin: Actor, fields: Partial<DoctorProfileFields> = {}) {
  return post<Profile>(admin, '/api/doctors', {
    name: 'Dr. Synthetic ' + randomUUID().slice(0, 8),
    title: 'Consultant',
    qualifications: 'Original qualification',
    specialties: ['Skin, hair and nails', 'Acne'],
    experience: 0,
    fee: 0,
    bio: '',
    languages: ['Marathi', 'English'],
    color: '#735595',
    ...fields,
  });
}
async function edit(page: Page, id: string) {
  await row(page, id).getByRole('button', { name: 'Edit profile', exact: true }).click();
  await expect(field(page, 'Display name')).toBeVisible();
}
async function review(page: Page) {
  await button(page, 'Review changes').click();
  await expect(title(page, 'Confirm profile changes')).toBeVisible();
  await expect(button(page, save)).toBeDisabled();
  await checkbox(page).check();
}
async function send(page: Page, id: string, label: string, status: number) {
  const received = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path(id) && r.request().method() === 'POST',
  );
  await button(page, label).click();
  const response = await received;
  expect(response.status(), await response.text()).toBe(status);
  return response;
}
async function patch(admin: Actor, doctor: Profile, change: Partial<DoctorProfileFields>) {
  const result = await admin.api.patch('/api/doctors/' + doctor.id, {
    headers: { 'X-CSRF-Token': admin.session.csrfToken! },
    data: { ...doctor, ...change },
  });
  expect(result.status(), await result.text()).toBe(200);
  return (await result.json()) as Profile;
}
async function enter(page: Page) {
  await login(page.request, 'admin');
  await page.goto(team);
}
async function otherAdmin(page: Page, admin: Actor) {
  const email = randomUUID() + '@example.test',
    password = randomUUID(),
    name = 'Other synthetic editor';
  await post(admin, '/api/users', { name, email, password, role: 'admin' });
  const response = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(response.status()).toBe(200);
  const session: Session = await response.json();
  await post(
    { api: page.request, session },
    '/api/auth/password',
    { currentPassword: password, newPassword: randomUUID() },
    200,
  );
  await page.goto(team);
  return name;
}

test('two administrators keep disjoint edits and an untouched list entry containing a comma', async ({
  page,
  admin,
  browser,
}, info) => {
  const doctor = await seed(admin);
  const colleague = await browser.newPage({ baseURL: info.project.use.baseURL });
  try {
    await enter(page);
    const actor = await otherAdmin(colleague, admin);
    await edit(page, doctor.id);
    await field(page, 'Consultation fee (₹)').fill('125.75');
    await review(page);
    await edit(colleague, doctor.id);
    await field(colleague, 'Qualifications').fill('New qualification');
    await review(colleague);
    const first = await (await send(colleague, doctor.id, save, 201)).json();
    await expect(title(colleague, done)).toBeVisible();
    const stale = await (await send(page, doctor.id, save, 409)).json();
    expect(stale.code).toBe('DOCTOR_PROFILE_CHANGED');
    await expect(title(page, conflict)).toBeVisible();
    await button(page, 'Refresh current profile').click();
    await expect(field(page, 'Qualifications')).toHaveValue('New qualification');
    await expect(field(page, 'Consultation fee (₹)')).toHaveValue('125.75');
    await review(page);
    const second = await (await send(page, doctor.id, save, 201)).json();
    expect(second.receipt.actorId).not.toBe(first.receipt.actorId);
    expect(second.receipt.requestId).not.toBe(stale.requestId);
    expect(second.receipt.expectedRevision).toBe(first.receipt.revision);
    expect(second.receipt.before).toEqual(first.receipt.after);
    expect(second.receipt.after).toEqual({
      ...doctor,
      fee: 125.75,
      qualifications: 'New qualification',
    });
    await button(page, 'Done').click();
    await row(page, doctor.id)
      .getByRole('button', { name: 'Profile history', exact: true })
      .click();
    await expect(title(page, 'Doctor profile history')).toBeVisible();
    await expect(dialog(page).locator('article')).toHaveCount(2);
    await expect(dialog(page).locator('article').last()).toContainText(actor);
    const directory = await read<Profile[]>(admin, '/api/doctors');
    expect(directory.find((p) => p.id === doctor.id)).toEqual({
      ...second.receipt.after,
      appointmentDurationMinutes: 30,
      acceptingNewBookings: true,
    });
  } finally {
    await colleague.close();
  }
});

test('conflicting fields require separate choices before a new review', async ({
  page,
  admin,
}, info) => {
  const doctor = await seed(admin);
  await enter(page);
  await edit(page, doctor.id);
  await field(page, 'Professional title').fill('My title');
  await field(page, 'Qualifications').fill('My qualification');
  await review(page);
  const changed = await patch(admin, doctor, {
    title: 'Concurrent title',
    qualifications: 'Concurrent qualification',
  });
  await send(page, doctor.id, save, 409);
  await button(page, 'Refresh current profile').click();
  const advance = button(page, 'Continue editing');
  await expect(advance).toBeDisabled();
  await dialog(page)
    .getByRole('group', { name: 'Professional title', exact: true })
    .getByRole('radio', { name: 'Use current value' })
    .check();
  await expect(advance).toBeDisabled();
  await dialog(page)
    .getByRole('group', { name: 'Qualifications', exact: true })
    .getByRole('radio', { name: 'Keep my edit' })
    .check();
  await mobile(page, 'Continue editing', info.outputPath('conflicts-320.png'));
  await advance.click();
  await expect(field(page, 'Professional title')).toHaveValue(changed.title);
  await expect(field(page, 'Qualifications')).toHaveValue('My qualification');
  await review(page);
  await mobile(page, save, info.outputPath('review-320.png'));
  const saved = await (await send(page, doctor.id, save, 201)).json();
  expect(saved.receipt.before).toEqual(changed);
  expect(saved.receipt.after).toEqual({ ...changed, qualifications: 'My qualification' });
  await expect(title(page, done)).toBeVisible();
});

test('a lost edit confirmation recovers its before and after data after another administrator changes the profile', async ({
  page,
  admin,
}, info) => {
  const storedText = {
    qualifications: 'Qualification one\r\nQualification two',
    bio: 'First paragraph\rSecond paragraph\r\nThird paragraph',
    specialties: ['Skin, hair\r\nand nails', 'Acne'],
    languages: ['Marathi\rEnglish', 'Hindi'],
  };
  const doctor = await seed(admin, storedText);
  expect(doctor).toMatchObject(storedText);
  const commands: Record<string, unknown>[] = [];
  let original: DoctorProfileEditResponse | undefined;
  await page.route('**' + path(doctor.id), async (route) => {
    const attempt = commands.push(route.request().postDataJSON());
    const response = await route.fetch(),
      data = await response.json();
    expect(response.status()).toBe(attempt === 1 ? 201 : 200);
    if (attempt === 1) {
      original = data;
      return route.abort('connectionreset');
    }
    if (attempt === 2) data.receipt.actorId = 'different-actor';
    if (attempt === 3) data.receipt.before.qualifications = 'Incorrect source';
    if (attempt === 4) data.receipt.after.specialties.reverse();
    if (attempt === 5) data.receipt.doctorId = 'different-doctor';
    return route.fulfill({ response, json: data });
  });
  await enter(page);
  await edit(page, doctor.id);
  await field(page, 'Consultation fee (₹)').fill('835');
  await review(page);
  await button(page, save).click();
  await expect(button(page, retry)).toBeEnabled();
  expect(commands[0].profile).toMatchObject(storedText);
  expect(original!.receipt.after).toEqual({ ...doctor, fee: 835 });
  const updated = await patch(admin, original!.receipt.after, {
    fee: 1735,
    title: 'Current title',
  });
  await button(page, 'Close for now').click();
  await row(page, doctor.id).getByRole('button', { name: resume }).click();
  for (let i = 0; i < 4; i++) {
    await send(page, doctor.id, retry, 200);
    await expect(button(page, retry)).toBeEnabled();
    await expect(title(page, done)).toHaveCount(0);
  }
  const result = await (await send(page, doctor.id, retry, 200)).json();
  expect(result).toEqual(original);
  for (const command of commands) expect(command).toEqual(commands[0]);
  await expect(title(page, done)).toBeVisible();
  await expect(dialog(page)).toContainText('835');
  await expect(dialog(page)).not.toContainText('1735');
  await mobile(page, 'Done', info.outputPath('confirmation-320.png'));
  await button(page, 'Done').click();
  expect(
    (await read<Profile[]>(admin, '/api/doctors')).find((p) => p.id === doctor.id),
  ).toMatchObject(updated);
  expect((await read<{ total: number }>(admin, historyPath(doctor.id))).total).toBe(2);
});

test('a profile changed away and back requires a fresh review and the private history can be paged', async ({
  page,
  admin,
  patient,
}, info) => {
  const doctor = await seed(admin);
  await enter(page);
  await edit(page, doctor.id);
  await field(page, 'Professional title').fill('Reviewed title');
  await review(page);
  for (let i = 1; i <= 10; i++) await patch(admin, doctor, { fee: i });
  await patch(admin, doctor, { fee: 0 });
  await send(page, doctor.id, save, 409);
  await button(page, 'Refresh current profile').click();
  await expect(field(page, 'Professional title')).toHaveValue('Reviewed title');
  await review(page);
  await send(page, doctor.id, save, 201);
  await button(page, 'Done').click();
  await row(page, doctor.id).getByRole('button', { name: 'Profile history' }).click();
  await expect(dialog(page).locator('article')).toHaveCount(10);
  await expect(dialog(page).locator('article').first()).toContainText('Reviewed title');
  await button(page, 'Next page').click();
  await expect(dialog(page).locator('article')).toHaveCount(2);
  await expect(dialog(page)).not.toContainText('Reviewed title');
  await mobile(page, 'Previous page', info.outputPath('history-320.png'));
  await button(page, 'Previous page').click();
  await expect(dialog(page).locator('article').first()).toContainText('Reviewed title');
  const denied = await patient.api.get(historyPath(doctor.id));
  expect(denied.status()).toBe(403);
  expect(await denied.text()).not.toContain('Reviewed title');
});

test('a delayed response stays scoped to its profile and an unresolved edit clears at the session boundary', async ({
  page,
  admin,
}) => {
  const first = await seed(admin),
    second = await seed(admin);
  const reached = deferred(),
    release = deferred();
  await enter(page);
  await page.route(
    '**' + path(first.id),
    async (route) => {
      reached.resolve();
      await release.promise;
      await route.fulfill({ status: 401, json: { error: 'Synthetic late response.' } });
    },
    { times: 1 },
  );
  await edit(page, first.id);
  await field(page, 'Professional title').fill('Pending title');
  await review(page);
  await button(page, save).click();
  await reached.promise;
  const late = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path(first.id) && r.status() === 401,
  );
  try {
    await button(page, 'Close for now').click();
    await edit(page, second.id);
  } finally {
    release.resolve();
  }
  await (await late).finished();
  await expect(field(page, 'Display name')).toHaveValue(second.name);
  await page.keyboard.press('Escape');
  await row(page, first.id).getByRole('button', { name: resume }).click();
  const result = await (await send(page, first.id, retry, 201)).json();
  expect(result.receipt.after).toEqual({ ...first, title: 'Pending title' });
  await button(page, 'Done').click();
  let attempts = 0;
  await page.route('**' + path(second.id), (route) => {
    const { requestId, expectedRevision, profile } = route.request().postDataJSON();
    const refusal = {
      code: 'DOCTOR_PROFILE_CHANGED',
      actorId: admin.session.user!.id,
      doctorId: first.id,
      requestId,
      expectedRevision,
      profile,
    };
    return route.fulfill({ status: 409, json: attempts++ ? refusal : { error: 'Unconfirmed' } });
  });
  for (const reset of ['reload', 'sign out']) {
    await edit(page, second.id);
    await field(page, 'Professional title').fill('Discarded pending edit');
    await review(page);
    const failed = await send(page, second.id, save, 409);
    await expect(button(page, retry)).toBeEnabled();
    await button(page, 'Close for now').click();
    await expect(row(page, second.id).getByRole('button', { name: resume })).toBeVisible();
    const stored = await page.evaluate(() =>
      JSON.stringify([
        window.history.state,
        location.href,
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    );
    expect(stored).not.toContain(failed.request().postDataJSON().requestId);
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL('/login');
      await page.getByRole('button', { name: 'Admin', exact: true }).click();
      await expect(page).toHaveURL('/clinic');
      await page.getByRole('link', { name: 'Clinic settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Your team' }).click();
    }
    await expect(
      row(page, second.id).getByRole('button', { name: 'Edit profile', exact: true }),
    ).toBeEnabled();
    await expect(row(page, second.id).getByRole('button', { name: resume })).toHaveCount(0);
  }
  expect((await read<{ total: number }>(admin, historyPath(second.id))).total).toBe(0);
});
