import express, { type Express, type Request, type Response } from 'express';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { DB } from './db.ts';
import type {
  PublicArticle,
  PublicLibraryBootstrap,
  PublicLibraryIndex,
} from '../shared/public-library.ts';
import { PublicLibraryDocument } from '../src/public-library/PublicLibraryDocument.tsx';

export interface PublicSiteOptions {
  staticDirectory?: string;
  publicOrigin?: string;
  publicIndexing?: boolean;
}

export interface PublicSiteConfiguration {
  origin: string | null;
  indexable: boolean;
  publicTemplate: string | null;
  privateTemplate: string | null;
  staticDirectory: string;
}

const HEAD_BLOCK = /<!--public-library-head-start-->[\s\S]*?<!--public-library-head-end-->/g;
const ROOT = '<div id="root"></div>';
const BOOTSTRAP = '<!--public-library-data-->';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const indexQuery = z
  .object({
    q: z.string().trim().max(200).default(''),
    page: z
      .string()
      .regex(/^[1-9]\d{0,6}$/)
      .transform(Number)
      .refine((value) => value <= 1000000)
      .default(1),
  })
  .strict();
const emptyQuery = z.object({}).strict();
const PUBLIC_WHERE =
  "json_extract(data,'$.status')='published' AND length(id) BETWEEN 1 AND 100 AND id NOT GLOB '*[^A-Za-z0-9_-]*'";
const PUBLIC_FIELDS = `id, json_extract(data,'$.title') AS title,
  json_extract(data,'$.category') AS category, json_extract(data,'$.body') AS body,
  json_extract(data,'$.authorName') AS authorName, json_extract(data,'$.updatedAt') AS updatedAt`;

function templateAt(path: string) {
  if (!existsSync(path)) return null;
  const template = readFileSync(path, 'utf8');
  if (
    template.split(ROOT).length !== 2 ||
    (template.match(HEAD_BLOCK)?.length ?? 0) !== 1 ||
    template.split(BOOTSTRAP).length !== 2 ||
    !template.includes('</head>') ||
    !template.includes('</body>')
  )
    throw new Error(
      `Public page template is missing its unique head, root, or data markers: ${path}`,
    );
  return template;
}

/** Validate before opening the database; request Host/forwarded headers are never consulted. */
export function publicSiteConfiguration(
  options: PublicSiteOptions,
  production: boolean,
  demoMode: boolean,
): PublicSiteConfiguration {
  const configured =
    options.publicOrigin ??
    (process.env.PUBLIC_SITE_ORIGIN?.trim() || process.env.APP_ORIGIN?.trim());
  let origin: string | null = null;
  if (configured !== undefined && configured !== '') {
    try {
      const url = new URL(configured);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        throw new Error('Invalid origin');
      origin = url.origin;
    } catch {
      throw new Error(
        'Public site origin must be an HTTPS origin without credentials, path, query, or fragment (HTTP is allowed only on loopback).',
      );
    }
  }
  const staticDirectory = resolve(options.staticDirectory ?? 'dist');
  // Development must not depend on a previous build's template or asset generation.
  const template = templateAt(
    options.staticDirectory || production
      ? resolve(staticDirectory, 'index.html')
      : resolve('index.html'),
  );
  return {
    origin,
    indexable:
      production &&
      !demoMode &&
      !!origin &&
      (options.publicIndexing ?? process.env.PUBLIC_INDEXING_ENABLED === 'true'),
    publicTemplate: template,
    privateTemplate: template,
    staticDirectory,
  };
}

export function escapePublicHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

