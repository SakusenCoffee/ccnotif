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

-- Products mirrored from each site's public products.json feed.
-- `external_id` is the store's own product id; it is only unique within a site,
-- so the primary key is a surrogate.
create table if not exists products (
  id                  bigserial primary key,
  site_id             bigint      not null references sites (id) on delete cascade,
  external_id         bigint      not null,
  handle              text        not null,
  title               text        not null,
  vendor              text,
  product_type        text,
  image_url           text,
  price               numeric(10, 2),
  available           boolean     not null default false,
  collections         text[]      not null default '{}',
  published_at        timestamptz,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  became_available_at timestamptz,
  unique (site_id, external_id)
);

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

-- The watchlist: which subscriber wants a text about which product.
create table if not exists watches (
  subscriber_id    bigint      not null references subscribers (id) on delete cascade,
  product_id       bigint      not null references products (id) on delete cascade,
  created_at       timestamptz not null default now(),
  last_notified_at timestamptz,
  primary key (subscriber_id, product_id)
);

create index if not exists watches_product_idx on watches (product_id);

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
