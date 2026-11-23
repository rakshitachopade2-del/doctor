import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicSettings, ClinicalImage, PatientRecord, Session } from '../../shared/types';
import type { PatientDocument } from '../../shared/documents';
import type {
  DocumentUploadCommand,
  ImageUploadCommand,
  PrivateUploadResult,
} from '../../shared/private-upload';
import { syntheticPdf } from '../fixtures/report';

const patientId = 'patient-ananya';
const patientImages = '/my-care/record?tab=images';
const clinic = '/clinic/patients/' + patientId;
const imagePath = '/api/images/upload';
const pdfPath = '/api/documents/upload';
const retry = 'Retry exact upload';
const imageFile = {
  name: 'synthetic.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
    'base64',
  ),
};
const pdfFile = {
  name: 'synthetic-report.pdf',
  mimeType: 'application/pdf',
  buffer: syntheticPdf(),
};
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const dialog = (page: Page) => page.getByRole('dialog').last();
const action = (page: Page, name: string) =>
  dialog(page).getByRole('button', { name, exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function login(api: APIRequestContext, role: 'patient' | 'doctor' | 'admin') {
  const response = await api.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as Session;
}
async function read<T>(api: APIRequestContext, path: string) {
  const response = await api.get(path);
  expect(response.status()).toBe(200);
  return (await response.json()) as T;
}
async function images(api: APIRequestContext, caption: string) {
  const record = await read<PatientRecord>(api, '/api/patients/' + patientId);
  return record.images.filter((image) => image.caption === caption);
}
async function documents(api: APIRequestContext, title: string) {
  return (await read<PatientDocument[]>(api, '/api/documents?patientId=' + patientId)).filter(
    (doc) => doc.title === title,
  );
}
async function enableImages(admin: APIRequestContext, session: Session, enabled: boolean) {
  const settings = await read<ClinicSettings>(admin, '/api/settings');
  const response = await admin.patch('/api/settings', {
    headers: { 'X-CSRF-Token': session.csrfToken! },
    data: { modules: { ...settings.modules, images: enabled } },
  });
  expect(response.status(), await response.text()).toBe(200);
}
async function fillImage(page: Page, caption: string, staff = false) {
  await button(page, 'Add image').click();
  await dialog(page).locator('input[type=file]').setInputFiles(imageFile);
  await dialog(page)
    .getByLabel(staff ? 'Caption' : 'Description', { exact: true })
    .fill(caption);
  await dialog(page)
    .getByLabel(staff ? 'Category' : 'Type of record', { exact: true })
    .selectOption('report');
  await dialog(page).getByRole('checkbox').check();
}
async function fillPdf(page: Page, title: string) {
  await dialog(page).getByLabel('PDF file', { exact: true }).setInputFiles(pdfFile);
  await dialog(page).getByLabel('Report title', { exact: true }).fill(title);
  await dialog(page).getByRole('checkbox').check();
}
async function send(page: Page, name: string, path: string) {
  const response = page.waitForResponse(
    (res) => new URL(res.url()).pathname === path && res.request().method() === 'POST',
  );
  await action(page, name).click();
  return response;
}
async function checkBytes(
  api: APIRequestContext,
  file: ClinicalImage | PatientDocument,
  buffer: Buffer,
) {
  const res = await api.get(file.url);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain(file.mimeType);
  expect(await res.body()).toEqual(buffer);
}
async function mobile(page: Page, name: string, path: string) {
  await page.setViewportSize({ width: 320, height: 860 });
  const control = action(page, name);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path });
}

