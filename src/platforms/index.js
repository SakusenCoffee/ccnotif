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
 */
export const ADAPTERS = [shopify, shopware];

export function adapterFor(platform) {
  return ADAPTERS.find((a) => a.id === platform) ?? null;
}
