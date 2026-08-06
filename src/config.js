import 'dotenv/config';

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
  databaseUrl: process.env.DATABASE_URL,

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

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    // With no credentials the app still runs end-to-end; texts are logged to
    // stdout instead of sent. Handy while building the UI.
    get enabled() {
      return Boolean(this.accountSid && this.authToken && (this.from || this.messagingServiceSid));
    },
  },

  verification: {
    codeTtlMinutes: int(process.env.CODE_TTL_MINUTES, 10),
    maxAttempts: int(process.env.CODE_MAX_ATTEMPTS, 5),
    resendCooldownSeconds: int(process.env.CODE_RESEND_COOLDOWN_SECONDS, 60),
  },

  // When set, adding/editing/removing stores requires this token. Leave unset
  // while the app is private; set it before sharing the URL.
  adminToken: process.env.ADMIN_TOKEN || null,

  defaultCountry: process.env.DEFAULT_PHONE_COUNTRY || 'US',
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
