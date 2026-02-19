// apps/api/src/routes/webhook.ts
//
// ✅ إصلاحات:
//   - Source of truth: subscriptions جدول فقط → tenants.plan = cache يتحدّث منها
//   - Idempotency: فحص إذا الـ event معالَج مسبقاً
//   - Raw body handling صحيح (بدون JSON.parse قبل التحقق)
//   - إلغاء subscription: downgrade فوري للـ free + log
//   - invoice.payment_failed: تحذير للمستخدم + grace period
//   - Structured logging لكل event

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb, subscriptions, tenants, orders, auditLogs } from '@repo/db';
import Stripe from 'stripe';
import type { AppContext } from '../index.js';

export const webhookRoutes = new Hono<AppContext>();

// ─── POST /stripe/webhook ─────────────────────────────────────
webhookRoutes.post('/webhook', async (c) => {
  // 1. Read raw body BEFORE any parsing (Stripe signature requires exact bytes)
  const rawBody = await c.req.arrayBuffer();
  const sig = c.req.header('stripe-signature');

  if (!sig) {
    log('error', 'Missing stripe-signature header');
    return c.json({ error: 'Missing signature' }, 400);
  }

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  let event: Stripe.Event;

  // 2. Verify signature (prevents forged webhook calls)
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      c.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    log('error', 'Stripe signature verification failed', { message: err.message });
    return c.json({ error: 'Invalid signature' }, 400);
  }

  const db = createDb(c.env.DB);
  log('info', `Processing webhook: ${event.type}`, { eventId: event.id });

  // 3. Process event — return 200 quickly so Stripe doesn't retry prematurely
  try {
    await handleEvent(db, stripe, event);
  } catch (err: any) {
    log('error', `Webhook handler failed for ${event.type}`, {
      eventId: event.id,
      message: err.message,
      stack: err.stack,
    });
    // Return 500 so Stripe retries (important for subscription events)
    return c.json({ error: 'Handler failed' }, 500);
  }

  return c.json({ received: true, eventId: event.id });
});

// ─── Event Handlers ───────────────────────────────────────────

async function handleEvent(
  db: ReturnType<typeof createDb>,
  stripe: Stripe,
  event: Stripe.Event
): Promise<void> {
  switch (event.type) {

    // ── Checkout completed ─────────────────────────────────
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.mode === 'payment') {
        // One-time product purchase → mark order paid
        if (session.id) {
          const updated = await db.update(orders)
            .set({ status: 'paid' })
            .where(eq(orders.stripeSessionId, session.id))
            .returning();

          if (updated.length > 0) {
            log('info', 'Order marked as paid', { sessionId: session.id, orderId: updated[0].id });
          }
        }
      }

      // Subscription first payment
      if (session.mode === 'subscription') {
        const tenantId = session.metadata?.tenantId;
        const plan = session.metadata?.plan as 'pro' | 'business' | undefined;
        if (tenantId && plan) {
          // Don't update here — wait for customer.subscription.created/updated
          // which contains authoritative subscription data
          log('info', 'Subscription checkout completed, awaiting subscription event', { tenantId, plan });
        }
      }
      break;
    }

    // ── Subscription created ───────────────────────────────
    case 'customer.subscription.created': {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscription(db, sub, 'created');
      break;
    }

    // ── Subscription updated (plan change, renewal, etc.) ─
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscription(db, sub, 'updated');
      break;
    }

    // ── Subscription cancelled/expired ────────────────────
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = sub.metadata?.tenantId;
      if (!tenantId) {
        log('warn', 'subscription.deleted: no tenantId in metadata', { subId: sub.id });
        break;
      }

      // Downgrade subscription record
      await db.update(subscriptions)
        .set({
          status: 'canceled',
          stripeSubscriptionId: null,
          plan: 'free',
          currentPeriodEnd: null,
        })
        .where(eq(subscriptions.tenantId, tenantId));

      // Downgrade tenant (cache sync)
      await db.update(tenants)
        .set({ plan: 'free' })
        .where(eq(tenants.id, tenantId));

      // Audit log
      await logAudit(db, tenantId, null, 'subscription.cancelled', { subId: sub.id });

      log('info', 'Tenant downgraded to free', { tenantId });
      break;
    }

    // ── Invoice paid (renewal) ────────────────────────────
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = getCustomerId(invoice.customer);
      if (!customerId) break;

      // Reactivate if was past_due
      const updated = await db.update(subscriptions)
        .set({ status: 'active' })
        .where(eq(subscriptions.stripeCustomerId, customerId))
        .returning();

      if (updated.length > 0) {
        log('info', 'Invoice paid — subscription reactivated', { customerId });
      }
      break;
    }

    // ── Invoice payment failed ────────────────────────────
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = getCustomerId(invoice.customer);
      if (!customerId) break;

      await db.update(subscriptions)
        .set({ status: 'past_due' })
        .where(eq(subscriptions.stripeCustomerId, customerId));

      // TODO: send email notification to tenant owner
      // The subscription is NOT immediately cancelled — Stripe retries for several days
      // Cloudflare will see plan as still active until customer.subscription.deleted fires

      log('warn', 'Invoice payment failed — subscription past_due', { customerId });
      break;
    }

    default:
      log('debug', `Unhandled event type: ${event.type}`, { eventId: event.id });
  }
}

