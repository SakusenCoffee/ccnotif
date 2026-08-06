# Pre-Order Watch

Add a store, tick the pre-orders you care about, and **get a text the moment one
becomes buyable** — plus a real RSS feed of the same events, so you can read it in
any feed reader instead of (or as well as) getting texts.

Stores are added from the UI. You paste a URL, the app reads that store's public
catalogue, works out which of its collections are pre-order sections, and you
confirm which ones to track.

## How it works

```
paste a store URL
      │
      ▼
read /meta.json + /collections.json  ──►  rank collections that look like pre-orders
      │                                          │
      ▼                                          ▼
  you confirm which to watch  ──────────►  saved as a site row
                                                 │
                            poll every 5 min ────┤
                                                 ▼
                              variant flipped false ─► true?
                                    ┌─────────────┴─────────────┐
                                    ▼                           ▼
                          text everyone watching it      append to RSS feed
```

The signal is `variants[].available` in the store's own JSON. A product counts as
buyable when **any** variant is — the exact flag the storefront uses to decide
between an "Add to cart" button and a "Sold out" badge. Nothing is scraped; Shopify
stores publish this themselves.

### Store discovery

`/meta.json` gives the store's name and currency. `/collections.json` is paged
through for the full collection list, and each is scored against handle/title
patterns:

| Pattern | Score | Pre-ticked |
| --- | --- | --- |
| `pre-order`, `preorder` | 100 | yes |
| `coming soon` | 70 | yes |
| `upcoming` | 60 | no |
| `new arrivals`, `new releases`, `back in stock` | 40 | no |
| `drop` / `drops` | 30 | no |

Collections matching `non-pre-order` / `no-preorder` are excluded — several stores
have a "Sale items (Non Pre Order)" collection, which is the opposite of what you
want.

Anything below 70 is listed but left unticked, and "Show all" exposes every
collection for a manual pick. Products found in more than one collection are
de-duplicated, so ticking a category that sits inside a larger collection is
harmless.

Verified against four real storefronts during development: Hobbiesville (CAD, 676
collections), Total Cards (GBP, 2000), Hairy Tarantula (CAD, 258), and Card
Merchant WestCity (NZD, 179). Non-Shopify sites are rejected with a clear message
rather than a generic failure.

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

## Design decisions worth knowing

**Adding a store means the server fetches a URL a visitor chose, so every outbound
request goes through `src/safe-fetch.js`.** It resolves the hostname and refuses
anything that isn't publicly routable — loopback, private ranges, CGNAT,
link-local (`169.254.169.254` is the cloud metadata endpoint), IPv4-mapped IPv6 —
on the original URL *and on every redirect hop*, with non-standard ports, non-HTTP
schemes, a request timeout, and a response size cap. Without this, "add a store"
is a server-side request forgery hole pointed at Railway's internal network. Set
`ADMIN_TOKEN` as well before sharing the URL publicly.

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
currency comes from its `meta.json` and prices render as `CA$307.00` / `NZ$154.00`
rather than a bare `$`.

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
