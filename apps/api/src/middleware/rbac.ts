// apps/api/src/middleware/rbac.ts
import type { MiddlewareHandler } from 'hono';
import type { Role, Plan } from '@repo/shared/types';
import type { AppContext } from '../index.js';
import { PLAN_LIMITS } from '@repo/shared/types';

const ROLE_HIERARCHY: Record<Role, number> = {
  staff: 1,
  admin: 2,
  owner: 3,
};

export function requireRole(roles: Role[]): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const role = c.get('role') as Role;
    if (!role) return c.json({ error: 'Unauthorized' }, 401);

    const userLevel = ROLE_HIERARCHY[role] ?? 0;
    const minRequired = Math.min(...roles.map(r => ROLE_HIERARCHY[r]));

    if (userLevel < minRequired) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
    await next();
  };
}

export function requirePlan(feature: keyof typeof PLAN_LIMITS['free']): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const plan = (c.get('plan') ?? 'free') as Plan;
    const limits = PLAN_LIMITS[plan];

    if (!limits) return c.json({ error: 'Invalid plan' }, 403);

    if (feature === 'team' && !limits.team) {
      return c.json({ error: 'Team feature requires Business plan', upgrade: true }, 403);
    }
    if (feature === 'customDomain' && !limits.customDomain) {
      return c.json({ error: 'Custom domain requires Business plan', upgrade: true }, 403);
    }
    if (feature === 'analytics' && !limits.analytics) {
      return c.json({ error: 'Analytics requires Pro plan or higher', upgrade: true }, 403);
    }

    await next();
  };
}

export function requireSuperAdmin(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    // Super admin identified by a special header + secret
    const adminKey = c.req.header('X-Admin-Key');
    if (adminKey !== (c.env as any).ADMIN_SECRET) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  };
}
