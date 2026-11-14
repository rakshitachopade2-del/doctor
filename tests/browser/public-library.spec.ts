import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Session } from '../../shared/types';
import type { KnowledgeArticle } from '../../shared/operations';
import type { PublicLibraryBootstrap } from '../../shared/public-library';

async function login(page: Page, role = 'Doctor') {
  await page.goto('/login');
  await page.getByRole('button', { name: role, exact: true }).click();
  await expect(page).toHaveURL(role === 'Patient' ? '/my-care' : '/clinic');
  return (await (await page.request.get('/api/session')).json()) as Session;
}
async function createArticle(
  page: Page,
  session: Session,
  title: string,
  body: string,
  published = true,
) {
  let response = await page.request.post('/api/knowledge', {
    headers: { 'X-CSRF-Token': session.csrfToken! },
    data: { title, body, category: 'Synthetic clinic logistics' },
  });
  expect(response.status(), await response.text()).toBe(201);
  const article = (await response.json()) as KnowledgeArticle;
  if (published) {
    response = await page.request.patch(`/api/knowledge/${article.id}`, {
      headers: { 'X-CSRF-Token': session.csrfToken! },
      data: { status: 'published' },
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json() as Promise<KnowledgeArticle>;
  }
  return article;
}
async function bootstrap(page: Page) {
  return JSON.parse(
    (await page.locator('#public-library-data').textContent())!,
  ) as PublicLibraryBootstrap;
}
async function metadata(page: Page, canonical: string | null) {
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  if (canonical) {
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', canonical);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', canonical);
  } else await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
}

test('reviewed articles have shareable full-document links, complete initial HTML, and quiet hydration without session requests', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const baseURL = String(testInfo.project.use.baseURL);
  await login(page);
  await page.goto('/clinic/knowledge');
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  let dialog = page.getByRole('dialog');
  const title = `Shared appointment guide ${randomUUID().slice(0, 8)}`;
  const body = `Synthetic browser fixture: bring the records you wish to discuss. ${'This paragraph is supplied only to verify complete article delivery. '.repeat(5)}\n\nFinal paragraph after the listing excerpt. Literal markup: </script><img src=x onerror="window.syntheticLibraryInjection=true"> & <script>window.syntheticLibraryInjection=true</script>.`;
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel('Category', { exact: true }).fill('Synthetic clinic logistics');
  await dialog.getByLabel('Article content', { exact: true }).fill(body);
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const manage = (await (
    await page.request.get('/api/knowledge/manage')
  ).json()) as KnowledgeArticle[];
  const article = manage.find((entry) => entry.title === title)!;
  expect(article).toBeDefined();
  const visitorContext = await browser.newContext({ baseURL });
  const noScriptContext = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const visitor = await visitorContext.newPage(),
      noScript = await noScriptContext.newPage();
    const messages: string[] = [],
      sessions: string[] = [];
    visitor.on('pageerror', (error) => messages.push(error.message));
    visitor.on('console', (message) => {
      if (message.type() === 'error' || /hydrat/i.test(message.text()))
        messages.push(message.text());
    });
    visitor.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/session') sessions.push(request.url());
    });
    const draftResponse = await noScript.goto(`/library/${article.id}`);
    expect(draftResponse!.status()).toBe(404);
    await expect(
      noScript.getByRole('heading', { name: 'This page is not available', exact: true }),
    ).toBeVisible();
    await expect(noScript.locator('body')).not.toContainText(title);
    await metadata(noScript, null);
    const card = page
      .locator('.knowledge-grid .card')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(card.getByRole('link', { name: /Open public article/ })).toHaveCount(0);
    await card.getByRole('button', { name: 'Read article', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(body);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await card.getByRole('button', { name: 'Edit & review', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Approve and publish', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByRole('link', { name: /Open public article/ })).toHaveAttribute(
      'href',
      `/library/${article.id}`,
    );

    const html = await noScript.goto(`/library/${article.id}`);
    expect(html!.status()).toBe(200);
    expect(html!.headers()['cache-control']).toContain('no-store');
    await expect(noScript.locator('h1')).toHaveCount(1);
    await expect(noScript.locator('h1')).toHaveText(title);
    await expect(noScript.locator('.public-library-article-body')).toHaveText(body);
    await expect(
      noScript.locator('.public-library-article-body img, .public-library-article-body script'),
    ).toHaveCount(0);
    await metadata(noScript, `${baseURL}/library/${article.id}`);
    await expect(noScript).toHaveTitle(new RegExp(title));
    const initial = await bootstrap(noScript);
    expect(initial.pageType).toBe('article');
    expect(initial).not.toHaveProperty('user');
    expect(initial).not.toHaveProperty('csrfToken');
    if (initial.pageType === 'article') {
      expect(Object.keys(initial.article).sort()).toEqual(
        ['id', 'title', 'category', 'body', 'authorName', 'updatedAt'].sort(),
      );
      expect(initial.article.body).toBe(body);
    }
    await visitor.goto('/library');
    const publicCard = visitor
      .locator('.public-library-card')
      .filter({ has: visitor.getByRole('heading', { name: title, exact: true }) });
    await publicCard.getByRole('link', { name: `Read article: ${title}`, exact: true }).click();
    await expect(visitor).toHaveURL(`/library/${article.id}`);
    await visitor.waitForLoadState('networkidle');
    await expect(visitor.locator('.public-library-article-body')).toHaveText(body);
    expect(
      await visitor.evaluate(
        () =>
          (window as typeof window & { syntheticLibraryInjection?: boolean })
            .syntheticLibraryInjection,
      ),
    ).toBeUndefined();
    expect(messages).toEqual([]);
    expect(sessions).toEqual([]);
    await visitor.getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(visitor).toHaveURL('/login');
    await expect(visitor.locator('#public-library-data')).toHaveCount(0);
    await metadata(visitor, null);
    await expect(visitor).not.toHaveTitle(new RegExp(title));
    await expect(visitor.locator('body')).not.toContainText(body);
  } finally {
    await visitorContext.close();
    await noScriptContext.close();
  }
});

