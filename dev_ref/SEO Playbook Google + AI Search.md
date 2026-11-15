# SEO Playbook: Google + AI Search

Oct 22, 2026 · @Rakshit Chopade

A working model of how search ranking actually works in 2026, across Google and AI assistants, written for someone who ships multiple sites and wants SEO baked into the pipeline rather than bolted on afterwards.

## The verdict: do not build an SEO platform

SEO is not the same shape of problem as Debate Room or the wireframe system, so the same solution does not apply.

Those two solved a **divergent generation** problem. A single AI conversation collapses to one perspective, and you needed many perspectives in parallel, held in structure, with you steering. No existing tool did that, so building one paid off.

SEO is three things, and none of them are divergent generation:

1. **A fixed technical checklist**, identical on every site. It does not need discussion, exploration, or personas. It needs to be *code in a template* so it is never decided again.
2. **Content production against the right targets.** The hard part is choosing the targets, which is research, and writing something genuinely better, which is writing.
3. **A feedback loop fed by data you do not own** — Google Search Console, rank positions, AI citation checks. A platform cannot generate this data; it can only read it.

A platform would give you an interface over work that needs no interface. Points 1 and 2 happen inside your repo, where the files are, which is exactly where Claude Code already operates. Point 3 is a scheduled job plus a dashboard.

### You already have the toolkit

The `searchfit-seo` plugin is installed in this environment: 12 skills and 3 autonomous agents covering site audit, technical SEO, on-page optimization, schema markup, keyword clustering, content strategy, internal linking, AI visibility, broken links, content briefs, and translation. Combined with `agent-skills:webperf` and the `web-performance-auditor` agent for Core Web Vitals, that is the tool you were considering building. It is worth spending an hour running it against one real site before building anything.

### What is actually worth building, in order

| Priority | What | Why it is worth it | Effort |
| --- | --- | --- | --- |
| 1 | An SEO-baked project starter (one repo template) | Makes the technical layer inherited rather than audited. Every future site starts compliant. | One day, once |
| 2 | A repo-level rules file that constrains dev-stage AI | Stops the AI from generating SEO-hostile code in the first place. Cheaper than fixing it after. | Two hours, once |
| 3 | A monitoring loop: Search Console API plus scheduled AI-citation checks | The only genuine gap. No tool you have reads your live performance. | Half a day, then it runs itself |
| — | An SEO "platform" with rooms, personas, or discussion rounds | Solves nothing. SEO has no perspective problem. | Skip |

### On the artifact-versus-app constraint you raised

It does not bind here, which is worth knowing before you plan around it.

The SEO work that needs no interface at all is audit, technical fixes, schema, internal linking, and content generation — all of that runs in Claude Code against your repository, with no app and no API credits. The only piece that wants a persistent interface is the monitoring dashboard, and that is a published artifact reading your Search Console data on a schedule. So the one thing you would want as a hosted app is also the one thing an artifact handles well.

You never need a separate application wired to a Claude session for this.

## How search actually works: four gates

Every page passes four independent gates before anyone sees it. A failure at gate 1 makes gates 2 to 4 irrelevant, and most people optimize gate 3 while silently failing gate 1 or 2.

1. **Crawl** — a bot requests your URL. It fails here if the URL is not discoverable (no link to it, missing from the sitemap), blocked in `robots.txt`, returns an error or a redirect chain, or is too slow to fetch. Googlebot also budgets crawling per site: a site with 50,000 thin URLs gets its important pages crawled less often.
2. **Index** — the page is rendered, its content extracted, and the URL stored with its content. It fails here if the content only exists after client-side JavaScript that the renderer does not execute, if it is marked `noindex`, if a canonical tag points elsewhere, or if Google decides the page is a near-duplicate of something it already has. "Crawled — currently not indexed" in Search Console means you passed gate 1 and failed gate 2, usually for lack of distinct value.
3. **Select and rank** — for a given query, candidate pages are retrieved and ordered. This is where keywords, relevance, authority signals, and user-behaviour signals operate. It is the only gate most people think about.
4. **Present** — what the user actually sees. The same rank-1 position is worth wildly different traffic depending on whether the page above it is an AI Overview, a product carousel, a map pack, or nothing. Winning gate 3 and losing gate 4 is now the normal failure.

### Why this framing matters for you specifically

AI-built sites fail at gates 1 and 2 far more often than hand-built ones, because the AI optimizes for what renders in the browser, not what a bot without JavaScript sees. A React single-page app with client-side routing can look perfect to you and be almost entirely invisible to a crawler. This is the single highest-leverage thing to get right, and it is a build-time decision — which is why it belongs in your template, not in a later audit.

Gate 4 is the newer problem. Google now answers many queries directly, so a first-place ranking on an informational query may produce far less traffic than it did two years ago. The practical consequence is that **ranking and traffic have decoupled**, and you need to choose keyword targets where a click is still necessary — covered below.

## What actually moves rankings

Google uses hundreds of signals, but they collapse into six things that matter and a long tail that does not. Being "paranoid" about SEO means being obsessive about the six, not exhaustive about the tail — the tail is where people burn months.

**The six that move the needle:**

1. **Indexability and render-completeness.** Can a bot with no JavaScript read the full content of the page? Binary, and it gates everything.
2. **Query-to-page match.** Does a page exist that is clearly, specifically about the thing being searched, and does it satisfy the *intent* behind the query rather than just containing the words?
3. **Content quality relative to what already ranks.** Not quality in the abstract. You are graded against the ten results currently on page one. "As good as" loses; it must be better on something a user would notice.
4. **Authority — links and brand.** Other sites referencing yours, and people searching for your name. This is the slowest signal, the hardest to fake, and the main reason a new site cannot beat an established one on a competitive term.
5. **Site architecture and internal linking.** How link equity flows internally, and whether the structure tells Google which pages are important and how topics relate.
6. **User satisfaction signals.** Google watches whether searchers who click your result come back and click a different one. You cannot game this; you can only not deserve it.

**The long tail that mostly does not matter**, and which SEO content endlessly discusses: keyword density, exact-match keyword placement counts, meta keywords tag (dead since 2009), LSI keywords, word count targets as a goal in themselves, domain age as a direct factor, bounce rate as a direct ranking factor, Core Web Vitals beyond passing the threshold, H1 count, URL keyword stuffing, social-share counts as a direct factor, and nearly every "SEO score" produced by a tool.

### The uncomfortable part

Signals 1, 2, 3 and 5 are fully within your control and can be executed close to perfectly with AI. That is real leverage and it is why you can out-execute most small competitors.

Signal 4 — authority — cannot be AI-generated. It requires other people to independently decide to reference you. No prompt, platform, or workflow produces it. This is the honest ceiling on "AI makes SEO solvable," and it is the reason the strategy section below is about *target selection* rather than *out-optimizing incumbents*. Any plan that assumes you can beat a 15-year-old domain on its main commercial term through technical excellence is a plan to lose slowly.

## How to structure a site: pages, groups, URLs

Google ranks **pages, not sites**. So the real design question is which pages exist, how they group, and what their URLs are — and all three are decided at the wireframe stage, because they are expensive to change later.

### One page per search

Someone searching `Duster on road price Bangalore` should land on a page built only for that, at a URL that says so, answering that exact question. A generic page about the Duster loses to a page that is specifically about the Bangalore on-road price. Splitting your content into specific pages is not clutter; it is the mechanism.

### Pages live in families

A specific page standing alone is weak. It belongs in a neighborhood:

- **Pillar:** `/duster/` — the broad page about the car
- **Children:** `/duster/on-road-price-bangalore`, `/duster/mileage`, `/duster/variants`, `/duster/colours` — one specific question each

Google reads the group from three signals, in this order of weight:

1. **The URL folder path.** `/duster/mileage` and `/duster/variants` sitting under `/duster/` literally tells Google these belong together. The path does much of the work on its own.
2. **Two-way linking.** The pillar links down to every child, every child links back up to the pillar, and siblings link across where it is genuinely useful. Navigation buttons on the parent page count here — but what matters is that they are real links, not that they look like buttons.
3. **Each child actually answering its one thing** well and specifically.

When those three hold, Google concludes the site knows this topic, and it trusts every page in the family more than it would trust any of them alone.

### Where one group ends and the next begins

Group by **what the user is trying to do**, not by how your database is organized. One group equals one job in the user's head. The moment the goal changes, that is a new pillar.

| User's job | Group |
| --- | --- |
| "I'm interested in the Duster" — price, mileage, variants, colours, reviews | One pillar: the Duster |
| "I'm choosing between cars" — Duster vs Creta, best SUVs under 15 lakh | A separate comparisons pillar |
| "I need to finance this" — loan eligibility, EMI, down payment | A separate finance pillar |
| "I want a used one near me" — used cars in Bangalore | A separate used-cars pillar |

### How many pages

Let real searches decide the shape. Never invent structure to look organized. If people genuinely search ten specific things about a product, build ten child pages. If a topic has one real question behind it, it is a single page and needs no pillar at all.

Two failure modes, both costly:

- **Two pages chasing one search.** If `Duster price` and `Duster on-road cost` are really the same question, that is one page. Two pages competing for one query split the signals and weaken both. Consolidate and 301 the loser.
- **Hundreds of pages nobody searches for.** These do not sit harmlessly in the background; they drag down how the whole domain is assessed.

### The gravity rule

Your product is the centre of gravity. Search research tells you which nearby doors to open; it does not tell you what the house is for.

- **Large audience, close to your product** — car comparisons for a car marketplace — is worth building even though comparison is not your core product. The search demand is telling you a real feature should exist, and it brings people who then explore the rest of the site.
- **Small audience, far from your product** is not worth distorting the site for. Chasing it clutters the structure and pulls the product off-centre.

If you only follow searches you build a soulless keyword farm. If you only follow your idea and ignore searches you build something nobody can find. The good sites live in the overlap.

### How Google finds thousands of URLs

Two mechanisms, and at scale only the second is reliable.

**Following links.** Google lands on a page, sees links, follows them, keeps going. This works, but with thousands of products it is slow and it misses pages.

**The sitemap.** A single file at `/sitemap.xml` listing every URL you want indexed. This is you handing Google the index instead of making it wander. Your framework generates it automatically — add a product, its URL appears in the sitemap on its own — and you submit it once in Google Search Console. From then on Google re-reads it and picks up new pages as they appear.

So the answer to "do I have to do something about thousands of URLs" is: yes, but it is a one-time setup of two things (auto-generate the sitemap, register it once), and after that it scales to ten thousand pages with no further work.

One caveat so it does not surprise you later: **listed is not the same as indexed.** A thin or near-duplicate page gets discovered through the sitemap and then skipped. The sitemap gets pages found; each page still has to earn being kept.

## The technical layer: bake it once, inherit it forever

This is the part to turn into a repo template. Every item below is a build-time decision, identical across every site you will ever ship, and each one is cheap at the start and expensive to retrofit.

### Rendering — the one that actually kills AI-built sites

Server-render or statically generate every page whose content matters for search. In practice that means Next.js with SSR or SSG, Astro, SvelteKit, Nuxt, or plain server-rendered HTML — not Create React App, not Vite SPA with client-side routing, not a client-fetched content layer.

The test that settles it: disable JavaScript in the browser and load the page. Whatever you can read is roughly what the crawler reliably gets. If the page is blank, the page does not exist as far as search is concerned. Make this a CI check, not a habit.

Two related traps: content hidden behind tabs or accordions is indexed but weighted lower if injected on interaction rather than present in the DOM; and infinite scroll with no paginated URLs means everything past the first screen is unreachable.

### The non-negotiable baseline

| Item | Rule | Common failure |
| --- | --- | --- |
| URLs | Lowercase, hyphenated, descriptive, 3–5 words, no IDs or dates, stable forever | Auto-generated slugs with UUIDs; changing URLs without 301s |
| Title tag | Unique per page, primary term near the front, 50–60 characters | Same title templated across every page |
| Meta description | Unique, 140–160 characters, written to earn the click | Left empty or auto-truncated body text |
| Headings | One `h1` matching page intent, `h2`/`h3` reflecting real structure | Headings chosen for visual size |
| Canonical | Self-referencing absolute canonical on every page | Missing, or pointing to the homepage sitewide |
| `robots.txt` | Allow crawling; never block CSS or JS; link the sitemap | Blocking `/static/` or `/_next/`, so the page cannot render |
| XML sitemap | Auto-generated, only indexable 200-status URLs, accurate `lastmod` | Stale, hand-written, or listing redirects and 404s |
| Internal links | Real `<a href>` with descriptive text; never `<div onClick>` | Router-only navigation that crawlers cannot follow |
| Images | `width`/`height` set, descriptive `alt`, WebP or AVIF, lazy-load below the fold only | Lazy-loading the hero image, destroying LCP |
| Status codes | Real 404 for missing, 301 for moved, never a soft 404 | SPA returning 200 with "not found" rendered |
| HTTPS and host | One canonical host, everything else 301s to it | `www` and non-`www` both serving 200 |
| `hreflang` | Only if genuinely multilingual, reciprocal, with `x-default` | Added speculatively and half-wired |
| Pagination | Crawlable `?page=2` URLs with self-canonicals | Canonicalizing page 2 to page 1 |

### Speed, to the threshold and no further

Core Web Vitals are a tiebreaker, not a lever. Pass the thresholds, then stop and spend the time on content. Current targets: **LCP under 2.5s**, **INP under 200ms**, **CLS under 0.1**, measured at the 75th percentile of real users on mobile.

What actually gets you there, in order of impact: server-render the HTML; set explicit dimensions on every image and embed; preload the LCP image and self-host the font with `font-display: swap`; ship less JavaScript on the critical path; put static assets on a CDN. Chasing a Lighthouse score from 94 to 99 is the purest form of SEO busywork.

### Structured data

JSON-LD in the `<head>`, matching what is visibly on the page. It does not raise rankings directly; it changes how your result is *presented* (gate 4) and it makes your facts machine-extractable, which now matters for AI citation too.

Use only the types that fit: `Organization` and `WebSite` sitewide, plus `Article`, `Product` with `Offer` and `AggregateRating`, `FAQPage`, `HowTo`, `BreadcrumbList`, `LocalBusiness`, `Event`, `JobPosting`, or `SoftwareApplication` as applicable. Validate every type against Google's Rich Results Test before shipping. Marking up content that is not on the page is a manual-action risk, not a clever trick.

You have `searchfit-seo:schema-markup` installed for generating these, and `searchfit-seo:technical-seo` for auditing the whole list above.

## React or Next.js, and what hosting actually costs

One rule covers this: **Next.js (or Astro) for anything public, plain React for anything behind a login.** A dashboard or internal tool has nothing to rank, so it does not matter there. A public product site always matters.

### What actually differs

Plain React sends the browser a nearly empty HTML page and then fills it in with JavaScript. The crawler frequently looks before the filling happens, so it sees a blank page. Next.js sends the content already built into the HTML, so there is nothing to wait for. That is the entire difference, and it is the difference between invisible and visible.

With AI writing the code, the extra complexity of Next.js is not your problem, so there is no reason to default to anything else for a public site.

### You are not trading SEO against user experience

The common worry is that server-rendering means every click reloads the page. It does not, and this is worth being clear about because it is the thing that makes people pick the wrong framework.

Next.js serves a complete page on first arrival, then switches to in-app navigation once the person is browsing — they click, the URL changes, the content swaps, no reload. Smooth app feel and a fully crawlable site at the same time, with no compromise to balance.

The condition that makes this safe: **every one of those URLs must also work cold.** If a robot or a person requests `/duster/mileage` directly, a complete server-rendered page has to come back. Next.js does this by default. The plain-React trap is exactly the opposite — the URL changes as you browse, but arriving at it fresh gives a blank page that JavaScript has to fill, so the crawler gets nothing.

### Hosting and cost — the Vercel myth

Next.js is made by Vercel but is **not tied to Vercel**. It runs on GCP, AWS, Cloudflare, or a plain server, like anything else.

There are two ways to run it, and the cost difference comes from which you use:

| Mode | What happens | Cost |
| --- | --- | --- |
| Static (SSG) | Pages built once into plain files at build time, served like any static site | Same as React, often cheaper |
| Server (SSR) | Page rendered per request, so something has to be running | Slightly more |

Most content pages — product pages, guides, comparisons — can be static, which is where you should lean. So in practice the cost difference against a plain React site is small to none.

Vercel does get expensive at high traffic, but that is Vercel's pricing model, not a property of Next.js. The same application on GCP or Cloudflare at the same traffic is cheap again. The rule to carry: **Next.js always; at high traffic, host it somewhere other than Vercel.**

## Keyword strategy and the niche math

This section decides whether a site wins, and it happens before any code is written. Everything technical is table stakes; target selection is the actual strategy.

### The thing to internalize

"Beating the top companies" on their main terms is not an execution problem you can out-work. If you launch a project-management tool and target `project management software`, you are competing with domains that have hundreds of thousands of referring domains and a decade of accumulated brand search. You will not rank, no matter how technically perfect and well-written your page is, because signal 4 is not purchasable with effort.

What you *can* do, reliably, with AI as leverage: **win an enormous number of specific queries that the incumbents have not bothered to write a dedicated page for.** They have 50 pages. You can have 500 genuinely useful ones. Each one is low-volume; in aggregate they beat one impossible term, they compound, and they are exactly where AI assistants go looking for specific answers.

### How to choose targets

For each candidate keyword, four questions in order. Fail any one and drop it.

1. **Intent** — what does the searcher want: to learn, to compare, to buy, or to find a specific site? Match the page type to the intent. A sales page targeting a learning query loses to a blog post, always.
2. **Can a click still happen?** Look at the live result. If Google answers it fully in an AI Overview or a featured snippet and no one needs to click, ranking there is a vanity exercise. Prefer queries where the user needs your tool, your data, your calculator, or a decision they cannot make from two sentences.
3. **Is page one beatable?** Open the top ten. If they are all high-authority domains with pages precisely on-topic, skip it. If two or more results are only loosely about the query — a forum thread, a generic category page, a 2021 post — that is a real opening, and it is where you go.
4. **Does ranking produce anything you want?** Traffic that cannot convert or inform is a cost. Volume is the least important of the four.

### The structure that makes this compound

Organize by **topic cluster**, not by keyword list:

- One **pillar page** per major topic, targeting the broad term, comprehensive, the hub.
- Ten to thirty **cluster pages** beneath it, each owning one specific long-tail question.
- Every cluster page links up to the pillar; the pillar links down to all of them; siblings link across where genuinely relevant.

This works for three independent reasons: it concentrates topical authority so Google can see the site is *about* something; it gives every page an internal link source so nothing is orphaned; and it is the structure AI assistants traverse when they fan a question out into sub-questions.

### Where the targets come from

In rough order of value, and none of them require a paid tool to start:

- **Google Search Console, once you have any traffic.** Queries where you already rank 8–20 are the cheapest wins available — you are already relevant, you just need a better page. This becomes your best source and it is free.
- **Google autocomplete, "People also ask", and "Related searches"** on your seed terms. These are literally Google telling you the query space.
- **Competitor site structures.** What pages do they have, and more importantly, what obvious pages are *missing*? `searchfit-seo:competitor-analyzer` does this.
- **Your own product surface.** Every feature, integration, use case, comparison, and job-to-be-done is a candidate page.
- **Reddit, forums, Stack Overflow, and support tickets** for the real phrasing people use, which is rarely the industry term.

Use `searchfit-seo:keyword-clustering` to turn a raw list into clusters mapped to pages, then `searchfit-seo:content-strategy` for sequencing. Paid volume data from Ahrefs or Semrush is a convenience, not a requirement, and for long-tail targets the reported volumes are mostly noise anyway.

## Running the research step

This is the one new step to add to your pipeline, and it sits between Debate Room and the wireframe:

`idea → Debate Room → search research → wireframe (pages, groups, URLs) → build`

Its only job is to find out how people actually search for your thing *before* you design any pages, so the wireframe starts from real demand instead of what feels right. Three stages, and only one of them needs you.

### Stage 1: gather

Start with three to six seed words — for a car marketplace, `Duster`, `Creta`, `used cars`, `car loan`. Expand each into the real questions people type:

> "For someone interested in buying a Duster, list every specific thing they search on Google — prices, variants, comparisons, problems, how-tos — in the actual words people use, not marketing language."

What comes back is a messy list of a few hundred candidate searches.

**The honest limit:** an AI listing searches is guessing from its training data, not reading live Google. It produces plausible searches, not measured ones. Treat it as a first draft to be verified, never as truth.

