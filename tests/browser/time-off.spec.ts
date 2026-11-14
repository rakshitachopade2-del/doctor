import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type { VisitDurationMutation } from '../../shared/visit-duration';
import type {
  TimeOffContext,
  TimeOffEditValues,
  TimeOffHistory,
  TimeOffMutation,
  TimeOffPage,
  TimeOffValues,
} from '../../shared/time-off';

const base = '/api/time-off';
const editReview = 'I reviewed this time-off change.';
const cancelReview =
  'I understand this cancels the time-off entry while weekly hours and other closures still apply.';
const acknowledge = 'I reviewed the latest time off; keep my draft';
const row = (page: Page, id: string) => page.locator(`.time-off-entry[data-closure-id="${id}"]`);
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const weekly = (page: Page) => page.locator('.weekly-availability-form');
const day = (offset = 35) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const date = new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000);
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};
const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  url: string,
  data: unknown,
  status = 201,
): Promise<T> {
  const response = await request.post(url, { headers, data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function createDoctor(request: APIRequestContext, headers: Record<string, string>) {
  return post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Time off ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 5,
    fee: 650,
    bio: 'Synthetic time-off verification.',
    languages: ['English'],
  });
}
const closure = (
  doctorId: string | null,
  reason = `Operational time off ${randomUUID()}`,
  date = day(),
): TimeOffValues => ({
  doctorId,
  startDate: date,
  endDate: date,
  startTime: '14:00',
  endTime: '15:00',
  reason,
});
const editValues = (context: TimeOffContext): TimeOffEditValues => {
  const { startDate, endDate, startTime, endTime, reason } = context.closure;
  return { startDate, endDate, startTime, endTime, reason };
};
async function create(
  request: APIRequestContext,
  headers: Record<string, string>,
  values: TimeOffValues,
) {
  return post<TimeOffMutation>(request, headers, base, {
    closure: values,
    requestId: randomUUID(),
  });
}
async function change(
  request: APIRequestContext,
  headers: Record<string, string>,
  context: TimeOffContext,
  values: TimeOffEditValues,
  changeReason: string,
) {
  return post<TimeOffMutation>(request, headers, `${base}/${context.closure.id}/changes`, {
    closure: values,
    changeReason,
    expectedRevision: context.revision,
    requestId: randomUUID(),
  });
}
async function cancel(
  request: APIRequestContext,
  headers: Record<string, string>,
  context: TimeOffContext,
  changeReason: string,
) {
  return post<TimeOffMutation>(request, headers, `${base}/${context.closure.id}/cancel`, {
    changeReason,
    expectedRevision: context.revision,
    requestId: randomUUID(),
  });
}
async function open(page: Page, doctorId: string) {
  await page.goto('/clinic/scheduling');
  await page.getByRole('combobox', { name: 'Doctor schedule', exact: true }).selectOption(doctorId);
  await expect(weekly(page).getByLabel('Appointment length', { exact: true })).toBeEnabled();
}
const responseFor = (page: Page, endpoint: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === endpoint && response.request().method() === 'POST',
  );
async function submit(page: Page, title: string, label: string, endpoint: string, status = 201) {
  const wait = responseFor(page, endpoint);
  await dialog(page, title).getByRole('button', { name: label, exact: true }).click();
  const response = await wait;
  expect(response.status(), await response.text()).toBe(status);
  return response;
}
async function addDraft(page: Page, values: TimeOffValues) {
  await page.getByRole('button', { name: 'Add time off', exact: true }).first().click();
  const current = dialog(page, 'Add time off');
  await current.getByLabel('Reason', { exact: true }).fill(values.reason);
  await current.getByLabel('First day', { exact: true }).fill(values.startDate);
  await current.getByLabel('Last day', { exact: true }).fill(values.endDate);
  await current.getByLabel('All day', { exact: true }).setChecked(values.startTime === null);
  if (values.startTime !== null) {
    await current.getByLabel('Unavailable from', { exact: true }).fill(values.startTime);
    await current.getByLabel('Unavailable until', { exact: true }).fill(values.endTime!);
  }
}
async function editDraft(page: Page, id: string, reason: string) {
  await row(page, id).getByRole('button', { name: 'Edit time off', exact: true }).click();
  await dialog(page, 'Edit time off').getByLabel('Reason for change', { exact: true }).fill(reason);
}
async function review(page: Page, title = 'Edit time off') {
  await dialog(page, title)
    .getByLabel(title === 'Cancel time off' ? cancelReview : editReview, { exact: true })
    .check();
}
async function refresh(page: Page) {
  const current = dialog(page, 'Edit time off');
  await current.getByRole('button', { name: 'Refresh latest time off', exact: true }).click();
  await current.getByRole('button', { name: acknowledge, exact: true }).click();
  await expect(current.getByLabel(editReview, { exact: true })).not.toBeChecked();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function audit(page: Page) {
  await page.setViewportSize({ width: 320, height: 860 });
  await page.evaluate(() => document.fonts.ready);
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}

test('reviewed time off protects entire booked visits, preserves weekly drafts and cancels only its own overlapping restriction', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const monday = day(),
    tuesday = nextDay(monday);
  const booked = await post<VisitDurationMutation>(
    page.request,
    admin.headers,
    '/api/visit-duration/bookings',
    {
      doctorId: doctor.id,
      patientId: 'patient-ananya',
      date: monday,
      time: '11:00',
      durationMinutes: 60,
      mode: 'in-person',
      reason: 'Synthetic existing hour-long visit.',
      requestId: randomUUID(),
    },
  );
  await open(page, doctor.id);
  const weeklyReason = `Unsaved weekly review ${randomUUID()}`;
  await weekly(page).getByLabel('Appointment length', { exact: true }).selectOption('20');
  await weekly(page)
    .getByLabel('Reason for availability change', { exact: true })
    .fill(weeklyReason);
  const values = {
    ...closure(doctor.id, undefined, monday),
    endDate: tuesday,
    startTime: '11:30',
    endTime: '12:30',
  };
  await addDraft(page, values);
  await submit(page, 'Add time off', 'Save time off', base, 409);
  await expect(dialog(page, 'Add time off').getByRole('alert')).toContainText(
    'would affect 1 booked appointment',
  );
  await expect(dialog(page, 'Add time off').getByRole('alert')).toContainText(
    'No bookings have been cancelled.',
  );
  await dialog(page, 'Add time off').getByLabel('Unavailable from', { exact: true }).fill('12:00');
  await dialog(page, 'Add time off').getByLabel('Unavailable until', { exact: true }).fill('13:00');
  const saved = (await (
    await submit(page, 'Add time off', 'Save time off', base)
  ).json()) as TimeOffMutation;
  await expect(dialog(page, 'Add time off')).toBeHidden();
  const slots = (date: string) =>
    get<string[]>(page.request, `/api/slots?doctorId=${doctor.id}&date=${date}&mode=in-person`);
  for (const date of [monday, tuesday]) {
    const available = await slots(date);
    expect(available).not.toContain('12:00');
    expect(available).not.toContain('12:30');
    expect(available).toContain('13:00');
  }
  expect(await slots(tuesday)).toContain('11:30');
  const privateEdit = `Private reviewed relocation ${randomUUID()}`;
  await editDraft(page, saved.context.closure.id, privateEdit);
  const edit = dialog(page, 'Edit time off');
  await edit.getByLabel('Unavailable from', { exact: true }).fill('11:30');
  await review(page);
  await submit(
    page,
    'Edit time off',
    'Save time-off changes',
    `${base}/${saved.context.closure.id}/changes`,
    409,
  );
  await expect(edit.getByLabel('Reason for change', { exact: true })).toHaveValue(privateEdit);
  await edit.getByLabel('Unavailable from', { exact: true }).fill('13:00');
  await edit.getByLabel('Unavailable until', { exact: true }).fill('14:00');
  await review(page);
  const edited = (await (
    await submit(
      page,
      'Edit time off',
      'Save time-off changes',
      `${base}/${saved.context.closure.id}/changes`,
    )
  ).json()) as TimeOffMutation;
  expect(edited.context.closure.createdAt).toBe(saved.context.closure.createdAt);
  expect(edited.change.before).toEqual({ closure: saved.context.closure, status: 'active' });
  const overlap = await create(page.request, admin.headers, {
    ...values,
    startTime: '13:30',
    endTime: '14:30',
    reason: 'Separate overlapping operational restriction',
  });
  await row(page, saved.context.closure.id)
    .getByRole('button', { name: 'Cancel time off', exact: true })
    .click();
  const privateCancel = `Private cancellation review ${randomUUID()}`;
  await dialog(page, 'Cancel time off')
    .getByLabel('Reason for change', { exact: true })
    .fill(privateCancel);
  await review(page, 'Cancel time off');
  const cancelled = (await (
    await submit(
      page,
      'Cancel time off',
      'Cancel time off',
      `${base}/${saved.context.closure.id}/cancel`,
    )
  ).json()) as TimeOffMutation;
  expect(cancelled.context.status).toBe('cancelled');
  await expect(page.getByLabel('Time-off view', { exact: true })).toHaveValue('cancelled');
  await expect(row(page, saved.context.closure.id)).toBeVisible();
  await expect(weekly(page).getByLabel('Appointment length', { exact: true })).toHaveValue('20');
  await expect(
    weekly(page).getByLabel('Reason for availability change', { exact: true }),
  ).toHaveValue(weeklyReason);
  const after = await slots(tuesday);
  expect(after).toContain('13:00');
  expect(after).not.toContain('13:30');
  expect(after).not.toContain('14:00');
  expect(after).toContain('14:30');
  expect(
    (await get<Appointment[]>(page.request, '/api/appointments?patientId=patient-ananya')).find(
      (item) => item.id === booked.appointment.id,
    ),
  ).toEqual(booked.appointment);
  const active = await get<{ closures: { id: string }[] }>(page.request, '/api/scheduling');
  expect(active.closures.map((item) => item.id)).toContain(overlap.context.closure.id);
  expect(active.closures.map((item) => item.id)).not.toContain(saved.context.closure.id);
  await row(page, saved.context.closure.id)
    .getByRole('button', { name: 'View time-off history', exact: true })
    .click();
  await expect(dialog(page, 'Time-off history').locator('.time-off-change')).toHaveCount(3);
  await expect(dialog(page, 'Time-off history')).toContainText(privateEdit);
  await expect(dialog(page, 'Time-off history')).toContainText(privateCancel);
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('time-off-history-mobile.png'),
    fullPage: true,
  });
  const patient = await browser.newContext({ baseURL });
  try {
    await login(patient.request, 'patient@derma.demo');
    const portal = await patient.newPage();
    await portal.goto(`/book?doctor=${doctor.id}`);
    await portal.getByLabel('Appointment date', { exact: true }).fill(tuesday);
    const times = portal.getByRole('group', { name: 'Available appointment times', exact: true });
    await expect(times.getByRole('button', { name: '14:30', exact: true })).toBeVisible();
    await expect(times.getByRole('button', { name: '13:00', exact: true })).toBeVisible();
    await expect(times.getByRole('button', { name: '13:30', exact: true })).toHaveCount(0);
    expect(
      (await patient.request.get(`${base}/${saved.context.closure.id}/history`)).status(),
    ).toBe(403);
    const summary = JSON.stringify(
      await get(patient.request, '/api/patients/patient-ananya/care-summary'),
    );
    for (const secret of [privateEdit, privateCancel, values.reason])
      expect(summary).not.toContain(secret);
  } finally {
    await patient.close();
  }
});

