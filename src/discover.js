import { politeFetch } from './robots.js';
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
  return { origin: `${landed.protocol}//${landed.host}`, reachable: true };
}

/**
 * Probe a URL and work out whether we can watch it: which platform it runs,
 * what it's called, and which of its sections look like pre-order listings.
 *
 * Each adapter gets a turn until one recognises the store. An adapter that
 * recognises it but can't read it throws, and that error wins — it says
 * something true about the store, which "unsupported" would not.
 */
export async function discoverSite(input, { signal } = {}) {
  const requested = normalizeOrigin(input);
  const { origin, reachable } = await canonicalOrigin(requested, signal);
  if (!reachable) throw new Error(`Could not reach ${requested}.`);

  for (const adapter of ADAPTERS) {
    const result = await adapter.discover(origin, { signal });
    if (!result) continue;
    return {
      origin,
      platform: adapter.id,
      platformLabel: adapter.label,
      sectionNoun: adapter.sectionNoun,
      ...result,
    };
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
