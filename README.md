# SaaS Ecommerce Platform

Multi-tenant SaaS ecommerce monorepo — Cloudflare Workers + Astro SSR + Hono + Drizzle (D1).

## Stack

| Layer | Technology |
|---|---|
| **API** | Cloudflare Worker · Hono · Drizzle ORM |
| **DB** | Cloudflare D1 (SQLite) |
| **Storage** | Cloudflare R2 |
| **Rate limit** | KV (public) + Durable Objects (login) |
| **Frontend** | Astro SSR · Tailwind · Cloudflare Pages |
| **Auth** | Session-based (HttpOnly cookie) · PBKDF2 |
| **Payments** | Stripe (online card) + COD (Cash on Delivery) |
| **Email** | Resend |
| **i18n** | Arabic (RTL) + English |

---

## Quick Start (Local Dev)

```bash
# 1. Install
pnpm install

# 2. Copy env files
cp apps/api/.env.example apps/api/.env.local
cp apps/web/.env.example apps/web/.env.local
# Fill in your values

# 3. Run local D1 migrations
pnpm db:migrate

# 4. Start dev servers in parallel
pnpm dev
# API: http://localhost:8787
# Web: http://localhost:4321
```

---

## Deploy to Cloudflare

### Prerequisites

- Cloudflare account with Workers, D1, R2, KV enabled
- `wrangler` CLI authenticated: `wrangler login`
- `pnpm` installed

---

### Step 1 — Create Cloudflare resources (once)

```bash
# D1 database
wrangler d1 create saas-ecommerce-db
# → copy the database_id from output

# KV namespace (for rate limiting)
wrangler kv namespace create RATE_LIMIT
# → copy the id from output

# R2 bucket (for product images)
wrangler r2 bucket create saas-ecommerce-uploads
```

---

### Step 2 — Put real IDs in wrangler.toml

Edit `apps/api/wrangler.toml` → `[env.production]`:

```toml
[[env.production.d1_databases]]
database_id = "your-actual-d1-uuid-here"   # from Step 1

[[env.production.kv_namespaces]]
id = "your-actual-kv-id-here"              # from Step 1
```

Commit this change. **These IDs are not secrets — safe to commit.**

---

### Step 3 — Set secrets (once, not in wrangler.toml)

```bash
wrangler secret put STRIPE_SECRET_KEY     --env production
wrangler secret put STRIPE_WEBHOOK_SECRET --env production
wrangler secret put RESEND_API_KEY        --env production
wrangler secret put ADMIN_SECRET          --env production
```

---

### Step 4 — Run DB migrations

```bash
# Apply all migrations to production D1
pnpm db:migrate:prod

# Migrations are in: packages/db/migrations/
# 0001_init.sql          — base schema
# 0002_email_verify.sql  — email verification columns
# 0003_cod.sql           — COD payment support
```

---

### Step 5 — Deploy API Worker

```bash
# From repo root
pnpm deploy:api

# Or directly
pnpm -C apps/api deploy:prod

# Or with wrangler
cd apps/api && wrangler deploy --env production
```

Expected output: `Deployed saas-ecommerce (production)`

---

### Step 6 — Deploy Web (Cloudflare Pages)

#### Option A: Cloudflare Pages Dashboard (recommended)

| Setting | Value |
|---|---|
| **Framework preset** | Astro |
| **Root directory** | `apps/web` |
| **Build command** | `pnpm build` |
| **Build output dir** | `dist` |
| **Node version** | `20` |
| **Package manager** | `pnpm` (not bun) |

**Environment Variables** (set in Pages dashboard → Settings → Environment Variables):

| Variable | Value |
|---|---|
| `PUBLIC_API_URL` | `https://saas-ecommerce.talidichafiq.workers.dev` |
| `PUBLIC_APP_NAME` | `StoreBuilder` (or your brand name) |

#### Option B: GitHub Actions (CI/CD)

See `.github/workflows/deploy.yml` — pushes to `main` branch auto-deploy.

Required GitHub Secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token with Workers:Edit + D1:Edit + Pages:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `PUBLIC_API_URL` | `https://saas-ecommerce.talidichafiq.workers.dev` |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `RESEND_API_KEY` | Resend API key |
| `ADMIN_SECRET` | Random 32+ char string |

---

### Step 7 — Stripe Webhook

In Stripe Dashboard → Developers → Webhooks → Add endpoint:

- **URL:** `https://saas-ecommerce.talidichafiq.workers.dev/stripe/webhook`
- **Events:** `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`
- Copy the **signing secret** → `wrangler secret put STRIPE_WEBHOOK_SECRET --env production`

---

## Deployment Checklist

