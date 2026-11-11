import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Investigation } from '../../shared/clinical';
import type { InvestigationReviewContext } from '../../shared/investigation-worklist';
import type { CareSummary } from '../../shared/care-summary';
import { syntheticPdf } from '../fixtures/report';

const clinicToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { 'X-CSRF-Token': (await response.json()).csrfToken as string };
}
async function createOrder(
  request: APIRequestContext,
  headers: Record<string, string>,
  title: string,
) {
  const response = await request.post('/api/investigations', {
    headers,
    data: {
      patientId: 'patient-ananya',
      title,
      kind: 'laboratory',
      reason: 'Synthetic investigation for workflow verification.',
      instructions: 'Share the synthetic report for clinical review.',
      dueDate: clinicToday(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Investigation;
}
async function context(
  request: APIRequestContext,
  id: string,
): Promise<InvestigationReviewContext> {
  const response = await request.get(`/api/investigations/${id}/review-context`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function addResult(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  note: string,
  documentIds: string[] = [],
) {
  const response = await request.post(`/api/investigations/${id}/results`, {
    headers,
    data: { note, documentIds },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Investigation;
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

test('latest results re-enter the review worklist while private reviews stay private and uncertain saves retry once', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const headers = await login(page.request);
  const patientContext = await browser.newContext({ baseURL });
  try {
    const patientHeaders = await login(patientContext.request, 'patient@derma.demo');
    const patient = await patientContext.newPage();
    const suffix = randomUUID().slice(0, 8);
    const title = `Investigation review queue ${suffix}`;
    const order = await createOrder(page.request, headers, title);
    const reportTitle = `Review source PDF ${suffix}`;
    const upload = await patientContext.request.post('/api/documents', {
      headers: patientHeaders,
      data: {
        patientId: order.patientId,
        title: reportTitle,
        originalName: 'synthetic-investigation.pdf',
        dataUrl: `data:application/pdf;base64,${syntheticPdf().toString('base64')}`,
        consent: true,
      },
    });
    expect(upload.status(), await upload.text()).toBe(201);
    const document = await upload.json();
    const initialNote = `Initial synthetic result ${suffix}`;
    const initial = await addResult(patientContext.request, patientHeaders, order.id, initialNote, [
      document.id,
    ]);
    const activityBefore = await (await patientContext.request.get('/api/activity')).json();
    await page.goto('/clinic/investigations');
    const row = page.locator('.iwq-row').filter({ hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Review latest result', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review investigation findings', exact: true });
    await expect(dialog.getByText(initialNote, { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: `${reportTitle} PDF report`, exact: true }),
    ).toHaveAttribute('href', `/api/documents/${document.id}/file`);
    await expect(
      dialog.getByText(/This is not a clinical urgency rating or a review deadline/),
    ).toBeVisible();
    const findings = `Private review draft preserved after a newer result ${suffix}`;
    const nextSteps = `Discuss the synthetic record with the clinic ${suffix}`;
    await dialog.getByLabel('Reviewed findings', { exact: true }).fill(findings);
    await dialog.getByLabel('Follow-up and next steps', { exact: true }).fill(nextSteps);
    const share = dialog.getByRole('checkbox', {
      name: 'Share this clinician-reviewed summary and next steps with the patient now.',
      exact: true,
    });
    await expect(share).not.toBeChecked();
    await share.check();
    const supplementalNote = `Supplement received while the review draft was open ${suffix}`;
    const supplement = await addResult(
      patientContext.request,
      patientHeaders,
      order.id,
      supplementalNote,
    );
    const reviewPath = `/api/investigations/${order.id}/reviews`;
    const staleRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === reviewPath,
    );
    const staleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === reviewPath,
    );
    await dialog.getByRole('button', { name: 'Save clinical review', exact: true }).click();
    const rejectedBody = (await staleRequest).postDataJSON();
    expect((await staleResponse).status()).toBe(409);
    await expect(dialog.getByLabel('Reviewed findings', { exact: true })).toHaveValue(findings);
    await expect(dialog.getByLabel('Reviewed findings', { exact: true })).toBeDisabled();
    await expect(share).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Refresh latest investigation', exact: true }).click();
    await expect(dialog.getByText(supplementalNote, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Follow-up and next steps', { exact: true })).toHaveValue(
      nextSteps,
    );
    await expect(
      dialog.getByRole('button', { name: 'Save clinical review', exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole('button', { name: 'I reviewed the latest record; keep my draft', exact: true })
      .click();
    await expect(share).not.toBeChecked();
    await page.setViewportSize({ width: 320, height: 780 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('investigation-review-draft-mobile.png'),
      fullPage: true,
    });
    const saveRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === reviewPath,
    );
    await dialog.getByRole('button', { name: 'Save clinical review', exact: true }).click();
    const savedBody = (await saveRequest).postDataJSON();
    expect(savedBody.requestId).not.toBe(rejectedBody.requestId);
    expect(savedBody.resultId).toBe(supplement.results.at(-1)!.id);
    expect(savedBody.resultId).not.toBe(initial.results[0].id);
    expect(savedBody.publishToPatient).toBe(false);
    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
    await expect(row.getByText('Latest review is clinic-only', { exact: true })).toBeVisible();
    const reviewed = await context(page.request, order.id);
    expect(reviewed.needsReview).toBe(false);
    expect(reviewed.awaitingPublication).toBe(true);
    expect(reviewed.investigation.reviews).toHaveLength(1);
    const review = reviewed.investigation.reviews[0];
    expect(review.publishedAt).toBeNull();
    const activityPrivate = await (await patientContext.request.get('/api/activity')).json();
    expect(activityPrivate.items).toEqual(activityBefore.items);
    await patient.goto('/my-care/record?tab=workflows');
    const patientCard = patient.locator('.patient-investigation-card').filter({ hasText: title });
    await expect(patientCard.getByText('Reviewed by clinician', { exact: true })).toBeVisible();
    await expect(patientCard.getByText(findings, { exact: true })).toHaveCount(0);
    const beforePublication = (await (
      await patientContext.request.get(`/api/patients/${order.patientId}/care-summary`)
    ).json()) as CareSummary;
    expect(JSON.stringify(beforePublication)).not.toContain(findings);
    for (const path of [
      '/api/investigation-worklist?scope=all',
      '/api/investigation-owners',
      `/api/investigations/${order.id}/review-context`,
    ])
      expect((await patientContext.request.get(path)).status()).toBe(403);

    // Explicit publication is separate from review completion and is idempotent.
    const publishPath = `${reviewPath}/${review.id}/publish`;
    for (let repeat = 0; repeat < 2; repeat++)
      expect((await page.request.post(publishPath, { headers, data: {} })).status()).toBe(200);
    const afterPublication = await (await patientContext.request.get('/api/activity')).json();
    expect(afterPublication.items.length).toBe(activityBefore.items.length + 1);
    expect(JSON.stringify(afterPublication)).not.toContain(findings);
    expect(
      (
        await patientContext.request.get(
          `/api/patients/${order.patientId}/care-summary/download?revision=${beforePublication.revision}`,
        )
      ).status(),
    ).toBe(409);
    await patient.getByRole('button', { name: 'Refresh updates', exact: true }).click();
    await expect(patientCard.getByText(findings, { exact: true })).toBeVisible();
    const sharedSummary = (await (
      await patientContext.request.get(`/api/patients/${order.patientId}/care-summary`)
    ).json()) as CareSummary;
    expect(
      sharedSummary.investigations.find((entry) => entry.id === order.id)!.reviews[0].summary,
    ).toBe(findings);

    const thirdNote = `Later supplemental report reopens review ${suffix}`;
    const third = await addResult(patientContext.request, patientHeaders, order.id, thirdNote);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.getByRole('button', { name: 'Awaiting review', exact: true }).click();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Review latest result', exact: true }).click();
    await expect(dialog.getByText(thirdNote, { exact: true })).toBeVisible();
    await dialog.locator('.irm-earlier-results > summary').click();
    await expect(dialog.getByText(findings, { exact: true })).toBeVisible();
    const latestFindings = `New private supplement interpretation ${suffix}`;
    await dialog.getByLabel('Reviewed findings', { exact: true }).fill(latestFindings);
    await dialog
      .getByLabel('Follow-up and next steps', { exact: true })
      .fill('Synthetic next steps for the newest report.');
    let submitted: Record<string, unknown> | undefined;
    let release!: () => void, committed!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const malformed = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      const value = await response.json();
      committed();
      await gate;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ...value, reviews: [{}] }),
      });
    };
    await page.route(`**${reviewPath}`, malformed);
    try {
      await dialog.getByRole('button', { name: 'Save clinical review', exact: true }).click();
      await reached;
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Reviewed findings', { exact: true })).toBeDisabled();
    } finally {
      release();
    }
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    await page.unroute(`**${reviewPath}`, malformed);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(/Confirm the pending save with Retry same request/),
    ).toBeVisible();
    const committedReview = await context(page.request, order.id);
    expect(committedReview.investigation.reviews).toHaveLength(2);
    const retryRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === reviewPath,
    );
    const retryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === reviewPath,
    );
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await retryRequest).postDataJSON()).toEqual(submitted);
    expect((await retryResponse).status()).toBe(200);
    await expect(dialog).toBeHidden();
    expect((await context(page.request, order.id)).investigation.reviews).toEqual(
      committedReview.investigation.reviews,
    );
    await patient.getByRole('button', { name: 'Refresh updates', exact: true }).click();
    await expect(patientCard.getByText(findings, { exact: true })).toBeVisible();
    await expect(patientCard.getByText(latestFindings, { exact: true })).toHaveCount(0);
    await expect(patientCard.getByText(thirdNote, { exact: true })).toBeVisible();
    const own = await (
      await patientContext.request.get(`/api/patients/${order.patientId}/clinical-workflows`)
    ).json();
    expect(JSON.stringify(own)).not.toContain(latestFindings);
    await patient.setViewportSize({ width: 320, height: 780 });
    await audit(patient);
    await patient.screenshot({
      path: testInfo.outputPath('investigation-patient-history-mobile.png'),
      fullPage: true,
    });
    await page.goto(
      `/clinic/patients/${order.patientId}?tab=workup&investigation=${order.id}&result=${third.results.at(-1)!.id}`,
    );
    await expect(page.locator(`#investigation-result-${third.results.at(-1)!.id}`)).toBeFocused();
    await expect(
      page.locator(`#investigation-${order.id}`).getByText(latestFindings, { exact: true }),
    ).toBeVisible();
  } finally {
    await patientContext.close();
  }
});

