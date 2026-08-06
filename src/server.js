import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import twilio from 'twilio';
import { assertConfig, config } from './config.js';
import { dbState, initDb, query } from './db.js';
import { discoverSite } from './discover.js';
import { getFeedItems, parseTypes, renderRss } from './feed.js';
import { getRates, ratesFor, startFx } from './fx.js';
import { describeSmsFailure, sendSms, verificationMessage } from './notify.js';
import { passwordProblem } from './auth.js';
import { sendPush, testPush, topicUrl } from './push.js';
import { addAlert, buildMatchString, deleteAlert, listAlerts, updateAlert } from './alerts.js';
import { diagnoseTwilio } from './twilio-diagnose.js';
import { adapterFor } from './platforms/index.js';
import { pollerState, pollSite, runPoll, startPoller } from './poller.js';
import { addSite, deleteSite, getSite, listSites, updateSite } from './sites.js';
import {
  absorbAnonymous,
  authenticate,
  changePassword,
  checkVerification,
  clearVerificationCooldown,
  ensureBootstrapAccount,
  createAnonymousSubscriber,
  getWatchSettings,
  getWatchedProductIds,
  normalizePhone,
  rotatePushTopic,
  setPushEnabled,
  setWatchSettings,
  setWatches,
  startVerification,
  subscriberByFeedToken,
  subscriberBySession,
  token,
  unsubscribe,
} from './subscribers.js';

assertConfig();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// --- crude in-memory rate limiting -----------------------------------------
// Good enough for a single-instance deploy. If this ever runs multiple
// replicas, move the counters into Postgres or Redis.
const hits = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const id = `${key}:${req.ip}`;
    const now = Date.now();
    const entry = hits.get(id);
    if (!entry || now > entry.resetAt) {
      hits.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('retry-after', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', retryAfter });
    }
    entry.count += 1;
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
}, 60_000).unref();

// How long adding a store waits for its first read before answering anyway.
// Long enough that a JSON-feed store still returns real counts in the response,
// short enough to be nowhere near any proxy's idle timeout.
const SEED_WAIT_MS = 12_000;
const PENDING = Symbol('seeding');

// How long an authority to buy stays good for. The agent opens the tab at once,
// so this only has to cover a slow page load and a slow reader.
const TICKET_TTL_MS = 10 * 60_000;

/**
 * Get the session's subscriber, creating an anonymous one if there isn't a
 * session yet. Used by anything a visitor may do before deciding whether they
 * want texts — which is now everything except the texting itself.
 */
async function withSubscriber(req, res, next) {
  try {
    let subscriber = await subscriberBySession(req.cookies?.[config.sessionCookie]);
    if (!subscriber) {
      subscriber = await createAnonymousSubscriber();
      setSessionCookie(res, subscriber.session_token);
    }
    req.subscriber = subscriber;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireSubscriber(req, res, next) {
  try {
    // The gate has usually resolved this already; reuse it rather than issuing
    // a second identical query for the same request.
    const subscriber =
      req.account ?? (await subscriberBySession(req.cookies?.[config.sessionCookie]));
    if (!subscriber) return res.status(401).json({ error: 'not_signed_in' });
    req.subscriber = subscriber;
    next();
  } catch (err) {
    next(err);
  }
}

// Store management is gated only when ADMIN_TOKEN is set, so the app is usable
// out of the box but can be locked down before the URL is shared.
function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();
  const provided = req.get('x-admin-token') || req.query.admin_token;
  if (provided !== config.adminToken) return res.status(401).json({ error: 'admin_required' });
  next();
}

// --- the gate ---------------------------------------------------------------
//
// Nothing here is public. A handful of paths have to be, and they are listed
// rather than pattern-matched, because "everything except things matching X" is
// how a route quietly ends up exposed.
//
//   /login, /login.html  the page itself, self-contained so it needs nothing else
//   /api/login           the only way to get a session
//   /healthz, /readyz    the platform's health checks; a gated one fails deploys
//   /twilio/inbound      Twilio's webhook, which authenticates by signature
//   /feed/<token>.xml    the token in the path *is* the credential
//   /favicon.ico         requested before anything else and harmless
const PUBLIC_PATHS = new Set([
  '/login',
  '/login.html',
  '/api/login',
  '/api/tickets/claim',
  '/healthz',
  '/readyz',
  '/twilio/inbound',
  '/favicon.ico',
]);

const PUBLIC_PATTERNS = [/^\/feed\/[A-Za-z0-9_-]+\.xml$/];

// Loading one page asks for the document, the stylesheet and three scripts —
// five requests, effectively at once, each of which the gate must authorise. A
// database round trip apiece is both wasteful and fragile: it multiplies every
// page view by five queries, and a database that hiccups under that burst takes
// out a script rather than an API call, which surfaces as a page stuck on
// "Loading…" rather than an error anyone can read.
//
// So an authorised session is remembered for a few seconds. Long enough to
// collapse a page load into a single lookup, short enough that signing out or
// having a session revoked elsewhere takes effect almost immediately. The cache
// is dropped entirely on any write that invalidates a session, so the delay
// only ever applies to things nobody has touched.
const SESSION_CACHE_MS = 5_000;
const sessionCache = new Map(); // token -> { at, account }

function forgetSession(token) {
  if (token) {
    sessionCache.delete(token);
    sessionInflight.delete(token);
  } else {
    sessionCache.clear();
    sessionInflight.clear();
  }
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_CACHE_MS;
  for (const [token, entry] of sessionCache) {
    if (entry.at < cutoff) sessionCache.delete(token);
  }
}, 30_000).unref();

