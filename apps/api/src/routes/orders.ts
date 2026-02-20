// apps/api/src/routes/orders.ts
//
// Endpoints:
//   POST /store/checkout        — Stripe payment (unchanged)
//   POST /store/checkout/cod    — Cash on Delivery (new)
//   GET  /store/orders/:id      — Public order lookup
//   GET  /dashboard/orders      — Dashboard orders list
//   GET  /dashboard/orders/:id  — Dashboard order detail
//   PATCH /dashboard/orders/:id/status — Update status (RBAC: owner|admin|staff)
//   GET  /dashboard/analytics   — Revenue analytics (Pro+)

import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { createDb, orders, orderItems, products, subscriptions, auditLogs } from '@repo/db';
import {
  checkoutSchema,
  codCheckoutSchema,
  updateOrderStatusSchema,
} from '@repo/shared/schemas';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { requireRole } from '../middleware/rbac.js';
import { publicApiRateLimit } from '../middleware/rateLimit.js';
import Stripe from 'stripe';
import type { AppContext } from '../index.js';

export const orderRoutes = new Hono<AppContext>();

// ════════════════════════════════════════════════════════════════
// STOREFRONT — Public endpoints
// ════════════════════════════════════════════════════════════════

// ─── POST /store/checkout (Stripe) ───────────────────────────
orderRoutes.post('/checkout', publicApiRateLimit, resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');

  const body = await c.req.json().catch(() => null);
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const { items, customerEmail, currency, successUrl, cancelUrl } = parsed.data;

  // Validate products + build Stripe line items
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

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const subtotal = snapshots.reduce((acc, s) => acc + s.price * s.qty, 0);
  const orderId = crypto.randomUUID();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    customer_email: customerEmail,
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}&order_id=${orderId}`,
    cancel_url: cancelUrl,
    metadata: { tenantId, orderId, customerEmail },
    payment_intent_data: { metadata: { tenantId, orderId } },
  });

  // Create pending Stripe order
  await db.insert(orders).values({
    id: orderId,
    tenantId,
    customerEmail,
    status: 'pending',
    paymentMethod: 'STRIPE',
    paymentStatus: 'PENDING',
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

// ─── POST /store/checkout/cod ─────────────────────────────────
// Cash on Delivery — no Stripe, creates order immediately as PLACED
orderRoutes.post('/checkout/cod', publicApiRateLimit, resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');

  const body = await c.req.json().catch(() => null);
  const parsed = codCheckoutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'Validation failed',
      issues: parsed.error.flatten().fieldErrors,
    }, 400);
  }

  const { items, customerEmail, customerName, customerPhone, customerAddress, currency } = parsed.data;

  // ── Fraud protection: COD max order total (configurable via env) ──
  // Default: 2000 MAD max for COD orders
  const COD_MAX_TOTAL = 2000;

  // Validate products + compute total
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
      return c.json({ error: `المنتج غير متاح: ${item.productId}` }, 400);
    }
    if (product.stock < item.qty) {
      return c.json({ error: `المخزون غير كافٍ للمنتج: ${product.title}` }, 400);
    }
    const price = product.salePrice ?? product.price;
    snapshots.push({ productId: product.id, title: product.title, price, qty: item.qty });
  }

  const subtotal = snapshots.reduce((acc, s) => acc + s.price * s.qty, 0);

  // Fraud check: reject COD if total exceeds limit
  if (subtotal > COD_MAX_TOTAL && currency === 'MAD') {
    return c.json({
      error: `الحد الأقصى للدفع عند الاستلام هو ${COD_MAX_TOTAL} ${currency}. للطلبات الأكبر، يرجى الدفع ببطاقة.`,
      code: 'COD_LIMIT_EXCEEDED',
    }, 422);
  }

  const orderId = crypto.randomUUID();

  // Create COD order — status=pending, paymentStatus=UNPAID
  await db.insert(orders).values({
    id: orderId,
    tenantId,
    customerEmail,
    customerName,
    customerPhone,
    customerAddress,
    status: 'pending',        // pending confirmation from merchant
    paymentMethod: 'COD',
    paymentStatus: 'UNPAID',  // payment collected on delivery
    subtotal,
    total: subtotal,
    currency,
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

  // Log COD order creation
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    tenantId,
    action: 'order.cod_created',
    metaJson: JSON.stringify({ orderId, customerEmail, total: subtotal, currency }),
  });

  return c.json({
    success: true,
    orderId,
    // Redirect URL for frontend
    redirectUrl: `/success?order_id=${orderId}&method=cod`,
    message: 'تم استلام طلبك! سنتواصل معك لتأكيد الطلب وترتيب التوصيل.',
  }, 201);
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

// ════════════════════════════════════════════════════════════════
// DASHBOARD — Authenticated endpoints
// ════════════════════════════════════════════════════════════════

// ─── GET /dashboard/orders ────────────────────────────────────
orderRoutes.get('/dashboard/orders', requireAuth(), resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const {
    page = '1',
    limit = '20',
    status,
    paymentMethod,
    paymentStatus,
  } = c.req.query();

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;

  const conditions: any[] = [eq(orders.tenantId, tenantId)];
  if (status) conditions.push(eq(orders.status, status as any));
  if (paymentMethod) conditions.push(eq(orders.paymentMethod, paymentMethod as any));
  if (paymentStatus) conditions.push(eq(orders.paymentStatus, paymentStatus as any));

  const [orderList, countResult] = await Promise.all([
    db.query.orders.findMany({
      where: and(...conditions),
      orderBy: [desc(orders.createdAt)],
      limit: limitNum,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` })
      .from(orders)
      .where(and(...conditions)),
  ]);

  return c.json({
    data: orderList,
    total: countResult[0]?.count ?? 0,
    page: pageNum,
    pageSize: limitNum,
  });
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

  const items = await db.query.orderItems.findMany({
    where: eq(orderItems.orderId, id),
  });
  return c.json({ ...order, items });
});

