import { test, expect, type Download } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CareSummary } from '../../shared/care-summary';
import type { CarePlan, ClinicalImage } from '../../shared/types';
import type { ImageAnnotationHistory } from '../../shared/image-annotations';
import type { Investigation, ProcedureRecord } from '../../shared/clinical';
import type { PatientDocument } from '../../shared/documents';
import type { Invoice } from '../../shared/operations';
import { syntheticPdf } from '../fixtures/report';

const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const after = (days: number) =>
  new Date(Date.parse(`${today()}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const displayedDate = (date: string) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00+05:30`));

test('patient and clinician read the same portable shared snapshot, retain original instructions, and refresh a stale download', async ({
  page,
  browser,
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(90000);
  const doctor = await playwright.request.newContext({ baseURL });
  const suffix = randomUUID().slice(0, 8);
  const privateMarker = `PRIVATE-SUMMARY-${suffix}`;
  const summaryPath = '/api/patients/patient-ananya/care-summary';
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=';
  try {
    const login = await doctor.post('/api/auth/login', {
      data: { email: 'doctor@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(login.ok()).toBeTruthy();
    const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
    async function post<T>(path: string, data: unknown, expectedStatus = 201): Promise<T> {
      const response = await doctor.post(`/api${path}`, { headers, data });
      expect(response.status(), await response.text()).toBe(expectedStatus);
      return response.json() as Promise<T>;
    }
    const title = `Portable original care plan ${suffix}`;
    const originalInstructions = `Original synthetic regimen instructions ${suffix}`;
    const sharedInstructions = `Shared follow-up instructions ${suffix}`;
    const plan = await post<CarePlan>('/care-plans', {
      patientId: 'patient-ananya',
      title,
      instructions: originalInstructions,
      startDate: today(),
      endDate: after(30),
      followUpDate: after(7),
      medications: [
        {
          name: `Synthetic regimen ${suffix}`,
          instructions: 'Preserved original medication instructions.',
          schedule: 'Original recorded schedule',
          duration: 'Original recorded duration',
          warnings: 'Synthetic documentation only.',
        },
      ],
    });
    const plans = (await (await doctor.get('/api/care-plans')).json()) as CarePlan[];
    await post(`/care-plans/${plan.id}/reviews`, {
      expectedRevision: plans.find((entry) => entry.id === plan.id)!.followUpRevision,
      assessment: `${privateMarker} internal follow-up assessment`,
      patientInstructions: sharedInstructions,
      disposition: 'continue',
      nextReviewDate: after(14),
    });
    const encounter = await post<{ id: string }>('/encounters', {
      patientId: 'patient-ananya',
      assessment: `${privateMarker} internal encounter`,
      plan: 'Internal documentation only.',
    });
    await post(`/encounters/${encounter.id}/amendments`, {
      reason: 'Synthetic correction',
      text: `${privateMarker} private amendment`,
    });
    const uploadedDocument = await post<PatientDocument>('/documents', {
      patientId: 'patient-ananya',
      title: `Portable report ${suffix}`,
      originalName: `synthetic-summary-${suffix}.pdf`,
      dataUrl: `data:application/pdf;base64,${syntheticPdf().toString('base64')}`,
      consent: true,
    });
    const image = await post<ClinicalImage>('/images', {
      patientId: 'patient-ananya',
      caption: `Portable image ${suffix}`,
      category: 'clinical',
      dataUrl: `data:image/png;base64,${png}`,
      consent: true,
    });
    const annotationPath = `/images/${image.id}/annotations`;
    const initialAnnotations = (await (
      await doctor.get(`/api${annotationPath}`)
    ).json()) as ImageAnnotationHistory;
    const sharedAnnotation = `Shared image documentation ${suffix}`;
    const draft = await post<ImageAnnotationHistory>(annotationPath, {
      expectedRevision: initialAnnotations.revision,
      note: sharedAnnotation,
      markers: [
        {
          id: randomUUID(),
          type: 'rectangle',
          color: 'blue',
          label: 'Shared area description',
          x: 0.2,
          y: 0.2,
          width: 0.3,
          height: 0.3,
        },
      ],
    });
    const published = await post<ImageAnnotationHistory>(
      `${annotationPath}/${draft.versions[0].id}/publish`,
      {
        expectedRevision: draft.revision,
        patientSharingConfirmed: true,
      },
      200,
    );
    const investigation = await post<Investigation>('/investigations', {
      patientId: 'patient-ananya',
      title: `Portable investigation ${suffix}`,
      kind: 'laboratory',
      reason: 'Synthetic investigation documentation.',
      instructions: 'Synthetic requested information.',
    });
    const withResult = await post<Investigation>(`/investigations/${investigation.id}/results`, {
      note: `Submitted report information ${suffix}`,
      documentIds: [uploadedDocument.id],
    });
    const resultId = withResult.results[0].id;
    await post(`/investigations/${investigation.id}/reviews`, {
      resultId,
      summary: `${privateMarker} unpublished result interpretation`,
      followUp: '',
      publishToPatient: false,
    });
    const sharedInterpretation = `Shared clinician interpretation ${suffix}`;
    const procedure = await post<ProcedureRecord>('/procedures', {
      patientId: 'patient-ananya',
      title: `Portable procedure ${suffix}`,
      indication: 'Synthetic indication',
      benefits: 'Synthetic benefits discussion',
      risks: 'Synthetic risk discussion',
      alternatives: 'Synthetic alternatives discussion',
      aftercare: 'Synthetic planned aftercare',
      estimatedCost: 'An estimate only, not an invoice.',
    });
    await post(`/procedures/${procedure.id}/agreements`, {
      decision: 'agreed',
      method: 'in-person',
      patientDecisionConfirmed: true,
      note: `Recorded procedure decision ${suffix}`,
    });
    await post(
      `/procedures/${procedure.id}/complete`,
      {
        outcome: `Recorded synthetic outcome ${suffix}`,
        aftercare: 'Recorded completion instructions.',
      },
      200,
    );
    const invoice = await post<Invoice>('/invoices', {
      requestId: randomUUID(),
      patientId: 'patient-ananya',
      items: [
        {
          description: `Explicit summary fixture charge ${suffix}`,
          quantity: 1,
          unitAmountPaise: 2505,
        },
      ],
    });

    await page.goto('/login');
    await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
    await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/my-care$/);
    const patientSession = await (await page.request.get('/api/session')).json();
    const checkIn = await page.request.post('/api/check-ins', {
      headers: { 'X-CSRF-Token': patientSession.csrfToken },
      data: {
        carePlanId: plan.id,
        date: today(),
        adherence: 'partial',
        feeling: 'same',
        note: `Patient-reported progress ${suffix}`,
      },
    });
    expect(checkIn.status()).toBe(201);
    await page.getByRole('link', { name: 'View care summary', exact: true }).click();
    await expect(page).toHaveURL(/\/my-care\/summary$/);
    await expect(page.getByRole('heading', { name: 'Care summary', exact: true })).toBeVisible();
    const content = page.locator('.care-summary-document');
    const planCard = content
      .locator('.care-summary-entry')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(planCard.getByText(originalInstructions, { exact: true })).toBeVisible();
    await expect(planCard.getByText(sharedInstructions, { exact: true })).toBeVisible();
    await expect(
      planCard.getByText('Preserved original medication instructions.', { exact: true }),
    ).toBeVisible();
    await expect(planCard.getByText(displayedDate(after(7)), { exact: true })).toBeVisible();
    await expect(planCard.getByText(displayedDate(after(14)), { exact: true })).toBeVisible();
    await expect(
      content.getByText(`Patient-reported progress ${suffix}`, { exact: true }),
    ).toBeVisible();
    await expect(content.getByText(sharedAnnotation, { exact: true })).toBeVisible();
    await expect(
      content.getByRole('heading', { name: uploadedDocument.title, exact: true }),
    ).toBeVisible();
    await expect(
      content.getByText(`Recorded procedure decision ${suffix}`, { exact: true }),
    ).toBeVisible();
    await expect(
      content.getByText(`Recorded synthetic outcome ${suffix}`, { exact: true }),
    ).toBeVisible();
    await expect(content.getByRole('heading', { name: invoice.number, exact: true })).toBeVisible();
    await expect(content.getByText(privateMarker, { exact: false })).toHaveCount(0);
    await expect(content.locator('img')).toHaveCount(0);

    const snapshot = (await (await page.request.get(summaryPath)).json()) as CareSummary;
    const clinicianSnapshot = (await (await doctor.get(summaryPath)).json()) as CareSummary;
    const { generatedAt: _patientTime, ...patientVisible } = snapshot;
    const { generatedAt: _clinicalTime, ...clinicalVisible } = clinicianSnapshot;
    expect(clinicalVisible).toEqual(patientVisible);
    const clinicianContext = await browser.newContext({
      baseURL,
      storageState: await doctor.storageState(),
    });
    try {
      const clinicalPage = await clinicianContext.newPage();
      await clinicalPage.goto('/clinic/patients/patient-ananya/summary');
      await expect(clinicalPage.getByText(sharedInstructions, { exact: true })).toBeVisible();
      await expect(clinicalPage.getByText(privateMarker, { exact: false })).toHaveCount(0);
    } finally {
      await clinicianContext.close();
    }
    async function downloadSummary(): Promise<CareSummary> {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/^care-summary-\d{4}-\d{2}-\d{2}\.json$/);
      const serialized = await readFile((await file.path())!, 'utf8');
      expect(serialized).not.toContain(privateMarker);
      expect(serialized).not.toContain(png);
      for (const key of [
        'messages',
        'encounters',
        'amendments',
        'assessment',
        'checkInSnapshots',
        'followUpRevision',
        'dataUrl',
        'bytes',
      ]) {
        expect(serialized).not.toContain(`"${key}"`);
      }
      const downloaded = JSON.parse(serialized) as CareSummary;
      const fileDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(downloaded.generatedAt));
      expect(file.suggestedFilename()).toBe(`care-summary-${fileDate}.json`);
      return downloaded;
    }
    const saved = await downloadSummary();
    expect(saved.revision).toBe(snapshot.revision);
    expect(saved.carePlans.find((entry) => entry.id === plan.id)?.endDate).toBe(after(30));
    expect(saved.imageAnnotations.find((entry) => entry.imageId === image.id)?.note).toBe(
      sharedAnnotation,
    );
    expect(saved.invoices.find((entry) => entry.id === invoice.id)?.totalPaise).toBe(2505);

    // Internal revisions must not invalidate the patient's displayed snapshot.
    await post(annotationPath, {
      expectedRevision: published.revision,
      note: `${privateMarker} newer private annotation`,
      markers: [],
    });
    expect((await downloadSummary()).revision).toBe(snapshot.revision);
    // A newly shared clinical interpretation must require an explicit refresh.
    await post(`/investigations/${investigation.id}/reviews`, {
      resultId,
      summary: sharedInterpretation,
      followUp: 'Shared follow-up after review.',
      publishToPatient: true,
    });
    const downloads: Download[] = [];
    const captureDownload = (file: Download) => downloads.push(file);
    page.on('download', captureDownload);
    await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Your shared care record has changed');
    await expect(page.getByRole('button', { name: 'Download JSON', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Print summary', exact: true })).toBeEnabled();
    await expect(content.getByText(sharedInterpretation, { exact: true })).toHaveCount(0);
    expect(downloads).toHaveLength(0);
    await page.evaluate(() => {
      window.print = () => document.documentElement.setAttribute('data-summary-printed', 'true');
    });
    await page.getByRole('button', { name: 'Print summary', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-summary-printed', 'true');
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'Print summary', exact: true })).toBeHidden();
    await expect(planCard.getByText(originalInstructions, { exact: true })).toBeVisible();
    await expect(content.getByText(sharedAnnotation, { exact: true })).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
    await page.getByRole('button', { name: 'Refresh to download', exact: true }).click();
    await expect(content.getByText(sharedInterpretation, { exact: true })).toBeVisible();
    const refreshed = await downloadSummary();
    expect(refreshed.revision).not.toBe(snapshot.revision);
    expect(downloads).toHaveLength(1);
    page.off('download', captureDownload);

    // A delayed download from a discarded snapshot cannot reintroduce an error.
    let release!: () => void;
    let arrived!: () => void;
    let settled!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    await page.route(`**${summaryPath}/download?*`, async (route) => {
      arrived();
      await gate;
      try {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Discarded download error' }),
        });
      } finally {
        settled();
      }
    });
    try {
      await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
      await ready;
      await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Download JSON', exact: true })).toBeEnabled();
      release();
      await done;
      await expect(page.getByText('Discarded download error', { exact: true })).toHaveCount(0);
      await expect(content.getByText(sharedInterpretation, { exact: true })).toBeVisible();
    } finally {
      release();
      await page.unroute(`**${summaryPath}/download?*`);
    }

    const imageEntry = content
      .locator('.care-summary-entry')
      .filter({ has: page.getByRole('heading', { name: image.caption, exact: true }) });
    await imageEntry
      .getByRole('link', { name: 'View original image and shared annotations →', exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/my-care/record\\?tab=images&image=${image.id}$`));
    const viewer = page.getByRole('dialog', { name: 'Image details', exact: true });
    await expect(viewer.getByText(sharedAnnotation, { exact: true })).toBeVisible();
    await expect(viewer.getByText(privateMarker, { exact: false })).toHaveCount(0);
    await viewer.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('link', { name: 'View care summary', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 780 });
    await expect(page.getByRole('button', { name: 'Download JSON', exact: true })).toBeEnabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    // The earlier intentionally aborted download need not settle the browser's
    // global network-idle tracker. Verify the rendered snapshot and fonts instead.
    await expect(content.getByText(sharedInterpretation, { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('care-summary-mobile.png'), fullPage: true });
  } finally {
    await doctor.dispose();
  }
});
