import { test, expect, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Investigation } from '../../shared/clinical';
import type {
  InvestigationWorkItem,
  InvestigationReviewContext,
} from '../../shared/investigation-worklist';

test('investigation dashboard counts recover from unavailable data and exact links reveal cancelled and missing targets without exposing reception', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.status()).toBe(200);
  const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
  async function order(label: string): Promise<Investigation> {
    const response = await page.request.post('/api/investigations', {
      headers,
      data: {
        patientId: 'patient-ananya',
        title: `${label} ${randomUUID()}`,
        kind: 'other',
        reason: 'Synthetic navigation verification.',
        instructions: 'Synthetic record only.',
      },
    });
    expect(response.status()).toBe(201);
    const created = (await response.json()) as Investigation;
    const result = await page.request.post(`/api/investigations/${created.id}/results`, {
      headers,
      data: { note: `${label} source result`, documentIds: [] },
    });
    expect(result.status()).toBe(201);
    return result.json();
  }
  const pending = await order('Awaiting dashboard review');
  const cancelled = await order('Cancelled navigation record');
  expect(
    (
      await page.request.post(`/api/investigations/${cancelled.id}/cancel`, {
        headers,
        data: { reason: 'Synthetic cancelled request retained for history.' },
      })
    ).status(),
  ).toBe(200);
  const sourceId = cancelled.results[0].id;
  await page.goto(
    `/clinic/patients/patient-ananya?tab=workup&investigation=${cancelled.id}&result=${sourceId}`,
  );
  const selected = page.locator(`#investigation-${cancelled.id}`);
  await expect(selected.getByRole('heading', { name: cancelled.title, exact: true })).toBeVisible();
  await expect(page.locator(`#investigation-result-${sourceId}`)).toBeFocused();
  await expect(selected.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(
    selected.getByRole('button', { name: 'Review this result', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  expect(new URL(page.url()).searchParams.has('investigation')).toBe(false);
  expect(new URL(page.url()).searchParams.has('result')).toBe(false);

  await page.goto('/clinic/patients/patient-ananya?tab=workup&investigation=unavailable-order');
  await expect(
    page.getByText("The linked investigation is not available in this patient's record.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.cw-selected-target')).toHaveCount(0);
  await page.goto(
    `/clinic/patients/patient-ananya?tab=workup&investigation=${pending.id}&result=unavailable-result`,
  );
  await expect(
    page.getByText(
      'The linked result is not available on this investigation. The order and its available history are shown below.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator(`#investigation-${pending.id}`)).toBeFocused();

  const worklistPath = '/api/investigation-worklist?scope=all';
  async function worklist(): Promise<InvestigationWorkItem[]> {
    const response = await page.request.get(worklistPath);
    expect(response.status()).toBe(200);
    return response.json();
  }
  const unavailable = async (route: Route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic investigation count unavailable.' }),
    });
  await page.route(`**${worklistPath}`, unavailable);
  await page.goto('/clinic');
  const overview = page.locator('.investigation-overview');
  await expect(overview.getByRole('alert')).toContainText(
    'Synthetic investigation count unavailable.',
  );
  await expect(overview.locator('.investigation-overview-counts')).toHaveCount(0);
  await page.unroute(`**${worklistPath}`, unavailable);
  await overview.getByRole('button', { name: 'Try again', exact: true }).click();
  async function expectCounts(items: InvestigationWorkItem[]) {
    const count = (label: string) =>
      overview.getByRole('group', { name: label, exact: true }).locator('strong');
    await expect(count('Results awaiting review')).toHaveText(
      String(items.filter((item) => item.needsReview).length),
    );
    await expect(count('Latest reviews not shared')).toHaveText(
      String(items.filter((item) => item.awaitingPublication).length),
    );
    await expect(count('Missing results past requested date')).toHaveText(
      String(items.filter((item) => item.pastRequestedDate).length),
    );
  }
  await expectCounts(await worklist());
  const context = (await (
    await page.request.get(`/api/investigations/${pending.id}/review-context`)
  ).json()) as InvestigationReviewContext;
  const review = await page.request.post(`/api/investigations/${pending.id}/reviews`, {
    headers,
    data: {
      resultId: context.latestResultId,
      summary: 'Private synthetic dashboard review.',
      followUp: 'Synthetic next steps.',
      publishToPatient: false,
      expectedRevision: context.revision,
      requestId: randomUUID(),
    },
  });
  expect(review.status()).toBe(201);
  await page.goto('/clinic');
  await expectCounts(await worklist());
  await page.setViewportSize({ width: 320, height: 780 });
  await page.evaluate(() => document.fonts.ready);
  expect(
    (
      await new AxeBuilder({ page })
        .include('.investigation-overview')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await overview.evaluate((element) => element.getBoundingClientRect().right <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath('investigation-overview-mobile.png'),
    fullPage: true,
  });

  const reception = await browser.newContext({ baseURL });
  try {
    expect(
      (
        await reception.request.post('/api/auth/login', {
          data: { email: 'reception@derma.demo', password: 'DemoClinic2026!' },
        })
      ).status(),
    ).toBe(200);
    const member = await reception.newPage();
    const privateRequests: string[] = [];
    member.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/investigation-worklist')
        privateRequests.push(request.url());
    });
    await member.goto('/clinic');
    await expect(member.getByRole('heading', { name: /A good day for better care/ })).toBeVisible();
    await expect(member.locator('.investigation-overview')).toHaveCount(0);
    await expect(
      member.getByRole('link', { name: 'Investigation reviews', exact: true }),
    ).toHaveCount(0);
    await member.goto('/clinic/investigations');
    await expect(member).toHaveURL(/\/clinic$/);
    await expect(member.locator('.iwq-workspace')).toHaveCount(0);
    expect(privateRequests).toEqual([]);
    expect((await reception.request.get(worklistPath)).status()).toBe(403);
  } finally {
    await reception.close();
  }
});
