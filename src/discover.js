import { delayFor, politeFetch, robotsFor } from './robots.js';
import { ADAPTERS, adapterFor } from './platforms/index.js';

export function normalizeOrigin(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Enter a store URL.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}`;
}

/**
 * Where the store actually lives. Typing "miniaturemarket.com" reaches a host
 * that redirects to www, and if we kept the address as typed we'd be judging
 * every link on the page against an origin the store never uses — its own
 * navigation would look off-site. Follow the homepage once and adopt whatever
 * it settles on, so a site is stored under one canonical origin no matter how
 * it was typed.
 */
async function canonicalOrigin(origin, signal) {
  const probe = await politeFetch(origin, { signal }).catch(() => null);
  if (!probe?.ok) return { origin, reachable: false };

  const landed = new URL(probe.url);
  return {
    origin: `${landed.protocol}//${landed.host}`,
    reachable: true,
    // Hand the page we just fetched to the adapters. On a store asking for a
    // ten-second crawl delay, re-fetching the homepage to sniff it costs ten
    // seconds of a scan the user is sitting and waiting on.
    homepage: probe.text,
  };
}

// Adding a store re-probes rather than trusting the sections in the request, so
// that a caller can't make us fetch paths of their choosing. On a crawl-delayed
// store that honest re-probe costs another spaced-out homepage fetch, seconds
// after the scan that produced the very same answer. Holding the scan briefly
// keeps the guarantee — the server still derived the sections itself — without
// making the person who just pressed "Add" wait through it again.
const RECENT_TTL_MS = 2 * 60 * 1000;
const recent = new Map(); // origin -> { at, result }

function remember(requested, result) {
  const at = Date.now();
  // Keyed under both the address that was typed and the one the store actually
  // lives at: the scan is looked up by whatever the person entered ("foo.com"),
  // while the result is stored against the canonical host ("www.foo.com").
  for (const key of new Set([requested, result.origin])) {
    recent.set(key, { at, result });
  }
  for (const [key, entry] of recent) {
    if (at - entry.at > RECENT_TTL_MS) recent.delete(key);
  }
  return result;
}

function recall(input) {
  let origin;
  try {
    origin = normalizeOrigin(input);
  } catch {
    return null;
  }
  const entry = recent.get(origin);
  return entry && Date.now() - entry.at < RECENT_TTL_MS ? entry.result : null;
}

/**
 * Probe a URL and work out whether we can watch it: which platform it runs,
 * what it's called, and which of its sections look like pre-order listings.
 *
 * Each adapter gets a turn until one recognises the store. An adapter that
 * recognises it but can't read it throws, and that error wins — it says
 * something true about the store, which "unsupported" would not.
 */
export async function discoverSite(input, { signal, allowRecent = false } = {}) {
  if (allowRecent) {
    const cached = recall(input);
    if (cached) return cached;
  }

  const requested = normalizeOrigin(input);
  const { origin, reachable, homepage } = await canonicalOrigin(requested, signal);
  if (!reachable) throw new Error(`Could not reach ${requested}.`);

  for (const adapter of ADAPTERS) {
    const result = await adapter.discover(origin, { signal, homepage });
    if (!result) continue;
    return remember(requested, {
      origin,
      platform: adapter.id,
      platformLabel: adapter.label,
      sectionNoun: adapter.sectionNoun,
      // Scraped stores are read one listing page at a time. Tell the UI what
      // each page costs, so the person ticking boxes can see that ticking the
      // "everything" section is a different proposition from ticking one aisle.
      crawlDelayMs: adapter.scraped ? delayFor(await robotsFor(origin, { signal })) : 0,
      ...result,
    });
  }

  throw new Error(
    `${origin} is reachable but doesn't run a storefront we can read ` +
      `(${ADAPTERS.map((a) => a.label).join(' or ')}), so it can't be watched.`,
  );
}

/** Read every watched section of a saved site, using the platform it runs. */
export async function fetchSiteProducts(site, { signal } = {}) {
  const adapter = adapterFor(site.platform);
  if (!adapter) {
    throw new Error(`${site.origin} was added as "${site.platform}", which is no longer supported.`);
  }
  return adapter.fetchProducts(site, { signal });
}
