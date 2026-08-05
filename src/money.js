/**
 * Stores are not all in USD — Hobbiesville prices in CAD — so every price is
 * rendered against its own site's currency. A price of 0 or null means the
 * store hasn't announced one yet, which is "TBA" rather than "free".
 */
export function formatPrice(value, currency = 'USD') {
  if (value == null || Number(value) === 0) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
    }).format(Number(value));
  } catch {
    return `${Number(value).toFixed(2)} ${currency}`;
  }
}