test('library search and bounded pages work without JavaScript and the hydrated index is accessible on mobile', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90000);
  const baseURL = String(testInfo.project.use.baseURL),
    session = await login(page);
  const marker = `Library fixture ${randomUUID().slice(0, 8)}`;
  for (let i = 0; i < 28; i++)
    await createArticle(
      page,
      session,
      `${marker} guide ${i}`,
      `Synthetic pagination record ${i}. ${i === 7 ? 'Literal symbols %_ are part of this article.' : 'No medical guidance is included.'}`,
    );
  const noScriptContext = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const visitorContext = await browser.newContext({ baseURL });
  try {
    const noScript = await noScriptContext.newPage();
    await noScript.goto('/library');
    await noScript.getByLabel('Search articles', { exact: true }).fill(marker);
    await noScript.getByRole('button', { name: 'Search library', exact: true }).click();
    await expect(noScript).toHaveURL(
      (url) => url.searchParams.get('q') === marker && !url.searchParams.has('page'),
    );
    await expect(noScript.locator('.public-library-card')).toHaveCount(25);
    await expect(noScript.locator('.public-library-count')).toContainText('28 articles');
    const firstIds = await noScript
      .locator('.public-library-card h2 a')
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).pathname));
    await noScript.getByRole('link', { name: 'Next page', exact: true }).click();
    await expect(noScript).toHaveURL(
      (url) => url.searchParams.get('page') === '2' && url.searchParams.get('q') === marker,
    );
    await expect(noScript.locator('.public-library-card')).toHaveCount(3);
    const secondIds = await noScript
      .locator('.public-library-card h2 a')
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).pathname));
    expect(new Set([...firstIds, ...secondIds]).size).toBe(28);
    await expect(noScript.getByRole('navigation', { name: 'Library pages' })).toContainText(
      'Page 2 of 2',
    );
    await noScript.goto(`/library?q=${encodeURIComponent(marker)}&page=999`);
    await expect(noScript.locator('.public-library-card')).toHaveCount(3);
    expect((await bootstrap(noScript)).pageType).toBe('library');
    const clamped = await bootstrap(noScript);
    if (clamped.pageType === 'library') {
      expect(clamped.page).toBe(2);
      await metadata(
        noScript,
        `${baseURL}/library?${new URLSearchParams({ q: marker, page: '2' })}`,
      );
    }
    await noScript.getByLabel('Search articles', { exact: true }).fill('%_');
    await noScript.getByRole('button', { name: 'Search library', exact: true }).click();
    await expect(noScript.locator('.public-library-card')).toHaveCount(1);
    await expect(noScript.locator('.public-library-card')).toContainText(`${marker} guide 7`);
    await noScript.getByRole('link', { name: 'Clear search', exact: true }).click();
    await expect(noScript).toHaveURL('/library');
    const visitor = await visitorContext.newPage();
    await visitor.setViewportSize({ width: 320, height: 760 });
    await visitor.goto(`/library?q=${encodeURIComponent(marker)}`);
    await visitor.waitForLoadState('networkidle');
    await expect
      .poll(() => visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBeTruthy();
    expect(
      (
        await new AxeBuilder({ page: visitor })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await visitor.screenshot({
      path: testInfo.outputPath('public-library-mobile.png'),
      fullPage: true,
    });
  } finally {
    await noScriptContext.close();
    await visitorContext.close();
  }
});

