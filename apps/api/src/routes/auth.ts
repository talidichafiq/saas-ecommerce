// apps/api/src/routes/auth.ts
//
// ✅ Bug fixes (v3):
//
//   BUG 1 — Email verification broken:
//     قبل: sendVerificationEmail() كتولّد rawToken محلياً ولا تخزّنه فـ DB أبداً
//     دبا: rawSecret + hash يتولّدو قبل INSERT، hash يتخزن فـ emailVerifyToken (حقل خاص)
//          token فـ URL = userId.rawSecret → verify بـ hash comparison
//
//   BUG 2 — Reset password link يفشل دائماً:
//     قبل: sendResetEmail() تبعث rawToken وحده، و/auth/reset يتوقع userId.rawSecret
//     دبا: /auth/forgot يبعث ${user.id}.${rawSecret} → /auth/reset يشتغل صح
//
//   BUG 3 — JWT_SECRET references:
//     حذفنا كل mention لـ JWT_SECRET (لا نستعمل JWT بتاتاً)

import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { createDb, users, memberships, tenants, subscriptions, sessions } from '@repo/db';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  createTenantSchema,
} from '@repo/shared/schemas';
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  generateResetToken,
  verifyResetToken,
} from '../middleware/auth.js';
import { loginRateLimit, resetRateLimit, registerRateLimit } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppContext } from '../index.js';

export const authRoutes = new Hono<AppContext>();

// ─── POST /auth/register ──────────────────────────────────────
authRoutes.post('/register', registerRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.flatten().fieldErrors }, 400);
  }

  const db = createDb(c.env.DB);
  const { email, password, name } = parsed.data;

  const existing = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });
  if (existing) {
    return c.json({ error: 'البريد الإلكتروني مستخدم بالفعل' }, 409);
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  // ── BUG 1 FIX: Generate verify token BEFORE insert ────────────
  // rawSecret → sent in email URL only (never stored in DB)
  // verifyHash → SHA-256 of rawSecret, stored in emailVerifyToken (dedicated column)
  const { rawToken: rawSecret, tokenHash: verifyHash } = await generateResetToken();
  const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

  await db.insert(users).values({
    id: userId,
    email: email.toLowerCase(),
    passwordHash,
    name,
    emailVerified: false,
    emailVerifyToken: verifyHash,         // ✅ HASH stored, not raw token
    emailVerifyExpiresAt: verifyExpiresAt,
  });

  // Send email non-blocking — registration must succeed even if email fails
  // URL token format: userId.rawSecret  (parsed in GET /auth/verify-email)
  sendVerificationEmail(
    c.env.RESEND_API_KEY,
    email.toLowerCase(),
    `${userId}.${rawSecret}`,  // ✅ correct format, rawSecret generated above
    c.env.APP_URL,
  ).catch(err => console.error('[Auth] Verification email failed:', err));

  await createSession(c, userId);

  return c.json({
    user: { id: userId, email: email.toLowerCase(), name, emailVerified: false },
    message: 'تم إنشاء الحساب. تحقق من بريدك الإلكتروني للتفعيل.',
  }, 201);
});

// ─── GET /auth/verify-email?token=userId.rawSecret ────────────
authRoutes.get('/verify-email', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'Token required' }, 400);

  // ── BUG 1 FIX: Parse userId.rawSecret format ──────────────────
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return c.json({ error: 'رابط غير صالح' }, 400);

  const userId   = token.slice(0, dotIdx);
  const rawSecret = token.slice(dotIdx + 1);

  const db = createDb(c.env.DB);

  // Lookup by userId (fast indexed query — no table scan)
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!user) {
    return c.json({ error: 'رابط التفعيل غير صالح' }, 400);
  }

  if (user.emailVerified) {
    return c.json({ message: 'البريد الإلكتروني مفعّل بالفعل' });
  }

  if (!user.emailVerifyToken || !user.emailVerifyExpiresAt) {
    return c.json({ error: 'لا يوجد طلب تفعيل نشط' }, 400);
  }

  if (new Date(user.emailVerifyExpiresAt) < new Date()) {
    return c.json({ error: 'انتهت صلاحية رابط التفعيل (24 ساعة). سجّل دخولك لإعادة الإرسال.' }, 400);
  }

  // Verify rawSecret against stored hash (constant-time)
  const valid = await verifyResetToken(rawSecret, user.emailVerifyToken);
  if (!valid) {
    return c.json({ error: 'رابط التفعيل غير صالح' }, 400);
  }

  // Activate account + clear verify fields
  await db.update(users)
    .set({
      emailVerified: true,
      emailVerifyToken: null,
      emailVerifyExpiresAt: null,
    })
    .where(eq(users.id, userId));

  return c.json({ message: 'تم تفعيل البريد الإلكتروني بنجاح! يمكنك تسجيل الدخول.' });
});

