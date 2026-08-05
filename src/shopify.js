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
