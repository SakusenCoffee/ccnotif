import { config } from './config.js';
import { safeFetch } from './safe-fetch.js';

/**
 * robots.txt, honoured.
 *
 * Reading a Shopify store costs two or three JSON requests. Reading a storefront
 * that only renders HTML costs one request per listing page — dozens per poll,
 * every few minutes, forever. That is enough traffic that the store's own rules
 * about it matter, so every scraped fetch goes through here: it obeys Disallow
 * and spaces requests out by Crawl-delay.
 *
 * A store may, for instance, publish `Crawl-delay: 10` while disallowing
 * `?limit=` (which is why listings are paged rather than fetched in bulk) and
 * explicitly allows `?p=`, the pagination the adapter uses.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ROBOTS_MAX_BYTES = 512 * 1024;

const cache = new Map(); // origin -> { robots, fetchedAt }

/** Our token in robots.txt terms: the product name from the User-Agent header. */
const OUR_AGENT = 'preorder-watch';

const PERMISSIVE = { rules: [], crawlDelayMs: null, source: 'none' };

function parseRobots(text) {
  // Group directives by the user-agents they were introduced with. A blank line
  // or a Disallow ends a run of User-agent lines; the next User-agent starts a
  // new group.
  const groups = [];
  let current = null;
  let expectingAgents = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    expectingAgents = false;

    if (field === 'disallow' || field === 'allow') {
      // "Disallow:" with an empty value means "nothing is disallowed", which is
      // a permission, not a rule about the empty path.
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }

  // Most specific wins: a group naming us beats the catch-all.
  const ours = groups.find((g) => g.agents.some((a) => a !== '*' && OUR_AGENT.startsWith(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = ours ?? wildcard;
  if (!group) return { ...PERMISSIVE, source: 'robots' };

  return {
    rules: group.rules,
    crawlDelayMs: group.crawlDelay === null ? null : Math.round(group.crawlDelay * 1000),
    source: 'robots',
  };
}

/** Translate a robots.txt path pattern (`*` and `$`) into a regular expression. */
function patternToRegExp(pattern) {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '$') source += '$';
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}`);
}

/**
 * Whether robots.txt permits this path. Ties go to the longest matching
 * pattern, and to Allow when an Allow and a Disallow are the same length —
 * the behaviour every major crawler implements.
 */
export function pathAllowed(robots, pathWithQuery) {
  let best = null;
  for (const rule of robots.rules ?? []) {
    if (!patternToRegExp(rule.pattern).test(pathWithQuery)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

/** Fetch and cache a store's robots.txt. Unreadable robots.txt means no rules. */
export async function robotsFor(origin, { signal } = {}) {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.robots;

  let robots = PERMISSIVE;
  try {
    const res = await safeFetch(`${origin}/robots.txt`, {
      headers: { accept: 'text/plain' },
      signal,
    });
    // A 404 is a store with no rules. A 5xx is a store having a bad day, and
    // guessing at rules we can't read would be worse than assuming none.
    if (res.ok && res.text.length <= ROBOTS_MAX_BYTES) robots = parseRobots(res.text);
  } catch {
    // Unreachable robots.txt: fall through to the permissive default. The
    // request that follows will fail on its own if the store is really down.
  }

  cache.set(origin, { robots, fetchedAt: Date.now() });
  return robots;
}

/** How long to wait between requests to this store. */
export function delayFor(robots) {
  const declared = robots.crawlDelayMs;
  if (declared === null || declared === undefined) return config.crawl.defaultDelayMs;
  // Honour the store's figure, but don't let an extreme one wedge a poll for
  // hours; the operator's ceiling wins above that.
  return Math.min(Math.max(declared, 0), config.crawl.maxDelayMs);
}

// One queue per host, so several categories on the same store take turns rather
// than all firing at once and defeating the crawl delay.
//
// The state object is mutated in place and never replaced: a request records
// when it finished, and the next one reads that same object to work out how
// long to wait. Copying it per call would hand every request the timestamp as
// it stood when the request was *queued* — always the stale one — and the delay
// would silently never apply.
const queues = new Map(); // host -> { chain, lastFinishedAt }

export function pace(host, delayMs, fn) {
  let state = queues.get(host);
  if (!state) {
    state = { chain: Promise.resolve(), lastFinishedAt: 0 };
    queues.set(host, state);
  }

  const run = state.chain.then(async () => {
    const wait = state.lastFinishedAt + delayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await fn();
    } finally {
      state.lastFinishedAt = Date.now();
    }
  });

  // The chain must survive a failed request, or one error would poison every
  // later fetch to that host.
  state.chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export class RobotsDisallowed extends Error {
  constructor(url) {
    super(`${url} is disallowed by that store's robots.txt.`);
    this.name = 'RobotsDisallowed';
    this.code = 'robots_disallowed';
  }
}

/**
 * Fetch a page as a crawler should: rules checked, requests spaced out.
 * Returns the full response, including the URL it finally landed on.
 */
export async function politeFetch(urlString, { signal, headers = {} } = {}) {
  const url = new URL(urlString);
  const origin = `${url.protocol}//${url.host}`;

  const robots = await robotsFor(origin, { signal });
  if (!pathAllowed(robots, `${url.pathname}${url.search}`)) throw new RobotsDisallowed(urlString);

  return pace(url.host, delayFor(robots), () =>
    safeFetch(urlString, {
      headers: { accept: 'text/html,application/xhtml+xml', ...headers },
      signal,
    }),
  );
}

/** As politeFetch, but yields the body and treats a non-2xx as a failure. */
export async function politeFetchText(urlString, options) {
  const res = await politeFetch(urlString, options);
  if (!res.ok) throw new Error(`${res.url} responded ${res.status}`);
  return res.text;
}

/** Test seam: forget cached robots.txt so a store can be re-read. */
export function clearRobotsCache() {
  cache.clear();
}