// ─── POST /auth/resend-verification ──────────────────────────
// Lets logged-in users request a new verification email
authRoutes.post('/resend-verification', requireAuth(), async (c) => {
  const db = createDb(c.env.DB);
  const userId = c.get('userId');

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return c.json({ error: 'User not found' }, 404);
  if (user.emailVerified) return c.json({ message: 'البريد مفعّل بالفعل' });

  const { rawToken: rawSecret, tokenHash: verifyHash } = await generateResetToken();
  const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await db.update(users)
    .set({ emailVerifyToken: verifyHash, emailVerifyExpiresAt: verifyExpiresAt })
    .where(eq(users.id, userId));

  sendVerificationEmail(
    c.env.RESEND_API_KEY,
    user.email,
    `${userId}.${rawSecret}`,
    c.env.APP_URL,
  ).catch(err => console.error('[Auth] Resend verification failed:', err));

  return c.json({ message: 'تم إرسال رابط تفعيل جديد إلى بريدك الإلكتروني.' });
});

// ─── POST /auth/login ─────────────────────────────────────────
authRoutes.post('/login', loginRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed' }, 400);
  }

  const db = createDb(c.env.DB);
  const { email, password } = parsed.data;

  const user = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });

  // Always run verifyPassword even when user not found — prevents timing oracle
  const dummyHash = '$pbkdf2-sha256$310000$' + '00'.repeat(32) + '$' + '00'.repeat(32);
  const passwordValid = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, dummyHash).then(() => false);

  if (!user || !passwordValid) {
    return c.json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, 401);
  }

  const membership = await db.query.memberships.findFirst({
    where: eq(memberships.userId, user.id),
  });

  let tenantData = null;
  if (membership) {
    const tenant = await db.query.tenants.findFirst({
      where: and(eq(tenants.id, membership.tenantId), eq(tenants.isActive, true)),
    });
    if (tenant) {
      tenantData = {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        plan: tenant.plan,
        role: membership.role,
      };
    }
  }

  await createSession(c, user.id);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
    },
    tenant: tenantData,
    // ✅ No token in JSON body — session is in HttpOnly cookie only
  });
});

// ─── POST /auth/logout ────────────────────────────────────────
authRoutes.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ message: 'تم تسجيل الخروج بنجاح' });
});

// ─── GET /auth/me ─────────────────────────────────────────────
authRoutes.get('/me', requireAuth(), async (c) => {
  const db = createDb(c.env.DB);
  const userId = c.get('userId');

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) {
    await destroySession(c);
    return c.json({ error: 'User not found' }, 404);
  }

  const membershipList = await db.query.memberships.findMany({
    where: eq(memberships.userId, userId),
  });

  const tenantList = await Promise.all(
    membershipList.map(async (m) => {
      const tenant = await db.query.tenants.findFirst({
        where: and(eq(tenants.id, m.tenantId), eq(tenants.isActive, true)),
      });
      return tenant ? { ...tenant, role: m.role } : null;
    })
  );

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
    },
    tenants: tenantList.filter(Boolean),
  });
});

// ─── POST /auth/forgot ────────────────────────────────────────
authRoutes.post('/forgot', resetRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid email' }, 400);

  const db = createDb(c.env.DB);

  // Same response regardless of whether email exists — prevents user enumeration
  const user = await db.query.users.findFirst({
    where: eq(users.email, parsed.data.email.toLowerCase()),
  });

  if (user) {
    // ── BUG 2 FIX: Send userId.rawSecret so /auth/reset can look up by ID ─
    const { rawToken: rawSecret, tokenHash } = await generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await db.update(users)
      .set({ resetToken: tokenHash, resetTokenExpiresAt: expiresAt })
      .where(eq(users.id, user.id));

    if (c.env.RESEND_API_KEY) {
      // ✅ Token in URL = userId.rawSecret (format expected by /auth/reset)
      sendResetEmail(
        c.env.RESEND_API_KEY,
        user.email,
        `${user.id}.${rawSecret}`,  // ✅ BUG 2 fixed — was: rawToken alone
        c.env.APP_URL,
      ).catch(err => console.error('[Auth] Reset email failed:', err));
    } else {
      // Dev convenience: log the full token so you can test without email
      console.warn(`[Auth][Dev] Reset URL: ${c.env.APP_URL}/auth/reset?token=${user.id}.${rawSecret}`);
    }
  }

  return c.json({ message: 'إذا كان البريد مسجلاً، ستصلك رسالة خلال دقائق' });
});

