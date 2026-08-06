import { config } from '../config.js';
import {
  absoluteUrl,
  attr,
  chunksAt,
  currencyFromSymbol,
  parseMoney,
  textOf,
} from '../html.js';
import { politeFetchText } from '../robots.js';
import { PREORDER_MARKER, detectPreorder, rankCollections, scoreCollection } from './signals.js';

/**
 * Shopware 6 storefronts, read from their rendered pages.
 *
 * Shopware's machine-readable API is the Store API, which needs an
 * `sw-access-key` issued per sales channel — a standard storefront never puts
 * one in the page, so there is nothing to read but the HTML. The theme's class
 * names are the contract we anchor on; they are Shopware's own storefront
 * bundle, so they hold across themes far better than positional parsing would.
 *
 * Every fetch goes through the robots.txt-aware crawler, because reading a
 * catalogue this way is one request per 24 products rather than per 250.
 */

// Shopware's own storefront routes and bundles. One of these on the page is
// strong evidence; nothing else lays out URLs quite like it.
const PLATFORM_MARKERS = [
  '/widgets/cms/navigation',
  'frontend.cms.navigation.page',
  'frontend.menu.offcanvas',
  'bundles/storefront/',
  'window.activeNavigationId',
];

// Anchors the storefront marks as navigation. Anything else on a homepage is as
// likely to be a product, a policy page or a banner.
const NAV_LINK_CLASSES = [
  'main-navigation-link',
  'navigation-flyout-link',
  'category-navigation-link',
  'nav-link',
];

// Paths that are never a browsable listing.
const NON_CATEGORY = [
  /^(checkout|account|wishlist|widgets|search|form|store-api|api|media|thumbnail|bundles|sitemap)(\/|$)/i,
  /^(login|register|logout|newsletter|cookie|compare)(\/|$)/i,
  /\.(xml|json|jpe?g|png|webp|gif|svg|css|js|pdf|ico)$/i,
];

const CARD_START = /<div\b[^>]*\bclass="[^"]*\bproduct-box\b/i;

/** Class attributes are space-separated tokens; substring tests over-match. */
function classTokens(openTag) {
  return new Set((attr(openTag, 'class') ?? '').split(/\s+/).filter(Boolean));
}

function hasClass(openTag, name) {
  return classTokens(openTag).has(name);
}

/** Every `<tag ...>` opening tag in a fragment, with its offset. */
function* openTags(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  for (let m = re.exec(html); m; m = re.exec(html)) {
    yield { tag: m[0], index: m.index, end: m.index + m[0].length };
  }
}

/** The first element of `tagName` carrying `className`, with its inner HTML. */
function elementWithClass(html, tagName, className) {
  for (const { tag, end } of openTags(html, tagName)) {
    if (!hasClass(tag, className)) continue;
    const close = html.indexOf(`</${tagName}`, end);
    return { tag, inner: close === -1 ? '' : html.slice(end, close) };
  }
  return null;
}

/** The value of a hidden input by name — how Shopware themes stash card data. */
function hiddenInput(html, name) {
  for (const { tag } of openTags(html, 'input')) {
    if (attr(tag, 'name') === name) return attr(tag, 'value');
  }
  return null;
}

function looksLikeShopware(html) {
  return PLATFORM_MARKERS.some((marker) => html.includes(marker));
}

function storeName(html, origin) {
  const candidates = [
    attr(/<meta\b[^>]*property="og:site_name"[^>]*>/i.exec(html)?.[0] ?? '', 'content'),
    attr(/<meta\b[^>]*itemprop="copyrightHolder"[^>]*>/i.exec(html)?.[0] ?? '', 'content'),
    textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
      // Page titles are usually "Something | Store Name".
      .split(/\s+[|·–—]\s+/)
      .pop(),
  ];
  const found = candidates.find((c) => c && c.trim());
  return found ? found.trim() : new URL(origin).hostname.replace(/^www\./, '');
}

function storeCurrency(html) {
  const declared =
    hiddenInput(html, 'dtgs-gtm-currency-code') ??
    attr(/<meta\b[^>]*itemprop="priceCurrency"[^>]*>/i.exec(html)?.[0] ?? '', 'content') ??
    /"(?:currencyIsoCode|priceCurrency|currency_code)"\s*:\s*"([A-Z]{3})"/.exec(html)?.[1] ??
    null;
  if (declared && /^[A-Za-z]{3}$/.test(declared)) return declared.toUpperCase();

  const price = elementWithClass(html, 'span', 'product-price');
  return (price && currencyFromSymbol(textOf(price.inner))) ?? 'USD';
}

