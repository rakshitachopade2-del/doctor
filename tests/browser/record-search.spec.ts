import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { AuditEntry, Appointment, Doctor } from '../../shared/types';
import type {
  AuditSearchPage,
  PatientSearchPage,
  AppointmentSearchPage,
} from '../../shared/record-search';

const clinicToday = (value = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
const future = (days: number) =>
  new Date(Date.parse(`${clinicToday()}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { 'X-CSRF-Token': (await response.json()).csrfToken as string };
}
async function newPatient(
  request: APIRequestContext,
  headers: Record<string, string>,
  name: string,
  allergies = '',
) {
  const response = await request.post('/api/patients', {
    headers,
    data: { name, email: '', phone: '+91 9000000822', dob: '', gender: 'Not specified', allergies },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: string; name: string };
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

async function pendingSearchBack(
  page: Page,
  inputLabel: string,
  paginationLabel: string,
  applied: string,
  pending: string,
) {
  const input = page.getByLabel(inputLabel, { exact: true });
  const pagination = page.getByRole('navigation', { name: paginationLabel, exact: true });
  await expect(pagination.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  // Hold the browser timer so Back happens before the 250ms debounce even on a
  // slow test machine, then advance beyond that timer to prove it was cancelled.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  try {
    await input.fill(pending);
    await page.goBack();
    await expect(input).toHaveValue(applied);
    await page.clock.runFor(350);
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('search') === applied && !url.searchParams.has('page'),
    );
    await expect(input).toHaveValue(applied);
    await expect(pagination.getByText('Page 1 of 2', { exact: true })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('search') === applied && url.searchParams.get('page') === '2',
    );
    await expect(input).toHaveValue(applied);
    await expect(pagination.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  } finally {
    await page.clock.resume();
  }
}

test('audit search reaches older history, treats wildcard text literally, and keeps filters stable across delayed responses and navigation', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const headers = await login(page.request);
  const marker = await newPatient(
    page.request,
    headers,
    `Older audit marker ${randomUUID().slice(0, 8)}`,
  );
  // Use ordinary authorized read actions to place the marker beyond the old
  // 500-entry endpoint limit; no fixture-only route or security bypass is used.
  for (let batch = 0; batch < 51; batch++) {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => page.request.get('/api/clinic-resources')),
    );
    for (const response of responses) expect(response.ok(), await response.text()).toBeTruthy();
  }
  const legacy = (await (await page.request.get('/api/audit')).json()) as AuditEntry[];
  expect(legacy).toHaveLength(500);
  expect(legacy.some((entry) => entry.entityId === marker.id)).toBe(false);
  const markerPage = (await (
    await page.request.get(`/api/search/audit?entityId=${marker.id}`)
  ).json()) as AuditSearchPage;
  expect(markerPage.total).toBe(1);
  const original = markerPage.items[0];
  await page.goto('/clinic/audit');
  await page.getByLabel('Performed by', { exact: true }).fill(original.actorName);
  await page.getByLabel('Action contains', { exact: true }).fill('created patient');
  await page.getByLabel('Record type', { exact: true }).fill('patient');
  await page.getByLabel('Record ID', { exact: true }).fill(marker.id);
  const markerDate = clinicToday(new Date(original.createdAt));
  await page.getByLabel('From date', { exact: true }).fill(markerDate);
  await page.getByLabel('Through date', { exact: true }).fill(markerDate);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('.audit-row')).toHaveCount(1);
  await expect(page.locator('.audit-row').getByText(marker.id, { exact: true })).toBeVisible();
  await expect(
    page.locator('.audit-row').getByText(original.actorName, { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.audit-result-count')).toHaveText('1 entry matches');
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(page.getByLabel('Record ID', { exact: true })).toHaveValue('');
  await page.getByLabel('Search activity', { exact: true }).fill('%');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('q') === '%');
  await expect(page.getByLabel('Search activity', { exact: true })).toHaveValue('%');
  await expect(
    page.getByRole('heading', { name: 'No activity matches these filters', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.audit-result-count')).toHaveText('0 entries match');
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await page.getByLabel('Action contains', { exact: true }).fill('viewed clinic resources');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('.audit-row')).toHaveCount(25);
  const pages = page.getByRole('navigation', { name: 'Audit history pages', exact: true });
  await expect(pages.getByText('Page 1 of 21', { exact: true })).toBeVisible();
  const wrongPage = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('page') !== '2') return route.continue();
    // A valid first page is still wrong for an in-range second-page request.
    // The response is internally coherent, so cardinality checks alone miss it.
    url.searchParams.delete('page');
    const first = await route.fetch({ url: url.href });
    const body = (await first.json()) as AuditSearchPage;
    expect(body.page).toBe(1);
    expect(body.totalPages).toBeGreaterThan(1);
    await route.fulfill({ response: first, json: body });
  };
  await page.route('**/api/search/audit?*', wrongPage);
  try {
    await pages.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'The search results could not be confirmed.',
    );
    await expect(page).toHaveURL((url) => url.searchParams.get('page') === '2');
    await expect(page.locator('.audit-row')).toHaveCount(0);
    await expect(page.locator('.audit-result-count')).toHaveCount(0);
    await expect(pages).toHaveCount(0);
  } finally {
    await page.unroute('**/api/search/audit?*', wrongPage);
  }
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(pages.getByText('Page 2 of 21', { exact: true })).toBeVisible();
  await expect(page.locator('.audit-row')).toHaveCount(25);
  await pages.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(pages.getByText('Page 1 of 21', { exact: true })).toBeVisible();
  await pages.getByRole('button', { name: 'Last page', exact: true }).click();
  await expect(page.locator('.audit-row')).toHaveCount(10);
  await expect(pages.getByText('Page 21 of 21', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/page=21/);
  await page.goBack();
  await expect(pages.getByText('Page 1 of 21', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Action contains', { exact: true })).toHaveValue(
    'viewed clinic resources',
  );
  await page.goForward();
  await expect(pages.getByText('Page 21 of 21', { exact: true })).toBeVisible();
  let releaseClamp!: () => void, clampArrived!: () => void;
  const clampGate = new Promise<void>((resolve) => {
    releaseClamp = resolve;
  });
  const clampReady = new Promise<void>((resolve) => {
    clampArrived = resolve;
  });
  const delayedClamp = async (route: Route) => {
    if (new URL(route.request().url()).searchParams.get('page') !== '999999')
      return route.continue();
    const response = await route.fetch();
    clampArrived();
    await clampGate;
    await route.fulfill({ response });
  };
  await page.route('**/api/search/audit?*', delayedClamp);
  try {
    await page.goto('/clinic/audit?action=viewed+clinic+resources&page=999999');
    await clampReady;
    // Server page normalization must not submit or erase an unfinished filter.
    await page.getByLabel('Search activity', { exact: true }).fill(marker.id);
    releaseClamp();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('page') === '21' &&
        url.searchParams.get('action') === 'viewed clinic resources' &&
        !url.searchParams.has('q'),
    );
    await expect(pages.getByText('Page 21 of 21', { exact: true })).toBeVisible();
    await expect(page.locator('.audit-row')).toHaveCount(10);
    await expect(page.locator('.audit-result-count')).toHaveText('510 entries match');
    await expect(page.getByLabel('Search activity', { exact: true })).toHaveValue(marker.id);
  } finally {
    releaseClamp();
    await page.unroute('**/api/search/audit?*', delayedClamp);
  }
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(page.getByLabel('Action contains', { exact: true })).toHaveValue('');

  // Observe the obsolete response's JSON consumption so assertions run after
  // the hook has processed it, without a global network-idle or timing sleep.
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    const state = window as typeof window & { obsoleteAuditJsonRead?: boolean };
    state.obsoleteAuditJsonRead = false;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        window.location.href,
      );
      if (
        url.pathname === '/api/search/audit' &&
        url.searchParams.get('q') === 'viewed clinic resources'
      ) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.obsoleteAuditJsonRead = true;
          }
        };
      }
      return response;
    };
  });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const delayed = async (route: Route) => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'viewed clinic resources')
      return route.continue();
    arrived();
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Obsolete audit query failed.' }),
    });
  };
  await page.route('**/api/search/audit?*', delayed);
  try {
    await page.getByLabel('Search activity', { exact: true }).fill('viewed clinic resources');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await ready;
    await page.getByLabel('Search activity', { exact: true }).fill(marker.id);
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.locator('.audit-row').getByText(marker.id, { exact: true })).toBeVisible();
  } finally {
    release();
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { obsoleteAuditJsonRead?: boolean }).obsoleteAuditJsonRead,
      ),
    )
    .toBe(true);
  await page.unroute('**/api/search/audit?*', delayed);
  await expect(page.getByLabel('Search activity', { exact: true })).toHaveValue(marker.id);
  await expect(page.locator('.audit-row')).toHaveCount(1);
  await expect(page.getByText('Obsolete audit query failed.', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel('Search activity', { exact: true })).toHaveValue(
    'viewed clinic resources',
  );
  await expect(page.locator('.audit-row')).toHaveCount(25);
  await page.goForward();
  await expect(page.getByLabel('Search activity', { exact: true })).toHaveValue(marker.id);
  await expect(page.locator('.audit-row')).toHaveCount(1);

  const failed = async (route: Route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic current audit query failure.' }),
    });
  await page.route('**/api/search/audit?*', failed);
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic current audit query failure.');
  await expect(page.locator('.audit-row')).toHaveCount(0);
  await expect(page.locator('.audit-result-count')).toHaveCount(0);
  await expect(pages).toHaveCount(0);
  await page.unroute('**/api/search/audit?*', failed);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.audit-row').getByText(marker.id, { exact: true })).toBeVisible();
  await audit(page);
  await page.screenshot({ path: testInfo.outputPath('audit-search-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({ path: testInfo.outputPath('audit-search-mobile.png'), fullPage: true });
});

test('reception can page and filter complete patient and appointment lists without searching private clinical fields', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const admin = await browser.newContext({ baseURL });
  try {
    const headers = await login(admin.request);
    const suffix = randomUUID().slice(0, 8);
    const privateAllergy = `PrivateAllergy${suffix}`;
    const appointmentReason = `ReasonOnly${suffix}`;
    const patients: { id: string; name: string }[] = [];
    for (let index = 0; index < 28; index++) {
      patients.push(
        await newPatient(
          admin.request,
          headers,
          `${index === 0 ? "Search_%'" : 'Search fixture'} ${suffix} ${String(index).padStart(2, '0')}`,
          index === 0 ? privateAllergy : '',
        ),
      );
    }
    const createdDoctor = await admin.request.post('/api/doctors', {
      headers,
      data: {
        name: `Dr. Search ${suffix}`,
        title: 'Consultant Dermatologist',
        qualifications: 'Synthetic test profile',
        specialties: ['General dermatology'],
        experience: 5,
        fee: 800,
        bio: 'Fictional clinician for record search verification.',
        languages: ['English'],
        color: '#e0ede6',
      },
    });
    expect(createdDoctor.status(), await createdDoctor.text()).toBe(201);
    const doctor = (await createdDoctor.json()) as Doctor;
    const scheduled = await admin.request.put(`/api/schedules/${doctor.id}`, {
      headers,
      data: {
        durationMinutes: 15,
        windows: Array.from({ length: 7 }, (_, day) => ({
          day,
          start: '08:00',
          end: '18:00',
          mode: 'both',
        })),
      },
    });
    expect(scheduled.ok(), await scheduled.text()).toBeTruthy();
    const date = future(20);
    const appointments: Appointment[] = [];
    for (let index = 0; index < patients.length; index++) {
      const minutes = 8 * 60 + index * 15;
      const result = await admin.request.post('/api/appointments', {
        headers,
        data: {
          patientId: patients[index].id,
          doctorId: doctor.id,
          date,
          time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
          mode: index % 2 ? 'online' : 'in-person',
          reason: appointmentReason,
        },
      });
      expect(result.status(), await result.text()).toBe(201);
      appointments.push((await result.json()) as Appointment);
    }
    for (const appointment of appointments.slice(0, 3)) {
      const result = await admin.request.patch(`/api/appointments/${appointment.id}`, {
        headers,
        data: { status: 'cancelled' },
      });
      expect(result.ok(), await result.text()).toBeTruthy();
    }
    const nextDay = await admin.request.post('/api/appointments', {
      headers,
      data: {
        patientId: patients[0].id,
        doctorId: doctor.id,
        date: future(21),
        time: '08:00',
        mode: 'online',
        reason: appointmentReason,
      },
    });
    expect(nextDay.status(), await nextDay.text()).toBe(201);

    await login(page.request, 'reception@derma.demo');
    expect((await page.request.get('/api/search/audit')).status()).toBe(403);
    const directoryPath = `/api/search/patients?q=${suffix}`;
    const firstPage = (await (await page.request.get(directoryPath)).json()) as PatientSearchPage;
    const secondPage = (await (
      await page.request.get(`${directoryPath}&page=2`)
    ).json()) as PatientSearchPage;
    expect(firstPage.total).toBe(28);
    expect(firstPage.items).toHaveLength(25);
    expect(secondPage.items).toHaveLength(3);
    expect(new Set([...firstPage.items, ...secondPage.items].map((entry) => entry.id)).size).toBe(
      28,
    );
    for (const entry of [...firstPage.items, ...secondPage.items]) {
      expect(entry).not.toHaveProperty('allergies');
      expect(entry).not.toHaveProperty('allergyStatus');
    }
    for (const request of [page.request, admin.request]) {
      const hidden = (await (
        await request.get(`/api/search/patients?q=${privateAllergy}`)
      ).json()) as PatientSearchPage;
      expect(hidden.total).toBe(0);
    }
    await page.clock.install();
    await page.goto(`/clinic/patients?search=${suffix}`);
    const directory = page.getByRole('region', {
      name: 'Patient directory; scroll horizontally for all columns',
      exact: true,
    });
    const directoryPages = page.getByRole('navigation', {
      name: 'Patient directory pagination',
      exact: true,
    });
    await expect(directory.locator('tbody tr')).toHaveCount(25);
    await expect(directoryPages.getByRole('status')).toHaveText('1–25 of 28 results');
    const expectedLinks = firstPage.items.map((entry) => `/clinic/patients/${entry.id}/details`);
    expect(
      await directory
        .getByRole('link', { name: 'Patient details', exact: true })
        .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    ).toEqual(expectedLinks);
    await expect(directory.getByRole('link', { name: 'Open record', exact: true })).toHaveCount(0);
    await directoryPages.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(directory.locator('tbody tr')).toHaveCount(3);
    await expect(directoryPages.getByRole('status')).toHaveText('26–28 of 28 results');
    await page.goBack();
    await expect(directory.locator('tbody tr')).toHaveCount(25);
    await expect(page.getByLabel('Search patient directory')).toHaveValue(suffix);
    await page.goForward();
    await expect(directory.locator('tbody tr')).toHaveCount(3);
    await pendingSearchBack(
      page,
      'Search patient directory',
      'Patient directory pagination',
      suffix,
      privateAllergy,
    );
    await page.getByLabel('Search patient directory').fill("_%'");
    await expect(directory.locator('tbody tr')).toHaveCount(1);
    await expect(directory.getByText(patients[0].name, { exact: true })).toBeVisible();
    await expect(directoryPages.getByText('Page 1 of 1', { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('page')).toBe(false);
    await page.getByLabel('Search patient directory').fill(privateAllergy);
    await expect(
      page.getByRole('heading', { name: 'No matching patients', exact: true }),
    ).toBeVisible();
    await expect(directoryPages.getByRole('status')).toHaveText('0–0 of 0 results');
    await page.getByLabel('Search patient directory').fill(suffix);
    await expect(directory.locator('tbody tr')).toHaveCount(25);
    await page.setViewportSize({ width: 320, height: 780 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('patient-directory-mobile.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 800 });

    const appointmentPath = `/api/search/appointments?from=${date}&to=${date}&doctorId=${doctor.id}&q=${suffix}`;
    const appointmentPage = (await (
      await page.request.get(appointmentPath)
    ).json()) as AppointmentSearchPage;
    expect(appointmentPage.total).toBe(28);
    expect(appointmentPage.items.map((entry) => entry.id)).toEqual(
      appointments.slice(0, 25).map((entry) => entry.id),
    );
    const reasonOnly = (await (
      await page.request.get(`/api/search/appointments?q=${appointmentReason}`)
    ).json()) as AppointmentSearchPage;
    expect(reasonOnly.total).toBe(0);
    await page.goto(`/clinic/appointments?date=${date}&doctorId=${doctor.id}&search=${suffix}`);
    const schedule = page.getByRole('region', {
      name: 'Appointments; scroll horizontally for all columns',
      exact: true,
    });
    const appointmentPages = page.getByRole('navigation', {
      name: 'Appointment pagination',
      exact: true,
    });
    await expect(schedule.locator('tbody tr')).toHaveCount(25);
    await expect(appointmentPages.getByRole('status')).toHaveText('1–25 of 28 results');
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    try {
      await page.getByLabel('Search appointments', { exact: true }).fill(patients[27].id);
      await page.getByLabel('Appointment status', { exact: true }).selectOption('scheduled');
      const combinedFilters = (url: URL) =>
        url.searchParams.get('search') === patients[27].id &&
        url.searchParams.get('status') === 'scheduled';
      await expect(page).toHaveURL(combinedFilters);
      await expect(page.getByLabel('Search appointments', { exact: true })).toHaveValue(
        patients[27].id,
      );
      await expect(schedule.locator('tbody tr')).toHaveCount(1);
      await expect(schedule.getByText(patients[27].name, { exact: true })).toBeVisible();
      await page.clock.runFor(350);
      await expect(page).toHaveURL(combinedFilters);
      await expect(page.getByLabel('Search appointments', { exact: true })).toHaveValue(
        patients[27].id,
      );
      await expect(schedule.locator('tbody tr')).toHaveCount(1);
    } finally {
      await page.clock.resume();
    }
    await page.getByLabel('Search appointments', { exact: true }).fill(suffix);
    await expect(appointmentPages.getByRole('status')).toHaveText('1–25 of 25 results');
    await page.getByLabel('Appointment status', { exact: true }).selectOption('all');
    await expect(appointmentPages.getByRole('status')).toHaveText('1–25 of 28 results');
    await appointmentPages.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(schedule.locator('tbody tr')).toHaveCount(3);
    await expect(schedule.getByText(patients[27].name, { exact: true })).toBeVisible();
    await page.goBack();
    await expect(appointmentPages.getByText('Page 1 of 2', { exact: true })).toBeVisible();
    await page.goForward();
    await expect(appointmentPages.getByText('Page 2 of 2', { exact: true })).toBeVisible();
    await pendingSearchBack(
      page,
      'Search appointments',
      'Appointment pagination',
      suffix,
      appointmentReason,
    );
    await page.getByLabel('Appointment status', { exact: true }).selectOption('cancelled');
    await expect(schedule.locator('tbody tr')).toHaveCount(3);
    await expect(appointmentPages.getByText('Page 1 of 1', { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('page')).toBe(false);
    await page.getByLabel('Consultation mode', { exact: true }).selectOption('online');
    await expect(schedule.locator('tbody tr')).toHaveCount(1);
    await expect(schedule.getByText(patients[1].name, { exact: true })).toBeVisible();
    await page.getByLabel('Appointment status', { exact: true }).selectOption('waiting');
    await expect(schedule.locator('tbody tr')).toHaveCount(13);
    await page.getByLabel('Appointment status', { exact: true }).selectOption('all');
    await page.getByLabel('Consultation mode', { exact: true }).selectOption('all');
    await expect(appointmentPages.getByRole('status')).toHaveText('1–25 of 28 results');
    await page.getByRole('checkbox', { name: 'All dates', exact: true }).check();
    await expect(appointmentPages.getByRole('status')).toHaveText('1–25 of 29 results');
    await page.goBack();
    await expect(page).toHaveURL((url) => !url.searchParams.has('allDates'));
    await expect(page.getByRole('checkbox', { name: 'All dates', exact: true })).not.toBeChecked();
    await expect(appointmentPages.getByRole('status')).toHaveText('1–25 of 28 results');
    await page.goForward();
    await expect(page).toHaveURL((url) => url.searchParams.get('allDates') === '1');
    await expect(page.getByRole('checkbox', { name: 'All dates', exact: true })).toBeChecked();
    await expect(appointmentPages.getByRole('status')).toHaveText('1–25 of 29 results');
    await page.getByLabel('Appointment date', { exact: true }).fill(future(21));
    await expect(page.getByRole('checkbox', { name: 'All dates', exact: true })).not.toBeChecked();
    await expect(schedule.locator('tbody tr')).toHaveCount(1);
    await page.getByLabel('Search appointments', { exact: true }).fill(appointmentReason);
    await expect(
      page.getByRole('heading', { name: 'No matching appointments', exact: true }),
    ).toBeVisible();
    await expect(appointmentPages.getByRole('status')).toHaveText('0–0 of 0 results');
    await page.getByLabel('Search appointments', { exact: true }).fill(suffix);
    await expect(schedule.locator('tbody tr')).toHaveCount(1);
    await page.getByLabel('Filter by doctor', { exact: true }).selectOption('doctor-meera');
    await expect(
      page.getByRole('heading', { name: 'No matching appointments', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Filter by doctor', { exact: true }).selectOption(doctor.id);
    await expect(schedule.locator('tbody tr')).toHaveCount(1);
    await schedule
      .getByRole('button', { name: `More actions for ${patients[0].name}`, exact: true })
      .click();
    const actions = page.getByRole('dialog', { name: 'Appointment actions', exact: true });
    await expect(actions.getByText(patients[0].name, { exact: true })).toBeVisible();
    await actions.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
    await expect(actions).toHaveCount(0);
    await expect(schedule.getByText('Cancelled', { exact: true })).toBeVisible();
    const afterCancellation = (await (
      await page.request.get(
        `/api/search/appointments?from=${future(21)}&to=${future(21)}&doctorId=${doctor.id}&q=${suffix}`,
      )
    ).json()) as AppointmentSearchPage;
    expect(afterCancellation.total).toBe(1);
    expect(afterCancellation.items[0].status).toBe('cancelled');
    await page.setViewportSize({ width: 320, height: 780 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('appointment-search-mobile.png'),
      fullPage: true,
    });
  } finally {
    await admin.close();
  }
});

test('patients cannot search clinic lists and clinicians cannot access the administrator audit history', async ({
  page,
  browser,
  baseURL,
}) => {
  await login(page.request, 'patient@derma.demo');
  for (const path of ['/api/search/patients', '/api/search/appointments', '/api/search/audit']) {
    const denied = await page.request.get(path);
    expect(denied.status(), await denied.text()).toBe(403);
    expect(await denied.json()).not.toHaveProperty('items');
    expect(await denied.json()).not.toHaveProperty('total');
  }
  await page.goto('/clinic/audit');
  await expect(page.getByRole('heading', { name: 'Clinic activity', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Search activity', { exact: true })).toHaveCount(0);
  const doctor = await browser.newContext({ baseURL });
  try {
    await login(doctor.request, 'doctor@derma.demo');
    for (const path of ['/api/search/patients', '/api/search/appointments']) {
      const allowed = await doctor.request.get(path);
      expect(allowed.ok(), await allowed.text()).toBeTruthy();
      expect(await allowed.json()).toHaveProperty('total');
    }
    const denied = await doctor.request.get('/api/search/audit');
    expect(denied.status(), await denied.text()).toBe(403);
    expect(await denied.json()).not.toHaveProperty('items');
    expect(await denied.json()).not.toHaveProperty('total');
  } finally {
    await doctor.close();
  }
});