// Lookups already in flight, so a burst of requests arriving on a cold cache
// asks the database once rather than once each. A page load fires the document,
// the stylesheet, three scripts and several API calls more or less together;
// without this they all miss the cache simultaneously and issue the same query
// in parallel, which is both wasteful and the moment a database under strain is
// most likely to drop one — taking a script with it and leaving the page
// half-loaded with nothing useful on screen.
const sessionInflight = new Map(); // token -> Promise<account|null>

/** A session belonging to a real account — not merely a session. */
async function accountFromRequest(req) {
  const token = req.cookies?.[config.sessionCookie];
  if (!token) return null;

  const cached = sessionCache.get(token);
  if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached.account;

  const pending = sessionInflight.get(token);
  if (pending) return pending;

  const lookup = (async () => {
    const subscriber = await subscriberBySession(token);
    const account = subscriber?.password_hash ? subscriber : null;
    // Negative results are cached too: an expired cookie on a page that keeps
    // retrying should not become a query per retry.
    sessionCache.set(token, { at: Date.now(), account });
    return account;
  })().finally(() => sessionInflight.delete(token));

  sessionInflight.set(token, lookup);
  return lookup;
}

app.use(async (req, res, next) => {
  const path = req.path;
  if (PUBLIC_PATHS.has(path) || PUBLIC_PATTERNS.some((re) => re.test(path))) return next();

  // The database being down must not lock everyone out with a confusing 401 —
  // let the request through to the handlers that explain themselves.
  if (!dbState.ready && path.startsWith('/api/')) return next();

  try {
    const account = await accountFromRequest(req);
    if (account) {
      req.account = account;
      return next();
    }
  } catch (err) {
    return next(err);
  }

  // An API caller wants a status code; a browser wants the login page. Sending
  // a redirect to fetch() would surface as a confusing parse error instead.
  if (path.startsWith('/api/') || req.get('accept')?.includes('application/json')) {
    return res.status(401).json({ error: 'not_signed_in', message: 'Sign in to continue.' });
  }
  const next_ = encodeURIComponent(req.originalUrl);
  return res.redirect(302, `/login?next=${next_}`);
});

app.get('/login', (req, res) => {
  // Already signed in? There is nothing to do here.
  accountFromRequest(req)
    .then((account) => {
      if (account) return res.redirect(302, '/');
      res.sendFile(fileURLToPath(new URL('../public/login.html', import.meta.url)));
    })
    .catch(() => res.sendFile(fileURLToPath(new URL('../public/login.html', import.meta.url))));
});

// Every /api route needs the database. Answer with a clear, actionable error
// instead of a stack trace while it is still coming up.
app.use('/api', (req, res, next) => {
  if (dbState.ready) return next();
  res.status(503).json({
    error: 'database_unavailable',
    message: config.databaseUrl
      ? `Waiting for the database: ${dbState.error ?? 'connecting…'}`
      : 'DATABASE_URL is not set. On Railway, add a variable to this service ' +
        'referencing your Postgres, e.g. DATABASE_URL=${{Postgres.DATABASE_URL}}.',
    configured: Boolean(config.databaseUrl),
  });
});

function setSessionCookie(res, sessionToken) {
  res.cookie(config.sessionCookie, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: 1000 * 60 * 60 * 24 * 180,
  });
}

// --- sites ------------------------------------------------------------------

app.get('/api/sites', async (_req, res, next) => {
  try {
    const sites = await listSites();
    res.json({
      sites: sites.map((s) => ({
        id: s.id,
        origin: s.origin,
        name: s.name,
        currency: s.currency,
        platform: s.platform,
        // What this platform calls the things being watched, so the UI can say
        // "3 categories" for a Shopware store and "3 collections" for Shopify.
        sectionNoun: adapterFor(s.platform)?.sectionNoun ?? 'collection',
        collections: s.collections,
        enabled: s.enabled,
        productCount: s.product_count,
        availableCount: s.available_count,
        lastPolledAt: s.last_polled_at,
        lastError: s.last_error,
        seeded: s.seeded_at !== null,
      })),
      adminRequired: Boolean(config.adminToken),
    });
  } catch (err) {
    next(err);
  }
});

// Probe a URL without saving anything, so the UI can show what it found.
app.post(
  '/api/sites/discover',
  requireAdmin,
  rateLimit({ windowMs: 10 * 60_000, max: 20, key: 'discover' }),
  async (req, res, next) => {
    try {
      const result = await discoverSite(req.body?.url ?? '');
      res.json(result);
    } catch (err) {
      if (err.message && !/^internal/i.test(err.message)) {
        return res.status(400).json({ error: 'discover_failed', message: err.message });
      }
      next(err);
    }
  },
);

