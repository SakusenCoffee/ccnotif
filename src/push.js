import { config } from './config.js';

/**
 * Push notifications via ntfy.
 *
 * The alternative to paying per text. ntfy delivers to a phone app, a desktop
 * browser or anything that can hold an HTTP connection, costs nothing, needs no
 * account, and — unlike SMS — has no carrier in the middle deciding whether your
 * message looks like spam. Sending is one POST.
 *
 * The trade against SMS is honest: a text arrives on any phone with signal and
 * needs nothing installed, while this needs the app and a data connection. So
 * this sits alongside texting rather than replacing it, and a subscriber can
 * have either or both.
 *
 * On the public server a topic is readable by anyone who knows its name, so the
 * names here are generated rather than chosen. A guessable topic would leak
 * what someone watches to whoever guessed it.
 */

const TIMEOUT_MS = 10_000;

// ntfy passes these through as HTTP headers, which cannot carry newlines or
// non-ASCII. The body is UTF-8 and unrestricted, so anything expressive goes
// there and headers stay plain.
function headerSafe(value, max = 120) {
  const flat = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    // Latin-1 is what a header can represent; anything else is dropped rather
    // than mangled into replacement characters.
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A topic name that cannot be guessed, and that ntfy will accept verbatim. */
export function isValidTopic(topic) {
  return typeof topic === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(topic);
}

/**
 * Send one notification. Returns { ok, error } rather than throwing, so one
 * unreachable topic cannot abort a batch — the same contract as sendSms.
 */
export async function sendPush(topic, { title, message, url, image, priority = 'default', tags }) {
  if (!isValidTopic(topic)) {
    return { ok: false, error: 'That notification topic is not valid.' };
  }

  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    ...(title ? { Title: headerSafe(title) } : {}),
    ...(priority ? { Priority: String(priority) } : {}),
    ...(tags?.length ? { Tags: tags.map((t) => headerSafe(t, 30)).join(',') } : {}),
    // Tapping the notification opens the product rather than the app.
    ...(url ? { Click: url } : {}),
    ...(image ? { Attach: image } : {}),
    ...(config.ntfy.token ? { Authorization: `Bearer ${config.ntfy.token}` } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${config.ntfy.server}/${topic}`, {
      method: 'POST',
      headers,
      body: message,
      signal: controller.signal,
    });

    if (!res.ok) {
      // ntfy explains itself in the body; pass that on rather than a bare code.
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        error: `ntfy responded ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err.name === 'AbortError'
          ? 'The notification server took too long to respond.'
          : `Could not reach the notification server: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Where a subscriber points their ntfy app. */
export function topicUrl(topic) {
  return `${config.ntfy.server}/${topic}`;
}

/**
 * The restock notification, as a push rather than a text. It can afford more
 * than an SMS: a title, the price, a thumbnail, and a tap that opens the
 * product page directly.
 */
export function restockPush(event, currency, formatPrice) {
  const price = formatPrice(event.price, currency);
  return {
    title: event.type === 'restock' ? 'Now in stock' : 'New pre-order listed',
    message: `${event.title}${price ? `\n${price}` : ''}`,
    url: event.url,
    image: event.image_url ?? undefined,
    // High, not urgent: urgent bypasses a phone's do-not-disturb, and this is a
    // shopping alert.
    priority: 'high',
    tags: event.type === 'restock' ? ['shopping_cart'] : ['sparkles'],
  };
}

/** A push announcing that pushes work, sent when someone switches them on. */
export function testPush() {
  return {
    title: `${config.appName} is connected`,
    message: 'Alerts for the products you watch will arrive here.',
    url: config.publicUrl,
    priority: 'default',
    tags: ['white_check_mark'],
  };
}