test('patient recovers one original image through a lost reply, incorrect receipts, navigation and a clinic pause', async ({
  page,
  playwright,
  baseURL,
}, info) => {
  const patient = await login(page.request, 'patient');
  const admin = await playwright.request.newContext({ baseURL });
  const staff = await login(admin, 'admin');
  const caption = 'Retained photo ' + randomUUID().slice(0, 8);
  const commands: ImageUploadCommand[] = [];
  let original!: PrivateUploadResult;
  try {
    await page.goto(patientImages);
    await fillImage(page, caption);
    await page.route('**' + imagePath, async (route) => {
      commands.push(route.request().postDataJSON());
      const saved = await route.fetch();
      expect(saved.status()).toBe(commands.length === 1 ? 201 : 200);
      const result: PrivateUploadResult = await saved.json();
      if (commands.length === 1) {
        original = result;
        return route.abort('connectionreset');
      }
      expect(result).toEqual(original);
      if (commands.length === 2) result.receipt.file.sha256 = 'a'.repeat(64);
      if (commands.length === 3) result.receipt.file.url = '/api/images/' + randomUUID() + '/file';
      if (commands.length === 4) result.receipt.file.createdById = 'wrong-author';
      if (commands.length === 5) result.receipt.patientId = 'another-patient';
      await route.fulfill({ response: saved, json: result });
    });
    await action(page, 'Upload to my record').click();
    await expect(action(page, retry)).toBeEnabled();
    await mobile(page, retry, info.outputPath('patient-image-recovery-mobile.png'));
    await page.setViewportSize({ width: 1280, height: 800 });
    for (let i = 0; i < 4; i++) {
      await send(page, retry, imagePath);
      await expect(action(page, retry)).toBeEnabled();
      await expect(dialog(page).locator('input[type=file]:enabled')).toHaveCount(0);
    }
    await action(page, 'Close upload').click();
    await enableImages(admin, staff, false);
    await page.getByRole('link', { name: 'My care', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Hello,/ })).toBeVisible();
    const loadedSettings = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/settings' && res.request().method() === 'GET',
    );
    await page.goBack();
    expect((await (await loadedSettings).json()).modules.images).toBe(false);
    await expect(page.getByText('Image uploads are paused.', { exact: false })).toBeVisible();
    await button(page, 'Resume image upload').click();
    const replay = await send(page, retry, imagePath);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(original);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(commands).toHaveLength(6);
    for (const command of commands) expect(command).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({
      patientId,
      caption,
      category: 'report',
      sha256: sha(imageFile.buffer),
      consent: true,
      dataUrl: 'data:image/png;base64,' + imageFile.buffer.toString('base64'),
    });
    const file = original.receipt.file;
    expect(original.receipt).toMatchObject({
      requestId: commands[0].requestId,
      actorId: patient.user!.id,
      patientId,
      kind: 'image',
      file: {
        caption,
        category: 'report',
        consent: true,
        patientId,
        sha256: sha(imageFile.buffer),
        sizeBytes: imageFile.buffer.length,
        mimeType: 'image/png',
        createdById: patient.user!.id,
        createdByName: patient.user!.name,
        createdByRole: 'patient',
      },
    });
    expect(await images(admin, caption)).toEqual([file]);
    await checkBytes(page.request, file, imageFile.buffer);
    const logs = await read<{ items: { action: string }[] }>(
      admin,
      '/api/search/audit?entityType=image&entityId=' + file.id,
    );
    expect(logs.items.filter((item) => item.action === 'uploaded private image')).toHaveLength(1);
  } finally {
    await enableImages(admin, staff, true);
    await admin.dispose();
  }
});

test('a clinician reviews a retained photo after the exact paused rejection and can intentionally upload the same bytes again', async ({
  page,
  playwright,
  baseURL,
}) => {
  await login(page.request, 'doctor');
  const admin = await playwright.request.newContext({ baseURL });
  const staff = await login(admin, 'admin');
  const caption = 'Reviewed clinical photo ' + randomUUID().slice(0, 8);
  const commands: ImageUploadCommand[] = [];
  try {
    await page.goto(clinic + '?tab=images');
    await fillImage(page, caption, true);
    await enableImages(admin, staff, false);
    await page.route('**' + imagePath, async (route) => {
      commands.push(route.request().postDataJSON());
      const upstream = await route.fetch();
      if (commands.length <= 3) {
        expect(upstream.status()).toBe(403);
        const rejected = await upstream.json();
        expect(rejected.code).toBe('UPLOAD_NOT_SAVED');
        if (commands.length === 1)
          return route.fulfill({ status: 403, json: { error: 'Upload interrupted' } });
        if (commands.length === 2) rejected.sizeBytes++;
        return route.fulfill({ response: upstream, json: rejected });
      }
      await route.fulfill({ response: upstream });
    });
    await send(page, 'Upload privately', imagePath);
    await expect(action(page, retry)).toBeEnabled();
    await enableImages(admin, staff, true);
    await send(page, retry, imagePath);
    await expect(action(page, retry)).toBeEnabled();
    await expect(action(page, 'Review upload')).toHaveCount(0);
    await send(page, retry, imagePath);
    await expect(
      dialog(page).getByRole('heading', { name: 'Image upload was not saved' }),
    ).toBeVisible();
    expect(await images(admin, caption)).toHaveLength(0);
    await enableImages(admin, staff, false);
    await action(page, 'Review upload').click();
    await expect(dialog(page).getByLabel('Caption', { exact: true })).toHaveValue(caption);
    await expect(dialog(page).getByRole('checkbox')).not.toBeChecked();
    await dialog(page).getByRole('checkbox').check();
    await expect(action(page, 'Refresh availability')).toBeVisible();
    await expect(action(page, 'Upload privately')).toBeDisabled();
    await enableImages(admin, staff, true);
    await action(page, 'Refresh availability').click();
    const first = await send(page, 'Upload privately', imagePath);
    expect(first.status()).toBe(201);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await fillImage(page, caption, true);
    expect((await send(page, 'Upload privately', imagePath)).status()).toBe(201);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(commands.slice(0, 3)).toEqual(Array(3).fill(commands[0]));
    expect(new Set(commands.map((cmd) => cmd.requestId)).size).toBe(3);
    for (const cmd of commands) expect(cmd).toEqual({ ...commands[0], requestId: cmd.requestId });
    const saved = await images(admin, caption);
    expect(saved).toHaveLength(2);
    expect(saved[0].id).not.toEqual(saved[1].id);
    for (const image of saved) {
      expect(image.createdByRole).toBe('doctor');
      await checkBytes(admin, image, imageFile.buffer);
    }
  } finally {
    await enableImages(admin, staff, true);
    await admin.dispose();
  }
});

