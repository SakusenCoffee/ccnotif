import { query } from './db.js';
import { discoverSite, normalizeOrigin } from './discover.js';

export async function listSites() {
  const { rows } = await query(
    `select s.*,
            (select count(*)::int from products p where p.site_id = s.id) as product_count,
            (select count(*)::int from products p where p.site_id = s.id and p.available) as available_count
       from sites s
      order by s.name asc`,
  );
  return rows;
}

export async function getSite(id) {
  const { rows } = await query('select * from sites where id = $1', [id]);
  return rows[0] ?? null;
}

export async function enabledSites() {
  const { rows } = await query(
    "select * from sites where enabled and collections <> '{}' order by id asc",
  );
  return rows;
}

/**
 * Create a site from a user-supplied URL. The collections are re-derived from a
 * fresh probe rather than trusted from the request, so a caller can't make us
 * poll arbitrary paths.
 */
export async function addSite({ url, collections, name }) {
  const origin = normalizeOrigin(url);

  const { rows: existing } = await query('select id from sites where origin = $1', [origin]);
  if (existing.length) {
    throw Object.assign(new Error('That store has already been added.'), { code: 'duplicate' });
  }

  const discovered = await discoverSite(origin);
  const known = new Set([
    ...discovered.suggested.map((c) => c.handle),
    ...discovered.others.map((c) => c.handle),
  ]);

  const chosen = (Array.isArray(collections) && collections.length
    ? collections
    : discovered.suggested.slice(0, 5).map((c) => c.handle)
  ).filter((handle) => known.has(handle));

  if (!chosen.length) {
    throw Object.assign(new Error('Pick at least one collection that exists on that store.'), {
      code: 'no_collections',
    });
  }

  const { rows } = await query(
    `insert into sites (origin, name, platform, currency, collections)
       values ($1,$2,$3,$4,$5)
     returning *`,
    [
      origin,
      (name || discovered.name).slice(0, 120),
      discovered.platform,
      discovered.currency,
      chosen,
    ],
  );
  return rows[0];
}

export async function updateSite(id, { collections, enabled, name }) {
  const site = await getSite(id);
  if (!site) return null;

  let nextCollections = site.collections;
  if (Array.isArray(collections)) {
    // Re-probe so a request can't introduce a handle the store doesn't have.
    const discovered = await discoverSite(site.origin);
    const known = new Set([
      ...discovered.suggested.map((c) => c.handle),
      ...discovered.others.map((c) => c.handle),
    ]);
    nextCollections = collections.filter((h) => known.has(h));
    if (!nextCollections.length) {
      throw Object.assign(new Error('Pick at least one collection that exists on that store.'), {
        code: 'no_collections',
      });
    }
  }

  const { rows } = await query(
    `update sites
        set collections = $2,
            enabled = coalesce($3, enabled),
            name = coalesce($4, name)
      where id = $1
      returning *`,
    [id, nextCollections, typeof enabled === 'boolean' ? enabled : null, name ?? null],
  );
  return rows[0];
}

export async function deleteSite(id) {
  // Products, events, and watches cascade from the site row.
  const { rowCount } = await query('delete from sites where id = $1', [id]);
  return rowCount > 0;
}
