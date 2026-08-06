import 'dotenv/config';

/**
 * Read an environment variable, trimming whitespace and stripping a wrapping
 * pair of quotes. Pasting `"abc"` or a value with a trailing newline into a
 * dashboard's variable field is easy to do and otherwise fails much later as an
 * opaque authentication error.
 */
function str(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unquoted === '' ? undefined : unquoted;
}

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, dflt) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
}

export const config = {
  port: int(process.env.PORT, 3000),
  databaseUrl: str('DATABASE_URL'),

  // Public origin of this app, used to build links in texts and the RSS feed.
  // Railway injects RAILWAY_PUBLIC_DOMAIN automatically.
  publicUrl: (
    process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`) ||
    `http://localhost:${int(process.env.PORT, 3000)}`
  ).replace(/\/$/, ''),

  appName: process.env.APP_NAME || 'Pre-Order Watch',

  // Optional: a store to create on first boot so the app isn't empty. Stores are
  // normally added through the UI.
  seedSite: process.env.SEED_SITE_URL
    ? {
        url: process.env.SEED_SITE_URL,
        collections: (process.env.SEED_SITE_COLLECTIONS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }
    : null,

  poll: {
    intervalMs: int(process.env.POLL_INTERVAL_SECONDS, 300) * 1000,
    enabled: bool(process.env.POLL_ENABLED, true),
    // Don't text the same person about the same product twice inside this
    // window. Shopify inventory flaps; this keeps a flapping product from
    // becoming a stream of texts.
    cooldownHours: int(process.env.NOTIFY_COOLDOWN_HOURS, 24),
    maxPages: int(process.env.MAX_PAGES_PER_COLLECTION, 10),
  },

  // Stores with no JSON feed are read by fetching listing pages, which is far
  // more traffic than a products.json call. These bound how hard we lean on one.
  crawl: {
    // Gap between requests when robots.txt names no Crawl-delay.
    defaultDelayMs: int(process.env.CRAWL_DELAY_MS, 1_000),
    // Ceiling on a store's own Crawl-delay. Some publish figures (300s and up)
    // that would make a poll take longer than the interval between polls.
    maxDelayMs: int(process.env.CRAWL_MAX_DELAY_MS, 15_000),
    // Listing pages hold ~24 products where a JSON feed holds 250, so these
    // need their own ceiling: MAX_PAGES_PER_COLLECTION would cut a scraped
    // section off ten times sooner than the equivalent Shopify collection.
    maxPages: int(process.env.CRAWL_MAX_PAGES, 40),
  },

  twilio: {
    accountSid: str('TWILIO_ACCOUNT_SID'),
    authToken: str('TWILIO_AUTH_TOKEN'),
    // Strip spaces, dashes and brackets so "(913) 388-3175" style input still
    // yields a usable E.164 number.
    from: str('TWILIO_FROM_NUMBER')?.replace(/[\s()\-.]/g, ''),
    messagingServiceSid: str('TWILIO_MESSAGING_SERVICE_SID'),
    // With no credentials the app still runs end-to-end; texts are logged to
    // stdout instead of sent. Handy while building the UI.
    get enabled() {
      return Boolean(this.accountSid && this.authToken && (this.from || this.messagingServiceSid));
    },
  },

  verification: {
    codeTtlMinutes: int(process.env.CODE_TTL_MINUTES, 10),
    maxAttempts: int(process.env.CODE_MAX_ATTEMPTS, 5),
    // Off by default. It only ever blocked legitimate retries while getting
    // Twilio working; the per-IP rate limit still guards against abuse.
    resendCooldownSeconds: int(process.env.CODE_RESEND_COOLDOWN_SECONDS, 0),
  },

  // When set, adding/editing/removing stores requires this token. Leave unset
  // while the app is private; set it before sharing the URL.
  adminToken: str('ADMIN_TOKEN') ?? null,

  defaultCountry: str('DEFAULT_PHONE_COUNTRY') || 'US',
  // Prices are shown in the store's own currency, with an approximate
  // conversion to this one beside them.
  displayCurrency: (str('DISPLAY_CURRENCY') || 'USD').toUpperCase(),
  maxWatchesPerSubscriber: int(process.env.MAX_WATCHES, 100),
  maxSites: int(process.env.MAX_SITES, 25),
  sessionCookie: 'pw_session',
};

/**
 * Report configuration problems without throwing. A missing DATABASE_URL used to
 * kill the process at import time, which on Railway looks like a failed deploy
 * with no usable logs. The app now starts, says what's wrong, and recovers on
 * its own once the variable is set.
 */
export function assertConfig() {
  if (!config.databaseUrl) {
    console.error(
      '[config] DATABASE_URL is not set. The app will start but cannot store anything yet.',
    );
  }
  if (!config.twilio.enabled) {
    console.warn(
      '[config] Twilio is not configured — outgoing texts will be logged to stdout instead of sent.',
    );
  }
  if (!config.adminToken) {
    console.warn(
      '[config] ADMIN_TOKEN is not set — anyone who can reach this app can add or remove stores.',
    );
  }
}
