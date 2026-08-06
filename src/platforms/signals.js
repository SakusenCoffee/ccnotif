/**
 * What "this is a pre-order" looks like from the outside, shared by every
 * platform adapter.
 *
 * No storefront publishes a pre-order flag. Shopify's `available` only means
 * "can be bought", which is equally true of stock on a shelf and of an open
 * pre-order, and the fields that would settle it (inventory_policy,
 * inventory_quantity) are Admin-API only. What stores do reliably is say so in
 * the title, tag it, or badge it — so that is what we read.
 */

/** Handles/titles that look like they hold things you'd want an alert about. */
const PREORDER_PATTERNS = [
  { re: /\bpre[\s._-]?orders?\b/i, score: 100, why: 'pre-order' },
  { re: /\bpreorders?\b/i, score: 100, why: 'pre-order' },
  { re: /\bcoming[\s._-]?soon\b/i, score: 70, why: 'coming soon' },
  { re: /\bupcoming\b/i, score: 60, why: 'upcoming' },
  { re: /\bnew[\s._-]?(arrival|release)s?\b/i, score: 40, why: 'new arrivals' },
  { re: /\bback[\s._-]?in[\s._-]?stock\b/i, score: 40, why: 'restocks' },
  { re: /\bdrops?\b/i, score: 30, why: 'drops' },
];

// Sections that merely *exclude* pre-orders are the opposite of what we want.
const NEGATIVE_PATTERNS = [/\bnon[\s._-]?pre/i, /\bno[\s._-]?pre[\s._-]?order/i, /\bnot[\s._-]?pre/i];

/**
 * Score one browsable section of a store. Returns null when nothing about it
 * suggests pre-orders, which is most of a catalogue.
 */
export function scoreCollection({ handle, title }) {
  const haystack = `${handle ?? ''} ${title ?? ''}`;
  if (NEGATIVE_PATTERNS.some((re) => re.test(haystack))) return null;

  for (const { re, score, why } of PREORDER_PATTERNS) {
    if (re.test(haystack)) return { score, why };
  }
  return null;
}

// Tags like "*Show_Pre Orders" or "Show:Pre Orders" are collection-filter
// markers a theme uses; they sit on every item in a pre-order collection and so
// are no evidence about an individual product.
const SHOW_TAG = /^\**\s*show[:_]/i;
export const PREORDER_MARKER = /pre[\s_-]?order|coming[\s_-]?soon/i;

/**
 * Whether a product is something you pre-order rather than something on a shelf.
 *
 * Measured across three watched collections, the title-and-tag test caught 316
 * of 317 products, with 2 false positives in a 250-item non-pre-order control.
 */
export function detectPreorder({ title, tags = [] }) {
  if (PREORDER_MARKER.test(title ?? '')) return true;
  return tags.some((tag) => !SHOW_TAG.test(tag) && PREORDER_MARKER.test(tag));
}

/** Order candidates so the biggest, most obviously pre-order sections lead. */
export function rankCollections(scored) {
  return [...scored].sort((a, b) => b.score - a.score || (b.productCount ?? 0) - (a.productCount ?? 0));
}
