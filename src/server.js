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
import { PASSWORD_RULES, USERNAME_RULES, passwordProblem } from './auth.js';
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
  createAnonymousSubscriber,
  getWatchNotifyMap,
  getWatchedProductIds,
  normalizePhone,
  registerAccount,
  setKeyword,
  setWatchNotify,
  setWatches,
  startVerification,
  subscriberByFeedToken,
  subscriberBySession,
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
  const subscriber = await subscriberBySession(req.cookies?.[config.sessionCookie]);
  if (!subscriber) return res.status(401).json({ error: 'not_signed_in' });
  req.subscriber = subscriber;
  next();
}

// Store management is gated only when ADMIN_TOKEN is set, so the app is usable
// out of the box but can be locked down before the URL is shared.
function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();
  const provided = req.get('x-admin-token') || req.query.admin_token;
  if (provided !== config.adminToken) return res.status(401).json({ error: 'admin_required' });
  next();
}

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

app.post(
  '/api/verify/start',
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

      setSessionCookie(res, result.session);
      const watches = await getWatchedProductIds(result.subscriber.id);
      res.json({
        ok: true,
        phone,
        watches,
        feedToken: result.subscriber.feed_token,
        keyword: result.subscriber.keyword ?? '',
        notify: await getWatchNotifyMap(result.subscriber.id),
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
      feedToken: subscriber.feed_token,
      keyword: subscriber.keyword ?? '',
      watches: await getWatchedProductIds(subscriber.id),
      notify: await getWatchNotifyMap(subscriber.id),
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/watches', withSubscriber, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    const saved = await setWatches(req.subscriber.id, ids);
    res.json({ ok: true, watches: saved, max: config.maxWatchesPerSubscriber });
  } catch (err) {
    next(err);
  }
});

// --- accounts ---------------------------------------------------------------
//
// A username and password is the way to reach a watchlist from another browser
// without a phone number being involved. It sits alongside the phone rather
// than replacing it: the phone is for texting, this is for identity.

app.post(
  '/api/register',
  withSubscriber,
  rateLimit({ windowMs: 60 * 60_000, max: 10, key: 'register' }),
  async (req, res, next) => {
    try {
      const problem = passwordProblem(req.body?.password);
      if (problem) return res.status(400).json({ error: 'bad_password', message: problem });

      if (req.subscriber.username) {
        return res.status(400).json({
          error: 'already_registered',
          message: 'This session already has an account. Sign out first.',
        });
      }

      const result = await registerAccount(req.subscriber, req.body?.username, req.body?.password);
      if (result.error === 'bad_username') {
        return res.status(400).json({ error: result.error, message: USERNAME_RULES });
      }
      if (result.error === 'username_taken') {
        return res.status(409).json({ error: result.error, message: 'That username is taken.' });
      }

      res.json({ ok: true, username: result.subscriber.username });
    } catch (err) {
      next(err);
    }
  },
);

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

      setSessionCookie(res, result.session);
      res.json({
        ok: true,
        username: result.subscriber.username,
        phone: result.subscriber.phone,
        feedToken: result.subscriber.feed_token,
        keyword: result.subscriber.keyword ?? '',
        watches: await getWatchedProductIds(result.subscriber.id),
        notify: await getWatchNotifyMap(result.subscriber.id),
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

      // The old session was just invalidated; keep *this* browser signed in.
      setSessionCookie(res, result.session);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The standing alert: text me about anything matching this, watchlist or not.
 * Stored as typed; `terms` comes back so the UI can show what will actually be
 * matched on, which is not always what someone thinks they typed.
 */
app.put('/api/keyword', requireSubscriber, async (req, res, next) => {
  try {
    const saved = await setKeyword(req.subscriber.id, req.body?.keyword ?? '');
    res.json({ ok: true, ...saved });
  } catch (err) {
    next(err);
  }
});

/**
 * Texting for one watched product. Turning it *on* is the only place a phone
 * number is actually required — which is the point of splitting the two.
 */
app.put('/api/watches/:productId/notify', withSubscriber, async (req, res, next) => {
  try {
    const notify = Boolean(req.body?.notify);
    const productId = Number(req.params.productId);
    if (!Number.isFinite(productId)) return res.status(400).json({ error: 'bad_product' });

    if (notify && !(req.subscriber.verified && req.subscriber.phone)) {
      return res.status(403).json({
        error: 'verification_required',
        message: 'Add a phone number to be texted about this.',
      });
    }

    const ok = await setWatchNotify(req.subscriber.id, productId, notify);
    if (!ok) return res.status(404).json({ error: 'not_watched' });
    res.json({ ok: true, productId, notify });
  } catch (err) {
    next(err);
  }
});

app.post('/api/signout', (req, res) => {
  res.clearCookie(config.sessionCookie);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', requireSubscriber, async (req, res, next) => {
  try {
    await unsubscribe(req.subscriber.id);
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
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    database: {
      configured: Boolean(config.databaseUrl),
      ready: dbState.ready,
      error: dbState.error,
      attempts: dbState.attempts,
    },
    poller: pollerState,
    twilio: config.twilio.enabled ? 'configured' : 'dry-run',
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

app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: '5m' }));

app.use((err, _req, res, _next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'internal_error' });
});

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
