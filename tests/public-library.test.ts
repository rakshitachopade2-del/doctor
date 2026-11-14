import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppOptions } from '../server/app.ts';
import { createUser, insert, openDatabase, settings, type DB } from '../server/db.ts';
import type { KnowledgeArticle } from '../shared/operations.ts';
import type { PublicLibraryBootstrap } from '../shared/public-library.ts';

const origin = 'https://clinic.example.test';
const template = `<!doctype html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <!--public-library-head-start-->
  <title>Synthetic application title</title><meta name="description" content="Synthetic shell description">
  <meta name="robots" content="noindex,nofollow">
  <!--public-library-head-end-->
  <link rel="stylesheet" href="/assets/fixture.css">
</head><body><div id="root"></div><!--public-library-data-->
<script type="module" src="/assets/fixture.js"></script></body></html>`;
const environmentKeys = ['PUBLIC_SITE_ORIGIN', 'PUBLIC_INDEXING_ENABLED', 'APP_ORIGIN'] as const;

function withEnvironment<T>(values: Record<string, string | undefined>, action: () => T): T {
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of environmentKeys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    return action();
  } finally {
    for (const key of environmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function fixture(
  t: TestContext,
  options: Partial<AppOptions> = {},
  environment: Record<string, string | undefined> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-public-library-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), template);
  writeFileSync(
    join(directory, 'assets', 'fixture.js'),
    '/* Synthetic public library test asset. */',
  );
  writeFileSync(join(directory, 'assets', 'fixture.css'), 'body { color: #173e34; }');
  writeFileSync(join(directory, 'assets', 'shadow.html'), '<p>PRIVATE_STATIC_HTML_SENTINEL</p>');
  writeFileSync(join(directory, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const app = withEnvironment(environment, () =>
    createApp({
      databasePath: ':memory:',
      demoMode: false,
      production: false,
      staticDirectory: directory,
      ...options,
    }),
  );
  const db = app.locals.db as DB;
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '',
    csrf = '';
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    app.locals.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      authenticated?: boolean;
    } = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      redirect: 'manual',
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.authenticated ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const data =
      text && response.headers.get('content-type')?.includes('application/json')
        ? JSON.parse(text)
        : undefined;
    if (response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie')!.split(';')[0];
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: response.status, headers: response.headers, text, data };
  }
  async function login() {
    const id = randomUUID(),
      email = `${id}@example.test`,
      password = 'SyntheticLibrary2026!';
    createUser(db, { id, email, name: 'Private administrator sentinel', role: 'admin' }, password);
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    assert.equal(response.status, 200, response.text);
    return response.data;
  }
  function article(overrides: Partial<KnowledgeArticle> & Record<string, unknown> = {}) {
    const value: KnowledgeArticle & Record<string, unknown> = {
      id: randomUUID(),
      title: 'Synthetic published guidance',
      category: 'Clinic information',
      body: 'Synthetic information shared for patients. This is not medical advice.',
      authorName: 'Synthetic reviewing clinician',
      updatedAt: '2026-10-21T04:30:00.000Z',
      status: 'published',
      ...overrides,
    };
    insert(db, 'knowledge', value);
    return value;
  }
  return { app, db, request, article, login, directory };
}

function bootstrap(html: string): PublicLibraryBootstrap {
  const match = html.match(/<script\b[^>]*\bid="public-library-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'Expected inert public library bootstrap');
  return JSON.parse(match[1]);
}

function main(html: string) {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/);
  assert.ok(match, 'Public content must be visible inside main before JavaScript runs');
  return match[1];
}

function noStore(headers: Headers) {
  assert.match(headers.get('cache-control') ?? '', /no-store/);
  assert.equal(headers.get('etag'), null);
}

