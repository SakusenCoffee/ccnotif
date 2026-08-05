import { config } from './config.js';
import { query } from './db.js';
import { formatPrice } from './money.js';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cdata(str) {
  return `<![CDATA[${String(str ?? '').replace(/]]>/g, ']]&gt;')}]]>`;
}

const TYPE_LABEL = {
  restock: 'Now in stock',
  new: 'New pre-order listed',
  sold_out: 'Sold out',
};

/**
 * Fetch feed items. `feedToken` scopes the feed to one subscriber's watchlist;
 * `siteId` scopes it to a single store. Omit both for everything.
 */
export async function getFeedItems({ types, feedToken, siteId, limit = 100 }) {
  const params = [types, limit];
  let sql = `
    select e.id, e.type, e.title, e.url, e.image_url, e.price, e.created_at,
           p.vendor, p.handle, s.name as site_name, s.currency
      from events e
      join products p on p.id = e.product_id
      join sites s on s.id = p.site_id
     where e.type = any($1::text[])`;

  if (feedToken) {
    params.push(feedToken);
    sql += `
       and exists (
         select 1 from watches w
           join subscribers sub on sub.id = w.subscriber_id
          where w.product_id = e.product_id and sub.feed_token = $${params.length}
       )`;
  }

  if (siteId) {
    params.push(siteId);
    sql += ` and p.site_id = $${params.length}`;
  }

  sql += ' order by e.created_at desc limit $2';
  const { rows } = await query(sql, params);
  return rows;
}

export function renderRss({ items, title, description, selfUrl }) {
  const now = new Date().toUTCString();

  const entries = items
    .map((item) => {
      const label = TYPE_LABEL[item.type] ?? item.type;
      const price = formatPrice(item.price, item.currency) ?? 'Price TBA';
      const body =
        `<p><strong>${esc(label)}</strong> — ${esc(price)}</p>` +
        `<p>${esc(item.site_name)}${item.vendor ? ` · ${esc(item.vendor)}` : ''}</p>` +
        (item.image_url ? `<p><img src="${esc(item.image_url)}" alt="${esc(item.title)}"/></p>` : '') +
        `<p><a href="${esc(item.url)}">View on ${esc(item.site_name)}</a></p>`;

      return `    <item>
      <title>${cdata(`${label}: ${item.title}`)}</title>
      <link>${esc(item.url)}</link>
      <guid isPermaLink="false">${esc(`${config.publicUrl}/events/${item.id}`)}</guid>
      <pubDate>${new Date(item.created_at).toUTCString()}</pubDate>
      <category>${esc(label)}</category>
      <source url="${esc(selfUrl)}">${esc(item.site_name)}</source>
      <description>${cdata(body)}</description>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${cdata(title)}</title>
    <link>${esc(config.publicUrl)}</link>
    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml"/>
    <description>${cdata(description)}</description>
    <language>en-us</language>
    <lastBuildDate>${items[0] ? new Date(items[0].created_at).toUTCString() : now}</lastBuildDate>
    <ttl>5</ttl>
${entries}
  </channel>
</rss>
`;
}

export function parseTypes(raw) {
  const valid = ['restock', 'new', 'sold_out'];
  if (!raw || raw === 'all') return valid;
  const requested = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((t) => valid.includes(t));
  return requested.length ? requested : ['restock'];
}
