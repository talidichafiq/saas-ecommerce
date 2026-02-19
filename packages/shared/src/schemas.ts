// packages/shared/src/schemas.ts
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('البريد الإلكتروني غير صالح'),
  password: z.string().min(8, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل'),
  name: z.string().min(2, 'الاسم يجب أن يكون حرفين على الأقل'),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createTenantSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, 'الاسم يجب أن يحتوي على أحرف إنجليزية صغيرة وأرقام وشرطات فقط'),
});

export const updateTenantSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  logoR2Key: z.string().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  shippingPolicy: z.string().max(5000).optional(),
  returnPolicy: z.string().max(5000).optional(),
});

export const createProductSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  price: z.number().positive(),
  salePrice: z.number().positive().optional().nullable(),
  currency: z.enum(['MAD', 'EUR', 'USD']).default('MAD'),
  sku: z.string().max(100).optional().nullable(),
  stock: z.number().int().min(0).default(0),
  status: z.enum(['active', 'draft', 'archived']).default('draft'),
  categoryIds: z.array(z.string()).optional(),
});

export const updateProductSchema = createProductSchema.partial();

export const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(['pending', 'paid', 'shipped', 'cancelled', 'refunded']),
  note: z.string().max(500).optional(),
});

export const checkoutSchema = z.object({
  items: z.array(z.object({
    productId: z.string(),
    qty: z.number().int().positive(),
  })).min(1),
  customerEmail: z.string().email(),
  currency: z.enum(['MAD', 'EUR', 'USD']).default('MAD'),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
