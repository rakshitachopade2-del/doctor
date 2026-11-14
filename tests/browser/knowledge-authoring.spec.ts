import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Session } from '../../shared/types';
import type {
  KnowledgeAuthoringDetail,
  KnowledgeAuthoringMutation,
  KnowledgeFields,
  KnowledgeVersionPage,
} from '../../shared/knowledge-authoring';

const approval = 'I have reviewed this information and approve it for the public clinic library.';
const restoration =
  'I understand this creates a new private draft and removes any current public publication.';
async function login(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Doctor', exact: true }).click();
  await expect(page).toHaveURL('/clinic');
  return (await (await page.request.get('/api/session')).json()) as Session;
}
const headers = (session: Session) => ({ 'X-CSRF-Token': session.csrfToken! });
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function post(
  request: APIRequestContext,
  session: Session,
  path: string,
  body: unknown,
  status = 200,
) {
  const response = await request.post(path, { headers: headers(session), data: body });
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<KnowledgeAuthoringMutation>;
}
const fields = (
  title: string,
  body = 'Synthetic clinic logistics for browser testing.',
): KnowledgeFields => ({ title, category: 'Synthetic clinic logistics', body });
async function create(request: APIRequestContext, session: Session, content: KnowledgeFields) {
  return (
    await post(
      request,
      session,
      '/api/knowledge-authoring',
      { fields: content, publication: 'draft', requestId: randomUUID() },
      201,
    )
  ).detail;
}
async function save(
  request: APIRequestContext,
  session: Session,
  source: KnowledgeAuthoringDetail,
  content: KnowledgeFields,
  publication: 'draft' | 'published' = 'draft',
  reason = 'Synthetic concurrent change',
) {
  return (
    await post(request, session, `/api/knowledge-authoring/${source.article.id}/save`, {
      fields: content,
      publication,
      ...(publication === 'published' ? { reviewed: true } : {}),
      reason,
      expectedRevision: source.revision,
      requestId: randomUUID(),
    })
  ).detail;
}
function card(page: Page, title: string) {
  return page
    .locator('.knowledge-grid .card')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}
