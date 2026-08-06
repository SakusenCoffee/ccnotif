import { safeFetchJson } from './safe-fetch.js';
import { config } from './config.js';

/**
 * Exchange rates so a price can be shown in the viewer's currency alongside the
 * one the store actually charges. Rates are indicative only — the store bills in
 * its own currency and a card issuer applies its own rate and fees — so the UI
 * always marks the converted figure as approximate.
 *
 * Cached in memory and refreshed a few times a day. If the lookup fails the app
 * simply shows no conversion; nothing depends on it.
 */

const REFRESH_MS = 6 * 60 * 60 * 1000;

// Two independent providers, neither needing an API key.
const PROVIDERS = [
  {
    name: 'exchangerate-api',
    url: (base) => `https://open.er-api.com/v6/latest/${base}`,
    parse: (body) => (body?.result === 'success' ? body.rates : null),
    updated: (body) => body?.time_last_update_utc ?? null,
  },
  {
    name: 'frankfurter',
    url: (base) => `https://api.frankfurter.dev/v1/latest?base=${base}`,
    parse: (body) => body?.rates ?? null,
    updated: (body) => body?.date ?? null,
  },
];

const state = {
  base: null,
  rates: null,
  fetchedAt: 0,
  updated: null,
  source: null,
  error: null,
};

async function refresh() {
  const base = config.displayCurrency;

  for (const provider of PROVIDERS) {
    try {
      const body = await safeFetchJson(provider.url(base));
      const rates = provider.parse(body);
      if (!rates || typeof rates !== 'object') throw new Error('no rates in response');

      state.base = base;
      // Rates arrive as base -> other. We need other -> base, so invert.
      state.rates = rates;
      state.fetchedAt = Date.now();
      state.updated = provider.updated(body);
      state.source = provider.name;
      state.error = null;
      console.log(`[fx] rates for ${base} from ${provider.name} (${state.updated})`);
      return state;
    } catch (err) {
      state.error = err.message;
      console.error(`[fx] ${provider.name} failed: ${err.message}`);
    }
  }
  return state;
}

export async function getRates() {
  if (!state.rates || Date.now() - state.fetchedAt > REFRESH_MS) {
    await refresh();
  }
  return state;
}

/**
 * Convert an amount in `currency` into the display currency. Returns null when
 * no conversion is possible or needed.
 */
export function convert(amount, currency) {
  if (amount == null || !currency) return null;
  if (currency === state.base) return null; // already in the display currency
  const rate = state.rates?.[currency];
  if (!rate || !Number.isFinite(rate) || rate <= 0) return null;
  // state.rates maps base -> currency, so divide to go the other way.
  return Number(amount) / rate;
}

/** Snapshot for the API: only the currencies actually in use. */
export function ratesFor(currencies) {
  const out = {};
  for (const currency of new Set(currencies)) {
    if (!currency || currency === state.base) continue;
    const rate = state.rates?.[currency];
    if (rate) out[currency] = rate;
  }
  return {
    base: state.base,
    rates: out,
    updated: state.updated,
    source: state.source,
  };
}

/** Warm the cache at boot and keep it fresh. */
export function startFx() {
  getRates().catch(() => {});
  const timer = setInterval(() => getRates().catch(() => {}), REFRESH_MS);
  timer.unref?.();
}
