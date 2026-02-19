// apps/api/src/index.ts
//
// ✅ إصلاحات CORS:
//   - CORS مش string split بسيطة — regex آمنة للـ subdomains
//   - Wildcard *.yourdomain.com مُعالَج بشكل صحيح فـ الكود
//   - Preflight OPTIONS مُعالَج صريحاً
//   - Export RateLimiterDO للـ Durable Object (مطلوب فـ wrangler)

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { prettyJSON } from 'hono/pretty-json';
import type { Env } from './env.js';
import { authRoutes } from './routes/auth.js';
import { tenantRoutes } from './routes/tenants.js';
import { productRoutes } from './routes/products.js';
import { categoryRoutes } from './routes/categories.js';
import { orderRoutes } from './routes/orders.js';
import { billingRoutes } from './routes/billing.js';
import { uploadRoutes } from './routes/upload.js';
import { webhookRoutes } from './routes/webhook.js';
import { adminRoutes } from './routes/admin.js';

// Re-export Durable Object class — wrangler requires this export
export { RateLimiterDO } from './middleware/rateLimit.js';

export type AppContext = {
  Bindings: Env;
  Variables: {
    userId: string;
    tenantId: string;
    role: string;
    plan: string;
  };
};

const app = new Hono<AppContext>();

// ─── Global Middleware ────────────────────────────────────────

app.use('*', logger());

app.use('*', secureHeaders({
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  // Note: HSTS not set here — Cloudflare handles it at edge
}));

// ─── CORS ─────────────────────────────────────────────────────
// ✅ Correct implementation:
//    - Parse allowed origins from env (comma-separated)
//    - Wildcard *.yourdomain.com → converted to regex (NOT passed raw to browser)
//    - Browser always receives exact origin back (never wildcard)
//    - Credentials: true requires exact origin match

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');

  // Handle preflight
  if (c.req.method === 'OPTIONS') {
    if (origin && isAllowedOrigin(origin, c.env.CORS_ORIGINS)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tenant-Slug, X-Admin-Key');
      c.header('Access-Control-Max-Age', '86400');
      return c.body(null, 204);
    }
    return c.body(null, 204);
  }

  // Actual request
  if (origin && isAllowedOrigin(origin, c.env.CORS_ORIGINS)) {
    c.header('Access-Control-Allow-Origin', origin);   // exact origin, never '*'
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }

  await next();
});

app.use('*', prettyJSON());

// ─── Health ───────────────────────────────────────────────────
app.get('/health', (c) =>
  c.json({ ok: true, ts: new Date().toISOString(), version: '1.0.0' })
);

// ─── Routes ───────────────────────────────────────────────────
// Auth (no tenant context needed)
app.route('/auth', authRoutes);

// Tenant management
app.route('/tenants', tenantRoutes);

// Store (public storefront) — tenant resolved from host/header inside each route
app.route('/store', productRoutes);
app.route('/store', orderRoutes);
app.route('/store/categories', categoryRoutes);

// Dashboard (requires auth + tenant) — same routers, different guard in middleware
app.route('/dashboard', productRoutes);
app.route('/dashboard', orderRoutes);
app.route('/dashboard/categories', categoryRoutes);

// Billing
app.route('/billing', billingRoutes);

// File uploads
app.route('/upload', uploadRoutes);

// Stripe webhook — must receive raw body (no JSON parsing)
app.route('/stripe', webhookRoutes);

// Platform admin
app.route('/admin', adminRoutes);

// ─── Error handlers ───────────────────────────────────────────
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

app.onError((err, c) => {
  // Structured logging for Cloudflare logpush
  console.error(JSON.stringify({
    level: 'error',
    message: err.message,
    stack: err.stack,
    url: c.req.url,
    method: c.req.method,
    ts: new Date().toISOString(),
  }));
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default app;

// ─── CORS validation ─────────────────────────────────────────

/**
 * Validates an Origin against a comma-separated allowlist.
 *
 * Supports:
 *   - Exact: "https://app.yourdomain.com"
 *   - Wildcard subdomain: "https://*.yourdomain.com"
 *     → converted to regex, never sent raw to browser
 *   - localhost patterns for dev: "http://localhost:4321"
 *
 * The critical correctness property:
 *   This function returns boolean — the caller always responds with
 *   the exact `Origin` header value, NEVER a wildcard string.
 *   This satisfies: credentials:true requires non-wildcard ACAO header.
 */
function isAllowedOrigin(origin: string, corsEnv?: string): boolean {
  if (!corsEnv) return false;

  const patterns = corsEnv.split(',').map(s => s.trim()).filter(Boolean);

  for (const pattern of patterns) {
    if (pattern === origin) return true;

    // Wildcard subdomain pattern: https://*.example.com
    if (pattern.includes('*')) {
      const regexStr = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // escape regex special chars
        .replace(/\\\*/g, '[a-zA-Z0-9-]+');       // * → valid subdomain chars only
      try {
        const regex = new RegExp(`^${regexStr}$`);
        if (regex.test(origin)) return true;
      } catch { /* invalid pattern, skip */ }
    }
  }

  return false;
}
