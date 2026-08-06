import { config } from '../config.js';
import { safeFetchJson } from '../safe-fetch.js';
import { pace } from '../robots.js';
import { detectPreorder, rankCollections, scoreCollection } from './signals.js';

/**
 * Shopify: read the public JSON feeds every storefront publishes.
 *
 * These are a documented, deliberately public API rather than pages meant for a
 * browser, so this adapter doesn't consult robots.txt the way the scraping ones
 * do — but it shares their per-host request queue, because a poll still costs
 * one request per watched section and firing those at once is what got a real
 * store to start refusing all of them.
 */

/** Statuses that mean "you are asking too often" or "I am overloaded". */
const RATE_LIMIT_STATUSES = new Set([429, 430, 500, 502, 503, 504]);

export function isRateLimited(err) {
  return RATE_LIMIT_STATUSES.has(err?.status);
}

const PAGE_SIZE = 250;
const COLLECTION_PAGE_SIZE = 250;
const MAX_COLLECTION_PAGES = 8;

/**
 * Every request to a store goes through the same per-host queue the scraped
 * adapters use.
 *
 * These are public JSON feeds, but a poll fetches one page per watched section,
 * and firing them all at once is a burst however gentle the interval looks.
 * Serialising them with a small gap is what keeps eleven sections from becoming
 * eleven simultaneous requests — which is what got a real store to start
 * refusing every one of them.
 */
function fetchPaced(url, options) {
  const host = new URL(url).host;
  return pace(host, config.poll.requestGapMs, () => safeFetchJson(url, options));
}

/**
 * A product is buyable when at least one of its variants is. Shopify reports
 * this directly in the public products.json feed, so no inventory scraping.
 */
function isAvailable(product) {
  return (product.variants ?? []).some((v) => v.available === true);
}

/**
 * Cheapest variant price, or null when there isn't a real one. Shopify reports
 * 0.00 for pre-orders whose price hasn't been announced, which is "TBA" rather
 * than "free" — collapse it to null so nothing downstream renders "0.00".
 */
function lowestPrice(product) {
  const prices = (product.variants ?? [])
    .map((v) => Number.parseFloat(v.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? Math.min(...prices) : null;
}

function primaryImage(product) {
  const src = product.images?.[0]?.src ?? null;
  if (!src) return null;
  // Ask the CDN for a thumbnail rather than the full 1000px+ original.
  return src.replace(/(\.[a-z]+)(\?|$)/i, '_400x$1$2');
}

async function fetchAllCollections(origin, signal) {
  const collections = [];
  for (let page = 1; page <= MAX_COLLECTION_PAGES; page += 1) {
    const body = await fetchPaced(
      `${origin}/collections.json?limit=${COLLECTION_PAGE_SIZE}&page=${page}`,
      { signal },
    );
    const batch = body.collections ?? [];
    collections.push(...batch);
    if (batch.length < COLLECTION_PAGE_SIZE) break;
  }
  return collections;
}

/**
 * Probe an origin. Returns null when this isn't a Shopify store, so the next
 * adapter gets a turn; throws when it plainly is one but can't be read.
 */
async function discover(origin, { signal } = {}) {
  // meta.json is the cheapest proof of a Shopify storefront, and it carries the
  // store name and currency.
  let meta = null;
  try {
    const body = await fetchPaced(`${origin}/meta.json`, { signal });
    if (body && typeof body === 'object' && (body.name || body.currency)) meta = body;
  } catch {
    // Some stores disable it; the collections probe below decides.
  }

  let collections;
  try {
    collections = await fetchAllCollections(origin, signal);
  } catch (err) {
    // meta.json already proved this is Shopify, so a failure here is a real
    // fault worth reporting rather than a reason to try another platform.
    if (meta) throw new Error(`Could not read ${origin}: ${err.message}`);
    return null;
  }

  if (!collections.length) {
    if (meta) throw new Error(`${origin} published no collections, so there is nothing to watch.`);
    return null;
  }

  const scored = [];
  for (const collection of collections) {
    const hit = scoreCollection(collection);
    if (!hit) continue;
    scored.push({
      handle: collection.handle,
      title: collection.title,
      productCount: collection.products_count ?? null,
      score: hit.score,
      why: hit.why,
    });
  }

  const ranked = rankCollections(scored);
  const hostname = new URL(origin).hostname.replace(/^www\./, '');

  return {
    name: meta?.name || hostname,
    currency: meta?.currency || 'USD',
    totalCollections: collections.length,
    suggested: ranked.slice(0, 25),
    // Everything else, so the UI can offer a manual pick.
    others: collections
      .filter((c) => !ranked.some((s) => s.handle === c.handle))
      .map((c) => ({
        handle: c.handle,
        title: c.title,
        productCount: c.products_count ?? null,
      }))
      .sort((a, b) => (b.productCount ?? 0) - (a.productCount ?? 0))
      .slice(0, 300),
  };
}

/**
 * Walk every watched collection on one site and return normalized records.
 * A product appearing in several collections is merged, keeping the union of
 * the collection handles it was found under.
 */
async function fetchProducts(site, { signal } = {}) {
  const byId = new Map();
  const errors = [];

  for (const collection of site.collections) {
    try {
      for (let page = 1; page <= config.poll.maxPages; page += 1) {
        const url =
          `${site.origin}/collections/${encodeURIComponent(collection)}` +
          `/products.json?limit=${PAGE_SIZE}&page=${page}`;
        const body = await fetchPaced(url, { signal });
        const products = body.products ?? [];
        if (!products.length) break;

        for (const p of products) {
          const id = String(p.id);
          const existing = byId.get(id);
          if (existing) {
            if (!existing.collections.includes(collection)) {
              existing.collections.push(collection);
            }
            continue;
          }
          byId.set(id, {
            externalId: id,
            handle: p.handle,
            title: p.title,
            vendor: p.vendor || null,
            productType: p.product_type || null,
            imageUrl: primaryImage(p),
            price: lowestPrice(p),
            available: isAvailable(p),
            isPreorder: detectPreorder({ title: p.title, tags: p.tags ?? [] }),
            publishedAt: p.published_at ? new Date(p.published_at) : null,
            collections: [collection],
            url: `${site.origin}/products/${p.handle}`,
          });
        }

        if (products.length < PAGE_SIZE) break;
      }
    } catch (err) {
      errors.push({ collection, message: err.message });

      // A rate-limit answer is the store saying stop, and the right response is
      // to stop — not to ask about the remaining ten sections and collect ten
      // more refusals. Doing that turned one poll into eleven rejected
      // requests, which is how a temporary limit becomes a lasting block.
      if (isRateLimited(err)) {
        console.warn(
          `[shopify] ${site.origin} is rate limiting us (${err.status}); ` +
            'abandoning the rest of this poll',
        );
        return {
          products: [...byId.values()],
          errors,
          rateLimited: true,
          retryAfterMs: err.retryAfterMs ?? null,
        };
      }

      // Anything else is one bad section, which shouldn't stop the site.
      console.error(`[shopify] ${site.origin} "${collection}" failed: ${err.message}`);
    }
  }

  return { products: [...byId.values()], errors };
}

export const shopify = {
  id: 'shopify',
  label: 'Shopify',
  // What the UI calls the things you tick when adding this kind of store.
  sectionNoun: 'collection',
  discover,
  fetchProducts,
};