### Stage 2: sort — the one manual hour

Apply the gravity rule. Every candidate goes into one of three piles:

| Pile | Test | Action |
| --- | --- | --- |
| Build | Close to your product, real audience | Becomes a page now |
| Park | Close to your product, tiny audience | Keep the list, revisit later |
| Ignore | Far from your product, whatever the audience | Drop it, do not let it clutter the site |

This is the only genuinely manual part, it takes about an hour per site, and you should want it manual — only you know what your product is really for. Everything else here can be automated.

### Stage 3: shape

Take the Build pile, group it into clusters by user intent (pillar plus children, as in the structure section), assign each search a URL, and hand that to the wireframe tool. `searchfit-seo:keyword-clustering` does the grouping mechanically once you have the sorted list.

### What is open, and what is sold

This is the part worth being precise about, because it is usually described as a dark art and it is not.

**What people search is open.** Google publishes it, free, to everyone: autocomplete, "People also ask", and "Related searches" are Google literally showing you real queries. No secrecy, no estimation.

**How much audience each search has is not free — but it is sold, not hidden.** Google does not publish exact volumes. Third-party tools estimate them from clickstream data and Google's own ad system, and sell those estimates in bulk. Google's Keyword Planner gives fuzzy ranges free, but needs a Google Ads account and only gets precise if you are actually running ads.

So the shape of it: **the searches are open, the volumes are buyable, and only the sorting is yours.** It is not a grey area where everyone guesses.

Which raises the obvious question — if the data is available to everyone, why doesn't everyone win? Because knowing the searches was never the hard part. The hard parts are building a genuinely better page than what already ranks, and being a site Google trusts. The data levels the field; execution decides the outcome.

### Automation versus manual, concretely

| Task | Automatable? | How |
| --- | --- | --- |
| Expanding seeds into candidate searches | Fully | AI, as in stage 1 |
| Pulling Google autocomplete at scale | Fully | Google's undocumented autocomplete endpoint returns suggestions as plain data — no browser needed |
| "People also ask", related searches, live results | Fully, via a paid API | DataForSEO or SerpAPI; needs a real browser otherwise |
| Search volumes in bulk | Fully, via a paid API | Ahrefs or Semrush API, or DataForSEO |
| **Sorting by the gravity rule** | **No — keep it manual** | You, \~1 hour per site |
| Clustering the sorted list into pillars and children | Fully | `searchfit-seo:keyword-clustering` |
| Generating draft pages, schema, internal links, sitemap | Fully | Your installed skills |
| **Adding the one unique thing per page** | **No — keep it manual** | You: your screenshot, your number, your opinion |
| Monitoring performance after launch | Fully | Search Console API on a schedule |

Two manual items, both strategy, both small in time and large in effect. Everything else is a script.

### What it costs, October 2026