test('investigation responsibility preserves private handovers, survives stale and uncertain saves, and falls back when an owner is inactive', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const headers = await login(page.request);
  const patient = await browser.newContext({ baseURL });
  const reception = await browser.newContext({ baseURL });
  try {
    const patientHeaders = await login(patient.request, 'patient@derma.demo');
    const receptionHeaders = await login(reception.request, 'reception@derma.demo');
    const suffix = randomUUID().slice(0, 8);
    const doctorResponse = await page.request.post('/api/doctors', {
      headers,
      data: {
        name: `Dr. Review Owner ${suffix}`,
        title: 'Dermatologist',
        qualifications: 'Synthetic profile',
        specialties: ['General dermatology'],
        experience: 3,
        fee: 600,
        bio: 'Synthetic profile for investigation handover verification.',
        languages: ['English'],
      },
    });
    expect(doctorResponse.status(), await doctorResponse.text()).toBe(201);
    const newDoctor = await doctorResponse.json();
    const accountResponse = await page.request.post('/api/users', {
      headers,
      data: {
        name: newDoctor.name,
        email: `investigation-owner-${suffix}@example.test`,
        password: 'InvestigationOwner2026!',
        role: 'doctor',
        doctorId: newDoctor.id,
      },
    });
    expect(accountResponse.status(), await accountResponse.text()).toBe(201);
    const account = await accountResponse.json();
    const title = `Investigation handover ${suffix}`;
    const order = await createOrder(page.request, headers, title);
    await addResult(patient.request, patientHeaders, order.id, `Initial handover source ${suffix}`);
    const assignmentPath = `/api/investigations/${order.id}/assignment`;
    await page.goto('/clinic/investigations');
    const row = page.locator('.iwq-row').filter({ hasText: title });
    await row.getByRole('button', { name: 'Owner & history', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Investigation ownership', exact: true });
    await expect(page).toHaveURL(new RegExp(`investigation=${order.id}`));
    const form = dialog.locator('.iwq-assignment-form');
    await form.getByLabel('New investigation owner', { exact: true }).selectOption(newDoctor.id);
    const reason = `PRIVATE investigation handover reason ${suffix}`;
    await form.getByLabel('Reason for handover', { exact: true }).fill(reason);
    await addResult(
      patient.request,
      patientHeaders,
      order.id,
      `Result arrived during assignment ${suffix}`,
    );
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === assignmentPath,
    );
    await form.getByRole('button', { name: 'Save assignment', exact: true }).click();
    const rejection = await rejected;
    expect(rejection.status()).toBe(409);
    const rejectedBody = rejection.request().postDataJSON();
    await expect(form.getByLabel('Reason for handover', { exact: true })).toHaveValue(reason);
    await expect(form.getByLabel('New investigation owner', { exact: true })).toHaveValue(
      newDoctor.id,
    );
    await form.getByRole('button', { name: 'Refresh assignment context', exact: true }).click();
    await form
      .getByRole('button', { name: 'I reviewed the latest context; keep my draft', exact: true })
      .click();
    const patientSnapshot = (await (
      await patient.request.get(`/api/patients/${order.patientId}/care-summary`)
    ).json()) as CareSummary;
    let submitted: Record<string, unknown> | undefined;
    const lost = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic missing assignment confirmation.' }),
      });
    };
    await page.route(`**${assignmentPath}`, lost);
    await form.getByRole('button', { name: 'Save assignment', exact: true }).click();
    await expect(
      form.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    await expect(form.getByLabel('Reason for handover', { exact: true })).toBeDisabled();
    await page.unroute(`**${assignmentPath}`, lost);
    expect(submitted?.requestId).not.toBe(rejectedBody.requestId);
    expect(submitted?.expectedRevision).not.toBe(rejectedBody.expectedRevision);
    const committed = await context(page.request, order.id);
    expect(committed.assignments).toHaveLength(1);
    expect(committed.ownerDoctorId).toBe(newDoctor.id);
    await form.getByRole('button', { name: 'Close for now', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Resume pending assignment', exact: true }).click();
    await expect(form.getByLabel('Reason for handover', { exact: true })).toHaveValue(reason);
    const retried = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === assignmentPath,
    );
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await retried).postDataJSON()).toEqual(submitted);
    await expect(dialog).toBeHidden();
    expect((await context(page.request, order.id)).assignments).toEqual(committed.assignments);
    await expect(row.getByText(newDoctor.name, { exact: true })).toBeVisible();
    await page.getByLabel('Investigation owner', { exact: true }).selectOption('mine');
    await expect(row).toHaveCount(0);
    await page.getByLabel('Investigation owner', { exact: true }).selectOption('all');
    await expect(row).toBeVisible();
    const afterHandover = (await (
      await patient.request.get(`/api/patients/${order.patientId}/care-summary`)
    ).json()) as CareSummary;
    expect(afterHandover.revision).toBe(patientSnapshot.revision);
    expect(JSON.stringify(afterHandover)).not.toContain(reason);
    const patientWorkflow = await (
      await patient.request.get(`/api/patients/${order.patientId}/clinical-workflows`)
    ).json();
    const ownOrder = patientWorkflow.investigations.find(
      (entry: Investigation) => entry.id === order.id,
    );
    expect(ownOrder.doctorId).toBe(order.doctorId);
    for (const privateKey of ['ownerDoctorId', 'revision', 'assignments'])
      expect(ownOrder).not.toHaveProperty(privateKey);
    expect(JSON.stringify(patientWorkflow)).not.toContain(reason);

    // An inactive account cannot make an outstanding result disappear. New
    // activity falls back to active clinicians while ownership stays explicit.
    const deactivate = await page.request.patch(`/api/accounts/${account.id}`, {
      headers,
      data: { active: false },
    });
    expect(deactivate.ok(), await deactivate.text()).toBeTruthy();
    await page.getByRole('button', { name: 'Refresh worklist', exact: true }).click();
    await expect(row.getByText('No active linked clinical account', { exact: true })).toBeVisible();
    expect((await context(page.request, order.id)).ownerAvailable).toBe(false);
    const fallback = await addResult(
      patient.request,
      patientHeaders,
      order.id,
      `Fallback result for unavailable owner ${suffix}`,
    );
    const activity = await (await page.request.get('/api/activity')).json();
    const resultHref = `/clinic/patients/${order.patientId}?tab=workup&investigation=${order.id}&result=${fallback.results.at(-1)!.id}`;
    expect(
      activity.items.some((entry: { href: string }) => entry.href === resultHref),
    ).toBeTruthy();
    expect(JSON.stringify(activity)).not.toContain(reason);
    await page.goto(`/clinic/investigations?investigation=${order.id}`);
    await expect(
      dialog.locator('.iwq-assignment-history').getByText(reason, { exact: true }),
    ).toBeVisible();
    await form.getByLabel('New investigation owner', { exact: true }).selectOption(order.doctorId);
    await form
      .getByLabel('Reason for handover', { exact: true })
      .fill('Return responsibility to an available clinician.');
    await page.setViewportSize({ width: 320, height: 780 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('investigation-owner-mobile.png'),
      fullPage: true,
    });
    await form.getByRole('button', { name: 'Save assignment', exact: true }).click();
    await expect(dialog).toBeHidden();
    const final = await context(page.request, order.id);
    expect(final.assignments).toHaveLength(2);
    expect(final.ownerDoctorId).toBe(order.doctorId);
    expect(final.orderedByDoctorId).toBe(order.doctorId);
    expect(final.investigation.dueDate).toBe(order.dueDate);
    expect(final.needsReview).toBe(true);
    await expect(row).toBeVisible();
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('investigation-worklist-mobile.png'),
      fullPage: true,
    });
    for (const request of [patient.request, reception.request])
      for (const path of [
        '/api/investigation-worklist?scope=all',
        '/api/investigation-owners',
        `/api/investigations/${order.id}/review-context`,
      ])
        expect((await request.get(path)).status()).toBe(403);
    for (const [request, memberHeaders] of [
      [patient.request, patientHeaders],
      [reception.request, receptionHeaders],
    ] as const) {
      expect(
        (
          await request.post(assignmentPath, {
            headers: memberHeaders,
            data: {
              doctorId: newDoctor.id,
              reason: 'Unauthorized handover',
              expectedRevision: final.revision,
              requestId: randomUUID(),
            },
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await request.post(`/api/investigations/${order.id}/reviews`, {
            headers: memberHeaders,
            data: {
              resultId: final.latestResultId,
              summary: 'Unauthorized review',
              followUp: '',
              publishToPatient: false,
              expectedRevision: final.revision,
              requestId: randomUUID(),
            },
          })
        ).status(),
      ).toBe(403);
    }
    const receptionPage = await reception.newPage();
    await receptionPage.goto('/clinic/investigations');
    await expect(
      receptionPage.getByRole('heading', { name: 'Investigation worklist', exact: true }),
    ).toHaveCount(0);
  } finally {
    await patient.close();
    await reception.close();
  }
});

