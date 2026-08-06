import { config } from './config.js';
import { query, transaction } from './db.js';
import { fetchSiteProducts } from './discover.js';
import { enabledSites, getSite } from './sites.js';
import { compileAlert } from './match.js';
import { keywordMessage, restockMessage, sendSms } from './notify.js';
import { formatPrice } from './money.js';
import { restockPush, sendPush } from './push.js';

let running = false;
let timer = null;

/**
 * Per-store backoff.
 *
 * Polling continuously means a store that is happy to be read gets read as
 * often as it can answer — but one that starts pushing back must be left alone,
 * or we keep hammering it until the app is blocked outright and every alert
 * stops. A store that answers 429/503 gets an exponentially growing rest,
 * cleared the moment it serves a good response again.
 */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const backoff = new Map(); // siteId -> { until, failures }

// Every one of these means "you are asking too often" or "I am overloaded".
// Matched anywhere in the message, because a failure is usually reported
// wrapped in context about which section it came from.
const RATE_LIMITED = /\bresponded (429|430|500|502|503|504)\b|too many requests/i;

function noteFailure(site, message) {
  if (!RATE_LIMITED.test(message)) return;
  const previous = backoff.get(site.id)?.failures ?? 0;
  const failures = previous + 1;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  backoff.set(site.id, { until: Date.now() + wait, failures });
  console.warn(
    `[poll] ${site.name} asked us to slow down (${message}); backing off ${Math.round(wait / 1000)}s`,
  );
}

function noteSuccess(siteId) {
  backoff.delete(siteId);
}

function restingUntil(siteId) {
  const entry = backoff.get(siteId);
  if (!entry) return 0;
  if (Date.now() >= entry.until) return 0;
  return entry.until;
}

export const pollerState = {
  lastRunAt: null,
  lastError: null,
  lastDurationMs: null,
  sites: [],
};

/**
 * Fetch one site, write the new state, and return the products that just
 * flipped from unbuyable to buyable. Everything happens in one transaction so a
 * crash mid-write can't leave us having recorded a restock we never sent.
 */