/**
 * Categories, taken from the navigation the storefront renders into every page.
 * Shopware ships the whole main-navigation tree in the header markup, so one
 * request gets the catalogue's shape without crawling it.
 *
 * Returns the navigation separately from `extra`: links that aren't marked as
 * navigation but whose own last path segment reads as a pre-order section. A
 * store's headline pre-order listing is often a promo button rather than a menu
 * item — Miniature Market's site-wide `/preorders` is an `<a class="btn">` — and
 * that link is worth offering. Testing only the last segment is what keeps
 * product URLs out: `/Some-Set-Preorder/SKU123` ends in its SKU, not in
 * "preorder", so it doesn't qualify.
 */
function extractCategories(html, origin) {
  const navigation = new Map();
  const extra = new Map();

  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const openTag = `<a${m[1]}>`;
    const href = absoluteUrl(attr(openTag, 'href'), origin);
    if (!href) continue;

    const url = new URL(href);
    if (`${url.protocol}//${url.host}` !== origin) continue;

    const handle = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!handle || NON_CATEGORY.some((skip) => skip.test(handle))) continue;

    const tokens = classTokens(openTag);
    const isNav = NAV_LINK_CLASSES.some((name) => tokens.has(name));
    const lastSegment = handle.split('/').pop().replace(/\.[a-z]+$/i, '');
    if (!isNav && !scoreCollection({ handle: lastSegment, title: '' })) continue;

    const target = isNav ? navigation : extra;
    const label = textOf(m[2]) || attr(openTag, 'title') || '';
    // "View all" tells you nothing about which section you'd be ticking.
    const title = /^(view|shop|see|browse)\s+(all|more)$|^(more|all)$/i.test(label)
      ? lastSegment.replace(/[-_]+/g, ' ')
      : label || handle;
    // The same category appears in several menus; the first title wins, and a
    // later empty one must not overwrite it.
    if (!target.has(handle)) target.set(handle, { handle, title });
  }

  for (const handle of navigation.keys()) extra.delete(handle);
  return [...navigation.values(), ...extra.values()];
}

/**
 * Everything discovery reads off a homepage. Split from the fetch so it can be
 * checked against saved pages.
 */
export function discoverFromHtml(html, origin) {
  if (!looksLikeShopware(html)) return null;

  const categories = extractCategories(html, origin);
  if (!categories.length) {
    throw new Error(
      `${origin} is a Shopware storefront, but its pages list no navigable categories to watch.`,
    );
  }

  const scored = [];
  for (const category of categories) {
    const hit = scoreCollection(category);
    if (!hit) continue;
    scored.push({ ...category, productCount: null, score: hit.score, why: hit.why });
  }
  const ranked = rankCollections(scored);

  return {
    name: storeName(html, origin),
    currency: storeCurrency(html),
    totalCollections: categories.length,
    suggested: ranked.slice(0, 25),
    others: categories
      .filter((c) => !ranked.some((s) => s.handle === c.handle))
      // Product counts aren't in the navigation, and finding them would mean a
      // request per category — on a store with a crawl delay, minutes of them.
      .map((c) => ({ ...c, productCount: null }))
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .slice(0, 300),
  };
}

async function discover(origin, { signal, homepage } = {}) {
  const html = homepage ?? (await politeFetchText(`${origin}/`, { signal }).catch(() => null));
  return html ? discoverFromHtml(html, origin) : null;
}

/** Pick a thumbnail out of a srcset rather than shipping the 800px original. */
function thumbnailFrom(imgTag) {
  const srcset = attr(imgTag, 'srcset');
  const src = attr(imgTag, 'src');

  if (srcset) {
    const candidates = srcset
      .split(',')
      .map((entry) => entry.trim().split(/\s+/))
      .map(([url, descriptor]) => ({ url, width: Number.parseInt(descriptor ?? '', 10) }))
      .filter((c) => c.url && Number.isFinite(c.width))
      .sort((a, b) => a.width - b.width);

    const chosen = candidates.find((c) => c.width >= 300) ?? candidates.at(-1);
    if (chosen) return chosen.url;
  }
  return src ?? null;
}

/**
 * Turn one product card into a record. Returns null for a fragment that has no
 * product link, which is what a promotional tile inside a listing looks like.
 */
