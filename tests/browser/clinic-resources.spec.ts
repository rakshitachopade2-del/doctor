import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor } from '../../shared/types';
import type { AppointmentResourceContext, ResourceDetail } from '../../shared/clinic-resources';

const future = (days = 30) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
};
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { 'X-CSRF-Token': (await response.json()).csrfToken as string };
}
async function doctor(
  request: APIRequestContext,
  headers: Record<string, string>,
  durationMinutes: number,
): Promise<Doctor> {
  const response = await request.post('/api/doctors', {
    headers,
    data: {
      name: `Dr. Resource Fixture ${randomUUID().slice(0, 8)}`,
      title: 'Dermatologist',
      qualifications: 'Synthetic profile',
      specialties: ['General dermatology'],
      experience: 4,
      fee: 600,
      bio: 'Synthetic scheduling verification.',
      languages: ['English'],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const created = (await response.json()) as Doctor;
  const configured = await request.put(`/api/schedules/${created.id}`, {
    headers,
    data: {
      durationMinutes,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '08:00',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(configured.ok(), await configured.text()).toBeTruthy();
  return created;
}
async function patient(request: APIRequestContext, headers: Record<string, string>) {
  const response = await request.post('/api/patients', {
    headers,
    data: {
      name: `Resource Patient ${randomUUID().slice(0, 8)}`,
      email: '',
      phone: '+91 9000000151',
      dob: '',
      gender: 'Not specified',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: string; name: string };
}
async function book(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  patientId: string,
  date: string,
  time: string,
): Promise<Appointment> {
  const response = await request.post('/api/appointments', {
    headers,
    data: {
      doctorId,
      patientId,
      date,
      time,
      mode: 'in-person',
      reason: 'Synthetic resource scheduling visit.',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}
async function resource(
  request: APIRequestContext,
  headers: Record<string, string>,
  kind: 'room' | 'equipment' = 'room',
): Promise<ResourceDetail> {
  const response = await request.post('/api/clinic-resources', {
    headers,
    data: {
      name: `${kind === 'room' ? 'Room' : 'Equipment'} fixture ${randomUUID().slice(0, 8)}`,
      kind,
      location: 'Synthetic clinic area',
      notes: 'Operational test fixture only.',
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}
async function context(
  request: APIRequestContext,
  appointmentId: string,
): Promise<AppointmentResourceContext> {
  const response = await request.get(`/api/appointments/${appointmentId}/resources`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function allocate(
  request: APIRequestContext,
  headers: Record<string, string>,
  appointmentId: string,
  resourceIds: string[],
  reason: string,
): Promise<AppointmentResourceContext> {
  const response = await request.put(`/api/appointments/${appointmentId}/resources`, {
    headers,
    data: {
      resourceIds,
      reason,
      expectedRevision: (await context(request, appointmentId)).revision,
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
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
function option(page: Page, name: string) {
  return page.locator('.ar-resource-option').filter({ has: page.getByText(name, { exact: true }) });
}

test('resource intervals follow patient rescheduling, preserve cancellation history, and allow reception to reuse released capacity', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const headers = await login(page.request);
  const patientContext = await browser.newContext({ baseURL });
  const receptionContext = await browser.newContext({ baseURL });
  try {
    const patientHeaders = await login(patientContext.request, 'patient@derma.demo');
    const receptionHeaders = await login(receptionContext.request, 'reception@derma.demo');
    const suffix = randomUUID().slice(0, 8);
    const roomName = `Consultation room ${suffix}`;
    const operationalNote = `PRIVATE operational resource note ${suffix}`;
    const response = await page.request.post('/api/clinic-resources', {
      headers,
      data: {
        name: roomName,
        kind: 'room',
        location: 'Ground floor',
        notes: operationalNote,
        requestId: randomUUID(),
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const room = (await response.json()) as ResourceDetail;
    const equipment = await resource(page.request, headers, 'equipment');
    const longDoctor = await doctor(page.request, headers, 60);
    const shortDoctor = await doctor(page.request, headers, 20);
    const otherPatient = await patient(page.request, headers);
    const thirdPatient = await patient(page.request, headers);
    const date = future();
    const ownAppointment = await book(
      page.request,
      headers,
      longDoctor.id,
      'patient-ananya',
      date,
      '09:00',
    );
    const adjacent = await book(
      page.request,
      headers,
      shortDoctor.id,
      otherPatient.id,
      date,
      '10:40',
    );
    const overlapping = await book(
      page.request,
      headers,
      shortDoctor.id,
      thirdPatient.id,
      date,
      '09:20',
    );
    expect(ownAppointment.durationMinutes).toBe(60);
    expect(adjacent.durationMinutes).toBe(20);
    await page.goto(`/clinic/appointments?date=${date}&resources=${ownAppointment.id}`);
    const dialog = page.getByRole('dialog', { name: 'Appointment resources', exact: true });
    await expect(dialog.getByText(/They do not track live room occupancy/)).toBeVisible();
    await option(page, roomName).getByRole('checkbox').check();
    await option(page, equipment.resource.name).getByRole('checkbox').check();
    const allocationReason = `PRIVATE operational appointment allocation ${suffix}`;
    await dialog.getByLabel('Reason for allocation change', { exact: true }).fill(allocationReason);
    await dialog.getByRole('button', { name: 'Save resource reservations', exact: true }).click();
    await expect(
      dialog.locator('.ar-allocation-history').getByText(allocationReason, { exact: true }),
    ).toBeVisible();
    const initial = await context(page.request, ownAppointment.id);
    expect(initial.resourceIds).toEqual([room.resource.id, equipment.resource.id].sort());
    expect(initial.history).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Close resources', exact: true }).click();

    // Another doctor has a different slot grid. Adjacent intervals are valid;
    // a 20-minute slot inside the first visit's hour cannot reuse the room.
    await allocate(
      page.request,
      headers,
      adjacent.id,
      [room.resource.id],
      'Adjacent interval fixture.',
    );
    await page.goto(`/clinic/resources?date=${date}&resource=${room.resource.id}`);
    await expect(page.getByRole('heading', { name: roomName, exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: testInfo.outputPath('clinic-resources-desktop.png'),
      fullPage: true,
    });
    await page.goto(`/clinic/appointments?date=${date}&resources=${overlapping.id}`);
    await expect(option(page, roomName).getByRole('checkbox')).toBeDisabled();
    await expect(
      option(page, roomName).getByText('Reserved for another appointment', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(allocationReason, { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close resources', exact: true }).click();

    const ownPage = await patientContext.newPage();
    await ownPage.goto(`/book?appointmentId=${ownAppointment.id}`);
    const times = ownPage.getByRole('group', { name: 'Available appointment times', exact: true });
    await expect(times.getByRole('button', { name: '11:00', exact: true })).toBeVisible();
    await expect(times.getByRole('button', { name: '10:00', exact: true })).toHaveCount(0);
    await expect(times.getByRole('button', { name: '09:00', exact: true })).toBeVisible();
    await expect(ownPage.getByText(roomName, { exact: true })).toHaveCount(0);
    await expect(ownPage.getByText(otherPatient.name, { exact: true })).toHaveCount(0);
    await times.getByRole('button', { name: '11:00', exact: true }).click();
    await ownPage.getByRole('button', { name: 'Confirm new time', exact: true }).click();
    await expect(
      ownPage.getByRole('heading', { name: 'Appointment rescheduled.', exact: true }),
    ).toBeVisible();
    const moved = await context(page.request, ownAppointment.id);
    expect(moved.appointment.time).toBe('11:00');
    expect(moved.resourceIds).toEqual(initial.resourceIds);
    expect(moved.history).toHaveLength(2);
    expect(moved.history[0]).toMatchObject({
      source: 'appointment-rescheduled',
      before: { appointment: { time: '09:00', durationMinutes: 60 } },
      after: { appointment: { time: '11:00', durationMinutes: 60 } },
    });
    const reuseAppointment = await book(
      page.request,
      headers,
      shortDoctor.id,
      thirdPatient.id,
      date,
      '11:20',
    );
    expect(
      (await context(page.request, reuseAppointment.id)).resources.find(
        (entry) => entry.resource.id === room.resource.id,
      )!.available,
    ).toBe(false);
    const cancellation = await patientContext.request.patch(
      `/api/appointments/${ownAppointment.id}`,
      { headers: patientHeaders, data: { status: 'cancelled' } },
    );
    expect(cancellation.ok(), await cancellation.text()).toBeTruthy();
    const cancelled = await context(page.request, ownAppointment.id);
    expect(cancelled.resourceIds).toEqual([]);
    expect(cancelled.canAllocate).toBe(false);
    expect(cancelled.canRelease).toBe(false);
    expect(cancelled.history).toHaveLength(3);
    expect(cancelled.history[0]).toMatchObject({
      source: 'appointment-status',
      before: { resources: moved.history[0].after.resources },
      after: { appointment: { status: 'cancelled' }, resources: [] },
    });
    await page.goto(`/clinic/appointments?date=${date}&resources=${ownAppointment.id}`);
    await expect(
      dialog.getByText(
        'This appointment is not available for resource changes. Recorded reservations and history remain readable.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Save resource reservations', exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.locator('.ar-allocation-history').getByText(allocationReason, { exact: true }),
    ).toBeVisible();
    await dialog.locator('.ar-history-event').last().locator('summary').click();
    await expect(
      dialog.locator('.ar-history-event').last().getByText(roomName, { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 320, height: 780 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('cancelled-resource-history-mobile.png'),
      fullPage: true,
    });

    const receptionPage = await receptionContext.newPage();
    await receptionPage.goto(`/clinic/appointments?date=${date}&resources=${reuseAppointment.id}`);
    const receptionDialog = receptionPage.getByRole('dialog', {
      name: 'Appointment resources',
      exact: true,
    });
    await expect(option(receptionPage, roomName).getByRole('checkbox')).toBeEnabled();
    await option(receptionPage, roomName).getByRole('checkbox').check();
    await receptionDialog
      .getByLabel('Reason for allocation change', { exact: true })
      .fill('Reception reserved released room capacity.');
    await receptionDialog
      .getByRole('button', { name: 'Save resource reservations', exact: true })
      .click();
    await expect(
      receptionDialog
        .locator('.ar-allocation-history')
        .getByText('Reception reserved released room capacity.', { exact: true }),
    ).toBeVisible();
    expect(
      (await context(receptionContext.request, reuseAppointment.id)).history[0].createdByRole,
    ).toBe('receptionist');
    expect(
      (await receptionContext.request.get(`/api/patients/${ownAppointment.patientId}`)).status(),
    ).toBe(403);
    expect(
      (
        await receptionContext.request.post('/api/clinic-resources', {
          headers: receptionHeaders,
          data: { name: `Forbidden ${suffix}`, kind: 'room', requestId: randomUUID() },
        })
      ).status(),
    ).toBe(403);
    for (const path of [
      '/api/clinic-resources',
      `/api/appointments/${ownAppointment.id}/resources`,
      `/api/resource-reservations?from=${date}&to=${date}`,
    ])
      expect((await patientContext.request.get(path)).status()).toBe(403);
    const ownAppointments = await (await patientContext.request.get('/api/appointments')).json();
    const ownSummary = await (
      await patientContext.request.get(`/api/patients/${ownAppointment.patientId}/care-summary`)
    ).json();
    for (const payload of [ownAppointments, ownSummary]) {
      expect(JSON.stringify(payload)).not.toContain(operationalNote);
      expect(JSON.stringify(payload)).not.toContain(allocationReason);
      expect(JSON.stringify(payload)).not.toContain(roomName);
      expect(JSON.stringify(payload)).not.toContain('resourceIds');
    }
  } finally {
    await patientContext.close();
    await receptionContext.close();
  }
});

test('allocation changes retain a stale draft, confirm exact retries, and preserve full-set before and after history', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const headers = await login(page.request);
  const clinician = await doctor(page.request, headers, 30);
  const visitPatient = await patient(page.request, headers);
  const date = future(40);
  const appointment = await book(
    page.request,
    headers,
    clinician.id,
    visitPatient.id,
    date,
    '12:00',
  );
  const room = await resource(page.request, headers);
  const equipment = await resource(page.request, headers, 'equipment');
  await page.goto(`/clinic/appointments?date=${date}&resources=${appointment.id}`);
  const dialog = page.getByRole('dialog', { name: 'Appointment resources', exact: true });
  await option(page, room.resource.name).getByRole('checkbox').check();
  const draftReason = `Retained allocation draft ${randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('Reason for allocation change', { exact: true }).fill(draftReason);
  const concurrentReason = 'Concurrent equipment assignment must be reviewed before replacing it.';
  const concurrent = await allocate(
    page.request,
    headers,
    appointment.id,
    [equipment.resource.id],
    concurrentReason,
  );
  const path = `/api/appointments/${appointment.id}/resources`;
  const stale = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && new URL(response.url()).pathname === path,
  );
  await dialog.getByRole('button', { name: 'Save resource reservations', exact: true }).click();
  const rejected = await stale;
  expect(rejected.status()).toBe(409);
  const staleBody = rejected.request().postDataJSON();
  await expect(dialog.getByLabel('Reason for allocation change', { exact: true })).toHaveValue(
    draftReason,
  );
  await expect(option(page, room.resource.name).getByRole('checkbox')).toBeChecked();
  await dialog.getByRole('button', { name: 'Refresh allocation context', exact: true }).click();
  await expect(
    dialog.locator('.ar-allocation-history').getByText(concurrentReason, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Save resource reservations', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole('button', { name: 'I reviewed current availability; keep my draft', exact: true })
    .click();
  await expect(dialog.getByLabel('Reason for allocation change', { exact: true })).toHaveValue(
    draftReason,
  );
  await expect(option(page, room.resource.name).getByRole('checkbox')).toBeChecked();
  await expect(option(page, equipment.resource.name).getByRole('checkbox')).not.toBeChecked();
  let body: Record<string, unknown> | undefined;
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const malformed = async (route: Route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    body = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(200);
    const saved = await response.json();
    arrived();
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...saved, history: [{}] }),
    });
  };
  await page.route(`**${path}`, malformed);
  try {
    await dialog.getByRole('button', { name: 'Save resource reservations', exact: true }).click();
    await ready;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Reason for allocation change', { exact: true })).toBeDisabled();
  } finally {
    release();
  }
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await page.unroute(`**${path}`, malformed);
  expect(body?.requestId).not.toBe(staleBody.requestId);
  expect(body?.expectedRevision).toBe(concurrent.revision);
  const committed = await context(page.request, appointment.id);
  expect(committed.history).toHaveLength(2);
  expect(committed.resourceIds).toEqual([room.resource.id]);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('Retry the pending request to confirm its outcome before closing.', {
      exact: true,
    }),
  ).toBeVisible();
  const retry = page.waitForRequest(
    (request) => request.method() === 'PUT' && new URL(request.url()).pathname === path,
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await retry).postDataJSON()).toEqual(body);
  await expect(
    dialog.locator('.ar-allocation-history').getByText(draftReason, { exact: true }),
  ).toBeVisible();
  expect((await context(page.request, appointment.id)).history).toEqual(committed.history);
  const event = committed.history[0];
  expect(event.createdById).toBe('user-admin');
  expect(event.requestId).toBe(body?.requestId);
  expect(event.before.resources.map((entry) => entry.id)).toEqual([equipment.resource.id]);
  expect(event.after.resources.map((entry) => entry.id)).toEqual([room.resource.id]);
  await dialog.locator('.ar-history-event').first().locator('summary').click();
  await expect(
    dialog.locator('.ar-history-event').first().getByText(equipment.resource.name, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.locator('.ar-history-event').first().getByText(room.resource.name, { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('resource-allocation-history-mobile.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Clear all reservations', exact: true }).click();
  await dialog
    .getByLabel('Reason for allocation change', { exact: true })
    .fill('Clear the entire resource set while retaining its history.');
  await dialog.getByRole('button', { name: 'Save resource reservations', exact: true }).click();
  await expect(
    dialog
      .locator('.ar-allocation-history')
      .getByText('Clear the entire resource set while retaining its history.', { exact: true }),
  ).toBeVisible();
  const released = await context(page.request, appointment.id);
  expect(released.resourceIds).toEqual([]);
  expect(released.history).toHaveLength(3);
  expect(released.history[0].after.resources).toEqual([]);
  expect(released.history.slice(1)).toEqual(committed.history);
});
