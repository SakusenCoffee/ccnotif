import { politeFetch, politeFetchText } from '../robots.js';
import { rankCollections, scoreCollection } from './signals.js';

/**
 * Premium Bandai (p-bandai.com), read through the API its own storefront uses.
 *
 * The site is a Vue application behind a bot-detection layer, so its product
 * pages return no product data to anything but a real browser — which is why
 * this looked unwatchable at first. But the app is driven by a plain JSON API
 * that answers an anonymous request perfectly well, as long as it is told which
 * regional storefront is asking. The storefront carries the region in the URL
 * (`/us/`, `/au/`) and passes it to the API as a header; without it every call
 * comes back 500, and that 500 is the whole reason this looked like a wall.
 *
 * What robots.txt allows shapes the rest of the design. It disallows the four
 * parameters that would make catalogue paging easy — `offset`, `limit`,
 * `sortType`, `_f_productStatuses` — so there is no permitted way to walk a
 * listing. It does advertise a per-region product sitemap, and the API's bulk
 * endpoint takes product codes with no disallowed parameter at all. So:
 * enumerate from the sitemap, read state in bulk. That suits this app anyway,
 * since the bulk endpoint is exactly "tell me about these products".
 */

const HOSTS = new Set(['p-bandai.com', 'www.p-bandai.com']);

// The regional storefronts, each of which robots.txt advertises a sitemap for.
// They share one origin and are told apart only by this code.
const AREAS = {
  us: { label: 'United States', currency: 'USD' },
  au: { label: 'Australia', currency: 'AUD' },
  nz: { label: 'New Zealand', currency: 'NZD' },
  sg: { label: 'Singapore', currency: 'SGD' },
  hk: { label: 'Hong Kong', currency: 'HKD' },
  tw: { label: 'Taiwan', currency: 'TWD' },
  fr: { label: 'France', currency: 'EUR' },
};

// The storefront a bare `p-bandai.com` is taken to mean. The region lives in
// the path (`/us/`), and discovery only ever sees an origin — so this is a
// choice, not a reading, and it is the one the other regions are offered
// against.
const DEFAULT_AREA = 'us';

// The API's own product classification. `PreOrder` is the one this app exists
// for; the others are offered because a watched item is a watched item.
const TYPES = {
  preorder: { api: 'PreOrder', title: 'Pre-orders' },
  general: { api: 'General', title: 'General release' },
  event: { api: 'Event', title: 'Event exclusives' },
};

// 100 codes per request answers; 200 is a 503. Not a documented limit, so leave
// room rather than sitting exactly on the edge of one.
const BULK_CHUNK = 90;

// A full sweep of a region is ~110 requests. Spreading it over several polls
// keeps one store from monopolising the crawl queue while it seeds.
const CHUNKS_PER_POLL = 25;

// Products whose sale has ended do not generally come back, so re-checking all
// 9,000 of them every poll would spend the entire budget learning nothing. They
// are revisited on a slow rotation instead, which still notices a resurrection
// within a few hours.
const SETTLED_CHUNKS_PER_POLL = 3;

// The sitemap is the only permitted way to learn that a product exists at all,
// so it caps how quickly a brand-new listing can be noticed.
const SITEMAP_TTL_MS = 60 * 60 * 1000;

// It is ~8.5MB for the larger regions, over safeFetch's default ceiling.
const SITEMAP_MAX_BYTES = 24 * 1024 * 1024;

const ORIGIN = 'https://p-bandai.com';

/** Per-region catalogue state, kept between polls. */
const catalogues = new Map();

function catalogueFor(area) {
  let entry = catalogues.get(area);
  if (!entry) {
    entry = {
      codes: [],
      codeSet: new Set(),
      records: new Map(),
      sitemapAt: 0,
      rotation: 0,
      // Whether the first pass over the region has finished. Until it has, this
      // adapter reports nothing at all — see fetchProducts.
      swept: false,
      unreadLastPoll: -1,
    };
    catalogues.set(area, entry);
  }
  return entry;
}

/** Test seam, and a way for a re-added store to start from nothing. */
export function clearCatalogueCache() {
  catalogues.clear();
}

// --- talking to the API -----------------------------------------------------

/**
 * The header set the storefront sends. `X-G1-Area-Code` is the load-bearing
 * one: it is how a single origin serves seven regional catalogues, and every
 * call without it fails.
 */