// ─── PATCH /dashboard/orders/:id/status ──────────────────────
// Roles: owner + admin can update any status
//        staff can only move to shipped/delivered (cannot cancel)
orderRoutes.patch(
  '/dashboard/orders/:id/status',
  requireAuth(),
  resolveTenant(),
  requireRole(['owner', 'admin', 'staff']),
  async (c) => {
    const db = createDb(c.env.DB);
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const role = c.get('role');
    const { id } = c.req.param();

    const body = await c.req.json().catch(() => null);
    const parsed = updateOrderStatusSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', issues: parsed.error.flatten().fieldErrors }, 400);
    }

    const order = await db.query.orders.findFirst({
      where: and(eq(orders.id, id), eq(orders.tenantId, tenantId)),
    });
    if (!order) return c.json({ error: 'Order not found' }, 404);

    // Staff cannot cancel or refund — only owner/admin can
    if (role === 'staff' && ['cancelled', 'refunded'].includes(parsed.data.status)) {
      return c.json({ error: 'Staff cannot cancel or refund orders' }, 403);
    }

    // Determine payment status update:
    // When marking COD order as delivered → auto-mark as PAID
    let newPaymentStatus = parsed.data.paymentStatus ?? order.paymentStatus;
    if (parsed.data.status === 'delivered' && order.paymentMethod === 'COD') {
      newPaymentStatus = 'PAID';
    }
    if (parsed.data.status === 'cancelled') {
      newPaymentStatus = order.paymentMethod === 'STRIPE' ? order.paymentStatus : 'UNPAID';
    }

    await db.update(orders)
      .set({
        status: parsed.data.status,
        paymentStatus: newPaymentStatus,
        notes: parsed.data.note ?? order.notes,
      })
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)));

    // Audit log
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId,
      actorUserId: userId,
      action: 'order.status_updated',
      metaJson: JSON.stringify({
        orderId: id,
        from: order.status,
        to: parsed.data.status,
        paymentMethod: order.paymentMethod,
        paymentStatusFrom: order.paymentStatus,
        paymentStatusTo: newPaymentStatus,
      }),
    });

    return c.json({ success: true });
  }
);

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
    where: and(
      eq(orders.tenantId, tenantId),
      // Count paid Stripe orders + delivered COD orders
    ),
    orderBy: [desc(orders.createdAt)],
  });

  // Filter to revenue-generating orders
  const paidOrders = allOrders.filter(o =>
    (o.paymentMethod === 'STRIPE' && o.status === 'paid') ||
    (o.paymentMethod === 'COD' && o.status === 'delivered')
  );

  const todayOrders = paidOrders.filter(o => o.createdAt >= todayStart);
  const monthOrders = paidOrders.filter(o => o.createdAt >= monthStart);

  // COD stats
  const codPending = allOrders.filter(o => o.paymentMethod === 'COD' && o.status === 'pending');
  const codShipped = allOrders.filter(o => o.paymentMethod === 'COD' && o.status === 'shipped');

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
      orders: paidOrders.length,
      revenue: paidOrders.reduce((acc, o) => acc + o.total, 0),
    },
    cod: {
      pending: codPending.length,
      shipped: codShipped.length,
      pendingValue: codPending.reduce((acc, o) => acc + o.total, 0),
    },
  });
});
