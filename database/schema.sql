-- BrandSpot Relational Database Schema (SQLite / PostgreSQL-compatible design)
-- All monetary amounts are stored in integer PKR (or minor units) to avoid floating-point drift.
-- All timestamps are UTC ISO-8601 strings.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'seller', 'admin')),
  seller_id TEXT,
  city TEXT DEFAULT 'Islamabad',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  primary_category_id TEXT NOT NULL REFERENCES categories(id),
  partnership_mode TEXT NOT NULL CHECK (partnership_mode IN ('directory_only', 'affiliate_partner', 'marketplace_seller', 'sponsored_advertiser')),
  badge TEXT NOT NULL,
  description TEXT NOT NULL,
  city_coverage TEXT NOT NULL DEFAULT 'Nationwide',
  official_url TEXT DEFAULT '',
  link_status TEXT NOT NULL DEFAULT 'pending_verification' CHECK (link_status IN ('verified', 'pending_verification', 'disabled')),
  featured_order INTEGER DEFAULT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_categories (
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (brand_id, category_id)
);

CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  brand_id TEXT REFERENCES brands(id),
  contact_email TEXT NOT NULL,
  city TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('pending', 'verified', 'suspended')),
  integration_mode TEXT NOT NULL CHECK (integration_mode IN ('dashboard', 'rest_api', 'shopify', 'woocommerce')),
  payment_model TEXT NOT NULL CHECK (payment_model IN ('seller_collected', 'provider_collected')),
  is_demo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commission_agreements (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  category_id TEXT REFERENCES categories(id),
  rate_bps INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  fixed_pkr INTEGER NOT NULL DEFAULT 0,
  settlement_schedule TEXT NOT NULL CHECK (settlement_schedule IN ('weekly', 'biweekly', 'monthly')),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'draft')),
  version INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  seller_id TEXT REFERENCES sellers(id),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  original_price_pkr INTEGER NOT NULL CHECK (original_price_pkr >= 0),
  sale_price_pkr INTEGER NOT NULL CHECK (sale_price_pkr >= 0),
  stock_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  shipping_pkr INTEGER NOT NULL DEFAULT 0 CHECK (shipping_pkr >= 0),
  delivery_estimate TEXT NOT NULL DEFAULT '3-5 business days',
  city_scope TEXT NOT NULL DEFAULT 'Nationwide',
  image_url TEXT NOT NULL,
  is_direct_buy INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  seller_id TEXT REFERENCES sellers(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('flat_percent', 'up_to_percent', 'fixed_pkr', 'bogo', 'bundle', 'free_shipping')),
  discount_value INTEGER NOT NULL DEFAULT 0,
  voucher_code TEXT DEFAULT '',
  city_scope TEXT NOT NULL DEFAULT 'Nationwide',
  is_sponsored INTEGER NOT NULL DEFAULT 0,
  is_verified INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'draft')),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ranking_score REAL NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parent_orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES users(id),
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('pending', 'simulated_paid', 'cod_pending', 'refunded')),
  subtotal_pkr INTEGER NOT NULL,
  shipping_pkr INTEGER NOT NULL,
  total_pkr INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  is_demo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seller_orders (
  id TEXT PRIMARY KEY,
  parent_order_id TEXT NOT NULL REFERENCES parent_orders(id),
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  status TEXT NOT NULL CHECK (status IN (
    'order_created', 'awaiting_seller_acceptance', 'seller_accepted', 'seller_rejected',
    'processing', 'packed', 'dispatched', 'delivered', 'return_requested', 'refunded', 'cancelled', 'completed'
  )),
  subtotal_pkr INTEGER NOT NULL,
  shipping_pkr INTEGER NOT NULL,
  commission_rate_bps INTEGER NOT NULL,
  commission_pkr INTEGER NOT NULL,
  seller_net_pkr INTEGER NOT NULL,
  commission_status TEXT NOT NULL CHECK (commission_status IN ('estimated', 'pending_delivery', 'confirmed', 'payable', 'settled', 'reversed')),
  tracking_number TEXT DEFAULT '',
  rejection_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL REFERENCES seller_orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_pkr INTEGER NOT NULL,
  line_total_pkr INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL REFERENCES seller_orders(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_journal_entries (
  id TEXT PRIMARY KEY,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_postings (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES ledger_journal_entries(id),
  account_code TEXT NOT NULL,
  seller_id TEXT,
  debit_pkr INTEGER NOT NULL DEFAULT 0 CHECK (debit_pkr >= 0),
  credit_pkr INTEGER NOT NULL DEFAULT 0 CHECK (credit_pkr >= 0)
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  gross_sales_pkr INTEGER NOT NULL,
  commission_pkr INTEGER NOT NULL,
  net_payout_pkr INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reconciled', 'paid')),
  payment_reference TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sponsored_campaigns (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  slot TEXT NOT NULL CHECK (slot IN ('homepage_hero', 'category_hero', 'featured_brand', 'sponsored_card')),
  package_name TEXT NOT NULL,
  daily_rate_pkr INTEGER NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'scheduled', 'expired')),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS affiliate_events (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  referral_code TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('click', 'confirmed_conversion')),
  commission_pkr INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
