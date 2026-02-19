// apps/api/src/middleware/auth.ts
//
// ✅ PRODUCTION-READY AUTH — إصلاحات كاملة:
//   - HttpOnly + Secure + SameSite=Lax cookie (مش localStorage/JWT)
//   - DB-backed sessions → logout حقيقي + revocation فورية
//   - Session token = 32 random bytes → SHA-256 hash فـ DB (مش plaintext)
//   - Reset password token = 32 random bytes → SHA-256 hash فـ DB
//   - PBKDF2-SHA256: 310,000 iterations + 32-byte salt + timing-safe compare
//   - Rolling sessions: expiry يتجدد مع كل request
//   - Role/Plan يُجلبان من DB مع كل request (مش من JWT stale)

import type { MiddlewareHandler, Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { eq, and, lt } from 'drizzle-orm';
import { createDb, sessions, memberships, tenants } from '@repo/db';
import type { AppContext } from '../index.js';

// ─── Constants ────────────────────────────────────────────────
const SESSION_COOKIE = '__session';
const SESSION_TTL_DAYS = 14;
const PBKDF2_ITERATIONS = 310_000;  // OWASP 2023 for SHA-256
const SALT_BYTES = 32;              // 256-bit salt

// ─── Crypto Helpers ───────────────────────────────────────────

/** Generates a cryptographically secure random token (hex) */
export function generateSecureToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return toHex(arr);
}

/** SHA-256 hash — used for token storage (never store raw tokens) */
export async function hashToken(rawToken: string): Promise<string> {
  const data = new TextEncoder().encode(rawToken);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(buf));
}

// ─── Password Hashing ─────────────────────────────────────────

/**
 * PBKDF2-SHA256 with 310k iterations + 32-byte random salt.
 * Stored format: $pbkdf2-sha256$<iterations>$<salt-hex>$<hash-hex>
 * This format is self-describing → future iteration upgrades work automatically.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await importPasswordKey(password);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `$pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(derived))}`;
}

/**
 * Constant-time password verification.
 * Parses iterations from stored hash so it survives migration to higher iterations.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // Dev-only seed hash — never used in prod
  if (stored.startsWith('$sha256$')) {
    if (typeof (globalThis as any).process !== 'undefined') {
      const { createHash } = await import('node:crypto' as any);
      const h = createHash('sha256').update(password + 'seed-salt').digest('hex');
      return timingSafeEqual(`$sha256$${h}`, stored);
    }
    return false;
  }

  const parts = stored.split('$').filter(Boolean);
  // Expected: ['pbkdf2-sha256', '<iterations>', '<salt-hex>', '<hash-hex>']
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;

  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 100_000) return false;

  const salt = fromHex(parts[2]);
  const expectedHash = parts[3];

  const keyMaterial = await importPasswordKey(password);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  // Timing-safe comparison prevents timing oracle attacks
  return timingSafeEqual(toHex(new Uint8Array(derived)), expectedHash);
}

// ─── Session Management ───────────────────────────────────────

/**
 * Creates a DB-backed session and sets an HttpOnly cookie.
 *
 * Flow:
 *   1. Generate 32 random bytes (raw token)
 *   2. SHA-256 hash → store in DB
 *   3. Set raw token in HttpOnly cookie (never stored server-side)
 *   4. Purge expired sessions for this user (hygiene)
 */
export async function createSession(
  c: Context<AppContext>,
  userId: string
): Promise<void> {
  const db = createDb(c.env.DB);

  // Cleanup expired sessions (best-effort, don't fail if it errors)
  try {
    await db.delete(sessions).where(
      and(
        eq(sessions.userId, userId),
        lt(sessions.expiresAt, new Date().toISOString())
      )
    );
  } catch { /* non-critical */ }

  const rawToken = generateSecureToken(32);
  const tokenHash = await hashToken(rawToken);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString();

  await db.insert(sessions).values({ id: sessionId, userId, tokenHash, expiresAt });

  const isProduction = !(c.env.APP_URL ?? '').includes('localhost');

  setCookie(c, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: isProduction,   // false في local dev بدون HTTPS
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86400,
  });
}

