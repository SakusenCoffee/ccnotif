import { safeFetch, safeFetchJson } from './safe-fetch.js';

const COLLECTION_PAGE_SIZE = 250;
const MAX_COLLECTION_PAGES = 8;

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

// Collections that merely *exclude* pre-orders are the opposite of what we want.
const NEGATIVE_PATTERNS = [/\bnon[\s._-]?pre/i, /\bno[\s._-]?pre[\s._-]?order/i, /\bnot[\s._-]?pre/i];

export function normalizeOrigin(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Enter a store URL.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}`;
}

function scoreCollection(collection) {
  const haystack = `${collection.handle} ${collection.title}`;
  if (NEGATIVE_PATTERNS.some((re) => re.test(haystack))) return null;

  for (const { re, score, why } of PREORDER_PATTERNS) {
    if (re.test(haystack)) return { score, why };
  }
  return null;
}

async function fetchAllCollections(origin, signal) {
  const collections = [];
  for (let page = 1; page <= MAX_COLLECTION_PAGES; page += 1) {
    const body = await safeFetchJson(
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
 * Probe a URL and work out whether we can watch it, what it's called, and which
 * of its collections look like pre-order sections.
 */
export async function discoverSite(input, { signal } = {}) {
  const origin = normalizeOrigin(input);

  // meta.json is the cheapest proof that this is a Shopify storefront, and it
  // carries the store name and currency.
  let meta = null;
  try {
    meta = await safeFetchJson(`${origin}/meta.json`, { signal });
  } catch {
    // Some stores disable it; fall back to the collections probe below.
  }

  let collections;
  try {
    collections = await fetchAllCollections(origin, signal);
  } catch (err) {
    // Distinguish "not a Shopify store" from "the store is down".
    const probe = await safeFetch(origin, { headers: { accept: 'text/html' }, signal }).catch(
      () => null,
    );
    if (probe && probe.ok) {
      throw new Error(
        `${origin} is reachable but does not publish a Shopify product feed, so it can't be watched.`,
      );
    }
    throw new Error(`Could not read ${origin}: ${err.message}`);
  }

  if (!collections.length) {
    throw new Error(`${origin} published no collections, so there is nothing to watch.`);
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

  // Biggest, most obviously-pre-order collections first.
  scored.sort((a, b) => b.score - a.score || (b.productCount ?? 0) - (a.productCount ?? 0));

  const hostname = new URL(origin).hostname.replace(/^www\./, '');
  return {
    origin,
    name: meta?.name || hostname,
    currency: meta?.currency || 'USD',
    platform: 'shopify',
    totalCollections: collections.length,
    suggested: scored.slice(0, 25),
    // Everything else, so the UI can offer a manual pick.
    others: collections
      .filter((c) => !scored.some((s) => s.handle === c.handle))
      .map((c) => ({
        handle: c.handle,
        title: c.title,
        productCount: c.products_count ?? null,
      }))
      .sort((a, b) => (b.productCount ?? 0) - (a.productCount ?? 0))
      .slice(0, 300),
  };
}
