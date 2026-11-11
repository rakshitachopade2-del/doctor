import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Route,
  type Locator,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Session, User } from '../../shared/types';
import type {
  AttendanceContext,
  AttendanceDetail,
  AttendanceMutation,
  AttendanceReport,
  AttendanceStaff,
} from '../../shared/attendance';

const clinicToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const day = (offset: number) =>
  new Date(Date.parse(`${clinicToday()}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const utc = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`).toISOString();
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function staff(request: APIRequestContext, headers: Record<string, string>, name: string) {
  const response = await request.post('/api/users', {
    headers,
    data: {
      name,
      email: `attendance-${randomUUID()}@example.test`,
      password: 'AttendanceFixture2026!',
      role: 'receptionist',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as User;
}
async function manual(
  request: APIRequestContext,
  headers: Record<string, string>,
  userId: string,
  startedAt: string,
  endedAt: string,
  reason: string,
) {
  const context = await get<AttendanceContext>(request, `/api/attendance/staff/${userId}/context`);
  const response = await request.post('/api/attendance/shifts', {
    headers,
    data: {
      userId,
      startedAt,
      endedAt,
      reason,
      requestId: randomUUID(),
      expectedRevision: context.revision,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as AttendanceMutation;
}
async function detail(request: APIRequestContext, id: string) {
  return get<AttendanceDetail>(request, `/api/attendance/shifts/${id}`);
}
async function report(request: APIRequestContext, from: string, to: string, userId: string) {
  return get<AttendanceReport>(
    request,
    `/api/attendance?${new URLSearchParams({ from, to, userId })}`,
  );
}
async function audit(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const notices = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await notices.count()) await notices.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}
async function fillInterval(
  dialog: Locator,
  from: string,
  start: string,
  to: string,
  end: string,
  reason: string,
) {
  await dialog.getByLabel('Start date (IST)', { exact: true }).fill(from);
  await dialog.getByLabel('Start time (IST)', { exact: true }).fill(start);
  await dialog.getByLabel('End date (IST)', { exact: true }).fill(to);
  await dialog.getByLabel('End time (IST)', { exact: true }).fill(end);
  await dialog.getByLabel('Reason', { exact: true }).fill(reason);
}
async function applyReport(page: Page, from: string, to: string, userId: string) {
  await page.getByRole('button', { name: 'Team timesheet', exact: true }).click();
  await page.getByLabel('From date', { exact: true }).fill(from);
  await page.getByLabel('To date', { exact: true }).fill(to);
  await page.getByLabel('Staff member', { exact: true }).selectOption(userId);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('view') === 'team' &&
      url.searchParams.get('from') === from &&
      url.searchParams.get('to') === to &&
      url.searchParams.get('staff') === userId,
  );
  await expect(page.getByLabel('From date', { exact: true })).toHaveValue(from);
  await expect(page.getByLabel('To date', { exact: true })).toHaveValue(to);
  await expect(page.getByLabel('Staff member', { exact: true })).toHaveValue(userId);
}
async function holdCommitted(page: Page, path: string, outcome: 'lost' | 'malformed') {
  let release!: () => void, arrived!: () => void, finished!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let body: Record<string, unknown> | undefined;
  let saved: AttendanceMutation | undefined;
  let used = false;
  const handler = async (route: Route) => {
    if (used || route.request().method() !== 'POST') return route.continue();
    used = true;
    try {
      body = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBeTruthy();
      saved = (await response.json()) as AttendanceMutation;
      arrived();
      await gate;
      await route.fulfill({
        status: outcome === 'lost' ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          outcome === 'lost'
            ? { error: 'Synthetic response lost after attendance was recorded.' }
            : { ...saved, event: { ...saved.event, after: null } },
        ),
      });
    } finally {
      finished();
    }
  };
  await page.route(`**${path}`, handler);
  return {
    ready,
    body: () => body,
    saved: () => saved!,
    release: async () => {
      release();
      if (used) await done;
      await page.unroute(`**${path}`, handler);
    },
  };
}
async function retryExact(
  page: Page,
  dialog: Locator,
  path: string,
  body: Record<string, unknown> | undefined,
) {
  expect(body).toBeDefined();
  const request = page.waitForRequest(
    (value) => value.method() === 'POST' && new URL(value.url()).pathname === path,
  );
  const response = page.waitForResponse(
    (value) => value.request().method() === 'POST' && new URL(value.url()).pathname === path,
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await request).postDataJSON()).toEqual(body);
  expect((await response).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await closeSavedEntry(page);
}
async function closeSavedEntry(page: Page) {
  const entry = page.getByRole('dialog', { name: 'Attendance entry', exact: true });
  await expect(entry).toBeVisible();
  await entry.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(entry).toHaveCount(0);
}

test('staff clock their own attendance safely through lost and malformed responses without duplicate shifts', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const { session, headers } = await login(page.request, 'reception@derma.demo');
  const before = await get<AttendanceContext>(page.request, '/api/attendance/me');
  expect(before.staff.id).toBe(session.user!.id);
  expect(before.openShift).toBeNull();
  await page.goto('/clinic/attendance');
  const clock = page.getByRole('region', { name: 'My clock status', exact: true });
  await clock.getByRole('button', { name: 'Clock in', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Clock in', exact: true });
  const incoming = await holdCommitted(page, '/api/attendance/clock-in', 'lost');
  try {
    await dialog.getByRole('button', { name: 'Confirm clock in', exact: true }).click();
    await incoming.ready;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
  } finally {
    await incoming.release();
  }
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  const open = await get<AttendanceContext>(page.request, '/api/attendance/me');
  expect(open.openShift?.id).toBe(incoming.saved().shift.id);
  expect((await detail(page.request, open.openShift!.id)).events).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await page.getByRole('button', { name: 'Resume pending attendance update', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Clock in', exact: true });
  await retryExact(page, dialog, '/api/attendance/clock-in', incoming.body());
  expect((await detail(page.request, open.openShift!.id)).events).toHaveLength(1);
  await expect(clock.getByRole('button', { name: 'Clock out', exact: true })).toBeVisible();

  const duplicate = await page.request.post('/api/attendance/clock-in', {
    headers,
    data: { expectedRevision: open.revision, requestId: randomUUID() },
  });
  expect(duplicate.status(), await duplicate.text()).toBe(409);
  expect((await get<AttendanceContext>(page.request, '/api/attendance/me')).openShift?.id).toBe(
    open.openShift!.id,
  );
  const outgoingPath = `/api/attendance/shifts/${open.openShift!.id}/clock-out`;
  await clock.getByRole('button', { name: 'Clock out', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Clock out', exact: true });
  const outgoing = await holdCommitted(page, outgoingPath, 'malformed');
  try {
    await dialog.getByRole('button', { name: 'Confirm clock out', exact: true }).click();
    await outgoing.ready;
  } finally {
    await outgoing.release();
  }
  await expect(dialog.getByRole('alert')).toContainText('could not be confirmed');
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  const committed = await detail(page.request, open.openShift!.id);
  expect(committed.shift.status).toBe('closed');
  expect(committed.events).toHaveLength(2);
  await retryExact(page, dialog, outgoingPath, outgoing.body());
  const closed = await detail(page.request, open.openShift!.id);
  expect(closed.events).toEqual(committed.events);
  expect(closed.shift.endedAt).toBe(committed.shift.endedAt);
  expect(closed.shift.recordedSeconds).toBe(
    Math.floor((Date.parse(closed.shift.endedAt!) - Date.parse(closed.shift.startedAt)) / 1000),
  );
  expect((await get<AttendanceContext>(page.request, '/api/attendance/me')).openShift).toBeNull();
  await expect(clock.getByRole('button', { name: 'Clock in', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Record missed attendance', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Team timesheet', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View attendance entry', exact: true }).click();
  const entry = page.getByRole('dialog', { name: 'Attendance entry', exact: true });
  await expect(entry.getByRole('button', { name: 'Correct entry', exact: true })).toHaveCount(0);
  await expect(entry.getByRole('button', { name: 'Void mistaken entry', exact: true })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('attendance-own-history-mobile.png'),
    fullPage: true,
  });
});

test('administrators record missed attendance, review concurrent corrections and preserve original entries when voiding', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const { session, headers } = await login(page.request);
  const suffix = randomUUID().slice(0, 8);
  const person = await staff(page.request, headers, `Attendance correction ${suffix}`);
  const date = day(-10);
  const originalReason = `Missed entry documented ${suffix}`;
  await page.goto('/clinic/attendance');
  await page.getByRole('button', { name: 'Record missed attendance', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Record missed attendance', exact: true });
  await dialog.getByLabel('Attendance staff', { exact: true }).selectOption(person.id);
  await fillInterval(dialog, date, '09:00', date, '17:00', originalReason);
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/attendance/shifts',
  );
  await dialog.getByRole('button', { name: 'Save missed attendance', exact: true }).click();
  const created = (await (await createdResponse).json()) as AttendanceMutation;
  await expect(dialog).toHaveCount(0);
  await closeSavedEntry(page);
  expect(created.shift).toMatchObject({
    userId: person.id,
    source: 'manual',
    status: 'closed',
    startedAt: utc(date, '09:00'),
    endedAt: utc(date, '17:00'),
    recordedSeconds: 28800,
  });
  expect(created.event).toMatchObject({
    operation: 'manual-entry',
    createdById: session.user!.id,
    reason: originalReason,
    before: null,
  });
  await applyReport(page, date, date, person.id);
  let row = page.locator('.attendance-report-table tbody tr').filter({ hasText: person.name });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'View attendance entry', exact: true }).click();
  let entry = page.getByRole('dialog', { name: 'Attendance entry', exact: true });
  await expect(entry.getByText(originalReason, { exact: true })).toBeVisible();
  await entry.getByRole('button', { name: 'Correct entry', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Correct attendance entry', exact: true });
  const intendedReason = `Reviewed adjustment ${suffix}`;
  await fillInterval(dialog, date, '09:15', date, '17:00', intendedReason);
  const competingReason = `Concurrent verified update ${suffix}`;
  const correctionPath = `/api/attendance/shifts/${created.shift.id}/corrections`;
  const competing = await page.request.post(correctionPath, {
    headers,
    data: {
      startedAt: utc(date, '08:45'),
      endedAt: utc(date, '17:00'),
      reason: competingReason,
      expectedRevision: created.shift.revision,
      requestId: randomUUID(),
    },
  });
  expect(competing.ok(), await competing.text()).toBeTruthy();
  const competingMutation = (await competing.json()) as AttendanceMutation;
  const staleRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === correctionPath,
  );
  const staleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === correctionPath,
  );
  await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
  const staleBody = (await staleRequest).postDataJSON();
  expect((await staleResponse).status()).toBe(409);
  await expect(dialog.getByLabel('Start time (IST)', { exact: true })).toHaveValue(
    /^09:15(?::00)?$/,
  );
  await expect(dialog.getByLabel('Reason', { exact: true })).toHaveValue(intendedReason);
  await expect(dialog.getByRole('button', { name: 'Save correction', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Refresh latest attendance', exact: true }).click();
  await expect(dialog.locator('.attendance-reviewed-context')).toContainText(competingReason);
  await expect(dialog.locator('.attendance-reviewed-context')).toContainText(
    new Date(utc(date, '08:45')).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'medium',
    }),
  );
  await dialog
    .getByRole('button', { name: 'I reviewed the latest attendance; keep my draft', exact: true })
    .click();
  await expect(dialog.getByLabel('Start time (IST)', { exact: true })).toHaveValue(
    /^09:15(?::00)?$/,
  );
  await expect(dialog.getByLabel('Reason', { exact: true })).toHaveValue(intendedReason);
  const correctedRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === correctionPath,
  );
  await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
  const correctedBody = (await correctedRequest).postDataJSON();
  expect(correctedBody.requestId).not.toBe(staleBody.requestId);
  expect(correctedBody.expectedRevision).toBe(competingMutation.shift.revision);
  expect(correctedBody.expectedRevision).not.toBe(staleBody.expectedRevision);
  await expect(dialog).toHaveCount(0);
  const corrected = await detail(page.request, created.shift.id);
  expect(corrected.shift).toMatchObject({
    source: 'manual',
    userId: person.id,
    startedAt: utc(date, '09:15'),
    endedAt: utc(date, '17:00'),
    recordedSeconds: 27900,
  });
  expect(corrected.events).toHaveLength(3);
  expect(corrected.events.find((event) => event.operation === 'manual-entry')).toEqual(
    created.event,
  );
  expect(corrected.events.find((event) => event.reason === intendedReason)?.before).toMatchObject({
    startedAt: utc(date, '08:45'),
  });
  await page.goto(`/clinic/attendance?entry=${created.shift.id}`);
  entry = page.getByRole('dialog', { name: 'Attendance entry', exact: true });
  await expect(entry.getByText(originalReason, { exact: true })).toBeVisible();
  await expect(entry.getByText(competingReason, { exact: true })).toBeVisible();
  await expect(entry.getByText(intendedReason, { exact: true })).toBeVisible();
  await entry.getByRole('button', { name: 'Void mistaken entry', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Void mistaken entry', exact: true });
  const voidReason = `Entry assigned in error ${suffix}; original evidence retained`;
  await dialog.getByLabel('Reason', { exact: true }).fill(voidReason);
  await dialog.getByRole('button', { name: 'Void entry', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect((await detail(page.request, created.shift.id)).shift.status).toBe('closed');
  await dialog
    .getByRole('checkbox', {
      name: 'I confirm this attendance entry was recorded by mistake',
      exact: true,
    })
    .check();
  await dialog.getByRole('button', { name: 'Void entry', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const voided = await detail(page.request, created.shift.id);
  expect(voided.shift.status).toBe('voided');
  expect(voided.events).toHaveLength(4);
  expect(voided.events.find((event) => event.operation === 'manual-entry')).toEqual(created.event);
  expect(voided.events.find((event) => event.operation === 'void')).toMatchObject({
    reason: voidReason,
    createdById: session.user!.id,
  });
  const totals = await report(page.request, date, date, person.id);
  expect(totals.total).toBe(1);
  expect(totals.totals).toEqual({
    recordedSeconds: 0,
    closedShiftCount: 0,
    openShiftCount: 0,
    voidedShiftCount: 1,
  });
  await page.goto(`/clinic/attendance?entry=${created.shift.id}`);
  entry = page.getByRole('dialog', { name: 'Attendance entry', exact: true });
  await expect(entry.getByText(voidReason, { exact: true })).toBeVisible();
  await expect(entry.getByRole('button', { name: 'Correct entry', exact: true })).toHaveCount(0);
  await expect(entry.getByRole('button', { name: 'Void mistaken entry', exact: true })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('attendance-admin-history-mobile.png'),
    fullPage: true,
  });
});

test('timesheets use full IST start-date intervals and checked private CSV exports while other roles stay within their own records', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request);
  const suffix = randomUUID().slice(0, 8);
  const person = await staff(page.request, headers, `=2+3 ${suffix}`);
  const from = day(-5),
    following = day(-4);
  const privateReason = `PRIVATE_ATTENDANCE_REASON_${suffix}`;
  const early = await manual(
    page.request,
    headers,
    person.id,
    utc(from, '00:15'),
    utc(from, '00:45'),
    privateReason,
  );
  const overnight = await manual(
    page.request,
    headers,
    person.id,
    utc(from, '23:30'),
    utc(following, '01:30'),
    privateReason,
  );
  await manual(
    page.request,
    headers,
    person.id,
    utc(following, '02:00'),
    utc(following, '03:00'),
    privateReason,
  );
  expect(early.shift.startedAt.slice(0, 10)).not.toBe(from);
  const initial = await report(page.request, from, from, person.id);
  expect(initial.total).toBe(2);
  expect(initial.totals).toEqual({
    recordedSeconds: 9000,
    closedShiftCount: 2,
    openShiftCount: 0,
    voidedShiftCount: 0,
  });
  expect(initial.items.map((entry) => entry.id)).toEqual([overnight.shift.id, early.shift.id]);
  expect((await report(page.request, following, following, person.id)).totals.recordedSeconds).toBe(
    3600,
  );
  const suspended = await page.request.patch(`/api/accounts/${person.id}`, {
    headers,
    data: { active: false },
  });
  expect(suspended.ok(), await suspended.text()).toBeTruthy();
  const staffList = await get<AttendanceStaff[]>(page.request, '/api/attendance/staff');
  expect(staffList.find((entry) => entry.id === person.id)).toEqual({
    id: person.id,
    name: person.name,
    role: 'receptionist',
    active: false,
  });
  expect(
    staffList.every(
      (entry) => !('email' in entry) && !('doctorId' in entry) && !('password' in entry),
    ),
  ).toBe(true);
  await page.goto('/clinic/attendance');
  await applyReport(page, from, from, person.id);
  await expect(page.locator('.attendance-report-table tbody tr')).toHaveCount(2);
  await expect(page.getByText('2h 30m 0s', { exact: true })).toBeVisible();
  await expect(page.getByText(/start.date/i).first()).toBeVisible();
  const exported: string[] = [];
  page.on('download', (download) => exported.push(download.suggestedFilename()));
  const exportButton = page.getByRole('button', { name: 'Export attendance CSV', exact: true });
  const downloadEvent = page.waitForEvent('download');
  await exportButton.click();
  const downloaded = await downloadEvent;
  expect(downloaded.suggestedFilename()).toBe(`attendance-${from}-to-${from}.csv`);
  const path = await downloaded.path();
  expect(path).not.toBeNull();
  const csv = await readFile(path!, 'utf8');
  expect(csv).toContain(`'=2+3 ${suffix}`);
  expect(csv).toContain('"Recorded seconds","9000"');
  expect(csv).toContain(early.shift.startedAt);
  expect(csv).toContain(overnight.shift.id);
  expect(csv).not.toContain(privateReason);
  expect(csv).not.toContain(person.email);
  expect(csv).not.toContain('AttendanceFixture2026!');

  const correctedResponse = await page.request.post(
    `/api/attendance/shifts/${overnight.shift.id}/corrections`,
    {
      headers,
      data: {
        startedAt: overnight.shift.startedAt,
        endedAt: utc(following, '01:45'),
        reason: privateReason,
        expectedRevision: overnight.shift.revision,
        requestId: randomUUID(),
      },
    },
  );
  expect(correctedResponse.ok(), await correctedResponse.text()).toBeTruthy();
  const changed = (await correctedResponse.json()) as AttendanceMutation;
  expect(changed.shift.recordedSeconds).toBe(8100);
  const staleExport = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/attendance/export.csv',
  );
  await exportButton.click();
  expect((await staleExport).status()).toBe(409);
  await expect(page.getByRole('alert')).toContainText(
    'Attendance changed since this report loaded',
  );
  expect(exported).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh attendance', exact: true }).click();
  await expect(page.getByText('2h 45m 0s', { exact: true })).toBeVisible();
  await expect(exportButton).toBeEnabled();

  // A 200 response must still prove both CSV type and the displayed revision;
  // neither a stale attachment nor a JSON error disguised as success is saved.
  for (const defect of ['revision', 'mime'] as const) {
    const badExport = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          ...(defect === 'revision'
            ? { 'x-attendance-revision': '0'.repeat(64) }
            : { 'content-type': 'application/json' }),
        },
      });
    };
    await page.route('**/api/attendance/export.csv?*', badExport);
    try {
      const rejectedAttachment = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/attendance/export.csv',
      );
      await exportButton.click();
      expect((await rejectedAttachment).status()).toBe(200);
      await expect(page.getByRole('alert')).toContainText(/CSV|confirm|revision/i);
      await expect(exportButton).toBeEnabled();
      expect(exported).toHaveLength(1);
    } finally {
      await page.unroute('**/api/attendance/export.csv?*', badExport);
    }
  }
  const goodDownload = page.waitForEvent('download');
  await exportButton.click();
  await goodDownload;
  expect(exported).toHaveLength(2);
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const input = args[0];
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        window.location.href,
      );
      const tracked = url.pathname === '/api/attendance/export.csv';
      try {
        const response = await originalFetch(...args);
        if (tracked) {
          const blob = response.blob.bind(response);
          response.blob = async () => {
            try {
              return await blob();
            } finally {
              document.documentElement.dataset.attendanceExportSettled = 'true';
            }
          };
        }
        return response;
      } catch (error) {
        if (tracked) document.documentElement.dataset.attendanceExportSettled = 'true';
        throw error;
      }
    };
  });
  let releaseExport!: () => void, exportArrived!: () => void, exportHandled!: () => void;
  const exportGate = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  const exportReady = new Promise<void>((resolve) => {
    exportArrived = resolve;
  });
  const exportDone = new Promise<void>((resolve) => {
    exportHandled = resolve;
  });
  const delayedExport = async (route: Route) => {
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(200);
    expect(response.headers()['x-attendance-revision']).toBe(
      new URL(route.request().url()).searchParams.get('expectedRevision'),
    );
    exportArrived();
    await exportGate;
    try {
      await route.fulfill({ response });
    } catch {
      /* The browser may already have cancelled this intercepted request. */
    } finally {
      exportHandled();
    }
  };
  await page.route('**/api/attendance/export.csv?*', delayedExport);
  const failedReport = async (route: Route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic attendance report outage.' }),
    });
  try {
    await exportButton.click();
    await exportReady;
    await page.route('**/api/attendance?*', failedReport);
    await page.getByRole('button', { name: 'Refresh attendance', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic attendance report outage.');
  } finally {
    releaseExport();
  }
  await exportDone;
  await page.unroute('**/api/attendance/export.csv?*', delayedExport);
  await expect(page.locator('html')).toHaveAttribute('data-attendance-export-settled', 'true');
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(exported).toHaveLength(2);
  await expect(page.locator('.attendance-report-table tbody tr')).toHaveCount(0);
  await expect(page.getByText('2h 45m 0s', { exact: true })).toHaveCount(0);
  await expect(exportButton).toBeDisabled();
  await page.unroute('**/api/attendance?*', failedReport);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.attendance-report-table tbody tr')).toHaveCount(2);
  await expect(page.getByText('2h 45m 0s', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await page.getByLabel('From date', { exact: true }).fill(following);
  await page.getByLabel('To date', { exact: true }).fill(following);
  await page.getByLabel('Staff member', { exact: true }).selectOption(person.id);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('from') === following &&
      url.searchParams.get('to') === following &&
      url.searchParams.get('staff') === person.id,
  );
  await expect(page.getByLabel('From date', { exact: true })).toHaveValue(following);
  await expect(page.getByLabel('To date', { exact: true })).toHaveValue(following);
  await expect(page.locator('.attendance-report-table tbody tr')).toHaveCount(1);
  await expect(
    page.locator('.attendance-metrics').getByText('1h 0m 0s', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('attendance-timesheet-mobile.png'),
    fullPage: true,
  });

  const clinician = await browser.newContext({ baseURL });
  const patient = await browser.newContext({ baseURL });
  try {
    const doctorLogin = await login(clinician.request, 'doctor@derma.demo');
    const own = await get<AttendanceContext>(clinician.request, '/api/attendance/me');
    expect(own.staff.id).toBe(doctorLogin.session.user!.id);
    const ownReport = await get<AttendanceReport>(
      clinician.request,
      `/api/attendance?from=${from}&to=${following}`,
    );
    expect(ownReport.userId).toBe(own.staff.id);
    expect(ownReport.items.every((entry) => entry.userId === own.staff.id)).toBe(true);
    for (const route of [
      '/api/attendance/staff',
      `/api/attendance/staff/${person.id}/context`,
      `/api/attendance?from=${from}&to=${from}&userId=${person.id}`,
      `/api/attendance/export.csv?from=${from}&to=${from}&expectedRevision=${initial.revision}`,
    ]) {
      const denied = await clinician.request.get(route);
      expect(denied.status(), await denied.text()).toBe(403);
      const body = await denied.json();
      expect(body).not.toHaveProperty('items');
      expect(body).not.toHaveProperty('totals');
      expect(JSON.stringify(body)).not.toContain(person.name);
    }
    const missing = await clinician.request.get(`/api/attendance/shifts/${randomUUID()}`);
    const forbidden = await clinician.request.get(`/api/attendance/shifts/${overnight.shift.id}`);
    expect(forbidden.status()).toBe(404);
    expect(await forbidden.json()).toEqual(await missing.json());
    const forbiddenCorrection = await clinician.request.post(
      `/api/attendance/shifts/${overnight.shift.id}/corrections`,
      {
        headers: doctorLogin.headers,
        data: {
          startedAt: overnight.shift.startedAt,
          endedAt: utc(following, '01:50'),
          reason: 'Unauthorized synthetic correction',
          expectedRevision: changed.shift.revision,
          requestId: randomUUID(),
        },
      },
    );
    expect(forbiddenCorrection.status()).toBe(403);
    const forbiddenClockOut = await clinician.request.post(
      `/api/attendance/shifts/${overnight.shift.id}/clock-out`,
      {
        headers: doctorLogin.headers,
        data: { expectedRevision: own.revision, requestId: randomUUID() },
      },
    );
    expect(forbiddenClockOut.status()).toBe(404);
    const patientLogin = await login(patient.request, 'patient@derma.demo');
    for (const route of [
      '/api/attendance/me',
      '/api/attendance/staff',
      `/api/attendance?from=${from}&to=${following}`,
      `/api/attendance/shifts/${overnight.shift.id}`,
    ]) {
      const denied = await patient.request.get(route);
      expect(denied.status(), await denied.text()).toBe(403);
      expect(await denied.json()).not.toHaveProperty('totals');
    }
    const deniedClock = await patient.request.post('/api/attendance/clock-in', {
      headers: patientLogin.headers,
      data: { expectedRevision: own.revision, requestId: randomUUID() },
    });
    expect(deniedClock.status()).toBe(403);
    expect((await detail(page.request, overnight.shift.id)).shift).toEqual(changed.shift);
  } finally {
    await clinician.close();
    await patient.close();
  }
});
