# The SEO starter pack — what a wireframe has to fit

**For:** whoever or whatever produces the wireframes · **Written:** 23 October 2026
**Scope:** this file is only about the code template (`seo-starter`). It is not the SEO strategy and not the project background — those are elsewhere.

---

## What the template is

A Next.js skeleton where the technical SEO layer is already correct and enforced by build gates that fail the build rather than warn. Every site starts from a copy of it. Visual design and content are explicitly **not** in it — they go on top, per project.

The consequence for wireframing: the template is not a suggestion you can design around. If a wireframe implies something the gates forbid, the build breaks, and the fix lands on the design.

---

## 1. The handshake — what the template needs from the wireframe

Every page must exist as a row in `lib/routes.ts` **before the page is written**, and the row is mostly a design-stage decision. One row per page, these fields:

| Field | What it is | Hard limit |
| --- | --- | --- |
| `path` | The URL as served. Lowercase, hyphenated, no trailing slash, `/` for home | Decide it at wireframe stage. **Changing it later discards everything the page has earned** |
| `targetQuery` | The one search this page exists to answer | **One page per query.** Two pages with the same target query fail the build |
| `intent` | `informational` · `comparison` · `commercial` · `navigational` · `local` | Decides how the page should read |
| `pageType` | `pillar` · `child` · `comparison` · `guide` · `utility` | Decides template and depth |
| `clusterParent` | Path of the pillar this sits under; `null` for a pillar or home | A child with no valid parent fails the build |
| `title` | The `<title>` | 50–60 characters. **The build fails over 60 — but that is this template's policy, not a Google rule.** Google truncates the displayed title by pixel width, not character count; 60 is a safe proxy |
| `description` | The meta description | 140–160 characters, same status: house policy. Google rewrites most descriptions anyway, so the limit is about writing one worth showing |
| `indexable` | Set `false` for a page that should exist but not be found | A page with `indexable: false` may set `targetQuery: null`. **Login, checkout, account and other private screens have no search target, and inventing one to fill the field is the error** — the gate now enforces that pairing |

So a wireframe that says "a flexible landing page" is not yet a wireframe. Each page needs its one query, its place in the cluster, and its URL fixed.

---

## 2. What the template already handles — do not design around it

These are generated. No wireframe or design decision is needed, and hand-writing them is forbidden by the project rules:

titles, descriptions, canonicals, Open Graph and Twitter cards, `Organization` + `WebSite` JSON-LD, breadcrumb JSON-LD, the sitemap (auto-splits at 40,000 URLs), the sitemap index, `robots.txt` (AI crawlers allowed deliberately), a real 404, security headers including HSTS and CSP, AVIF/WebP negotiation, and preview deployments noindexing themselves.

---

## 3. The nine things a wireframe can break

| Template rule | What it means for the wireframe |
| --- | --- |
| **Content must exist in the HTML before JavaScript runs** | The test is **delivery, not visual state** — corrected 24 October 2026, because the earlier wording here was too rigid. Content inside a collapsed accordion or an inactive tab is fine if it ships in the initial HTML. What breaks is content that is **fetched** on interaction: infinite scroll, "load more", client-side data loading, and tab panels whose content arrives on click. If it matters for search it must be in the first render; whether it is visible at that moment does not matter. Interactive widgets are leaves, never the page |
| **One `<h1>` per page, carrying the `targetQuery`** | The biggest text on the page is not a slogan or a brand name. It has to contain the words people search. A design with no single clear top heading, or two competing ones, fails the render gate |
| **Answer first** | The direct answer goes in the opening paragraph, above any context, hero statement or preamble. Hero-then-reveal layouts fight this. Roughly half of AI citations come from the first 30% of a page |
| **Each section stands alone** | Sections get retrieved and read without the page around them. So: no "as mentioned above", no section whose meaning depends on the previous one, terms defined where they appear |
| **No duplicated blocks** | Repeating a section for a sticky sidebar, a mobile variant, or a "see also" rail inflates the page and muddies extraction. Design one instance, placed once |
| **Images only through `components/Img.tsx`** | Every image slot needs **`alt` text and fixed dimensions** in the wireframe — give an aspect ratio per slot, not "an image here". No `data-src`, no scroll-handler loading. Mark the hero image `priority` and never lazy-load it |
| **Navigation is real `<a href>`** | No nav built from click handlers, no menu that only exists after JS. Crawlers follow anchors and nothing else |
| **Schema only for content visibly on the page** | If the design shows a rating, price, FAQ or author, it must be real and present. A design that implies structured data the page does not actually display is a manual-action risk |
| **Every page earns its existence** | Before a page enters the wireframe, name the thing on it that exists nowhere else. Pages built to fill a nav bar drag down how the whole domain is judged |

Plus the performance budget the design spends: **LCP under 2.5s, INP under 200ms, CLS under 0.1** at the 75th percentile. Hero video, a large above-the-fold image, webfont loading, late-injected banners and on-load animation are all paid for out of that budget.

---

## 4. Defaults the design inherits

From `app/globals.css` and the layout, already set: **16px body text**, **44px minimum tap targets**, a system font stack with **no webfont request** (so no flash of invisible text and no layout shift), and one `<main>` per page. Override any of these deliberately if the design needs to — a webfont is fine, imported with `display: "swap"` — but know they are the starting point and each is there for a reason.

---

## 5. What to hand over, per page

A wireframe is ready for this template when each page carries:

1. `path`, `targetQuery`, `intent`, `pageType`, `clusterParent`
2. A draft `title` (≤60 chars) and `description` (140–160 chars)
3. The one-sentence answer that goes in the opening paragraph
4. The section list **in reading order**, each with a heading that works out of context
5. Every image slot with an aspect ratio and its alt text
6. The internal links out of the page, and the link back up to its pillar
7. Which elements are interactive leaves — the only parts allowed to be client-side

---

## 6. Out of scope for the template

Visual design, content, and the search research that decides which pages exist. Also not included: analytics, consent management, a CMS. One caution if analytics is wireframed in — scope the snippet to the routes that need it in a route-segment layout; never site-wide with filtering in the vendor's dashboard.

---

## If you want to look at the code

`lib/routes.ts` (the registry and the exact allowed values) · `lib/seo.ts` (what is generated) · `components/Img.tsx` (the image contract) · `CLAUDE.md` (the seventeen rules, which is the shortest complete statement of what the template enforces; rules 13–17, added 14 November 2026, cover what a design must not carry into the build: text inside images, claims not in the wireframe, autoplay or load motion, an opening answer pushed off the first screen, and design-tool code shipped without being rebuilt in the template) · `README.md` (why each choice exists).

Run `npm run check:routes` for an instant check of the registry, and `npm run verify` for the full gate — registry, production build, and a crawl of every route with JavaScript disabled.
