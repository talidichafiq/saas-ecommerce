PRAGMA foreign_keys=OFF;

ALTER TABLE orders RENAME TO orders_old;

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_address TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','paid','shipped','delivered','cancelled','refunded')),

  payment_method TEXT NOT NULL DEFAULT 'STRIPE'
    CHECK(payment_method IN ('STRIPE','COD')),

  payment_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(payment_status IN ('PAID','UNPAID','PENDING','FAILED')),

  subtotal REAL NOT NULL,
  total REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MAD',
  stripe_session_id TEXT UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO orders (
  id, tenant_id, customer_email, customer_name,
  status, subtotal, total, currency, stripe_session_id, notes, created_at,
  payment_method, payment_status
)
SELECT
  id, tenant_id, customer_email, customer_name,
  status, subtotal, total, currency, stripe_session_id, notes, created_at,
  'STRIPE' AS payment_method,
  CASE
    WHEN status='paid' THEN 'PAID'
    ELSE 'PENDING'
  END AS payment_status
FROM orders_old;

DROP TABLE orders_old;

PRAGMA foreign_keys=ON;