test('published updates retain their URL, withdrawal returns a true public404, and private library links open the public page', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const baseURL = String(testInfo.project.use.baseURL),
    session = await login(page);
  const title = `Stable public guide ${randomUUID().slice(0, 8)}`;
  const article = await createArticle(
    page,
    session,
    title,
    'Synthetic original published logistics text.',
  );
  const visitorContext = await browser.newContext({ baseURL }),
    patientContext = await browser.newContext({ baseURL });
  try {
    const visitor = await visitorContext.newPage(),
      patient = await patientContext.newPage();
    await visitor.goto(`/library/${article.id}`);
    await expect(visitor.locator('h1')).toHaveText(title);
    let response = await page.request.patch(`/api/knowledge/${article.id}`, {
      headers: { 'X-CSRF-Token': session.csrfToken! },
      data: {
        title: `${title} revised`,
        body: 'Synthetic replacement published logistics text.',
        status: 'published',
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    await visitor.reload();
    await expect(visitor).toHaveURL(`/library/${article.id}`);
    await expect(visitor.locator('h1')).toHaveText(`${title} revised`);
    await expect(visitor.locator('.public-library-article-body')).toHaveText(
      'Synthetic replacement published logistics text.',
    );
    await metadata(visitor, `${baseURL}/library/${article.id}`);
    await login(patient, 'Patient');
    await patient.goto('/my-care/library');
    const card = patient
      .locator('.knowledge-grid .card')
      .filter({ has: patient.getByRole('heading', { name: `${title} revised`, exact: true }) });
    await card.getByRole('link', { name: `Read article: ${title} revised`, exact: true }).click();
    await expect(patient).toHaveURL(`/library/${article.id}`);
    await expect(patient.locator('#public-library-data')).toHaveCount(1);
    await expect(patient.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    const privateDraft = 'Private withdrawn draft must not appear in a public document.';
    response = await page.request.patch(`/api/knowledge/${article.id}`, {
      headers: { 'X-CSRF-Token': session.csrfToken! },
      data: { body: privateDraft },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()).status).toBe('draft');
    const missing = await visitor.reload();
    expect(missing!.status()).toBe(404);
    await expect(visitor.locator('h1')).toHaveText('This page is not available');
    await expect(visitor.locator('body')).not.toContainText(title);
    await expect(visitor.locator('body')).not.toContainText(privateDraft);
    await metadata(visitor, null);
    expect((await visitor.request.get(`/api/public-library/${article.id}`)).status()).toBe(404);
    const absent = await visitor.goto('/library/unknown-article');
    expect(absent!.status()).toBe(404);
    await expect(visitor.locator('h1')).toHaveText('This page is not available');
    await metadata(visitor, null);
    await visitor.setViewportSize({ width: 320, height: 760 });
    await visitor.waitForLoadState('networkidle');
    expect(
      (
        await new AxeBuilder({ page: visitor })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  } finally {
    await visitorContext.close();
    await patientContext.close();
  }
});
