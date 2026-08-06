export const $ = (sel) => document.querySelector(sel);

export const state = {
  products: [],
  sites: [],
  adminRequired: false,
  selected: new Set(),
  saved: new Set(),
  signedIn: false,
  phone: null,
  feedToken: null,
  keyword: '',
  watchedOnly: false,
  status: 'unavailable',
  sort: 'title',
  siteId: '',
  type: 'all',
  fx: null,
  q: '',
  // Set by app.js so the stores module can trigger a refresh without importing it.
  onSitesChanged: null,
};

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || res.statusText), {
      data,
      status: res.status,
    });
  }
  return data;
}

export function money(value, currency = 'USD') {
  // 0 means the store hasn't announced a price, not that it's free.
  if (value == null || Number(value) === 0) return 'Price TBA';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
    }).format(Number(value));
  } catch {
    return `${Number(value).toFixed(2)} ${currency}`;
  }
}

/**
 * Approximate price in the display currency, or null when no conversion applies.
 * `fx.rates` maps the base currency to each store currency, so divide to invert.
 */
export function convertedMoney(value, currency) {
  const { base, rates } = state.fx ?? {};
  if (!base || !value || !currency || currency === base) return null;
  const rate = rates?.[currency];
  if (!rate) return null;
  return money(Number(value) / rate, base);
}
