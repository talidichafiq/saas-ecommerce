-- add payment method (stripe | cod)
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'stripe'
  CHECK(payment_method IN ('stripe','cod'));

-- optional: track payment state separately (إذا بغيتي)
-- ALTER TABLE orders ADD COLUMN paid_at TEXT;
