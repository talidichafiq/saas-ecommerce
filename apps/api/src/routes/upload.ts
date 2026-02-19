// apps/api/src/routes/upload.ts
import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { uploadRateLimit } from '../middleware/rateLimit.js';
import { createDb, productImages } from '@repo/db';
import type { AppContext } from '../index.js';

export const uploadRoutes = new Hono<AppContext>();

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

// ─── POST /upload/product-image ───────────────────────────────
// Uploads directly to R2, returns public URL
uploadRoutes.post('/product-image', requireAuth(), uploadRateLimit, resolveTenant(), async (c) => {
  const tenantId = c.get('tenantId');
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ error: 'Invalid form data' }, 400);

  const file = formData.get('file') as File | null;
  const productId = formData.get('productId') as string | null;
  const alt = (formData.get('alt') as string) ?? '';

  if (!file) return c.json({ error: 'File is required' }, 400);
  if (!ALLOWED_TYPES.includes(file.type)) {
    return c.json({ error: 'نوع الملف غير مدعوم. استخدم JPEG, PNG, أو WebP' }, 400);
  }
  if (file.size > MAX_SIZE) {
    return c.json({ error: 'حجم الملف يتجاوز 5MB' }, 400);
  }

  const ext = file.type.split('/')[1];
  const key = `${tenantId}/${productId ?? 'misc'}/${crypto.randomUUID()}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  await c.env.R2.put(key, arrayBuffer, {
    httpMetadata: { contentType: file.type },
    customMetadata: { tenantId, productId: productId ?? '' },
  });

  // Save image record if productId provided
  if (productId) {
    const db = createDb(c.env.DB);
    const count = await db.query.productImages.findMany({
      where: (pi, { eq }) => eq(pi.productId, productId),
    });
    await db.insert(productImages).values({
      id: crypto.randomUUID(),
      tenantId,
      productId,
      r2Key: key,
      alt,
      sortOrder: count.length,
    });
  }

  return c.json({
    key,
    url: `https://cdn.yourdomain.com/${key}`, // Replace with your R2 public URL
  }, 201);
});

// ─── DELETE /upload/image/:key ────────────────────────────────
uploadRoutes.delete('/image/:key{.+}', requireAuth(), resolveTenant(), async (c) => {
  const tenantId = c.get('tenantId');
  const key = c.req.param('key');

  // Security: ensure key belongs to this tenant
  if (!key.startsWith(`${tenantId}/`)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.R2.delete(key);
  return c.json({ success: true });
});

// ─── GET /upload/presign ──────────────────────────────────────
// Returns a presigned URL for direct browser upload (optional)
uploadRoutes.get('/presign', requireAuth(), resolveTenant(), async (c) => {
  const tenantId = c.get('tenantId');
  const { contentType = 'image/jpeg', productId } = c.req.query();

  if (!ALLOWED_TYPES.includes(contentType)) {
    return c.json({ error: 'Invalid content type' }, 400);
  }

  const ext = contentType.split('/')[1];
  const key = `${tenantId}/${productId ?? 'misc'}/${crypto.randomUUID()}.${ext}`;

  // Note: Cloudflare R2 presigned URLs require Workers with R2 bindings
  // This returns a direct upload endpoint instead
  return c.json({ key, uploadUrl: `/upload/product-image` });
});