test('uncertain create and edited time off retry exact receipts even after later cancellation without reactivating a closure', async ({
  page,
}) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  await open(page, doctor.id);
  await addDraft(page, closure(doctor.id));
  const creates: unknown[] = [];
  let originalCreate: TimeOffMutation | undefined;
  const createFault = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creates.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(creates.length === 1 ? 201 : 200);
    if (creates.length === 1) {
      originalCreate = (await response.json()) as TimeOffMutation;
      return route.fulfill({
        response,
        json: { ...originalCreate, receipt: { ...originalCreate.receipt, changeId: randomUUID() } },
      });
    }
    return route.fulfill({ response });
  };
  await page.route(`**${base}`, createFault);
  try {
    await submit(page, 'Add time off', 'Save time off', base);
    await expect(
      dialog(page, 'Add time off').getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(dialog(page, 'Add time off').getByLabel('Reason', { exact: true })).toBeDisabled();
    await dialog(page, 'Add time off')
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(dialog(page, 'Add time off')).toBeVisible();
    const cancelled = await cancel(
      page.request,
      admin.headers,
      originalCreate!.context,
      'Cancelled independently while the initial response was uncertain.',
    );
    await submit(page, 'Add time off', 'Retry same request', base, 200);
    await expect(dialog(page, 'Add time off')).toBeHidden();
    await expect(page.getByLabel('Time-off view', { exact: true })).toHaveValue('cancelled');
    await expect(row(page, cancelled.context.closure.id)).toBeVisible();
    expect(creates).toHaveLength(2);
    expect(creates[1]).toEqual(creates[0]);
    const history = await get<TimeOffHistory>(
      page.request,
      `${base}/${cancelled.context.closure.id}/history`,
    );
    expect(history.items.filter((item) => item.action === 'created')).toEqual([
      originalCreate!.change,
    ]);
    expect(
      (await get<TimeOffContext>(page.request, `${base}/${cancelled.context.closure.id}`)).status,
    ).toBe('cancelled');
  } finally {
    await page.unroute(`**${base}`, createFault);
  }

  const active = await create(
    page.request,
    admin.headers,
    closure(doctor.id, 'Original operational interval'),
  );
  await open(page, doctor.id);
  const reason = `Private retained edit ${randomUUID()}`;
  await editDraft(page, active.context.closure.id, reason);
  const current = dialog(page, 'Edit time off');
  await current.getByLabel('Unavailable from', { exact: true }).fill('15:00');
  await current.getByLabel('Unavailable until', { exact: true }).fill('16:00');
  await review(page);
  const changed = await change(
    page.request,
    admin.headers,
    active.context,
    { ...editValues(active.context), reason: 'Temporary competing operational description' },
    'Private ABA move away.',
  );
  const restored = await change(
    page.request,
    admin.headers,
    changed.context,
    editValues(active.context),
    'Private ABA return to the original values.',
  );
  expect(restored.context.closure).toEqual(active.context.closure);
  expect(restored.context.revision).not.toBe(active.context.revision);
  const endpoint = `${base}/${active.context.closure.id}/changes`;
  await submit(page, 'Edit time off', 'Save time-off changes', endpoint, 409);
  await expect(current.getByLabel('Reason for change', { exact: true })).toHaveValue(reason);
  await refresh(page);
  await expect(current.getByLabel('Unavailable from', { exact: true })).toHaveValue('15:00');
  await review(page);
  const attempts: unknown[] = [];
  let committed: TimeOffMutation | undefined;
  const editFault = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 2)
      return route.fulfill({
        status: 400,
        json: { error: 'Synthetic later validation failure cannot disprove an earlier commit.' },
      });
    const response = await route.fetch();
    expect(response.status()).toBe(attempts.length === 1 ? 201 : 200);
    const body = (await response.json()) as TimeOffMutation;
    if (attempts.length === 1) {
      committed = body;
      return route.fulfill({
        response,
        json: { ...body, change: { ...body.change, after: null } },
      });
    }
    if (attempts.length === 3)
      return route.fulfill({
        response,
        json: { ...body, receipt: { ...body.receipt, actorId: 'another-account' } },
      });
    return route.fulfill({ response, json: body });
  };
  await page.route(`**${endpoint}`, editFault);
  try {
    await submit(page, 'Edit time off', 'Save time-off changes', endpoint);
    await expect(
      current.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(current.getByLabel('Reason for change', { exact: true })).toBeDisabled();
    await submit(page, 'Edit time off', 'Retry same request', endpoint, 400);
    await expect(
      current.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await submit(page, 'Edit time off', 'Retry same request', endpoint, 200);
    await expect(
      current.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await current.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(current).toBeVisible();
    await cancel(
      page.request,
      admin.headers,
      committed!.context,
      'Independent cancellation after the saved edit.',
    );
    await submit(page, 'Edit time off', 'Retry same request', endpoint, 200);
    await expect(current).toBeHidden();
    await expect(page.getByLabel('Time-off view', { exact: true })).toHaveValue('cancelled');
    await expect(row(page, active.context.closure.id)).toBeVisible();
    expect(attempts).toHaveLength(4);
    for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
    const history = await get<TimeOffHistory>(
      page.request,
      `${base}/${active.context.closure.id}/history`,
    );
    expect(history.items.filter((item) => item.changeReason === reason)).toEqual([
      committed!.change,
    ]);
    expect(
      (await get<TimeOffContext>(page.request, `${base}/${active.context.closure.id}`)).status,
    ).toBe('cancelled');
  } finally {
    await page.unroute(`**${endpoint}`, editFault);
  }
});

test('an uncommitted aborted edit can recover from a definitive stale retry with retained intent and a newly reviewed request', async ({
  page,
}) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const created = await create(page.request, admin.headers, closure(doctor.id));
  const endpoint = `${base}/${created.context.closure.id}/changes`;
  await open(page, doctor.id);
  const reason = `Reviewed retained abort draft ${randomUUID()}`;
  await editDraft(page, created.context.closure.id, reason);
  const current = dialog(page, 'Edit time off');
  await current.getByLabel('Unavailable until', { exact: true }).fill('16:00');
  await review(page);
  const attempts: { requestId: string; expectedRevision: string }[] = [];
  const firstAbort = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) return route.abort('failed');
    return route.continue();
  };
  await page.route(`**${endpoint}`, firstAbort);
  try {
    const failed = page.waitForEvent(
      'requestfailed',
      (request) => new URL(request.url()).pathname === endpoint,
    );
    await current.getByRole('button', { name: 'Save time-off changes', exact: true }).click();
    await failed;
    await expect(
      current.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    expect(
      (await get<TimeOffHistory>(page.request, `${base}/${created.context.closure.id}/history`))
        .items,
    ).toEqual([created.change]);
    const other = await change(
      page.request,
      admin.headers,
      created.context,
      { ...editValues(created.context), endTime: '15:30' },
      'Concurrent time-off change before the aborted request was ever saved.',
    );
    await submit(page, 'Edit time off', 'Retry same request', endpoint, 409);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(current.getByLabel('Reason for change', { exact: true })).toHaveValue(reason);
    await expect(current.getByLabel('Unavailable until', { exact: true })).toHaveValue('16:00');
    await refresh(page);
    await expect(current.getByLabel('Reason for change', { exact: true })).toHaveValue(reason);
    await review(page);
    const saved = (await (
      await submit(page, 'Edit time off', 'Save time-off changes', endpoint)
    ).json()) as TimeOffMutation;
    await expect(current).toBeHidden();
    expect(attempts).toHaveLength(3);
    expect(attempts[2].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[2].expectedRevision).toBe(other.context.revision);
    const history = await get<TimeOffHistory>(
      page.request,
      `${base}/${created.context.closure.id}/history`,
    );
    expect(history.items).toHaveLength(3);
    expect(history.items.filter((item) => item.changeReason === reason)).toEqual([saved.change]);
  } finally {
    await page.unroute(`**${endpoint}`, firstAbort);
  }
});

