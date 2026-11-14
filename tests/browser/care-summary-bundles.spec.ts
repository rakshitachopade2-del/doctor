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
import { inflateRawSync } from 'node:zlib';
import type { ClinicalImage, Session } from '../../shared/types';
import type { PatientDocument } from '../../shared/documents';
import type { CareSummary } from '../../shared/care-summary';
import type { CareSummaryCopyResult } from '../../shared/care-summary-copies';
import type { PatientProfile } from '../../shared/patient-profile';
import type {
  CareSummaryAttachmentSelection,
  CareSummaryBundleAttachmentPage,
  CareSummaryBundleDownloadInput,
  CareSummaryBundleManifest,
  CareSummaryBundlePreview,
} from '../../shared/care-summary-bundles';
import { syntheticPdf } from '../fixtures/report';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
  'base64',
);
const summaryPath = (patientId: string) => `/api/patients/${patientId}/care-summary`;
const copyPath = (patientId: string, copyId: string) =>
  `${summaryPath(patientId)}/copies/${copyId}`;
const bundlePath = (patientId: string, copyId: string) => `${copyPath(patientId, copyId)}/bundle`;
const reviewLabel =
  'I reviewed the selected files and understand this download contains private health information.';
const modal = (page: Page) =>
  page.getByRole('dialog', { name: 'Download summary attachments', exact: true });