test('review requests reject old matching successes and retain their exact UUID after identity conflicts', async ({
  page,
}) => {
  const headers = await login(page.request);
  const suffix = randomUUID().slice(0, 8);
  const order = await createOrder(page.request, headers, `Review confirmation ${suffix}`);
  await addResult(page.request, headers, order.id, 'Synthetic result with an existing review.');
  const source = await context(page.request, order.id);
  const summary = `Repeated review text ${suffix}`;
  const followUp = `Repeated next steps ${suffix}`;
  const reviewPath = `/api/investigations/${order.id}/reviews`;
  const seededResponse = await page.request.post(reviewPath, {
    headers,
    data: {
      resultId: source.latestResultId,
      summary,
      followUp,
      publishToPatient: false,
      expectedRevision: source.revision,
      requestId: randomUUID(),
    },
  });
  expect(seededResponse.status()).toBe(201);
  const seeded = (await seededResponse.json()) as Investigation;
  await page.goto(`/clinic/patients/${order.patientId}?tab=workup&investigation=${order.id}`);
  const card = page.locator(`#investigation-${order.id}`);
  await card.getByRole('button', { name: 'Add another review', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review investigation findings', exact: true });
  await dialog.getByLabel('Reviewed findings', { exact: true }).fill(summary);
  await dialog.getByLabel('Follow-up and next steps', { exact: true }).fill(followUp);
  let savedBody: Record<string, unknown> | undefined;
  const oldSuccess = async (route: Route) => {
    savedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(seeded),
    });
  };
  await page.route(`**${reviewPath}`, oldSuccess);
  await dialog.getByRole('button', { name: 'Save clinical review', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('did not confirm this new review');
  await expect(dialog.getByLabel('Reviewed findings', { exact: true })).toBeDisabled();
  expect((await context(page.request, order.id)).investigation.reviews).toHaveLength(1);
  await page.unroute(`**${reviewPath}`, oldSuccess);
  const collision = async (route: Route) => {
    expect(route.request().postDataJSON()).toEqual(savedBody);
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'This investigation request was already used with different details',
      }),
    });
  };
  await page.route(`**${reviewPath}`, collision);
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already used with different details');
  await expect(
    dialog.getByRole('button', { name: 'Refresh latest investigation', exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByLabel('Reviewed findings', { exact: true })).toBeDisabled();
  await page.unroute(`**${reviewPath}`, collision);
  const retry = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === reviewPath,
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await retry).postDataJSON()).toEqual(savedBody);
  await expect(dialog).toBeHidden();
  const final = await context(page.request, order.id);
  expect(final.investigation.reviews).toHaveLength(2);
  expect(final.investigation.reviews[0]).toEqual(seeded.reviews[0]);
  expect(final.investigation.reviews[1].id).not.toBe(seeded.reviews[0].id);
});