test('public APIs explicitly project current published fields and never expose private keys or historical drafts', async (t) => {
  const f = await fixture(t);
  const published = f.article({
    internalNotes: 'PRIVATE_INTERNAL_SENTINEL',
    sessionToken: 'PRIVATE_TOKEN_SENTINEL',
    password: 'PRIVATE_PASSWORD_SENTINEL',
  });
  const draft = f.article({
    title: 'PRIVATE_DRAFT_SENTINEL',
    body: 'PRIVATE_DRAFT_BODY_SENTINEL',
    status: 'draft',
  });
  f.db
    .prepare('INSERT INTO knowledgeRevisions(id,articleId,data) VALUES (?,?,?)')
    .run(
      randomUUID(),
      published.id,
      JSON.stringify({ ...published, body: 'PRIVATE_HISTORICAL_DRAFT_SENTINEL', status: 'draft' }),
    );
  const detail = await f.request(`/api/public-library/${published.id}`);
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual(
    Object.keys(detail.data).sort(),
    ['id', 'title', 'category', 'body', 'authorName', 'updatedAt'].sort(),
  );
  assert.equal(detail.data.body, published.body);
  const index = await f.request('/api/public-library');
  assert.equal(index.status, 200);
  assert.equal(index.data.total, 1);
  assert.deepEqual(
    Object.keys(index.data.articles[0]).sort(),
    ['id', 'title', 'category', 'excerpt', 'authorName', 'updatedAt'].sort(),
  );
  const legacy = await f.request('/api/knowledge');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data[0].status, 'published');
  for (const response of [detail, index, legacy]) {
    noStore(response.headers);
    assert.ok(!response.text.includes('PRIVATE_'));
    assert.ok(!response.text.includes(draft.id));
  }
  const absent = await f.request('/api/public-library/missing-article');
  const unpublished = await f.request(`/api/public-library/${draft.id}`);
  assert.equal(unpublished.status, 404);
  assert.deepEqual(unpublished.data, absent.data);
});

