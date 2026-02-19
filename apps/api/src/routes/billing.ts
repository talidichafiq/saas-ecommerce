// apps/api/src/routes/billing.ts
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb, subscriptions, tenants } from '@repo/db';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { requireRole } from '../middleware/rbac.js';
import Stripe from 'stripe';
import type { AppContext } from '../index.js';

export const billingRoutes = new Hono<AppContext>();

const STRIPE_PRICES: Record<string, Record<string, string>> = {
  pro: {
    monthly: 'price_pro_monthly',      // Replace with your Stripe price IDs
    yearly: 'price_pro_yearly',
  },
  business: {
    monthly: 'price_business_monthly',
    yearly: 'price_business_yearly',
  },
};

// ─── GET /billing/status ──────────────────────────────────────
billingRoutes.get('/status', requireAuth(), resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');

  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.tenantId, tenantId) });
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });

  return c.json({
    plan: tenant?.plan ?? 'free',
    status: sub?.status ?? 'active',
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    stripeCustomerId: sub?.stripeCustomerId ?? null,
  });
});

// ─── POST /billing/checkout ───────────────────────────────────
billingRoutes.post('/checkout', requireAuth(), resolveTenant(), requireRole(['owner']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  const body = await c.req.json().catch(() => null);
  const { plan = 'pro', interval = 'monthly' } = body ?? {};

  if (!['pro', 'business'].includes(plan)) {
    return c.json({ error: 'Invalid plan' }, 400);
  }

  const priceId = STRIPE_PRICES[plan]?.[interval];
  if (!priceId) return c.json({ error: 'Invalid plan or interval' }, 400);

  let sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.tenantId, tenantId) });
  const user = await db.query.users.findFirst({ where: eq((await import('@repo/db')).users.id, userId) });

  // Create or reuse Stripe customer
  let customerId = sub?.stripeCustomerId ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user?.email,
      metadata: { tenantId, userId },
    });
    customerId = customer.id;

    if (sub) {
      await db.update(subscriptions)
        .set({ stripeCustomerId: customerId })
        .where(eq(subscriptions.tenantId, tenantId));
    } else {
      await db.insert(subscriptions).values({
        id: crypto.randomUUID(),
        tenantId,
        stripeCustomerId: customerId,
        status: 'incomplete',
        plan: 'free',
      });
    }
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${c.env.APP_URL}/dashboard/billing?success=1`,
    cancel_url: `${c.env.APP_URL}/dashboard/billing?cancelled=1`,
    metadata: { tenantId, plan },
    subscription_data: {
      metadata: { tenantId, plan },
    },
  });

  return c.json({ checkoutUrl: session.url });
});

// ─── POST /billing/portal ─────────────────────────────────────
billingRoutes.post('/portal', requireAuth(), resolveTenant(), requireRole(['owner']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.tenantId, tenantId) });
  if (!sub?.stripeCustomerId) {
    return c.json({ error: 'No active subscription found' }, 400);
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${c.env.APP_URL}/dashboard/billing`,
  });

  return c.json({ url: portal.url });
});