test('recovering an investigation PDF preserves its bytes and selects it only in the intended result form', async ({
  page,
  playwright,
  baseURL,
}) => {
  const doctor = await playwright.request.newContext({ baseURL });
  const staff = await login(doctor, 'doctor');
  const patient = await login(page.request, 'patient');
  const suffix = randomUUID().slice(0, 8);
  const title = 'Investigation document ' + suffix;
  const sameOriginTitle = title + ' follow-up';
  const investigations: { id: string; title: string }[] = [];
  const commands: DocumentUploadCommand[] = [];
  try {
    for (const key of ['First', 'Second']) {
      const result = await doctor.post('/api/investigations', {
        headers: { 'X-CSRF-Token': staff.csrfToken! },
        data: {
          patientId,
          title: key + ' investigation ' + suffix,
          kind: 'laboratory',
          reason: 'Synthetic check of report selection.',
          instructions: 'Share the synthetic PDF.',
          dueDate: null,
        },
      });
      expect(result.status()).toBe(201);
      investigations.push(await result.json());
    }
    await page.goto('/my-care/record?tab=workflows');
    const openResult = async (index: number) => {
      const card = page.locator('.patient-investigation-card').filter({
        has: page.getByRole('heading', { name: investigations[index].title, exact: true }),
      });
      await card.getByRole('button', { name: 'Share result', exact: true }).click();
    };
    const selectReport = (name: string) =>
      dialog(page)
        .locator('label')
        .filter({ has: page.getByText(name, { exact: true }) })
        .getByRole('checkbox');
    await page.route('**' + pdfPath, async (route) => {
      commands.push(route.request().postDataJSON());
      const upstream = await route.fetch();
      if (commands.length === 1 || commands.length === 4) {
        expect(upstream.status()).toBe(201);
        return route.abort('connectionreset');
      }
      expect(upstream.status()).toBe(200);
      const result: PrivateUploadResult = await upstream.json();
      if (commands.length === 2 && result.receipt.kind === 'document') {
        result.receipt.file.originalName = 'another-report.pdf';
      }
      await route.fulfill({ response: upstream, json: result });
    });
    await openResult(0);
    await action(page, 'Upload a PDF report').click();
    await fillPdf(page, title);
    await action(page, 'Add report to record').click();
    await expect(action(page, retry)).toBeEnabled();
    await action(page, 'Close upload').click();
    await action(page, 'Cancel').click();
    await openResult(1);
    await action(page, 'Upload a PDF report').click();
    await send(page, retry, pdfPath);
    await expect(action(page, retry)).toBeEnabled();
    const recovered = await send(page, retry, pdfPath);
    expect(recovered.status()).toBe(200);
    await expect(selectReport(title)).toBeVisible();
    await expect(selectReport(title)).not.toBeChecked();
    const original = ((await recovered.json()) as PrivateUploadResult).receipt.file;
    expect(await documents(doctor, title)).toEqual([original]);
    expect(original).toMatchObject({
      originalName: pdfFile.name,
      title,
      sha256: sha(pdfFile.buffer),
      sizeBytes: pdfFile.buffer.length,
      createdById: patient.user!.id,
    });
    await checkBytes(doctor, original, pdfFile.buffer);
    await action(page, 'Cancel').click();
    await openResult(0);
    await dialog(page)
      .getByLabel('Result note', { exact: true })
      .fill('Patient note retained after recovering the file.');
    await action(page, 'Upload a PDF report').click();
    await fillPdf(page, sameOriginTitle);
    await action(page, 'Add report to record').click();
    await expect(action(page, retry)).toBeEnabled();
    await send(page, retry, pdfPath);
    await expect(selectReport(sameOriginTitle)).toBeChecked();
    await expect(selectReport(title)).not.toBeChecked();
    await expect(dialog(page).getByLabel('Result note', { exact: true })).toHaveValue(
      'Patient note retained after recovering the file.',
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Review result', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('checkbox', {
        name: 'I reviewed this result and the reports to share.',
        exact: true,
      })
      .check();
    await action(page, 'Share result with clinic').click();
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'Result submitted', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close confirmation', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const records = await read<{
      investigations: { id: string; results: { documentIds: string[] }[] }[];
    }>(doctor, '/api/patients/' + patientId + '/clinical-workflows');
    const selected = await documents(doctor, sameOriginTitle);
    expect(selected).toHaveLength(1);
    expect(
      records.investigations
        .find((item) => item.id === investigations[0].id)
        ?.results.map((result) => result.documentIds),
    ).toEqual([[selected[0].id]]);
    expect(
      records.investigations.find((item) => item.id === investigations[1].id)?.results,
    ).toHaveLength(0);
    expect(commands).toHaveLength(5);
    expect(commands.slice(0, 3)).toEqual(Array(3).fill(commands[0]));
    expect(commands[3]).toEqual(commands[4]);
    expect(commands[3].requestId).not.toBe(commands[0].requestId);
  } finally {
    await doctor.dispose();
  }
});