app.post(
  '/api/sites',
  requireAdmin,
  rateLimit({ windowMs: 10 * 60_000, max: 10, key: 'add-site' }),
  async (req, res, next) => {
    try {
      const existing = await listSites();
      if (existing.length >= config.maxSites) {
        return res.status(400).json({ error: 'too_many_sites', max: config.maxSites });
      }

      const site = await addSite(req.body ?? {});

      // Seed before responding *if it's quick*, so the UI shows real product
      // counts straight away rather than an empty store until the next tick.
      //
      // But a scraped store is read one listing page at a time, spaced by the
      // crawl delay it asks for: seeding a large store's pre-order sections
      // takes minutes, and no HTTP request survives that — the browser and the
      // platform's edge both give up long before it lands, and the store looks
      // like it failed to add when it is in fact being read perfectly well.
      // So the seed always runs to completion in the background; we just stop
      // waiting on it. pollSite reports failures through site.last_error rather
      // than throwing, so a store that can't be read is still created and shows
      // its error in the list.
      const seeding = pollSite(site).catch((err) => {
        console.error(`[http] background seed of ${site.origin} failed: ${err.message}`);
        return null;
      });

      const result = await Promise.race([
        seeding,
        new Promise((resolve) => setTimeout(() => resolve(PENDING), SEED_WAIT_MS).unref?.()),
      ]);

      res.status(201).json({
        site,
        result: result === PENDING ? null : result,
        // The client polls the store list until this clears.
        seeding: result === PENDING,
      });
    } catch (err) {
      if (err.code === 'duplicate' || err.code === 'no_collections' || err.message) {
        return res.status(400).json({ error: err.code ?? 'add_failed', message: err.message });
      }
      next(err);
    }
  },
);

app.patch('/api/sites/:id', requireAdmin, async (req, res, next) => {
  try {
    const site = await updateSite(Number(req.params.id), req.body ?? {});
    if (!site) return res.status(404).json({ error: 'not_found' });
    res.json({ site });
  } catch (err) {
    if (err.code === 'no_collections') {
      return res.status(400).json({ error: err.code, message: err.message });
    }
    next(err);
  }
});