async function syncSite(site) {
  const { products: fetched, errors } = await fetchSiteProducts(site);

  // Postgres refuses an ON CONFLICT statement whose source rows collide with
  // each other, so a duplicate external id would fail the whole write rather
  // than one product. Both adapters key by external id already; this makes that
  // a guarantee of the write path rather than of every future adapter.
  const products = [...new Map(fetched.map((p) => [p.externalId, p])).values()];

  if (!products.length) {
    // Carry the underlying failures, not just which sections failed.
    //
    // This used to report only the collection names, which threw away the HTTP
    // status — and the backoff decides whether to rest a store by looking for
    // one. So a store answering 429 to every request looked like an ordinary
    // empty result, no backoff was applied, and it went on being polled at full
    // speed indefinitely: exactly the runaway the backoff exists to prevent.
    const detail = errors.length
      ? errors.map((e) => `${e.collection}: ${e.message}`).join('; ')
      : 'unknown cause';
    throw new Error(`no products returned (${detail})`);
  }

  return transaction(async (client) => {
    // A site is seeded the first time it is polled. Until then every product
    // looks "new", and emitting hundreds of events nobody asked for is noise.
    const seeding = site.seeded_at === null;

    const { rows: previous } = await client.query(
      'select external_id, available from products where site_id = $1 and external_id = any($2::text[])',
      [site.id, products.map((p) => p.externalId)],
    );
    const wasAvailable = new Map(previous.map((r) => [r.external_id, r.available]));

    // Every product in one statement rather than one statement per product.
    // A store polled once a second with a 250-product catalogue would otherwise
    // put 250 round trips a second on the database, per store, forever — which
    // is what actually limits how fast this can poll, long before the stores do.
    const { rows: written } = await client.query(
      `insert into products (site_id, external_id, handle, url, title, vendor, product_type,
                             image_url, price, available, collections, published_at,
                             is_preorder, last_seen_at, became_available_at)
       select $1, x.external_id, x.handle, x.url, x.title, x.vendor, x.product_type,
              x.image_url, x.price, x.available, x.collections, x.published_at,
              x.is_preorder, now(),
              case when x.available then now() else null end
         from jsonb_to_recordset($2::jsonb) as x(
                external_id  text,
                handle       text,
                url          text,
                title        text,
                vendor       text,
                product_type text,
                image_url    text,
                price        numeric,
                available    boolean,
                collections  text[],
                published_at timestamptz,
                is_preorder  boolean)
       on conflict (site_id, external_id) do update set
         handle       = excluded.handle,
         url          = excluded.url,
         title        = excluded.title,
         vendor       = excluded.vendor,
         product_type = excluded.product_type,
         image_url    = excluded.image_url,
         price        = excluded.price,
         available    = excluded.available,
         is_preorder  = excluded.is_preorder,
         collections  = excluded.collections,
         published_at = excluded.published_at,
         last_seen_at = now(),
         became_available_at = case
           when excluded.available and not products.available then now()
           else products.became_available_at
         end
       returning id, external_id`,
      [
        site.id,
        JSON.stringify(
          products.map((p) => ({
            external_id: p.externalId,
            handle: p.handle,
            url: p.url,
            title: p.title,
            vendor: p.vendor,
            product_type: p.productType,
            image_url: p.imageUrl,
            price: p.price,
            available: p.available,
            collections: p.collections,
            published_at: p.publishedAt,
            is_preorder: p.isPreorder,
          })),
        ),
      ],
    );

    const idByExternal = new Map(written.map((r) => [r.external_id, r.id]));

    const restocked = [];
    const appeared = [];
    const soldOut = [];

    if (!seeding) {
      for (const p of products) {
        const before = wasAvailable.get(p.externalId);
        const productId = idByExternal.get(p.externalId);
        if (productId === undefined) continue;

        if (before === undefined) appeared.push({ ...p, productId });
        else if (p.available && before === false) restocked.push({ ...p, productId });
        // The other direction is a change too. It sends nobody a text — being
        // told you missed something is not an alert, it is a taunt — but it
        // belongs in the feed, which is a record of what the stores did.
        else if (!p.available && before === true) soldOut.push({ ...p, productId });
      }
    }

    const events = [];
    for (const [type, batch] of [
      ['restock', restocked],
      ['new', appeared],
      ['sold_out', soldOut],
    ]) {
      for (const p of batch) {
        const { rows } = await client.query(
          `insert into events (product_id, type, title, url, image_url, price)
             values ($1,$2,$3,$4,$5,$6)
           returning id, product_id, type, title, url, image_url, price, created_at`,
          [p.productId, type, p.title, p.url, p.imageUrl, p.price],
        );
        events.push(rows[0]);
      }
    }

    await client.query(
      `update sites set seeded_at = coalesce(seeded_at, now()), last_polled_at = now(),
                        last_error = null
        where id = $1`,
      [site.id],
    );

    return {
      total: products.length,
      seeded: seeding,
      restockEvents: events.filter((e) => e.type === 'restock'),
      newEvents: events.filter((e) => e.type === 'new'),
      soldOutEvents: events.filter((e) => e.type === 'sold_out'),
      errors,
    };
  });
}

/**
 * Text everyone watching a product that just came back in stock, respecting the
 * per-product cooldown so inventory flapping can't spam anyone.
 */
