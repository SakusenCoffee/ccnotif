import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Adding a site lets a visitor make this server issue HTTP requests to a host
 * of their choosing. Unguarded, that is a server-side request forgery hole:
 * `http://169.254.169.254/` is the cloud metadata endpoint, `http://127.0.0.1:5432`
 * is our own database. Every outbound fetch for user-supplied URLs goes through
 * here, which resolves the hostname and refuses to talk to anything that isn't a
 * public address — on the original URL and on every redirect hop.
 */

const MAX_BYTES = 8 * 1024 * 1024;
// However large a caller claims its response may be, this is the real ceiling:
// the body is buffered in memory, so an unbounded opt-out would just move the
// failure from a clear error to the process being killed.
const ABSOLUTE_MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

function ipv4IsPublic(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false; // 192.0.0/24 + 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false;
  if (a === 203 && b === 0) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function ipv6IsPublic(ip) {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::1' || addr === '::') return false;

  // IPv4-mapped (::ffff:1.2.3.4) inherits the IPv4 rules.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPublic(mapped[1]);

  const head = Number.parseInt(addr.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((head & 0xffc0) === 0xfe80) return false; // link local fe80::/10
  if ((head & 0xff00) === 0xff00) return false; // multicast
  return true;
}

export function addressIsPublic(ip) {
  const version = net.isIP(ip);
  if (version === 4) return ipv4IsPublic(ip);
  if (version === 6) return ipv6IsPublic(ip);
  return false;
}

/** Throws unless every address the hostname resolves to is publicly routable. */
export async function assertPublicHost(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('That is not a valid URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http and https URLs are supported.');
  }
  if (url.port && !['80', '443', ''].includes(url.port)) {
    throw new Error('Only the standard web ports (80 and 443) are allowed.');
  }

  // A bare IP literal skips DNS entirely.
  if (net.isIP(url.hostname)) {
    if (!addressIsPublic(url.hostname)) {
      throw new Error('That address is not publicly routable.');
    }
    return url;
  }

  let records;
  try {
    records = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve ${url.hostname}.`);
  }
  if (!records.length) throw new Error(`Could not resolve ${url.hostname}.`);

  for (const { address } of records) {
    if (!addressIsPublic(address)) {
      throw new Error(`${url.hostname} resolves to a private address.`);
    }
  }
  return url;
}

/**
 * fetch() with the host check applied to every hop, a hard timeout, and a
 * response size cap.
 */
export async function safeFetch(urlString, { headers = {}, signal, maxBytes = MAX_BYTES } = {}) {
  let current = urlString;
  // A caller may raise the ceiling for one request it knows is legitimately
  // large — a sitemap index, say — without loosening it for everything else.
  const limit = Math.max(0, Math.min(maxBytes, ABSOLUTE_MAX_BYTES));

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'preorder-watch/1.0 (+restock notifier)',
          ...headers,
        },
      });
    } catch (err) {
      throw new Error(
        err.name === 'AbortError' ? 'The store took too long to respond.' : `Request failed: ${err.message}`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('The store sent a redirect with no destination.');
      current = new URL(location, current).toString();
      continue;
    }

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > limit) throw new Error('The response was too large.');

    const text = await res.text();
    if (text.length > limit) throw new Error('The response was too large.');

    return {
      ok: res.ok,
      status: res.status,
      url: current,
      text,
      // How long the server asked us to wait, when it says. A store answering
      // 429 usually names a figure, and honouring it is both faster to recover
      // from and less likely to deepen the block than a guess.
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    };
  }

  throw new Error('Too many redirects.');
}

/** Retry-After is either a number of seconds or an HTTP date. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

export async function safeFetchJson(url, options) {
  const res = await safeFetch(url, options);
  if (!res.ok) {
    // The status travels on the error, not only inside its text. Callers need
    // to tell "this one collection is broken" from "the store is telling us to
    // stop", and re-reading it out of a message is how that gets missed.
    throw Object.assign(new Error(`${res.url} responded ${res.status}`), {
      status: res.status,
      retryAfterMs: res.retryAfterMs,
    });
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`${res.url} did not return JSON.`);
  }
}
