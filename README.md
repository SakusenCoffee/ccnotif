# Pre-Order Watch

Add a store, tick the pre-orders you care about, and **get a text the moment one
becomes buyable** — plus a real RSS feed of the same events, so you can read it in
any feed reader instead of (or as well as) getting texts.

Stores are added from the UI. You paste a URL, the app works out what platform the
store runs, reads its catalogue, works out which of its sections are pre-order
listings, and you confirm which ones to track.

**Supported platforms: Shopify and Shopware 6.**

## How it works

```
paste a store URL
      │
      ▼
each platform adapter gets a turn  ──►  rank sections that look like pre-orders
      │                                          │
      ▼                                          ▼
  you confirm which to watch  ──────────►  saved as a site row
                                                 │
                            poll every 5 min ────┤
                                                 ▼
                            product flipped unbuyable ─► buyable?
                                    ┌─────────────┴─────────────┐
                                    ▼                           ▼
                          text everyone watching it      append to RSS feed
```

The signal is always the same question — *can you actually put this in a cart right
now?* — but each platform answers it differently, so each has an adapter in
`src/platforms/`. Adding a platform means writing one, not touching the poller.

### Shopify

`variants[].available` in the store's own JSON. A product counts as buyable when
**any** variant is — the exact flag the storefront uses to decide between an "Add to
cart" button and a "Sold out" badge. `/meta.json` gives the name and currency, and
`/collections.json` is paged through for the collection list. Nothing is scraped;
these are public feeds a Shopify store publishes deliberately.

### Shopware 6

Shopware's machine-readable API is the Store API, which needs an `sw-access-key`
issued per sales channel — a normal storefront never puts one in the page, so there
is no feed to read and the rendered HTML *is* the interface.

The buyable signal is whether the card carries Shopware's add-to-cart form
(`action="/checkout/line-item/add"`). That form is rendered only when the product can
really be bought; a sold-out product gets a disabled label and a back-in-stock
notification form instead. Products are keyed by **SKU**, because the product UUID
appears only inside that form — keying on it would make a product change identity at
the exact moment it became buyable, which is the one event this app exists to catch.