async function notifyRestocks(restockEvents) {
  let sent = 0;

  for (const event of restockEvents) {
    const { rows: watchers } = await query(
      `select s.id, s.phone, s.verified, s.feed_token, s.ntfy_topic, s.ntfy_enabled,
              si.currency
         from watches w
         join subscribers s on s.id = w.subscriber_id
         join products p on p.id = w.product_id
         join sites si on si.id = p.site_id
        where w.product_id = $1
          -- Watching is open to anyone; being notified is not. A watch only
          -- reaches someone if it was switched on for this product *and* there
          -- is somewhere to send it — a verified number, a push topic, or both.
          and w.notify
          and s.unsubscribed_at is null
          and ((s.verified and s.phone is not null)
               or (s.ntfy_enabled and s.ntfy_topic is not null))
          and (w.last_notified_at is null
               or w.last_notified_at < now() - ($2 || ' hours')::interval)`,
      [event.product_id, String(config.poll.cooldownHours)],
    );

    for (const watcher of watchers) {
      // Every channel this person has, because someone who set up both wants
      // whichever arrives first, not an arbitrary one of the two.
      const results = [];

      if (watcher.ntfy_enabled && watcher.ntfy_topic) {
        const push = await sendPush(
          watcher.ntfy_topic,
          restockPush(event, watcher.currency, formatPrice),
        );
        results.push({ channel: 'push', ...push });
      }

      if (watcher.verified && watcher.phone) {
        const sms = await sendSms(
          watcher.phone,
          restockMessage(event, watcher.feed_token, watcher.currency),
        );
        results.push({ channel: 'sms', ...sms });
      }

      for (const result of results) {
        await query(
          `insert into deliveries (subscriber_id, event_id, status, provider_sid, error)
             values ($1,$2,$3,$4,$5)`,
          [
            watcher.id,
            event.id,
            result.ok ? 'sent' : 'failed',
            result.sid ?? null,
            result.error ?? null,
          ],
        );
      }

      // One channel landing is enough to count as told, and to start the
      // cooldown — otherwise a broken second channel would re-alert forever.
      if (results.some((r) => r.ok)) {
        sent += 1;
        await query(
          'update watches set last_notified_at = now() where subscriber_id = $1 and product_id = $2',
          [watcher.id, event.product_id],
        );
      }
    }
  }

  return sent;
}

/**
 * Text people whose standing alert matches something that just happened —
 * whether or not they had ever found that product to watch it.
 *
 * Both kinds of event qualify: a pre-order that just opened is the obvious one,
 * but a newly listed pre-order is exactly what someone typing "one piece" wants
 * to hear about, and often earlier than a restock would tell them.
 */
async function notifyKeywordMatches(events) {
  if (!events.length) return 0;

  const { rows: subscribers } = await query(
    `select id, phone, verified, feed_token, keyword, ntfy_topic, ntfy_enabled
       from subscribers
      where unsubscribed_at is null
        and keyword is not null
        and keyword <> ''
        and ((verified and phone is not null)
             or (ntfy_enabled and ntfy_topic is not null))`,
  );
  if (!subscribers.length) return 0;

  // One regex per person for the whole batch, rather than one per comparison.
  const alerts = subscribers
    .map((s) => ({ subscriber: s, alert: compileAlert(s.keyword) }))
    .filter((a) => a.alert);
  if (!alerts.length) return 0;

  let sent = 0;

  for (const event of events) {
    for (const { subscriber, alert } of alerts) {
      if (!alert.test(event.title)) continue;

      // Someone already watching this product is about to get the restock text
      // for it; a second message saying the same thing is not a better alert.
      const { rows: already } = await query(
        `select 1 from watches where subscriber_id = $1 and product_id = $2`,
        [subscriber.id, event.product_id],
      );
      if (already.length) continue;

      const { rows: fresh } = await query(
        `select 1 from keyword_alerts
          where subscriber_id = $1 and product_id = $2
            and last_notified_at > now() - ($3 || ' hours')::interval`,
        [subscriber.id, event.product_id, String(config.poll.cooldownHours)],
      );
      if (fresh.length) continue;

      const { rows: site } = await query(
        `select s.currency from products p join sites s on s.id = p.site_id where p.id = $1`,
        [event.product_id],
      );
      const term = alert.match(event.title);
      const currency = site[0]?.currency ?? 'USD';
      const results = [];

      if (subscriber.ntfy_enabled && subscriber.ntfy_topic) {
        const push = await sendPush(subscriber.ntfy_topic, {
          ...restockPush(event, currency, formatPrice),
          title: term ? `Matched "${term}"` : 'Matched your alert',
        });
        results.push({ channel: 'push', ...push });
      }

      if (subscriber.verified && subscriber.phone) {
        const sms = await sendSms(
          subscriber.phone,
          keywordMessage(event, subscriber.feed_token, currency, term),
        );
        results.push({ channel: 'sms', ...sms });
      }

      for (const result of results) {
        await query(
          `insert into deliveries (subscriber_id, event_id, status, provider_sid, error)
             values ($1,$2,$3,$4,$5)`,
          [
            subscriber.id,
            event.id,
            result.ok ? 'sent' : 'failed',
            result.sid ?? null,
            result.error ?? null,
          ],
        );
      }

      if (results.some((r) => r.ok)) {
        sent += 1;
        await query(
          `insert into keyword_alerts (subscriber_id, product_id, term)
             values ($1,$2,$3)
           on conflict (subscriber_id, product_id)
             do update set last_notified_at = now(), term = excluded.term`,
          [subscriber.id, event.product_id, term],
        );
      }
    }
  }

  return sent;
}

