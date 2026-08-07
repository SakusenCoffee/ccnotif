import { pbandai } from './pbandai.js';
import { shopify } from './shopify.js';
import { shopware } from './shopware.js';

/**
 * The storefront platforms this app knows how to read.
 *
 * Order matters: cheapest and most certain probe first. Shopify's JSON feeds
 * either exist or don't, which settles the question in one request; the HTML
 * adapters have to fetch and sniff a page.
 *
 * An adapter's `discover` returns null for "this isn't my platform" and throws
 * for "it is mine and something is wrong" — so a store we recognise but can't
 * read reports the real reason instead of falling through to "unsupported".
 *
 * P-Bandai leads because it settles on a hostname, which costs nothing: it is
 * a single storefront rather than a platform other shops run, so there is no
 * page to sniff.
 */
export const ADAPTERS = [pbandai, shopify, shopware];

export function adapterFor(platform) {
  return ADAPTERS.find((a) => a.id === platform) ?? null;
}
