// packages/shared/src/__tests__/schemas.test.ts
// Unit tests for Zod validation schemas — especially COD checkout

import { describe, it, expect } from 'vitest';
import {
  codCheckoutSchema,
  checkoutSchema,
  updateOrderStatusSchema,
  registerSchema,
} from '../schemas.js';

// ─── codCheckoutSchema ────────────────────────────────────────
describe('codCheckoutSchema', () => {
  const validCod = {
    items: [{ productId: '550e8400-e29b-41d4-a716-446655440000', qty: 2 }],
    customerEmail: 'test@example.com',
    customerName: 'محمد أمين',
    customerPhone: '0612345678',
    customerAddress: '123 شارع الحسن الثاني، الدار البيضاء، المغرب',
    currency: 'MAD' as const,
  };

  it('accepts valid COD payload', () => {
    const result = codCheckoutSchema.safeParse(validCod);
    expect(result.success).toBe(true);
  });

  it('rejects missing customerName', () => {
    const { customerName, ...rest } = validCod;
    const result = codCheckoutSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing customerPhone', () => {
    const { customerPhone, ...rest } = validCod;
    const result = codCheckoutSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects phone shorter than 8 chars', () => {
    const result = codCheckoutSchema.safeParse({ ...validCod, customerPhone: '0612' });
    expect(result.success).toBe(false);
  });

  it('rejects address shorter than 10 chars', () => {
    const result = codCheckoutSchema.safeParse({ ...validCod, customerAddress: 'short' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email', () => {
    const result = codCheckoutSchema.safeParse({ ...validCod, customerEmail: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects empty items array', () => {
    const result = codCheckoutSchema.safeParse({ ...validCod, items: [] });
    expect(result.success).toBe(false);
  });

  it('rejects qty = 0', () => {
    const result = codCheckoutSchema.safeParse({
      ...validCod,
      items: [{ productId: '550e8400-e29b-41d4-a716-446655440000', qty: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects qty > 100', () => {
    const result = codCheckoutSchema.safeParse({
      ...validCod,
      items: [{ productId: '550e8400-e29b-41d4-a716-446655440000', qty: 101 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid currency', () => {
    const result = codCheckoutSchema.safeParse({ ...validCod, currency: 'GBP' });
    expect(result.success).toBe(false);
  });

  it('accepts EUR currency', () => {
    const result = codCheckoutSchema.safeParse({ ...validCod, currency: 'EUR' });
    expect(result.success).toBe(true);
  });

  it('defaults currency to MAD when omitted', () => {
    const { currency, ...rest } = validCod;
    const result = codCheckoutSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currency).toBe('MAD');
  });
});

// ─── checkoutSchema (Stripe) ──────────────────────────────────
describe('checkoutSchema', () => {
  const validStripe = {
    items: [{ productId: 'prod-123', qty: 1 }],
    customerEmail: 'user@example.com',
    currency: 'MAD' as const,
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
  };

  it('accepts valid Stripe payload', () => {
    const result = checkoutSchema.safeParse(validStripe);
    expect(result.success).toBe(true);
  });

  it('rejects missing successUrl', () => {
    const { successUrl, ...rest } = validStripe;
    expect(checkoutSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects non-URL successUrl', () => {
    const result = checkoutSchema.safeParse({ ...validStripe, successUrl: '/success' });
    expect(result.success).toBe(false);
  });
});

// ─── updateOrderStatusSchema ──────────────────────────────────
describe('updateOrderStatusSchema', () => {
  it('accepts all valid statuses', () => {
    const statuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'] as const;
    for (const status of statuses) {
      const result = updateOrderStatusSchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown status', () => {
    const result = updateOrderStatusSchema.safeParse({ status: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('accepts optional paymentStatus for COD', () => {
    const result = updateOrderStatusSchema.safeParse({
      status: 'delivered',
      paymentStatus: 'PAID',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid paymentStatus', () => {
    const result = updateOrderStatusSchema.safeParse({
      status: 'delivered',
      paymentStatus: 'COLLECTED',  // not in enum
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional note up to 500 chars', () => {
    const result = updateOrderStatusSchema.safeParse({
      status: 'shipped',
      note: 'x'.repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it('rejects note longer than 500 chars', () => {
    const result = updateOrderStatusSchema.safeParse({
      status: 'shipped',
      note: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

// ─── registerSchema ───────────────────────────────────────────
describe('registerSchema', () => {
  it('accepts valid registration', () => {
    const result = registerSchema.safeParse({
      email: 'user@example.com',
      password: 'password123',
      name: 'محمد أمين',
    });
    expect(result.success).toBe(true);
  });

  it('rejects password shorter than 8 chars', () => {
    const result = registerSchema.safeParse({
      email: 'user@example.com',
      password: 'short',
      name: 'Test User',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name shorter than 2 chars', () => {
    const result = registerSchema.safeParse({
      email: 'user@example.com',
      password: 'password123',
      name: 'A',
    });
    expect(result.success).toBe(false);
  });
});
