-- Migration: 0001_init.sql
-- Generated for Cloudflare D1

PRAGMA foreign_keys = ON;

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','business')),
  logo_r2_key TEXT,
  primary_color TEXT DEFAULT '#6366f1',
  shipping_policy TEXT,
  return_policy TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  reset_token TEXT,
  reset_token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Memberships
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('owner','admin','staff')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_tenant_idx ON memberships(tenant_id);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  sale_price REAL,
  currency TEXT NOT NULL DEFAULT 'MAD' CHECK(currency IN ('MAD','EUR','USD')),
  sku TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('active','draft','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS products_tenant_idx ON products(tenant_id);
CREATE INDEX IF NOT EXISTS products_status_idx ON products(tenant_id, status);

-- Product Images
CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  alt TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS product_images_product_idx ON product_images(product_id);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS categories_tenant_idx ON categories(tenant_id);

-- Product Categories (pivot)
CREATE TABLE IF NOT EXISTS product_categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE(product_id, category_id)
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','shipped','cancelled','refunded')),
  subtotal REAL NOT NULL,
  total REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MAD',
  stripe_session_id TEXT UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS orders_tenant_idx ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(tenant_id, status);
CREATE INDEX IF NOT EXISTS orders_stripe_idx ON orders(stripe_session_id);

-- Order Items
CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT,
  title_snapshot TEXT NOT NULL,
  price_snapshot REAL NOT NULL,
  qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);

-- Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','trialing','past_due','canceled','incomplete')),
  plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','business')),
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_tenant_idx ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_logs(actor_user_id);
