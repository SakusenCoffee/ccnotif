import { config } from './config.js';
import { safeFetchJson } from './safe-fetch.js';

const PAGE_SIZE = 250;

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

// Tags like "*Show_Pre Orders" or "Show:Pre Orders" are collection-filter
// markers the theme uses; they sit on every item in a pre-order collection and
// so are no evidence about an individual product.
const SHOW_TAG = /^\**\s*show[:_]/i;
const PREORDER_MARKER = /pre[\s_-]?order|coming[\s_-]?soon/i;

/**
 * Whether this is something you pre-order rather than something on a shelf.
 *
 * Shopify publishes no such flag: `available` only means "can be bought", which
 * is true both for stock on hand and for an open pre-order, and the fields that
 * would disambiguate (inventory_policy, inventory_quantity) are Admin-API only —
 * absent from products.json and from the /products/<handle>.js AJAX endpoint.
 *
 * What stores do reliably is say so in the title ("... (Pre Order)") and tag it.
 * Across Hobbiesville's three watched collections that catches 316 of 317
 * products, with 2 false positives in a 250-item non-pre-order control.
 */
function detectPreorder(product) {
  if (PREORDER_MARKER.test(product.title ?? '')) return true;
  return (product.tags ?? []).some((t) => !SHOW_TAG.test(t) && PREORDER_MARKER.test(t));
}

function primaryImage(product) {
  const src = product.images?.[0]?.src ?? null;
  if (!src) return null;
  // Ask the CDN for a thumbnail rather than the full 1000px+ original.
  return src.replace(/(\.[a-z]+)(\?|$)/i, '_400x$1$2');
}

/**
 * Walk every watched collection on one site and return normalized records.
 * A product appearing in several collections is merged, keeping the union of
 * the collection handles it was found under.
 */
export async function fetchSiteProducts(site, { signal } = {}) {
  const byId = new Map();
  const errors = [];

  for (const collection of site.collections) {
    try {
      for (let page = 1; page <= config.poll.maxPages; page += 1) {
        const url =
          `${site.origin}/collections/${encodeURIComponent(collection)}` +
          `/products.json?limit=${PAGE_SIZE}&page=${page}`;
        const body = await safeFetchJson(url, { signal });
        const products = body.products ?? [];
        if (!products.length) break;

        for (const p of products) {
          const existing = byId.get(p.id);
          if (existing) {
            if (!existing.collections.includes(collection)) {
              existing.collections.push(collection);
            }
            continue;
          }
          byId.set(p.id, {
            externalId: p.id,
            handle: p.handle,
            title: p.title,
            vendor: p.vendor || null,
            productType: p.product_type || null,
            imageUrl: primaryImage(p),
            price: lowestPrice(p),
            available: isAvailable(p),
            isPreorder: detectPreorder(p),
            publishedAt: p.published_at ? new Date(p.published_at) : null,
            collections: [collection],
            url: `${site.origin}/products/${p.handle}`,
          });
        }

        if (products.length < PAGE_SIZE) break;
      }
    } catch (err) {
      // One bad collection shouldn't stop the whole site.
      errors.push({ collection, message: err.message });
      console.error(`[shopify] ${site.origin} "${collection}" failed: ${err.message}`);
    }
  }

  return { products: [...byId.values()], errors };
}
