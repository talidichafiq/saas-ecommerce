// apps/api/src/routes/tenants.ts
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb, tenants, memberships, users } from '@repo/db';
import { updateTenantSchema } from '@repo/shared/schemas';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { requireRole } from '../middleware/rbac.js';
import type { AppContext } from '../index.js';

export const tenantRoutes = new Hono<AppContext>();

// ─── GET /tenants/:id ─────────────────────────────────────────
tenantRoutes.get('/:id', requireAuth(), async (c) => {
  const db = createDb(c.env.DB);
  const { id } = c.req.param();
  const userId = c.get('userId');

  // Verify membership
  const membership = await db.query.memberships.findFirst({
    where: (m, { eq, and }) => and(eq(m.tenantId, id), eq(m.userId, userId)),
  });
  if (!membership) return c.json({ error: 'Access denied' }, 403);

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
  if (!tenant) return c.json({ error: 'Not found' }, 404);

  return c.json(tenant);
});

// ─── PATCH /tenants/:id/settings ─────────────────────────────
tenantRoutes.patch('/:id/settings', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => null);
  const parsed = updateTenantSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  await db.update(tenants).set(parsed.data).where(eq(tenants.id, tenantId));
  return c.json({ success: true });
});

// ─── GET /tenants/:id/members ─────────────────────────────────
tenantRoutes.get('/:id/members', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');

  const members = await db.query.memberships.findMany({
    where: eq(memberships.tenantId, tenantId),
  });

  const enriched = await Promise.all(members.map(async (m) => {
    const user = await db.query.users.findFirst({ where: eq(users.id, m.userId) });
    return { ...m, user: user ? { id: user.id, email: user.email, name: user.name } : null };
  }));

  return c.json({ data: enriched });
});

// ─── POST /tenants/:id/members ────────────────────────────────
tenantRoutes.post('/:id/members', requireAuth(), resolveTenant(), requireRole(['owner']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const plan = c.get('plan');

  if (plan === 'free') {
    return c.json({ error: 'Team feature requires Business plan', upgrade: true }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const { email, role = 'staff' } = body ?? {};
  if (!email) return c.json({ error: 'Email required' }, 400);

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) return c.json({ error: 'User not found. They must register first.' }, 404);

  const existing = await db.query.memberships.findFirst({
    where: (m, { eq, and }) => and(eq(m.tenantId, tenantId), eq(m.userId, user.id)),
  });
  if (existing) return c.json({ error: 'User is already a member' }, 409);

  await db.insert(memberships).values({
    id: crypto.randomUUID(),
    tenantId,
    userId: user.id,
    role,
  });

  return c.json({ success: true }, 201);
});
