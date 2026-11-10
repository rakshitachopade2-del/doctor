import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function audit(page: Page) {
  await page.waitForLoadState('networkidle');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function signIn(page: Page, role: 'doctor' | 'patient') {
  const response = await page.request.post('/api/auth/login', {
    data: { email: `${role}@derma.demo`, password: 'DemoClinic2026!' },
  });
  expect(response.ok()).toBeTruthy();
}

test('public discovery and sign-in have no detectable WCAG A/AA violations', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await audit(page);
  await page.screenshot({ path: testInfo.outputPath('public-discovery.png'), fullPage: true });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await audit(page);
});

test('clinic dashboard and booking dialog have no detectable WCAG A/AA violations', async ({
  page,
}, testInfo) => {
  await signIn(page, 'doctor');
  await page.goto('/clinic');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await audit(page);
  await page.screenshot({ path: testInfo.outputPath('clinic-dashboard.png'), fullPage: true });
  await page.goto('/clinic/appointments');
  await page.getByRole('button', { name: 'New appointment', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await audit(page);
});

test('patient care and records remain accessible on a narrow screen', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, 'patient');
  await page.goto('/my-care');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await audit(page);
  await page.screenshot({ path: testInfo.outputPath('patient-mobile.png'), fullPage: true });
  await page.goto('/my-care/record');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await audit(page);
});
