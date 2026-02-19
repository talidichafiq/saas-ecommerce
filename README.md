# 🏪 SaaS E-commerce — Multi-tenant Platform

منصة SaaS متكاملة لإنشاء وإدارة المتاجر الإلكترونية. مبنية على Cloudflare Edge (Pages + Workers + D1 + R2).

## 🏗️ Architecture

```
saas-ecommerce/
├── apps/api          → Hono Worker (Cloudflare Workers)
├── apps/web          → Astro SSR (Cloudflare Pages)
├── packages/db       → Drizzle ORM + D1 migrations
└── packages/shared   → Shared types + Zod schemas
```

**لماذا Astro + Hono بدلاً من Next.js؟**
- **Astro** له adapter رسمي لـ Cloudflare Pages يعمل بكامل طاقته مع SSR حقيقي
- **Hono** مصمم للـ Workers بحجم ~12kb وداعم كامل لـ TypeScript
- **Next.js** يحتاج workarounds كثيرة على Cloudflare ولا يدعم كل الميزات

---

## ⚡ Quick Start (محلياً)

### 1. Clone & Install

```bash
git clone https://github.com/your-username/saas-ecommerce
cd saas-ecommerce
pnpm install
```

### 2. Environment Setup

```bash
# API
cp apps/api/.env.example apps/api/.env.local

# Web
cp apps/web/.env.example apps/web/.env
```

### 3. إنشاء D1 Database محلياً

```bash
# إنشاء قاعدة البيانات
wrangler d1 create saas-ecommerce-db

# انسخ الـ database_id الظاهر وضعه في apps/api/wrangler.toml

# تطبيق الـ migrations
pnpm db:migrate

# إضافة بيانات تجريبية (اختياري)
pnpm db:seed
```

### 4. إنشاء R2 Bucket محلياً

```bash
wrangler r2 bucket create saas-ecommerce-uploads
```

### 5. تشغيل محلي

```bash
# تشغيل كل شيء معاً
pnpm dev

# أو بشكل منفصل:
# API: http://localhost:8787
cd apps/api && pnpm dev

# Web: http://localhost:4321
cd apps/web && pnpm dev
```

---

## 🌐 إعداد Stripe

