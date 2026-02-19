// apps/api/src/middleware/tenant.ts
import type { MiddlewareHandler } from 'hono';
import { createDb } from '@repo/db';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../index.js';

/**
 * Resolves tenant from:
 * 1. X-Tenant-Slug header (preferred for API calls)
 * 2. Host subdomain: {slug}.yourdomain.com
 * 3. Path: /t/{slug}/... (fallback)
 */
export function resolveTenant(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const db = createDb(c.env.DB);
    const slug = extractTenantSlug(c.req);

    if (!slug) {
      return c.json({ error: 'Tenant not found' }, 404);
    }

    const tenant = await db.query.tenants.findFirst({
      where: (t, { eq, and }) => and(eq(t.slug, slug), eq(t.isActive, true)),
    });

    if (!tenant) {
      return c.json({ error: 'Store not found or inactive' }, 404);
    }

    // Enforce that the authenticated user belongs to this tenant
    const userId = c.get('userId');
    if (userId) {
      const membership = await db.query.memberships.findFirst({
        where: (m, { eq, and }) => and(eq(m.tenantId, tenant.id), eq(m.userId, userId)),
      });
      if (!membership) {
        return c.json({ error: 'Access denied to this store' }, 403);
      }
      c.set('role', membership.role);
    }

    c.set('tenantId', tenant.id);
    c.set('plan', tenant.plan);

    await next();
  };
}

function extractTenantSlug(req: Request): string | null {
  // 1. Header
  const headerSlug = req.headers.get('X-Tenant-Slug');
  if (headerSlug) return headerSlug.toLowerCase();

  // 2. Subdomain
  const host = req.headers.get('Host') ?? '';
  const subdomain = host.split('.')[0];
  const ignoredSubdomains = ['www', 'api', 'app', 'admin', 'localhost'];
  if (subdomain && !ignoredSubdomains.includes(subdomain) && !subdomain.includes(':')) {
    return subdomain.toLowerCase();
  }

  // 3. Path: /store/{slug}/...
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/(?:store|t)\/([a-z0-9-]+)/);
  if (match) return match[1];

  return null;
}