app.delete('/api/sites/:id', requireAdmin, async (req, res, next) => {
  try {
    const ok = await deleteSite(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/sites/:id/poll', requireAdmin, async (req, res, next) => {
  try {
    const site = await getSite(Number(req.params.id));
    if (!site) return res.status(404).json({ error: 'not_found' });

    // Same reasoning as adding a store: a scraped catalogue takes minutes to
    // read, and no browser holds a request open that long. Awaiting it here
    // made "Refresh" look broken on exactly the stores it was most useful for
    // — the request died, the dialog showed an error, and the poll it started
    // went on to finish perfectly well in the background.
    const polling = pollSite(site).catch((err) => {
      console.error(`[http] manual poll of ${site.origin} failed: ${err.message}`);
      return null;
    });

    const result = await Promise.race([
      polling,
      new Promise((resolve) => setTimeout(() => resolve(PENDING), SEED_WAIT_MS).unref?.()),
    ]);

    res.json({
      result: result === PENDING ? null : result,
      running: result === PENDING,
    });
  } catch (err) {
    next(err);
  }
});

// --- product browsing -------------------------------------------------------

app.get('/api/products', async (req, res, next) => {
  try {
    const { q, status = 'all', vendor, sort = 'title', siteId, type = 'all' } = req.query;
    const limit = Math.min(Number.parseInt(req.query.limit ?? '500', 10) || 500, 1000);
    const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10) || 0, 0);

    const where = ['true'];
    const params = [];

    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      where.push(
        `(lower(p.title) like $${params.length} or lower(coalesce(p.vendor,'')) like $${params.length})`,
      );
    }
    if (status === 'available') where.push('p.available');
    if (status === 'unavailable') where.push('not p.available');
    if (type === 'preorder') where.push('p.is_preorder');
    if (type === 'instock') where.push('not p.is_preorder');
    if (vendor) {
      params.push(vendor);
      where.push(`p.vendor = $${params.length}`);
    }
    if (siteId) {
      params.push(Number(siteId));
      where.push(`p.site_id = $${params.length}`);
    }

    // The watchlist as a filter rather than a separate screen, so the store
    // dropdown, search and sort all keep working over it. Resolved from the
    // session here rather than trusted from the query — a caller must not be
    // able to read somebody else's list by guessing an id.
    if (req.query.watched === '1') {
      const subscriber = await subscriberBySession(req.cookies?.[config.sessionCookie]);
      if (!subscriber) return res.json({ products: [], totals: null, signedIn: false });
      params.push(subscriber.id);
      where.push(
        `exists (select 1 from watches w
                  where w.product_id = p.id and w.subscriber_id = $${params.length})`,
      );
    }

    const orderBy =
      {
        title: 'p.title asc',
        newest: 'coalesce(p.published_at, p.first_seen_at) desc',
        price_asc: 'p.price asc nulls last',
        price_desc: 'p.price desc nulls last',
      }[sort] ?? 'p.title asc';

    params.push(limit, offset);
    const { rows } = await query(
      `select p.id, p.external_id, p.handle, p.url, p.title, p.vendor, p.image_url, p.price,
              p.available, p.is_preorder, p.published_at, p.became_available_at,
              p.collections, p.site_id, s.name as site_name, s.origin as site_origin,
              s.currency
         from products p
         join sites s on s.id = p.site_id
        where ${where.join(' and ')}
        order by p.available asc, ${orderBy}
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );

    const totalParams = siteId ? [Number(siteId)] : [];
    const { rows: totals } = await query(
      `select count(*)::int as total,
              count(*) filter (where available)::int as available,
              count(*) filter (where is_preorder)::int as preorders,
              count(*) filter (where is_preorder and available)::int as preorders_open,
              count(*) filter (where not is_preorder and available)::int as in_stock
         from products ${siteId ? 'where site_id = $1' : ''}`,
      totalParams,
    );

    // Indicative conversion so a CAD price can show a USD figure beside it.
    await getRates().catch(() => {});

    res.json({
      // url is stored per product: only Shopify's is derivable from the handle.
      products: rows,
      totals: totals[0],
      fx: ratesFor(rows.map((p) => p.currency)),
      appName: config.appName,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/events', async (req, res, next) => {
  try {
    // `since` lets a client poll for what it has not seen instead of pulling
    // the last 50 every few seconds and discarding most of them.
    const sinceId = Number.parseInt(req.query.since ?? '', 10);
    const items = await getFeedItems({
      types: parseTypes(req.query.type),
      sinceId: Number.isFinite(sinceId) && sinceId > 0 ? sinceId : null,
      limit: Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200),
    });
    // The newest id, so a caller can resume from here without re-deriving it.
    res.json({ events: items, latestId: items[0]?.id ?? (sinceId || null) });
  } catch (err) {
    next(err);
  }
});

// --- verification + session -------------------------------------------------

// Both verification routes refuse outright when SMS is off, rather than
// reaching Twilio and surfacing whatever it says about a setup nobody is using.
function requireSms(_req, res, next) {
  if (!config.smsEnabled) {
    return res.status(404).json({
      error: 'sms_disabled',
      message: 'Texting is off. Alerts are delivered by push notification.',
    });
  }
  next();
}

app.post(
  '/api/verify/start',
  requireSms,
  rateLimit({ windowMs: 15 * 60_000, max: 10, key: 'verify-start' }),
  async (req, res, next) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!phone) return res.status(400).json({ error: 'invalid_phone' });

      const { code, retryAfter } = await startVerification(phone);
      if (retryAfter) return res.status(429).json({ error: 'cooldown', retryAfter });

      const result = await sendSms(phone, verificationMessage(code));
      if (!result.ok) {
        // The code never reached the carrier, so don't hold the caller to the
        // resend cooldown for a message they never got.
        await clearVerificationCooldown(phone);

        // Never 502 here: that is indistinguishable from the platform's own
        // gateway errors and sends you hunting the wrong problem.
        const failure = describeSmsFailure(result);
        return res.status(failure.status).json({
          error: 'sms_failed',
          message: failure.message,
          twilioCode: result.code ?? null,
        });
      }

      res.json({ ok: true, phone, ttlMinutes: config.verification.codeTtlMinutes });
    } catch (err) {
      next(err);
    }
  },
);

app.post(
  '/api/verify/check',
  requireSms,
  rateLimit({ windowMs: 15 * 60_000, max: 20, key: 'verify-check' }),
  async (req, res, next) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!phone) return res.status(400).json({ error: 'invalid_phone' });

      // Whoever is here already — possibly an anonymous watcher with a list
      // built before they decided they wanted texts.
      const existing = await subscriberBySession(req.cookies?.[config.sessionCookie]);

      const result = await checkVerification(phone, req.body?.code ?? '');
      if (result.error) return res.status(400).json(result);

      if (existing && !existing.phone) {
        await absorbAnonymous(existing.id, result.subscriber.id);
      }

      forgetSession(req.cookies?.[config.sessionCookie]);
      setSessionCookie(res, result.session);
      const watches = await getWatchedProductIds(result.subscriber.id);
      res.json({
        ok: true,
        phone,
        watches,
        feedToken: result.subscriber.feed_token,
        keyword: result.subscriber.keyword ?? '',
        notify: await getWatchSettings(result.subscriber.id),
      });
    } catch (err) {
      next(err);
    }
  },
);

app.get('/api/me', async (req, res, next) => {
  try {
    const subscriber = await subscriberBySession(req.cookies?.[config.sessionCookie]);
    if (!subscriber) return res.json({ signedIn: false, watches: [], notify: {} });
    res.json({
      // "Signed in" now means a verified phone, which is what actually gates
      // anything. A session without one still carries a watchlist.
      signedIn: Boolean(subscriber.verified && subscriber.phone),
      phone: subscriber.phone,
      username: subscriber.username ?? null,
      hasAccount: Boolean(subscriber.password_hash),
      // What this deployment offers, so the UI never presents a channel that
      // cannot work here.
      smsEnabled: config.smsEnabled,
      push: {
        enabled: Boolean(subscriber.ntfy_enabled && subscriber.ntfy_topic),
        topic: subscriber.ntfy_topic ?? null,
        url: subscriber.ntfy_topic ? topicUrl(subscriber.ntfy_topic) : null,
        server: config.ntfy.server,
      },
      feedToken: subscriber.feed_token,
      keyword: subscriber.keyword ?? '',
      watches: await getWatchedProductIds(subscriber.id),
      notify: await getWatchSettings(subscriber.id),
      match: await buildMatchString(subscriber.id),
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/watches', withSubscriber, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    const saved = await setWatches(req.subscriber.id, ids);
    res.json({
      ok: true,
      watches: saved,
      max: config.maxWatchesPerSubscriber,
      match: await buildMatchString(req.subscriber.id),
    });
  } catch (err) {
    next(err);
  }
});

// --- accounts ---------------------------------------------------------------
//
// Accounts are created from the command line (`npm run useradd`), never over
// HTTP: there is no sign-up. Removing the button would not have been enough —
// the endpoint behind it was the thing that let anyone in, so it is gone.
// Signing in and changing your own password are all that remain.

app.post(
  '/api/login',
  // Deliberately tight: this is the endpoint worth guessing against.
  rateLimit({ windowMs: 15 * 60_000, max: 10, key: 'login' }),
  async (req, res, next) => {
    try {
      // Whoever is watching in this browser already, so a list built before
      // logging in is not stranded on a session that is about to be replaced.
      const anonymous = await subscriberBySession(req.cookies?.[config.sessionCookie]);

      const result = await authenticate(req.body?.username, req.body?.password);
      if (!result) {
        // One message for both failures: saying which was wrong confirms
        // whether a username exists.
        return res.status(401).json({
          error: 'bad_credentials',
          message: 'That username and password do not match.',
        });
      }

      if (anonymous && !anonymous.username && anonymous.id !== result.subscriber.id) {
        await absorbAnonymous(anonymous.id, result.subscriber.id);
      }

      forgetSession(req.cookies?.[config.sessionCookie]);
      setSessionCookie(res, result.session);
      res.json({
        ok: true,
        username: result.subscriber.username,
        phone: result.subscriber.phone,
        feedToken: result.subscriber.feed_token,
        keyword: result.subscriber.keyword ?? '',
        watches: await getWatchedProductIds(result.subscriber.id),
        notify: await getWatchSettings(result.subscriber.id),
      });
    } catch (err) {
      next(err);
    }
  },
);

app.put(
  '/api/password',
  requireSubscriber,
  rateLimit({ windowMs: 60 * 60_000, max: 10, key: 'password' }),
  async (req, res, next) => {
    try {
      const problem = passwordProblem(req.body?.newPassword);
      if (problem) return res.status(400).json({ error: 'bad_password', message: problem });

      const result = await changePassword(
        req.subscriber,
        req.body?.currentPassword ?? '',
        req.body?.newPassword,
      );
      if (result.error === 'no_account') {
        return res.status(400).json({
          error: result.error,
          message: 'This session has no username and password yet.',
        });
      }
      if (result.error === 'wrong_password') {
        return res.status(403).json({
          error: result.error,
          message: 'That is not your current password.',
        });
      }

      // Changing a password is how you lock out someone who has yours, so every
      // cached session is dropped, not just this browser's — otherwise theirs
      // would keep working for the lifetime of the cache entry. Clearing the
      // whole map is cheap and cannot miss one.
      forgetSession();
      setSessionCookie(res, result.session);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// --- push notifications -----------------------------------------------------
//
// The free alternative to texting: no per-message cost, no carrier deciding
// whether an alert looks like spam, and no phone number handed over. It sits
// beside SMS rather than replacing it — a text needs nothing installed and
// arrives on any phone with signal, so both are worth having.

app.get('/api/push', requireSubscriber, (req, res) => {
  const topic = req.subscriber.ntfy_topic;
  res.json({
    enabled: Boolean(req.subscriber.ntfy_enabled && topic),
    topic: topic ?? null,
    // What to paste into the app, and what to open to check it works.
    url: topic ? topicUrl(topic) : null,
    server: config.ntfy.server,
  });
});

app.put('/api/push', requireSubscriber, async (req, res, next) => {
  try {
    const state = await setPushEnabled(req.subscriber.id, req.body?.enabled);
    if (!state) return res.status(404).json({ error: 'not_found' });

    // Prove it end to end on the way in. Being told "push is on" and then
    // hearing nothing for a week is the failure mode worth designing out.
    let delivered = null;
    if (state.ntfy_enabled && state.ntfy_topic) {
      const result = await sendPush(state.ntfy_topic, testPush());
      delivered = result.ok;
      if (!result.ok) {
        return res.status(502).json({
          error: 'push_failed',
          message: result.error,
          topic: state.ntfy_topic,
          url: topicUrl(state.ntfy_topic),
        });
      }
    }

    res.json({
      ok: true,
      enabled: state.ntfy_enabled,
      topic: state.ntfy_topic,
      url: state.ntfy_topic ? topicUrl(state.ntfy_topic) : null,
      server: config.ntfy.server,
      delivered,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/push/rotate', requireSubscriber, async (req, res, next) => {
  try {
    const state = await rotatePushTopic(req.subscriber.id);
    if (!state) return res.status(404).json({ error: 'not_found' });
    res.json({
      ok: true,
      enabled: state.ntfy_enabled,
      topic: state.ntfy_topic,
      url: topicUrl(state.ntfy_topic),
      server: config.ntfy.server,
    });
  } catch (err) {
    next(err);
  }
});

// --- standing alerts --------------------------------------------------------
//
// One term per row, each with two switches: notify (push/SMS) and autobuy
// (offer the match to the buyer userscript). They are separate because the
// useful combinations differ — a broad term like "pokemon" is worth being told
// about but not worth arming a buyer for; an exact set code like "OP-17" is the
// reverse, since you already know you want it and the seconds matter.

app.get('/api/alerts', requireSubscriber, async (req, res, next) => {
  try {
    res.json({ alerts: await listAlerts(req.subscriber.id) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/alerts', requireSubscriber, async (req, res, next) => {
  try {
    const result = await addAlert(req.subscriber.id, req.body?.term, {
      notify: req.body?.notify ?? true,
      autobuy: req.body?.autobuy ?? false,
    });

    const problems = {
      empty: [400, 'Type something to alert on.'],
      unusable: [400, 'That has no letters or numbers to match on.'],
      duplicate: [409, 'You are already alerting on that.'],
      too_many: [400, `That is the most alerts one account can have (${result.max}).`],
    };
    if (result.error) {
      const [status, message] = problems[result.error] ?? [400, 'That alert could not be added.'];
      return res.status(status).json({ error: result.error, message });
    }

    res.status(201).json({
      alert: result.alert,
      match: await buildMatchString(req.subscriber.id),
    });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/alerts/:id', requireSubscriber, async (req, res, next) => {
  try {
    const alert = await updateAlert(req.subscriber.id, Number(req.params.id), {
      notify: req.body?.notify,
      autobuy: req.body?.autobuy,
    });
    if (!alert) return res.status(404).json({ error: 'not_found' });
    res.json({ alert, match: await buildMatchString(req.subscriber.id) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/alerts/:id', requireSubscriber, async (req, res, next) => {
  try {
    const ok = await deleteAlert(req.subscriber.id, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, match: await buildMatchString(req.subscriber.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * What the buyer userscript should act on.
 *
 * Matching happens here rather than in the script, so there is one definition
 * of what counts and it is the one you can see and edit in the UI. Each match
 * is handed over once: claiming it removes it from the queue, so a script that
 * restarts does not re-open everything it has already dealt with.
 */
app.get('/api/dispatch', requireSubscriber, async (req, res, next) => {
  try {
    const { rows } = await query(
      `select d.event_id, d.term, e.title, e.url, e.price, e.type, e.image_url,
              s.currency
         from dispatches d
         join events e on e.id = d.event_id
         join products p on p.id = e.product_id
         join sites s on s.id = p.site_id
        where d.subscriber_id = $1
        order by d.event_id asc
        limit 25`,
      [req.subscriber.id],
    );
    res.json({ matches: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * Take a set of matches off the queue and get, for each, a URL that arms the
 * buyer script.
 *
 * The nonce in that URL is the authority to act. It is minted here rather than
 * in the browser because the thing opening the tab is an agent outside it, and
 * it is single-use and short-lived because it is doing the job a session would
 * otherwise do — a link that stays armed is a link that buys something the
 * second time it is opened.
 */
app.post('/api/dispatch/claim', requireSubscriber, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.eventIds)
      ? req.body.eventIds.map(Number).filter(Number.isFinite)
      : [];
    if (!ids.length) return res.json({ ok: true, claimed: 0, tickets: [] });

    const { rows: claimed } = await query(
      `delete from dispatches d
        where d.subscriber_id = $1 and d.event_id = any($2::bigint[])
        returning d.event_id, d.term`,
      [req.subscriber.id, ids],
    );
    if (!claimed.length) return res.json({ ok: true, claimed: 0, tickets: [] });

    const { rows: details } = await query(
      `select e.id as event_id, e.title, e.url, e.price
         from events e where e.id = any($1::bigint[])`,
      [claimed.map((c) => c.event_id)],
    );
    const byEvent = new Map(details.map((d) => [d.event_id, d]));

    const tickets = [];
    for (const { event_id, term } of claimed) {
      const detail = byEvent.get(event_id);
      if (!detail) continue;
      const nonce = token(24);
      await query(
        `insert into tickets (nonce, subscriber_id, event_id, url, title, price, term)
           values ($1,$2,$3,$4,$5,$6,$7)`,
        [nonce, req.subscriber.id, event_id, detail.url, detail.title, detail.price, term],
      );
      tickets.push({
        eventId: event_id,
        term,
        title: detail.title,
        price: detail.price,
        url: detail.url,
        // What the agent actually opens. The fragment survives the navigation
        // and is not sent to the store in the request.
        armedUrl: `${detail.url}#pwbuy=${nonce}`,
      });
    }

    res.json({ ok: true, claimed: claimed.length, tickets });
  } catch (err) {
    next(err);
  }
});

