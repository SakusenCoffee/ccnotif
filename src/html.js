/**
 * Just enough HTML handling to read a storefront that publishes no JSON feed.
 *
 * Shopify hands us products.json; platforms like Shopware only render pages, so
 * the listing markup is the feed. These helpers stay deliberately small — the
 * adapters anchor on stable class names and pull a handful of fields out, which
 * needs attribute reading and entity decoding but not a DOM.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  trade: '™',
  reg: '®',
  copy: '©',
  deg: '°',
  eacute: 'é',
};

export function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values would throw; leave those as written.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Visible text of a fragment: tags removed, entities decoded, runs collapsed. */
export function textOf(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read one attribute out of a fragment. Storefront templates indent attributes
 * across many lines, so this matches across newlines and accepts single quotes.
 */
export function attr(html, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(String(html ?? ''));
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? '');
}

/** The opening tag that starts at `index`, or '' when there isn't one. */
export function openTagAt(html, index) {
  const end = html.indexOf('>', index);
  return end === -1 ? '' : html.slice(index, end + 1);
}

/**
 * Split a document into the chunks that each begin at a `marker` match. Used to
 * carve a listing page into one fragment per product card: each card's fields
 * then can't be confused with the next card's.
 */
export function chunksAt(html, marker) {
  const re = new RegExp(marker.source, marker.flags.includes('g') ? marker.flags : `${marker.flags}g`);
  const starts = [];
  for (let m = re.exec(html); m; m = re.exec(html)) starts.push(m.index);

  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

/** Resolve a possibly-relative href against a base, or null if it's unusable. */
export function absoluteUrl(href, base) {
  const raw = decodeEntities(href ?? '').trim();
  if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(raw)) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

/**
 * Read a displayed price. Storefronts render "$59.99", "€1.234,56", "from
 * $10.00 - $20.00"; take the first complete number and work out which separator
 * is the decimal point from its position.
 */
export function parseMoney(text) {
  const cleaned = String(text ?? '').replace(/\s|&nbsp;| /g, '');
  const match = /\d[\d.,]*/.exec(cleaned);
  if (!match) return null;

  let digits = match[0];
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  if (lastComma > lastDot) {
    // European: dots group thousands, the comma is the decimal separator.
    digits = digits.replace(/\./g, '').replace(',', '.');
  } else {
    digits = digits.replace(/,/g, '');
  }

  const value = Number.parseFloat(digits);
  // A storefront shows 0.00 for a price it hasn't announced, which is "TBA"
  // rather than "free" — the callers treat null that way.
  return Number.isFinite(value) && value > 0 ? value : null;
}

const CURRENCY_SYMBOLS = [
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['zł', 'PLN'],
  ['kr', 'SEK'],
  ['CHF', 'CHF'],
];

/** Best guess at a currency from a rendered price, for stores that name none. */
export function currencyFromSymbol(text) {
  const haystack = String(text ?? '');
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (haystack.includes(symbol)) return code;
  }
  return null;
}
