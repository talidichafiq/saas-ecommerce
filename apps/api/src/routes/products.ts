// apps/api/src/routes/products.ts
import { Hono } from 'hono';
import { eq, and, like, desc, sql } from 'drizzle-orm';
import { createDb, products, productImages, productCategories, categories } from '@repo/db';
import { createProductSchema, updateProductSchema } from '@repo/shared/schemas';
import { PLAN_LIMITS } from '@repo/shared/types';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { requireRole } from '../middleware/rbac.js';
import { publicApiRateLimit } from '../middleware/rateLimit.js';
import type { AppContext } from '../index.js';

export const productRoutes = new Hono<AppContext>();

// ─── Public: GET /store/products ─────────────────────────────
productRoutes.get('/products', publicApiRateLimit, resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { page = '1', limit = '20', category, search, status = 'active' } = c.req.query();

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [
    eq(products.tenantId, tenantId),
    eq(products.status, status as any),
  ];

  if (search) {
    conditions.push(like(products.title, `%${search}%`));
  }

  const [productList, countResult] = await Promise.all([
    db.query.products.findMany({
      where: and(...conditions),
      orderBy: [desc(products.createdAt)],
      limit: limitNum,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` })
      .from(products)
      .where(and(...conditions)),
  ]);

  // Attach images and categories
  const enriched = await Promise.all(productList.map(async (p) => {
    const [images, cats] = await Promise.all([
      db.query.productImages.findMany({ where: eq(productImages.productId, p.id) }),
      db.select({ id: categories.id, name: categories.name, slug: categories.slug })
        .from(productCategories)
        .innerJoin(categories, eq(productCategories.categoryId, categories.id))
        .where(eq(productCategories.productId, p.id)),
    ]);
    return {
      ...p,
      images: images.map(img => ({
        ...img,
        url: `https://cdn.yourdomain.com/${img.r2Key}`, // Replace with your R2 public URL
      })),
      categories: cats,
    };
  }));

  // Filter by category if requested
  const filtered = category
    ? enriched.filter(p => p.categories.some(cat => cat.slug === category))
    : enriched;

  return c.json({
    data: filtered,
    total: countResult[0]?.count ?? 0,
    page: pageNum,
    pageSize: limitNum,
  });
});

// ─── Public: GET /store/products/:id ─────────────────────────
productRoutes.get('/products/:id', publicApiRateLimit, resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const product = await db.query.products.findFirst({
    where: and(eq(products.id, id), eq(products.tenantId, tenantId), eq(products.status, 'active')),
  });
  if (!product) return c.json({ error: 'Product not found' }, 404);

  const [images, cats] = await Promise.all([
    db.query.productImages.findMany({ where: eq(productImages.productId, id) }),
    db.select({ id: categories.id, name: categories.name, slug: categories.slug })
      .from(productCategories)
      .innerJoin(categories, eq(productCategories.categoryId, categories.id))
      .where(eq(productCategories.productId, id)),
  ]);

  // Related products (same category)
  let related: typeof products.$inferSelect[] = [];
  if (cats.length > 0) {
    const relatedPcs = await db.query.productCategories.findMany({
      where: and(
        eq(productCategories.categoryId, cats[0].id),
        eq(productCategories.tenantId, tenantId)
      ),
    });
    const relatedIds = relatedPcs.map(r => r.productId).filter(rid => rid !== id).slice(0, 4);
    if (relatedIds.length > 0) {
      related = await db.query.products.findMany({
        where: and(eq(products.tenantId, tenantId), eq(products.status, 'active')),
        limit: 4,
      });
    }
  }

  return c.json({
    ...product,
    images: images.map(img => ({ ...img, url: `https://cdn.yourdomain.com/${img.r2Key}` })),
    categories: cats,
    related,
  });
});

// ─── Dashboard: GET /dashboard/products ──────────────────────
productRoutes.get('/dashboard/products', requireAuth(), resolveTenant(), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { page = '1', limit = '20', search } = c.req.query();

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [eq(products.tenantId, tenantId)];
  if (search) conditions.push(like(products.title, `%${search}%`));

  const [productList, countResult] = await Promise.all([
    db.query.products.findMany({
      where: and(...conditions),
      orderBy: [desc(products.createdAt)],
      limit: limitNum,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` }).from(products).where(and(...conditions)),
  ]);

  return c.json({
    data: productList,
    total: countResult[0]?.count ?? 0,
    page: pageNum,
    pageSize: limitNum,
  });
});

// ─── Dashboard: POST /dashboard/products ─────────────────────
productRoutes.post('/dashboard/products', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const plan = c.get('plan') as any;

  // Check product limit
  const countResult = await db.select({ count: sql<number>`count(*)` })
    .from(products)
    .where(eq(products.tenantId, tenantId));
  const productCount = countResult[0]?.count ?? 0;
  const limit = PLAN_LIMITS[plan]?.maxProducts ?? 20;

  if (productCount >= limit) {
    return c.json({
      error: `لقد وصلت إلى الحد الأقصى (${limit}) منتج في خطتك الحالية`,
      upgrade: true,
    }, 403);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = createProductSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const { categoryIds, ...productData } = parsed.data;
  const productId = crypto.randomUUID();

  await db.insert(products).values({ id: productId, tenantId, ...productData });

  if (categoryIds?.length) {
    await db.insert(productCategories).values(
      categoryIds.map(catId => ({
        id: crypto.randomUUID(),
        tenantId,
        productId,
        categoryId: catId,
      }))
    );
  }

  return c.json({ id: productId, ...productData }, 201);
});

// ─── Dashboard: PATCH /dashboard/products/:id ────────────────
productRoutes.patch('/dashboard/products/:id', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const existing = await db.query.products.findFirst({
    where: and(eq(products.id, id), eq(products.tenantId, tenantId)),
  });
  if (!existing) return c.json({ error: 'Product not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = updateProductSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);

  const { categoryIds, ...updates } = parsed.data as any;

  if (Object.keys(updates).length > 0) {
    await db.update(products).set(updates).where(and(eq(products.id, id), eq(products.tenantId, tenantId)));
  }

  if (categoryIds !== undefined) {
    await db.delete(productCategories).where(eq(productCategories.productId, id));
    if (categoryIds.length > 0) {
      await db.insert(productCategories).values(
        categoryIds.map((catId: string) => ({
          id: crypto.randomUUID(),
          tenantId,
          productId: id,
          categoryId: catId,
        }))
      );
    }
  }

  return c.json({ success: true });
});

// ─── Dashboard: DELETE /dashboard/products/:id ───────────────
productRoutes.delete('/dashboard/products/:id', requireAuth(), resolveTenant(), requireRole(['owner', 'admin']), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const existing = await db.query.products.findFirst({
    where: and(eq(products.id, id), eq(products.tenantId, tenantId)),
  });
  if (!existing) return c.json({ error: 'Product not found' }, 404);

  await db.update(products)
    .set({ status: 'archived' })
    .where(and(eq(products.id, id), eq(products.tenantId, tenantId)));

  return c.json({ success: true });
});