```
□ wrangler d1 create saas-ecommerce-db           → got database_id
□ wrangler kv namespace create RATE_LIMIT         → got KV id
□ wrangler r2 bucket create saas-ecommerce-uploads
□ wrangler.toml [env.production] has real D1 + KV IDs (not placeholders)
□ wrangler secret put STRIPE_SECRET_KEY --env production
□ wrangler secret put STRIPE_WEBHOOK_SECRET --env production
□ wrangler secret put RESEND_API_KEY --env production
□ wrangler secret put ADMIN_SECRET --env production
□ pnpm db:migrate:prod                            → all 3 migrations applied
□ pnpm deploy:api                                 → Worker deployed
□ Cloudflare Pages project created (saas-ecommerce-web)
□ Pages env vars set (PUBLIC_API_URL, PUBLIC_APP_NAME)
□ Pages build triggered and succeeded
□ Stripe webhook endpoint created + STRIPE_WEBHOOK_SECRET updated
□ Health check: GET https://saas-ecommerce.talidichafiq.workers.dev/health → { ok: true }
```

---

## Known Cloudflare Issues & Fixes (History)

| Issue | Root cause | Fix |
|---|---|---|
| CI failed `--frozen-lockfile` | `pnpm-lock.yaml` missing | Commit lockfile; keep `--frozen-lockfile` |
| `wrangler not found` in CI | Running install from wrong directory | `working-directory: apps/api` in Actions |
| `Missing entry-point` on deploy | `wrangler deploy` without config path | Added `--config wrangler.toml` and `--env production` to scripts |
| R2 error 10042 | R2 not enabled on account | Enable R2 in Cloudflare dashboard |
| KV error 10042 | Placeholder `YOUR_KV_NAMESPACE_ID` in toml | Replace with real KV id in `[env.production]` |
| D1 not found | Placeholder `YOUR_D1_DATABASE_ID` in toml | Replace with real D1 uuid in `[env.production]` |
| DO error on Free plan | `new_classes` not supported on Free | Changed to `new_sqlite_classes` in `[[migrations]]` |

---

## Project Structure

```
saas-ecommerce/
├── apps/
│   ├── api/                    # Cloudflare Worker (Hono)
│   │   ├── src/
│   │   │   ├── middleware/     # auth, rateLimit, rbac, tenant
│   │   │   └── routes/        # auth, orders, products, billing, webhook…
│   │   └── wrangler.toml
│   └── web/                    # Astro SSR (Cloudflare Pages)
│       ├── src/
│       │   ├── i18n/          # ar.ts, en.ts
│       │   ├── layouts/       # DashboardLayout, StorefrontLayout
│       │   └── pages/         # auth/, dashboard/, store/
│       └── astro.config.mjs
├── packages/
│   ├── db/                     # Drizzle schema + D1 migrations
│   │   └── migrations/
│   │       ├── 0001_init.sql
│   │       ├── 0002_email_verify.sql
│   │       └── 0003_cod.sql   # COD payment support
│   └── shared/                 # Zod schemas + TypeScript types
└── .github/workflows/deploy.yml
```

---

## Manual Test Checklist

### Stripe Flow
1. Browse `/catalog` → add product to cart
2. Go to `/cart` → select **بطاقة (Card)** → enter email → click **إتمام الشراء**
3. Stripe checkout opens → use test card `4242 4242 4242 4242`
4. Redirect to `/success` → shows order with 💳 badge
5. Dashboard `/dashboard/orders` → order shows `STRIPE` + `PENDING` → update to `paid`

### COD Flow
1. Browse `/catalog` → add product to cart
2. Go to `/cart` → select **الدفع عند الاستلام (COD)**
3. Fill name, phone, address → click **تأكيد الطلب**
4. API creates order with `paymentMethod=COD`, `paymentStatus=UNPAID`
5. Redirect to `/success?method=cod` → shows 🏠 badge + COD reminder
6. Dashboard `/dashboard/orders` → shows COD badge + `غير مدفوع` + amber highlight
7. Click **تحديث** → use quick action **تأكيد التسليم** → status → `delivered`, payment → `PAID` (auto)
8. COD pending alert disappears from orders list

### Auth Flow
1. Register → verify email → login → create tenant (onboarding)
2. Logout → verify session cookie cleared → redirect to login
3. Forgot password → check email → click reset link → enter new password

### API Health Check
```bash
curl https://saas-ecommerce.talidichafiq.workers.dev/health
# → { "ok": true, "ts": "...", "version": "1.0.0" }

# COD checkout test
curl -X POST https://saas-ecommerce.talidichafiq.workers.dev/store/checkout/cod \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Slug: your-store-slug" \
  -d '{
    "items": [{"productId": "valid-uuid", "qty": 1}],
    "customerEmail": "test@example.com",
    "customerName": "محمد أمين",
    "customerPhone": "0612345678",
    "customerAddress": "123 شارع الحسن الثاني، الدار البيضاء",
    "currency": "MAD"
  }'
```