| Tool | Price | What you get |
| --- | --- | --- |
| Google autocomplete, "People also ask", related searches | Free | Real queries, unlimited; manual unless scripted |
| Google Search Console | Free | Your own real query data once the site is live — the best source there is |
| Google Keyword Planner | Free, needs a Google Ads account | Fuzzy volume ranges, precise only while running ads |
| [Moz Pro Starter](https://konabayev.com/blog/seo-tool-pricing-2026/) | $49/month | Entry tier, single site |
| [Ahrefs Lite](https://konabayev.com/blog/seo-tool-pricing-2026/) | $129/month | 5 projects, 750 tracked keywords, 1 user |
| [Semrush SEO](https://konabayev.com/blog/seo-tool-pricing-2026/) | $139/month ($117 billed annually) | 5 sites, 500 daily tracked keywords, site audit; API only from the $549 tier |
| [DataForSEO](https://searlo.tech/serp-api-pricing) | Pay-as-you-go, \~$0.60 per 1,000 queries | The cheapest route to automated results data |
| [SerpAPI](https://searlo.tech/serp-api-pricing) | From $25/month for 1,000 searches | Easier to use, roughly 10–40x DataForSEO's per-query cost |

Prices move — check the vendor before buying. Note how wide the gap is between the subscription tools and the raw APIs: if what you want is automation rather than a dashboard, DataForSEO at well under a cent per query does the job that a $139/month subscription is mostly selling you an interface for.

### On scraping Google yourself: don't

You asked whether Playwright, Selenium, or a browser-driving AI agent could do this without being flagged. The straight answer:

Autocomplete is easy — that undocumented endpoint is a plain data call, and you can run it across hundreds of seeds in minutes. It is also undocumented, so it can change or disappear without notice.

"People also ask" and live results are a different matter. Those need a real browser, and **Google actively detects and blocks automated scraping of its results.** You can evade detection for a while with rotating proxies, human-like delays, and agent-driven browsers, but you are then in an arms race against Google's detection, your IPs get blocked, it breaks regularly, and it violates their terms of service.

The verdict: it works, and don't. Pay a middleman that already runs that infrastructure — DataForSEO or SerpAPI — for cents per query, and spend the engineering time on your product. The scraping route costs more in maintenance than the API fees ever will, and for someone shipping multiple sites that maintenance is exactly the wrong thing to own.

### What to actually do on your first sites

**Don't subscribe to anything yet.** For the first site or two, run on the free layer: AI-generated candidates, verified against autocomplete and "People also ask", then Search Console once you are live.

The reason is specific rather than frugal: exact volumes barely matter for the long-tail pages you will be targeting, and volume estimates are least reliable precisely at that low end, in every tool. You would be paying for numbers you should not trust anyway.

Subscribe when you have a site already earning traffic and you want to scale page production seriously — pay when you are scaling, not while you are learning.

## The handoff to the wireframe

The research step does not hand over a document for the wireframe tool to interpret. It hands over a table where **every row is a page**, and every page already knows what it is for, where it lives, and what its address is.

Your wireframe tool already outputs a list of pages, each with a name and a rough purpose. The research step staples five fields onto each one. That is the entire handoff.

| Field | Example | What it removes |
| --- | --- | --- |
| Target query | `Duster on road price Bangalore` | The wireframe no longer guesses what the page must answer |
| Intent | Buying | Tells the page what it should feel like — sales, guide, comparison |
| Page type | Child page | Decides the template and the depth |
| URL slug | `/duster/on-road-price-bangalore` | Locks the expensive-to-change decision at the right moment |
| Cluster parent | `/duster/` | Decides the grouping and the two-way linking now, not later by guesswork |

Each field exists because it removes a decision the wireframe would otherwise make blind. Together they mean the wireframe just draws what the table has already decided.

The consequence worth noticing: **site structure stops being a design choice and becomes a research output.** By the time you are wireframing, the hard thinking is already done, and the three expensive decisions — which pages exist, how they group, what the URLs are — were all made with real demand in front of you.

## Content that ranks

One page per intent, answer first, and something on it that is not available elsewhere. That is nearly the whole craft.

### Page types, matched to intent

| Intent | Query shape | Page type | What it must contain |
| --- | --- | --- | --- |
| Informational | "what is", "how to", "why does" | Guide or tutorial | A direct answer in the first 50 words, then depth |
| Comparison | "X vs Y", "best X for Y", "alternatives to X" | Comparison or listicle | A real table with honest trade-offs, including where you lose |
| Commercial | "X software", "X tool", "buy X" | Product or category page | Pricing, specifics, proof, and a clear action |
| Navigational | your brand plus a word | Docs or your own page | Just be the obvious result |
| Local | "near me", city plus service | Location page | `LocalBusiness` schema, a real address, local specifics |

### The structure that wins both Google and AI

This is the highest-leverage formatting decision in the document, because the same structure serves both.

**Answer first.** State the direct answer in the opening paragraph, before any context, background, or preamble. Google uses that passage for featured snippets. AI systems retrieve it as a passage. CXL's analysis of 100 AI Overview citations found 55% of cited passages came from the first 30% of a page, and Kevin Indig's analysis of 18,012 verified ChatGPT citations found 44.2% in the first 30%, with retrieval probability roughly 2.5x lower for material buried deep in a page.

**Make every section self-contained.** Content is retrieved as individual passages, pulled out of the surrounding page and read without it. So each section needs to make sense alone: use specific nouns rather than "it" and "this", define terms where they appear rather than once at the top, and make sure each claim stays true when quoted in isolation.

**Then go deep.** Headings matching real sub-questions, tables for anything with multiple attributes, and enough specificity that the page is the last one someone needs to read.

### What makes a page actually better than page one

You are graded against the current top ten, so the page needs a concrete advantage a user would notice:

- **Original data.** A survey, a benchmark, usage numbers from your own product, a tested comparison. This is the single strongest differentiator and also the main thing that earns links on its own.
- **Genuine first-hand experience.** Screenshots of you actually using the thing, the failure you hit on step 4, the workaround. This is unfakeable and it is what Google's E-E-A-T guidance is reaching for.
- **Specificity where others are vague.** Real numbers, real versions, real prices, dated.
- **A tool instead of prose.** A calculator, a generator, a comparison the user drives. It ranks, it earns links, and it survives AI summarization because the answer requires interaction.
- **Current where others are stale.** A 2023 post ranking on a fast-moving topic is an open door.

### The AI-content trap, stated plainly

Google's position is that it does not penalize AI-generated content as such; it penalizes content produced at scale with no added value. In practice the distinction is sharp and it is the main risk in your specific workflow.

What fails: 200 pages generated from one template with the variables swapped, each summarizing what already exists, published in a week. This pattern has been reliably hit by core updates and by the scaled-content-abuse policy. Being prolific is precisely what triggers it.

What works: AI doing research, structure, drafting, schema, internal linking, and editing — with real inputs from you. Your product data, your benchmark, your screenshots, your opinion, your decision about what the page is for. The AI should be the leverage on your content, not a substitute for having any.

The practical rule: before publishing any page, be able to name the one thing on it that does not exist anywhere else. If you cannot, the page is a liability, not an asset, and it drags the whole domain's assessment down with it.

## Entity and authority: the part AI cannot do for you

Google does not just index pages, it maintains a model of **entities** — organizations, people, products — and what it knows about them. A new site is an unknown entity, which is why it ranks poorly even with excellent pages. Making yourself a known entity is the slow work, and it is the same work that gets you recommended by AI assistants.

### Why a new domain loses, mechanically

Google has no evidence your site is trustworthy: no other site references it, nobody searches for its name, it has no history of satisfying searchers. Ranking it highly is a risk Google has no reason to take. There is no "sandbox" timer to wait out, just an absence of evidence. New sites typically see little organic traffic for three to six months regardless of quality, and the pages that break through first are the specific long-tail ones where competition is thin.

Plan for this. If a project's business model requires organic traffic in month one, organic is the wrong channel for month one.

### What builds authority, in order of return

1. **Something worth referencing.** Original data, a free tool, a definitive guide on a narrow topic, an open-source library. Links are a consequence of an asset, not an activity you perform separately. This is where to put the effort.
2. **Consistent entity facts everywhere.** Identical name, description, category, and URL across your site, your schema markup, LinkedIn, Crunchbase, GitHub, G2 or Capterra, Product Hunt, and any directory in your niche. This is cheap, fully in your control, and directly feeds both Google's entity model and AI assistants' picture of you.
3. **Being present where your buyers already discuss the problem.** Reddit, Hacker News, niche Slack and Discord communities, Stack Overflow, industry forums. Answer real questions genuinely. These pages rank, AI systems cite them heavily, and this is the main route by which a brand-new product gets mentioned at all.
4. **Third-party listicles and comparisons.** "Best X for Y" roundups written by other people are disproportionately influential — one analysis found comparative and listicle content accounts for about 25% of all AI citations. Getting into existing roundups matters more than writing your own.
5. **Earned coverage.** Launch posts, podcasts, guest writing, being quoted. Slow, but it compounds and it is what makes the entity real.
6. **Brand search volume.** People searching your name directly is among the strongest trust signals there is, and it comes from everything above rather than from SEO work.

### What to never do

Buying links, private blog networks, link exchanges at scale, guest-post farms, comment spam, expired-domain redirects, and paid "guaranteed DR 50 backlinks" packages. These are explicitly against Google's spam policies, they are detected reliably now, and a manual action or algorithmic suppression on a domain is far more expensive than the years of patience it would have replaced. For a portfolio of sites under one identity, one penalized domain can also color how the others are assessed.

The honest summary: this is the part of SEO where your AI leverage is near zero and your patience is the input. Budget for it rather than hoping to engineer around it.

## AI search: how assistants pick who to recommend

This goes by several names — GEO (generative engine optimization), AEO (answer engine optimization), AI visibility. The important finding is that it is **roughly 70% the same work as good SEO, and 30% genuinely different**. Nobody needs a separate strategy; they need the same strategy with four additions.

### The mechanism

When someone asks an assistant a question, it does not look up your keyword. It **fans the question out** into many sub-questions, retrieves passages for each, and composes an answer from them. Google's AI Mode does this routinely, and its Deep Search mode runs hundreds of sub-queries.

Two consequences follow directly:

- **You are retrieved as a passage, not as a page.** Your paragraph is lifted out and read without the rest of the page around it. Self-contained sections are not a style preference here, they are the retrieval unit.
- **Visibility requires topical coverage, not a head term.** You need to be the best available answer to many small sub-questions, which is exactly the topic-cluster structure from the strategy section. The architecture that is right for Google is the architecture that is right for this.

### What the data shows

| Finding | Figure | Source |
| --- | --- | --- |
| Cited passages from the first 30% of a page | 55% of AI Overview citations; 44.2% of 18,012 verified ChatGPT citations | [CXL](https://cxl.com/blog/google-ai-overview-citation-sources/) |
| AI Overview citations also in Google's organic top 10 | 37.1% (of 4M URLs); 36.7% were not in the top 100 at all | [CXL / Ahrefs](https://cxl.com/blog/google-ai-overview-citation-sources/) |
| Citations per answer, by surface | \~15.2 for AI Mode, \~11.1 for AI Overviews, \~6.6 for Gemini | [Profound](https://www.tryprofound.com/articles/rank-in-google-ai-mode) |
| Share of AI citations that are comparative or listicle content | 25.4% — the largest single format | [Lafferty](https://nicklafferty.com/blog/how-to-rank-higher-in-chatgpt-perplexity/) |
| Domain overlap between ChatGPT and Perplexity citations | Only 11% of domains appear in both | [Lafferty](https://nicklafferty.com/blog/how-to-rank-higher-in-chatgpt-perplexity/) |
| Citation churn | 40–60% of citations change month to month | [Lafferty](https://nicklafferty.com/blog/how-to-rank-higher-in-chatgpt-perplexity/) |

Two things to read off that table. First, 36.7% of cited URLs did not rank in the organic top 100, so classic rankings are helpful but not required — being indexed and quotable is the real requirement. Second, the engines disagree with each other almost completely, so there is no single list to optimize against, and churn means a snapshot of your visibility is close to meaningless. Trend over months is the only readable signal.

Caveat worth keeping: much of this data comes from vendors selling AI-visibility tools, the figures are correlations rather than established causes, and it is a young field. Treat the direction as sound and the decimals as decoration.

### The four things that are genuinely different

1. **Third-party mentions outrank your own pages.** Assistants pulling "best X for Y" lean on other people's roundups, Reddit threads, and review sites far more than on your marketing pages. Being *in* the comparison matters more than publishing one. LinkedIn became the most-cited domain for professional queries between November 2025 and February 2026, and AI Mode's second-most-cited domain is google.com itself, mostly via Business Profile and Product Knowledge Panel cards — so your off-site profiles are part of the surface area.
2. **Extractable facts beat persuasive prose.** A table of your pricing, limits, and supported platforms is retrievable; "the most powerful solution for modern teams" is not. Write the facts down somewhere plain and machine-readable.
3. **Consistency across the whole web is the trust test.** The entity work from the previous section is load-bearing here: if your site says one thing and your LinkedIn and G2 say another, you are an unreliable source to a model aggregating across all three.
4. **Allow the AI crawlers.** Check `robots.txt` for `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `PerplexityBot`, `ClaudeBot`, `Google-Extended`, and `Bingbot`. Many default templates and CDN bot-protection rules block these. It is a one-line decision with a binary outcome, and blocking `OAI-SearchBot` removes you from ChatGPT's search entirely. Note that `Google-Extended` controls Gemini training but not AI Overviews — you cannot opt out of those separately from Search.

### On llms.txt: skip it for now

The proposed convention is a markdown file summarizing your site for LLMs. Current state: OpenAI's crawlers have been observed requesting `llms.txt` files regularly, and Anthropic and some others document support, but Google's Gary Illyes stated publicly that Google does not support it and has no plans to. It costs nearly nothing to generate one if your stack can emit it automatically, and it is worth zero effort beyond that. Do not treat it as a lever. Correct server-rendered HTML is what every system actually reads.

**One amendment, from the CarDekho test on 9 October 2026: a broken `llms.txt` is worse than no `llms.txt`.** CarDekho ships one whose first line reads `Sample llms.txt file`, followed by an unclosed `{code:java}` marker pasted from an internal tool, and it is 460 articles out of date. The file intended to tell AI systems what the site authoritatively is instead tells them it is placeholder content.

So the position stands with a condition: do not build a strategy around `llms.txt`, and if your framework emits one automatically, either verify it and keep it current or do not ship it at all. Shipping a stale or placeholder-looking one is an own goal, and nobody notices because nobody looks at that file after the day it is created.

### On ChatGPT ads

Since you raised it: ads launched inside ChatGPT on 9 February 2026 for Free and Go tier users in the US, opening to self-serve with no minimum spend on 5 May 2026, with CPMs around $25. The format is a single labeled sponsored card placed *below* the AI response — title up to 50 characters, body up to 100 — targeted by conversation context rather than keywords or demographics. Paid and Enterprise tiers see no ads, and ads are excluded from health and political contexts.

The part that matters strategically: OpenAI's stated "Answer Independence" principle means **paid placement cannot change what ChatGPT says in its organic answer.** Ads buy a box next to the answer; they do not buy being the answer. So this is a distribution channel to evaluate on normal paid-acquisition arithmetic, and it is not a route to AI visibility. The organic citation work above is the only thing that gets you *inside* the answer, and unlike the ad spend, it does not stop the moment you stop paying.

### The practical upshot

You do not need a separate AI-SEO program. You need: the answer-first, self-contained page structure; the topic-cluster architecture; honest comparison and listicle content; accurate facts in tables and schema; consistent entity data across third-party sites; AI crawlers unblocked; and presence in the communities and roundups your buyers already read. Every one of those also helps you in Google. `searchfit-seo:ai-visibility` is installed and covers the auditing side of this.

## Measurement: the only feedback loop you need

Without measurement, SEO is guessing with extra steps. With it, you stop guessing within about eight weeks. This is also the one genuine gap in your current toolkit, since nothing installed can read your live performance.

### Install on day one, before launch

| Instrument | Why | Cost |
| --- | --- | --- |
| Google Search Console, verified | The only source of truth for what you rank for, impressions, clicks, and index coverage. Irreplaceable. | Free |
| Bing Webmaster Tools | Five minutes, and still relevant for some AI retrieval paths | Free |
| Analytics with referrer tracking | To see traffic arriving from `chatgpt.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com` | Free |
| An XML sitemap submitted to both | Faster discovery of new pages | Free |

**Add the Search Console property before launch, and verify it before launch.** Corrected 22 October 2026: collection begins when the **property is added**, not when ownership is verified — so adding it early is what actually protects your baseline, and verification is what lets you read what has been collected. Do both early anyway: data you cannot see is data you will not act on.

### What to actually watch, and in what order

1. **Index coverage.** How many submitted pages are indexed? Anything less than near-total is a gate-1 or gate-2 failure and nothing else matters until it is fixed. Check weekly at first.
2. **Impressions trend.** The earliest signal of life, and it moves well before clicks do. If impressions are climbing, the site is being taken seriously.
3. **Queries ranking 8–20.** Your best work queue, permanently. These are pages Google already considers relevant and nearly good enough. Improving one of these is several times cheaper than ranking a new page.
4. **Clicks and click-through rate by page.** A page with high impressions and a low CTR has a title and description problem, which is a ten-minute fix with an outsized payoff.
5. **AI referral traffic.** Growing, usually small, and systematically under-reported since some assistants pass no referrer. Track the trend, do not trust the absolute number.
6. **Core Web Vitals field data.** Check once a quarter. If it passes, stop looking.

### What to ignore

Domain Authority and Domain Rating are third-party inventions, not Google metrics. "SEO score" out of 100 from any tool measures compliance with that tool's checklist. Keyword density. Daily rank fluctuation, which is noise at any timescale under two weeks. And vanity impression counts on queries that cannot convert.

### Measuring AI visibility, honestly

**There is now a Search Console report for Google's AI surfaces — added 21 October 2026, replacing the "no Search Console for AI" line that stood here.** Announced 3 June 2026 and rolled out worldwide by 31 August 2026, it combines **AI Overviews and AI Mode**. The first thing to hold onto: **those impressions are already inside Search Console's ordinary Web performance data — never add them to your Web totals.** You get page, country, device and date dimensions, text-based and multimodal filters, Pacific-time dates and canonical attribution. Property-level and page-level aggregation differ. Search Labs experiments are excluded. The report can be **absent altogether** when impressions are too few, and the usual reporting limits apply, including the 1,000-row table cap. Exported unavailable values can arrive as **0**, which is not an observed zero.

What the inspected evidence did **not** establish: a cross-assistant census, prompt-level coverage, or a separate AI click, CTR, rank or API breakdown. Plan as if we do not have those, and re-check the documentation before relying on their absence — that is a gap in what was verified, not proof the capability will never exist. Beyond Google there is still no equivalent, so the manual method stands: keep a fixed list of 20 to 40 questions a real buyer would ask, run them against ChatGPT, Google AI Mode, Perplexity and Claude on a schedule, and record whether you are mentioned, whether you are cited with a link, and who is mentioned instead. **Bing's citation metrics are not equivalent to Google impressions** — different definition, not a comparable number, and never to be summed with them.

That is mechanical, repetitive, and worth automating — it is the monitoring loop in the build list, and the only part of this whole document that justifies writing software.

## Where SEO plugs into your existing pipeline

The key insight for your workflow: **SEO is not a stage after development.** Two of its decisions must happen before the wireframe, and one of them cannot be retrofitted at all. Treating SEO as a post-launch phase is the single most expensive mistake available here.

| Your stage | SEO decision that belongs here | Retrofit cost if skipped |
| --- | --- | --- |
| Idea and research | Does search demand exist for this problem, in the words real people use? If nobody searches for it, organic is not a channel for this product. | Whole channel discovered to be unavailable after launch |
| Debate Room | Add a persona: an SEO strategist who argues for target selection and against unwinnable terms. Costs you nothing, you already have the machinery. | Strategy never gets challenged |
| Wireframe | **The page inventory and URL structure.** Which pages exist, what each one targets, how they nest, what the URLs are. This is a sitemap, and a wireframe already is one. | High — restructuring URLs later means redirect maps and lost equity |
| UI design | Content-first layouts: a real `h1`, visible text rather than text baked into images, headings that are headings. Mostly automatic if the UI is good. | Low to moderate |
| Development | **Rendering strategy — SSR or SSG.** Plus the whole technical baseline from the template. | Severe. Changing a client-rendered SPA to server-rendered later is close to a rewrite |
| Pre-deploy | Full audit, schema, sitemap, `robots.txt`, verify Search Console *before* going live | Low, but it must not be skipped |
| Cloud and deploy | CDN, compression, caching headers, stable canonical host, correct status codes | Low |
| Post-launch | Content production against the keyword plan, plus the monitoring loop | This is the ongoing work, forever |

### The two changes to make to your pipeline

**One: fold the page inventory into the wireframe stage.** Your wireframe system already decides what pages exist and how they relate. That *is* the site architecture decision. Have it also emit, per page: the target query, the search intent, the page type, the URL slug, and the parent in the cluster. You are not adding a stage, you are adding five fields to output you already produce — and it means the UI and dev stages inherit a structure that is already correct.

**Two: make the rendering decision a constraint, not a choice.** Put "server-rendered or statically generated, no exceptions for content pages" in the project rules file so the dev-stage AI never silently ships a client-rendered app. This is the highest-value single line in your whole setup, because it is the one failure that is both easy for AI to cause and very expensive to undo.

Everything else is genuinely post-development, and your installed skills handle it: `searchfit-seo:seo-audit` and `searchfit-seo:technical-seo` against the repo before deploy, `searchfit-seo:schema-markup` and `searchfit-seo:internal-linking` during the build, `agent-skills:webperf` for Core Web Vitals, and `searchfit-seo:content-strategy` driving the content queue afterwards.

## What to build, concretely

Three artifacts, in this order. Together they are maybe two days of work and they cover SEO for every site you ship from here on.

### 1. The SEO-baked starter template (one day, once)

A real repository you clone for every new project, with the technical layer already correct rather than documented. The point is that compliance is *inherited*, so it is never audited, never discussed, and never forgotten at 2am before a launch.

Contents: Next.js or Astro configured for SSR/SSG; a metadata helper that makes a unique title, description, and canonical mandatory per route, failing the build if absent; auto-generated `sitemap.xml` and `robots.txt` with AI crawlers explicitly allowed; `Organization` and `WebSite` JSON-LD wired to a single config file; an image component with required dimensions and `alt`; a 404 that returns a real 404; and two CI checks — render the built pages with JavaScript disabled and fail if main content is missing, and fail on any page lacking a title or canonical.

That last pair of checks is the whole value. A checklist gets skipped; a failing build does not.

Three further requirements came out of the CarDekho test on 9 October 2026, each one a real failure found on a large production site:

- **Return a real 404.** An unknown URL must return 404, or 410 for something retired — never a 200 redirect to a parent page. CarDekho turns every mistyped model URL into a live page. Redirecting to a parent is only correct when there is a genuine one-to-one successor.
- **Split the sitemap automatically at a threshold.** The 50,000-URL-per-file limit is real and silent when breached. Generate sitemaps that split at, say, 40,000 and let the index grow, so no launch can ever push you over.
- **Emit robots directives from one place.** CarDekho's city-page template emits them on some pages and omits them on others. A single shared head component makes that class of inconsistency impossible.

Also promote the image rule from guidance to a build failure: real `src`/`srcset` plus native `loading="lazy"`, with `width` and `height` always present. CarDekho ships 82% of its images as JS-dependent placeholders with no `<noscript>` fallback, which is the most expensive mistake on the page and completely preventable at build time.

#### What a starter template actually is

A **folder of code files** you copy to begin every new site. Not a design and not a look — the plumbing underneath: how pages render, how URLs work, how the sitemap is generated, how images load. All the invisible technical machinery.

It is general. One template, reused for every site, whether it is cars, travel or anything else, because the plumbing is identical. What changes per site is the content and the design placed on top.

The distinction from the audit, which is easy to conflate:

|  | Audit | Template |
| --- | --- | --- |
| What it is | An inspector you call in | The foundation you build on |
| When | After the site exists | Before any content exists |
| Scope | Run per page, on a sample of representative pages | Set up once, applies to every page automatically |
| Effect | Finds mistakes | Prevents them existing |

Explicitly **not** in the template: the visual design, the content, and the research step. Those stay separate.

#### Confirmed requirements — evidence, not opinion

Every row below is a real failure found on CarDekho, a large well-resourced production site, on 9 October 2026. These are settled.

| Requirement | Found by |
| --- | --- |
| Content pages server-rendered or statically generated | All three |
| Real `src`/`srcset`, native `loading="lazy"`, `width`/`height` always present — never JS-dependent placeholders | All three, independently |
| Unknown URLs return a real 404, or 410 if retired — never a 200 redirect to a parent | `technical-seo` |
| Sitemap auto-splits at \~40,000 URLs so the 50,000 cap can never be breached | `technical-seo` (49,557 of 50,000) |
| `robots` directives emitted from one shared head component | `technical-seo` (same template, inconsistent output) |
| Unique title, meta description and self-referencing canonical per route; build fails if absent | `seo-audit` |
| One `h1`, carrying the page's actual target query | `seo-audit` (H1 said the model name, title targeted price) |
| No duplicated content blocks in the DOM | `seo-audit` (review block repeated 2–3×, 48 headings for 1,834 words) |
| JavaScript budget discipline; nothing render-blocking in `<head>` | `seo-audit` and `technical-seo` (474 KB, 50 requests, 4 blocking) |
| `Organization` and `WebSite` JSON-LD from one config; `Review` and `VideoObject` where the content warrants | `ai-visibility` |
| `llms.txt` either verified and auto-regenerated, or absent entirely | `ai-visibility` (shipped reading `Sample llms.txt file`) |
| `Referrer-Policy` header | `technical-seo` |
| CI check: render the built pages with JavaScript disabled, fail if main content is missing | The pattern behind the image defect |

#### Not confirmed — research needed before building

Recorded deliberately. This template will be reused for years, so building it on unverified assumptions is the expensive mistake.

**Research done 9 October 2026. Four of the five are now resolved.**

**1. Framework — decided: Next.js.** Four reasons, in order of weight:

- The audit tooling is Next.js-aware. `technical-seo`'s checklist has a dedicated Next.js section (Server Components for static content, dynamic imports, `next/image`, route prefetching, bundle analysis) and no Astro equivalent. A Next.js template gets audited against a sharper checklist.
- `next/image` makes the CarDekho image defect — the most expensive finding across all three reports — impossible by default. Dimensions and modern formats come for free.
- It covers static and server rendering in one framework, so a site that starts as content and later needs app behaviour never forces a migration. Your products are applications, not blogs.
- AI code generation has far more Next.js training data than Astro, which matters when the AI writes the code.

Astro ships less JavaScript and is arguably better for pure-content sites, but it is a second thing to maintain and it fights you when a site later needs interactivity. Not worth the split.

**2. The skills' internals — read. One finding changes how to treat them.**

They are **prompts, not programs** — markdown checklists instructing the model what to look for, with no deterministic engine underneath. Three consequences:

- **Output quality depends on the model running them**, and will vary run to run. The three CarDekho reports were good because the model was careful, not because the tool is reliable. Re-running on the same site will not produce identical findings.
- **They can audit a codebase, not just a URL.** Both checklists have an explicit "if the user has a codebase open" path: search for page files, read meta tags, check sitemap config, review component patterns. **This means the template can be validated as code before it is ever deployed**, which simplifies the build method below.
- **The `ai-visibility` skill invites fabrication.** It instructs the model to fill in a prompt-position matrix across four AI platforms with no mechanism to query them. A less careful model would have invented the entire table. The run we did refused — that was the model overriding the skill, not the skill working. Treat `ai-visibility` as a recommendations checklist, never as measurement.

The checklists are also broader than the CarDekho reports surfaced. Additional items the template must satisfy: orphan-page prevention, pagination via `rel="next/prev"` or canonical, `font-display: swap`, browser caching headers, no exposed `.env` or `.git`, URL depth capped at 3–4 levels with hyphens and lowercase, heading hierarchy with no skips and no empty headings, anchor-text diversity, touch targets at 44×44px, body text at 16px or more, and Server Components by default rather than `"use client"` everywhere.

**3. Hosting — decided, pragmatically.** Start on Vercel: zero config is worth more than a hypothetical bill, the app is portable, and moving to Cloudflare or GCP when a specific site's traffic makes Vercel expensive is cheap and can wait until there is revenue to justify it. Do not solve high-traffic hosting before having high traffic. **Corrected 22 October 2026, and this one matters for a startup: Vercel's free Hobby plan is for non-commercial use.** A site that sells anything, carries advertising, or represents a business belongs on a paid plan. So budget the paid seat from the day a site becomes commercial — the earlier claim here, that most of the sites you ship will never leave the free tier, holds only for personal and pre-commercial projects.

**4. The five handoff fields — decided: no separate config file.** Put them in each route's own metadata export, beside the page they describe. One location, nothing to keep in sync, and the AI writing the page sees the target query right there.

**5. The template has not been proven.** Still open, and only closable by building it. See the build method below.

### Still genuinely unresolved

- **The post-launch monitoring loop** — the six questions listed under "Open" in the status section. Unchanged, and still the largest gap in the pipeline.
- **Live AI answer position** — no tool here measures it, and the skill that claims to cannot. Needs real repeated queries across platforms, which is build item 3.

#### The build method — decided

Build version one, then **run the same three skills against it** and fix whatever they flag. The template then earns its status by passing the identical test that exposed CarDekho, rather than by being asserted as correct. Nothing ships as version 1.0 until it does.

#### Built and proven — 9 October 2026

`seo-starter/` exists: 16 code files, about 1,215 lines, Next.js 15 App Router with TypeScript. Every page prerenders static, 106 kB first-load JS. `npm run verify` passes with zero errors and zero warnings.

Two gates, both of which earned their place by catching real defects **in this template's own construction**:

- **`check-routes`** — instant, no server. Validates the registry: duplicate titles, descriptions or paths, titles over 60 characters, URL shape and depth, broken cluster parents, orphan pages, raw HTML leaking into metadata, and two pages chasing the same search. Verified against a deliberately broken route: seven distinct failures caught, including the cannibalization check.
- **`check-render`** — boots the production server and fetches every route **with no JavaScript executing**, which is what most AI crawlers see. Fails on an empty `<main>`, a missing or duplicated `h1`, a missing canonical or description, an image resolving from `data-src`, generic or filename alt text, more than 100 internal links, an unknown URL not returning 404, a `robots.txt` blocking rendering resources, and a sitemap advertised but not resolving.

**What the gates caught while building it — the evidence they are not theatre:**

1. **`robots.txt` was blocking `/_next/static/chunks/`.** The template was about to ship the exact self-inflicted invisibility its own rules file lectures against. The gate's original check only looked for file extensions, so a directory-level block slipped through; it now fails on any `Disallow` under `/_next/`.
2. **`/sitemap.xml` returned 404 while `robots.txt` advertised it.** Next's `generateSitemaps` serves `/sitemap/0.xml` and creates no index, so Google would have been handed a dead link, silently. Fixed with a real sitemap index, and the gate now follows every `Sitemap:` line and every `<loc>` in the index to confirm each resolves.
3. **The verification harness itself had a false pass.** The shell version (`next start & ... && check`) hit `EADDRINUSE`, and the readiness loop happily connected to a *stale* server already on that port — so the check validated the old build and reported green. Replaced with `scripts/verify.mjs`, which takes an ephemeral port from the OS, runs the Next binary directly as one killable process, and fails explicitly if the server does not come up. A gate that can report success without having tested the current code is worse than no gate.
4. **A deliberately client-rendered page was rejected correctly**: `<main> holds only 15 chars of text without JavaScript — a crawler sees an empty page`, plus the missing canonical and Open Graph tags that a client component cannot export. Exit code 1. That is the core guarantee, proven rather than asserted.

**Two decisions revised during the build, overriding what is written above:**

- **The five research fields live in a registry (`lib/routes.ts`), not in each route's own metadata.** The earlier decision was the opposite. The reason for the change: the sitemap has to enumerate every route, which with per-file metadata needs either a build-time filesystem scan or a second list that can drift out of sync. One registry gives a single source of truth, makes the sitemap trivial, and lets TypeScript catch a page referencing an unregistered path. Pages stay three lines of boilerplate.
- **No webfont by default.** `next/font/google` fetches at build time, so the build fails outright on any network that blocks `fonts.googleapis.com` — which is how it failed here first time. A template reused for years should not carry that failure mode, and the typeface is a per-project design decision. The system stack costs no request and has no flash of invisible text; the README says how to add one.

**Verified on the real machine.** Installed and run on macOS (Apple Silicon, Node 18+): `check-routes` and `check-render` both at zero errors and zero warnings, build clean, all nine routes prerendered static, `found 0 vulnerabilities`. So it is not only green in the environment that built it.

**One dependency fix made during that install.** `npm audit` flagged four PostCSS advisories that Next 15 pulls in transitively — XSS via an unescaped `</style>` in stringify output, and arbitrary `.map` file reads via an attacker-controlled `sourceMappingURL`. They only bite on attacker-controlled CSS, which a build never processes, so the real exposure here is close to nil. But `npm audit fix --force` would have jumped to Next 16, a major version bump on a template that had just been validated. Instead PostCSS is pinned to `^8.5.29` through an `overrides` entry — inside the 8.x line Next expects, so the framework is untouched and the audit is clean. The reasoning is written into `package.json` under a `//overrides` key, along with when to remove it.

The general lesson, worth keeping: `npm audit fix --force` is not a fix, it is a version bump with an advisory attached. Read what the advisory actually requires before letting it rewrite your dependency tree — an override inside the compatible range usually does the job.

**Remaining honest limits.** It has been proven against its own two gates and three demo routes, not against a real site with real content. The `searchfit-seo` skills have not been run against it, and since they are prompts rather than programs, a clean pass from them would be evidence rather than a guarantee. Expect the first real site to surface one or two things the template did not anticipate — that is how it hardens, and those findings belong back in here.

### 2. The project rules file (two hours, once)

A `CLAUDE.md` section carried into every repo, so the AI doing the development never generates SEO-hostile code. The content is short: server-render content pages, always; real `<a href>` for navigation, never `div onClick`; one `h1` per page; every image gets dimensions and alt text; never change a published URL without a 301; never add schema for content not on the page. Six rules, enforced at the moment code is written rather than discovered in an audit three weeks later.

This is the cheapest item on the list and probably the highest return, because it converts SEO from a review step into a generation constraint.

### 3. The monitoring loop (half a day, then autonomous)

The only genuine software gap. Two halves:

**Search Console side.** The Search Console API is free and generous. A scheduled job pulls your query data weekly and writes the one report that matters: new queries you entered, queries ranking 8–20 ranked by impressions (your work queue), pages whose position dropped, and index-coverage changes. That report is your content queue, generated rather than brainstormed.

**AI visibility side.** A fixed list of 20 to 40 buyer questions, run on a schedule against ChatGPT, Google AI Mode, Perplexity, and Claude, recording mention, citation with link, and who was recommended instead. Watch the trend across months, not the snapshot.

Both outputs land in one dashboard artifact. This is where the "pending system" instinct you had is correct — but note the shape: a scheduled job plus a dashboard, not a platform with rooms and personas.

### What not to build, and why

- **An SEO discussion or debate platform.** SEO has no perspective problem. The answers are known and the constraints are objective; what you need is execution, and the installed skills execute.
- **A keyword research tool.** Search Console plus Google's own autocomplete and related searches cover the real work for free. Building a scraper for volume data is maintenance you will resent, and long-tail volume estimates are unreliable anyway.
- **A content generation platform.** Claude Code against your repo already writes the page, the schema, and the internal links, with your repo as context. A wrapper around that adds an interface and removes the context.
- **A rank tracker — for routine work.** Daily positions are noise, and Search Console's average position is the figure to act on for your own pages. Qualified 22 October 2026: a tracker is not worthless, it answers a different question. It is the only way to see **competitors'** positions, and the only way to watch one head term daily during a launch or a suspected penalty. Skip it for the monthly rhythm; buy a month of one when you have that specific question.

### First move, before building anything

Take the most SEO-dependent site you have or are about to start. Run `searchfit-seo:seo-audit` and `searchfit-seo:technical-seo` on it, then `searchfit-seo:ai-visibility`. Read what comes back.

That hour tells you two things no amount of planning will: how good the installed tooling actually is, and which specific gaps are real for your stack rather than hypothetical. Build the template from the findings rather than from this document — your actual failures are more informative than my general list.

## How sites lose

You asked not to miss anything, so this is the downside list. Most of these are specific to your situation — shipping many AI-built sites quickly under one identity — and they are the failure modes that actually end projects.

### The ones that will bite your workflow specifically

**Scaled content abuse.** Publishing many pages of low-value content, however they were produced, is an explicit spam policy violation. Programmatic SEO — generating hundreds of templated pages like `best [tool] for [industry]` — works only when each page has genuinely distinct, useful data behind it. Without that it is the textbook case the policy was written for. This is the single most likely way an AI-assisted site gets flattened, and prolificacy is the trigger.

**Client-rendered invisibility.** Already covered, and worth repeating because it is silent. The site looks perfect to you and does not exist to a crawler. Nothing in the browser warns you.

**Thin-page dilution.** 500 pages where 400 are weak does not average out; the weak ones drag the domain's overall assessment down. Fewer, better pages beat more, thinner ones, which is the opposite of what "I can generate anything" tempts you toward. Pruning or consolidating weak pages is a legitimate and often effective recovery move.

**URL churn.** Shipping fast means restructuring, and every unredirected URL change discards whatever that page had accumulated. Decide URLs at the wireframe stage and treat them as permanent.

**Cross-site footprint.** Running several sites yourself is fine. Interlinking them to pass authority, reusing content across them, or building a network that exists to link to itself is a link scheme. Keep them genuinely independent.

### The classic ways

| Failure | What happens | Fix |
| --- | --- | --- |
| Manual action | A human reviewer penalizes the site; it appears in Search Console | Fix the cause, then file a reconsideration request |
| Core update hit | Rankings drop sitewide after an update; no notice given | Improve genuine quality; recovery typically takes until a later update |
| Site reputation abuse | Hosting third-party content to exploit your domain's authority — "parasite SEO" | Do not host content you did not editorially control |
| Keyword cannibalization | Several of your own pages compete for one query, splitting signals | Consolidate into one page, 301 the rest |
| Index bloat | Thousands of filter, search, or parameter URLs crawled | `noindex` them, or block in `robots.txt` |
| Accidental deindexing | A `noindex` or `Disallow: /` shipped to production from staging | Make it a deploy check; this one is common and brutal |
| Hacked content | Injected spam pages, often undetected for weeks | Monitor the Security Issues report in Search Console |
| Expired SSL or long downtime | Rankings decay quickly | Uptime monitoring |

**The EEA carve-out on site-reputation abuse — added 21 October 2026.** Published 28 August 2026, effective 30 August 2026. It governs what a **site-reputation-abuse manual action** does. Outside the EEA, affected sections stay subject to that manual action. Inside the EEA, the manual-action impact does not apply, and affected sections may instead be separated and allowed to rank independently over time. The geography that counts is the **searcher's** location, not where the publisher sits.

Three things it is not: an exemption from any other spam policy; a promise that EEA rankings hold up; or a publisher-country rule — so being based in India gives you nothing from it directly. It only engages at all if a site carries third-party or partner-published sections, which makes it a per-site question rather than a portfolio-wide action. Its recency does not make it a priority.

### Security and dependency updates — the quiet one

Added 22 October 2026. Nothing else in this document covered it, and an unpatched site is one of the few ways to lose rankings that is genuinely hard to undo.

**Monthly, alongside the rest of the rhythm.** Run `npm audit` (or your package manager's equivalent), apply patch and minor updates, and take majors deliberately — one at a time, through the verify script. Turn on Dependabot or Renovate so the pull requests arrive on their own instead of depending on you to remember.

**Watch the two reports that tell you something is already wrong:** Search Console's **Security Issues** report and its **Manual Actions** report. A hacked site shows up there first, and injected spam pages or a "this site may be hacked" label can cost you everything the site has earned.

**Keep the framework current.** Security fixes for Next.js and its runtime ship in point releases; sitting several majors behind means the urgent patch will not apply cleanly on the day you need it.

**Before launch:** HTTPS everywhere with HSTS, dependencies patched, no secrets in the repository, and admin or staging routes both `noindex`-ed and behind authentication — an indexed admin URL is a security hole and a duplicate-content problem at the same time.

### The mindset correction

You framed the goal as paranoid completeness: miss nothing, do everything. Taken literally, that framing loses, because SEO's long tail of possible actions is effectively infinite and almost entirely worthless. Someone doing "everything" spends six months on keyword density, Lighthouse scores, and schema types nobody reads, while a competitor publishes thirty pages with original data and wins.

The paranoia is better aimed at the small set of things that are **binary and silent**: is every page actually indexed; does the content exist without JavaScript; are the AI crawlers unblocked; did a `noindex` reach production; is Search Console verified and watched; is any page being published without a reason to exist. Those fail quietly and completely, and they are the ones to check obsessively.

Everything else is a slow accumulation where consistency beats intensity. Your real advantage over established competitors is not that you can do more SEO tasks than them — it is that you can produce genuinely useful, well-structured pages at a rate they cannot, against targets they have ignored. That advantage only exists if the technical gates are open and the pages deserve to exist. Those two conditions are the whole game.

## Status: what is settled, what is still open

This section exists so nothing gets lost between conversations. It is the one to read first when picking this back up.

### Settled and written up here

| Topic | Where |
| --- | --- |
| Do not build an SEO platform; what to build instead | The verdict |
| How ranking works — the four gates, what moves rankings | How search actually works / What actually moves rankings |
| Site structure — pages not sites, pillars and children, URL paths, two-way linking, where groups end, the gravity rule, sitemaps at scale | How to structure a site |
| Technical baseline to bake into a template | The technical layer |
| React vs Next.js, the no-trade-off point, hosting cost and the Vercel myth | React or Next.js |
| Target selection and the niche math | Keyword strategy |
| The research step — gather, sort, shape; open vs sold data; automation vs manual; costs; why not to scrape | Running the research step |
| The five fields handed to the wireframe | The handoff to the wireframe |
| Content structure, authority, AI search, failure modes | The remaining sections |

That covers the front half of the pipeline end to end: **idea → Debate Room → research → wireframe → build.**

### Open — not yet discussed

**1. The post-launch loop — first pass written 13 October 2026. Discussion still open.**

These were the open questions. The routine that answers them follows below, recorded so nothing is lost; it has not yet been pressure-tested with questions and may change.

The Measurement section lists the instruments to install and what to watch, but **we have never worked through the loop as a workflow.** Written down is *what to measure*; not written down is *how the feedback actually re-enters your pipeline*. Specifically still open:

- How you read Search Console each month and turn it into a decision, not just a number
- How you choose which existing pages to improve versus which new pages to add
- How you verify the SEO work actually worked — what counts as evidence, and over what timescale
- How real query data feeds back into the research step, replacing the AI-guessed candidate list with measured reality
- When to prune or consolidate pages, and how to tell a page is dragging the domain down
- What the AI-visibility check looks like as a repeatable routine rather than a one-off

#### The monthly routine — 20 minutes

Everything comes from **one place**: Google Search Console → Performance → Queries. Not a rank tracker, not a paid tool, not a dashboard that needs building.

Four checks, in this order. The order matters — the first is a gate, and the second is where nearly all the compounding happens.

| # | Check | Where | What it means | What you do |
| --- | --- | --- | --- | --- |
| 1 | **Are the pages indexed?** | Pages report | A page not indexed cannot rank, so nothing else on this list matters. "Crawled — currently not indexed" usually means Google found too little distinct value — but that is a diagnosis to confirm, not a verdict to act on blind. | **Review them first**, then fix. Diagnose why each page failed — thin content, duplication, canonical, rendering — and delete only if the review concludes that. Do not move down this list until indexing is near-total. |
| 2 | **The 8–20 list** | Queries, filter position 8–20, sort by impressions | Searches where Google already considers you relevant and you are just off page one. | Take the top 3. For each: open your page, open the three results beating you, add the one thing they have that you do not. |
| 3 | **High impressions, low CTR** | Queries, sort impressions desc, read the CTR column | You are being shown and not clicked. This is a **title problem, not a ranking problem**. | Rewrite the title to match what the searcher actually wants. Ten minutes. |
| 4 | **Queries you never planned for** | Queries, anything absent from `lib/routes.ts` | Google telling you a page should exist that you have not built. | Add the registry row, build the page. |

Then, last: **what dropped.** Pages whose average position fell materially against last month. Usually a competitor improved or a core update landed. Look, understand, and do not thrash — reacting inside two weeks is reacting to noise.

#### Why check 2 is the whole game

Improving a page already sitting at position 8–20 is several times cheaper than ranking a new page from nothing. You have already cleared the hard parts — indexed, considered relevant, competing — and you are closing a gap rather than starting from zero. If only one check ever gets done, it is this one.

This is also the point at which guessing stops. Before launch, the keyword list was an AI's plausible invention verified against autocomplete. From here it is measured: real people, real queries, real positions. The research step's candidate list gets replaced by Search Console's actual list, and every month that list gets better.

#### The decision rule

| What you see | What you do |
| --- | --- |
| Not indexed | Fix or delete the page |
| Position 8–20 | Improve that page |
| Impressions high, CTR low | Rewrite the title |
| Query you did not plan | Add a new page |
| Position dropped | Look, do not thrash |

#### What not to do

Checking rankings daily. Acting on less than two weeks of data. Chasing position as a number rather than as traffic that converts. Adding pages faster than you can make each one genuinely unique — that is the thin-content trap, and it undoes the rest.

#### Timing, and the honest expectation

**Add the Search Console property before launch**, and verify it before launch. Collection starts when the property is added rather than at verification, so adding it early is what preserves the baseline; verification is what gives you access to it.

Then wait **4 to 6 weeks** before the data means anything. Checking at week one tells you nothing and only produces anxiety. The loop switches on around week six.

And the correction worth keeping: **you will not rank first for most searches related to your product.** Nobody does, including the incumbents. What is achievable is owning a large number of specific searches, and this loop is the grind that gets there — a few pages improved every month, compounding.

#### Automation — later, not now

The Search Console API is free and could pull all four checks into one page on a schedule. That is build item 3. It is not worth writing until a site has traffic worth reading, and the manual version is twenty minutes a month.

#### The three gaps — all answered 14 October 2026

**1. How long to wait before judging an improved page — closed.**

There are **two waits**, and missing the first is what makes people conclude wrongly.

- **Wait for the recrawl before crediting your edit.** Search Console → URL Inspection shows the last crawl date; until that date falls after your edit, Google has not re-read the page, so **your change** cannot be what moved it. Corrected 22 October 2026: that is not the same as saying nothing can move. Positions shift from competitors' changes, algorithm updates, a different query mix and personalization whatever you do, and a crawl is not proof the new version has been fully processed. The recrawl date tells you when your edit became **eligible** to matter — not that a movement after it belongs to you.
- **Then wait about four weeks** and compare **average position** for the 28 days after against the 28 days before the edit.

Reading it, corrected 22 October 2026: **up 3 or more places is a signal that the change helped — not proof that it did.** Average position moves on its own, from competitors' edits, algorithm updates, seasonality and a shifting query mix, so a 3-place gain means "keep this change and move on", not "this edit caused this". Flat after eight weeks means the page was probably not the bottleneck, and the usual remaining explanation is authority. Both readings are decision rules for what to do next; neither is a measurement of cause.

**Four weeks is the aim point, not a fixed law — it flexes per site.** It is the sensible default to plan around, but a site performing exceptionally will show movement sooner, and a quiet one will need longer. Once a site has its own track record, judge by *that site's* observed rhythm: if its pages consistently move inside two weeks, read at two; if they are consistently slow, wait longer before concluding anything. The default holds until the site's own data earns a different number — which is one more thing worth recording in that site's `SEO-CONTEXT.md`.

**Measure average position — not clicks, not time on page.** Clicks swing too much at low volume to read. Time on page is not in Search Console at all, and belongs to a different tool answering a different question (see the closed decisions below).

**The discipline that makes this work: one change per page at a time.** Rewrite the title *or* add the missing section, never both. Change two things and a movement tells you nothing about which one caused it.

**Tooling: none.** Search Console does all of this, free. Nothing to build or buy.

**2. When a page is past improving — closed.**

**Two honest attempts.** One attempt = one change plus its full wait. No movement after the second → stop. It is no longer an improvement problem, and continuing is sunk-cost spending.

Then one of two actions, both code changes:

- **Merge** — fold the content into its pillar and 301 the old URL, so whatever it had accumulated transfers rather than being discarded.
- **Delete** — when nothing on it is worth keeping.

Three shortcuts that skip the two attempts entirely:

| Signal | Meaning | Action |
| --- | --- | --- |
| Indexed, zero impressions after 6 months | Possibly no demand — or missing data, wrong page scope, or seasonality | Put it in the review queue — never an automatic merge or delete |
| Two of your pages ranking for one query | Possibly cannibalization — or two pages serving two different intents | Compare what each page is for; consolidate only if the intent is genuinely the same |
| "Crawled — currently not indexed" | Google judged it not worth keeping | Make it genuinely unique; delete only after the checks below |

**Corrected 21 October 2026 — these rows are diagnostic triggers, not actions.** The earlier wording turned them into automatic rules, and an automatic rule here deletes pages that should have stayed. A page that is indexed with apparently zero impressions after six months enters a review queue; it does not enter a delete list.

Before acting on any row, check seven things: the collection dates of the data; whether the URL you are judging is the canonical one; which filters the report has applied; whether the figure is genuinely zero or simply **missing** — an unavailable value can be exported as 0, and missing is not the same as nobody searching; seasonality; whether the query is one Search Console surfaces at all; and what the page exists to do. A useful service page can deserve its place with little or no search traffic. A drop or a zero has more than one candidate cause, and none of these signals tells you which cause applies to your page.

**Why this matters more than it looks: a dead page is not neutral, it is a small drag.** Thin pages nobody visits lower how the whole domain is assessed, so pruning them helps the pages that remain. Deletion is a positive action here, not an admission of failure.

**Tooling: none.** Search Console tells you which pages to **look at**; the review decides whether anything happens to them. If a review does end in a merge or a delete, the template's rules already cover the 301.

**3. How AI visibility fits the rhythm — timing closed, measurement still open.**

**Quarterly, not monthly.** Citations churn 40–60% month to month, so a monthly reading is mostly noise, and nothing you could do would act on it that fast anyway. Quarterly shows a trend instead of static.

The routine: a fixed list of 20–40 questions a real buyer would ask, run **by hand** across ChatGPT, Claude, Gemini and Perplexity. Record three things — were you mentioned, were you cited with a link, who was recommended instead. About 30 minutes a quarter.

**Why it needs no separate workstream:** the actions that improve AI visibility are the same actions as checks 2–4 of the monthly routine, plus third-party presence. The quarterly run is a reality check, not a second loop to maintain.

**What is still open here:** automated measurement. No tool measures AI answer position reliably, and the `ai-visibility` skill that claims to will fabricate the whole table if a careless model runs it. This is the one genuinely unsolved item in the post-launch phase, and it is unsolved industry-wide, not just here.

**Decided 14 October 2026 — gather by hand, let Claude think.**

The obvious move is to automate the collection with Playwright, Selenium or a browser-driving agent. Two reasons not to, and the second is the decisive one:

1. **Those platforms actively block automation.** CAPTCHAs, login walls, account bans. A scraper works for a fortnight, then a layout change or a bot flag breaks it — and it breaks *silently*, so you believe you have data when you do not. That is worse than having none.
2. **The answers are non-deterministic.** Ask the same AI the same question twice and you get two different replies. Automating the clicking does not produce a stable number, it produces one random sample faster. The quarterly cadence is not slow because clicking is slow — it is deliberately infrequent *because the thing being measured is noisy*. Automation would only let you collect noise at speed.

So the split worth having:

| Part | Approach |
| --- | --- |
| **Collecting** the AI answers | By hand, quarterly, \~30 minutes. Do not automate. |
| **Interpreting** them, and the Search Console numbers | Paste them to Claude. No scraping, no tool, no fragility. |

The instinct to automate was right about the *thinking* and wrong about the *clicking*. Interpretation is the expensive part, and it is already automated the moment you paste the data in.

**4. A multi-site monitoring dashboard — agreed in principle, deliberately deferred.**

At one site the monthly routine is twenty minutes and a tool would be absurd. The trigger to build is when the ritual genuinely hurts — roughly **five to ten live sites**, where twenty minutes times many sites becomes hours of repetitive screen-reading.

What it would be, precisely: not intelligence and not a new SEO brain, but a scheduled job pulling every site's numbers from the free Search Console API into one screen, flagging what needs attention (red for a page that dropped, yellow for one stuck just off page one). The judgment stays human; the tool only saves opening many tabs.

Two things it would **not** change: the per-site success rule (a human decision, re-read every few months as a site matures) and the four checks themselves (identical across every site).

Revisit once the number of live sites and the real time cost are known. Build it when the saving is demonstrable, not before.

### Closed decisions — do not re-open

Each row below was discussed and settled. The reasoning is recorded so it does not get re-argued from scratch, by you or by an AI reading this later.

| Considered | Decision | Why |
| --- | --- | --- |
| An SEO platform with rooms and personas | **No** | SEO has no perspective problem. The answers are known and the constraints objective; what is needed is execution, which the installed skills already do. |
| A keyword research tool | **No** | Search Console plus Google's own autocomplete and "People also ask" cover the real work, free. Long-tail volume estimates are unreliable in every tool, so you would be paying for numbers you should not trust. |
| A content generation platform | **No** | Claude Code against the repo already writes the page, schema and internal links with the repo as context. A wrapper adds an interface and removes the context. |
| A rank tracker | **No** | Daily positions are noise at any timescale under two weeks, and Search Console's average position is the figure to act on for your own pages. Not worthless, though: a tracker is the only way to see competitors' positions, so buy a month of one when that is the actual question. |
| Heatmaps, session recording, behaviour analytics **as SEO work** | **No — it is not SEO at all** | Google never sees your heatmaps. Behaviour data improves conversion (CRO), not rankings. They are two different problems with two different loops, and building one system for both produces something that answers neither. |
| Building behaviour analytics ourselves | **No — buy it** | Microsoft Clarity is free and does heatmaps plus session recordings; PostHog covers funnels and events. Building session-recording infrastructure is months spent rebuilding a commodity. |
| Per-site monitoring systems for different audience types | **No** | The four checks are identical for every site. Only the definition of a win changes — premium low-volume sorts check 2 by commercial intent, volume sites sort by impressions. That is one line per site, a judgment, not a system. |
| A tool to tell you when to stop analysing | **No — permanently, at any scale** | This is a discipline problem, not a volume problem, and a tool is the very thing that tempts you to keep going. More dashboards and flags make over-analysis *easier*, not harder. The restraint has to live in you. The only item here that stays tool-free no matter how many sites you run. |
| Behaviour-analytics plumbing inside the template | **No — optional, added per site** | Decided 14 October 2026: not in the template. Behaviour data improves conversion, not ranking, so it does not belong in the SEO rhythm at all. Added per site, late, only when a page has real traffic and a real conversion question — a short job at that point for the integration code itself, so there is nothing to pre-build — though the privacy and consent work around it depends on the product, the data and the market, and is not part of that estimate. Microsoft Clarity, free with no limits. Full reasoning in the section below. |

**The pattern worth remembering, because it answered nearly every build question in this document:** most of what feels like it needs building already exists for free, and the thing you would eventually build is a thin convenience layer on top of it, justified by volume alone.

### One context doc per site — decided 14 October 2026

This looks like the per-site monitoring idea but is a different thing, and the distinction matters because the table above says no to one and this says yes to the other:

- **No per-site monitoring system.** That row stands. A system would *read* data, and the four checks are identical for every site, so there is nothing to build.
- **Yes to a small per-site context document.** A doc *remembers judgment*, which is the part that genuinely differs per site and which no system can hold.

**What it is:** one markdown file at the project root, `SEO-CONTEXT.md`, holding exactly what cannot be derived from data:

- Who the audience is, in a sentence
- **What counts as a win here** — the one line from the different-audiences decision. Fifty qualified B2B visitors, or raw traffic, or signups. This is the field that makes a premium site and a volume site behave differently without needing different machinery
- The target queries this site exists to own
- A running log: what was tried, when, what the position did afterwards, what was concluded

**Why a doc rather than a database or a dashboard: Claude Code reads it.** The next session on that site already knows the audience, the goals and the history instead of asking again. Same principle as the template's rules file — the context travels with the project rather than living in your head or in a chat that ends.

To wire it in, add one line to the template's `CLAUDE.md`: *"Read `SEO-CONTEXT.md` before any SEO or content work on this project."*

This also closes the "but the rules should change as the site matures" worry. The win definition is a line in a file you edit whenever your judgment changes — not a threshold a system enforces and not something to re-derive from scratch each time.

### Behaviour analytics — optional, decided 14 October 2026

**Decision: not in the template. Added per site, late, and only when a real question exists.**

First, what it actually is, because the name is opaque. There are two different kinds of data about a site:

- **Search Console** — did Google show us, did anyone click. That is SEO, and it is the whole of this document.
- **Behaviour analytics** — once a visitor is already *on* the page, what do they do. Where they scroll, where they lose interest, where they abandon. Heatmaps and session recordings.

The second does **not** affect ranking — Google never sees your heatmaps. It improves *conversion*: making a page more convincing to someone already there. A different problem with a different loop, deliberately kept out of the SEO rhythm so neither gets muddled.

"Plumbing" meant only the setup code — the tracking snippet plus cookie consent. That part is generic across sites; what you measure with it is per-site.

**The tool: Microsoft Clarity.**

| Question | Answer |
| --- | --- |
| Cost | Free forever, with no traffic or session limits, per Microsoft's own terms. No paid tier to be upsold into and no spend to monitor. |
| Build our own instead? | **No.** Session recording means capturing every DOM mutation, storing it, and writing a player to replay it — months spent rebuilding a commodity, plus holding visitors' screen contents, which is a privacy liability not worth owning. The clearest buy-don't-build on this entire list. |
| Alternative considered | **PostHog** — free to 1M events and 5,000 session recordings a month, then usage billing. It does funnels and event tracking, which Clarity does not. But it answers a different question: PostHog tells you how many who landed signed up, Clarity tells you where people stopped scrolling. Not needed until there are signups to funnel, and its billing is a real thing to watch. |
| Integration effort | About ten minutes — one script tag and a project ID. The only real work is cookie consent for EU/UK traffic, which must gate the script until the visitor agrees. That part is legal rather than technical, and is the piece genuinely worth templating if the time comes. |

**Scoping it to a few pages: yes — and only one of the two options actually scopes anything.** Include the snippet only on the routes you care about: in this template the script sits in a layout, so a route-segment layout covers just that section. **Corrected 21 October 2026 — the second option offered here before was wrong.** "Collect everywhere and filter by URL in Clarity's dashboard" changes what you look at, not what you gather: collection is unchanged, and so is the consent surface. The two were presented as a free choice and they are not equivalent. If the intent is to collect less, it has to happen in the snippet. Put it on the two or three pages where money happens. Scoping also does not by itself settle your consent obligations or clear you legally — Clarity's contract terms remain an open item, listed with the other open questions.

**The trigger to add it — and it is not "the site is live".** House rule: a heatmap needs roughly **100 or more sessions on a page** before it shows anything but noise; install it on a page with ten visitors and you are studying three people. Labelled honestly as of 21 October 2026, that figure is **our own readability heuristic, not an established adequacy threshold** — it makes no claim of statistical sufficiency and nothing published backs it as one. The real trigger is the sentence: *this page gets traffic and I do not know why people are not converting.* Until that is true, there is nothing for the tool to tell you.

**Why it stays out of the template:** every new project would otherwise carry tracking code and a consent banner it may never use, and an unused snippet is both clutter and a privacy surface for no benefit. Since it is a ten-minute addition at the moment of need, pre-building it buys nothing.

### Parked — separate track, deliberately not folded in here

**App store SEO (ASO), for any product that is a mobile app.** It shares nothing with web SEO but the word. The stores do not crawl the web; there are no links and no sitemaps. Ranking runs on install rate, retention, ratings and reviews, and the keywords in the app's title and subtitle. None of the machinery in this document applies.

But an app still needs a website. The landing page is what ranks in Google, and a large share of discovery starts with a web search rather than browsing a store. So an app product needs **both** — everything in this document for the web presence, plus ASO as its own discipline.

Status as of 14 October 2026: no longer just parked. The mental model and the whole **"before"** half are now worked out and recorded in the section below. The install-decision deep dive waits for a real app; the **"after"** half is the next discussion.

## App Store Optimization (ASO) — App Store and Play Store

Opened 14 October 2026. Both platforms, no specific app yet, so this is the general playbook — the same approach taken with the web template.

### The mental model — ASO is not SEO with different words

One fact drives every difference: **there are no links, and no open web to crawl.**

On the web, Google reads your pages, follows links between sites, and ranks you partly on who else vouches for you. An app store is a single closed catalogue owned by Apple or Google. Nothing links to anything, so the store has no outside authority signal to read — there is no outside. It ranks on two things only:

1. Does your listing match what the person typed
2. Once people find you, do they install it, keep it, and rate it well

**The second is the real shift.** On the web, what a visitor does after clicking barely touches ranking — which is exactly why behaviour analytics was ruled out of the SEO loop above. In an app store, behaviour *is* most of the ranking. Install rate, retention and ratings are the algorithm, not a side effect of it.

### Gate and engine — the framing to keep

The two halves are not independent:

- **The before is the gate.** It makes you eligible and gets you tapped.
- **The after is the engine.** It decides how high you climb.

The engine cannot do anything until the gate lets people in, and the gate's biggest lever — install rate — is itself a number the engine reads. Neither works alone.

**Recorded deliberately:** a framing that came up mid-discussion — that the before is useless and the after does everything — is wrong, and was corrected. It is written here so it does not get re-adopted later.

### Where the type of app changes things

Not a technicality. It changes which half carries the weight. A utility people search for by name ("PDF scanner") is close to pure keyword matching. A game nobody searches for by name lives on browse placement and editorial featuring. What follows is the general version; per-app differences get recorded per app, the same pattern as `SEO-CONTEXT.md` on the web side.

### The before, half one — keywords (shallow, essentially solved)

Close enough to web keyword work that there is little new to crack. The store only shows you for words actually present in your metadata: if "PDF scanner" is not in there, no amount of good retention makes you appear for it — you are not in the race at all.

Verified field limits:

| Field | Apple App Store | Google Play |
| --- | --- | --- |
| Name / title | 30 characters | 30 characters |
| Subtitle | 30 characters | — (short description, 80 characters) |
| Keyword field | 100 characters per Apple's search guidance, 100 bytes per App Store Connect — the two sources conflict; comma-separated, no space after a comma (spaces inside a phrase are allowed) | **none** — Play indexes the descriptions instead |
| Promotional text | 170 characters | — |
| Full description | — | 4,000 characters |

**The structural difference worth knowing:** Apple has a hidden keyword field; Google does not, and reads your descriptions instead. So on Apple, keywords go in a field nobody ever sees; on Play they have to be written naturally into text real people read.

Two placement rules:

- **Do not repeat a word across fields.** If it is in the title, do not spend keyword-field characters on it — the store already counts it. With only 100 characters on Apple, repetition is pure waste.
- **Do not use a competitor's brand name.** Both stores reject it.

That is close to the whole of it — placement discipline, not strategy. No deep dive needed here.

#### How to actually generate the keywords — concluded 14 October 2026

**The division of labour, in one line: AI expands, data decides, you sort.** Exactly the split landed on for web keywords.

- **AI is genuinely good at expansion.** Give it the app in a sentence and it produces a large candidate list in seconds — synonyms, phrasings, problem-shaped searches. That part is a prompt, nothing more.
- **AI cannot know the real numbers, and this is the trap.** It does not know which of those phrases people actually search, how often, or how hard they are to rank for. Asked anyway, it will *guess and sound confident* — the same fabrication failure as the `ai-visibility` skill on the web side. Same wall, same discipline: never let a model supply a number it cannot have.
- **Real volume data** comes from a proper ASO data source, or from the stores' own hints — App Store search autocomplete, and Apple Search Ads' keyword tool, which is the commonly used free source of genuine popularity signal and needs only an Apple Search Ads account rather than actual ad spend. *Unverified against Apple's own documentation — confirm when the first real app exists.* Google Play has no equivalent keyword volume tool, which is one more reason Play keywords are written into natural description text rather than optimised numerically.

**No template or system needed.** This is a repeatable prompt plus a data lookup — a small routine, not a tool. The prompt below is the whole of it.

**The prompt.** Fill the bracketed slots and paste. It is built to resist the fabrication trap, to produce metadata that already respects the field limits, and to end by stating its own blind spots.

```text
You are helping me build an App Store and Google Play keyword candidate
list for ASO.

MY APP
- What it does, in one sentence: [...]
- The single job a user hires it for: [...]
- Platforms: [iOS / Android / both]
- Category I expect to file under: [...]
- Who it is for: [...]
- Three apps someone might use instead: [...]
  (for your positioning context only - these names must NOT appear
  anywhere in your output)
- Languages or markets I am considering: [...]

TASK 1 - CANDIDATE PHRASES
Give me candidate search phrases grouped by how the person is searching.
10-20 phrases per group:

1. Category terms - what the app IS ("document scanner")
2. Job / outcome terms - what they want done ("scan to pdf")
3. Problem phrasing - the pain in their own words, with no product
   vocabulary at all ("photo to pdf for email")
4. Feature terms - specific capabilities ("batch scan", "ocr")
5. Audience / context terms - who or when ("scanner for students",
   "receipt scanner for taxes")
6. Misspellings and shorthand people really type
7. Long-tail combinations of 3 or more words

RULES - FOLLOW STRICTLY
- Do NOT estimate search volume, popularity, difficulty or competition.
  You do not have that data. If you feel the urge to rank by volume,
  stop and give me the list unranked instead.
- Do NOT describe any phrase as "low competition" or "easy to rank for",
  including the 3+ word phrases in group 7. That claim needs store,
  market, query and date evidence that neither of us has here.
- Label every phrase with your SUBJECTIVE JUDGEMENT of whether a real
  person types it in exactly that form: High / Medium / Guess. These are
  judgements about plausible wording - they are NOT observed search
  frequency and NOT calibrated probabilities. Be honest: "Guess" is
  useful to me, a false "High" is not.
- No competitor brand names and no trademarks. This is my house rule for
  store metadata. (The platform rules behind it are narrower: Apple
  restricts competing app names in keywords and other-app references in
  subtitles; Google bars infringing or confusing use and recognises
  permissions. Ad targeting and permitted compatibility marketing are
  separate contexts. I am choosing the stricter line on purpose.)
- Prefer phrases people type over phrases marketers write.
- Keep phrases under 5 words unless they are genuinely searched longer.
- Your confidence labels and your own "what I do not know" list are
  themselves incomplete - you cannot report a blind spot you do not
  know you have. I will treat both as a starting point, not a guarantee.

TASK 2 - DRAFT METADATA
Using only phrases from Task 1, draft:

Apple:
- Title (max 30 characters)
- Subtitle (max 30 characters)
- Keyword field. Apple's search guidance says max 100 CHARACTERS and
  App Store Connect's platform information says max 100 BYTES; those
  two conflict and I have not resolved which the validator enforces.
  So: stay a few units short of 100, comma-separated, NO space after a
  comma (spaces WITHIN a multi-word phrase are allowed), and NO word
  that already appears in the title or subtitle. Do not spend keyword
  characters on my category name or my company name.

Google Play:
- Title (max 30 characters)
- Short description (max 80 characters)
- Five long-description sentences that each read naturally to a human
  while carrying a target phrase

Print BOTH the character count and the UTF-8 byte count next to every
field so I can check each against whichever limit turns out to apply.

TASK 3 - WHAT YOU DO NOT KNOW
- List the 10 phrases I should check real volume data for first, and why
  those 10.
- State plainly what you could not determine without real data.
```

**One real demand signal for Apple, added 22 October 2026: Apple Search Ads shows a keyword popularity score from 1 to 5.** Creating a Search Ads account is free and you do not have to run a campaign to see keyword suggestions, each carrying a five-point popularity indicator drawn from Apple's own search data. It is coarse — five buckets rather than volumes, reflecting Search Ads' data rather than organic ranking difficulty — but it is **first-party**, and it is the closest thing to real demand data you can get before you have installs. Use it to sort the ten-phrase validation queue: a phrase the prompt labelled "High" that Apple scores 1 is a phrase to drop. Google Play has no equivalent; there, Keyword Planner's web volumes are a weak proxy and the autocomplete check remains the method.

**Why it is shaped this way:** the explicit ban on volume estimates is the single most important line, because that is where a model will otherwise quietly invent numbers you then build a listing on. The High/Medium/Guess labels turn the model's uncertainty into something sortable instead of hiding it. The printed character counts stop the usual failure of drafts that overrun the field limits. And Task 3 makes the model mark its own boundary, which is where your data lookup then starts.

### The before, half two — the install decision (real depth, deliberately deferred)

This is where the big players actually compete. Someone sees the icon, the screenshots and the title; whether they tap install is the single biggest before-factor — **and** a low install rate is one of the numbers that buries you. So screenshots are not decoration, they are a ranking input.

What is known now:

- The top apps do not show plain screens. They show the screen with a **one-line caption** on it saying what the app does for you.
- **The first two screenshots do almost all the work**, because that is all most people see before deciding.

#### The icon — its own factor, concluded 14 October 2026

Recorded as its own line because it had been folded into "the install decision" and never given weight. It deserves naming separately.

**Why it punches above its size: it is the most-seen thing you own.** It appears in search results *before* anyone opens your listing, sitting in a row beside every rival. So it does ranking work indirectly — a weak icon means fewer taps, fewer taps means a lower install rate, and install rate feeds the engine.

Concluded now, without needing an app:

- **It competes in a row, so it must stand out *next to others*, not in isolation.** The standard design mistake is judging the icon alone on a white canvas. The real test is how it looks in a live search result beside five competitors.
- **Simple beats detailed.** At the size it actually renders, fine detail turns to mush. One bold shape or symbol, never a small scene.
- **No text inside the icon.** The app name already sits right beside it; text inside a small square is pure clutter.
- **It is one of the three things the official A/B test covers** — icon, screenshots, previews — so the winning icon comes from testing, not from taste.

**Status: principles concluded; the actual icon needs the A/B test.** Same trigger as the screenshots — a real app with a live listing.

#### Category and tags — concluded 14 October 2026

Verified against both stores' own documentation:

|  | Apple App Store | Google Play |
| --- | --- | --- |
| How many | **Two** — one primary, one secondary | **One category, plus up to five tags** |
| What drives discovery | The **primary**. It governs browse placement and search filtering, and determines which tab you appear on (Apps or Games) | Categories and tags together help people search and discover |
| Extra | Games may pick up to two Games subcategories, which have their own subcategory charts | Tags should be only those most strongly tied to the app |

**Why it is a real before-factor and not paperwork.** Category ranking is a **separate leaderboard from search**. Browse traffic — people scrolling a category's top list rather than searching for anything — is a second door into your app, and your category decides whether that door is open at all.

**The lever:** the same app can be top ten in a narrow honest category and invisible in a crowded one, because the installs needed to chart differ enormously between categories.

**The rule: pick the most honest category where you could realistically chart — not the most prestigious, and not the most obvious.**

**No, you cannot select every category, and trying is explicitly warned against.** Apple caps you at two; Google at one plus five tags. More to the point, Google's own documentation says to choose only tags that a user unfamiliar with the app would immediately see as fitting, and specifically **not** to add tags for features the app only loosely offers, or for neighbouring genres meant to attract different players. Their own example: a multiplayer vintage car racing game should not tag "Stunt driving", "Motorcycle racing" or "Truck racing". The spray-everything approach is named and ruled out by the platform itself.

**And why it would backfire even if it were allowed — this is the part worth remembering.** A wrong category or tag brings the *wrong audience*: people who installed expecting something else. They churn fast and rate badly, and retention plus ratings are precisely what the after-engine runs on. **Gaming the gate poisons the engine.** It is the same shape as the one-star trap in rating prompts — a cheap win at the front costs you the thing that actually drives ranking.

Two practical notes:

- **Apple's secondary category is nearly free upside** — a second surface to be browsed in, at no extra cost. Fill it deliberately rather than leaving it blank.
- **Treat the choice as near-permanent.** Google advises changing tags only after significant changes to the app's content or functionality, and changing category resets the ranking history built there.

**Status: concluded as a rule, with nothing to test.** You do not A/B test a category — you choose once and live with it. The only open per-app piece is which category your actual app fits, and that goes in that app's own context doc.

#### Localization — concluded 14 October 2026, with one grey-hat caveat

The most overlooked lever in the before-half, and the only item in it with a genuine decision inside.

**What it is:** offering your listing — name, subtitle, keywords, screenshots, description — in other languages.

**The structural fact that makes it a ranking move rather than a translation task:** on Apple, every locale you add brings **its own keyword field**, so the keyword space itself grows with each locale. Google Play has no keyword field, so none of this applies there — Play localization is genuinely about the descriptions reading naturally in each language.

There are **two separate paths**, and which one applies depends entirely on the app.

##### Path one — the app is English-only and global ("cross-localization")

The mechanism: each App Store territory indexes keywords from more than one locale. For the **US storefront**, the primary is English (US), and keywords also index from **Spanish (Mexico), Russian, Chinese (Simplified), Arabic, French, Portuguese (Brazil), Chinese (Traditional), Vietnamese and Korean**.

So those secondary locales' keyword fields can be filled with **additional English terms**, and English-speaking US users can match on them without you shipping a single translated screen. Two qualifications from the 21 October 2026 review. The fields do **not** merge into one larger pool: each locale's field is matched on its own, so what you gain is more places to be found, not a bigger single character budget — the earlier "multiplying your effective 100 characters" overstated it. And this is Apple's current indexing arrangement for that storefront as practitioners report it, not a published guarantee; verify it for your own storefront and locales when you file, and do not build a metadata plan that only works if the pooling story holds.

**Four caveats that limit the hack, and they matter:**

| Caveat | Consequence |
| --- | --- |
| **Keywords do not combine across locales** | A word in English (US) and another in Spanish (Mexico) will not rank together as a two-word phrase. To target a phrase, the words must sit in the *same* locale — so some deliberate repetition across locales is unavoidable. This is the big limitation, and it caps how much the extra space is actually worth. |
| **Apple disapproves of the practice** | This is not an Apple feature, it is an exploited behaviour. No public rejections are known, but it is grey-hat rather than sanctioned. Treat it as an optimisation that could disappear, never as a foundation. |
| **Not documented by Apple** | The indexing map above comes from ASO tooling that tested fake keywords across storefronts — not from Apple. It can change without notice, so re-verify before relying on it. |
| **Locales are partly interchangeable** | Where a locale is not enabled, a related one may index in its place — French (France) indexing in Canada until French (Canada) is enabled, for instance. Canada and the US are the exceptions; elsewhere apps generally index English (UK) or English (US) depending on which is primary. |

**The rule for this path:** keep the **title and subtitle** genuinely in the local language for real local users, and confine the mixed-language trick to the **keyword field**, which no user ever sees.

##### Path two — the app genuinely serves multiple regions

**How it actually works, and this corrects a misunderstanding worth recording: each language gets its own completely separate listing.** A Spanish user sees a wholly Spanish listing; an English user sees a wholly English one. They never see each other's — the store serves each person only their own language version.

**So there is no "mixing" of languages within one listing, and no clumsiness arising from it.** A concern was raised during discussion that a Spanish screenshot might confuse an English visitor; in the normal case that cannot happen, because the listings are walled off from one another by the store.

**But the instinct behind that concern pointed straight at a real trap — fallback.** The worry becomes real in exactly two cases:

1. A market where people speak several languages
2. A language you have **not** built a version for, where the store falls back to showing someone a different language

In both, a user can land on a screenshot in a language that is not theirs and conclude the app is not for them.

**The rule that falls out: do not half-localize.** If you commit to a language, do the screenshots too, so nobody in that locale ever meets a stray foreign word. Qualified 22 October 2026: **a half-done localization can be worse than none** — it creates exactly the mismatch described above, and a user who sees a translated listing and an untranslated app feels misled. But it is not automatically worse: a translated listing over an English app still wins installs in several markets, and some teams ship it deliberately as a test. Treat "all or nothing" as our standard because it protects the experience, not as a measured finding.

**The three real decisions in this path:**

1. **How many languages, and which.** Localize where the downloads and the revenue are, not everywhere. A handful of high-value markets beats forty half-done ones — the no-half-localization rule applied to breadth.
2. **Translate versus adapt — the sharp one.** Translating converts words. Adapting means researching what people in *that market* actually type, because search behaviour differs by country and not merely by language. A literal translation can miss the real local search terms entirely. Adapting costs more effort and is where the lever actually pays.
3. **How deep to go.** Text only, or screenshots as well? Localized screenshots lift conversion but multiply production work per market. By the no-half-localization rule: if a market matters enough to enter, it matters enough for screenshots.

##### Status

Mechanism and strategy are concluded for both paths. What still needs a real app: **which markets are worth it** — a revenue question, not a theory question — and **re-verification of the cross-localization indexing map**, which is undocumented and can shift. Worth noting for later: Google Play's store-listing A/B test supports **localized experiments in up to five languages**, so the testing loop extends to localized listings when that time comes.

### The after, item 1 — install rate (conversion rate), concluded 14 October 2026

First of the eight after-factors. **No decision in it — recorded as understanding, not a choice.**

**What it is:** of everyone who saw the listing, the fraction who tapped install. 100 views, 12 installs = 12%.

**Why it is first — it is the hinge.** Install rate is where the before hands off to the after. Everything in the before-half (icon, screenshots, title, category) exists to move this one number. So **install rate is not a lever you pull — it is the scoreboard for the before-half.** There is no separate strategy to decide here; the strategy all lives upstream, in the before-half, which is closed. The one action attached to it is the A/B test, already recorded and already waiting on a real app.

**It is a multiplier, not just a score.** A high install rate earns more visibility → more viewers → who convert at that same rate → still more visibility. It compounds. A poor rate does the reverse: you get shown, people pass, the store quietly shows you less. The web flywheel, but faster and more direct.

**It is relative, not a penalty — the framing to keep.** A low install rate is not a mark-down for doing something wrong. The store constantly compares you against other apps competing for the same slot; if you convert at 12% and a rival at 20%, the rival takes the slot by comparison, not because you were punished. Consequence: there is no fixed bar to clear and no "safe" number. The goal is to **beat whoever you are shown next to**, not to hit an absolute figure — the same you-versus-the-field logic as the web side.

**Measured per traffic source.** Conversion from **search**, **browse** and **direct link** are judged separately. Someone searching your exact app name converts near 100%; a category browser is window-shopping and converts far lower. So do not chase one global number — watch **search conversion** especially, because that is the one tied to the keywords you are trying to rank for.

### The after, item 2 — retention, concluded 15 October 2026

**What it is:** of the people who installed, how many are still using the app after a day, a week, a month — day-1, day-7 and day-30 retention.

**Why it is the heaviest after-signal.** Install rate can be won with good art; anyone can buy a tap with a pretty screenshot. Staying is the only proof the app is actually good, so the stores weight it heavily — and it cannot be faked. No amount of listing craft survives people deleting the app on day two.

**The honest split between documented fact and industry folklore.** Retention as a ranking factor is industry consensus, **not** published by either store. Neither Apple nor Google documents "we rank by day-7 retention." It is inferred, widely believed, and almost certainly true — so treat it exactly like cross-localization: real, undocumented, unverifiable.

**The one exception, and it is the only hard number in the whole of ASO.** Google publishes exact technical-quality thresholds and states that apps exceeding them are "likely to be less discoverable on Google Play":

| Metric | Overall threshold | Per-device threshold |
| --- | --- | --- |
| User-perceived **crash rate** | **1.09%** of daily users | **8%** of users on a single **phone** model · **4%** on a single **watch** model |
| User-perceived **ANR rate** (app not responding) | **0.47%** of daily active users | **8%** of users on a single **phone** model · **5%** on a single **watch** model |
| Excessive partial wake locks | 5% of app sessions, measured across 28 days | A battery metric with its own denominator — sessions, not daily users, and not a crash metric |
| Excessive battery usage, qualifying watch faces | More than 1% of sessions are bad sessions; a bad session exceeds 4.44% battery per hour | Watch-face scope only, and subject to sufficient-usage conditions |

Exceed them and Google steers users on the affected devices toward other titles, and **may show a warning on your store listing** offering alternatives with higher technical quality. Evaluation is over the past 28 days, though Google may act sooner on a spike.

**Why this matters more than most of ASO:** nearly everything else here is relative and opaque — beat the field, no fixed bar, no published number. These are lines you are either under or over, and they **reach into featuring eligibility**, not just ranking. **It also reclassifies crash monitoring: it is not engineering hygiene, it is ASO.** Apple publishes no equivalent threshold, which should not be read as Apple tolerating crashes — only that their line is not public.

Three corrections from the 21 October 2026 review, all of which change how you read the table. **A published threshold is not proof that a specific app is currently demoted** — it states the rule, not your status. **These are not the only hard numbers in ASO**, as this document previously claimed; the character and byte limits, the review-prompt cap and the store experiment mechanics are published too. And the **future memory and DEX visibility effects begin in February 2027** — they must not be described as already in force.

**What actually dominates retention: the first week, and really the first session.** Typical apps lose the large majority of users within days, so day-30 retention is mostly decided by what happened in the first few minutes. That reframes the problem — retention is not mainly about long-term depth, it is about **getting a new user to the thing they came for before they give up.**

And it loops straight back to the gate: users who arrived via a wrong category or a misleading screenshot churn hardest, because they wanted something else. **The category trap reappears here as a number.**

#### What "building retention tracking" actually means

Retention is not a feature you build — it is a question you answer: *are people coming back, and are new users reaching the point of the app before they quit?* To answer it, the app has to record a few moments and send them somewhere you can read. That recording is the entire job. **Two pieces, and only one of them is a build.**

**Piece one — a crash reporter. Installed, not built.** A ready-made library; Firebase Crashlytics is the usual choice and is free. Drop it in, and from then on crashes and freezes on users' phones report back automatically — most of them, not every one: an SDK can miss out-of-memory kills by the OS, some native and watchdog terminations, and anything that happens before it initialises, and you read the rate on a dashboard. Effort: roughly an hour, essentially free. **But — corrected 21 October 2026 — you cannot set it "to Google's thresholds."** An SDK's crash percentage and Play's user-perceived crash rate are not interchangeable numbers: they cover different populations, define an incident differently, identify users differently, and use different denominators and time windows. Treat the SDK as your early-warning system for finding and fixing crashes, and **Play Console's Android vitals as the only place where your standing against the published line is measured.** Configure each against its own definitions; do not copy 1.09% into a Crashlytics alert and believe it means the same thing.

**Piece two — the first-session funnel. This is the small build.** Pick the handful of steps a brand-new user takes to reach the point of the app, and fire one event at each. A recipe app might use: opened the app → searched a recipe → viewed one → saved one. Each step is a single line of code saying "this user reached step three." The events go to a free tool — Firebase or PostHog — which draws the funnel for you. **You are not building a dashboard; you are placing four or five markers on the path a new user walks.**

What it tells you: of the people who just installed, how far did they get toward the thing the app is *for* before they left. If 90% open it and only 10% ever search, the first screen is failing them.

**Scope discipline — instrument two things, not forty.** The crash and ANR rate, because that is the published de-ranking line. And the first-session funnel to the single "aha" moment. Everything else — deep engagement, feature-level usage — waits until there is a real question, exactly as decided for PostHog on the web side. **The same principle runs through both halves of this document: instrument the moment that matters, add depth only when a real question appears.**

#### The decision — when to build it

**Decided: before launch, once the app is built — not at the start of the build.**

This sharpens an earlier "day one" framing, and the sharpening is correct. "Day one" was only ever about not wasting the first cohort of *users*, and the first user arrives at launch. So building the instrumentation late in development achieves exactly the same protection at lower cost — with one real advantage: **by then the app exists, so you know which steps actually matter.** The funnel steps cannot be chosen sensibly before the features they are meant to measure exist.

The ordering that falls out:

1. Build the app.
2. **Before launch**, drop in the crash reporter (generic, needs no thought) and define the first-session funnel from the app's real features.
3. Launch with both already in place, so the first cohort is measured rather than lost.

**What stays open, correctly, per app:** the actual four or five funnel steps. That cannot be decided in theory — a recipe app's steps are not a banking app's. It is deferred-to-the-real-app in the same way as the screenshots and the A/B test, and it belongs in that app's own context doc.

#### A note on reuse: ASO gets no template, by design

The web side produced a reusable code template because the plumbing is identical across every site. ASO does not work that way — the crash reporter is generic and needs no template, and the funnel is inherently app-specific. **So for each new app, the reusable asset is this document, walked through, rather than a folder of code to copy.** That is the honest difference between the two tracks, and it is why no ASO template is planned.

### The after, item 3 — ratings and reviews, concluded 15 October 2026

**What it is:** your star average and the written reviews people leave. Really two numbers — the **average rating** and the **volume**.

**Why it hits twice, and this is the key insight.** Ratings do not only influence ranking, they influence the **gate** as well. Put a 4.7 and a 3.2 side by side in search results and people tap the 4.7 before reading a word. So a poor rating quietly crushes your install rate, which then crushes your ranking. **It is the only factor that attacks both halves at once**, which makes it disproportionately powerful.

**The volume-versus-average tension.** A 5.0 from 11 people is weaker than a 4.6 from 10,000 — both the stores and users trust volume, because a handful of ratings is easy to fluke or to game. So the goal is not high stars, it is *enough* high stars. **Early on, volume is the real problem, not average.**

#### The rating prompt — timing, and one compliance limit

Settled earlier and restated here: use the **native in-app prompt**, which does not kick the user out to the store, and **ask after a success moment — never after friction, an error or a crash.** Prompt indiscriminately and you summon your own one-star reviews, because people mid-frustration are exactly who you do not want rating you.

Three mechanics worth knowing:

- **The prompt is system-controlled, not yours.** You *request* a review; the system decides whether to actually display it. The prompt is a request, not a guarantee, so no single call can be counted on to produce a dialog.
- **There is a frequency cap, and it is on presentations — not on your calls.** Confirmed 21 October 2026. Where the user has not already reviewed this app on this device, the prompt is presented **at most three times in any 365-day period**. Where they have already reviewed it, a further prompt additionally requires a **new version** and **more than 365 days** since that review. Asking is not showing: the system decides whether the dialog appears, so three requests do not buy three dialogs, and nothing here guarantees a rating. Spend those presentations on genuine success moments.
- **Pre-screening is not allowed, and this matters.** The citations, checked 21 October 2026: **App Store Review Guidelines §5.6.1** prohibits custom review prompts; **§3** prohibits manipulated or filtered feedback; and **Google's in-app review guidance explicitly prohibits opinion or predictive pre-questions** around the review card. **So the common "Are you enjoying the app? — yes goes to the store, no goes to a feedback form" pattern is out.** One correction to the earlier wording in this document: that gate sentence is the policy read against that pattern, not a phrase Apple publishes. The prohibitions are real and cited; the paraphrase was mine, and attributing it to Apple as a quotation was wrong. The strategy survives intact, and the distinction is worth holding onto: you may time the prompt by what the user **did** in the app (a success moment), but you may not ask a filtering question first and route unhappy users away. **Timing on behaviour is fine; screening on opinion is not.** Giving unhappy users a separate support channel is legitimate — what is banned is deciding who gets to see the store prompt.

#### Responding to reviews — the decision

Both stores allow public developer replies — Apple through App Store Connect, Google through the Play Console. Three things make it worth doing:

- **On Google Play a reply can prompt the user to update their rating**, and many do. A thoughtful response to a 2-star can genuinely become a 4-star.
- **It signals to other browsers that the developer is present and cares**, which changes how the whole review section reads to someone still deciding.
- **But it is unbounded work.** Reviews never stop arriving, and unlike most of ASO this does not automate — a canned reply reads as canned and backfires.

**Decided: a three-tier priority ladder rather than one blanket policy.**

| Tier | Practice | Commitment |
| --- | --- | --- |
| **1 — must do** | Respond to **negative** reviews during the **early launch stage**, until the review section has carried the app to a reasonable level | Non-negotiable |
| **2 — should do** | Respond to negative reviews in general, once past that early stage | \~80% — important but not absolute. The intensity relaxes after launch; it does not switch off |
| **3 — optional** | Respond to positive reviews | Genuinely optional. Only with spare time, or a quick "thank you" setup. Fine to skip entirely |

**Why the ladder is right and not merely reasonable — this is the reasoning to keep.** It tracks the volume insight exactly. Early on, every review is a large fraction of your total, so one rescued 2-star visibly moves both your average and your install rate. Later, at thousands of ratings, a single review barely nudges the number, and the same effort buys far less. **Effort should be highest when each review carries the most weight, and taper as volume grows.**

**The trigger for dropping from tier 1 to tier 2:** when rating volume is large enough that **no single review visibly moves your average** — often somewhere in the few-hundred-ratings range. The exact figure is per-app; the signal is "one review no longer changes my star display." Record the real number in that app's context doc when it happens.

### The after, item 4 — engagement, concluded 15 October 2026

**Deliberately the shortest entry in this document, because the factor is genuinely thin. Its length here reflects its real weight, not neglect.**

**What it is:** what people actually do inside the app once they are in — how often they open it, how long they stay, how deeply they use it.

**It overlaps heavily with retention — the two are views of the same thing.** Retention asks *did they come back*; engagement asks *while they are here, what do they do*. A user who opens the app daily and does a lot is both highly retained and highly engaged, so most of the retention entry carries straight over.

**The honest assessment: this is the least documented and least actionable factor in the whole list.** Neither store publishes anything about engagement as a ranking input. It is inferred from the fact that engaged apps tend to rank well — but that is correlation, and engaged apps also retain well and rate well, so engagement's own contribution cannot be separated from the rest. **It is entirely possible that engagement does not rank you directly at all, and simply shows up as retention and ratings.**

**The practical conclusion, and this is the useful part: you do not optimise engagement for ASO.** There is no lever here you would pull for ranking that you would not already pull to make a good product. **Engagement is downstream of building something people want — it is an outcome, not a dial.** The ASO move is to build a genuinely useful app and let engagement feed the engine on its own.

**No new build, and no new decision.** The first-session funnel already decided for retention *is* the engagement instrument — the same four or five markers that show whether a new user reached the point of the app also show what people do inside it. Engagement rides entirely on instrumentation already planned.

### The after, item 5 — uninstalls, concluded 15 October 2026

**What it is:** people actively removing the app. Google's Play Console reports uninstall data directly; the ranking effect is inferred rather than documented, the same caveat as retention.

**Why it is not simply retention upside-down.** Retention measures who *stayed*; uninstalls measure who **actively removed you**. Those are different acts — a dormant user forgot about you, an uninstaller made a decision. Deliberate rejection is a stronger negative signal than drift.

**And it is close to irreversible in a way churn is not.** A dormant user is still on the device: reachable, possibly returning. An uninstaller is out of your reach — no push, no icon, no prompt you can send. They *can* reinstall, and a few do, but you have no mechanism to cause it and should never plan on it. **Treat it as the one effectively permanent loss in the system**, which is why it dominates the decisions below.

**What drives uninstalls** beyond simply a poor app: storage pressure, crashes, wrong expectations (the category trap again — people who installed for something else uninstall fastest), and notification fatigue, which is the one real lever and gets its own treatment next.

#### Notification policy — decided, three categories

The temptation: more pushes lift engagement. They genuinely do — and then people uninstall, and the uninstall costs far more than the engagement gained. **Over-notifying is a self-inflicted wound dressed up as growth.**

**Decided: send categories 1 and 2 always; never send category 3.**

| Category | What it is | Policy |
| --- | --- | --- |
| **1 — Operational / duty** | Subscription ending, payment failed, security alert, data about to be deleted. The user has a stake — money, access or data is about to change | **Always send.** These are not about engagement at all, and the "would the user be glad?" test does not even apply. Silence here is not restraint, it is negligence |
| **2 — Earned / service** | Something in the user's own activity happened — a reply, an order shipped, the thing they asked to be told about | **Send freely.** Welcome, because the user wanted to know anyway |
| **3 — Scheduled / re-engagement** | "We miss you", "come back and see what's new" | **Never send.** Serves your chart, not the user. This is the only category the policy forbids |

Category 1 was identified during discussion as a genuine gap in an earlier two-category model — the subscription-expiry case exposed it. The three-way split is the correct map.

**The precise rule, which is regret-proof in both directions: send every notification the user needs or would want; send none that only you want. Volume is not the metric — motive is.**

This matters in both directions. "Fewer notifications is better" is a rule of thumb **within category 3 only**, and must never become a reason to under-send categories 1 and 2. **Under-notifying on duty is its own mistake** — sitting on a subscription-lapse warning out of misplaced caution costs you a paying customer. A duty notification earns its place by duty, a service notification by the user's interest, and a re-engagement notification earns nothing, so it goes.

**One precondition, added 22 October 2026: none of this happens without the user's permission.** A notification is only delivered if the user has granted permission — iOS has always required an explicit opt-in, Android has required one since Android 13 — and they can revoke it, or mute your channel, whenever they like. So "always send a duty notification" is a rule about **motive, not a capability**: with permission never granted or since withdrawn, there is no send at all. Three consequences for the build. **Ask for permission at a moment when its value is obvious** — right after the user does the thing the notification would be about, never on first launch, where it gets refused by reflex. **Never let a duty message exist only as a push:** a subscription-lapse warning must also be visible inside the app, and by email where you have one, because the push may never arrive. And **check the platform's own categories before assuming a duty message breaks through** — time-sensitive and critical alerts on iOS carry their own entitlements and rules, and Focus modes and Android channel settings sit between you and the user regardless.

**Why a flat rule rather than case-by-case judgment:** judgment drifts under pressure. The month the numbers dip is exactly when "just one re-engagement push" feels justified, and exactly when it is most dangerous. A rule you do not renegotiate protects you from your own weak moments, and costs less willpower than deciding afresh each time. Any future exception must be **proved**, never assumed.

#### The notification trigger engine

**The fundamental: a good notification is triggered by the user's state, not by the clock.** State means where the user is in their own journey — what they have done, what they are in the middle of, what they are missing out on. The clock means "it has been three days, poke them." Every durable notification strategy is that single idea applied.

**It needs no second system.** The first-session funnel instrumentation already planned for retention **is** this engine's data source — the same events that reveal whether a new user reached the point of the app also reveal that this user loves feature A and has never touched feature B. One instrumentation layer, two uses.

**Build the triggers after launch, not before.** Before launch you do not know which user states are worth acting on, so you would be guessing — and triggers built on guesses are scheduled notifications with extra steps. After launch the logged data shows real patterns ("users who do X on day one stick; users who skip Y leave"), and only then is a nudge toward X grounded in evidence. **The data comes first, the triggers come second.**

**The cliff edge to watch, because it hides inside an idea that sounds safe:** "you haven't used this feature — want to try it?" can be genuinely helpful, *or* it can be "we miss you" in a costume. The test is whether the user would benefit from the reminder, or whether their engagement merely dipped. **Trigger on evidence that the user wants the thing, never on evidence that your numbers want them.** Same data, two motives — and the motive is what the user feels.

**Per-app variation fits cleanly.** Category, market and user psychology change *which states matter* and *what counts as value*, but they do not change the fundamental. A meditation app and a trading app care about entirely different user states, yet both follow "notify on the user's state, in the user's interest." The principle is universal; the specific triggers come from each app's own data and belong in its context doc.

#### The underlying principle: you cannot force positives, only remove negatives

**You cannot push users into positive signals. You can only remove the reasons they would give negative ones.** Every item in the after-half has turned out to be a version of this: you do not *make* people rate you well, you ask only the happy ones; you do not *make* people stay, you get them to value quickly and then stop annoying them. **The positive signals are what remains once you have stopped manufacturing the negative ones.**

The corollary, and the honest ceiling: **100% is impossible, and chasing it is itself a trap.** The effort to squeeze the last unhappy user usually annoys the happy majority. Good enough, done honestly, compounds; perfect, forced, backfires.

### The law — the gate is cheap, the engine collects

Named deliberately, because it has now predicted three separate traps and will predict more. *(The name is provisional — rename it if a better one fits.)*

> **In an app store, every tactic that borrows attention it has not earned gets repaid out of the engine. The gate is cheap to game; the engine is where you pay.**

| The cheap front-end win | What it poisons |
| --- | --- |
| A wrong category or loose tags, to be shown to more people | They churn and rate badly |
| Prompting everyone for a rating | You harvest your own one-star reviews |
| More notifications, to lift engagement | They uninstall you — the one effectively permanent loss |

**Why it holds structurally rather than by coincidence:** the gate is judged by strangers who have not used the app, so it can be moved with presentation alone. The engine is judged by people who have used it, so it cannot. Any gain taken at the gate that the product does not actually deserve arrives at the engine as a disappointed user — and the engine weighs more.

**How to use it:** whenever a tactic promises more visibility, more installs or more engagement, ask what it will look like **to the engine**. If the answer is "a user who expected something else," the tactic is a loan, not a gain.

### The after, item 6 — update cadence, concluded 15 October 2026

No decision needed: the conclusion is a rule that follows from what each kind of release actually costs.

**What it is:** how regularly you ship updates to the app.

**The positive side, on two levels:**

- **To the user reading your listing.** Both stores show "last updated" and the version history. Someone choosing between two apps sees one updated last week and one untouched for two years, and the fresh one feels safer, supported, less likely to break. **So it feeds the gate through perceived trust, and therefore install rate.**
- **To the store.** A regularly updated app is widely believed to be treated as healthier — inferred, not published, the same caveat as retention.

**The negative side, and it is real: pushing updates with no meaningful change frustrates users.** A changelog reading "bug fixes and improvements" for the tenth consecutive month fools nobody; each update costs the user a download and an interruption; and **every release is a fresh chance to introduce a crash**, which hits the one hard published threshold in this document. Releases are not free.

This is **the gate is cheap, the engine collects** in a new costume: an empty version bump borrows the *appearance* of being maintained without the substance, and gets repaid in user irritation and crash risk.

#### Is there a right balance? Yes — but it is a threshold, not a frequency

There is no universal "ship every N weeks" number, and anyone offering one is guessing. **The balance is found by converting the frequency question into a quality question:** ship when the release clears the bar of *a user would notice or benefit from this*. That bar has a definite answer for any given release, where a calendar does not.

From that, three different cadences fall out, because the three kinds of release carry different costs:

| Kind of release | Cadence | Why |
| --- | --- | --- |
| **Bug and crash fixes** | **Ship immediately, never bundled** | Delay is measured against Google's published crash and ANR thresholds. Holding a crash fix back to batch it costs discoverability directly |
| **Features and improvements** | **Bundle until substantial enough to be worth announcing** | Dribbling out trivial changes spends user attention for nothing, and adds crash risk per release with no compensating benefit |
| **Platform responses** | **Ship promptly** | When the OS has a major yearly release, or a store adds a capability, supporting it quickly is a real signal and sometimes a featuring opportunity (item 8). **This is the one legitimate case of updating because of a calendar — but it is the platform's calendar, driven by a genuine external change, not a schedule you invented** |

So the balance is not "how often" at all: **fast on fixes, patient on features, responsive to the platform.** Those three rules together produce the right rhythm without anyone having to choose a number.

**The resulting principle: the cadence should be the natural rhythm of actually improving the app, not a manufactured schedule.** An app genuinely being worked on produces a healthy cadence by itself, which is exactly why there is no decision here. Same shape as engagement — an outcome of building well, not a dial to turn.

**One concrete mechanic that ties cadence to the keyword work:** on Apple, the title, subtitle and keyword field can only be changed by submitting a new version, whereas the promotional text can be updated without one. *Worth confirming in App Store Connect when building.* So keyword revisions ride along with real releases — one more reason the natural release rhythm is sufficient and a fake one buys nothing.

### The after, item 7 — rating-prompt timing: closed inside item 3

Not given its own section deliberately. The native prompt, the ask-after-success rule, the pre-screening ban and the frequency cap are all recorded under **ratings and reviews** above. Nothing further is outstanding; a separate section would only duplicate it.

### The after, item 8 — editorial featuring, researched and concluded 15 October 2026

**The only item in either half that is not an algorithm.** Everything else in this document is machine-judged — keywords matched, rates compared, thresholds crossed. Featuring is **humans at Apple and Google choosing apps to showcase**, which makes it a different mechanism with different rules that cannot be optimised into.

#### The headline: Apple and Google are completely different here

This corrects an earlier framing in this conversation that treated them as the same ("just submit the form"). They are not, and the difference decides what you actually do.

|  | Apple App Store | Google Play |
| --- | --- | --- |
| Is there an open nomination route? | **Yes** — formal, documented, free, open to every developer | **Yes — a public nomination form exists.** Verified 21 October 2026; the earlier "effectively no" was wrong |
| Mechanism | **Featuring Nominations** in App Store Connect | **Featuring Nomination** form (`support.google.com/googleplay/contact/featuring_review`), **Indie Corner** form (`support.google.com/googleplay/contact/indie_corners`), and in-console **Promotional content → Request featuring** for titles meeting the premium-growth thresholds |
| Who can use it | All developers. Apple's own Tech Talk states "Our editors read every submission" and "Whether you're an indie developer or a household name, you have an opportunity to be featured" | Featuring Nomination is an open application with separate app and game branches, lead-time instructions and its own eligibility conditions. **Indie Corner's app branch specifies US-based developers**, plus team-size, rating and launch-age criteria — so it is closed to an India-based app; its game branch differs. Promotional content still needs the premium-growth thresholds: for a **new app** it is listed as **"Not available"**, and for a **new game** featuring requires a publisher with **≥$5M consumer spend** over the previous 12 months |
| Practical verdict | **Do it on every launch and major update.** It is the one part of featuring you control, and it costs almost nothing | **Submit the Featuring Nomination form at launch.** Indie Corner is out on the US-developer rule and promotional content waits for the thresholds, but the main form is open to us. Existence of a form is not eligibility and not a promise of selection |

#### Apple — Featuring Nominations (primary source: Apple)

Announced at WWDC 2024, shipped in App Store Connect November 2024. **Older ASO articles pointing to a web form or a promotions email address are outdated.**

- **Where:** App Store Connect → Apps → your app → sidebar **Featuring → Nominations** → "+" → Create Nomination. Bulk CSV import supports up to 50 nominations per file.
- **Who can submit:** Account Holder, Admin, App Manager or Marketing roles.
- **Three nomination types:** New Content (new content, offers or events), App Enhancements (new features or significant updates), App Launch (launch or pre-order of a new app).
- **Fields:** a memorable name; a detailed description that should state purpose and priority level; a publish date or date range; up to 10 related apps from the same account; platforms; countries and regions; localizations; approved or published In-App Events (iPhone/iPad only, up to 25 event IDs by CSV); **up to 5 supplemental URLs** — documents, art assets, and TestFlight public links; and **"Helpful Details"** for accessibility, inclusivity, priority level, and any unique aspect of the app or team.
- **Timing — Apple's own pages conflict.** The Getting Featured page says a minimum of **two weeks**; the App Store Connect help article says a minimum lead time of **three weeks**; and for wider consideration Apple recommends submitting **up to three months in advance**. **Plan on 6–12 weeks, never later than 3.**
- **Drafts** can be saved. After submission everything is editable except the nomination type and related apps.
- **If selected:** Apple may email Admin, App Manager and Marketing roles requesting promotional assets — answer fast. For select Today-tab placements such as App of the Day, you get a notification in the App Store Connect app plus shareable social assets.

#### Google Play — the gated route (primary source: Google)

- **Mechanism:** Play Console → Grow users → Store presence → **Promotional content** → Create Event, with "Request featuring". Can place content on high-visibility surfaces including the homepage and search results, and includes a full-width "Spotlight" placement at the top of Apps Home.
- **Rules:** submit up to 60 days ahead; approval can take up to four days; **events with featuring requested must be submitted at least 14 days before the start date**; major updates run a fixed 28 days. Quarterly quotas: games get 4 broad-audience featuring requests plus 2 targeted; apps get up to 6 broad plus 2 targeted. **Featuring is still not guaranteed.**
- **The eligibility gate — "Premium growth tools".** An existing title must meet at least one of: ≥1.6M daily MAU over 3 months plus ≥1.6M active installs; ≥2.0M daily MAU plus ≥2.0M installs last month; **≥$40,000/month consumer spend for 3 months**; or ≥$50,000 in the previous month. Top partners get reduced thresholds.
- **The paid/premium discount route exists as well**, and it is narrow: Google's Getting Featured page includes a "Nomination for store support" section, reviewed on "app quality, historical performance, and the depth of the proposed discount." It needs a paid or premium title running a discount — but it sits alongside the two open forms below, not instead of them.
- **Corrected 21 October 2026 — the open forms were found, and calling them folklore was wrong.** Two official Google forms have since been recovered and verified: the **Featuring Nomination** form at `support.google.com/googleplay/contact/featuring_review`, with separate application and game branches, lead-time instructions and stated eligibility conditions; and the **Indie Corner** form at `support.google.com/googleplay/contact/indie_corners`. What the ASO vendors garbled was the detail, not the existence, and this document's blanket "no public route for Play" is withdrawn. The limit that actually bites us sits in Indie Corner's app branch, which **specifies US-based developers** alongside team-size, rating and launch-age criteria — so it is unusable for an India-based app, while the game branch has different criteria. The forms themselves were verified; what happens behind them, and whether we qualify, was not.
- **Indie Corner** exists as a human-curated games showcase, but its current submission rules could not be confirmed from a Google page.

#### What editors actually look for

**Apple (officially published).** "While there's no checklist of requirements," editors weigh: user experience; UI design; innovation ("new technologies that solve a unique problem"); uniqueness; **accessibility**; **localization**; and the product page itself — "compelling screenshots, app previews, and descriptions, as well as **positive ratings and reviews**." Games add gameplay, art, controls, story, replayability, sound, technical performance and value. Editors' Choice apps "exemplify impeccable attention to design." Apple also explicitly invites a story: "if your app, game, or development team has a unique story that our editorial team should know, definitely be sure to tell us about it."

**Google (officially published).** "Good quality" earns increased discovery; **"great quality" is required for featuring.** Four pillars: core value, user experience (including localization and accessibility), technical quality, and privacy/security. Titles exceeding the bad-behaviour threshold on specific devices will not be promoted on those devices — **the crash and ANR thresholds from item 2 reach all the way into featuring eligibility.** Google also rewards making the most of premium devices such as foldables and watches, and names poor monetisation UX as a top driver of dissatisfaction.

**The crucial overlap, and the reason this item needs no separate strategy: both published criteria lists are simply descriptions of a well-built app.** Design, accessibility, localization, platform-native behaviour, a strong product page, good ratings. **You do no special work to court editors** — the same effort that makes an app rankable makes it featurable. That is why featuring collapses into "build something good" rather than becoming its own workstream.

#### What a feature is actually worth — and why not to plan around it

**Neither store publishes any data on uplift, duration or acceptance rates. Every figure below is third-party or developer-reported, and is directional only.**

| Source and type | Reported effect |
| --- | --- |
| Apptopia (data vendor, **2017**) | App of the Day +1,747% average, Game of the Day +792%, day-of vs prior day, US. But apps **already** in their category top 20 gained only \~44%, and a household-name app reportedly gained "a handful of downloads" |
| Signeasy (developer blog) | \~27× on day one as App of the Day; +774% net for the week, decaying through it |
| AppTweak (vendor case study) | +470% organic installs, +540% organic revenue as US Game of the Day |
| Michael Flarup (designer, quoted August 2026) | Today's best features bring **"tens of thousands of downloads, a far cry from the millions they once could"** — and many successful apps have never been featured |

**Two conclusions from that table.** First, **features help unknown apps far more than known ones**, which is good news for a new app — and that direction is the part most likely to still hold. Second, the **2017 figures are badly dated**, and practitioners say feature power has waned considerably since. Qualified 22 October 2026: dated does not mean useless. Treat the two numbers as the **outer bounds of what is plausible** rather than discarding the old one or adopting the newer one as a forecast — the 2017 figure as what a feature could do in a less crowded store, the practitioner figure as a more realistic modern expectation, and neither as a number to plan revenue against. Nobody publishes current, verified feature-lift data; that absence is the real state of the evidence.

**Does it permanently help ranking? No primary source says so.** The mechanism is install velocity: store charts are computed over rolling windows of install velocity, so a feature briefly lifts charts and some keyword rankings, then decays. Developer reports consistently describe a **day-one peak fading within about a week**, with rankings drifting back down. **Treat a feature as a one-off spike.** Its lasting value is what you collect *during* it — reviews, retained users, and "Featured by Apple" as social proof.

**How to think about selection, honestly.** Roughly a million new apps were on track to be added to the App Store in 2026, against a few hundred App-of-the-Day and Game-of-the-Day slots per storefront per year, and **neither store publishes acceptance rates.** Corrected 21 October 2026: that arithmetic describes the supply of slots, not your probability of getting one, and this document will no longer attach a number — or a word like "low" — to your chances. The rule that survives either way is the operative one: **selection is uncertain and must never be budgeted as assured.** Nominate because it costs an afternoon and it is the part you control; plan the launch as though nothing comes of it.

#### Decided: inputs are launch hygiene, the outcome is upside

**No real decision here, and the conclusion survived the research intact — with the Apple/Google split as the one material change.**

- **Plan the inputs.** On Apple, add a "Featuring" line to every release plan and nominate at T-8 to T-12 weeks. Keep a reusable three-sentence story: why you built it, who you are, what is genuinely new. Build to the published criteria — accessibility, localization, platform-native design, strong product page, 4.0+ ratings — because **those pay off whether or not you are ever featured.**
- **Do not plan the outcome.** No launch plan, revenue forecast or growth assumption should depend on a feature.
- **On Google:** invest in technical quality and Android vitals, and in large-screen, foldable and Wear OS support. Check Play Console for promotional-content access once a quarter. Keep it as a later-stage lever.
- **One reliable lever you do control:** adopting a brand-new OS capability promptly. Apple officially rewards innovation with new technologies, and "great apps updated for iOS" collections appear each September. Timing one release a year to the OS launch window, and nominating it, is the closest thing to a repeatable route — **though not a guarantee, and anyone selling a guaranteed path to featuring is selling something.**

**Anti-patterns worth recording:**

- **Google (official):** general service descriptions, evergreen content or routine events are ineligible; identical concurrent events are not allowed; text or logos on event images are not allowed; wrong language is a common rejection reason; poor Android vitals block promotion on affected devices.
- **Apple (practitioner reports):** asking anyone at Apple directly for featuring reportedly never works. In-App Events must not be fluffy. And **do not nominate every point release** — one practitioner suggests one or two significant nominations a year, which fits the update-cadence rule from item 6.
- **Both:** low ratings, crashes, misleading metadata and keyword stuffing.

**How to measure one if it happens:** compare App Store Connect's "App Store Browse" traffic, and Play Console's "Explore" acquisitions, on feature days against a 14-day baseline.

**Recheck before every launch.** Google's thresholds, quotas and form links have changed repeatedly since 2023, and Apple's own two-week/three-week guidance is inconsistent across its pages. **Verify the official URLs at the time rather than trusting this section's specifics.**

#### Where this points: straight back to the UI problem

**Design is the thing editors reward** — it heads Apple's published criteria and sits inside Google's user-experience pillar. So featuring is one more argument that the **UI design quality problem** is the correct next focus: it is simultaneously the blocker on every site and app, the thing that lifts install rate at the gate, and the thing that makes an app featurable. **No "editorial featuring strategy" is needed at all — a genuinely well-designed app plus remembering the Apple form is the whole of it.**

**This also closes the loop on the category trap:** a wrong category shows you to the wrong people, they do not install, search conversion falls, and the store shows you less. Gaming the gate poisons the score — now demonstrated mechanically, not just asserted.

**And the one genuine strategy that could not be guessed: both stores let you A/B test this officially, for free.** This is the measurement equivalent of Microsoft Clarity but for the before — and unlike cross-assistant AI-visibility measurement, it actually exists and is reliable — Google does now report its own AI surfaces in Search Console (see the AI search section); what still has no instrumentation is visibility across the other assistants.

|  | Apple | Google Play |
| --- | --- | --- |
| Feature name | Product Page Optimization | Store listing A/B tests |
| What can be tested | Icon, screenshots, app previews | Icon, feature graphic, screenshots; plus descriptions in localized tests |
| How many at once | Alternate versions shown to a share of randomly selected eligible users | One default-graphics test, or up to five localized tests; each with up to two variants against the current listing |
| How the winner is decided | Results appear in App Analytics; you then promote the best-performing version to everyone | A target metric chosen at setup — unique install clicks, open clicks or pre-registration clicks — judged with a confidence interval and minimum detectable effect. Too little data reports "More data needed"; a difference below the threshold is a draw |

**The decision: deep-dive this later, not now.** The screenshot craft and the testing loop need **a real app with real screens and real visitors**. Studying it in the abstract produces opinions, not knowledge — the same reason the per-page wait time cannot be pinned down without a live site.

The plan when that exists: run proper tests across several parameters, and from the actual results build the reusable artifact — a screenshot and listing template, or a rules file, in the same spirit as the web template. Categories and app types will differ, but whatever proves common becomes the general starting point that specific apps then adapt. **Nothing to build now. The trigger is explicit: the first real app with a live listing.**

### The after — next discussion, with two points already settled

This is where most of the ranking lives: install rate, retention, ratings. Two things are already established and worth recording before the full session.

**Mobile session recording does exist — corrected 22 October 2026.** The earlier line here ("there is no Clarity for the inside of an app") was wrong: Clarity ships mobile SDKs, and UXCam, Smartlook and PostHog all offer in-app session replay. What you cannot buy is your app's own meaning. Nothing outside your code knows the user just finished their third successful scan. **So screens and taps can be bought off the shelf; the success moment that drives the review prompt and the first-session funnel is still something you instrument yourself.** Replay also costs more inside an app than on the web — an SDK in the binary, a release to change it, and privacy exposure on screens that may show personal data — which is why it still waits for a real question rather than shipping by default.

**Ratings timing is a real strategy, not a checkbox.** Define "moments of success" in your own app — finished a task, exported a file, reached day three of use — count them, and trigger the rating ask only after a good one. Use the **native in-app rating prompt** both platforms provide, which does not kick the user out to the store; Apple caps how often you may ask per year, which forces you to spend those asks well.

**The trap in "just prompt everyone to rate it":** prompting everyone, frustrated users included, summons your own one-star reviews and drops your ranking. The skill is not the asking, it is asking the right person at the right moment. In one line: **ask after success, never after friction, and never after an error or a crash.**

Still to cover in the next session: retention mechanics and what the stores actually measure over what window, responding to reviews, update cadence as a ranking signal, and how editorial featuring works.

**The UI design quality problem.** Not SEO. It was the active priority before this conversation began and is still unresolved; it lives in the separate startup-context document. Nothing here displaces it.

**Update, 22 October 2026:** now active, in the companion [UI Playbook](https://claude.ai/artifact/CmCxWKLEvvhG3EDr5vmucq).

**2. The verification test — agreed, not yet run.**

Everything in this document is a sound model that has not been tested against a real site. The tools were vouched for from their descriptions, not from reading their internals or running them on anything.

**Wirecutter was tried and abandoned.** `nytimes.com` is blocked for the fetch tools, so there is no HTML to audit and any findings would have been invented. The lesson, recorded because it was my mistake: **confirm a target is reachable before choosing it.**

**Replacement target: `cardekho.com`** — reachable, confirmed 9 October 2026.

Why it is a better test than Wirecutter: it is a real Indian car marketplace, which is the exact example used throughout this document, and its findings are directly transferable to the kind of site you would build.

Its live structure, confirmed by inspection, is the model in this document working in the wild:

| Page | URL |
| --- | --- |
| Pillar | `/mahindra/thar` |
| Child — city on-road price | `/mahindra/thar/price-in-bangalore`, `/price-in-mumbai`, `/price-in-pune`, `/price-in-hyderabad`, `/price-in-chennai`, `/price-in-new-delhi` |
| Child — specs | `/mahindra/thar/specs` |
| Child — colours | `/mahindra/thar/colors` |
| Variants | `/overview/Mahindra_Thar/Mahindra_Thar_2.2L_ZXT_4WD_Diesel.htm` and 14 others |
| Separate group — comparisons | `/compare/mahindra-thar-and-maruti-jimny.htm`, `/compare-cars` hub |

Three predictions from this document hold on it: the URL folder path carries the grouping, the pillar links down to every child, and comparisons sit in their own group because the user's intent changed.

**Openings already visible without running any tool** — useful as a check on whether the installed skills find them too:

- **Soft 404s.** `/mahindra-thar` and `/renault-duster` return the homepage with a 200 status instead of a 404. This is in the failure table of this document, and it is also an *audit trap*: a fetch tool returns the homepage without erroring, so you silently audit the wrong page. Always confirm the page you got is the page you asked for.
- **Inconsistent URL conventions.** Variants live under `/overview/Mahindra_Thar/*.htm` rather than under `/mahindra/thar/`, breaking the otherwise clean pattern. Legacy `.htm` extensions throughout the comparison and review paths.
- **A raw HTML entity leaking into the title tag** (`&amp;` rendered literally).
- **The "Images" navigation item has no `href`**, so it is not crawlable.
- **No dedicated mileage page**, despite mileage being an obvious high-intent search. That is exactly the kind of gap the keyword strategy section says to look for.

**What to run:** `searchfit-seo:seo-audit` on `https://www.cardekho.com/mahindra/thar`, then `searchfit-seo:technical-seo`, then `searchfit-seo:ai-visibility`.

**Time:** roughly 1 hour, most of it waiting. **Cost:** zero — all three are installed skills.

**What it proves:** whether the tooling produces sensible output at all. The list of openings above is the benchmark — if the skills surface those, they work; if they miss them, they are checklist theatre and the build plan changes.

**Result — `seo-audit` run 9 October 2026. Verdict: the tooling is real, and it has a boundary worth knowing.**

Scored against the five openings found by hand before running it:

| Pre-inspection opening | Found by the skill? |
| --- | --- |
| Soft 404s (`/mahindra-thar` returns the homepage at 200) | No — it audits the page given, it does not probe bad URLs |
| Inconsistent variant URLs (`/overview/Mahindra_Thar/*.htm`) | No — found adjacent naming drift (`thar` vs "Thar OG", a legacy `/thar-2020/review`) but not the path inconsistency |
| Raw `&amp;` in the title tag | **My error.** Running in a live browser it read a normal `&`. The entity was an artifact of my fetch tool. It did find the same class of bug elsewhere — raw HTML leaking into three image `alt`/`title` attributes |
| "Images" nav item with no `href` | No — it counted 151 internal links and flagged dilution, which is not the same finding |
| No dedicated mileage page | No — it does not do content-gap analysis |

One of five, and that one was me being wrong. But the score is misleading, because what it found instead is more valuable than the list it missed:

- **82% of images (136 of 165) ship as a spacer placeholder** with the real URL in `data-src`, swapped in by a custom scroll handler, with zero `<noscript>` fallback. On a page built around 114 photos. This is the gate-1 and gate-2 invisibility problem from this document, caught in the wild, and it is the single most important finding on the page.
- **The Expert Review block is duplicated two to three times in the DOM** — 48 headings for 1,834 words. That muddies main-content extraction for Google and for AI answer engines.
- **H1 and title target different queries.** The title, meta description, `og:title` and first H2 all lead with price; the H1 is just "Mahindra Thar OG". A direct hit on the query-to-page-match signal.
- **Near-duplicate city pages at scale** — `/price-in-pen`, `/price-in-etah`, `/price-in-mhow` and siblings share templated copy with only the city and price swapped. This is exactly the thin-content and programmatic-SEO trap described in "How sites lose", found on a real site.
- **`robots.txt` explicitly allows `OAI-SearchBot`, `ChatGPT-User`, `PerplexityBot`, `ClaudeBot`, `DuckAssistBot`, `Apple-Extended`** — a deliberate AI-visibility posture, which makes the placeholder images and duplicated DOM more costly than they would otherwise be, since those crawlers are less forgiving of JS-dependent content than Googlebot. That observation validates the AI-crawler section of this document.
- Plus: missing `VideoObject` and `Review` schema, 474 KB of JS across 50 requests with 4 render-blocking in `<head>`, 36 images without dimensions, generic alt text at scale, a 64-character title that will truncate.

### What this establishes

**What the skill is:** a deep single-page technical and on-page auditor that renders in a real browser. That browser rendering is why it caught the placeholder images — a plain fetch would have missed them.

**What it is not:** a crawler, a site-structure analyst, or a content-gap finder. Every opening it missed was site-level rather than page-level. Do not expect it to tell you which pages should exist.

**What changes in the build plan:** nothing is removed, and item 1 gets stronger. The most serious findings — placeholder images with no fallback, duplicated DOM, render-blocking JS, missing image dimensions — are all things a correct starter template and a CI check prevent permanently, at zero ongoing cost. CarDekho is paying for them on every page of a very large site. That is the argument for building the template, made concrete.

**Two caveats on the output:** it opens with an "overall score: 72/100", which is exactly the kind of metric this document says to ignore — read the findings, not the number. And it closes by advertising the vendor's paid product. The plugin is free and useful; it is also marketing, so treat its recommendations to subscribe accordingly.

**Result — `technical-seo` run 9 October 2026. The boundary I drew after the first run was wrong.**

This skill does probe beyond the URL it is given: the sitemap index, deliberately invalid URLs, case and trailing-slash variants, query strings, and sibling city pages. Site-level analysis is covered after all — by this skill rather than `seo-audit`.

It found two of the openings the first run missed:

- **The soft 404, confirmed and better characterized than my version.** `/mahindra/thar-nonexistent-xyz123` redirects to `/cars/Mahindra` and returns 200. Any mistyped or retired model URL becomes a live page, which inflates the crawlable surface and hides genuinely dead URLs from Search Console.
- **The city-page duplication, quantified.** Roughly **1,256 indexable near-duplicate city pages for the Thar alone**, each 5,700–6,700 words of near-identical boilerplate differing only by city name and a price figure, all self-canonicalizing, all in the sitemap, nothing consolidating them. Far more severe than the first run implied.

And one neither the pre-inspection nor the first audit would ever have caught:

- **`car-model-price-sitemap.xml` holds 49,557 URLs — 443 short of the 50,000 hard cap.** The next model launch breaches it and the overflow silently stops being submitted. A genuine time bomb, found by counting.

Also worth having: a `robots` meta inconsistency across one template (`/price-in-etah` emits directives, `/price-in-pen` emits none); confirmation that URL normalization and parameter handling are correct; HTTP/3 and Brotli with 89 KB transferred against 660 KB decoded; and the same 474 KB of JavaScript and placeholder-image findings as the first run, which cross-validates both.

**The quality signal that matters most:** it reported its own measurement failures rather than inventing numbers. Core Web Vitals could not be measured because the automated tab never painted, and it said so and pointed to CrUX as the authoritative source instead. The mobile viewport resize did not take, so it marked mobile *untested rather than passing*. Redirect status codes were visible as behavior but not as codes, and it flagged that too. A tool that says "I could not measure this" is far more trustworthy than one that always produces a full score.

### Revised verdict on the toolkit

**Covered, and well:** page-level technical and on-page audit (`seo-audit`), site-level crawlability, indexation, sitemap health, duplication and normalization (`technical-seo`). Together they are a real audit, and both volunteer their own limits.

**Still not covered by any skill:** content-gap analysis — *which pages should exist*. Neither skill does this, and neither should. That is the research step, and it stays with the keyword work and your judgment.

**Discount in both outputs:** the scores out of 100, and the closing advertisement for the vendor's paid product.

**Result — `ai-visibility` run 9 October 2026. The most impressive of the three, for what it refused to do.**

The skill's own method calls for a prompt-by-prompt matrix — ask ChatGPT, Gemini, Perplexity and Claude where CarDekho ranks for category questions, and score it. It declined to produce one, for two reasons it stated plainly: it cannot query those four platforms, and its own recall was **contaminated** by two prior audits' worth of CarDekho data, so anything it "remembered" unprompted would be worthless. It marked that dimension `untested` rather than filling it with invention.

That is the behavior you want from a measurement tool, and it is rare.

What it audited instead was the supply side — everything determining whether AI systems can ingest, trust and cite the site — and it found one outright defect:

- **`cardekho.com/llms.txt` opens by announcing it is a sample.** First line: `Sample llms.txt file`, followed by a stray unclosed `{code:java}` marker pasted straight out of Jira or Confluence and shipped. The file is otherwise substantial — 163 lines, 124 links, eight sections — but the document meant to be the site's authoritative self-description to AI systems begins with two signals that it is placeholder content. It is also roughly **460 articles stale**, and `/llms-full.txt` returns 404.
- **Third-party facts about the company conflict badly.** Founding year 2008 on Wikipedia and CB Insights but GirnarSoft dated 2006 and 2007 elsewhere; HQ Jaipur almost everywhere but Gurgaon on one profile; total raised $536.1M on CB Insights against $752.1M on Inc42; and Inc42's own page showing FY24 revenue as both ₹777.1 Cr and ₹2,392.8 Cr. An assistant asked how much CarDekho has raised has no way to be confidently right. This is the entity-consistency problem from this document, measured.
- **A useful nuance on the image defect:** the *text* — prices, variant tables, specs, the full expert review — does arrive server-rendered in raw HTML, so the quotable content is reachable. It is the entire visual layer that does not exist to non-rendering crawlers. Worth separating, because it means the text strategy is sound and only the images are broken.
- Competitive context: Semrush had carwale.com at 25.81M monthly visits against cardekho.com at 19.4M — second by traffic despite owning ZigWheels. Flagged as ten months old and directional, correctly.

### The test is complete. Verdict on the toolkit.

All three skills measure rather than assert, declare their own blind spots instead of papering over them, and cross-validate each other — the placeholder-image defect was found independently three times. **The tooling is real and the audit step does not need building.**

| Capability | Owned by |
| --- | --- |
| Page-level technical and on-page audit | `seo-audit` |
| Crawlability, indexation, sitemap health, duplication, normalization | `technical-seo` |
| AI supply-side readiness: crawler access, retrievability, schema, entity consistency | `ai-visibility` |
| **Which pages should exist** (content-gap analysis) | **Nobody — this is the research step, and it stays with you** |
| **Live AI answer position across platforms** | **Nobody — needs repeated real queries; this is the monitoring loop, still unbuilt** |

In both outputs, discount the scores out of 100 and the closing advertisement for the vendor's paid product. The findings are the value.

### What this changes

Build items 1 and 2 — the starter template and the rules file — are now justified by evidence rather than assertion. Every serious finding across all three reports is a build-time preventable: JS-dependent images, duplicated DOM, missing dimensions, soft 404s, sitemap overflow, inconsistent robots directives, a broken generated file shipped unverified. A large, well-resourced production site is paying for all of them continuously.

Build item 3, the monitoring loop, is now the only thing the toolkit cannot do — confirmed, not assumed.

**3. Parked, and not SEO at all.**

The UI design quality problem — getting output that is distinctive rather than templated — was the active priority before this conversation and is still unresolved. It is recorded in the separate startup-context document. Nothing here displaces it.

**Update, 22 October 2026:** the UI design quality problem is now the active workstream. It is indexed and decided item by item in the companion [UI Playbook: Professional, not AI-default](https://claude.ai/artifact/CmCxWKLEvvhG3EDr5vmucq). UI decisions live there; this doc keeps SEO, AI search and ASO.

## Sources

- [Where Google AI Overviews pull their answers from: What 100 citations reveal](https://cxl.com/blog/google-ai-overview-citation-sources/) — CXL, citation position and ranking-overlap data
- [Google AI Mode: How to Rank and Get Cited](https://www.tryprofound.com/articles/rank-in-google-ai-mode) — Profound, query fan-out and passage retrieval
- [14 Proven Tactics to Rank Higher on ChatGPT](https://nicklafferty.com/blog/how-to-rank-higher-in-chatgpt-perplexity/) — citation format and domain-overlap data
- [ChatGPT ads are live: a complete breakdown](https://launchcodex.com/blog/performance-marketing/chatgpt-ads-breakdown/) — launch dates, formats, pricing, Answer Independence
- [OpenAI crawling llms.txt files, Google says it won't](https://www.optimixed.com/openai-crawling-llms-txt-files-google-says-it-wont/) — current llms.txt support status

Figures from vendor-published AI-visibility research are correlational and self-reported; the direction is reliable, the precise numbers are not.

## What this document cannot tell you, and the routine that keeps it honest

Added 22 October 2026. Two limits that belong in the document itself rather than in a conversation about it.

### It is desk research, and that is its boundary

Everything here comes from official platform documentation, one real third-party site audited in depth, and a claim-by-claim audit of the reasoning. **None of it has yet been tested against a site or app of our own.** That is not a flaw to fix by reading more — it is the boundary of what reading can establish. The gap between "correct according to the documentation" and "works for us" closes with a shipped site and roughly three months of Search Console data, and with nothing else.

What that means in practice: treat every number in this document as a published fact about the platform, and every **effect** as an expectation to verify. A threshold is real; whether crossing it moves your traffic is a question your own data answers. The first project to run on this playbook is therefore also the experiment that validates it, and its results should be written back here — especially anywhere the playbook turns out to have been confidently wrong.

The authority section already states the related ceiling: a new domain takes three to six months to see meaningful organic traffic regardless of how well this is executed. **Do not read that slow start as the playbook failing.** It is the documented behaviour, and the correct response is to keep publishing against chosen targets rather than to start changing the strategy.

### Platform facts rot — re-check them on a schedule

In the eight days between 14 and 22 October 2026 this document needed two correction passes, and the great majority of the corrections were not errors of reasoning but statements that had **gone out of date or had always been stated more absolutely than the sources support.** Stores change forms, Google ships reporting features, published limits get revised, and policies take effect on dates that pass.

So re-check the following **quarterly**, against the primary sources rather than from memory, and record the date of each check:

| Re-check | Why it moves |
| --- | --- |
| Android vitals thresholds, and the February 2027 memory/DEX effects | Published numbers get revised, and that date arrives |
| Apple's keyword-field limit — the 100-character versus 100-byte conflict | Unresolved in the sources; may be clarified |
| Both stores' featuring and nomination forms, and their eligibility rules | Forms appear, move and close; this document has already been wrong once |
| Search Console's AI reporting, and whether per-assistant or breakdown data has appeared | New product, actively changing; our current position is "not established", not "does not exist" |
| Review-prompt mechanics and the policy wording behind the pre-screening ban | Policy text and caps get edited |
| Core Web Vitals metrics and their thresholds | Google has replaced a metric before and will again |
| Vercel, Clarity and other vendor plan terms, including commercial-use limits | Pricing and licence terms change without notice |

Two rules for those passes. **Record the check even when nothing changed** — a dated "verified, unchanged" is what stops the next reader assuming a fact is fresh when it is two years old. And when something has changed, correct it **in place with its date**, the way both previous passes did, so the document keeps its own history instead of quietly becoming a different document.

## Change log — 21 October 2026 audit integration

An independent research audit of this document ran across 34 segments between 15 and 21 October 2026, producing 331 change proposals against 1,539 recorded claims, and was adjudicated over four rounds. The full record of what was accepted, what was rejected and why is held separately in the acknowledgement record (v5, 21 October 2026). This revision integrates the accepted findings. Everything not listed below stands as written.

### The eight changes that alter what you do

| What changed | Where | Now |
| --- | --- | --- |
| **Automatic pruning is withdrawn** | Monthly routine, signals table | Zero impressions after six months, and two pages on one query, are **review triggers**. Seven checks come first, including missing-versus-zero. No automatic merge or delete |
| **Review-prompt cap is on presentations** | Ratings and reviews | At most **three presentations per 365 days** where the user has not reviewed on that device; a previously-reviewed user also needs a new version and 365+ days. Asking is not showing |
| **Rating gates stay banned, with the right citations** | Ratings and reviews | §5.6.1, §3 and Google's pre-question ban are the real rules. The "gate" sentence was my paraphrase, not an Apple quotation — corrected and attributed |
| **Dashboard filtering is not reduced collection** | Behaviour analytics | If the point is collecting less, scope the snippet. The two options were wrongly offered as equivalent |
| **Google Play featuring can be nominated** | Editorial featuring | The **Featuring Nomination** form is real and open; **Indie Corner is US-developer-only** and closed to us. "No public route for Play" is withdrawn |
| **SDK crash rates are not Play vitals** | Quality thresholds | Both are kept, each configured against its own definitions. 1.09% cannot be copied into a Crashlytics alert. Watch, wake-lock and watch-face limits added; memory/DEX effects start **February 2027** |
| **No causal or probability claims** | Throughout | A drop has several candidate causes; a published threshold is not proof of demotion; featuring odds carry no number and no "low" |
| **Keyword prompt guardrails** | The generator prompt | High/Medium/Guess are labelled subjective judgements; "low competition" is banned without evidence; byte and character counts both printed; spaces inside phrases allowed |

### Changed in wording or confidence, not in action

- **The EEA site-reputation carve-out** was added where penalties are discussed: effective 30 August 2026, searcher location, manual actions only, and only if a site carries third-party sections.
- **Apple's keyword-field limit is a documented conflict** — 100 characters in Apple's search guidance, 100 bytes in App Store Connect. Stay short of 100 and verify on submission; the counts are diagnostics, not evidence of the validator.
- **Cross-locale keyword fields do not pool** into one larger budget; each locale is matched on its own, and the arrangement is practitioner-reported, not published.
- **Search Console now reports AI Overviews and AI Mode**, already included in Web totals. What was *not* established — cross-assistant census, prompt-level data, separate AI click/CTR/rank/API breakdown — is recorded as an evidence gap, not as proof of absence.
- **The \~100-session heatmap trigger** is labelled as our own readability heuristic.

### Still open, and why

| Open item | What it needs |
| --- | --- |
| Microsoft Clarity contract terms and consent obligations | The contract itself — a document to retrieve, not a question to reason about |
| TRAI provenance | The source document |
| Two chart sources behind the earlier market figures | The original charts |
| The CarDekho audit execution logs | The repository run output |
| **Conflict C1** | One disagreement about how Google's published featuring criteria relate to measured enforcement. **The quality-thresholds reading in this document controls** until the audit chat produces its reconciliation addendum; the competing reading is not applied here |

The first four are retrieval tasks that can be worked now — none of them waits on a live site or a shipped app. Where this document defers to "the first real app with a live listing" or "once a site has its own track record", that reflects project status as reported in the authoring sessions of 14–15 October 2026; it is dated and should be re-confirmed rather than assumed.

### What the audit left alone

The architecture and the four gates; the one-page-per-intent structure; topic clusters; the two-path localization approach and the commitment to full localization; the three-tier review ladder; the ten-phrase validation queue and the generator prompt's structure, inputs and guardrails; quality-first launch sequencing; the notification ban; the no-ASO-template decision; and the tooling and spending choices. The audit qualified several of the reasons given for these. It overturned none of the choices.

### Second pass — 22 October 2026 accuracy fixes

A follow-up review found sixteen statements that had gone stale, overstated their case, or were missing. **None of them reverses a decision in this document** — they make it accurate. All are corrected in place and dated.

| What it said | What it says now |
| --- | --- |
| Unindexed pages: "fix those pages or delete them" | **Review first**, diagnose, then fix — delete only if the review concludes that. Matches the pruning rule |
| "There is no Search Console for AI" | Google reports AI Overviews and AI Mode. What is still uninstrumented is visibility **across other assistants** |
| "Nothing can have moved until Google re-reads the page"; "up 3 places means it worked" | The recrawl date tells you when your edit became **eligible** to matter. Positions also move for reasons that are not you, so a 3-place gain is a signal, not proof of cause |
| Duty notifications: "always send" | Only with the user's **permission**, which they grant and can revoke. Ask at a moment the value is obvious, and never let a duty message exist only as a push |
| "There is no Clarity for the inside of an app" | Mobile session recording **does** exist (Clarity mobile SDKs, UXCam, Smartlook, PostHog). What you cannot buy is your app's own meaning — the success moment is still yours to instrument |
| Search Console "only reports forward from verification" | Collection starts when the **property is added**; verification is what lets you read it. Do both before launch |
| Uninstalls are "permanent" | **Effectively** permanent — reinstallation exists but you have no mechanism to cause it, so never plan on it |
| "A half-done localization is worse than none" | **Can be** worse. It is our standard because it protects the experience, not a measured finding |
| The 2017 featuring figures are "badly dated" and superseded | Dated, yes — but treat the old and new numbers as the **outer bounds of plausible**, not one discarded and one adopted. Nobody publishes current verified data |
| Rank trackers are not worth buying | Not for the monthly rhythm — but they are the only way to see **competitors'** positions, so buy a month when that is the question |
| Crashlytics reports "every crash" | **Most** crashes. SDKs miss OOM kills, some native and watchdog terminations, and anything before initialisation — another reason Play vitals are the measurement of record |

**Three additions:** Vercel's free Hobby plan is **non-commercial**, so a commercial site needs a paid plan from day one; a **security and dependency update routine** now sits with the monthly rhythm, including the Security Issues and Manual Actions reports; and **Apple Search Ads' 1–5 keyword popularity score** is recorded as the one first-party demand signal available before launch, with the note that Google Play has no equivalent.

**The code template was checked against this pass on 23 October 2026, and four things changed.** Most of it needed nothing — the sitemap already auto-splits at 40,000 URLs, images already cannot ship without dimensions, schema is already restricted to visible content, and the build gates already fail on an empty `<main>`, a missing canonical or a `robots.txt` that blocks rendering resources. What changed: **preview and staging deployments now noindex themselves** (`robots.txt` disallows everything and `X-Robots-Tag: noindex` is sent whenever the deployment is not production, read from one shared signal, defaulting to indexable so a production deploy with no environment variables set can never be silently hidden); a **dependency and audit routine** was added (`npm run check:deps`, plus grouped Dependabot pull requests, kept out of `npm run verify` so that stays offline-capable); and the README's two stale facts were corrected — **Search Console collects from property-add rather than verification**, and **Vercel's free Hobby plan is non-commercial**. Both the production and the preview paths were built and verified after the change.

The pattern worth noticing: every one of these was an **overstatement in the direction of being decisive** — a rule stated more absolutely than the evidence supports. The document is meant to be decisive, so that pressure is permanent, and this is the second pass that has had to pull it back. Expect to run another one.