/**
 * Redeem a ticket. Deliberately unauthenticated: the buyer script runs on a
 * storefront page, and requiring a session here would mean sending this app's
 * cookie cross-site — which would mean relaxing SameSite for every request, a
 * bad trade for one endpoint. The nonce is unguessable, single-use and expires,
 * so holding one is the proof.
 */
app.post(
  '/api/tickets/claim',
  rateLimit({ windowMs: 60_000, max: 60, key: 'ticket-claim' }),
  async (req, res, next) => {
    try {
      const nonce = String(req.body?.nonce ?? '');
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        return res.status(400).json({ error: 'bad_nonce' });
      }

      // Expired tickets are swept here rather than on a timer: the table only
      // grows when matches are handed out, so this is the moment it matters.
      await query(
        `delete from tickets where created_at < now() - ($1 || ' milliseconds')::interval`,
        [String(TICKET_TTL_MS)],
      ).catch(() => {});

      const { rows } = await query(
        'delete from tickets where nonce = $1 returning url, title, price, term',
        [nonce],
      );
      if (!rows.length) return res.status(404).json({ error: 'no_ticket' });

      res.json({ ok: true, ...rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Notifications for one watched product. Turning it *on* is the only place a
 * delivery channel is actually required — which is the point of keeping
 * watching and being notified separate.
 */
app.patch('/api/watches/:productId', withSubscriber, async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isFinite(productId)) return res.status(400).json({ error: 'bad_product' });

    // Notifying needs somewhere to send to; arming the buyer does not, because
    // that is collected by the userscript rather than delivered anywhere.
    if (req.body?.notify === true) {
      const canText = req.subscriber.verified && req.subscriber.phone;
      const canPush = req.subscriber.ntfy_enabled && req.subscriber.ntfy_topic;
      if (!canText && !canPush) {
        return res.status(403).json({
          error: 'no_channel',
          message: config.smsEnabled
            ? 'Turn on push notifications or add a phone number first.'
            : 'Turn on push notifications first — Account, then Push notifications.',
        });
      }
    }

    const watch = await setWatchSettings(req.subscriber.id, productId, {
      notify: req.body?.notify,
      autobuy: req.body?.autobuy,
    });
    if (!watch) return res.status(404).json({ error: 'not_watched' });
    res.json({ ok: true, watch, match: await buildMatchString(req.subscriber.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * The MATCH line for the buyer userscript, rebuilt from whatever is currently
 * armed. Returned by every route that can change it as well, so the copyable
 * text on the page is never a step behind what it describes.
 */
app.get('/api/match', requireSubscriber, async (req, res, next) => {
  try {
    res.json({ match: await buildMatchString(req.subscriber.id) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/signout', (req, res) => {
  forgetSession(req.cookies?.[config.sessionCookie]);
  res.clearCookie(config.sessionCookie);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', requireSubscriber, async (req, res, next) => {
  try {
    await unsubscribe(req.subscriber.id);
    forgetSession(req.cookies?.[config.sessionCookie]);
    res.clearCookie(config.sessionCookie);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- RSS --------------------------------------------------------------------

// Feeds go out as text/xml, not application/rss+xml.
//
// Both are valid for RSS and every reader accepts either, but a browser only
// applies an xml-stylesheet instruction to a document it treats as plain XML —
// under application/rss+xml Chrome skips the stylesheet and prints the source.
// Verified with the identical document served both ways: text/xml renders,
// application/rss+xml does not. The <link rel="alternate"> autodiscovery tag
// and atom:link still advertise application/rss+xml, which is what those are
// for; this is only the response header.
app.get('/feed.xml', async (req, res, next) => {
  try {
    const siteId = req.query.site ? Number(req.query.site) : null;
    const site = siteId ? await getSite(siteId) : null;
    const items = await getFeedItems({
      types: parseTypes(req.query.type),
      siteId: site?.id,
      limit: 100,
    });

    res.type('text/xml').send(
      renderRss({
        items,
        title: site ? `${site.name} restocks` : `${config.appName} restocks`,
        description: site
          ? `Pre-orders that became buyable at ${site.name}.`
          : 'Pre-orders that became buyable across every watched store.',
        selfUrl: `${config.publicUrl}/feed.xml${site ? `?site=${site.id}` : ''}`,
      }),
    );
  } catch (err) {
    next(err);
  }
});

app.get('/feed/:token.xml', async (req, res, next) => {
  try {
    const subscriber = await subscriberByFeedToken(req.params.token);
    if (!subscriber) return res.status(404).type('text/plain').send('Unknown feed token');

    const items = await getFeedItems({
      types: parseTypes(req.query.type),
      feedToken: subscriber.feed_token,
      limit: 100,
    });

    res.type('text/xml').send(
      renderRss({
        items,
        title: `My ${config.appName} watchlist`,
        description: 'Restocks for the pre-orders on your watchlist.',
        selfUrl: `${config.publicUrl}/feed/${subscriber.feed_token}.xml`,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// --- Twilio inbound (STOP / START) -----------------------------------------

app.post(
  '/twilio/inbound',
  express.urlencoded({ extended: false }),
  (req, res, next) => {
    // Twilio signs every webhook; reject anything we can't verify.
    if (!config.twilio.enabled) return next();
    const signature = req.get('x-twilio-signature');
    const url = `${config.publicUrl}${req.originalUrl}`;
    if (!twilio.validateRequest(config.twilio.authToken, signature, url, req.body)) {
      return res.status(403).type('text/plain').send('Bad signature');
    }
    next();
  },
  async (req, res, next) => {
    try {
      const from = normalizePhone(req.body?.From);
      const body = String(req.body?.Body ?? '').trim().toUpperCase();

      if (from && /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(body)) {
        await query(
          'update subscribers set unsubscribed_at = now(), session_token = null where phone = $1',
          [from],
        );
      } else if (from && /^(START|UNSTOP|YES)$/.test(body)) {
        await query('update subscribers set unsubscribed_at = null where phone = $1', [from]);
      }

      // Twilio's Advanced Opt-Out already replies to STOP; stay quiet.
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (err) {
      next(err);
    }
  },
);

// --- ops --------------------------------------------------------------------

// Ask Twilio what is misconfigured. Reports findings, never secrets.
app.get('/twilio/diagnose', requireAdmin, async (_req, res) => {
  try {
    res.json(await diagnoseTwilio());
  } catch (err) {
    res.status(500).json({ error: 'diagnose_failed', message: err.message });
  }
});

// Liveness. Always 200 while the process is serving — a 503 here makes Railway
// mark the whole deploy failed, which is wrong when the only problem is an
// unset variable the deploy itself can't fix. The database state is reported in
// the body, and /readyz is the strict check.
app.get('/healthz', async (req, res) => {
  // Public by necessity — a gated health check fails deploys — so it says only
  // whether the process is serving and whether the database is reachable.
  //
  // It used to return the whole poller state: every store's name, origin, the
  // handles of each watched section, and the text of any error. That is a
  // description of what this instance watches, published to anyone who asks,
  // on a site whose whole point is that nothing is readable without signing in.
  const summary = {
    ok: true,
    database: { configured: Boolean(config.databaseUrl), ready: dbState.ready },
  };

  // The detail is still here for whoever is entitled to it.
  const account = await accountFromRequest(req).catch(() => null);
  if (!account) return res.json(summary);

  res.json({
    ...summary,
    database: {
      ...summary.database,
      error: dbState.error,
      attempts: dbState.attempts,
    },
    poller: pollerState,
    sms: config.smsEnabled ? (config.twilio.enabled ? 'configured' : 'misconfigured') : 'off',
    push: config.ntfy.server,
    adminLocked: Boolean(config.adminToken),
  });
});

// Readiness: 200 only when the database is actually usable.
app.get('/readyz', async (_req, res) => {
  try {
    await query('select 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Served explicitly rather than left to the static handler's guess. A browser
// only applies an XSLT stylesheet when it arrives with an XML content type, and
// getting that wrong doesn't warn — the feed just renders as raw markup again.
app.get('/feed.xsl', (_req, res) => {
  res.type('text/xsl').sendFile(fileURLToPath(new URL('../public/feed.xsl', import.meta.url)));
});

// No max-age on the app's own files.
//
// They were cached for five minutes, which means every deploy is followed by
// five minutes of browsers running the previous version against the new server
// — an upgrade that appears not to have happened, or worse, half happened.
// These are a few tens of kilobytes; the ETag express.static already sends
// makes an unchanged file a 304 with no body, which is cheap enough that
// buying five minutes of staleness for it is a bad trade.
app.use(
  express.static(fileURLToPath(new URL('../public', import.meta.url)), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      // Images and the stylesheet for the feed change rarely and are not
      // versioned against the API, so they can be held briefly.
      const cacheable = /\.(png|jpe?g|gif|svg|webp|ico)$/i.test(filePath);
      res.setHeader('cache-control', cacheable ? 'public, max-age=3600' : 'no-cache');
    },
  }),
);

app.use((err, _req, res, _next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'internal_error' });
});

/**
 * Create or refresh the account named by ADMIN_USERNAME / ADMIN_PASSWORD.
 *
 * Without this, deploying the login gate with no account in the database locks
 * the operator out of their own site, and the only way back in is a shell on
 * the running service. Setting two variables is something every platform can
 * do from its dashboard.
 */
async function createBootstrapAccount() {
  if (!config.bootstrap.enabled) {
    const { rows } = await query(
      'select count(*)::int as n from subscribers where username is not null',
    ).catch(() => ({ rows: [{ n: 1 }] }));
    if (!rows[0].n) {
      console.warn(
        '[boot] There are no accounts and the site requires a login. Create one with ' +
          '`npm run useradd <username>`, or set ADMIN_USERNAME and ADMIN_PASSWORD and restart.',
      );
    }
    return;
  }

  try {
    const result = await ensureBootstrapAccount(config.bootstrap);
    if (result.error === 'bad_username') {
      console.error('[boot] ADMIN_USERNAME is not a valid username; no account was created.');
    } else if (result.error === 'bad_password') {
      console.error('[boot] ADMIN_PASSWORD is too short (8 characters minimum).');
    } else {
      console.log(
        `[boot] ${result.created ? 'created' : 'updated'} account "${result.username}" ` +
          'from ADMIN_USERNAME/ADMIN_PASSWORD. Clear those variables once you can sign in.',
      );
    }
  } catch (err) {
    console.error(`[boot] could not apply ADMIN_USERNAME/ADMIN_PASSWORD: ${err.message}`);
  }
}

/** Optionally create a store on first boot so a fresh deploy isn't empty. */
async function seedFirstSite() {
  if (!config.seedSite) return;
  const existing = await listSites();
  if (existing.length) return;
  try {
    const site = await addSite({
      url: config.seedSite.url,
      collections: config.seedSite.collections,
    });
    console.log(`[boot] seeded store ${site.name} (${site.origin})`);
  } catch (err) {
    console.error(`[boot] could not seed ${config.seedSite.url}: ${err.message}`);
  }
}

// Bind the port first and unconditionally. Whatever is misconfigured, the
// deploy comes up and can explain itself rather than crash-looping.
const server = app.listen(config.port, () => {
  console.log(`[http] listening on :${config.port} (public: ${config.publicUrl})`);
  startFx();

  // Keep retrying in the background; the poller starts once the schema is in.
  initDb({
    onReady: async () => {
      await createBootstrapAccount();
      await seedFirstSite();
      startPoller();
    },
  }).catch((err) => console.error('[boot] database init failed:', err));
});

server.on('error', (err) => {
  console.error(`[http] could not listen on :${config.port}: ${err.message}`);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[boot] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

export { app, runPoll };