async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function register(request: APIRequestContext) {
  const suffix = randomUUID();
  const response = await request.post('/api/auth/register', {
    data: {
      name: `Bundle patient ${suffix.slice(0, 8)}`,
      email: `bundle-${suffix}@example.test`,
      password: 'PrivateBundle2026!',
      phone: '9000000300',
      dob: '1994-04-12',
      gender: 'Not specified',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const session = (await response.json()) as Session;
  return {
    session,
    patientId: session.user!.patientId!,
    headers: { 'X-CSRF-Token': session.csrfToken! },
  };
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
async function uploadDocument(
  request: APIRequestContext,
  headers: Record<string, string>,
  patientId: string,
  title: string,
) {
  const bytes = syntheticPdf(`Synthetic bundle source: ${title}`);
  const record = await post<PatientDocument>(request, headers, '/api/documents', {
    patientId,
    title,
    originalName: 'synthetic-original.pdf',
    dataUrl: `data:application/pdf;base64,${bytes.toString('base64')}`,
    consent: true,
  });
  return { record, bytes };
}
async function fixture(request: APIRequestContext) {
  const identity = await register(request);
  const suffix = randomUUID().slice(0, 8);
  const report = await uploadDocument(
    request,
    identity.headers,
    identity.patientId,
    `Selected report ${suffix}`,
  );
  const omitted = await uploadDocument(
    request,
    identity.headers,
    identity.patientId,
    `Unselected report ${suffix}`,
  );
  const image = await post<ClinicalImage>(request, identity.headers, '/api/images', {
    patientId: identity.patientId,
    caption: `Selected original image ${suffix}`,
    category: 'clinical',
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    consent: true,
  });
  return { ...identity, report, omitted, image };
}
async function save(
  request: APIRequestContext,
  headers: Record<string, string>,
  patientId: string,
) {
  const summary = await get<CareSummary>(request, summaryPath(patientId));
  const result = await post<CareSummaryCopyResult>(
    request,
    headers,
    `${summaryPath(patientId)}/copies`,
    {
      expectedRevision: summary.revision,
      requestId: randomUUID(),
    },
  );
  const response = await request.get(`${copyPath(patientId, result.copy.id)}/download`);
  expect(response.status()).toBe(200);
  const bytes = await response.body();
  expect(sha256(bytes)).toBe(result.copy.contentSha256);
  return { ...result, bytes };
}

/** Inspect the real central directory independently of the application's ZIP writer. */
function zipEntries(bytes: Buffer) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--)
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  expect(end).toBeGreaterThanOrEqual(0);
  expect(bytes.readUInt16LE(end + 4)).toBe(0);
  expect(bytes.readUInt16LE(end + 6)).toBe(0);
  const count = bytes.readUInt16LE(end + 10);
  expect(bytes.readUInt16LE(end + 8)).toBe(count);
  let cursor = bytes.readUInt32LE(end + 16);
  expect(cursor + bytes.readUInt32LE(end + 12)).toBe(end);
  const result = new Map<string, Buffer>();
  for (let entry = 0; entry < count; entry++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10);
    expect(flags & 1).toBe(0);
    expect([0, 8]).toContain(method);
    const packedSize = bytes.readUInt32LE(cursor + 20),
      size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extraLength = bytes.readUInt16LE(cursor + 30),
      commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    expect(name).not.toMatch(/(^\/|\\|(^|\/)\.\.?(\/|$)|[\u0000-\u001f])/);
    expect(result.has(name)).toBe(false);
    const local = bytes.readUInt32LE(cursor + 42);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    expect(bytes.readUInt16LE(local + 8)).toBe(method);
    const localNameLength = bytes.readUInt16LE(local + 26),
      localExtraLength = bytes.readUInt16LE(local + 28);
    expect(bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8')).toBe(name);
    const start = local + 30 + localNameLength + localExtraLength;
    const packed = bytes.subarray(start, start + packedSize);
    const plain = method === 0 ? packed : inflateRawSync(packed);
    expect(plain.byteLength).toBe(size);
    result.set(name, plain);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(end);
  return result;
}
async function mobileAudit(page: Page) {
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function openBundle(page: Page, copyId: string, patientId?: string) {
  const route = patientId ? `/clinic/patients/${patientId}/summary` : '/my-care/summary';
  await page.goto(`${route}?view=copies&copy=${copyId}`);
  await page.getByRole('button', { name: 'Download with attachments', exact: true }).click();
  await expect(modal(page)).toBeVisible();
  return modal(page);
}
async function preview(page: Page, endpoint: string) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${endpoint}/preview` &&
      response.request().method() === 'POST',
  );
  await modal(page).getByRole('button', { name: 'Preview download', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(200);
  const result = (await response.json()) as CareSummaryBundlePreview;
  await expect(
    modal(page).getByRole('heading', { name: 'Review your download', exact: true }),
  ).toBeVisible();
  await expect(modal(page).getByLabel(reviewLabel, { exact: true })).not.toBeChecked();
  return result;
}
async function downloadBundle(page: Page, expected: CareSummaryBundlePreview) {
  await modal(page).getByLabel(reviewLabel, { exact: true }).check();
  const waiting = page.waitForEvent('download');
  await modal(page).getByRole('button', { name: 'Download ZIP', exact: true }).click();
  const file = await waiting;
  expect(file.suggestedFilename()).toBe(expected.filename);
  const bytes = await readFile((await file.path())!);
  expect(bytes.byteLength).toBe(expected.byteLength);
  expect(sha256(bytes)).toBe(expected.contentSha256);
  return bytes;
}

test('selected originals and frozen summary download together with verified hashes after the current care record changes', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  const source = await fixture(page.request);
  const staff = await playwright.request.newContext({ baseURL });
  try {
    const admin = await login(staff);
    const privateMarker = `PRIVATE_BUNDLE_${randomUUID()}`;
    await post(staff, admin.headers, '/api/encounters', {
      patientId: source.patientId,
      assessment: privateMarker,
      plan: 'Internal documentation only.',
    });
    await post(page.request, source.headers, '/api/messages', {
      body: `${privateMarker} private conversation`,
    });
    const saved = await save(page.request, source.headers, source.patientId);
    const endpoint = bundlePath(source.patientId, saved.copy.id);
    const initial = await openBundle(page, saved.copy.id);
    await expect(initial.locator('.care-bundle-selection-count')).toHaveText(
      '0 of 20 attachments selected',
    );
    await expect(
      initial.getByRole('button', { name: 'Preview download', exact: true }),
    ).toBeDisabled();
    await initial.getByLabel(`Include ${source.report.record.title}`, { exact: true }).check();
    await initial.getByLabel(`Include ${source.image.caption}`, { exact: true }).check();
    await expect(
      initial.getByLabel(`Include ${source.omitted.record.title}`, { exact: true }),
    ).not.toBeChecked();
    const reviewed = await preview(page, endpoint);
    expect(reviewed.selection).toEqual([
      { type: 'document', id: source.report.record.id },
      { type: 'image', id: source.image.id },
    ]);
    expect(reviewed.filename).toBe(
      `care-summary-bundle-${sha256(Buffer.from(saved.copy.id)).slice(0, 24)}.zip`,
    );
    await expect(initial.getByRole('button', { name: 'Download ZIP', exact: true })).toBeDisabled();
    await mobileAudit(page);
    await page.screenshot({
      path: testInfo.outputPath('care-summary-bundle-preview-mobile.png'),
      fullPage: true,
    });

    const patient = await get<PatientProfile>(staff, `/api/patients/${source.patientId}/profile`);
    const updated = await staff.patch(`/api/patients/${source.patientId}/profile`, {
      headers: admin.headers,
      data: {
        ...patient.demographics,
        phone: '9000000399',
        reason: 'Later synthetic contact correction',
        expectedRevision: patient.revision,
        requestId: randomUUID(),
      },
    });
    expect(updated.status(), await updated.text()).toBe(200);
    const laterDocument = await uploadDocument(
      page.request,
      source.headers,
      source.patientId,
      'Current-only later report',
    );
    const current = await get<CareSummary>(page.request, summaryPath(source.patientId));
    expect(current.patient.phone).toBe('9000000399');
    expect(current.revision).not.toBe(saved.copy.sourceRevision);

    const bytes = await downloadBundle(page, reviewed);
    const entries = zipEntries(bytes);
    const reportName = `attachments/document-${sha256(Buffer.from(`document:${source.report.record.id}`))}.pdf`;
    const imageName = `attachments/image-${sha256(Buffer.from(`image:${source.image.id}`))}.png`;
    expect([...entries.keys()]).toEqual([
      'care-summary.json',
      'manifest.json',
      reportName,
      imageName,
    ]);
    expect(entries.get('care-summary.json')).toEqual(saved.bytes);
    expect(entries.get(reportName)).toEqual(source.report.bytes);
    expect(entries.get(imageName)).toEqual(png);
    const manifestBytes = entries.get('manifest.json')!;
    expect(manifestBytes.toString('utf8')).toBe(`${JSON.stringify(reviewed.manifest, null, 2)}\n`);
    expect(sha256(manifestBytes)).toBe(reviewed.revision);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as CareSummaryBundleManifest;
    expect(manifest.copy).toEqual(saved.copy);
    expect(manifest.summary).toEqual({
      path: 'care-summary.json',
      byteLength: saved.bytes.length,
      sha256: sha256(saved.bytes),
    });
    for (const file of manifest.files) {
      const original = entries.get(file.path)!;
      expect(file.byteLength).toBe(original.length);
      expect(file.sha256).toBe(sha256(original));
      expect(file.verification).toBe('saved-sha256');
      expect(file.uploadedBy).toEqual({ name: source.session.user!.name, role: 'patient' });
    }
    expect(manifest.files.map((file) => file.id)).not.toContain(source.omitted.record.id);
    expect(manifest.files.map((file) => file.id)).not.toContain(laterDocument.record.id);
    expect(saved.bytes.toString('utf8')).not.toContain(privateMarker);
    expect(manifestBytes.toString('utf8')).not.toContain(privateMarker);
    expect(saved.bytes.toString('utf8')).not.toContain('9000000399');
    expect(
      await (
        await page.request.get(`${copyPath(source.patientId, saved.copy.id)}/download`)
      ).body(),
    ).toEqual(saved.bytes);

    // Reversing selection order or changing the requesting clinician cannot change the archive.
    const clinicianPreview = await post<CareSummaryBundlePreview>(
      staff,
      admin.headers,
      `${endpoint}/preview`,
      { attachments: [...reviewed.selection].reverse() },
      200,
    );
    expect(clinicianPreview).toEqual(reviewed);
    const clinicianDownload = await staff.post(`${endpoint}/download`, {
      headers: admin.headers,
      data: {
        attachments: [...reviewed.selection].reverse(),
        expectedRevision: reviewed.revision,
      },
    });
    expect(clinicianDownload.status(), await clinicianDownload.text()).toBe(200);
    expect(await clinicianDownload.body()).toEqual(bytes);
    expect(clinicianDownload.headers()['cache-control']).toContain('no-store');
    expect(clinicianDownload.headers()['x-content-sha256']).toBe(reviewed.contentSha256);
  } finally {
    await staff.dispose();
  }
});

test('attachment selection is bounded and private, with unavailable files and oversize failures producing no partial download', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const source = await fixture(page.request);
  const additional: Awaited<ReturnType<typeof uploadDocument>>[] = [];
  for (let index = 0; index < 23; index++)
    additional.push(
      await uploadDocument(
        page.request,
        source.headers,
        source.patientId,
        `Additional selection ${index} ${randomUUID().slice(0, 6)}`,
      ),
    );
  const saved = await save(page.request, source.headers, source.patientId);
  const endpoint = bundlePath(source.patientId, saved.copy.id);
  const catalogue = await get<CareSummaryBundleAttachmentPage>(
    page.request,
    `${endpoint}/attachments?page=1&pageSize=50`,
  );
  expect(catalogue.items).toHaveLength(26);
  const currentOnly = await uploadDocument(
    page.request,
    source.headers,
    source.patientId,
    'Not present in the saved copy',
  );
  const staff = await playwright.request.newContext({ baseURL });
  try {
    const admin = await login(staff);
    const foreign = await uploadDocument(
      staff,
      admin.headers,
      'patient-2',
      'Other patient private original',
    );
    const invalidSelections: CareSummaryAttachmentSelection[][] = [
      [{ type: 'document', id: currentOnly.record.id }],
      [{ type: 'document', id: foreign.record.id }],
      [
        { type: 'document', id: source.report.record.id },
        { type: 'document', id: source.report.record.id },
      ],
      catalogue.items.slice(0, 21).map(({ type, id }) => ({ type, id })),
    ];
    for (const attachments of invalidSelections) {
      const response = await page.request.post(`${endpoint}/preview`, {
        headers: source.headers,
        data: { attachments },
      });
      expect(response.status(), await response.text()).toBe(400);
      expect(response.headers()['content-disposition']).toBeUndefined();
      expect(response.headers()['content-type']).toContain('application/json');
    }
    const selection = [{ type: 'document' as const, id: source.report.record.id }];
    const reviewed = await post<CareSummaryBundlePreview>(
      page.request,
      source.headers,
      `${endpoint}/preview`,
      { attachments: selection },
      200,
    );
    for (const email of ['patient@derma.demo', 'reception@derma.demo']) {
      const outsider = await playwright.request.newContext({ baseURL });
      try {
        const identity = await login(outsider, email);
        for (const suffix of ['/attachments', '/preview', '/download']) {
          const response =
            suffix === '/attachments'
              ? await outsider.get(`${endpoint}${suffix}`)
              : await outsider.post(`${endpoint}${suffix}`, {
                  headers: identity.headers,
                  data:
                    suffix === '/preview'
                      ? { attachments: selection }
                      : { attachments: selection, expectedRevision: reviewed.revision },
                });
          expect(response.status(), await response.text()).toBe(403);
          expect(response.headers()['content-disposition']).toBeUndefined();
        }
      } finally {
        await outsider.dispose();
      }
    }
    const list = await openBundle(page, saved.copy.id);
    await expect(list.locator('.care-bundle-file')).toHaveCount(25);
    const checkboxes = list.locator('.care-bundle-file').getByRole('checkbox');
    for (let index = 0; index < 20; index++) await checkboxes.nth(index).check();
    await expect(list.locator('.care-bundle-selection-count')).toHaveText(
      '20 of 20 attachments selected',
    );
    await expect(checkboxes.nth(20)).toBeDisabled();
    const pagination = list.getByRole('navigation', { name: 'Attachment pagination', exact: true });
    await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(list.locator('.care-bundle-file')).toHaveCount(1);
    await expect(list.locator('.care-bundle-file').getByRole('checkbox')).toBeDisabled();
    await pagination.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(list.locator('.care-bundle-file')).toHaveCount(25);
    await expect(list.locator('.care-bundle-file input:checked')).toHaveCount(20);

    // The backend API suite owns missing/corrupt BLOB injection. Here the browser
    // receives those documented availability/error states and must fail closed.
    const unavailable = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const body = (await response.json()) as CareSummaryBundleAttachmentPage;
      body.items = body.items.map((item) =>
        item.id === source.report.record.id
          ? {
              ...item,
              availability: 'missing',
              problem: 'Synthetic original is unavailable; no file will be omitted silently.',
            }
          : item.id === source.omitted.record.id
            ? {
                ...item,
                availability: 'too-large',
                problem: 'Synthetic original exceeds the file-size limit.',
              }
            : item,
      );
      await route.fulfill({ response, json: body });
    };
    await page.route(`**${endpoint}/attachments?*`, unavailable);
    const downloads: Download[] = [];
    page.on('download', (file) => downloads.push(file));
    const oversize = async (route: Route) =>
      route.fulfill({
        status: 413,
        json: {
          error:
            'Synthetic selected archive exceeds the 25 MiB bundle limit. No partial archive was prepared.',
        },
      });
    try {
      await openBundle(page, saved.copy.id);
      await expect(
        modal(page).getByLabel(`Include ${source.report.record.title}`, { exact: true }),
      ).toBeDisabled();
      await expect(
        modal(page).getByLabel(`Include ${source.omitted.record.title}`, { exact: true }),
      ).toBeDisabled();
      await expect(modal(page)).toContainText('Synthetic original is unavailable');
      await expect(modal(page)).toContainText('Synthetic original exceeds the file-size limit');
      await modal(page)
        .getByLabel(`Include ${additional[0].record.title}`, { exact: true })
        .check();
      await page.route(`**${endpoint}/preview`, oversize);
      await modal(page).getByRole('button', { name: 'Preview download', exact: true }).click();
      await expect(modal(page).getByRole('alert')).toContainText('No partial archive was prepared');
      await expect(
        modal(page).getByRole('button', { name: 'Download ZIP', exact: true }),
      ).toHaveCount(0);
      expect(downloads).toHaveLength(0);
      await mobileAudit(page);
      await page.screenshot({
        path: testInfo.outputPath('care-summary-bundle-unavailable-mobile.png'),
        fullPage: true,
      });
    } finally {
      await page.unroute(`**${endpoint}/attachments?*`, unavailable);
      await page.unroute(`**${endpoint}/preview`, oversize);
    }
  } finally {
    await staff.dispose();
  }
});

test('a stale attachment preview requires review again and malformed ZIP responses cannot trigger a download', async ({
  page,
}) => {
  const source = await fixture(page.request);
  const saved = await save(page.request, source.headers, source.patientId);
  const endpoint = bundlePath(source.patientId, saved.copy.id);
  await openBundle(page, saved.copy.id);
  await modal(page).getByLabel(`Include ${source.report.record.title}`, { exact: true }).check();
  const initial = await preview(page, endpoint);
  const downloads: Download[] = [];
  page.on('download', (file) => downloads.push(file));
  const attempts: CareSummaryBundleDownloadInput[] = [];
  const faulty = async (route: Route) => {
    attempts.push(route.request().postDataJSON() as CareSummaryBundleDownloadInput);
    if (attempts.length === 1)
      return route.fulfill({
        status: 409,
        json: {
          error:
            'Synthetic saved attachment source changed. Refresh the attachment list and review a new preview.',
        },
      });
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (attempts.length === 2)
      return route.fulfill({
        response,
        headers: { ...response.headers(), 'content-type': 'application/json' },
      });
    if (attempts.length === 3) {
      const corrupted = Buffer.from(await response.body());
      corrupted[corrupted.length - 1] ^= 1;
      return route.fulfill({ response, body: corrupted });
    }
    return route.fulfill({ response });
  };
  const waitDownloadResponse = () =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${endpoint}/download` &&
        response.request().method() === 'POST',
    );
  await page.route(`**${endpoint}/download`, faulty);
  try {
    await modal(page).getByLabel(reviewLabel, { exact: true }).check();
    const stale = waitDownloadResponse();
    await modal(page).getByRole('button', { name: 'Download ZIP', exact: true }).click();
    expect((await stale).status()).toBe(409);
    await expect(
      modal(page).getByRole('button', { name: 'Refresh attachment list', exact: true }),
    ).toBeVisible();
    expect(downloads).toHaveLength(0);
    await modal(page).getByRole('button', { name: 'Refresh attachment list', exact: true }).click();
    await expect(
      modal(page).getByLabel(`Include ${source.report.record.title}`, { exact: true }),
    ).toBeChecked();
    const refreshed = await preview(page, endpoint);
    expect(refreshed.selection).toEqual(initial.selection);
    await expect(
      modal(page).getByRole('button', { name: 'Download ZIP', exact: true }),
    ).toBeDisabled();
    await modal(page).getByLabel(reviewLabel, { exact: true }).check();
    for (let index = 2; index <= 3; index++) {
      const waiting = waitDownloadResponse();
      await modal(page).getByRole('button', { name: 'Download ZIP', exact: true }).click();
      expect((await waiting).status()).toBe(200);
      await expect(modal(page).getByRole('alert')).toBeVisible();
      await expect(
        modal(page).getByRole('button', { name: 'Download ZIP', exact: true }),
      ).toBeEnabled();
      expect(downloads).toHaveLength(0);
      expect(attempts).toHaveLength(index);
    }
    const bytes = await downloadBundle(page, refreshed);
    expect(downloads).toHaveLength(1);
    expect(zipEntries(bytes).get('care-summary.json')).toEqual(saved.bytes);
    expect(attempts).toHaveLength(4);
    for (const attempt of attempts)
      expect(attempt).toEqual({
        attachments: initial.selection,
        expectedRevision: initial.revision,
      });
  } finally {
    await page.unroute(`**${endpoint}/download`, faulty);
  }
});

test('attachment reads recover explicitly and leaving a pending preview or download prevents late effects and session loss', async ({
  page,
}) => {
  test.setTimeout(120000);
  const source = await fixture(page.request);
  const saved = await save(page.request, source.headers, source.patientId);
  const endpoint = bundlePath(source.patientId, saved.copy.id);
  let fault: 'unavailable' | 'malformed' | 'none' = 'unavailable';
  const badList = async (route: Route) => {
    if (fault === 'unavailable')
      return route.fulfill({
        status: 503,
        json: { error: 'Synthetic attachment catalogue is unavailable.' },
      });
    const response = await route.fetch();
    if (fault === 'malformed') {
      const body = (await response.json()) as CareSummaryBundleAttachmentPage;
      return route.fulfill({
        response,
        json: { ...body, copy: { ...body.copy, id: randomUUID() } },
      });
    }
    return route.fulfill({ response });
  };
  await page.route(`**${endpoint}/attachments?*`, badList);
  try {
    await openBundle(page, saved.copy.id);
    await expect(modal(page).getByRole('alert')).toContainText('Synthetic attachment catalogue');
    fault = 'malformed';
    await modal(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(modal(page).getByRole('alert')).toContainText(
      'did not contain a complete matching care summary',
    );
    await expect(
      modal(page).getByRole('button', { name: 'Preview download', exact: true }),
    ).toBeDisabled();
    fault = 'none';
    await modal(page).getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(modal(page).locator('.care-bundle-file')).toHaveCount(3);
  } finally {
    await page.unroute(`**${endpoint}/attachments?*`, badList);
  }

  await page.evaluate((prefix) => {
    const state = window as unknown as {
      bundleSettled: Record<string, number>;
      bundleUnauthorizedBodies: number;
      bundleExpired: number;
    };
    state.bundleSettled = {};
    state.bundleUnauthorizedBodies = 0;
    state.bundleExpired = 0;
    window.addEventListener('derma:session-expired', () => state.bundleExpired++);
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(url, window.location.origin).pathname;
      try {
        const response = await original(input, init);
        if (pathname.startsWith(prefix)) {
          const json = response.json.bind(response);
          response.json = async () => {
            try {
              return await json();
            } finally {
              if (response.status === 401) state.bundleUnauthorizedBodies++;
            }
          };
        }
        return response;
      } finally {
        if (pathname.startsWith(prefix)) {
          const key = `${init?.method ?? 'GET'} ${pathname}`;
          state.bundleSettled[key] = (state.bundleSettled[key] ?? 0) + 1;
        }
      }
    };
  }, endpoint);
  const downloads: Download[] = [];
  page.on('download', (file) => downloads.push(file));
  for (const action of ['preview', 'download'] as const) {
    if (action === 'download')
      await page.getByRole('button', { name: 'Download with attachments', exact: true }).click();
    await modal(page).getByLabel(`Include ${source.report.record.title}`, { exact: true }).check();
    if (action === 'download') {
      await preview(page, endpoint);
      await modal(page).getByLabel(reviewLabel, { exact: true }).check();
    }
    const ready = deferred(),
      release = deferred(),
      done = deferred();
    const held = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      ready.resolve();
      await release.promise;
      try {
        await route.fulfill({ response });
      } catch {
        /* Navigation may abort this otherwise valid read. */
      } finally {
        done.resolve();
      }
    };
    await page.route(`**${endpoint}/${action}`, held);
    try {
      await modal(page)
        .getByRole('button', {
          name: action === 'preview' ? 'Preview download' : 'Download ZIP',
          exact: true,
        })
        .click();
      await ready.promise;
      await page.keyboard.press('Escape');
      await expect(modal(page)).toBeVisible();
      await page.evaluate((action) => {
        window.history.pushState({ key: `bundle-${action}-away` }, '', '/my-care');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, action);
      await expect(page.getByRole('heading', { name: /^Hello,/ })).toBeVisible();
      await page.goBack();
      await expect(
        page.getByRole('heading', { name: 'Saved care summary', exact: true }),
      ).toBeVisible();
      await expect(modal(page)).toHaveCount(0);
      release.resolve();
      await done.promise;
      await page.waitForFunction(
        (key) =>
          (window as unknown as { bundleSettled: Record<string, number> }).bundleSettled[key] >= 1,
        `POST ${endpoint}/${action}`,
      );
      await expect(modal(page)).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Download with attachments', exact: true }),
      ).toBeEnabled();
      await expect(page.getByText('ZIP download started.', { exact: false })).toHaveCount(0);
      expect(downloads).toHaveLength(0);
    } finally {
      release.resolve();
      await page.unroute(`**${endpoint}/${action}`, held);
    }
  }

  const ready = deferred(),
    release = deferred();
  let heldReads = 0,
    settledReads = 0;
  const unauthorized = async (route: Route) => {
    heldReads++;
    ready.resolve();
    await release.promise;
    try {
      await route.fulfill({
        status: 401,
        json: { error: 'Discarded attachment read must not sign out the current patient.' },
      });
    } finally {
      settledReads++;
    }
  };
  await page.route(`**${endpoint}/attachments?*`, unauthorized);
  try {
    await page.getByRole('button', { name: 'Download with attachments', exact: true }).click();
    await ready.promise;
    await page.evaluate(() => {
      window.history.pushState({ key: 'bundle-list-away' }, '', '/my-care');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: /^Hello,/ })).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: 'Saved care summary', exact: true }),
    ).toBeVisible();
    const count = heldReads;
    expect(count).toBeGreaterThan(0);
    release.resolve();
    await expect.poll(() => settledReads).toBe(count);
    await page.waitForFunction(
      (count) =>
        (window as unknown as { bundleUnauthorizedBodies: number }).bundleUnauthorizedBodies >=
        count,
      count,
    );
    expect(
      await page.evaluate(() => (window as unknown as { bundleExpired: number }).bundleExpired),
    ).toBe(0);
    expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(
      source.session.user!.id,
    );
    await expect(modal(page)).toHaveCount(0);
    expect(downloads).toHaveLength(0);
  } finally {
    release.resolve();
    await page.unroute(`**${endpoint}/attachments?*`, unauthorized);
  }
});