test('library and article responses contain complete readable content, real links and stable metadata before JavaScript', async (t) => {
  const f = await fixture(t, { publicOrigin: origin });
  const article = f.article({
    body: 'FIRST_VISIBLE_PARAGRAPH\n\nSECOND_VISIBLE_PARAGRAPH',
    title: 'A useful synthetic article',
  });
  const index = await f.request('/library');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html.*charset=utf-8/i);
  assert.ok(main(index.text).includes(article.title));
  assert.ok(main(index.text).includes(`href="/library/${article.id}"`));
  const page = await f.request(`/library/${article.id}`);
  assert.equal(page.status, 200);
  assert.ok(main(page.text).includes('FIRST_VISIBLE_PARAGRAPH'));
  assert.ok(main(page.text).includes('SECOND_VISIBLE_PARAGRAPH'));
  assert.ok(main(page.text).includes(article.authorName));
  assert.match(page.text, /href="\/library"/);
  assert.equal((page.text.match(/<title>/g) ?? []).length, 1);
  assert.ok(!page.text.includes('Synthetic application title'));
  assert.ok(page.text.includes(`href="${origin}/library/${article.id}"`));
  const data = bootstrap(page.text);
  assert.equal(data.pageType, 'article');
  assert.equal(data.canonicalUrl, `${origin}/library/${article.id}`);
  assert.equal(data.indexable, false);
  assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
  noStore(page.headers);
  noStore(index.headers);
  const head = await f.request(`/library/${article.id}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers.get('content-type'), page.headers.get('content-type'));
  noStore(head.headers);
});

test('publication, content edits, reapproval and audit rollback immediately govern direct public URLs', async (t) => {
  const f = await fixture(t, { production: true, publicOrigin: origin, publicIndexing: true });
  await f.login();
  const created = await f.request('/api/knowledge', {
    method: 'POST',
    authenticated: true,
    body: {
      title: 'Publication lifecycle synthetic article',
      category: 'Clinic information',
      body: 'ORIGINAL_APPROVED_BODY',
    },
  });
  assert.equal(created.status, 201, created.text);
  const id = created.data.id;
  assert.equal((await f.request(`/library/${id}`)).status, 404);
  assert.equal((await f.request(`/api/public-library/${id}`)).status, 404);
  assert.equal(
    (
      await f.request(`/api/knowledge/${id}`, {
        method: 'PATCH',
        authenticated: true,
        body: { status: 'published' },
      })
    ).status,
    200,
  );
  const first = await f.request(`/library/${id}`);
  assert.equal(first.status, 200);
  assert.ok(main(first.text).includes('ORIGINAL_APPROVED_BODY'));
  assert.ok((await f.request('/sitemap.xml')).text.includes(`/library/${id}`));
  f.db.exec(
    "CREATE TRIGGER synthetic_library_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='knowledge' BEGIN SELECT RAISE(ABORT,'Synthetic library publication failure'); END;",
  );
  const failed = await f.request(`/api/knowledge/${id}`, {
    method: 'PATCH',
    authenticated: true,
    body: { body: 'FAILED_PRIVATE_EDIT' },
  });
  assert.equal(failed.status, 500);
  const unchanged = await f.request(`/library/${id}`);
  assert.equal(unchanged.status, 200);
  assert.ok(main(unchanged.text).includes('ORIGINAL_APPROVED_BODY'));
  assert.ok(!unchanged.text.includes('FAILED_PRIVATE_EDIT'));
  f.db.exec('DROP TRIGGER synthetic_library_audit_failure');
  assert.equal(
    (
      await f.request(`/api/knowledge/${id}`, {
        method: 'PATCH',
        authenticated: true,
        body: { body: 'NEW_CONTENT_AWAITING_APPROVAL' },
      })
    ).status,
    200,
  );
  for (const path of [`/library/${id}`, `/api/public-library/${id}`]) {
    const withdrawn = await f.request(path, {
      headers: { 'If-None-Match': '*', 'If-Modified-Since': 'Wed, 31 Dec 2099 23:59:59 GMT' },
    });
    assert.equal(withdrawn.status, 404, withdrawn.text);
    assert.ok(!withdrawn.text.includes('NEW_CONTENT_AWAITING_APPROVAL'));
    assert.ok(!withdrawn.text.includes('ORIGINAL_APPROVED_BODY'));
    noStore(withdrawn.headers);
  }
  assert.ok(!(await f.request('/sitemap.xml')).text.includes(`/library/${id}`));
  assert.equal(
    (
      await f.request(`/api/knowledge/${id}`, {
        method: 'PATCH',
        authenticated: true,
        body: { status: 'published' },
      })
    ).status,
    200,
  );
  const approved = await f.request(`/library/${id}`);
  assert.equal(approved.status, 200);
  assert.ok(main(approved.text).includes('NEW_CONTENT_AWAITING_APPROVAL'));
  assert.ok(!approved.text.includes('ORIGINAL_APPROVED_BODY'));
});

test('HTML, metadata and inert bootstrap escape stored text without executing markup or losing the original text', async (t) => {
  const f = await fixture(t, { publicOrigin: origin });
  const clinicName = 'Synthetic "clinic" <svg onload="evil()"> & partners';
  f.db
    .prepare('UPDATE meta SET value=? WHERE key=?')
    .run(JSON.stringify({ ...settings(f.db), name: clinicName }), 'settings');
  const article = f.article({
    title: 'Synthetic "title" </title><script id="evil-title">evil()</script> & care',
    body: 'Literal <img src=x onerror="evil()"> text\n\n</script><script id="evil-body">evil()</script> & \u2028 \u2029',
    authorName: 'Reviewer " ><svg onload="evil()">',
    category: 'Category <iframe src="https://evil.example"> & text',
  });
  const page = await f.request(`/library/${article.id}`);
  assert.equal(page.status, 200);
  for (const injection of [
    '<script id="evil-title">',
    '<script id="evil-body">',
    '<img src=x',
    '<svg onload=',
    '<iframe src=',
  ])
    assert.ok(!page.text.includes(injection), `Found active markup ${injection}`);
  assert.match(main(page.text), /&lt;img/);
  assert.match(main(page.text), /&amp;/);
  assert.equal((page.text.match(/<title>/g) ?? []).length, 1);
  assert.equal((page.text.match(/<\/title>/g) ?? []).length, 1);
  const data = bootstrap(page.text);
  assert.equal(data.clinicName, clinicName);
  assert.equal(data.pageType, 'article');
  if (data.pageType !== 'article') assert.fail('Expected article bootstrap');
  assert.equal(data.article.title, article.title);
  assert.equal(data.article.body, article.body);
  assert.equal(data.article.authorName, article.authorName);
  const inert = page.text.match(
    /<script\b[^>]*\bid="public-library-data"[^>]*>([\s\S]*?)<\/script>/,
  )![1];
  assert.ok(!/[<>&\u2028\u2029]/.test(inert));
  assert.match(inert, /\\u003c/i);
  assert.match(inert, /\\u2028/i);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.ok(
    !(page.headers.get('content-security-policy') ?? '').includes(
      "script-src 'self' 'unsafe-inline'",
    ),
  );
});

test('public HTML is independent of signed-in cookies and excludes private settings, account, session and record data', async (t) => {
  const f = await fixture(t, { publicOrigin: origin });
  const article = f.article();
  const session = await f.login();
  insert(f.db, 'patients', {
    id: 'private-patient',
    name: 'PRIVATE_PATIENT_SENTINEL',
    email: 'private-patient@example.test',
    phone: 'PRIVATE_PHONE_SENTINEL',
    allergies: 'PRIVATE_ALLERGY_SENTINEL',
  } as any);
  f.db.prepare('UPDATE meta SET value=? WHERE key=?').run(
    JSON.stringify({
      ...settings(f.db),
      email: 'PRIVATE_SETTINGS_EMAIL_SENTINEL',
      phone: 'PRIVATE_SETTINGS_PHONE_SENTINEL',
      address: 'PRIVATE_SETTINGS_ADDRESS_SENTINEL',
    }),
    'settings',
  );
  f.article({ status: 'draft', body: 'PRIVATE_UNPUBLISHED_SENTINEL' });
  for (const path of ['/library', `/library/${article.id}`]) {
    const anonymous = await f.request(path);
    const authenticated = await f.request(path, { authenticated: true });
    assert.equal(anonymous.status, 200);
    assert.equal(authenticated.text, anonymous.text);
    for (const secret of [
      'PRIVATE_',
      session.user.id,
      session.user.name,
      session.user.email,
      session.csrfToken,
    ])
      assert.ok(!authenticated.text.includes(secret));
    const data = bootstrap(authenticated.text);
    assert.equal('session' in data, false);
    assert.equal('user' in data, false);
    assert.equal('csrfToken' in data, false);
  }
  assert.equal((await f.request('/api/knowledge/manage')).status, 401);
  assert.equal((await f.request('/api/patients/private-patient')).status, 401);
});

test('public library search and pagination use literal filters, stable ordering, clamped pages and body-free summaries', async (t) => {
  const f = await fixture(t, { production: true, publicOrigin: origin, publicIndexing: true });
  const ids: string[] = [];
  for (let index = 0; index < 31; index++) {
    const id = `article-${String(index).padStart(3, '0')}`;
    f.article({
      id,
      title: `Directory article ${index}`,
      body:
        index === 3
          ? 'Unique literal %_\'" needle in body'
          : `Generic article ${index}. ${'Long content '.repeat(30)}`,
    });
    ids.push(id);
  }
  f.article({ title: 'PRIVATE_DIRECTORY_DRAFT', status: 'draft' });
  const first = await f.request('/api/public-library');
  assert.equal(first.status, 200);
  assert.deepEqual(
    {
      page: first.data.page,
      pageSize: first.data.pageSize,
      total: first.data.total,
      totalPages: first.data.totalPages,
    },
    { page: 1, pageSize: 25, total: 31, totalPages: 2 },
  );
  assert.deepEqual(
    first.data.articles.map((row: { id: string }) => row.id),
    ids.slice().reverse().slice(0, 25),
  );
  assert.ok(
    first.data.articles.every(
      (row: Record<string, unknown>) => !('body' in row) && !('status' in row),
    ),
  );
  assert.equal(first.data.articles[0].excerpt.length, 181);
  assert.ok(first.data.articles[0].excerpt.endsWith('…'));
  const last = await f.request('/api/public-library?page=999');
  assert.equal(last.data.page, 2);
  assert.equal(last.data.articles.length, 6);
  assert.deepEqual(
    last.data.articles.map((row: { id: string }) => row.id),
    ids.slice(0, 6).reverse(),
  );
  const literal = await f.request(`/api/public-library?q=${encodeURIComponent('  %_\'"  ')}`);
  assert.equal(literal.status, 200, literal.text);
  assert.equal(literal.data.query, '%_\'"');
  assert.equal(literal.data.total, 1);
  assert.equal(literal.data.articles[0].id, 'article-003');
  const empty = await f.request('/api/public-library?q=absent-term&page=9');
  assert.deepEqual(
    {
      articles: empty.data.articles,
      page: empty.data.page,
      total: empty.data.total,
      totalPages: empty.data.totalPages,
    },
    { articles: [], page: 1, total: 0, totalPages: 1 },
  );
  const html = await f.request('/library?page=999');
  assert.equal(html.status, 200);
  assert.equal(bootstrap(html.text).canonicalUrl, `${origin}/library?page=2`);
  assert.match(main(html.text), /href="\/library(?:\?page=1)?"/);
  const filtered = await f.request(`/library?q=${encodeURIComponent('%_\'"')}`);
  assert.equal(filtered.status, 200);
  assert.equal(bootstrap(filtered.text).indexable, false);
  assert.match(filtered.headers.get('x-robots-tag') ?? '', /noindex/);
});

test('invalid public queries and noncanonical route variants never become indexable article aliases', async (t) => {
  const f = await fixture(t, { publicOrigin: origin });
  const article = f.article({ id: 'case-sensitive-article' });
  for (const query of [
    'page=0',
    'page=-1',
    'page=1.5',
    'page=1000001',
    'page=2&page=1',
    'q=a&q=b',
    'q[x]=test',
    'unknown=value',
    `q=${'a'.repeat(201)}`,
  ]) {
    assert.equal((await f.request(`/api/public-library?${query}`)).status, 400, query);
    const html = await f.request(`/library?${query}`);
    assert.equal(html.status, 404, query);
    assert.match(html.headers.get('x-robots-tag') ?? '', /noindex/);
  }
  assert.equal((await f.request(`/api/public-library/${article.id}?q=anything`)).status, 400);
  for (const path of [
    '/library/',
    '/Library',
    `/library/${article.id}/`,
    '/library/CASE-SENSITIVE-ARTICLE',
    '/library/%63ase-sensitive-article',
    '/library/has%2Fslash',
    '/library/bad%20id',
  ]) {
    const response = await f.request(path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
  }
  for (const id of ['missing', 'bad%20id', 'a'.repeat(101)])
    assert.equal((await f.request(`/api/public-library/${id}`)).status, 404);
});

test('sitemap and robots expose only enabled public URLs while private paths and missing assets retain correct response semantics', async (t) => {
  const f = await fixture(t, { production: true, publicOrigin: origin, publicIndexing: true });
  const published = f.article(),
    invalidDate = f.article({ updatedAt: 'not-a-date' }),
    draft = f.article({ status: 'draft' });
  const sitemap = await f.request('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type') ?? '', /xml/);
  noStore(sitemap.headers);
  const locations = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(
    locations.sort(),
    [
      `${origin}/library`,
      `${origin}/library/${published.id}`,
      `${origin}/library/${invalidDate.id}`,
    ].sort(),
  );
  assert.ok(!sitemap.text.includes(draft.id));
  assert.ok(!sitemap.text.includes('not-a-date'));
  assert.ok(sitemap.text.includes(published.updatedAt));
  const robots = await f.request('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(robots.text, /^User-agent:\s*\*/m);
  assert.match(robots.text, /^Allow:\s*\/$/m);
  assert.match(robots.text, /^Disallow:\s*\/api\//m);
  assert.ok(robots.text.includes(`Sitemap: ${origin}/sitemap.xml`));
  noStore(robots.headers);
  const html = await f.request(`/library/${published.id}`);
  assert.equal(bootstrap(html.text).indexable, true);
  assert.ok(!/noindex/.test(html.headers.get('x-robots-tag') ?? ''));
  for (const path of [
    '/',
    '/login',
    '/register',
    '/recover',
    '/book',
    '/intake',
    '/account',
    '/clinic',
    '/clinic/scheduling',
    '/clinic/patients/any-id',
    '/my-care',
    '/my-care/record',
  ]) {
    const response = await f.request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex.*nofollow/);
    assert.match(response.text, /name="robots"[^>]*content="noindex,\s*nofollow"/);
    assert.ok(!/rel="canonical"/.test(response.text));
    assert.ok(!response.text.includes('public-library-data"'));
    noStore(response.headers);
  }
  for (const path of [
    '/does-not-exist',
    '/clinic/does-not-exist',
    '/my-care/does-not-exist',
    '/assets/missing.js',
    '/index.html',
    '/index%2ehtml',
    '/%69ndex.html',
    '/assets/../index.html',
    '/assets/bad%ZZ.js',
    '/assets/shadow.html',
  ]) {
    const response = await f.request(path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.ok(!response.text.includes('PRIVATE_STATIC_HTML_SENTINEL'));
  }
  const script = await f.request('/assets/fixture.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.match(script.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.equal(script.text, '/* Synthetic public library test asset. */');
  const absentApi = await f.request('/api/nonexistent-endpoint');
  assert.equal(absentApi.status, 404);
  assert.match(absentApi.headers.get('content-type') ?? '', /application\/json/);
});

test('indexing remains disabled without every production opt-in prerequisite and never prevents ordinary reading', async (t) => {
  const cases: {
    name: string;
    options: Partial<AppOptions>;
    environment?: Record<string, string>;
  }[] = [
    { name: 'default disabled', options: { production: true, publicOrigin: origin } },
    { name: 'missing origin', options: { production: true, publicIndexing: true } },
    {
      name: 'development',
      options: { production: false, publicOrigin: origin, publicIndexing: true },
    },
    { name: 'demo', options: { demoMode: true, publicOrigin: origin, publicIndexing: true } },
    {
      name: 'explicit false beats environment',
      options: { production: true, publicOrigin: origin, publicIndexing: false },
      environment: { PUBLIC_INDEXING_ENABLED: 'true' },
    },
  ];
  for (const scenario of cases) {
    const f = await fixture(t, scenario.options, scenario.environment);
    const article = f.article();
    for (const path of ['/library', `/library/${article.id}`]) {
      const page = await f.request(path);
      assert.equal(page.status, 200, scenario.name);
      assert.equal(bootstrap(page.text).indexable, false, scenario.name);
      assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
      if (scenario.name === 'missing origin') {
        assert.equal(bootstrap(page.text).canonicalUrl, null);
        assert.ok(!page.text.includes('rel="canonical"'));
      }
      if (scenario.name === 'demo') assert.match(page.text, /demonstration|fictional/i);
    }
    const sitemap = await f.request('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.text, /<urlset\b/);
    assert.ok(!sitemap.text.includes('<loc>'));
    const robots = await f.request('/robots.txt');
    assert.ok(!robots.text.includes('Sitemap:'));
    assert.match(robots.text, /^Allow:\s*\/$/m);
    assert.ok(
      !/^Disallow:\s*\/$/m.test(robots.text),
      'Crawlers must be able to see page noindex instructions',
    );
  }
});

test('only validated configured origins determine canonical and sitemap URLs despite Host and forwarding headers', async (t) => {
  const f = await fixture(t, {
    production: true,
    publicOrigin: `${origin}/`,
    publicIndexing: true,
  });
  f.app.set('trust proxy', true);
  const article = f.article();
  const poison = {
    Host: 'attacker.example',
    'X-Forwarded-Host': 'forwarded-attacker.example',
    'X-Forwarded-Proto': 'http',
    Forwarded: 'host=another-attacker.example;proto=http',
    Origin: 'https://origin-attacker.example',
  };
  const page = await f.request(`/library/${article.id}`, { headers: poison });
  assert.equal(page.status, 200);
  assert.equal(bootstrap(page.text).canonicalUrl, `${origin}/library/${article.id}`);
  assert.ok(page.text.includes(`href="${origin}/library/${article.id}"`));
  for (const path of ['/sitemap.xml', '/robots.txt']) {
    const response = await f.request(path, { headers: poison });
    assert.equal(response.status, 200);
    assert.ok(response.text.includes(origin));
    assert.ok(!response.text.includes('attacker.example'));
    noStore(response.headers);
  }
  assert.ok(!page.text.includes('attacker.example'));
  const missing = await fixture(t, { production: true, publicIndexing: true });
  const noOrigin = await missing.request('/library', { headers: poison });
  assert.equal(bootstrap(noOrigin.text).canonicalUrl, null);
  assert.equal(bootstrap(noOrigin.text).indexable, false);
  assert.ok(!noOrigin.text.includes('attacker.example'));
});

test('origin and indexing configuration obey explicit options before environment fallbacks', async (t) => {
  const scenarios = [
    {
      options: { production: true, publicOrigin: 'https://explicit.example/' },
      environment: {
        PUBLIC_SITE_ORIGIN: 'https://public-env.example',
        APP_ORIGIN: 'https://app-env.example',
        PUBLIC_INDEXING_ENABLED: 'true',
      },
      expected: 'https://explicit.example',
    },
    {
      options: { production: true },
      environment: {
        PUBLIC_SITE_ORIGIN: 'https://public-env.example/',
        APP_ORIGIN: 'https://app-env.example',
        PUBLIC_INDEXING_ENABLED: 'true',
      },
      expected: 'https://public-env.example',
    },
    {
      options: { production: true },
      environment: {
        PUBLIC_SITE_ORIGIN: '',
        APP_ORIGIN: 'https://app-env.example/',
        PUBLIC_INDEXING_ENABLED: 'true',
      },
      expected: 'https://app-env.example',
    },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(t, scenario.options, scenario.environment);
    const page = await f.request('/library');
    assert.equal(bootstrap(page.text).canonicalUrl, `${scenario.expected}/library`);
    assert.equal(bootstrap(page.text).indexable, true);
  }
  for (const localOrigin of [
    'http://localhost:5195',
    'http://127.0.0.1:3023',
    'http://[::1]:4000',
  ]) {
    const f = await fixture(t, { publicOrigin: localOrigin });
    assert.equal(
      bootstrap((await f.request('/library')).text).canonicalUrl,
      `${localOrigin}/library`,
    );
  }
});

test('invalid configured origins fail before opening a database rather than falling back to request headers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-library-origin-'));
  try {
    for (const invalid of [
      'http://clinic.example.test',
      'https://user:password@clinic.example.test',
      'https://clinic.example.test/path',
      'https://clinic.example.test/?query=yes',
      'https://clinic.example.test/#fragment',
      '//clinic.example.test',
      'javascript:alert(1)',
      'not a URL',
    ]) {
      const path = join(directory, `${randomUUID()}.sqlite`);
      assert.throws(
        () =>
          withEnvironment({}, () =>
            createApp({ databasePath: path, demoMode: false, publicOrigin: invalid }),
          ),
        /origin|url|http|configuration/i,
        invalid,
      );
      assert.equal(existsSync(path), false, `Invalid origin opened a database: ${invalid}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sitemap refuses an oversized approved collection rather than silently truncating public discovery', async (t) => {
  const f = await fixture(t, { production: true, publicOrigin: origin, publicIndexing: true });
  const statement = f.db.prepare('INSERT INTO knowledge(id,data) VALUES (?,?)');
  f.db.exec('BEGIN');
  for (let index = 0; index < 50_000; index++) {
    const id = `bulk-${index}`;
    statement.run(
      id,
      JSON.stringify({
        id,
        title: `Synthetic ${index}`,
        category: 'Synthetic',
        body: 'Synthetic',
        authorName: 'Synthetic',
        status: 'published',
        updatedAt: '2026-10-21T00:00:00.000Z',
      }),
    );
  }
  f.db.exec('COMMIT');
  const sitemap = await f.request('/sitemap.xml');
  assert.equal(sitemap.status, 503);
  assert.ok(!sitemap.text.includes('<loc>'));
  noStore(sitemap.headers);
});