test('a busy clinician PDF dialog resists dismissal and a late authorization reply cannot sign out a revisited record', async ({
  page,
  playwright,
  baseURL,
}, info) => {
  const admin = await playwright.request.newContext({ baseURL });
  const administrator = await login(admin, 'admin');
  const staff = await login(page.request, 'doctor');
  const title = 'Clinician report ' + randomUUID().slice(0, 8);
  const seen = deferred(),
    release = deferred();
  const commands: DocumentUploadCommand[] = [];
  try {
    await enableImages(admin, administrator, false);
    await page.goto(clinic + '?tab=reports');
    await page.getByRole('link', { name: 'All patients', exact: true }).click();
    await expect(page.getByLabel('Search patient directory')).toBeVisible();
    await page.goBack();
    await button(page, 'Upload PDF report').click();
    await fillPdf(page, title);
    await mobile(page, 'Add report to record', info.outputPath('clinician-pdf-upload-mobile.png'));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      const state = window as Window & { expired?: number; oldRead?: boolean };
      state.expired = 0;
      window.addEventListener('derma:session-expired', () => state.expired!++);
      const native = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await native(...args);
        if (response.headers.get('X-Test-Upload') === 'held') {
          const json = response.json.bind(response);
          response.json = async () => {
            try {
              return await json();
            } finally {
              state.oldRead = true;
            }
          };
        }
        return response;
      };
    });
    await page.route('**' + pdfPath, async (route) => {
      commands.push(route.request().postDataJSON());
      const upstream = await route.fetch();
      if (commands.length === 1) {
        expect(upstream.status()).toBe(201);
        seen.resolve();
        await release.promise;
        return route.fulfill({
          status: 401,
          headers: { 'X-Test-Upload': 'held' },
          json: { error: 'Obsolete report response.' },
        });
      }
      await route.fulfill({ response: upstream });
    });
    await action(page, 'Add report to record').click();
    await seen.promise;
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeVisible();
    await page.goForward();
    await expect(page.getByLabel('Search patient directory')).toBeVisible();
    await page.getByRole('link', { name: 'Rohan Patel', exact: true }).click();
    await page.getByRole('tab', { name: 'PDF reports', exact: true }).click();
    await expect(button(page, 'Upload PDF report')).toBeEnabled();
    await expect(button(page, 'Resume PDF upload')).toHaveCount(0);
    await button(page, 'Upload PDF report').click();
    await expect(dialog(page).getByLabel('Report title', { exact: true })).toHaveValue('');
    await action(page, 'Cancel').click();
    await page.goBack();
    await expect(page.getByLabel('Search patient directory')).toBeVisible();
    await page.goBack();
    await button(page, 'Resume PDF upload').click();
    release.resolve();
    await expect
      .poll(() => page.evaluate(() => (window as Window & { oldRead?: boolean }).oldRead))
      .toBe(true);
    expect(await page.evaluate(() => (window as Window & { expired?: number }).expired)).toBe(0);
    await expect(action(page, retry)).toBeEnabled();
    const replay = await send(page, retry, pdfPath);
    expect(replay.status()).toBe(200);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    const saved = ((await replay.json()) as PrivateUploadResult).receipt.file;
    expect(saved).toMatchObject({
      title,
      createdById: staff.user!.id,
      createdByRole: 'doctor',
      sha256: sha(pdfFile.buffer),
    });
    expect(await documents(admin, title)).toEqual([saved]);
    const audit = await read<{ items: { action: string }[] }>(
      admin,
      '/api/search/audit?entityType=document&entityId=' + saved.id,
    );
    expect(
      audit.items.filter((row) => row.action === 'uploaded private report document'),
    ).toHaveLength(1);
    await checkBytes(admin, saved, pdfFile.buffer);
  } finally {
    release.resolve();
    await enableImages(admin, administrator, true);
    await admin.dispose();
  }
});