/** Poll one site. Exported so adding a site can populate it immediately. */
export async function pollSite(site) {
  const startedAt = Date.now();
  try {
    const result = await syncSite(site);
    // A seed run emits no events at all, so neither kind of alert fires on it.
    const sent = result.seeded ? 0 : await notifyRestocks(result.restockEvents);
    const keywordSent = result.seeded
      ? 0
      : await notifyKeywordMatches([...result.restockEvents, ...result.newEvents]);
    const summary = {
      site: site.name,
      origin: site.origin,
      products: result.total,
      seeded: result.seeded,
      restocks: result.restockEvents.length,
      texts: sent + keywordSent,
      keywordTexts: keywordSent,
      ms: Date.now() - startedAt,
      error: null,
    };
    noteSuccess(site.id);

    // At one poll a second an uneventful run must stay silent, or the log is
    // tens of thousands of identical lines a day and the interesting ones are
    // impossible to find. Speak up when something actually happened.
    const notable =
      result.seeded ||
      result.restockEvents.length ||
      result.newEvents.length ||
      result.soldOutEvents.length ||
      sent ||
      keywordSent;
    if (notable) {
      console.log(
        `[poll] ${site.name}: ${result.total} products in ${summary.ms}ms` +
          (result.seeded
            ? ' (initial seed, no alerts sent)'
            : ` · ${result.restockEvents.length} restock, ${result.newEvents.length} new, ` +
              `${result.soldOutEvents.length} sold out, ` +
              `${sent} watch texts, ${keywordSent} keyword texts`),
      );
    }
    return summary;
  } catch (err) {
    await query('update sites set last_polled_at = now(), last_error = $2 where id = $1', [
      site.id,
      err.message,
    ]).catch(() => {});
    noteFailure(site, err.message);
    console.error(`[poll] ${site.name} failed: ${err.message}`);
    return {
      site: site.name,
      origin: site.origin,
      products: 0,
      error: err.message,
      ms: Date.now() - startedAt,
    };
  }
}

let quietSince = 0;

/** Log something at most once a minute, however often we are called. */
function occasionally(message) {
  if (Date.now() - quietSince < 60_000) return;
  quietSince = Date.now();
  console.log(message);
}

/**
 * One sweep of every store, then done. This is what `npm run poll` and a cron
 * invocation use; the long-running server uses per-store loops below instead.
 */