test('public pagination count and content share a coherent snapshot while another connection withdraws an article', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-library-snapshot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'clinic.sqlite');
  const f = await fixture(t, { databasePath });
  for (let index = 0; index < 26; index++)
    f.article({ id: `snapshot-${String(index).padStart(2, '0')}` });
  const external = openDatabase(databasePath),
    original = f.db.prepare.bind(f.db);
  let changed = false;
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (sql.startsWith('SELECT count(*) AS n FROM knowledge')) {
      const get = statement.get.bind(statement);
      statement.get = ((...args: Parameters<typeof get>) => {
        const result = get(...args);
        if (!changed) {
          external
            .prepare("UPDATE knowledge SET data=json_set(data,'$.status','draft') WHERE id=?")
            .run('snapshot-25');
          changed = true;
        }
        return result;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const snapshot = await f.request('/api/public-library');
    assert.equal(snapshot.status, 200, snapshot.text);
    assert.equal(changed, true);
    assert.equal(snapshot.data.total, 26);
    assert.equal(snapshot.data.totalPages, 2);
    assert.equal(snapshot.data.articles.length, 25);
    assert.ok(
      snapshot.data.articles.some((article: { id: string }) => article.id === 'snapshot-25'),
    );
    const current = await f.request('/api/public-library');
    assert.equal(current.data.total, 25);
    assert.equal(current.data.totalPages, 1);
    assert.ok(
      !current.data.articles.some((article: { id: string }) => article.id === 'snapshot-25'),
    );
  } finally {
    f.db.prepare = original;
    external.close();
  }
});