test('wrong-account handover and empty publication confirmations remain unconfirmed until their original actions are retried', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(60000);
  const headers = await login(page.request);
  const patient = await browser.newContext({ baseURL });
  try {
    await login(patient.request, 'patient@derma.demo');
    const suffix = randomUUID().slice(0, 8);
    const order = await createOrder(
      page.request,
      headers,
      `Strict response confirmation ${suffix}`,
    );
    await addResult(page.request, headers, order.id, `Synthetic confirmation result ${suffix}`);
    const accountResponse = await page.request.post('/api/users', {
      headers,
      data: {
        name: `Synthetic receiving clinician ${suffix}`,
        email: `confirmation-owner-${suffix}@example.test`,
        password: 'ConfirmationOwner2026!',
        role: 'doctor',
        doctorId: 'doctor-arjun',
      },
    });
    expect(accountResponse.status(), await accountResponse.text()).toBe(201);
    await page.goto(`/clinic/investigations?investigation=${order.id}`);
    const dialog = page.getByRole('dialog', { name: 'Investigation ownership', exact: true });
    const form = dialog.locator('.iwq-assignment-form');
    const reason = `Private provenance-sensitive handover ${suffix}`;
    await form.getByLabel('New investigation owner', { exact: true }).selectOption('doctor-arjun');
    await form.getByLabel('Reason for handover', { exact: true }).fill(reason);
    const assignmentPath = `/api/investigations/${order.id}/assignment`;
    let submitted: Record<string, unknown> | undefined;
    let savedAssignment: InvestigationReviewContext | undefined;
    const wrongAuthor = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      savedAssignment = (await response.json()) as InvestigationReviewContext;
      expect(savedAssignment.assignments).toHaveLength(1);
      expect(savedAssignment.assignments[0].assignedById).toBe('user-admin');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...savedAssignment,
          assignments: savedAssignment.assignments.map((entry) => ({
            ...entry,
            assignedById: 'user-doctor',
          })),
        }),
      });
    };
    await page.route(`**${assignmentPath}`, wrongAuthor);
    await form.getByRole('button', { name: 'Save assignment', exact: true }).click();
    await expect(
      form.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    await expect(form.getByRole('alert')).toContainText('did not confirm the submitted handover');
    await expect(form.getByLabel('Reason for handover', { exact: true })).toHaveValue(reason);
    await expect(form.getByLabel('Reason for handover', { exact: true })).toBeDisabled();
    await expect(form.getByLabel('New investigation owner', { exact: true })).toBeDisabled();
    await expect(
      page.getByText(
        'Investigation responsibility assigned. The original order and clinical history are preserved.',
        { exact: true },
      ),
    ).toHaveCount(0);
    expect((await context(page.request, order.id)).assignments).toEqual(
      savedAssignment!.assignments,
    );
    await page.unroute(`**${assignmentPath}`, wrongAuthor);
    const assignmentRetry = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === assignmentPath,
    );
    const assignmentConfirmation = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === assignmentPath,
    );
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await assignmentRetry).postDataJSON()).toEqual(submitted);
    expect((await assignmentConfirmation).status()).toBe(200);
    await expect(dialog).toBeHidden();
    expect((await context(page.request, order.id)).assignments).toEqual(
      savedAssignment!.assignments,
    );

    const source = await context(page.request, order.id);
    const reviewResponse = await page.request.post(`/api/investigations/${order.id}/reviews`, {
      headers,
      data: {
        resultId: source.latestResultId,
        summary: `Private publication fixture ${suffix}`,
        followUp: 'Discuss this synthetic review with the clinic.',
        publishToPatient: false,
        expectedRevision: source.revision,
        requestId: randomUUID(),
      },
    });
    expect(reviewResponse.status(), await reviewResponse.text()).toBe(201);
    const reviewed = (await reviewResponse.json()) as Investigation;
    const review = reviewed.reviews.at(-1)!;
    expect(review.publishedAt).toBeNull();
    const activityBefore = await (await patient.request.get('/api/activity?limit=100')).json();
    const publicationPath = `/api/investigations/${order.id}/reviews/${review.id}/publish`;
    await page.goto(`/clinic/patients/${order.patientId}?tab=workup&investigation=${order.id}`);
    const card = page.locator(`#investigation-${order.id}`);
    let publishedAt: string | null = null;
    const missingTimestamp = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      const saved = (await response.json()) as Investigation;
      publishedAt = saved.reviews.find((entry) => entry.id === review.id)!.publishedAt;
      expect(publishedAt).toBeTruthy();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...saved,
          reviews: saved.reviews.map((entry) =>
            entry.id === review.id ? { ...entry, publishedAt: '' } : entry,
          ),
        }),
      });
    };
    await page.route(`**${publicationPath}`, missingTimestamp);
    await card.getByRole('button', { name: 'Share reviewed findings', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Publication could not be confirmed.' }),
    ).toBeVisible();
    await expect(
      page.getByText('Reviewed findings shared with the patient.', { exact: true }),
    ).toHaveCount(0);
    await expect(
      card.getByRole('button', { name: 'Share reviewed findings', exact: true }),
    ).toBeEnabled();
    await expect(card.getByText('Clinic only', { exact: true })).toBeVisible();
    const actualPublication = (await context(page.request, order.id)).investigation.reviews.find(
      (entry) => entry.id === review.id,
    )!;
    expect(actualPublication.publishedAt).toBe(publishedAt);
    const activityCommitted = await (await patient.request.get('/api/activity?limit=100')).json();
    expect(activityCommitted.items.length).toBe(activityBefore.items.length + 1);
    await page.unroute(`**${publicationPath}`, missingTimestamp);
    const publicationRetry = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === publicationPath,
    );
    await card.getByRole('button', { name: 'Share reviewed findings', exact: true }).click();
    expect((await publicationRetry).status()).toBe(200);
    await expect(card.getByText('Shared with patient', { exact: true })).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Share reviewed findings', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText('Reviewed findings shared with the patient.', { exact: true }),
    ).toBeVisible();
    const final = await context(page.request, order.id);
    expect(final.investigation.reviews).toHaveLength(1);
    expect(final.investigation.reviews[0]).toEqual(actualPublication);
    expect(final.assignments).toEqual(savedAssignment!.assignments);
    const activityRetried = await (await patient.request.get('/api/activity?limit=100')).json();
    expect(activityRetried.items).toEqual(activityCommitted.items);
  } finally {
    await patient.close();
  }
});