function apiHeaders(area) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en',
    'x-g1-area-code': area,
    'x-requested-with': 'XMLHttpRequest',
  };
}

async function apiGet(path, area, { signal } = {}) {
  const res = await politeFetch(`${ORIGIN}${path}`, { signal, headers: apiHeaders(area) });
  if (!res.ok) {
    const err = new Error(`p-bandai.com${path} responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(res.text);
  } catch {
    // A JSON endpoint answering with HTML means the request was routed to the
    // app shell, which is what a wrong or missing region code does.
    throw new Error(`p-bandai.com${path} answered with something that isn't JSON.`);
  }
}

// --- reading the catalogue --------------------------------------------------

const SITEMAP_LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

function locations(xml) {
  return [...xml.matchAll(SITEMAP_LOC)].map((m) => m[1]);
}

/**
 * Every product code in a region, from the sitemap robots.txt points at.
 *
 * The index names one file per few thousand products, so a growing catalogue
 * gains files rather than one unbounded file — follow all of them.
 */
async function readSitemap(area, { signal }) {
  const index = await politeFetchText(`${ORIGIN}/${area}/sitemap.xml`, {
    signal,
    headers: { accept: 'application/xml,text/xml' },
  });

  const parts = locations(index).filter((url) => /sitemap-product[^/]*\.xml$/i.test(url));
  if (!parts.length) throw new Error(`The ${area.toUpperCase()} storefront lists no product sitemap.`);

  const codes = new Set();
  for (const part of parts) {
    const xml = await politeFetchText(part, {
      signal,
      headers: { accept: 'application/xml,text/xml' },
      maxBytes: SITEMAP_MAX_BYTES,
    });
    for (const url of locations(xml)) {
      const code = /\/item\/([A-Za-z0-9._-]+)/.exec(url)?.[1];
      if (code) codes.add(code);
    }
  }
  return [...codes];
}

async function refreshCodes(area, entry, { signal }) {
  if (entry.codes.length && Date.now() - entry.sitemapAt < SITEMAP_TTL_MS) return;

  const codes = await readSitemap(area, { signal });
  entry.sitemapAt = Date.now();
  entry.codes = codes;
  entry.codeSet = new Set(codes);

  // A product that left the sitemap is delisted. Drop it so it stops being
  // re-checked, and so the count the UI shows means something.
  for (const code of entry.records.keys()) {
    if (!entry.codeSet.has(code)) entry.records.delete(code);
  }
}

/**
 * Which codes to spend this poll's requests on.
 *
 * Anything live or about to go live is checked every time — that is the whole
 * job. Codes never seen fill the rest of the budget, and a slow rotation over
 * the settled remainder catches anything that comes back from the dead.
 */
function codesToCheck(entry) {
  const urgent = [];
  const unseen = [];
  const settled = [];

  for (const code of entry.codes) {
    const record = entry.records.get(code);
    if (!record) unseen.push(code);
    else if (record.saleStatus === 'On' || record.saleStatus === 'Waiting') urgent.push(code);
    else settled.push(code);
  }

  const chosen = [...urgent];

  // The first pass runs to completion in one poll. It reports nothing until it
  // does, so splitting it across polls would only draw out the wait — the
  // crawl delay makes the total the same either way. Afterwards the cap
  // applies, because by then an unseen code is a genuinely new listing and
  // there are only ever a handful.
  const budget = entry.swept ? Math.max(0, CHUNKS_PER_POLL * BULK_CHUNK - chosen.length) : Infinity;
  // Newest first. The sitemap runs oldest to newest, and a listing that opened
  // this week is the one worth having early — reading front to back would start
  // with sales that ended in 2017.
  chosen.push(...unseen.slice(Math.max(0, unseen.length - budget)).reverse());

  // No point rotating through finished products before the catalogue has been
  // read once; every request is better spent on the pass itself.
  if (entry.swept && settled.length) {
    const slice = Math.min(SETTLED_CHUNKS_PER_POLL * BULK_CHUNK, settled.length);
    const start = entry.rotation % settled.length;
    // Wrap, so the rotation covers the whole tail rather than stalling at the end.
    chosen.push(...settled.slice(start, start + slice));
    chosen.push(...settled.slice(0, Math.max(0, start + slice - settled.length)));
    entry.rotation = (start + slice) % settled.length;
  }

  // The rotation can overlap itself on a short tail, and a duplicated code is a
  // wasted request out of a fixed budget.
  return [...new Set(chosen)];
}

async function readStatuses(area, codes, { signal }) {
  const records = [];
  for (let i = 0; i < codes.length; i += BULK_CHUNK) {
    const chunk = codes.slice(i, i + BULK_CHUNK);
    const path = `/api/search/bulk?productCodes=${encodeURIComponent(chunk.join(','))}`;
    const answer = await apiGet(path, area, { signal });
    if (Array.isArray(answer)) records.push(...answer);
  }
  return records;
}

// --- turning API records into products --------------------------------------

/** The storefront renders these names by locale, falling back to English. */
function nameOf(names, area) {
  if (typeof names === 'string') return names;
  if (!names || typeof names !== 'object') return null;
  return names.en ?? names[area] ?? Object.values(names).find(Boolean) ?? null;
}

function imageOf(record) {
  const file = record.productImages?.find((i) => i.mediaType === 'Image')?.fileUrl;
  return file ? `${ORIGIN}/${String(file).replace(/^\/+/, '')}` : null;
}

/**
 * One API record as this app's idea of a product.
 *
 * `saleStatus` is the field that matters: `On` means it can be bought right
 * now, `Waiting` means the sale has not opened yet, `End` means it is over.
 * `displayStatus` is separate — a product pulled from display is not buyable
 * whatever its sale status says.
 */
export function toProduct(record, area, handle) {
  const code = record.productCode;
  const title = nameOf(record.productName, area);
  if (!code || !title) return null;

  const price = record.fixedListPrice?.amount;

  return {
    // Unique per region, and stable — the product code alone repeats across
    // regional catalogues, and this app keys products per site.
    externalId: record.areaProductNo ?? `${code}-${area.toUpperCase()}`,
    handle: code,
    title,
    vendor: null,
    productType: record.productType ?? null,
    imageUrl: imageOf(record),
    price: Number.isFinite(price) ? price : null,
    available: record.saleStatus === 'On' && record.displayStatus !== 'Off',
    isPreorder: record.productType === 'PreOrder',
    // When the sale opens, which for a pre-order is the moment worth knowing.
    publishedAt: record.saleStartExpectedDt ?? null,
    url: `${ORIGIN}/${area}/item/${encodeURIComponent(code)}`,
    collections: [handle],
  };
}

// --- discovery --------------------------------------------------------------

function sectionsFor(area) {
  return Object.entries(TYPES).map(([type, { title }]) => ({
    handle: `${area}/${type}`,
    title: `${title} — ${AREAS[area].label}`,
  }));
}

/**
 * Everything discovery decides, given a working API. Split from the fetching so
 * the shape can be checked without going to the network.
 */
export function describeStore(currency, home = DEFAULT_AREA) {
  const sections = Object.keys(AREAS).flatMap(sectionsFor);

  // Only the home region is suggested, and so only it is selected by default.
  //
  // A site records one currency, and the seven storefronts price in seven. If
  // the other regions were merely ranked lower they would still be picked up by
  // the default selection, and an AUD price would be stored against a USD site
  // — wrong in a way nothing downstream could detect. They stay available
  // below; fetchProducts refuses the mismatched ones rather than mislabelling.
  const scored = [];
  for (const section of sections) {
    if (!section.handle.startsWith(`${home}/`)) continue;
    const hit = scoreCollection(section);
    if (hit) scored.push({ ...section, productCount: null, score: hit.score, why: hit.why });
  }

  const rest = sections.filter((s) => !scored.some((h) => h.handle === s.handle));
  return {
    name: 'Premium Bandai',
    currency,
    totalCollections: sections.length,
    suggested: rankCollections(scored),
    // The rest of the home region first — those are the ones that will actually
    // work alongside what is already ticked.
    others: rest
      .sort((a, b) => Number(b.handle.startsWith(`${home}/`)) - Number(a.handle.startsWith(`${home}/`)))
      .map((s) => ({ ...s, productCount: null })),
  };
}

async function discover(origin, { signal } = {}) {
  if (!HOSTS.has(new URL(origin).host)) return null;

  // Past this point the store is P-Bandai, so a failure is a real failure and
  // must say so rather than falling through to "unsupported".
  let shops;
  try {
    shops = await apiGet('/api/shop', DEFAULT_AREA, { signal });
  } catch (err) {
    throw new Error(
      `p-bandai.com is Premium Bandai, but its catalogue API did not answer: ${err.message}`,
    );
  }
  if (!Array.isArray(shops) || !shops.length) {
    throw new Error('p-bandai.com is Premium Bandai, but its catalogue API returned no shops.');
  }

  // Take the currency from the store rather than trusting the table above.
  // This call carries no disallowed parameter, so it is one plain request.
  let currency = AREAS[DEFAULT_AREA].currency;
  try {
    const sample = await apiGet('/api/search', DEFAULT_AREA, { signal });
    currency = sample?.productResults?.products?.[0]?.fixedListPrice?.currency ?? currency;
  } catch {
    // Not worth failing discovery over; the table is right for every region
    // the site currently serves.
  }

  return describeStore(currency);
}

// --- polling ----------------------------------------------------------------

async function fetchProducts(site, { signal } = {}) {
  const errors = [];
  const wanted = new Map(); // area -> Set of API productType

  for (const handle of site.collections) {
    const [area, type] = String(handle).split('/');
    if (!AREAS[area] || !TYPES[type]) {
      errors.push({ collection: handle, message: 'not a storefront this reads' });
      continue;
    }
    // A site holds one currency. Reading a storefront that prices in another
    // would store, say, AUD amounts against a USD site — and nothing further
    // down can tell that has happened, so refuse it here and say why.
    if (site.currency && AREAS[area].currency !== site.currency) {
      errors.push({
        collection: handle,
        message:
          `the ${area.toUpperCase()} storefront prices in ${AREAS[area].currency}, ` +
          `but this store is recorded in ${site.currency} — watch it as a separate store instead`,
      });
      continue;
    }
    if (!wanted.has(area)) wanted.set(area, new Map());
    wanted.get(area).set(TYPES[type].api, handle);
  }

  const products = [];

  for (const [area, types] of wanted) {
    const entry = catalogueFor(area);
    try {
      await refreshCodes(area, entry, { signal });

      const codes = codesToCheck(entry);
      for (const record of await readStatuses(area, codes, { signal })) {
        if (record?.productCode) entry.records.set(record.productCode, record);
      }
    } catch (err) {
      // One region failing shouldn't discard what the others found, and a
      // cached catalogue is still worth reporting.
      errors.push({ collection: area, message: err.message });
      console.error(`[pbandai] ${area} failed: ${err.message}`);
    }

    const seen = entry.records.size;
    const total = entry.codes.length;
    const unread = Math.max(0, total - seen);

    if (!entry.swept && total) {
      // Nothing left to read, or a pass that read nothing new — the second
      // matters because a code can sit in the sitemap and never come back from
      // the bulk endpoint, and waiting on it forever would mean this store
      // never reports at all.
      if (unread === 0 || unread === entry.unreadLastPoll) entry.swept = true;
      entry.unreadLastPoll = unread;
    }

    if (!entry.swept) {
      // Withhold the partial catalogue rather than handing over what has been
      // read so far.
      //
      // The poller marks a site seeded after its first successful poll and
      // treats everything new after that as an arrival. Reporting a sweep in
      // progress would make each poll look like two thousand products had just
      // appeared, and anyone with a keyword alert would be notified about all
      // of them — a catalogue going back to 2017, announced as new. So the
      // first complete read is the one the poller sees, and it is the seed.
      const progress = `read ${seen} of ${total} products so far`;
      console.warn(`[pbandai] ${area}: ${progress}, holding off until the first pass finishes`);
      errors.push({ collection: area, message: `first read of the ${area.toUpperCase()} catalogue, ${progress}` });
      continue;
    }

    for (const record of entry.records.values()) {
      const handle = types.get(record.productType);
      if (!handle) continue;
      const product = toProduct(record, area, handle);
      if (product) products.push(product);
    }
  }

  return { products, errors };
}

export const pbandai = {
  id: 'pbandai',
  label: 'Premium Bandai',
  sectionNoun: 'storefront',
  // Enumeration is one request per 90 products rather than per 250, and the
  // first sweep of a region takes several polls. The UI should say so.
  scraped: true,
  discover,
  fetchProducts,
};
