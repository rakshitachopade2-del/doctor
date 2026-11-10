import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { ImageAnnotationHistory } from '../../shared/image-annotations';

async function audit(page: Page) {
  await page.waitForLoadState('networkidle');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}

async function holdPost(page: Page, path: string) {
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
  let used = false;
  const handler = async (route: Route) => {
    if (used || route.request().method() !== 'POST') return route.continue();
    used = true;
    try {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      arrived();
      await gate;
      await route.fulfill({ response });
    } finally {
      finished();
    }
  };
  await page.route(path, handler);
  return {
    ready,
    release: async () => {
      release();
      if (used) await done;
      await page.unroute(path, handler);
    },
  };
}

test('clinician saves immutable image marks privately, shares explicitly and resolves a concurrent revision without losing a draft', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const patientContext = await browser.newContext({
    baseURL: String(testInfo.project.use.baseURL),
  });
  const patientPage = await patientContext.newPage();
  const patientLogin = await patientContext.request.post('/api/auth/login', {
    data: { email: 'patient@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(patientLogin.ok()).toBeTruthy();
  const settings = await (await page.request.get('/api/settings')).json();
  const caption = `Synthetic annotation image ${Date.now()}`;
  const uploaded = await page.request.post('/api/images', {
    headers,
    data: {
      patientId: 'patient-ananya',
      caption,
      category: 'clinical',
      consent: true,
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
    },
  });
  expect(uploaded.status()).toBe(201);
  const image = await uploaded.json();
  const original = await (await page.request.get(image.url)).body();
  const path = `/api/images/${image.id}/annotations`;
  const read = async (): Promise<ImageAnnotationHistory> => (await page.request.get(path)).json();
  const patientRead = async (): Promise<ImageAnnotationHistory> =>
    (await patientContext.request.get(path)).json();
  const privateNote = 'Synthetic clinician annotation for documentation testing only.';
  const draftNote = 'A later private revision that has not been shared with the patient.';
  try {
    await page.goto('/clinic/patients/patient-ananya?tab=images');
    const card = page.locator('.ia-image-card').filter({ hasText: caption });
    await card.getByRole('button', { name: 'View annotations', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`image=${image.id}`));
    const dialog = page.getByRole('dialog', { name: 'Image annotations', exact: true });
    await dialog.getByRole('button', { name: 'Add annotations', exact: true }).click();
    await dialog.getByLabel('Clinician annotation note', { exact: true }).fill(privateNote);
    await dialog.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
    await page.keyboard.press('Enter');
    await dialog
      .getByLabel('Mark note', { exact: true })
      .fill('First area recorded by the clinician');
    await dialog.getByLabel('Left (%)', { exact: true }).fill('20');
    await dialog.getByLabel('Top (%)', { exact: true }).fill('15');
    await dialog.getByLabel('Width (%)', { exact: true }).fill('90');
    await dialog.getByRole('button', { name: 'Save private revision', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Keep every shape inside the image');
    await dialog.getByLabel('Width (%)', { exact: true }).fill('30');
    await dialog.getByLabel('Height (%)', { exact: true }).fill('25');
    await dialog.getByRole('button', { name: 'Add ellipse', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove selected mark', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add arrow', exact: true }).click();
    await dialog
      .getByLabel('Mark note', { exact: true })
      .fill('Direction marker for documentation');
    await dialog.getByLabel('Start across (%)', { exact: true }).fill('30');
    await dialog.getByLabel('Start down (%)', { exact: true }).fill('40');
    await dialog.getByLabel('End across (%)', { exact: true }).fill('70');
    await dialog.getByLabel('End down (%)', { exact: true }).fill('60');
    await dialog.getByLabel('Mark color', { exact: true }).selectOption('blue');
    await expect(dialog.getByLabel('Selected mark', { exact: true }).locator('option')).toHaveCount(
      2,
    );
    await audit(page);
    const saving = await holdPost(page, `**${path}`);
    try {
      await dialog.getByRole('button', { name: 'Save private revision', exact: true }).click();
      await saving.ready;
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Clinician annotation note', { exact: true })).toBeDisabled();
      await expect(
        dialog.getByRole('button', { name: 'Close editor', exact: true }),
      ).toBeDisabled();
    } finally {
      await saving.release();
    }
    await expect(dialog.getByText('Clinic only', { exact: true })).toBeVisible();
    const first = await read();
    expect(first.versions).toHaveLength(1);
    expect(first.versions[0].markers).toMatchObject([
      { type: 'rectangle', x: 0.2, y: 0.15, width: 0.3, height: 0.25 },
      { type: 'arrow', x1: 0.3, y1: 0.4, x2: 0.7, y2: 0.6 },
    ]);
    expect(first.versions[0].publishedAt).toBeNull();
    expect(await patientRead()).toEqual({ imageId: image.id, revision: null, versions: [] });
    await patientPage.goto(`/my-care/record?tab=images&image=${image.id}`);
    const patientDialog = patientPage.getByRole('dialog', { name: 'Image details', exact: true });
    await expect(
      patientDialog.getByRole('heading', { name: 'No image annotations shared yet', exact: true }),
    ).toBeVisible();
    await expect(patientDialog.getByText(privateNote, { exact: true })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Share revision with patient', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Confirm patient sharing', exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole('checkbox', {
        name: 'I have reviewed this revision and want to share it with this patient.',
        exact: true,
      })
      .check();
    const sharing = await holdPost(page, `**${path}/${first.versions[0].id}/publish`);
    try {
      await dialog.getByRole('button', { name: 'Confirm patient sharing', exact: true }).click();
      await sharing.ready;
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Cancel sharing', exact: true }),
      ).toBeDisabled();
    } finally {
      await sharing.release();
    }
    await expect(dialog.getByText('Shared with patient', { exact: true })).toBeVisible();
    await patientPage.reload();
    await expect(patientDialog.getByText(privateNote, { exact: true })).toBeVisible();
    await expect(patientDialog.locator('.ia-mark-descriptions li')).toHaveCount(2);
    const shared = await read();
    expect((await patientRead()).versions).toHaveLength(1);

    await dialog.getByRole('button', { name: 'Create new revision', exact: true }).click();
    await dialog.getByLabel('Clinician annotation note', { exact: true }).fill(draftNote);
    const competing = await page.request.post(path, {
      headers,
      data: {
        expectedRevision: shared.revision,
        note: 'A concurrent clinician saved this note.',
        markers: [],
      },
    });
    expect(competing.status()).toBe(201);
    await dialog.getByRole('button', { name: 'Save private revision', exact: true }).click();
    await expect(
      dialog.getByText('Check the latest history before saving again.', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Clinician annotation note', { exact: true })).toHaveValue(
      draftNote,
    );
    await expect(
      dialog.getByRole('button', { name: 'Save private revision', exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole('button', { name: 'Load latest history and keep draft', exact: true })
      .click();
    await expect(
      dialog.getByText('Latest saved note: A concurrent clinician saved this note.', {
        exact: true,
      }),
    ).toBeVisible();
    await dialog
      .getByRole('button', { name: 'I reviewed the latest history; keep my draft', exact: true })
      .click();
    await dialog.getByRole('button', { name: 'Save private revision', exact: true }).click();
    await expect(dialog.getByText(draftNote, { exact: true })).toBeVisible();
    const latest = await read();
    expect(latest.versions).toHaveLength(3);
    expect(latest.versions[0].publishedAt).toBeNull();
    expect(latest.versions[2]).toEqual(shared.versions[0]);
    await patientPage.reload();
    await expect(patientDialog.getByText(privateNote, { exact: true })).toBeVisible();
    await expect(patientDialog.getByText(draftNote, { exact: true })).toHaveCount(0);
    await expect(
      patientDialog.getByLabel('Shared annotation version', { exact: true }).locator('option'),
    ).toHaveCount(1);

    await dialog
      .getByLabel('Saved annotation revision', { exact: true })
      .selectOption(first.versions[0].id);
    await expect(dialog.getByText(privateNote, { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Share revision with patient', exact: true }),
    ).toHaveCount(0);
    await dialog
      .getByLabel('Saved annotation revision', { exact: true })
      .selectOption(latest.versions[0].id);
    await dialog.getByRole('button', { name: 'Create new revision', exact: true }).click();
    await dialog
      .getByLabel('Clinician annotation note', { exact: true })
      .fill('Unsaved text to verify the close guard.');
    await page.keyboard.press('Escape');
    await expect(
      dialog.getByText('Discard your unsaved annotation draft?', { exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(dialog.getByLabel('Clinician annotation note', { exact: true })).toHaveValue(
      'Unsaved text to verify the close guard.',
    );
    await page.setViewportSize({ width: 320, height: 740 });
    await audit(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    expect(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath('image-annotation-editor-320px.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: 'Close editor', exact: true }).click();
    await dialog.getByRole('button', { name: 'Discard draft and close', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await read()).versions).toHaveLength(3);

    expect(
      (
        await page.request.patch('/api/settings', {
          headers,
          data: { modules: { ...settings.modules, images: false } },
        })
      ).ok(),
    ).toBeTruthy();
    await page.goto(`/clinic/patients/patient-ananya?tab=images&image=${image.id}`);
    await expect(dialog.getByText(draftNote, { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Create new revision', exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Share revision with patient', exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByText(/Image documentation is paused/)).toBeVisible();
    await patientPage.reload();
    await expect(patientDialog.getByText(privateNote, { exact: true })).toBeVisible();
    await patientPage.setViewportSize({ width: 320, height: 740 });
    await audit(patientPage);
    expect(
      await patientPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await patientPage.screenshot({
      path: testInfo.outputPath('patient-image-annotations-320px.png'),
      fullPage: true,
    });
    expect(await (await page.request.get(image.url)).body()).toEqual(original);
  } finally {
    await page.request.patch('/api/settings', { headers, data: { modules: settings.modules } });
    await patientContext.close();
  }
});
