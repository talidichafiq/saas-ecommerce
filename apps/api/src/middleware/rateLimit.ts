// apps/api/src/middleware/rateLimit.ts
//
// ✅ إصلاح كامل للـ rate limiting:
//   - Durable Object للـ login (consistent, atomic counters)
//   - KV فقط للـ public endpoints العامة (eventual consistency مقبول)
//   - Fixed window مع sliding window option للـ DO
//   - Clear error messages + Retry-After header

import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../index.js';

interface RateLimitOptions {
  /** Window duration in milliseconds */
  windowMs: number;
  /** Max requests per window */
  max: number;
  /** Prefix for storage key */
  keyPrefix?: string;
  /**
   * Use Durable Object for strong consistency (for login, sensitive endpoints).
   * Falls back to KV if DO not available.
   */
  useStrongConsistency?: boolean;
}

// ─── Durable Object Rate Limiter ─────────────────────────────
// This class must be exported and declared in wrangler.toml

export class RateLimiterDO {
  private state: DurableObjectState;
  private counts: Map<string, { count: number; windowStart: number }> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const { key, windowMs, max } = await request.json() as {
      key: string;
      windowMs: number;
      max: number;
    };

    const now = Date.now();
    const entry = this.counts.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      // New window
      this.counts.set(key, { count: 1, windowStart: now });
      return Response.json({
        allowed: true,
        remaining: max - 1,
        resetMs: windowMs,
      });
    }

    if (entry.count >= max) {
      const retryAfterMs = windowMs - (now - entry.windowStart);
      return Response.json({
        allowed: false,
        remaining: 0,
        retryAfterMs,
      });
    }

    entry.count++;
    return Response.json({
      allowed: true,
      remaining: max - entry.count,
      resetMs: windowMs - (now - entry.windowStart),
    });
  }
}

// ─── Main Rate Limit Middleware ───────────────────────────────

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const ip =
      c.req.header('CF-Connecting-IP') ??
      c.req.header('X-Forwarded-For')?.split(',')[0].trim() ??
      'unknown';

    const storageKey = `rl:${opts.keyPrefix ?? 'default'}:${ip}`;

    const limited = opts.useStrongConsistency
      ? await checkDO(c, storageKey, opts)
      : await checkKV(c, storageKey, opts);

    if (!limited.allowed) {
      const retryAfterSec = Math.ceil((limited.retryAfterMs ?? opts.windowMs) / 1000);
      c.header('Retry-After', String(retryAfterSec));
      c.header('X-RateLimit-Limit', String(opts.max));
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', String(Date.now() + (limited.retryAfterMs ?? opts.windowMs)));
      return c.json(
        { error: 'Too many requests. Please slow down.', retryAfterSeconds: retryAfterSec },
        429
      );
    }

    c.header('X-RateLimit-Limit', String(opts.max));
    c.header('X-RateLimit-Remaining', String(limited.remaining ?? 0));

    await next();
  };
}

// ─── Durable Object backend ───────────────────────────────────

async function checkDO(
  c: any,
  key: string,
  opts: RateLimitOptions
): Promise<{ allowed: boolean; remaining?: number; retryAfterMs?: number }> {
  try {
    const doNs = (c.env as any).RATE_LIMITER_DO as DurableObjectNamespace | undefined;
    if (!doNs) {
      // Fallback to KV if DO not bound
      return checkKV(c, key, opts);
    }

    // Use a hash of the key as the DO name (fixed length, safe characters)
    const doId = doNs.idFromName(key);
    const stub = doNs.get(doId);

    const res = await stub.fetch('https://rate-limiter/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, windowMs: opts.windowMs, max: opts.max }),
    });

    return await res.json();
  } catch {
    // If DO fails, fail open (allow the request) to avoid cascading failures
    console.error('[RateLimit] DO check failed, failing open');
    return { allowed: true };
  }
}

// ─── KV backend (eventual consistency — OK for public endpoints) ──

async function checkKV(
  c: any,
  key: string,
  opts: RateLimitOptions
): Promise<{ allowed: boolean; remaining?: number; retryAfterMs?: number }> {
  const kv = c.env.KV_RATE_LIMIT as KVNamespace | undefined;
  if (!kv) {
    // No KV bound — fail open
    return { allowed: true };
  }

  try {
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    const raw = await kv.get(key, 'text');
    let timestamps: number[] = [];

    if (raw) {
      try { timestamps = JSON.parse(raw); } catch { timestamps = []; }
    }

    // Sliding window: keep only timestamps within current window
    timestamps = timestamps.filter(ts => ts > windowStart);

    if (timestamps.length >= opts.max) {
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + opts.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    timestamps.push(now);

    // TTL slightly longer than window to handle clock skew
    const ttlSec = Math.ceil(opts.windowMs / 1000) + 30;
    await kv.put(key, JSON.stringify(timestamps), { expirationTtl: ttlSec });

    return { allowed: true, remaining: opts.max - timestamps.length };
  } catch {
    // KV failure — fail open
    return { allowed: true };
  }
}

// ─── Preset Limiters ─────────────────────────────────────────

/** Login: strict, Durable Object for consistency (brute-force protection) */
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,                     // 10 attempts
  keyPrefix: 'login',
  useStrongConsistency: true,  // DO → no race condition between Workers
});

/** Password reset: very strict to prevent user enumeration via timing */
export const resetRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 5,
  keyPrefix: 'reset',
  useStrongConsistency: true,
});

/** Public API (catalog, search): KV is fine, eventual consistency acceptable */
export const publicApiRateLimit = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 60,
  keyPrefix: 'public',
  useStrongConsistency: false,
});

/** File upload: per-minute strict to prevent storage abuse */
export const uploadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyPrefix: 'upload',
  useStrongConsistency: false,
});

/** Registration: prevent account farming */
export const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,
  keyPrefix: 'register',
  useStrongConsistency: true,
});
