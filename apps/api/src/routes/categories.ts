// apps/api/src/routes/categories.ts
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { createDb, categories } from '@repo/db';
import { createCategorySchema } from '@repo/shared/schemas';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { requireRole } from '../middleware/rbac.js';
import type { AppContext } from '../index.js';

export const categoryRoutes = new Hono<AppContext>();

// Public
categoryRoutes.get('/', resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const cats = await db.query.categories.findMany({ where: eq(categories.tenantId, tenantId) });
  return c.json({ data: cats });
});

// Dashboard CRUD
categoryRoutes.post('/', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const body = await c.req.json().catch(() => null);
  const parsed = createCategorySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  const existing = await db.query.categories.findFirst({
    where: and(eq(categories.tenantId, tenantId), eq(categories.slug, parsed.data.slug)),
  });
  if (existing) return c.json({ error: 'Slug already exists' }, 409);

  const id = crypto.randomUUID();
  await db.insert(categories).values({ id, tenantId, ...parsed.data });
  return c.json({ id, ...parsed.data }, 201);
});

categoryRoutes.patch('/:id', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  const parsed = createCategorySchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed' }, 400);

  await db.update(categories).set(parsed.data).where(and(eq(categories.id, id), eq(categories.tenantId, tenantId)));
  return c.json({ success: true });
});

categoryRoutes.delete('/:id', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  await db.delete(categories).where(and(eq(categories.id, id), eq(categories.tenantId, tenantId)));
  return c.json({ success: true });
});