type ReadGate = Window & { releaseFile?: () => void; fileFinished?: boolean };
async function holdFile(page: Page, stage: 'read' | 'digest') {
  await page.evaluate((stage) => {
    const state = window as ReadGate;
    delete state.releaseFile;
    state.fileFinished = false;
    if (stage === 'read') {
      const native = FileReader.prototype.readAsArrayBuffer;
      FileReader.prototype.readAsArrayBuffer = function (file) {
        FileReader.prototype.readAsArrayBuffer = native;
        state.releaseFile = () => {
          this.addEventListener(
            'loadend',
            () => {
              state.fileFinished = true;
            },
            { once: true },
          );
          native.call(this, file);
        };
      };
    } else {
      const native = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (algorithm, bytes) => {
        crypto.subtle.digest = native;
        const value = await native(algorithm, bytes);
        await new Promise<void>((resolve) => {
          state.releaseFile = resolve;
        });
        state.fileFinished = true;
        return value;
      };
    }
  }, stage);
}
test('dismissing an image during file reading or fingerprinting prevents any subsequent upload', async ({
  page,
}) => {
  await login(page.request, 'patient');
  await page.goto(patientImages);
  const writes: ImageUploadCommand[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === imagePath) writes.push(request.postDataJSON());
  });
  for (const stage of ['read', 'digest'] as const) {
    const caption = 'Dismissed ' + stage + ' ' + randomUUID().slice(0, 8);
    await fillImage(page, caption);
    await holdFile(page, stage);
    await action(page, 'Upload to my record').click();
    await expect
      .poll(() => page.evaluate(() => typeof (window as ReadGate).releaseFile))
      .toBe('function');
    await action(page, 'Close dialog').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await fillImage(page, 'Next selection');
    await page.evaluate(() => (window as ReadGate).releaseFile!());
    await expect.poll(() => page.evaluate(() => (window as ReadGate).fileFinished)).toBe(true);
    await expect(dialog(page).getByLabel('Description', { exact: true })).toHaveValue(
      'Next selection',
    );
    await expect(action(page, 'Upload to my record')).toBeEnabled();
    await action(page, 'Close dialog').click();
    expect(await images(page.request, caption)).toEqual([]);
    expect(writes).toHaveLength(0);
  }
});

test('signing out clears an unresolved file and its retry identity before the patient signs back in', async ({
  page,
}) => {
  await login(page.request, 'patient');
  const title = 'Unconfirmed report ' + randomUUID().slice(0, 8);
  await page.goto(patientImages);
  await button(page, 'Upload PDF report').click();
  await fillPdf(page, title);
  await page.route('**' + pdfPath, (route) => route.abort('connectionreset'), { times: 1 });
  await action(page, 'Add report to record').click();
  await expect(action(page, retry)).toBeEnabled();
  await action(page, 'Close upload').click();
  await expect(button(page, 'Resume PDF upload')).toBeEnabled();
  await page.getByTitle('Sign out', { exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
  await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
  await button(page, 'Sign in').click();
  await page.getByRole('link', { name: 'View your full record', exact: true }).click();
  await page.getByRole('tab', { name: 'Images & reports', exact: true }).click();
  await expect(button(page, 'Resume PDF upload')).toHaveCount(0);
  await button(page, 'Upload PDF report').click();
  await expect(dialog(page).getByLabel('Report title', { exact: true })).toHaveValue('');
  await expect(dialog(page).getByLabel('PDF file', { exact: true })).toHaveValue('');
  expect(await documents(page.request, title)).toEqual([]);
});
