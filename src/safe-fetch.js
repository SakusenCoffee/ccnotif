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
export async function safeFetch(urlString, { headers = {}, signal } = {}) {
  let current = urlString;

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
    if (declared > MAX_BYTES) throw new Error('The response was too large.');

    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('The response was too large.');

    return { ok: res.ok, status: res.status, url: current, text };
  }

  throw new Error('Too many redirects.');
}

export async function safeFetchJson(url, options) {
  const res = await safeFetch(url, options);
  if (!res.ok) throw new Error(`${res.url} responded ${res.status}`);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`${res.url} did not return JSON.`);
  }
}
