import { config } from './config.js';
import { query, transaction } from './db.js';
import { fetchSiteProducts } from './shopify.js';
import { enabledSites } from './sites.js';
import { restockMessage, sendSms } from './notify.js';

let running = false;
let timer = null;

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
  const { products, errors } = await fetchSiteProducts(site);

  if (!products.length) {
    throw new Error(
      `no products returned (${errors.map((e) => e.collection).join(', ') || 'unknown cause'})`,
    );
  }

  return transaction(async (client) => {
    // A site is seeded the first time it is polled. Until then every product
    // looks "new", and emitting hundreds of events nobody asked for is noise.
    const seeding = site.seeded_at === null;

    const { rows: previous } = await client.query(
      'select external_id, available from products where site_id = $1 and external_id = any($2::bigint[])',
      [site.id, products.map((p) => p.externalId)],
    );
    const wasAvailable = new Map(previous.map((r) => [r.external_id, r.available]));

    const restocked = [];
    const appeared = [];

    for (const p of products) {
      const before = wasAvailable.get(p.externalId);
      const isNew = before === undefined;

      const { rows } = await client.query(
        `insert into products (site_id, external_id, handle, title, vendor, product_type,
                               image_url, price, available, collections, published_at,
                               last_seen_at, became_available_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(),
                   case when $9 then now() else null end)
         on conflict (site_id, external_id) do update set
           handle       = excluded.handle,
           title        = excluded.title,
           vendor       = excluded.vendor,
           product_type = excluded.product_type,
           image_url    = excluded.image_url,
           price        = excluded.price,
           available    = excluded.available,
           collections  = excluded.collections,
           published_at = excluded.published_at,
           last_seen_at = now(),
           became_available_at = case
             when excluded.available and not products.available then now()
             else products.became_available_at
           end
         returning id`,
        [
          site.id,
          p.externalId,
          p.handle,
          p.title,
          p.vendor,
          p.productType,
          p.imageUrl,
          p.price,
          p.available,
          p.collections,
          p.publishedAt,
        ],
      );
      const productId = rows[0].id;

      if (seeding) continue;
      if (isNew) appeared.push({ ...p, productId });
      else if (p.available && before === false) restocked.push({ ...p, productId });
    }

    const events = [];
    for (const [type, batch] of [
      ['restock', restocked],
      ['new', appeared],
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
      `select s.id, s.phone, s.feed_token, si.currency
         from watches w
         join subscribers s on s.id = w.subscriber_id
         join products p on p.id = w.product_id
         join sites si on si.id = p.site_id
        where w.product_id = $1
          and s.verified
          and s.unsubscribed_at is null
          and (w.last_notified_at is null
               or w.last_notified_at < now() - ($2 || ' hours')::interval)`,
      [event.product_id, String(config.poll.cooldownHours)],
    );

    for (const watcher of watchers) {
      const result = await sendSms(
        watcher.phone,
        restockMessage(event, watcher.feed_token, watcher.currency),
      );

      await query(
        `insert into deliveries (subscriber_id, event_id, status, provider_sid, error)
           values ($1,$2,$3,$4,$5)`,
        [watcher.id, event.id, result.ok ? 'sent' : 'failed', result.sid, result.error ?? null],
      );

      if (result.ok) {
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

/** Poll one site. Exported so adding a site can populate it immediately. */
export async function pollSite(site) {
  const startedAt = Date.now();
  try {
    const result = await syncSite(site);
    const sent = result.seeded ? 0 : await notifyRestocks(result.restockEvents);
    const summary = {
      site: site.name,
      origin: site.origin,
      products: result.total,
      seeded: result.seeded,
      restocks: result.restockEvents.length,
      texts: sent,
      ms: Date.now() - startedAt,
      error: null,
    };
    console.log(
      `[poll] ${site.name}: ${result.total} products in ${summary.ms}ms` +
        (result.seeded
          ? ' (initial seed, no alerts sent)'
          : ` · ${result.restockEvents.length} restock, ${result.newEvents.length} new, ${sent} texts`),
    );
    return summary;
  } catch (err) {
    await query('update sites set last_polled_at = now(), last_error = $2 where id = $1', [
      site.id,
      err.message,
    ]).catch(() => {});
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

export async function runPoll() {
  if (running) {
    console.log('[poll] previous run still in flight, skipping this tick');
    return null;
  }
  running = true;

  try {
    const sites = await enabledSites();
    if (!sites.length) {
      console.log('[poll] no sites configured yet — add one in the UI');
      pollerState.lastRunAt = new Date();
      pollerState.sites = [];
      return [];
    }

    const summaries = [];
    for (const site of sites) {
      summaries.push(await pollSite(site));
    }

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

export function startPoller() {
  if (!config.poll.enabled) {
    console.log('[poll] disabled via POLL_ENABLED');
    return;
  }
  console.log(`[poll] running every ${config.poll.intervalMs / 1000}s`);
  runPoll();
  timer = setInterval(runPoll, config.poll.intervalMs);
  timer.unref?.();
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}