export function parseCard(card, origin) {
  let link = null;
  for (const { tag, end } of openTags(card, 'a')) {
    if (!hasClass(tag, 'product-name')) continue;
    const close = card.indexOf('</a', end);
    link = { tag, text: textOf(close === -1 ? '' : card.slice(end, close)) };
    break;
  }
  if (!link) return null;

  const url = absoluteUrl(attr(link.tag, 'href'), origin);
  if (!url) return null;

  const title = (attr(link.tag, 'title') || link.text || '').trim();
  if (!title) return null;

  const handle = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');

  // The SKU is the one identifier present whether or not the card can be bought;
  // the product's UUID only appears inside the add-to-cart form, so a sold-out
  // product would change identity the moment it became buyable.
  const sku =
    attr(/\bdata-sku\s*=\s*("[^"]*"|'[^']*')/i.exec(card)?.[0] ?? '', 'data-sku') ||
    hiddenInput(card, 'dtgs-gtm-product-sku') ||
    null;

  const priceEl = elementWithClass(card, 'span', 'product-price');
  const priceText = priceEl ? textOf(priceEl.inner) : '';

  let image = null;
  for (const { tag } of openTags(card, 'img')) {
    if (!hasClass(tag, 'product-image')) continue;
    image = thumbnailFrom(tag);
    break;
  }

  // Shopware's add-to-cart form posts to this route. It is rendered only when
  // the product can actually be bought — a sold-out card gets a disabled label
  // and a back-in-stock notification form instead.
  const buyable =
    /action\s*=\s*["'][^"']*\/checkout\/line-item\/add["']/i.test(card) ||
    [...openTags(card, 'button')].some(({ tag }) => hasClass(tag, 'btn-buy'));

  const badged = [...openTags(card, 'div')].some(({ tag }) => hasClass(tag, 'badge-preorder'));

  return {
    externalId: sku ?? handle,
    handle,
    title,
    vendor: hiddenInput(card, 'dtgs-gtm-product-brand') || null,
    productType: null,
    imageUrl: image,
    price: parseMoney(priceText) ?? parseMoney(hiddenInput(card, 'dtgs-gtm-product-price')),
    available: buyable,
    isPreorder: badged || detectPreorder({ title }) || PREORDER_MARKER.test(handle),
    publishedAt: null,
    url,
  };
}

export function parseListing(html, origin) {
  return chunksAt(html, CARD_START)
    .map((card) => parseCard(card, origin))
    .filter(Boolean);
}

function pageUrl(origin, handle, page) {
  // robots.txt on these stores commonly allows `?p=` and disallows `?limit=`,
  // so paginate rather than asking for a bigger page.
  const url = new URL(handle.replace(/^\/+/, ''), `${origin}/`);
  url.searchParams.set('p', String(page));
  return url.toString();
}

async function fetchProducts(site, { signal } = {}) {
  const byId = new Map();
  const errors = [];

  for (const handle of site.collections) {
    try {
      let found = 0;
      let exhausted = false;
      let previousPage = new Set();

      for (let page = 1; page <= config.crawl.maxPages; page += 1) {
        const html = await politeFetchText(pageUrl(site.origin, handle, page), { signal });
        const cards = parseListing(html, site.origin);
        if (!cards.length) {
          exhausted = true;
          break;
        }

        const thisPage = new Set(cards.map((c) => c.externalId));
        // Past the last page some storefronts serve the last page again rather
        // than an empty one; repeating a page means we are done.
        if (previousPage.size && [...thisPage].every((id) => previousPage.has(id))) {
          exhausted = true;
          break;
        }
        previousPage = thisPage;

        for (const card of cards) {
          const existing = byId.get(card.externalId);
          if (existing) {
            if (!existing.collections.includes(handle)) existing.collections.push(handle);
            continue;
          }
          byId.set(card.externalId, { ...card, collections: [handle] });
        }
        found += cards.length;
      }

      if (!found) {
        errors.push({ collection: handle, message: 'no products on that page' });
      } else if (!exhausted) {
        // Stopping at the cap means the tail of this section is invisible to
        // us, so a restock down there would never be noticed. Say so rather
        // than reporting a clean run over a partial catalogue.
        const message =
          `stopped at the ${config.crawl.maxPages}-page limit after ${found} products; ` +
          'watch a narrower section or raise CRAWL_MAX_PAGES';
        errors.push({ collection: handle, message });
        console.warn(`[shopware] ${site.origin} "${handle}": ${message}`);
      }
    } catch (err) {
      // One bad category shouldn't stop the whole site.
      errors.push({ collection: handle, message: err.message });
      console.error(`[shopware] ${site.origin} "${handle}" failed: ${err.message}`);
    }
  }

  return { products: [...byId.values()], errors };
}

export const shopware = {
  id: 'shopware',
  label: 'Shopware',
  sectionNoun: 'category',
  // Read by fetching pages rather than a feed, so a poll is slow and its cost
  // scales with how much of the catalogue is watched.
  scraped: true,
  discover,
  fetchProducts,
};
