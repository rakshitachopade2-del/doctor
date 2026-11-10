import { test, expect, type Page } from '@playwright/test';
async function login(page: Page, role = 'Admin') {
  await page.goto('/login');
  await page.getByRole('button', { name: role, exact: true }).click();
  await expect(page).toHaveURL('/clinic');
}

test('invoice amounts keep paise, payments update balance, patients see only their invoices', async ({
  page,
  browser,
}) => {
  await login(page);
  await page.goto('/clinic/billing');
  await page.getByRole('button', { name: 'Create invoice', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Patient', { exact: true }).selectOption('patient-ananya');
  await dialog.getByLabel('Service or item').fill('Browser test consultation');
  await dialog.getByLabel('Quantity').fill('2');
  await dialog.getByLabel('Unit price (₹)').fill('800.55');
  await dialog.getByRole('button', { name: 'Create invoice', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Invoice INV-/ })).toBeVisible();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('.invoice-totals')).toContainText('₹1,601.10');
  await dialog.getByLabel('Amount received (₹)').fill('500.25');
  await dialog.getByLabel('Payment method').selectOption('upi');
  await dialog.getByLabel('Reference / receipt number').fill('test-receipt-001');
  await dialog.getByRole('button', { name: 'Record received payment', exact: true }).click();
  await expect(dialog.locator('.invoice-totals')).toContainText('₹1,100.85');
  await expect(dialog.getByText('partial', { exact: true })).toBeVisible();
  const patientContext = await browser.newContext();
  const patient = await patientContext.newPage();
  await patient.goto('/login');
  await patient.getByRole('button', { name: 'Patient', exact: true }).click();
  await patient.waitForURL('/my-care');
  await patient.goto('/my-care/invoices');
  await expect(patient.getByText('₹1,100.85').first()).toBeVisible();
  await expect(patient.getByRole('button', { name: 'Create invoice' })).toHaveCount(0);
  await patient.getByRole('button', { name: 'View invoice' }).first().click();
  await expect(patient.getByText('Browser test consultation')).toBeVisible();
  await expect(patient.getByRole('button', { name: 'Record received payment' })).toHaveCount(0);
  await patientContext.close();
});

test('clinic drafts remain private until reviewed and published', async ({ page, browser }) => {
  await login(page, 'Doctor');
  await page.goto('/clinic/knowledge');
  await page.getByRole('button', { name: 'New article' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill('Browser test appointment guide');
  await dialog.getByLabel('Category').fill('Clinic logistics');
  await dialog
    .getByLabel('Article content')
    .fill('Bring your questions and any previous records to your appointment.');
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto('/library');
  await expect(
    publicPage.getByRole('heading', { name: 'Browser test appointment guide' }),
  ).toHaveCount(0);
  const card = page
    .locator('.card')
    .filter({ has: page.getByRole('heading', { name: 'Browser test appointment guide' }) });
  await card.getByRole('button', { name: 'Edit & review' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Approve and publish' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await publicPage.reload();
  await expect(
    publicPage.getByRole('heading', { name: 'Browser test appointment guide' }),
  ).toBeVisible();
  await visitor.close();
});

test('admin configures a doctor, provisions staff, and links a verified patient account', async ({
  page,
}) => {
  await login(page);
  await page.goto('/clinic/settings');
  await page.getByRole('tab', { name: 'Your team' }).click();
  await page.getByRole('button', { name: 'Add doctor', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Display name').fill('Dr. Browser Test');
  await dialog.getByLabel('Qualifications').fill('Demo qualification');
  await dialog.getByLabel('Focus areas').fill('Skin care, Follow-ups');
  await dialog.getByLabel('About the doctor').fill('Synthetic profile for the browser test.');
  await dialog.getByRole('button', { name: 'Save doctor' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Dr. Browser Test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add team member' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill('Test Staff');
  await dialog.getByLabel('Email address').fill('browser.staff@example.test');
  await dialog.getByLabel('Initial password').fill('BrowserStaff2026!');
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('browser.staff@example.test', { exact: true })).toBeVisible();
  await page.getByLabel('Existing patient').selectOption('patient-2');
  await page.getByLabel('Patient login email').fill('browser.portal@example.test');
  await page.getByLabel('Initial portal password').fill('BrowserPatient2026!');
  await page.getByRole('checkbox', { name: /verified this patient/ }).check();
  await page.getByRole('button', { name: 'Create patient portal access' }).click();
  await expect(
    page.getByText('Portal account created and linked to the existing patient record.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Clinic administrator/ }).click();
  await expect(page).toHaveURL('/login');
  await page.getByLabel('Email address').fill('browser.portal@example.test');
  await page.getByLabel('Password', { exact: true }).fill('BrowserPatient2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('/my-care');
  await page.goto('/my-care/record');
  await expect(page.getByRole('heading', { name: 'Rohan Patel', exact: true })).toBeVisible();
});