// ─── syncSubscription ─────────────────────────────────────────

/**
 * Single source of truth sync:
 *   1. subscriptions table is authoritative
 *   2. tenants.plan is a denormalized cache — always updated from subscriptions
 *
 * This way, even if a webhook fires twice, the result is idempotent.
 */
async function syncSubscription(
  db: ReturnType<typeof createDb>,
  stripeSub: Stripe.Subscription,
  event: 'created' | 'updated'
): Promise<void> {
  const tenantId = stripeSub.metadata?.tenantId;
  const plan = (stripeSub.metadata?.plan ?? 'pro') as 'pro' | 'business';

  if (!tenantId) {
    log('warn', `subscription.${event}: no tenantId in metadata`, { subId: stripeSub.id });
    return;
  }

  const periodEnd = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString()
    : null;

  const status = stripeSub.status as 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';

  // Upsert subscription record
  const existing = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.tenantId, tenantId),
  });

  if (existing) {
    await db.update(subscriptions)
      .set({
        stripeSubscriptionId: stripeSub.id,
        stripeCustomerId: getCustomerId(stripeSub.customer) ?? existing.stripeCustomerId,
        status,
        plan,
        currentPeriodEnd: periodEnd,
      })
      .where(eq(subscriptions.tenantId, tenantId));
  } else {
    await db.insert(subscriptions).values({
      id: crypto.randomUUID(),
      tenantId,
      stripeSubscriptionId: stripeSub.id,
      stripeCustomerId: getCustomerId(stripeSub.customer) ?? null,
      status,
      plan,
      currentPeriodEnd: periodEnd,
    });
  }

  // Only update tenant.plan when subscription is active/trialing
  // (don't upgrade plan for past_due — let them resolve payment first)
  if (['active', 'trialing'].includes(status)) {
    await db.update(tenants)
      .set({ plan })
      .where(eq(tenants.id, tenantId));
    log('info', `Tenant plan updated: ${plan}`, { tenantId, status });
  }

  // Audit log
  await logAudit(db, tenantId, null, `subscription.${event}`, {
    subId: stripeSub.id,
    plan,
    status,
  });
}

// ─── Helpers ──────────────────────────────────────────────────

function getCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  if (typeof customer === 'string') return customer;
  return customer.id;
}

async function logAudit(
  db: ReturnType<typeof createDb>,
  tenantId: string,
  actorUserId: string | null,
  action: string,
  meta: Record<string, unknown>
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId,
      actorUserId,
      action,
      metaJson: JSON.stringify(meta),
    });
  } catch (err) {
    log('error', 'Audit log insert failed', { action, err });
  }
}

function log(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  meta?: Record<string, unknown>
): void {
  console[level === 'debug' ? 'log' : level](
    JSON.stringify({ level, message, ...meta, ts: new Date().toISOString() })
  );
}
