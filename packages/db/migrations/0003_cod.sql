-- Migration: 0003_cod.sql
-- Adds COD (Cash on Delivery) payment support
-- Run: wrangler d1 migrations apply saas-ecommerce-db --remote
-- NOTE: D1 SQLite has limited ALTER TABLE — we add columns only

-- Add payment_method column (STRIPE | COD)
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'STRIPE'
  CHECK(payment_method IN ('STRIPE', 'COD'));

-- Add payment_status column (separate from order fulfillment status)
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK(payment_status IN ('PAID', 'UNPAID', 'PENDING', 'FAILED'));

-- Add customer_phone for COD contact (optional but useful)
ALTER TABLE orders ADD COLUMN customer_phone TEXT;

-- Add customer_address for COD delivery (optional)
ALTER TABLE orders ADD COLUMN customer_address TEXT;

-- Index for dashboard filtering by payment method
CREATE INDEX IF NOT EXISTS orders_payment_method_idx ON orders(tenant_id, payment_method);
CREATE INDEX IF NOT EXISTS orders_payment_status_idx ON orders(tenant_id, payment_status);