test('time-off history stays private and paginated while stale reads and saves cannot affect a later schedule view', async ({
  page,
  browser,
  playwright,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const otherDoctor = await createDoctor(page.request, admin.headers);
  const created = await create(page.request, admin.headers, closure(doctor.id));
  const other = await create(page.request, admin.headers, closure(otherDoctor.id));
  const clinic = await create(
    page.request,
    admin.headers,
    closure(null, 'Clinic-wide operational closure', day(63)),
  );
  const suffix = randomUUID();
  let latest = created;
  for (let index = 1; index <= 25; index++) {
    latest = await change(
      page.request,
      admin.headers,
      latest.context,
      { ...editValues(latest.context), reason: `Operational explanation ${index}` },
      `Private time-off history ${suffix} ${index}`,
    );
  }
  const id = created.context.closure.id;
  const historyPattern = `**${base}/${id}/history?*`;
  let unavailable = true;
  const fault = async (route: Route) =>
    unavailable
      ? route.fulfill({
          status: 503,
          json: { error: 'Synthetic time-off history is temporarily unavailable.' },
        })
      : route.continue();
  await page.route(historyPattern, fault);
  try {
    await open(page, doctor.id);
    await row(page, id).getByRole('button', { name: 'View time-off history', exact: true }).click();
    await expect(dialog(page, 'Time-off history').getByRole('alert')).toContainText(
      'Synthetic time-off history',
    );
    unavailable = false;
    await dialog(page, 'Time-off history')
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect(dialog(page, 'Time-off history').locator('.time-off-change')).toHaveCount(25);
  } finally {
    await page.unroute(historyPattern, fault);
  }
  const pagination = dialog(page, 'Time-off history').getByRole('navigation', {
    name: 'Time-off history pagination',
    exact: true,
  });
  await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(dialog(page, 'Time-off history').locator('.time-off-change')).toHaveCount(1);
  await pagination.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(dialog(page, 'Time-off history').locator('.time-off-change')).toHaveCount(25);
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('time-off-paged-history-mobile.png'),
    fullPage: true,
  });
  await dialog(page, 'Time-off history')
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click();
  await page.setViewportSize({ width: 1280, height: 900 });

  const physician = await playwright.request.newContext({ baseURL });
  try {
    const account = await login(physician, 'doctor@derma.demo');
    const own = await create(
      page.request,
      admin.headers,
      closure(account.session.user!.doctorId!, 'Own doctor operational absence', day(77)),
    );
    expect((await physician.get(`${base}/${own.context.closure.id}`)).status()).toBe(200);
    expect((await physician.get(`${base}/${own.context.closure.id}/history`)).status()).toBe(200);
    for (const denied of [id, clinic.context.closure.id]) {
      expect((await physician.get(`${base}/${denied}`)).status()).toBe(403);
      expect((await physician.get(`${base}/${denied}/history`)).status()).toBe(403);
      expect(
        (
          await physician.post(`${base}/${denied}/cancel`, {
            headers: account.headers,
            data: {
              expectedRevision: latest.context.revision,
              requestId: randomUUID(),
              changeReason: 'Unauthorized cancellation',
            },
          })
        ).status(),
      ).toBe(403);
    }
  } finally {
    await physician.dispose();
  }
  const reception = await browser.newContext({ baseURL });
  try {
    await login(reception.request, 'reception@derma.demo');
    const staff = await reception.newPage();
    await staff.goto('/clinic/scheduling');
    await staff.getByLabel('Doctor schedule', { exact: true }).selectOption(doctor.id);
    await expect(row(staff, id)).toBeVisible();
    await expect(row(staff, clinic.context.closure.id)).toBeVisible();
    await expect(row(staff, other.context.closure.id)).toHaveCount(0);
    for (const label of [
      'Add time off',
      'Edit time off',
      'Cancel time off',
      'View time-off history',
    ])
      await expect(staff.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    const safe = await get<TimeOffPage>(
      reception.request,
      `${base}?doctorId=${doctor.id}&filter=all`,
    );
    expect(safe.items.map((item) => item.closure.id)).toEqual(
      expect.arrayContaining([id, clinic.context.closure.id]),
    );
    expect(safe.items.map((item) => item.closure.id)).not.toContain(other.context.closure.id);
    for (const item of safe.items) expect(Object.keys(item).sort()).toEqual(['closure', 'status']);
    expect(JSON.stringify(safe)).not.toContain(suffix);
    expect((await reception.request.get(`${base}/${id}/history`)).status()).toBe(403);
    await audit(staff);
    await staff.screenshot({
      path: testInfo.outputPath('time-off-readonly-mobile.png'),
      fullPage: true,
    });
  } finally {
    await reception.close();
  }

  await page.evaluate(() => {
    const state = window as unknown as {
      timeOffBodies: Record<string, number>;
      timeOffExpired: number;
    };
    state.timeOffBodies = {};
    state.timeOffExpired = 0;
    window.addEventListener('derma:session-expired', () => state.timeOffExpired++);
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(url, window.location.origin).pathname;
      if (pathname.startsWith('/api/time-off')) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            const key = `${init?.method ?? 'GET'} ${pathname} ${response.status}`;
            state.timeOffBodies[key] = (state.timeOffBodies[key] ?? 0) + 1;
          }
        };
      }
      return response;
    };
  });
  const arrived = deferred(),
    releaseRead = deferred();
  let heldReads = 0,
    settledReads = 0;
  const lateRead = async (route: Route) => {
    heldReads++;
    arrived.resolve();
    await releaseRead.promise;
    try {
      await route.fulfill({
        status: 401,
        json: { error: 'Obsolete time-off history must not expire the current session.' },
      });
    } finally {
      settledReads++;
    }
  };
  await page.route(historyPattern, lateRead);
  try {
    await row(page, id).getByRole('button', { name: 'View time-off history', exact: true }).click();
    await arrived.promise;
    await dialog(page, 'Time-off history')
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await page.getByLabel('Doctor schedule', { exact: true }).selectOption(otherDoctor.id);
    await expect(row(page, other.context.closure.id)).toBeVisible();
    const count = heldReads;
    releaseRead.resolve();
    await expect.poll(() => settledReads).toBe(count);
    await page.waitForFunction(
      ({ key, count }) =>
        (window as unknown as { timeOffBodies: Record<string, number> }).timeOffBodies[key] >=
        count,
      { key: `GET ${base}/${id}/history 401`, count },
    );
    expect(
      await page.evaluate(() => (window as unknown as { timeOffExpired: number }).timeOffExpired),
    ).toBe(0);
    expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(
      admin.session.user!.id,
    );
    await expect(page.getByLabel('Doctor schedule', { exact: true })).toHaveValue(otherDoctor.id);
  } finally {
    releaseRead.resolve();
    await page.unroute(historyPattern, lateRead);
  }

  await editDraft(
    page,
    other.context.closure.id,
    'Delayed edit must not reopen an obsolete modal.',
  );
  await dialog(page, 'Edit time off')
    .getByLabel('Unavailable until', { exact: true })
    .fill('16:00');
  await review(page);
  const endpoint = `${base}/${other.context.closure.id}/changes`;
  const ready = deferred(),
    release = deferred(),
    done = deferred();
  let committed: TimeOffMutation | undefined;
  const heldSave = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = (await response.json()) as TimeOffMutation;
    ready.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } finally {
      done.resolve();
    }
  };
  await page.route(`**${endpoint}`, heldSave);
  try {
    await dialog(page, 'Edit time off')
      .getByRole('button', { name: 'Save time-off changes', exact: true })
      .click();
    await ready.promise;
    await dialog(page, 'Edit time off')
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await expect(dialog(page, 'Edit time off')).toBeVisible();
    await page.evaluate(() => {
      window.history.pushState({ key: 'time-off-command-away' }, '', '/clinic');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: /^A good day for better care/ })).toBeVisible();
    await page.goBack();
    await page.getByLabel('Doctor schedule', { exact: true }).selectOption(doctor.id);
    await expect(row(page, id)).toBeVisible();
    release.resolve();
    await done.promise;
    await page.waitForFunction(
      (key) =>
        (window as unknown as { timeOffBodies: Record<string, number> }).timeOffBodies[key] >= 1,
      `POST ${endpoint} 201`,
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByLabel('Doctor schedule', { exact: true })).toHaveValue(doctor.id);
    await expect(page.getByText('Time off updated.', { exact: true })).toHaveCount(0);
    const history = await get<TimeOffHistory>(
      page.request,
      `${base}/${other.context.closure.id}/history`,
    );
    expect(history.items.filter((item) => item.action === 'edited')).toEqual([committed!.change]);
  } finally {
    release.resolve();
    await page.unroute(`**${endpoint}`, heldSave);
  }
});
