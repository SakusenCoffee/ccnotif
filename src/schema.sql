-- Stores being watched. Added through the UI, one row per storefront.
create table if not exists sites (
  id             bigserial primary key,
  origin         text        not null unique,
  name           text        not null,
  platform       text        not null default 'shopify',
  currency       text        not null default 'USD',
  collections    text[]      not null default '{}',
  enabled        boolean     not null default true,
  seeded_at      timestamptz,
  last_polled_at timestamptz,
  last_error     text,
  created_at     timestamptz not null default now()
);

-- Products mirrored from each watched store.
-- `external_id` is the store's own identifier for the product — a numeric id on
-- Shopify, a SKU on Shopware. It is only unique within a site, so the primary
-- key is a surrogate.
create table if not exists products (
  id                  bigserial primary key,
  site_id             bigint      not null references sites (id) on delete cascade,
  external_id         text        not null,
  handle              text        not null,
  url                 text,
  title               text        not null,
  vendor              text,
  product_type        text,
  image_url           text,
  price               numeric(10, 2),
  available           boolean     not null default false,
  is_preorder         boolean     not null default false,
  collections         text[]      not null default '{}',
  published_at        timestamptz,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  became_available_at timestamptz,
  unique (site_id, external_id)
);

-- Added after the first deploy, so these have to be ALTERs for existing
-- databases. `create table if not exists` above is a no-op once the table is
-- there, and these run every boot, so each has to be safe to repeat.
alter table products add column if not exists is_preorder boolean not null default false;
alter table products add column if not exists url text;

-- external_id started out bigint, which fits a Shopify product id but not a
-- Shopware SKU. Widening to text keeps every existing row addressable: the
-- numbers become their own decimal spelling, which is what the Shopify adapter
-- now sends, so nothing already stored looks like a new product afterwards.
--
-- Guarded on the current type rather than run unconditionally: ALTER COLUMN TYPE
-- rewrites the whole table and rebuilds its indexes, and this file runs on every
-- boot. Unguarded, that is a full rewrite of the products table on every restart.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = 'products'
       and column_name = 'external_id'
       and data_type <> 'text'
  ) then
    alter table products alter column external_id type text using external_id::text;
  end if;
end $$;

-- Back-fill the stored link for rows written before the column existed. Every
-- one of those came from a Shopify store, where the product URL is the origin
-- plus the handle.
update products p
   set url = s.origin || '/products/' || p.handle
  from sites s
 where s.id = p.site_id
   and p.url is null;

create index if not exists products_available_idx on products (site_id, available);
create index if not exists products_title_idx on products (lower(title));

-- One row per phone number that has asked to be notified.
create table if not exists subscribers (
  id              bigserial primary key,
  phone           text        not null unique,
  verified        boolean     not null default false,
  session_token   text unique,
  feed_token      text        not null unique,
  code_hash       text,
  code_expires_at timestamptz,
  code_attempts   int         not null default 0,
  code_sent_at    timestamptz,
  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now()
);

-- A standing alert: text me about anything whose title matches this, without my
-- having to have found the product and ticked it first. Free text, matched
-- fuzzily (see src/match.js).
alter table subscribers add column if not exists keyword text;

-- An account, so a watchlist can be reached from another browser without a
-- phone number being involved at all. Both columns are nullable: a session-only
-- watcher has neither, a phone-verified one may have neither, and either kind
-- can gain them later.
alter table subscribers add column if not exists username text;
alter table subscribers add column if not exists password_hash text;

-- Case-insensitively unique, so "Jack" and "jack" cannot both be registered.
-- Postgres does not treat NULLs as equal, so accounts without a username are
-- unaffected by this index however many of them there are.
create unique index if not exists subscribers_username_idx
  on subscribers (lower(username));

-- Push notifications as an alternative to texting. The topic is generated, not
-- chosen: on a public ntfy server anyone who knows a topic name can read it, so
-- a guessable one would leak what you watch.
alter table subscribers add column if not exists ntfy_topic text;
alter table subscribers add column if not exists ntfy_enabled boolean not null default false;

-- Watching no longer requires a phone number. A visitor who ticks something
-- gets a row here with no phone at all, identified only by their session, and
-- attaches a number later if and when they want texts. The unique index still
-- holds: Postgres does not treat NULLs as equal, so any number of anonymous
-- rows coexist while a real number stays unique.
alter table subscribers alter column phone drop not null;