### 1. إنشاء حساب Stripe
- اذهب إلى [dashboard.stripe.com](https://dashboard.stripe.com)
- احصل على API keys من Developer → API Keys

### 2. إنشاء Products وPrices في Stripe
```bash
# في Stripe Dashboard → Products → Create product
# أنشئ منتجات للخطط:
# - Pro Monthly: 149 MAD/month
# - Pro Yearly: 1490 MAD/year
# - Business Monthly: 349 MAD/month
# - Business Yearly: 3490 MAD/year

# انسخ price IDs وضعها في:
# apps/api/src/routes/billing.ts → STRIPE_PRICES object
```

### 3. إعداد Webhook
```bash
# محلياً باستخدام Stripe CLI:
stripe login
stripe listen --forward-to localhost:8787/stripe/webhook

# انسخ الـ webhook secret الظاهر:
# STRIPE_WEBHOOK_SECRET=whsec_...

# في الإنتاج:
# Stripe Dashboard → Developers → Webhooks → Add endpoint
# URL: https://api.yourdomain.com/stripe/webhook
# Events to listen:
#   - checkout.session.completed
#   - customer.subscription.created
#   - customer.subscription.updated
#   - customer.subscription.deleted
#   - invoice.paid
#   - invoice.payment_failed
```

### 4. وضع المفاتيح

```bash
# محلياً: في apps/api/.env.local
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# الإنتاج: عبر wrangler secrets
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put ADMIN_SECRET
```

---

## 🚀 النشر على Cloudflare

### طريقة 1: عبر GitHub Actions (مُوصى بها)

#### إعداد Secrets في GitHub:
```
CLOUDFLARE_ACCOUNT_ID     → Cloudflare Dashboard → Account ID
CLOUDFLARE_API_TOKEN      → My Profile → API Tokens → Create token (Workers Edit)
STRIPE_SECRET_KEY         → من Stripe Dashboard
STRIPE_WEBHOOK_SECRET     → من Stripe Webhooks
STRIPE_PUBLISHABLE_KEY    → من Stripe Dashboard
RESEND_API_KEY            → من Resend Dashboard
ADMIN_SECRET              → مفتاح سري لصفحة الـ Admin
PUBLIC_API_URL            → https://api.yourdomain.com
```

#### ثم push إلى main:
```bash
git push origin main
# GitHub Actions سيتولى النشر تلقائياً
```

### طريقة 2: يدوياً

#### نشر الـ API Worker:
```bash
cd apps/api

# وضع الـ secrets
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put ADMIN_SECRET

# نشر
wrangler deploy
```

#### نشر الـ Web (Astro):
```bash
cd apps/web

# Build
PUBLIC_API_URL=https://api.yourdomain.com pnpm build

# نشر على Pages
wrangler pages deploy dist --project-name=saas-ecommerce-web
```

#### تطبيق migrations في الإنتاج:
```bash
pnpm db:migrate:prod
```

---

## 🔧 إعداد الدومين

### API (Worker):
```
1. Cloudflare Dashboard → Workers & Pages → saas-ecommerce-api
2. Settings → Triggers → Add Route: api.yourdomain.com/*
```

### Web (Pages):
```
1. Cloudflare Dashboard → Workers & Pages → saas-ecommerce-web
2. Custom Domains → Set primary domain: app.yourdomain.com
```

### Subdomain للمتاجر:
```
في Cloudflare DNS:
  *.yourdomain.com → CNAME → saas-ecommerce-web.pages.dev

الـ Web app يقرأ الـ slug من الـ subdomain تلقائياً.
```

### R2 Public URL:
```
1. R2 → saas-ecommerce-uploads → Settings → Public Access → Allow
2. انسخ الـ public URL وضعه في:
   - apps/api/src/routes/products.ts (بحث عن cdn.yourdomain.com)
   - apps/api/src/routes/upload.ts
```

---

## 📋 Scripts المتاحة

```bash
pnpm dev              # تشغيل كل شيء محلياً
pnpm build            # build جميع الـ packages
pnpm db:migrate       # migration محلي
pnpm db:migrate:prod  # migration الإنتاج
pnpm db:seed          # إضافة بيانات تجريبية
pnpm deploy:api       # نشر الـ API Worker
pnpm deploy:web       # build الـ Web
pnpm typecheck        # فحص TypeScript
pnpm lint             # فحص ESLint
```

---

## 👤 حسابات التجربة بعد Seed

```
Email: owner@demo.com
Password: password123
Store: demo (demo.localhost:4321)
```

---

## 🔐 الأمان

| الميزة | التطبيق |
|--------|---------|
| Auth | Session-based (DB + HttpOnly Cookie) + PBKDF2 |
| Tenant isolation | كل query مقيدة بـ tenant_id |
| RBAC | Owner > Admin > Staff |
| Rate limiting | KV-based per IP |
| Input validation | Zod على كل endpoint |
| CORS | مضبوط بين API وWeb |
| Stripe webhooks | Signature verification |

---

## 📁 هيكل الجداول

| الجدول | الوصف |
|--------|-------|
| `tenants` | المتاجر + الخطط |
| `users` | المستخدمون |
| `sessions` | جلسات المصادقة |
| `memberships` | ربط المستخدمين بالمتاجر + Roles |
| `products` | منتجات كل متجر |
| `product_images` | صور المنتجات في R2 |
| `categories` | تصنيفات المنتجات |
| `product_categories` | pivot table |
| `orders` | الطلبات |
| `order_items` | منتجات كل طلب (snapshot) |
| `subscriptions` | اشتراكات Stripe |
| `audit_logs` | سجل العمليات |

---

## 🛠️ التطوير

```bash
# إضافة package لـ app معين
pnpm --filter api add stripe
pnpm --filter web add @astrojs/react

# إضافة للـ shared packages
pnpm --filter @repo/shared add zod

# فحص types
pnpm typecheck
```

---

## 🆘 حل المشاكل الشائعة

**خطأ: D1 database not found**
```bash
# تأكد من وضع database_id الصحيح في wrangler.toml
wrangler d1 list  # اعرض قواعد البيانات المتاحة
```

**خطأ: CORS error**
```bash
# أضف domain الـ web في CORS_ORIGINS
# apps/api/wrangler.toml: CORS_ORIGINS = "https://yourdomain.com,https://*.yourdomain.com"
```

**خطأ: Stripe webhook signature failed**
```bash
# تأكد من استخدام whsec_ الخاص بـ endpoint الإنتاج (وليس المحلي)
# محلياً: استخدم stripe listen --forward-to ...
```

**خطأ: R2 upload failed**
```bash
# تأكد من أن R2 binding مضبوط في wrangler.toml
# وأن اسم الـ bucket صحيح
```
