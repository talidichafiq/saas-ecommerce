// apps/api/src/routes/orders.ts
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { createDb, orders, orderItems, products, tenants, subscriptions, auditLogs } from '@repo/db';
import { checkoutSchema, updateOrderStatusSchema } from '@repo/shared/schemas';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { requireRole } from '../middleware/rbac.js';
import { publicApiRateLimit } from '../middleware/rateLimit.js';
import Stripe from 'stripe';
import type { AppContext } from '../index.js';

export const orderRoutes = new Hono<AppContext>();

// ─── POST /store/checkout ─────────────────────────────────────
orderRoutes.post('/checkout', publicApiRateLimit, resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');

  const body = await c.req.json().catch(() => null);
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const { items, customerEmail, currency, successUrl, cancelUrl } = parsed.data;

  // Validate products and build line items
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  const snapshots: { productId: string; title: string; price: number; qty: number }[] = [];

  for (const item of items) {
    const product = await db.query.products.findFirst({
      where: and(
        eq(products.id, item.productId),
        eq(products.tenantId, tenantId),
        eq(products.status, 'active')
      ),
    });
    if (!product) {
      return c.json({ error: `Product ${item.productId} not found or unavailable` }, 400);
    }
    if (product.stock < item.qty) {
      return c.json({ error: `المخزون غير كافٍ للمنتج: ${product.title}` }, 400);
    }

    const price = product.salePrice ?? product.price;
    lineItems.push({
      quantity: item.qty,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: Math.round(price * 100),
        product_data: { name: product.title },
      },
    });
    snapshots.push({ productId: product.id, title: product.title, price, qty: item.qty });
  }

  // Get or create Stripe customer/account for tenant
  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.tenantId, tenantId) });
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  const subtotal = snapshots.reduce((acc, s) => acc + s.price * s.qty, 0);
  const orderId = crypto.randomUUID();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    customer_email: customerEmail,
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}`,
    cancel_url: cancelUrl,
    metadata: {
      tenantId,
      orderId,
      customerEmail,
    },
    payment_intent_data: {
      metadata: { tenantId, orderId },
    },
  });

  // Create pending order
  await db.insert(orders).values({
    id: orderId,
    tenantId,
    customerEmail,
    status: 'pending',
    subtotal,
    total: subtotal,
    currency,
    stripeSessionId: session.id,
  });

  await db.insert(orderItems).values(
    snapshots.map(s => ({
      id: crypto.randomUUID(),
      tenantId,
      orderId,
      productId: s.productId,
      titleSnapshot: s.title,
      priceSnapshot: s.price,
      qty: s.qty,
    }))
  );

  return c.json({ checkoutUrl: session.url, orderId, sessionId: session.id });
});

// ─── GET /store/orders/:id ────────────────────────────────────
orderRoutes.get('/orders/:id', publicApiRateLimit, resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, id), eq(orders.tenantId, tenantId)),
  });
  if (!order) return c.json({ error: 'Order not found' }, 404);

  const items = await db.query.orderItems.findMany({
    where: eq(orderItems.orderId, id),
  });

  return c.json({ ...order, items });
});

// ─── GET /dashboard/orders ────────────────────────────────────
orderRoutes.get('/dashboard/orders', requireAuth(), resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { page = '1', limit = '20', status } = c.req.query();

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;

  const conditions: any[] = [eq(orders.tenantId, tenantId)];
  if (status) conditions.push(eq(orders.status, status as any));

  const orderList = await db.query.orders.findMany({
    where: and(...conditions),
    orderBy: [desc(orders.createdAt)],
    limit: limitNum,
    offset,
  });

  return c.json({ data: orderList, page: pageNum, pageSize: limitNum });
});

// ─── GET /dashboard/orders/:id ───────────────────────────────
orderRoutes.get('/dashboard/orders/:id', requireAuth(), resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, id), eq(orders.tenantId, tenantId)),
  });
  if (!order) return c.json({ error: 'Order not found' }, 404);

  const items = await db.query.orderItems.findMany({ where: eq(orderItems.orderId, id) });
  return c.json({ ...order, items });
});

// ─── PATCH /dashboard/orders/:id/status ──────────────────────
orderRoutes.patch('/dashboard/orders/:id/status', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const { id } = c.req.param();

  const body = await c.req.json().catch(() => null);
  const parsed = updateOrderStatusSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed' }, 400);

  const order = await db.query.orders.findFirst({
    where: and(eq(orders.id, id), eq(orders.tenantId, tenantId)),
  });
  if (!order) return c.json({ error: 'Order not found' }, 404);

  await db.update(orders)
    .set({ status: parsed.data.status, notes: parsed.data.note ?? order.notes })
    .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));

  // Audit log
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    tenantId,
    actorUserId: userId,
    action: 'order.status_updated',
    metaJson: JSON.stringify({ orderId: id, from: order.status, to: parsed.data.status }),
  });

  return c.json({ success: true });
});

// ─── GET /dashboard/analytics ────────────────────────────────
orderRoutes.get('/dashboard/analytics', requireAuth(), resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const plan = c.get('plan');

  if (!['pro', 'business'].includes(plan)) {
    return c.json({ error: 'Analytics requires Pro plan', upgrade: true }, 403);
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const allOrders = await db.query.orders.findMany({
    where: and(eq(orders.tenantId, tenantId), eq(orders.status, 'paid')),
    orderBy: [desc(orders.createdAt)],
  });

  const todayOrders = allOrders.filter(o => o.createdAt >= todayStart);
  const monthOrders = allOrders.filter(o => o.createdAt >= monthStart);

  return c.json({
    today: {
      orders: todayOrders.length,
      revenue: todayOrders.reduce((acc, o) => acc + o.total, 0),
    },
    month: {
      orders: monthOrders.length,
      revenue: monthOrders.reduce((acc, o) => acc + o.total, 0),
    },
    total: {
      orders: allOrders.length,
      revenue: allOrders.reduce((acc, o) => acc + o.total, 0),
    },
  });
});