-- The watchlist: which subscriber wants a text about which product.
create table if not exists watches (
  subscriber_id    bigint      not null references subscribers (id) on delete cascade,
  product_id       bigint      not null references products (id) on delete cascade,
  created_at       timestamptz not null default now(),
  last_notified_at timestamptz,
  primary key (subscriber_id, product_id)
);

create index if not exists watches_product_idx on watches (product_id);

-- Whether this particular watch should text. Watching and being texted are now
-- separate decisions: you can follow a dozen things and be woken by one.
--
-- Defaulting to true is deliberate for the back-fill only. Every row that
-- existed before this column was created under the old contract, where ticking
-- a product *was* asking for texts, and silently switching those people off
-- would have been the wrong way round. New rows are inserted with it off, so
-- the default never applies to them.
alter table watches add column if not exists notify boolean not null default true;

-- The second switch, matching the one a standing alert has: hand this product
-- to the buyer userscript when it becomes buyable. Off by default — arming a
-- purchase is never something to infer from someone ticking "watch".
alter table watches add column if not exists autobuy boolean not null default false;

-- Standing alerts, one term per row.
--
-- This began as a single comma-separated text field on the subscriber, which
-- could only ever be all-or-nothing: every term notified, or none did. Two
-- independent decisions turn out to matter per term — whether it should reach
-- your phone, and whether it should arm the buyer — and a single string has
-- nowhere to record them.
create table if not exists alerts (
  id            bigserial   primary key,
  subscriber_id bigint      not null references subscribers (id) on delete cascade,
  term          text        not null,
  -- Send a push/SMS when this matches.
  notify        boolean     not null default true,
  -- Offer the match to the buyer userscript, which opens the product.
  autobuy       boolean     not null default false,
  created_at    timestamptz not null default now()
);

-- Case-insensitively unique per person: "OP-17" and "op-17" are one alert.
create unique index if not exists alerts_subscriber_term_idx
  on alerts (subscriber_id, lower(term));

-- Carry the old single field across. Terms were comma-separated, and every one
-- of them notified, so that is what they become; nothing is armed for buying
-- without being asked for explicitly.
insert into alerts (subscriber_id, term, notify, autobuy)
select s.id, btrim(t.term), true, false
  from subscribers s,
       lateral unnest(string_to_array(s.keyword, ',')) as t(term)
 where s.keyword is not null
   and btrim(t.term) <> ''
on conflict do nothing;

-- When a keyword alert last texted someone about a given product. Separate from
-- `watches` because these products were never chosen — the alert found them —
-- but the cooldown reasoning is identical: a product whose availability flaps
-- must not become a stream of texts.
create table if not exists keyword_alerts (
  subscriber_id    bigint      not null references subscribers (id) on delete cascade,
  product_id       bigint      not null references products (id) on delete cascade,
  term             text,
  last_notified_at timestamptz not null default now(),
  primary key (subscriber_id, product_id)
);


-- Append-only log of interesting things, which is what the RSS feed renders.
create table if not exists events (
  id         bigserial primary key,
  product_id bigint      not null references products (id) on delete cascade,
  type       text        not null check (type in ('restock', 'new', 'sold_out')),
  title      text        not null,
  url        text        not null,
  image_url  text,
  price      numeric(10, 2),
  created_at timestamptz not null default now()
);

create index if not exists events_created_idx on events (created_at desc);
create index if not exists events_product_idx on events (product_id, created_at desc);
-- What the buyer userscript has already been handed, so a restock is offered
-- once rather than every time the script asks.
create table if not exists dispatches (
  subscriber_id bigint      not null references subscribers (id) on delete cascade,
  event_id      bigint      not null references events (id) on delete cascade,
  term          text,
  created_at    timestamptz not null default now(),
  primary key (subscriber_id, event_id)
);

-- Audit trail of every text we tried to send.
create table if not exists deliveries (
  id            bigserial primary key,
  subscriber_id bigint      not null references subscribers (id) on delete cascade,
  event_id      bigint references events (id) on delete set null,
  status        text        not null,
  provider_sid  text,
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists deliveries_subscriber_idx on deliveries (subscriber_id, created_at desc);