function safeJson(value: unknown) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function plainExcerpt(value: string, limit = 180) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, limit) + (normalized.length > limit ? '…' : '');
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function respond(req: Request, res: Response, status: number, body: string, contentType: string) {
  res.status(status).set({
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');
  // res.end deliberately avoids Express's automatic ETag/freshness handling for withdrawn content.
  res.end(req.method === 'HEAD' ? undefined : body);
}

function metadata(data: PublicLibraryBootstrap) {
  const title =
    data.pageType === 'article'
      ? `${data.article.title} | ${data.clinicName}`
      : data.pageType === 'library'
        ? `Clinic library${data.page > 1 ? ` — Page ${data.page}` : ''} | ${data.clinicName}`
        : `Page not found | ${data.clinicName}`;
  const description =
    data.pageType === 'article'
      ? plainExcerpt(data.article.body, 160)
      : data.pageType === 'library'
        ? `Information reviewed and shared by ${data.clinicName}.`
        : 'The requested page is not available.';
  const tags = [
    `<title>${escapePublicHtml(title)}</title>`,
    `<meta name="description" content="${escapePublicHtml(description)}" />`,
    `<meta name="robots" content="${data.indexable ? 'index, follow' : 'noindex, nofollow'}" />`,
    `<meta property="og:title" content="${escapePublicHtml(title)}" />`,
    `<meta property="og:description" content="${escapePublicHtml(description)}" />`,
    `<meta property="og:site_name" content="${escapePublicHtml(data.clinicName)}" />`,
    `<meta property="og:type" content="${data.pageType === 'article' ? 'article' : 'website'}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${escapePublicHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapePublicHtml(description)}" />`,
  ];
  if (data.canonicalUrl)
    tags.push(
      `<link rel="canonical" href="${escapePublicHtml(data.canonicalUrl)}" />`,
      `<meta property="og:url" content="${escapePublicHtml(data.canonicalUrl)}" />`,
    );
  if (data.pageType === 'article') {
    tags.push(`<meta name="author" content="${escapePublicHtml(data.article.authorName)}" />`);
    if (validDate(data.article.updatedAt))
      tags.push(
        `<meta property="article:modified_time" content="${escapePublicHtml(data.article.updatedAt)}" />`,
      );
  }
  return tags.join('\n');
}

const KNOWN_SPA = [
  /^\/$/,
  /^\/(?:login|register|recover|book|intake|account)$/,
  /^\/clinic(?:\/(?:scheduling|resources|accounts|billing|inventory|attendance|waitlist|insights|expenses|activity|knowledge|appointments|procedures|procedure-catalogue|patients|investigations|follow-ups|settings|audit))?$/,
  /^\/clinic\/patients\/[A-Za-z0-9_-]{1,100}(?:\/(?:details|summary))?$/,
  /^\/my-care(?:\/(?:invoices|library|record|details|summary|messages|activity))?$/,
];

export function registerPublicLibrary(
  app: Express,
  {
    db,
    configuration,
    demoMode,
  }: { db: DB; configuration: PublicSiteConfiguration; demoMode: boolean },
) {
  db.exec(
    `CREATE INDEX IF NOT EXISTS knowledge_public_updated ON knowledge(json_extract(data,'$.status'),json_extract(data,'$.updatedAt') DESC,id DESC)`,
  );
  const snapshot = <T>(work: () => T): T => {
    db.exec('BEGIN');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const clinicName = () =>
    String(
      db.prepare("SELECT json_extract(value,'$.name') AS name FROM meta WHERE key='settings'").get()
        ?.name ?? 'Derma Studio',
    );
  const article = (articleId: string) =>
    ID.test(articleId)
      ? (db
          .prepare(`SELECT ${PUBLIC_FIELDS} FROM knowledge WHERE id=? AND ${PUBLIC_WHERE}`)
          .get(articleId) as unknown as PublicArticle | undefined)
      : undefined;
  const index = (query: z.infer<typeof indexQuery>): PublicLibraryIndex => {
    const search = query.q
      ? " AND (instr(lower(json_extract(data,'$.title')),lower(?))>0 OR instr(lower(json_extract(data,'$.category')),lower(?))>0 OR instr(lower(json_extract(data,'$.body')),lower(?))>0)"
      : '';
    const parameters = query.q ? [query.q, query.q, query.q] : [];
    const total = Number(
      db
        .prepare(`SELECT count(*) AS n FROM knowledge WHERE ${PUBLIC_WHERE}${search}`)
        .get(...parameters)!.n,
    );
    const totalPages = Math.max(1, Math.ceil(total / 25));
    const page = Math.min(query.page, totalPages);
    const rows = db
      .prepare(
        `SELECT ${PUBLIC_FIELDS} FROM knowledge WHERE ${PUBLIC_WHERE}${search} ORDER BY json_extract(data,'$.updatedAt') DESC,id DESC LIMIT 25 OFFSET ?`,
      )
      .all(...parameters, (page - 1) * 25) as unknown as PublicArticle[];
    return {
      query: query.q,
      page,
      pageSize: 25,
      total,
      totalPages,
      articles: rows.map(({ body, ...item }) => ({ ...item, excerpt: plainExcerpt(body) })),
    };
  };
  const notFound = (): PublicLibraryBootstrap => ({
    schemaVersion: 1,
    pageType: 'not-found',
    clinicName: clinicName(),
    demoMode,
    canonicalUrl: null,
    indexable: false,
  });
  const render = (req: Request, res: Response, data: PublicLibraryBootstrap, status = 200) => {
    res.setHeader('X-Robots-Tag', data.indexable ? 'index, follow' : 'noindex, nofollow');
    const template = configuration.publicTemplate;
    if (!template)
      return respond(
        req,
        res,
        503,
        'Public pages are unavailable until the frontend has been built.',
        'text/plain; charset=utf-8',
      );
    const document = template
      .replace(HEAD_BLOCK, () => metadata(data))
      .replace(
        ROOT,
        () =>
          `<div id="root">${renderToString(createElement(PublicLibraryDocument, { data }))}</div>`,
      )
      .replace(
        BOOTSTRAP,
        () => `<script id="public-library-data" type="application/json">${safeJson(data)}</script>`,
      );
    respond(req, res, status, document, 'text/html; charset=utf-8');
  };

  // This middleware reads raw path segments: encoded/case/trailing-slash variants are not alternate public URLs.
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    if (req.path === '/api/public-library') {
      const query = indexQuery.safeParse(req.query);
      if (!query.success)
        return respond(
          req,
          res,
          400,
          JSON.stringify({ error: 'Invalid library query.' }),
          'application/json; charset=utf-8',
        );
      return respond(
        req,
        res,
        200,
        JSON.stringify(snapshot(() => index(query.data))),
        'application/json; charset=utf-8',
      );
    }
    if (req.path.startsWith('/api/public-library/')) {
      const item = snapshot(() => article(req.path.slice('/api/public-library/'.length)));
      if (!item)
        return respond(
          req,
          res,
          404,
          JSON.stringify({ error: 'Article not found.' }),
          'application/json; charset=utf-8',
        );
      if (!emptyQuery.safeParse(req.query).success)
        return respond(
          req,
          res,
          400,
          JSON.stringify({ error: 'Invalid library query.' }),
          'application/json; charset=utf-8',
        );
      return respond(req, res, 200, JSON.stringify(item), 'application/json; charset=utf-8');
    }
    if (req.path === '/library') {
      const query = indexQuery.safeParse(req.query);
      if (!query.success) return render(req, res, snapshot(notFound), 404);
      const data = snapshot((): PublicLibraryBootstrap => {
        const results = index(query.data);
        const params = new URLSearchParams();
        if (results.query) params.set('q', results.query);
        if (results.page > 1) params.set('page', String(results.page));
        const suffix = params.size ? `?${params}` : '';
        return {
          schemaVersion: 1,
          pageType: 'library',
          clinicName: clinicName(),
          demoMode,
          canonicalUrl: configuration.origin ? `${configuration.origin}/library${suffix}` : null,
          indexable: configuration.indexable && !results.query,
          ...results,
        };
      });
      return render(req, res, data);
    }
    if (req.path.startsWith('/library/')) {
      const data = snapshot((): PublicLibraryBootstrap => {
        const item = article(req.path.slice('/library/'.length));
        return item && emptyQuery.safeParse(req.query).success
          ? {
              schemaVersion: 1,
              pageType: 'article',
              clinicName: clinicName(),
              demoMode,
              canonicalUrl: configuration.origin
                ? `${configuration.origin}/library/${item.id}`
                : null,
              indexable: configuration.indexable,
              article: item,
            }
          : notFound();
      });
      return render(req, res, data, data.pageType === 'not-found' ? 404 : 200);
    }
    if (req.path === '/robots.txt') {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      const sitemap = configuration.indexable
        ? `Sitemap: ${configuration.origin}/sitemap.xml\n`
        : '';
      return respond(
        req,
        res,
        200,
        `User-agent: *\nAllow: /\nDisallow: /api/\n${sitemap}`,
        'text/plain; charset=utf-8',
      );
    }
    if (req.path === '/sitemap.xml') {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      const rows = configuration.indexable
        ? (db
            .prepare(
              `SELECT id,json_extract(data,'$.updatedAt') AS updatedAt FROM knowledge WHERE ${PUBLIC_WHERE} ORDER BY id LIMIT 50000`,
            )
            .all() as { id: string; updatedAt: string }[])
        : [];
      if (rows.length > 49999)
        return respond(
          req,
          res,
          503,
          'The library exceeds the single sitemap limit.',
          'text/plain; charset=utf-8',
        );
      const urls = configuration.indexable
        ? [
            `<url><loc>${escapePublicHtml(`${configuration.origin}/library`)}</loc></url>`,
            ...rows.map(
              (row) =>
                `<url><loc>${escapePublicHtml(`${configuration.origin}/library/${row.id}`)}</loc>${validDate(row.updatedAt) ? `<lastmod>${escapePublicHtml(row.updatedAt)}</lastmod>` : ''}</url>`,
            ),
          ]
        : [];
      return respond(
        req,
        res,
        200,
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`,
        'application/xml; charset=utf-8',
      );
    }
    next();
  });
  const staticAssets = express.static(configuration.staticDirectory, {
    index: false,
    redirect: false,
    setHeaders: (response) => response.setHeader('X-Robots-Tag', 'noindex, nofollow'),
  });
  app.use((req, res, next) => {
    const asset =
      req.path.startsWith('/assets/') &&
      req.path
        .slice('/assets/'.length)
        .split('/')
        .every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(segment)) &&
      !/\.html?$/i.test(req.path);
    // Never let express.static's URL decoding expose an alternate index.html shell.
    if (!asset && !['/favicon.svg', '/manifest.webmanifest'].includes(req.path)) return next();
    return staticAssets(req, res, next);
  });
  app.use((req, res, next) => {
    if (
      req.path === '/api' ||
      req.path.startsWith('/api/') ||
      !['GET', 'HEAD'].includes(req.method)
    )
      return next();
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (KNOWN_SPA.some((route) => route.test(req.path)) && configuration.privateTemplate) {
      const document = configuration.privateTemplate
        .replace(
          HEAD_BLOCK,
          '<title>Derma — Care, connected.</title>\n<meta name="description" content="Your private clinic and care workspace." />\n<meta name="robots" content="noindex, nofollow" />',
        )
        .replace(BOOTSTRAP, '');
      return respond(req, res, 200, document, 'text/html; charset=utf-8');
    }
    return render(req, res, snapshot(notFound), 404);
  });
}