export async function runPoll() {
  // Ticks arrive far faster than a sweep completes, which is the intent: the
  // next poll starts the moment the last one finishes. Dropping the overlap is
  // normal operation here, not a condition worth reporting.
  if (running) return null;
  running = true;

  try {
    const sites = await enabledSites();
    if (!sites.length) {
      occasionally('[poll] no sites configured yet — add one in the UI');
      pollerState.lastRunAt = new Date();
      pollerState.sites = [];
      return [];
    }

    // Sites run concurrently, not one after another. A store read from a JSON
    // feed finishes in under a second; a scraped one takes minutes. Queued
    // behind each other, adding one slow store would drop every fast store to
    // that store's pace — a fast store would go from a poll a second to a poll
    // every twelve minutes because a slow one is in the same sweep.
    //
    // Concurrency is bounded so a long list of stores can't exhaust the
    // database pool; per-host request pacing is enforced separately, inside the
    // crawler, so parallelism here never means hitting one store harder.
    const queue = [...sites];
    const summaries = [];

    async function worker() {
      for (let site = queue.shift(); site; site = queue.shift()) {
        const until = restingUntil(site.id);
        if (until) {
          summaries.push({
            site: site.name,
            origin: site.origin,
            products: 0,
            skipped: 'backing off',
            retryAt: new Date(until).toISOString(),
          });
          continue;
        }
        summaries.push(await pollSite(site));
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(config.poll.concurrency, sites.length) }, worker),
    );

    pollerState.lastRunAt = new Date();
    pollerState.lastError = null;
    pollerState.sites = summaries;
    return summaries;
  } catch (err) {
    pollerState.lastRunAt = new Date();
    pollerState.lastError = err.message;
    console.error(`[poll] failed: ${err.message}`);
    return null;
  } finally {
    running = false;
  }
}

// --- continuous polling -----------------------------------------------------
//
// Each store gets its own loop rather than all of them sharing one clock.
//
// A single sweep can only go as fast as its slowest member: with one JSON-feed
// store answering in 700ms and one scraped store taking twenty seconds, a
// shared timer polls *both* every twenty seconds, and asking for a poll a
// second buys nothing. Given their own loops, each store simply runs as fast as
// it can — the fast one every second, the slow one whenever its crawl delay
// lets it — and neither waits on the other.

const loops = new Map(); // siteId -> { stopped }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

async function siteLoop(siteId) {
  while (loops.get(siteId)?.stopped === false) {
    // Re-read the row each time so edits — new sections, a pause, a rename —
    // take effect without restarting anything.
    const site = await getSite(siteId).catch(() => null);
    if (!site || !site.enabled) break;

    const until = restingUntil(siteId);
    if (until) {
      await sleep(Math.min(until - Date.now(), 5_000));
      continue;
    }

    const summary = await pollSite(site);
    pollerState.sites = [
      ...pollerState.sites.filter((s) => s.origin !== summary.origin),
      summary,
    ];
    pollerState.lastRunAt = new Date();

    await sleep(config.poll.intervalMs);
  }
  loops.delete(siteId);
}

/** Start a loop for every enabled store, and stop loops for ones that went away. */
async function reconcileLoops() {
  let sites;
  try {
    sites = await enabledSites();
  } catch (err) {
    pollerState.lastError = err.message;
    return;
  }

  for (const site of sites) {
    if (loops.has(site.id)) continue;
    loops.set(site.id, { stopped: false });
    siteLoop(site.id).catch((err) => {
      console.error(`[poll] loop for site ${site.id} died: ${err.message}`);
      loops.delete(site.id);
    });
  }

  const live = new Set(sites.map((s) => s.id));
  for (const [id, state] of loops) {
    if (!live.has(id)) state.stopped = true;
  }
}

export function startPoller() {
  if (!config.poll.enabled) {
    console.log('[poll] disabled via POLL_ENABLED');
    return;
  }
  console.log(
    `[poll] each store polls every ${config.poll.intervalMs / 1000}s on its own loop ` +
      '(a store that answers 429/503 is rested with a growing backoff, and a scraped ' +
      "store is additionally paced by its robots.txt crawl delay)",
  );
  reconcileLoops();
  // Picks up stores added or removed through the UI.
  timer = setInterval(reconcileLoops, 10_000);
  timer.unref?.();
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const state of loops.values()) state.stopped = true;
}
