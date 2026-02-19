// apps/api/src/routes/admin.ts
import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { createDb, tenants, users, subscriptions, auditLogs } from '@repo/db';
import { requireSuperAdmin } from '../middleware/rbac.js';
import type { AppContext } from '../index.js';

export const adminRoutes = new Hono<AppContext>();

adminRoutes.use('*', requireSuperAdmin());

// ─── GET /admin/tenants ───────────────────────────────────────
adminRoutes.get('/tenants', async (c) => {
  const db = createDb(c.env.DB);
  const { page = '1', limit = '50' } = c.req.query();
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const tenantList = await db.query.tenants.findMany({
    orderBy: [desc(tenants.createdAt)],
    limit: parseInt(limit),
    offset,
  });

  const enriched = await Promise.all(tenantList.map(async (t) => {
    const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.tenantId, t.id) });
    return { ...t, subscription: sub };
  }));

  return c.json({ data: enriched });
});

// ─── PATCH /admin/tenants/:id/toggle ─────────────────────────
adminRoutes.patch('/tenants/:id/toggle', async (c) => {
  const db = createDb(c.env.DB);
  const { id } = c.req.param();

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
  if (!tenant) return c.json({ error: 'Not found' }, 404);

  await db.update(tenants)
    .set({ isActive: !tenant.isActive })
    .where(eq(tenants.id, id));

  return c.json({ success: true, isActive: !tenant.isActive });
});

// ─── GET /admin/users ─────────────────────────────────────────
adminRoutes.get('/users', async (c) => {
  const db = createDb(c.env.DB);
  const userList = await db.query.users.findMany({ orderBy: [desc(users.createdAt)] });
  // Don't expose password hashes
  return c.json({ data: userList.map(u => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt })) });
});

// ─── GET /admin/logs ──────────────────────────────────────────
adminRoutes.get('/logs', async (c) => {
  const db = createDb(c.env.DB);
  const { tenantId, limit = '100' } = c.req.query();

  const conditions: any[] = [];
  if (tenantId) conditions.push(eq(auditLogs.tenantId, tenantId));

  const logs = await db.query.auditLogs.findMany({
    where: conditions.length ? conditions[0] : undefined,
    orderBy: [desc(auditLogs.createdAt)],
    limit: parseInt(limit),
  });

  return c.json({ data: logs });
});

// ─── GET /admin/stats ─────────────────────────────────────────
adminRoutes.get('/stats', async (c) => {
  const db = createDb(c.env.DB);

  const [tenantCount, userCount, subStats] = await Promise.all([
    db.query.tenants.findMany().then(r => r.length),
    db.query.users.findMany().then(r => r.length),
    db.query.subscriptions.findMany(),
  ]);

  const plans = { free: 0, pro: 0, business: 0 };
  subStats.forEach(s => { plans[s.plan as keyof typeof plans]++; });

  return c.json({ tenants: tenantCount, users: userCount, plans });
});