/** Destroys session in DB and clears cookie — real logout */
export async function destroySession(c: Context<AppContext>): Promise<void> {
  const db = createDb(c.env.DB);
  const rawToken = getCookie(c, SESSION_COOKIE);

  if (rawToken) {
    const tokenHash = await hashToken(rawToken);
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  deleteCookie(c, SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    path: '/',
  });
}

// ─── Auth Middleware ──────────────────────────────────────────

/**
 * requireAuth — validates session cookie → looks up DB → injects userId/tenantId/role/plan.
 *
 * Key properties:
 *   - Role and plan fetched FRESH from DB on every request (no stale JWT claims)
 *   - Rolling session: expiry extended on each valid request
 *   - Invalid/expired sessions are cleaned up immediately
 */
export function requireAuth(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const session = await validateSession(c);
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}

/** Like requireAuth but does not block unauthenticated requests */
export function optionalAuth(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    await validateSession(c); // sets variables if valid, silently skips if not
    await next();
  };
}

// ─── Internal: session validation ────────────────────────────

async function validateSession(c: Context<AppContext>): Promise<boolean> {
  const db = createDb(c.env.DB);
  const rawToken = getCookie(c, SESSION_COOKIE);
  if (!rawToken) return false;

  const tokenHash = await hashToken(rawToken);
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.tokenHash, tokenHash),
  });

  if (!session) {
    deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure: true, path: '/' });
    return false;
  }

  if (new Date(session.expiresAt) < new Date()) {
    await db.delete(sessions).where(eq(sessions.id, session.id));
    deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure: true, path: '/' });
    return false;
  }

  // Rolling session — extend expiry on activity
  const newExpiry = new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString();
  await db.update(sessions)
    .set({ expiresAt: newExpiry })
    .where(eq(sessions.id, session.id));

  c.set('userId', session.userId);

  // Resolve tenant context fresh from DB (slug from header)
  const slug = c.req.header('X-Tenant-Slug');
  if (slug) {
    await injectTenantContext(c, session.userId, slug);
  }

  return true;
}

/**
 * Fetches tenant + membership fresh from DB.
 * This is what prevents stale role/plan after Stripe webhook upgrades.
 */
async function injectTenantContext(
  c: Context<AppContext>,
  userId: string,
  slug: string
): Promise<void> {
  const db = createDb(c.env.DB);

  const tenant = await db.query.tenants.findFirst({
    where: (t, { eq, and }) => and(eq(t.slug, slug), eq(t.isActive, true)),
  });
  if (!tenant) return;

  const membership = await db.query.memberships.findFirst({
    where: and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, userId)),
  });
  if (!membership) return;

  // Always from DB — never from a potentially-stale token
  c.set('tenantId', tenant.id);
  c.set('role', membership.role);
  c.set('plan', tenant.plan);  // source of truth = tenants.plan (updated by webhook)
}

// ─── Reset Token Helpers ──────────────────────────────────────

/**
 * Generates a reset password token pair:
 *   - rawToken: sent to user's email (never stored)
 *   - tokenHash: stored in DB (SHA-256 of rawToken)
 */
export async function generateResetToken(): Promise<{ rawToken: string; tokenHash: string }> {
  const rawToken = generateSecureToken(32);
  const tokenHash = await hashToken(rawToken);
  return { rawToken, tokenHash };
}

/** Verifies a raw reset token against the stored hash (constant-time) */
export async function verifyResetToken(rawToken: string, storedHash: string): Promise<boolean> {
  const computed = await hashToken(rawToken);
  return timingSafeEqual(computed, storedHash);
}

// ─── Utility ──────────────────────────────────────────────────

function toHex(buf: Uint8Array): string {
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)));
}

async function importPasswordKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
}

/**
 * Constant-time string comparison — prevents timing oracle attacks.
 * Length is not secret for fixed-length hashes (hex SHA-256 = always 64 chars).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
