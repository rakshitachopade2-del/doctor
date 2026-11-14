import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Route,
  type Download,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Session } from '../../shared/types';
import type { CareSummary } from '../../shared/care-summary';
import type {
  CareSummaryCopyDetail,
  CareSummaryCopyInput,
  CareSummaryCopyPage,
  CareSummaryCopyResult,
} from '../../shared/care-summary-copies';
import type { PatientProfile } from '../../shared/patient-profile';
import type { Invoice } from '../../shared/operations';
import type { Investigation, ProcedureRecord } from '../../shared/clinical';
import type { PatientDocument } from '../../shared/documents';
import { syntheticPdf } from '../fixtures/report';

const reviewLabel = 'I reviewed this summary and want to save an unchanged copy.';
const summaryApi = (id = 'patient-ananya') => `/api/patients/${id}/care-summary`;
const copyApi = (id = 'patient-ananya') => `${summaryApi(id)}/copies`;
async function login(request: APIRequestContext, email: string) {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  path: string,
  data: unknown,
  status = 201,
): Promise<T> {
  const response = await request.post(path, { headers, data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function openSave(page: Page) {
  await page.getByRole('button', { name: 'Save copy', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save a care summary copy', exact: true });
  await expect(dialog.getByLabel(reviewLabel, { exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save copy', exact: true })).toBeDisabled();
  return dialog;
}
async function save(page: Page, id = 'patient-ananya') {
  const dialog = await openSave(page);
  await dialog.getByLabel(reviewLabel, { exact: true }).check();
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === copyApi(id) && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Save copy', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(201);
  const result = (await response.json()) as CareSummaryCopyResult;
  await expect(page).toHaveURL(new RegExp(`view=copies&copy=${result.copy.id}$`));
  await expect(
    page.getByRole('heading', { name: 'Saved care summary', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download saved JSON', exact: true }),
  ).toBeEnabled();
  return result;
}
async function download(page: Page, copyId: string) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download saved JSON', exact: true }).click();
  const file = await waiting;
  expect(file.suggestedFilename()).toBe(`care-summary-copy-${copyId}.json`);
  return readFile((await file.path())!);
}
async function mobileAudit(page: Page) {
  await page.setViewportSize({ width: 320, height: 820 });
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('patient and clinician share a dated archive whose clinical, contact and billing snapshot prints and downloads unchanged', async ({
  page,
  browser,
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const staff = await playwright.request.newContext({ baseURL });
  const suffix = randomUUID().slice(0, 8),
    privateNote = `PRIVATE_COPY_${suffix}`;
  try {
    const { headers } = await login(staff, 'admin@derma.demo');
    const patientSession = await login(page.request, 'patient@derma.demo');
    const document = await post<PatientDocument>(staff, headers, '/api/documents', {
      patientId: 'patient-ananya',
      title: `Saved report ${suffix}`,
      originalName: 'synthetic-copy.pdf',
      dataUrl: `data:application/pdf;base64,${syntheticPdf('Synthetic archived report').toString('base64')}`,
      consent: true,
    });
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCeoAAAAASUVORK5CYII=';
    await post(staff, headers, '/api/images', {
      patientId: 'patient-ananya',
      caption: `Saved image ${suffix}`,
      category: 'clinical',
      dataUrl: `data:image/png;base64,${png}`,
      consent: true,
    });
    const investigation = await post<Investigation>(staff, headers, '/api/investigations', {
      patientId: 'patient-ananya',
      title: `Saved investigation ${suffix}`,
      kind: 'laboratory',
      reason: 'Synthetic request',
      instructions: 'Shared result instructions',
    });
    const result = await post<Investigation>(
      page.request,
      patientSession.headers,
      `/api/investigations/${investigation.id}/results`,
      { note: `Submitted copy result ${suffix}`, documentIds: [document.id] },
    );
    const sharedReview = `Published copy review ${suffix}`;
    await post(staff, headers, `/api/investigations/${investigation.id}/reviews`, {
      resultId: result.results[0].id,
      summary: sharedReview,
      followUp: 'Shared recorded next steps',
      publishToPatient: true,
    });
    const procedure = await post<ProcedureRecord>(staff, headers, '/api/procedures', {
      patientId: 'patient-ananya',
      title: `Saved procedure ${suffix}`,
      indication: 'Patient-specific synthetic indication',
      benefits: 'Recorded benefits',
      risks: 'Recorded risks',
      alternatives: 'Recorded alternatives',
      aftercare: 'Recorded planned aftercare',
      estimatedCost: 'Estimate only',
    });
    await post(page.request, patientSession.headers, `/api/procedures/${procedure.id}/agreements`, {
      decision: 'agreed',
      method: 'portal',
      note: 'Recorded patient decision',
    });
    await post(staff, headers, '/api/encounters', {
      patientId: 'patient-ananya',
      assessment: privateNote,
      plan: 'Internal documentation',
    });
    await post(staff, headers, '/api/messages', {
      patientId: 'patient-ananya',
      body: `${privateNote} private message`,
    });
    const invoice = await post<Invoice>(staff, headers, '/api/invoices', {
      patientId: 'patient-ananya',
      requestId: randomUUID(),
      items: [{ description: `Saved charge ${suffix}`, quantity: 1, unitAmountPaise: 2505 }],
    });
    const profile = await get<PatientProfile>(staff, '/api/patients/patient-ananya/profile');

    await page.goto('/my-care/summary');
    await expect(
      page.locator('.care-summary-document').getByText(sharedReview, { exact: true }),
    ).toBeVisible();
    const saved = await save(page);
    const content = page.locator('.care-summary-document');
    await expect(content.locator('.care-summary-copy-provenance')).toContainText(
      `${patientSession.session.user!.name} (patient)`,
    );
    await expect(content.getByText('Allergy record at copy time', { exact: true })).toBeVisible();
    await expect(content.getByRole('heading', { name: document.title, exact: true })).toBeVisible();
    await expect(
      content.getByRole('heading', { name: procedure.title, exact: true }),
    ).toBeVisible();
    await expect(content.getByText(privateNote, { exact: false })).toHaveCount(0);
    await expect(content.locator('img')).toHaveCount(0);
    const oldBytes = await download(page, saved.copy.id);
    const old = JSON.parse(oldBytes.toString('utf8')) as CareSummary;
    expect(createHash('sha256').update(oldBytes).digest('hex')).toBe(saved.copy.contentSha256);
    expect(oldBytes.length).toBe(saved.copy.byteLength);
    expect(oldBytes.toString('utf8')).not.toContain(privateNote);
    expect(oldBytes.toString('utf8')).not.toContain(png);
    expect(old.invoices.find((entry) => entry.id === invoice.id)!.paidPaise).toBe(0);

    const correctedPhone = `9000${String(Date.now()).slice(-6)}`;
    const corrected = await staff.patch('/api/patients/patient-ananya/profile', {
      headers,
      data: {
        ...profile.demographics,
        phone: correctedPhone,
        reason: 'Synthetic contact correction after the saved copy',
        expectedRevision: profile.revision,
        requestId: randomUUID(),
      },
    });
    expect(corrected.status(), await corrected.text()).toBe(200);
    await post(staff, headers, `/api/invoices/${invoice.id}/payments`, {
      amountPaise: 500,
      method: 'cash',
      requestId: randomUUID(),
    });
    await page.getByRole('button', { name: 'Current summary', exact: true }).click();
    await expect(content.getByText(correctedPhone, { exact: true })).toBeVisible();
    const latest = await get<CareSummary>(page.request, summaryApi());
    expect(latest.invoices.find((entry) => entry.id === invoice.id)!.paidPaise).toBe(500);
    expect(latest.revision).not.toBe(saved.copy.sourceRevision);
    await page.getByRole('button', { name: 'Saved copies', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Saved care summaries', exact: true }),
    ).toBeVisible();
    const card = page
      .locator('.care-copy-card')
      .filter({ has: page.locator(`a[href*="copy=${saved.copy.id}"]`) });
    await expect(card).toContainText('Saved by');
    await card.getByRole('link', { name: /^Open saved copy/ }).click();
    await expect(content.getByText(profile.demographics.phone, { exact: true })).toBeVisible();
    await expect(content.getByText(correctedPhone, { exact: true })).toHaveCount(0);
    const invoiceEntry = content
      .locator('.care-summary-entry')
      .filter({ has: page.getByRole('heading', { name: invoice.number, exact: true }) });
    await expect(invoiceEntry.locator('.care-summary-invoice-totals')).toContainText(
      'Balance ₹25.05',
    );
    expect(await download(page, saved.copy.id)).toEqual(oldBytes);

    await page.evaluate(() => {
      (window as unknown as { copyPrints: number }).copyPrints = 0;
      window.print = () => {
        (window as unknown as { copyPrints: number }).copyPrints++;
        window.dispatchEvent(new Event('beforeprint'));
      };
    });
    await page.getByRole('button', { name: 'Print saved copy', exact: true }).click();
    expect(
      await page.evaluate(() => (window as unknown as { copyPrints: number }).copyPrints),
    ).toBe(1);
    await page.emulateMedia({ media: 'print' });
    await expect(content.locator('.care-summary-copy-provenance')).toBeVisible();
    await expect(invoiceEntry.locator('.care-summary-invoice-totals')).toContainText(
      'Balance ₹25.05',
    );
    await expect(page.getByRole('button', { name: 'Current summary', exact: true })).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: null });
    await mobileAudit(page);
    await page.screenshot({
      path: testInfo.outputPath('saved-care-copy-mobile.png'),
      fullPage: true,
    });

    const clinicalContext = await browser.newContext({
      baseURL,
      storageState: await staff.storageState(),
    });
    try {
      const clinical = await clinicalContext.newPage();
      await clinical.goto(
        `/clinic/patients/patient-ananya/summary?view=copies&copy=${saved.copy.id}`,
      );
      await expect(clinical.locator('.care-summary-copy-provenance')).toContainText('(patient)');
      await expect(
        clinical
          .locator('.care-summary-document')
          .getByText(profile.demographics.phone, { exact: true }),
      ).toBeVisible();
      await clinical.getByRole('button', { name: 'Current summary', exact: true }).click();
      await expect(clinical.getByRole('button', { name: 'Save copy', exact: true })).toBeEnabled();
      const clinicianCopy = await save(clinical);
      expect(clinicianCopy.copy.savedBy.role).toBe('admin');
      const detail = await get<CareSummaryCopyDetail>(
        page.request,
        `${copyApi()}/${clinicianCopy.copy.id}`,
      );
      expect(detail.summary.patient.phone).toBe(correctedPhone);
      expect(detail.summary.invoices.find((entry) => entry.id === invoice.id)!.paidPaise).toBe(500);
      await page.getByRole('button', { name: 'Saved copies', exact: true }).click();
      await expect(
        page.locator(`.care-copy-card a[href*="copy=${clinicianCopy.copy.id}"]`),
      ).toBeVisible();
    } finally {
      await clinicalContext.close();
    }
  } finally {
    await staff.dispose();
  }
});

test('stale sources require reviewing the new summary and uncertain saves retain the exact request through malformed, later error and wrong-actor receipts', async ({
  page,
  playwright,
  baseURL,
}) => {
  test.setTimeout(90000);
  const staff = await playwright.request.newContext({ baseURL });
  try {
    const { headers } = await login(staff, 'admin@derma.demo');
    await login(page.request, 'patient@derma.demo');
    await page.goto('/my-care/summary');
    await expect(page.getByRole('button', { name: 'Save copy', exact: true })).toBeEnabled();
    let dialog = await openSave(page);
    const invoice = await post<Invoice>(staff, headers, '/api/invoices', {
      patientId: 'patient-ananya',
      requestId: randomUUID(),
      items: [
        {
          description: `Stale-copy charge ${randomUUID().slice(0, 8)}`,
          quantity: 1,
          unitAmountPaise: 1200,
        },
      ],
    });
    await dialog.getByLabel(reviewLabel, { exact: true }).check();
    const staleResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === copyApi() && response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Save copy', exact: true }).click();
    const stale = await staleResponse;
    expect(stale.status()).toBe(409);
    const staleBody = stale.request().postDataJSON() as CareSummaryCopyInput;
    await dialog.getByRole('button', { name: 'Refresh summary for review', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page
        .locator('.care-summary-document')
        .getByRole('heading', { name: invoice.number, exact: true }),
    ).toBeVisible();
    const baseline = await get<CareSummaryCopyPage>(page.request, copyApi());
    const attempts: CareSummaryCopyInput[] = [];
    let committed: CareSummaryCopyResult | undefined;
    const intercepted = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 2) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Synthetic later failure after an uncertain save.' }),
        });
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(attempts.length === 1 ? 201 : 200);
      const value = (await response.json()) as CareSummaryCopyResult;
      if (attempts.length === 1) {
        committed = value;
        await route.fulfill({ response, json: { copy: null, receipt: value.receipt } });
      } else if (attempts.length === 3)
        await route.fulfill({
          response,
          json: { ...value, receipt: { ...value.receipt, actorId: 'another-account' } },
        });
      else await route.fulfill({ response });
    };
    await page.route(`**${copyApi()}`, intercepted);
    try {
      dialog = await openSave(page);
      await dialog.getByLabel(reviewLabel, { exact: true }).check();
      await dialog.getByRole('button', { name: 'Save copy', exact: true }).click();
      await expect(
        dialog.getByText('The save outcome could not be confirmed.', { exact: false }),
      ).toBeVisible();
      await expect(dialog.getByLabel(reviewLabel, { exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('Synthetic later failure');
      await expect(dialog.getByLabel(reviewLabel, { exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('complete matching care summary');
      await expect(page).toHaveURL(/\/my-care\/summary$/);
      expect((await get<CareSummaryCopyPage>(page.request, copyApi())).total).toBe(
        baseline.total + 1,
      );
      const retry = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === copyApi() && response.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
      expect((await retry).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`copy=${committed!.copy.id}$`));
      await expect(
        page.getByRole('button', { name: 'Download saved JSON', exact: true }),
      ).toBeEnabled();
      expect(attempts).toHaveLength(4);
      for (const body of attempts) expect(body).toEqual(attempts[0]);
      expect(attempts[0].requestId).not.toBe(staleBody.requestId);
      expect(attempts[0].expectedRevision).not.toBe(staleBody.expectedRevision);
      expect((await get<CareSummaryCopyPage>(page.request, copyApi())).total).toBe(
        baseline.total + 1,
      );
    } finally {
      await page.unroute(`**${copyApi()}`, intercepted);
    }
  } finally {
    await staff.dispose();
  }
});

test('archive reads recover, paginate and fail closed on corrupt downloads while navigation discards late save and download completion', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request, 'admin@derma.demo');
  const person = await post<{ id: string; name: string }>(page.request, headers, '/api/patients', {
    name: `Archive navigation ${randomUUID().slice(0, 8)}`,
    email: '',
    phone: '9000000231',
    dob: '',
    gender: 'Not recorded',
  });
  const currentPath = `/clinic/patients/${person.id}/summary`,
    base = copyApi(person.id);
  const summary = await get<CareSummary>(page.request, summaryApi(person.id));
  const copies: CareSummaryCopyResult[] = [];
  for (let index = 0; index < 27; index++)
    copies.push(
      await post(page.request, headers, base, {
        expectedRevision: summary.revision,
        requestId: randomUUID(),
      }),
    );
  let listUnavailable = true;
  const failList = async (route: Route) => {
    if (listUnavailable)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic saved-copy list unavailable.' }),
      });
    else await route.continue();
  };
  await page.route(`**${base}?*`, failList);
  await page.goto(`${currentPath}?view=copies`);
  await expect(page.getByRole('alert')).toContainText('Synthetic saved-copy list unavailable.');
  await expect(page.locator('.care-copy-card')).toHaveCount(0);
  listUnavailable = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.care-copy-card')).toHaveCount(25);
  await expect(page.locator('.care-copy-card').first()).toContainText(
    `Patient in this copy: ${person.name}`,
  );
  await page.unroute(`**${base}?*`, failList);
  const pagination = page.getByRole('navigation', {
    name: 'Saved care summaries pagination',
    exact: true,
  });
  await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.care-copy-card')).toHaveCount(2);
  await page.goBack();
  await expect(page.locator('.care-copy-card')).toHaveCount(25);
  await page.goForward();
  await expect(page.locator('.care-copy-card')).toHaveCount(2);
  await page.goto(`${currentPath}?view=copies&page=99999`);
  await expect(page).toHaveURL(/page=2$/);
  await expect(page.locator('.care-copy-card')).toHaveCount(2);
  await mobileAudit(page);
  await page.screenshot({
    path: testInfo.outputPath('saved-care-archive-mobile.png'),
    fullPage: true,
  });

  const saved = copies[0],
    detailPath = `${base}/${saved.copy.id}`;
  let detailMalformed = true;
  const malformedDetail = async (route: Route) => {
    const response = await route.fetch();
    const value = (await response.json()) as CareSummaryCopyDetail;
    if (detailMalformed)
      await route.fulfill({
        response,
        json: { ...value, summary: { ...value.summary, carePlans: [null] } },
      });
    else await route.fulfill({ response });
  };
  await page.route(`**${detailPath}`, malformedDetail);
  await page.goto(`${currentPath}?view=copies&copy=${saved.copy.id}`);
  await expect(page.getByRole('alert')).toContainText('complete matching care summary');
  await expect(page.locator('.care-summary-document')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Download saved JSON', exact: true }),
  ).toBeDisabled();
  detailMalformed = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Download saved JSON', exact: true }),
  ).toBeEnabled();
  await page.unroute(`**${detailPath}`, malformedDetail);
  const downloads: Download[] = [];
  const recordDownload = (file: Download) => {
    downloads.push(file);
  };
  page.on('download', recordDownload);
  const corrupt = async (route: Route) => {
    const response = await route.fetch(),
      bytes = Buffer.from(await response.body());
    bytes[0] = bytes[0] === 123 ? 91 : 123;
    await route.fulfill({ response, body: bytes });
  };
  await page.route(`**${detailPath}/download`, corrupt);
  await page.getByRole('button', { name: 'Download saved JSON', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'The downloaded file did not match this saved copy.',
  );
  expect(downloads).toHaveLength(0);
  await page.unroute(`**${detailPath}/download`, corrupt);
  const exactBytes = await download(page, saved.copy.id);
  expect(createHash('sha256').update(exactBytes).digest('hex')).toBe(saved.copy.contentSha256);
  expect(downloads).toHaveLength(1);

  const downloadReady = deferred(),
    releaseDownload = deferred(),
    downloadDone = deferred();
  const heldDownload = async (route: Route) => {
    const response = await route.fetch();
    downloadReady.resolve();
    await releaseDownload.promise;
    try {
      await route.fulfill({ response });
    } catch {
      /* Discarded read may be aborted by navigation. */
    } finally {
      downloadDone.resolve();
    }
  };
  await page.route(`**${detailPath}/download`, heldDownload);
  try {
    await page.getByRole('button', { name: 'Download saved JSON', exact: true }).click();
    await downloadReady.promise;
    await page.getByRole('button', { name: 'Back to saved copies', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Saved care summaries', exact: true }),
    ).toBeVisible();
    const unexpected = page.waitForEvent('download', { timeout: 750 }).then(
      () => true,
      () => false,
    );
    releaseDownload.resolve();
    await downloadDone.promise;
    expect(await unexpected).toBe(false);
    expect(downloads).toHaveLength(1);
  } finally {
    releaseDownload.resolve();
    await page.unroute(`**${detailPath}/download`, heldDownload);
  }
  page.off('download', recordDownload);

  await page.getByRole('button', { name: 'Current summary', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save copy', exact: true })).toBeEnabled();
  await page.evaluate((path) => {
    const original = window.fetch.bind(window);
    (window as unknown as { copyMutationConsumed: boolean }).copyMutationConsumed = false;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, window.location.origin).pathname === path && init?.method === 'POST') {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            (window as unknown as { copyMutationConsumed: boolean }).copyMutationConsumed = true;
          }
        };
      }
      return response;
    };
  }, base);
  const saveReady = deferred(),
    releaseSave = deferred(),
    saveDone = deferred();
  let committed: CareSummaryCopyResult | undefined;
  const heldSave = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = (await response.json()) as CareSummaryCopyResult;
    saveReady.resolve();
    await releaseSave.promise;
    try {
      await route.fulfill({ response });
    } finally {
      saveDone.resolve();
    }
  };
  await page.route(`**${base}`, heldSave);
  try {
    const dialog = await openSave(page);
    await dialog.getByLabel(reviewLabel, { exact: true }).check();
    await dialog.getByRole('button', { name: 'Save copy', exact: true }).click();
    await saveReady.promise;
    await page.evaluate((path) => {
      window.history.pushState({ key: 'discarded-copy-command' }, '', `${path}?view=copies`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, currentPath);
    await expect(
      page.getByRole('heading', { name: 'Saved care summaries', exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Care summary', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    releaseSave.resolve();
    await saveDone.promise;
    await page.waitForFunction(
      () => (window as unknown as { copyMutationConsumed: boolean }).copyMutationConsumed,
    );
    await expect(page).toHaveURL(new RegExp(`${currentPath}$`));
    await expect(
      page.getByRole('heading', { name: 'Saved care summary', exact: true }),
    ).toHaveCount(0);
    const archive = await get<CareSummaryCopyPage>(page.request, base);
    expect(archive.total).toBe(28);
    expect(archive.items.some((copy) => copy.id === committed!.copy.id)).toBe(true);
    await page.getByRole('button', { name: 'Saved copies', exact: true }).click();
    await page.locator(`.care-copy-card a[href*="copy=${committed!.copy.id}"]`).click();
    await expect(
      page.getByRole('button', { name: 'Download saved JSON', exact: true }),
    ).toBeEnabled();
  } finally {
    releaseSave.resolve();
    await page.unroute(`**${base}`, heldSave);
  }

  // A discarded archive read must not clear the still-valid global session.
  // Track body consumption so the assertions run after api() has processed the 401,
  // including every initial read produced by development StrictMode.
  await page.evaluate((path) => {
    const state = window as unknown as {
      staleCopyReadBodies: number;
      staleCopySessionEvents: number;
    };
    state.staleCopyReadBodies = 0;
    state.staleCopySessionEvents = 0;
    window.addEventListener('derma:session-expired', () => state.staleCopySessionEvents++);
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (
        new URL(url, window.location.origin).pathname.startsWith(path) &&
        (!init?.method || init.method === 'GET')
      ) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            if (response.status === 401) state.staleCopyReadBodies++;
          }
        };
      }
      return response;
    };
  }, base);
  for (const target of ['list', 'detail']) {
    const arrived = deferred(),
      release = deferred();
    let heldReads = 0,
      settledReads = 0;
    const stale401 = async (route: Route) => {
      heldReads++;
      arrived.resolve();
      await release.promise;
      try {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Discarded archive read must not sign out the current workspace.',
          }),
        });
      } finally {
        settledReads++;
      }
    };
    const pattern = target === 'list' ? `**${base}?*` : `**${detailPath}`;
    const beforeBodies = await page.evaluate(
      () => (window as unknown as { staleCopyReadBodies: number }).staleCopyReadBodies,
    );
    await page.route(pattern, stale401);
    try {
      if (target === 'list')
        await page.getByRole('button', { name: 'Saved copies', exact: true }).click();
      else
        await page.evaluate((path) => {
          window.history.pushState({ key: 'discarded-copy-detail-read' }, '', path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, `${currentPath}?view=copies&copy=${saved.copy.id}`);
      await arrived.promise;
      await page.getByRole('button', { name: 'Current summary', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Care summary', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save copy', exact: true })).toBeEnabled();
      const expectedReads = heldReads;
      expect(expectedReads).toBeGreaterThan(0);
      release.resolve();
      await expect.poll(() => settledReads).toBe(expectedReads);
      await page.waitForFunction(
        (expected) =>
          (window as unknown as { staleCopyReadBodies: number }).staleCopyReadBodies >= expected,
        beforeBodies + expectedReads,
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { staleCopySessionEvents: number }).staleCopySessionEvents,
        ),
      ).toBe(0);
      await expect(page).toHaveURL(new RegExp(`${currentPath}$`));
      await expect(page.getByRole('button', { name: 'Save copy', exact: true })).toBeEnabled();
      await expect(
        page.getByText('Discarded archive read must not sign out the current workspace.', {
          exact: true,
        }),
      ).toHaveCount(0);
      expect((await get<Session>(page.request, '/api/session')).user?.role).toBe('admin');
    } finally {
      release.resolve();
      await page.unroute(pattern, stale401);
    }
  }
});