// ─── POST /auth/reset ─────────────────────────────────────────
authRoutes.post('/reset', resetRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input' }, 400);

  const { token, password } = parsed.data;

  // Token format: userId.rawSecret
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return c.json({ error: 'رابط غير صالح' }, 400);

  const userId    = token.slice(0, dotIdx);
  const rawSecret = token.slice(dotIdx + 1);

  const db = createDb(c.env.DB);

  // Indexed lookup by userId (no table scan needed)
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

  if (!user || !user.resetToken || !user.resetTokenExpiresAt) {
    return c.json({ error: 'الرابط منتهي الصلاحية أو غير صالح' }, 400);
  }

  if (new Date(user.resetTokenExpiresAt) < new Date()) {
    return c.json({ error: 'انتهت صلاحية الرابط (ساعة واحدة). اطلب رابطاً جديداً.' }, 400);
  }

  // Constant-time comparison against stored hash
  const valid = await verifyResetToken(rawSecret, user.resetToken);
  if (!valid) {
    return c.json({ error: 'الرابط منتهي الصلاحية أو غير صالح' }, 400);
  }

  const passwordHash = await hashPassword(password);

  await db.update(users)
    .set({ passwordHash, resetToken: null, resetTokenExpiresAt: null })
    .where(eq(users.id, userId));

  // Invalidate ALL existing sessions after password reset (security)
  await db.delete(sessions).where(eq(sessions.userId, userId));

  return c.json({ message: 'تم تغيير كلمة المرور بنجاح. يمكنك تسجيل الدخول الآن.' });
});

// ─── POST /auth/create-tenant ─────────────────────────────────
authRoutes.post('/create-tenant', requireAuth(), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createTenantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.flatten().fieldErrors }, 400);
  }

  const db = createDb(c.env.DB);
  const userId = c.get('userId');

  const existing = await db.query.tenants.findFirst({
    where: eq(tenants.slug, parsed.data.slug),
  });
  if (existing) {
    return c.json({ error: 'هذا الرابط مستخدم بالفعل، جرب اسماً آخر' }, 409);
  }

  const tenantId = crypto.randomUUID();

  await db.insert(tenants).values({
    id: tenantId,
    name: parsed.data.name,
    slug: parsed.data.slug,
    ownerUserId: userId,
    plan: 'free',
  });

  await db.insert(memberships).values({
    id: crypto.randomUUID(),
    tenantId,
    userId,
    role: 'owner',
  });

  await db.insert(subscriptions).values({
    id: crypto.randomUUID(),
    tenantId,
    status: 'active',
    plan: 'free',
  });

  return c.json({ tenantId, slug: parsed.data.slug }, 201);
});

// ─── Email Helpers ────────────────────────────────────────────

/**
 * Sends email verification link.
 *
 * @param composedToken - already formatted as "userId.rawSecret"
 *
 * NOTE: The caller is responsible for generating rawSecret, storing its hash
 *       in emailVerifyToken, and composing the token string. This function
 *       is a pure sending helper — it does NOT touch the DB.
 */
async function sendVerificationEmail(
  apiKey: string | undefined,
  toEmail: string,
  composedToken: string,   // userId.rawSecret
  appUrl: string,
): Promise<void> {
  if (!apiKey) {
    console.warn(`[Auth][Dev] Verify URL: ${appUrl}/auth/verify-email?token=${composedToken}`);
    return;
  }

  const verifyUrl = `${appUrl}/auth/verify-email?token=${encodeURIComponent(composedToken)}`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'noreply@yourdomain.com',
      to: [toEmail],
      subject: 'تفعيل حسابك',
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="color:#6366f1;margin-bottom:8px">مرحباً بك! 🎉</h2>
          <p style="color:#374151;line-height:1.6;margin-bottom:16px">
            شكراً لتسجيلك. اضغط على الزر أدناه لتفعيل حسابك:
          </p>
          <a href="${verifyUrl}"
             style="display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin-bottom:16px">
            تفعيل الحساب
          </a>
          <p style="color:#6b7280;font-size:13px">الرابط صالح لمدة 24 ساعة.</p>
          <p style="color:#6b7280;font-size:13px">إذا لم تنشئ حساباً، يمكنك تجاهل هذه الرسالة.</p>
        </div>
      `,
    }),
  });
}

/**
 * Sends password reset link.
 *
 * @param composedToken - already formatted as "userId.rawSecret"
 *
 * Same pattern as sendVerificationEmail — caller composes the token,
 * this function only sends.
 */
async function sendResetEmail(
  apiKey: string,
  toEmail: string,
  composedToken: string,   // userId.rawSecret
  appUrl: string,
): Promise<void> {
  const resetUrl = `${appUrl}/auth/reset?token=${encodeURIComponent(composedToken)}`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'noreply@yourdomain.com',
      to: [toEmail],
      subject: 'إعادة تعيين كلمة المرور',
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="color:#6366f1;margin-bottom:8px">إعادة تعيين كلمة المرور 🔐</h2>
          <p style="color:#374151;line-height:1.6;margin-bottom:16px">
            تلقينا طلباً لإعادة تعيين كلمة مرور حسابك.
          </p>
          <a href="${resetUrl}"
             style="display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin-bottom:16px">
            إعادة تعيين كلمة المرور
          </a>
          <p style="color:#6b7280;font-size:13px">الرابط صالح لمدة ساعة واحدة فقط.</p>
          <p style="color:#6b7280;font-size:13px">إذا لم تطلب هذا، يمكنك تجاهل هذه الرسالة بأمان.</p>
        </div>
      `,
    }),
  });
}