Categories come from the navigation tree the storefront renders into every page, so
one request gets the catalogue's shape. Links that aren't navigation are admitted
only when their own last path segment reads as a pre-order section — that picks up a
store's headline listing when it's a promo button rather than a menu item (Miniature
Market's site-wide `/preorders` is an `<a class="btn">`), while keeping product URLs
out: `/Some-Set-Preorder/SKU123` ends in its SKU, not in "preorder".

Scraping is far more traffic than a JSON feed — one request per 24 products rather
than per 250 — so every fetch goes through `src/robots.js`, which obeys `Disallow`
and spaces requests out by `Crawl-delay`. See [Crawl budget](#crawl-budget).

### Section discovery

Each candidate section is scored against handle/title patterns:

| Pattern | Score | Pre-ticked |
| --- | --- | --- |
| `pre-order`, `preorder` | 100 | yes |
| `coming soon` | 70 | yes |
| `upcoming` | 60 | no |
| `new arrivals`, `new releases`, `back in stock` | 40 | no |
| `drop` / `drops` | 30 | no |

Sections matching `non-pre-order` / `no-preorder` are excluded — several stores
have a "Sale items (Non Pre Order)" collection, which is the opposite of what you
want.

Anything below 70 is listed but left unticked, and "Show all" exposes every
section for a manual pick. Products found in more than one section are
de-duplicated, so ticking a category that sits inside a larger one is harmless.

Discovery follows the store to its canonical host before anything else, so
`example.com` and `www.example.com` can't be added as two separate stores — and a
store's own navigation isn't mistaken for off-site links.

Verified against five real storefronts during development: Hobbiesville (Shopify,
CAD, 676 collections), Total Cards (GBP, 2000), Hairy Tarantula (CAD, 258), Card
Merchant WestCity (NZD, 179), and Miniature Market (Shopware, USD, 109 categories).
A store on a platform no adapter recognises is rejected with a message saying so,
rather than a generic failure.

### Polling pace

**Each store polls once a second, on its own loop.** Not one shared clock: a
sweep can only go as fast as its slowest member, so with one JSON-feed store
answering in 700ms and one scraped store taking twenty seconds, a shared timer
would poll *both* every twenty seconds and asking for a poll a second would buy
nothing. Given their own loops, measured over 45s: Hobbiesville 26 polls,
Miniature Market 1 — each going as fast as it can, neither waiting on the other.

Three things bound the real rate, none of them the timer:

- **The store's own limits.** A store answering 429/503 is rested with an
  exponential backoff from 30s to 15 minutes, cleared on the next good response.
  Without this, polling continuously just gets the app blocked and *every* alert
  stops — which is far worse than being a few seconds late.
- **robots.txt**, for scraped stores. Miniature Market asks for 10 seconds
  between requests and gets it; a one-second setting does not override a third
  party's stated rule. Expect a scraped store to poll on the order of minutes.
- **The database.** A 250-product store polled every second used to mean 250
  round trips a second; the catalogue is now written in a single statement.

Be aware of what a one-second default means for a JSON-feed store: it is a
sustained request every second or so to someone else's shop, indefinitely. The
backoff keeps that from becoming a ban, but if a store's operator objects, the
honest fix is `POLL_INTERVAL_SECONDS`, not a workaround.

### Crawl budget

A scraped store costs one request per listing page, every poll, forever — enough
traffic that the store's own rules about it matter. `robots.txt` is fetched, cached
for six hours, and obeyed: `Disallow` is enforced, and requests to one host are
serialised and spaced by its `Crawl-delay`.

This has a real cost. Miniature Market publishes `Crawl-delay: 10`, so a category
of ~340 products (15 pages) takes about two and a half minutes to read, and its
site-wide `/preorders` — 76 pages — would take over twelve. **Prefer the narrower
per-department sections** (`board-games/preorders.html` and friends) over a store's
"view all" listing.

Polls that overrun `POLL_INTERVAL_SECONDS` are safe: the poller skips a tick while
the previous run is still in flight rather than piling runs up. If a section is
still not finished within `CRAWL_MAX_PAGES`, the run says so explicitly instead of
reporting a clean sweep over a partial catalogue.

Because of that cost, **adding a store doesn't block on its first read.** A store
whose catalogue is a JSON feed still seeds within the request and returns real
counts, but a scraped one answers as soon as the row exists and finishes reading in
the background — no HTTP request survives a multi-minute crawl, and one that dies
mid-read makes a store look like it failed to add when it was being read perfectly
well. The store list shows *reading catalogue…* and refreshes itself until the
first read lands. Nothing is texted from a seed run either way.

For the same reason, sections are **not** pre-ticked on a scraped store. Several of
them usually overlap — Miniature Market's site-wide `/preorders` contains everything
in the seven per-department listings — so ticking the suggestions wholesale would
read the same catalogue twice over. The scan says what each page costs and lets you
choose.

## Deploying to Railway

1. **Create the project** and point it at this repo.
2. **Add Postgres**: `+ New` → `Database` → `Add PostgreSQL`.
3. **Link it to this service.** Railway does **not** inject `DATABASE_URL` into
   your app service automatically — the variable lives on the database service.
   Open your app service → Variables → add:

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

   (Replace `Postgres` with the database service's actual name if you renamed
   it.) Without this the app starts but shows a "not connected to a database"
   page. The schema is created on boot, so there is no separate migration step.
4. **Generate a domain** under Settings → Networking. Railway sets
   `RAILWAY_PUBLIC_DOMAIN`, which the app uses for links in texts and the RSS
   feed. Only set `PUBLIC_URL` if you attach a custom domain.
5. **Turn off app sleeping** for this service. Serverless/sleep mode suspends the
   container when there's no HTTP traffic, which stops the poller. This is the one
   Railway setting that will silently break the app.
6. Open the site and add your first store.

Twilio can stay unconfigured until you want real texts.

### Health checks

| Path | Meaning |
| --- | --- |
| `/healthz` | Liveness. **Always 200** while the process is serving, with database status in the body. This is what `railway.json` points at. |
| `/readyz` | Readiness. 200 only once the database is actually usable. |

`/healthz` deliberately does not fail when the database is missing. A 503 there
makes Railway mark the whole deploy failed, which is the wrong signal when the
only problem is an unset variable that a redeploy cannot fix — you want the
service up and telling you what to change.

### If a deploy fails

The app is built not to crash-loop, so check `/healthz` first — it reports
exactly what is wrong.

- **"DATABASE_URL is not set"** → step 3 above.
- **"The server does not support SSL connections"** → shouldn't happen now; SSL
  is chosen per host (off for `*.railway.internal` and loopback, on for public
  hosts). Override with `DATABASE_SSL=true|false` if your provider differs.
- **Deploy is "active" but nothing updates** → app sleeping is on (step 5).

> **Note on GitHub Pages:** the front end can't be hosted there on its own. It
> reads `/api/*` from the same origin, and the poller and database have to run
> somewhere regardless. Deploy the whole repo to Railway and use the domain it
> gives you.

### Twilio, when you get to it

| Variable | Notes |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | From the Twilio console dashboard |
| `TWILIO_AUTH_TOKEN` | Same page |
| `TWILIO_FROM_NUMBER` | An SMS-capable number you own, E.164 (`+15551234567`) |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional; used instead of the from-number and gives you Twilio's built-in STOP/START handling |

**Leave all four blank and the app still runs** — texts are printed to the logs
instead of sent, including the sign-in verification code. That is how the whole
flow was tested and the fastest way to work on the UI.

For inbound STOP handling, point your Twilio number's "A message comes in" webhook
at `https://<your-domain>/twilio/inbound`. The endpoint verifies Twilio's request
signature and rejects anything unsigned.

#### Diagnosing a failed text

Open `/twilio/diagnose` on your deployment. It asks Twilio directly and reports
what is wrong, without returning any secret:

```
https://<your-domain>/twilio/diagnose
```

It checks the shape of each variable (a wrapping pair of quotes or a stray
newline pasted into a dashboard field is the usual culprit), whether the
credentials are accepted, whether `TWILIO_FROM_NUMBER` is a number this account
owns and can send SMS from — **listing the numbers you do own if it isn't** —
and, on a trial account, exactly which destination numbers are verified.

If `ADMIN_TOKEN` is set, pass it as `?admin_token=…`.

#### Trial accounts

A Twilio trial account can **only text numbers you have verified**, including your
own. Add each one under **Phone Numbers → Manage → Verified Caller IDs** in the
console, or upgrade the account. Sending to an unverified number fails with code
`21608`, and the app says so directly in the dialog.

Trial accounts also prefix every message with "Sent from your Twilio trial
account -", which eats into the 160-character segment.

When a send fails, the exact Twilio code is written to the logs with a link to
Twilio's docs:

```
[sms] failed to +15551234567: [21608] The number +1... is unverified (https://www.twilio.com/docs/errors/21608)
```

## Running locally

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL at minimum

# a throwaway Postgres:
podman run -d --name pw-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=preorder \
  -p 55432:5432 docker.io/library/postgres:16
# then: DATABASE_URL=postgres://postgres:dev@127.0.0.1:55432/preorder?sslmode=disable

npm start          # web + poller
npm run poll       # one poll of every site, then exit
```

With no Twilio credentials the verification code is printed to the console — read
it from there to sign in.

## RSS

| URL | Contents |
| --- | --- |
| `/feed.xml` | Every restock across every store |
| `/feed.xml?site=<id>` | One store only |
| `/feed.xml?type=new` | Newly listed pre-orders |
| `/feed.xml?type=all` | Both |
| `/feed/<token>.xml` | **Only** the products on one person's watchlist |

The personal token is shown in the account dialog after you verify, and is linked
from every alert text. It's a bearer token — anyone with the URL sees that
watchlist (but can't change it or see the phone number).

**The RSS button opens a page in the app, not a feed file.** It used to link
straight to `/feed.xml`, which meant clicking it left the app and dropped you on a
document written for software. The dialog shows recent updates, the keyword alert
field, and the address to hand a feed reader.

**Opened directly, a feed still renders as a readable page.** `public/feed.xsl` is
an XSLT stylesheet the browser applies to the very same document: images, prices,
stores and badges, plus a note saying what the URL is for. Readers ignore the
stylesheet and parse the XML underneath, so one URL serves both.

Feeds are sent as `text/xml`, **not** `application/rss+xml`. Both are valid RSS and
readers accept either, but a browser only applies an `xml-stylesheet` instruction
to a document it treats as plain XML — under `application/rss+xml` Chrome skips the
stylesheet and prints the source, which is exactly what "the RSS link shows XML"
looks like. Confirmed by serving the identical document both ways: `text/xml`
renders, `application/rss+xml` does not. The `<link rel="alternate">` autodiscovery
tag and `atom:link` still advertise `application/rss+xml`, which is what those are
for; this is only the response header.

Items also carry `media:thumbnail` and a few `pw:*` fields (product, store,
price, label). The stylesheet builds the page from those rather than picking
apart the HTML in `description` — and a reader that understands `media:thumbnail`
gets a real image out of it too.

## Keyword alerts

The watchlist requires having already found a product. The text field under
**RSS** is the standing version: **text me about anything matching this**,
whether or not I have ever seen it. It fires on both kinds of event, because a
newly listed pre-order is usually what you wanted to hear about, and earlier than
its restock would tell you.

Matching is deliberately loose, because stores are inconsistent in a few
predictable ways — `src/match.js`:

| Typed | Also matches | Why |
| --- | --- | --- |
| `one piece` | One Piece, OnePiece, one-piece | the separator between words varies |
| `one piece` | OP, OP-11 | popular lines get abbreviated to initials |
| `pokemon` | Pokémon | accents get folded |
| `magic the gathering` | MTG | same initialism rule |

Several terms can be separated by commas. What it will **not** do is match inside
a longer word: the `op` in "Optic" or "Topps" is not a One Piece product, and
this feature sends texts — a false positive costs someone a message at whatever
hour it fires. Every alternative is bounded by "not adjacent to another letter or
digit", and typed input is regex-escaped, so a `*` matches an asterisk rather
than everything.

Alerts respect the same per-product cooldown as watchlist texts, and a product
you already watch won't text you twice for the same event.

## Design decisions worth knowing

**Adding a store means the server fetches a URL a visitor chose, so every outbound
request goes through `src/safe-fetch.js`.** It resolves the hostname and refuses
anything that isn't publicly routable — loopback, private ranges, CGNAT,
link-local (`169.254.169.254` is the cloud metadata endpoint), IPv4-mapped IPv6 —
on the original URL *and on every redirect hop*, with non-standard ports, non-HTTP
schemes, a request timeout, and a response size cap. Without this, "add a store"
is a server-side request forgery hole pointed at Railway's internal network. Set
`ADMIN_TOKEN` as well before sharing the URL publicly.

**Platforms are adapters, not branches.** Each lives in `src/platforms/` and
exposes the same two calls: `discover(origin)`, which returns `null` for "not my
platform" and *throws* for "mine, and something is wrong", and
`fetchProducts(site)`. The distinction matters — a store we recognise but can't
read reports the real reason instead of falling through to "unsupported". The
poller has no idea which platform it is polling.

**Products are keyed by whatever the store calls stable, not by a number.**
`external_id` is `text`: a numeric id on Shopify, a SKU on Shopware. It was
`bigint`, and the migration converts existing ids to their own decimal spelling —
exactly what the Shopify adapter now emits — so no existing product looks new after
the upgrade and nobody gets a burst of "new pre-order" alerts for a catalogue they
were already watching.

**Product URLs are stored, not rebuilt.** Only Shopify's is derivable from a handle
(`/products/<handle>`); a Shopware URL is its own SEO path. The link is written at
ingest.

**Phone verification is mandatory.** A 6-digit code is texted and must be entered
before a watchlist can be saved. Without it anyone could sign a stranger's number
up for texts. Codes are stored as SHA-256 hashes, expire in 10 minutes, and allow
5 attempts.

**Notification cooldown.** After texting someone about a product, that pair is
muted for `NOTIFY_COOLDOWN_HOURS` (default 24). Shopify inventory flaps — without
this, one wobbling product becomes a stream of texts. Flaps still appear in the
RSS feed; they just don't re-text.

**The app never exits because of configuration.** A missing or unreachable
database used to kill the process at import time, which on Railway looks like a
failed deploy with nothing useful in the logs. It now binds the port first,
serves a page explaining what to set, and retries the connection in the
background — so it starts working on its own the moment the variable is added or
Postgres finishes booting, with no redeploy.

**A store's first poll is silent.** Every product looks new on a fresh site, so
the seed run records state without emitting events or sending anything. Adding a
store waits for that seed before responding, so the UI shows real counts rather
than an empty store.

**"Buyable" and "in stock" are not the same thing.** Shopify's `available` flag
only means "can be added to cart", which is equally true of stock on hand and of
an open pre-order — so a pre-order that just opened was being labelled "In stock".
There is no native pre-order flag to consult: the fields that would settle it
(`inventory_policy`, `inventory_quantity`) are Admin-API only, absent from both
`products.json` and the `/products/<handle>.js` AJAX endpoint, which was checked
directly.

What stores do reliably is say so in the product title ("… (Pre Order)") and in
tags. Detection uses both, ignoring `*Show_Pre Orders`-style tags — those are
theme filter markers sitting on every item in a collection, so they are evidence
of nothing. Across Hobbiesville's three watched collections this identifies 316
of 317 products, with 2 false positives in a 250-item non-pre-order control.
Shopware themes badge pre-orders directly, so that badge is used where present and
the title test is the fallback.

That yields four states rather than two: **Pre-order open**, **Pre-order not
open**, **In stock**, **Sold out** — and a filter to show only one kind. On the
watched collections it separates 107 open pre-orders from 1 genuinely in-stock
item, which the old single "In stock" badge had lumped together.

**Prices are shown in the store's currency with an approximate conversion.**
Hobbiesville charges CAD, so a card reads `CA$193.00` with `≈ $137.63` beneath.
The conversion is indicative only — the store bills in its own currency and a
card issuer applies its own rate and fees — hence the `≈`. Rates come from a free
keyless provider (with a second as fallback), cached for six hours; if the lookup
fails the conversion is simply omitted. Set `DISPLAY_CURRENCY` to change the
target.

**Prices of `0.00` mean "TBA", not "free".** Shopify reports zero for pre-orders
whose price hasn't been announced. These become null at ingest so the UI, feed,
and texts all say "Price TBA".

**Currency is per store.** Hobbiesville prices in CAD, not USD. Each site's
currency comes from its `meta.json` (or, on a scraped store, whatever the page
declares, falling back to the symbol its prices are rendered with) and prices show
as `CA$307.00` / `NZ$154.00` rather than a bare `$`. Displayed prices are parsed
with the separator convention worked out from the number itself, so `€1.234,56`
doesn't come through as `1.23`.

**CSS custom properties are namespaced `--pw-*`, and `[hidden]` is forced with
`!important`.** Generic names like `--accent` collide with variables injected by
browser extensions, which silently breaks `var()` lookups; and the UA's `[hidden]`
rule loses to any author `display` declaration. Both were real bugs caught in
testing.

## Operational notes

- Rate limiting is in-process, which assumes **one instance**. If you scale to
  multiple replicas you'd get N× the poll traffic and N× the rate-limit budget —
  move the counters to Postgres and run the poller as a separate single-instance
  service (`npm run poll` on a Railway cron) before scaling out.
- The poller skips a tick if the previous one is still running, and a failing
  collection or site doesn't abort the rest of the run. Per-site failures are
  stored in `sites.last_error` and shown in the store list.
- Deleting a store deletes its products, events, and any watches on them.
- Store JSON feeds are public and unauthenticated, but they're still someone's
  server. Five-minute polling is well-mannered; don't drop it to seconds.
- Scraped stores cost far more than that per poll. `robots.txt` is honoured, but
  the ceilings are yours to set: `CRAWL_MAX_DELAY_MS` caps how long a store's own
  `Crawl-delay` can hold up a run, and `CRAWL_MAX_PAGES` caps how deep one section
  is read. Watch narrow sections rather than a store's "view all" listing.