async function fill(dialog: Locator, content: KnowledgeFields) {
  await dialog.getByLabel('Title', { exact: true }).fill(content.title);
  await dialog.getByLabel('Category', { exact: true }).fill(content.category);
  await dialog.getByLabel('Article content', { exact: true }).fill(content.body);
}
function response(page: Page, path: string) {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
  );
}
async function submit(page: Page, dialog: Locator, label: string, path: string, status = 200) {
  const waiting = response(page, path);
  await dialog.getByRole('button', { name: label, exact: true }).click();
  const result = await waiting;
  expect(result.status(), await result.text()).toBe(status);
  await expect(dialog).toBeHidden();
  return (await result.json()) as KnowledgeAuthoringMutation;
}
async function history(page: Page, title: string) {
  await card(page, title).getByRole('button', { name: 'Version history', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Private article history', exact: true });
  await expect(dialog.locator('.knowledge-authoring-source')).toBeVisible();
  return dialog;
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

test('reviewed article creation, private versions, withdrawal and restore keep stable public links and role boundaries', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const session = await login(page),
    marker = randomUUID().slice(0, 8),
    title = `Versioned library ${marker}`,
    content = fields(title),
    privateNote = `PRIVATE_AUTHORING_NOTE_${marker}`;
  await page.goto('/clinic/knowledge');
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Write a clinic article', exact: true });
  await fill(dialog, content);
  await dialog.getByLabel('Internal change note', { exact: true }).fill(privateNote);
  await dialog.getByLabel(approval, { exact: true }).check();
  await page.setViewportSize({ width: 320, height: 860 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('knowledge-editor-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  let source = (await submit(page, dialog, 'Approve and publish', '/api/knowledge-authoring', 201))
    .detail;
  expect(source.currentVersion.version).toBe(1);
  expect(source.historyTotal).toBe(1);
  expect(source.publication?.operation).toBe('created');
  const visitorContext = await browser.newContext({ baseURL }),
    patientContext = await browser.newContext({ baseURL }),
    receptionContext = await browser.newContext({ baseURL });
  try {
    const visitor = await visitorContext.newPage();
    let document = await visitor.goto(`/library/${source.article.id}`);
    expect(document!.status()).toBe(200);
    await expect(visitor.locator('h1')).toHaveText(title);
    await expect(visitor.locator('body')).not.toContainText(privateNote);
    const publicData = await get<Record<string, unknown>>(
      visitor.request,
      `/api/public-library/${source.article.id}`,
    );
    expect(JSON.stringify(publicData)).not.toContain(privateNote);
    expect(publicData).not.toHaveProperty('history');
    expect(publicData).not.toHaveProperty('revision');
    await card(page, title).getByRole('button', { name: 'Edit & review', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Review clinic article', exact: true });
    await dialog
      .getByLabel('Article content', { exact: true })
      .fill('Synthetic second version, intentionally private.');
    await expect(dialog).toContainText('removed from the public library');
    source = (
      await submit(page, dialog, 'Save draft', `/api/knowledge-authoring/${source.article.id}/save`)
    ).detail;
    expect(source.currentVersion.version).toBe(2);
    document = await visitor.reload();
    expect(document!.status()).toBe(404);
    await expect(visitor.locator('body')).not.toContainText('Synthetic second version');
    dialog = await history(page, title);
    const original = dialog
      .locator('.knowledge-authoring-history-entry')
      .filter({ has: page.getByRole('heading', { name: 'Version 1', exact: true }) });
    await original.getByText(`Read version 1 · ${title}`, { exact: true }).click();
    await expect(original).toContainText(content.body);
    await original.getByRole('button', { name: 'Restore as new draft', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Restore an article version', exact: true });
    await dialog
      .getByLabel('Reason for restoration', { exact: true })
      .fill('Return to the previously reviewed logistics wording.');
    await dialog.getByRole('button', { name: 'Restore as new draft', exact: true }).click();
    expect(
      await dialog
        .getByLabel(restoration, { exact: true })
        .evaluate((input) => (input as HTMLInputElement).validity.valueMissing),
    ).toBeTruthy();
    await dialog.getByLabel(restoration, { exact: true }).check();
    source = (
      await submit(
        page,
        dialog,
        'Restore as new draft',
        `/api/knowledge-authoring/${source.article.id}/restore`,
      )
    ).detail;
    expect(source.currentVersion.version).toBe(3);
    expect(source.currentVersion.fields).toEqual(content);
    expect(source.article.status).toBe('draft');
    dialog = await history(page, title);
    await dialog.getByRole('button', { name: 'Publish current version', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Publish the current article', exact: true });
    await dialog.getByLabel(approval, { exact: true }).check();
    source = (
      await submit(
        page,
        dialog,
        'Approve and publish',
        `/api/knowledge-authoring/${source.article.id}/publication`,
      )
    ).detail;
    expect(source.currentVersion.version).toBe(3);
    expect(source.publication?.operation).toBe('published');
    document = await visitor.reload();
    expect(document!.status()).toBe(200);
    await expect(visitor).toHaveURL(`/library/${source.article.id}`);
    await expect(visitor.locator('.public-library-article-body')).toHaveText(content.body);
    for (const [context, email] of [
      [patientContext, 'patient@derma.demo'],
      [receptionContext, 'reception@derma.demo'],
    ] as const) {
      const signedIn = await context.request.post('/api/auth/login', {
        data: { email, password: 'DemoClinic2026!' },
      });
      expect(signedIn.status(), await signedIn.text()).toBe(200);
      for (const path of [
        '/api/knowledge-authoring',
        `/api/knowledge-authoring/${source.article.id}`,
        `/api/knowledge-authoring/${source.article.id}/versions`,
        `/api/knowledge-authoring/${source.article.id}/history`,
      ])
        expect((await context.request.get(path)).status()).toBe(403);
    }
    await page.setViewportSize({ width: 320, height: 860 });
    dialog = await history(page, title);
    await dialog.getByRole('button', { name: 'Activity history', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Article activity history' })).toContainText(
      'Historical content restored as a draft',
    );
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('knowledge-history-mobile.png'),
      fullPage: true,
    });
  } finally {
    await Promise.all([visitorContext.close(), patientContext.close(), receptionContext.close()]);
  }
});

test('stale article review retains entered content and uncertain saves retry exactly after later current changes', async ({
  page,
}) => {
  test.setTimeout(120000);
  const session = await login(page),
    title = `Retained knowledge draft ${randomUUID().slice(0, 8)}`;
  let source = await create(page.request, session, fields(title));
  await page.goto('/clinic/knowledge');
  await card(page, title).getByRole('button', { name: 'Edit & review', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review clinic article', exact: true }),
    draft = fields(title, 'Synthetic entered content to retain across a competing update.');
  await fill(dialog, draft);
  await dialog
    .getByLabel('Internal change note', { exact: true })
    .fill('Private note kept with exact submitted content.');
  await dialog.getByLabel(approval, { exact: true }).check();
  source = await save(
    page.request,
    session,
    source,
    fields(title, 'Competing saved version that must be explicitly reviewed.'),
  );
  const path = `/api/knowledge-authoring/${source.article.id}/save`,
    stale = response(page, path);
  await dialog.getByRole('button', { name: 'Approve and publish', exact: true }).click();
  expect((await stale).status()).toBe(409);
  await expect(dialog.getByLabel('Article content', { exact: true })).toHaveValue(draft.body);
  await expect(dialog.getByLabel(approval, { exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Refresh article for review', exact: true }).click();
  await expect(dialog.locator('.knowledge-authoring-conflict')).toContainText(source.article.body);
  await dialog
    .getByRole('button', { name: 'I reviewed the latest article; keep my draft', exact: true })
    .click();
  await expect(dialog.getByLabel('Article content', { exact: true })).toHaveValue(draft.body);
  await expect(dialog.getByLabel(approval, { exact: true })).not.toBeChecked();
  await dialog.getByLabel(approval, { exact: true }).check();
  const bodies: unknown[] = [];
  let calls = 0,
    committed: KnowledgeAuthoringMutation | undefined;
  const intercept = async (route: Route) => {
    bodies.push(route.request().postDataJSON());
    calls++;
    if (calls === 2) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Synthetic subsequent rejection cannot erase an uncertain request.',
        }),
      });
      return;
    }
    const result = await route.fetch();
    expect(result.status()).toBe(200);
    const data = (await result.json()) as KnowledgeAuthoringMutation;
    if (calls === 1) {
      committed = data;
      await route.fulfill({
        response: result,
        json: {
          ...data,
          version: { ...data.version, fields: { ...data.version.fields, body: null } },
        },
      });
    } else await route.fulfill({ response: result });
  };
  await page.route(`**${path}`, intercept);
  await dialog.getByRole('button', { name: 'Approve and publish', exact: true }).click();
  await expect(
    dialog.getByText('The save outcome could not be confirmed.', { exact: true }),
  ).toBeVisible();
  expect(committed).toBeDefined();
  await expect(dialog.getByLabel('Article content', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  source = await save(
    page.request,
    session,
    committed!.detail,
    fields(title, 'A later current version after the original command committed.'),
    'draft',
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic subsequent rejection');
  await expect(dialog.getByLabel('Article content', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Article content', { exact: true })).toHaveValue(draft.body);
  const retry = response(page, path);
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await retry).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect(bodies).toHaveLength(3);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[2]).toEqual(bodies[0]);
  await page.unroute(`**${path}`, intercept);
  const current = await get<KnowledgeAuthoringDetail>(
    page.request,
    `/api/knowledge-authoring/${source.article.id}`,
  );
  expect(current.currentVersion.id).toBe(source.currentVersion.id);
  expect(current.historyTotal).toBe(4);
  expect(current.article.body).toBe(source.article.body);
  expect(
    current.history.filter(
      (event) => event.requestId === (bodies[0] as { requestId: string }).requestId,
    ),
  ).toHaveLength(1);
});

test('uncertain creation and late saves preserve command identity, recoverable history reads and accessible bounded version pages', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const session = await login(page),
    title = `Unknown create ${randomUUID().slice(0, 8)}`,
    content = fields(title);
  await page.goto('/clinic/knowledge');
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Write a clinic article', exact: true });
  await fill(dialog, content);
  await dialog.getByLabel(approval, { exact: true }).check();
  let receipt: KnowledgeAuthoringMutation | undefined;
  const bodies: unknown[] = [];
  const lose = async (route: Route) => {
    bodies.push(route.request().postDataJSON());
    const result = await route.fetch();
    if (!receipt) {
      expect(result.status()).toBe(201);
      receipt = await result.json();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic response lost after article creation.' }),
      });
    } else await route.fulfill({ response: result });
  };
  await page.route('**/api/knowledge-authoring', lose);
  await dialog.getByRole('button', { name: 'Approve and publish', exact: true }).click();
  await expect(
    dialog.getByText('The save outcome could not be confirmed.', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeVisible();
  let source = (
    await post(
      page.request,
      session,
      `/api/knowledge-authoring/${receipt!.detail.article.id}/publication`,
      {
        published: false,
        reason: 'Later withdrawal before confirming the original create response.',
        expectedRevision: receipt!.detail.revision,
        requestId: randomUUID(),
      },
    )
  ).detail;
  const retry = response(page, '/api/knowledge-authoring');
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await retry).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  await page.unroute('**/api/knowledge-authoring', lose);
  const detailPath = `/api/knowledge-authoring/${source.article.id}`;
  let corrupt = true;
  const malformed = async (route: Route) => {
    const result = await route.fetch();
    const data = await result.json();
    await route.fulfill({
      response: result,
      json: corrupt ? { ...data, currentVersion: { ...data.currentVersion, fields: null } } : data,
    });
  };
  await page.route(`**${detailPath}`, malformed);
  await card(page, title).getByRole('button', { name: 'Version history', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Private article history', exact: true });
  await expect(dialog).toContainText('The article response was incomplete');
  corrupt = false;
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.locator('.knowledge-authoring-source')).toContainText('Private draft');
  await page.unroute(`**${detailPath}`, malformed);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await card(page, title).getByRole('button', { name: 'Edit & review', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Review clinic article', exact: true });
  await dialog
    .getByLabel('Article content', { exact: true })
    .fill('Committed content while the user navigates away.');
  let release!: () => void, committed!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    written = new Promise<void>((resolve) => {
      committed = resolve;
    });
  const hold = async (route: Route) => {
    const result = await route.fetch();
    expect(result.status()).toBe(200);
    committed();
    await gate;
    try {
      await route.fulfill({ response: result });
    } catch {
      /* Navigation can cancel a response already committed by the server. */
    }
  };
  const savePath = `${detailPath}/save`;
  await page.route(`**${savePath}`, hold);
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await written;
  await page.evaluate(() => {
    window.history.pushState({ key: 'knowledge-away' }, '', '/clinic');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  release();
  await expect(page).toHaveURL('/clinic');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL('/clinic');
  await page.unroute(`**${savePath}`, hold);
  source = await get<KnowledgeAuthoringDetail>(page.request, detailPath);
  expect(source.article.body).toBe('Committed content while the user navigates away.');
  for (let i = 0; i < 10; i++)
    source = await save(
      page.request,
      session,
      source,
      fields(title, `Synthetic retained version sequence ${i}.`),
    );
  await page.goto('/clinic/knowledge');
  dialog = await history(page, title);
  await expect(dialog.locator('.knowledge-authoring-history-entry')).toHaveCount(10);
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Version 1', exact: true })).toBeVisible();
  const versions = await get<KnowledgeVersionPage>(
    page.request,
    `${detailPath}/versions?page=2&pageSize=10`,
  );
  await expect(dialog.locator('.knowledge-authoring-history-entry')).toHaveCount(
    versions.items.length,
  );
  await page.setViewportSize({ width: 320, height: 860 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('knowledge-versions-mobile.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .getByLabel('Search articles', { exact: true })
    .fill('Getting ready for your appointment');
  await page.getByRole('button', { name: 'Find articles', exact: true }).click();
  dialog = await history(page, 'Getting ready for your appointment');
  await expect(dialog).toContainText('Retained legacy snapshot');
  await expect(dialog).toContainText('actual saving account and approval time were not recorded');
});
