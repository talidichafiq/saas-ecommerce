// packages/db/src/schema.ts
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── Helpers ───────────────────────────────────────────────
const id = () => text('id').primaryKey();
const tenantId = () => text('tenant_id').notNull();
const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`);

// ─── Tenants ────────────────────────────────────────────────
export const tenants = sqliteTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan', { enum: ['free', 'pro', 'business'] }).notNull().default('free'),
  logoR2Key: text('logo_r2_key'),
  primaryColor: text('primary_color').default('#6366f1'),
  shippingPolicy: text('shipping_policy'),
  returnPolicy: text('return_policy'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  ownerUserId: text('owner_user_id').notNull(),
  createdAt: createdAt(),
});

// ─── Users ──────────────────────────────────────────────────
export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  // Password reset (separate from email verification)
  resetToken: text('reset_token'),
  resetTokenExpiresAt: text('reset_token_expires_at'),
  // Email verification (dedicated columns — never mixed with reset)
  emailVerifyToken: text('email_verify_token'),
  emailVerifyExpiresAt: text('email_verify_expires_at'),
  createdAt: createdAt(),
});

// ─── Sessions ───────────────────────────────────────────────
export const sessions = sqliteTable('sessions', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: createdAt(),
});

// ─── Memberships ────────────────────────────────────────────
export const memberships = sqliteTable(
  'memberships',
  {
    id: id(),
    tenantId: tenantId(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'staff'] }).notNull().default('staff'),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantUserIdx: uniqueIndex('memberships_tenant_user_idx').on(t.tenantId, t.userId),
    tenantIdx: index('memberships_tenant_idx').on(t.tenantId),
  })
);

// ─── Products ───────────────────────────────────────────────
export const products = sqliteTable(
  'products',
  {
    id: id(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    description: text('description'),
    price: real('price').notNull(),
    salePrice: real('sale_price'),
    currency: text('currency', { enum: ['MAD', 'EUR', 'USD'] }).notNull().default('MAD'),
    sku: text('sku'),
    stock: integer('stock').notNull().default(0),
    status: text('status', { enum: ['active', 'draft', 'archived'] }).notNull().default('draft'),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantIdx: index('products_tenant_idx').on(t.tenantId),
    statusIdx: index('products_status_idx').on(t.tenantId, t.status),
  })
);

// ─── Product Images ─────────────────────────────────────────
export const productImages = sqliteTable(
  'product_images',
  {
    id: id(),
    tenantId: tenantId(),
    productId: text('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    alt: text('alt'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    productIdx: index('product_images_product_idx').on(t.productId),
  })
);

// ─── Categories ─────────────────────────────────────────────
export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    slugIdx: uniqueIndex('categories_slug_tenant_idx').on(t.tenantId, t.slug),
    tenantIdx: index('categories_tenant_idx').on(t.tenantId),
  })
);

// ─── Product Categories ─────────────────────────────────────
export const productCategories = sqliteTable(
  'product_categories',
  {
    id: id(),
    tenantId: tenantId(),
    productId: text('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    categoryId: text('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    uniqueIdx: uniqueIndex('pc_unique_idx').on(t.productId, t.categoryId),
  })
);

// ─── Orders ─────────────────────────────────────────────────
export const orders = sqliteTable(
  'orders',
  {
    id: id(),
    tenantId: tenantId(),
    customerEmail: text('customer_email').notNull(),
    customerName: text('customer_name'),
    status: text('status', {
      enum: ['pending', 'paid', 'shipped', 'cancelled', 'refunded'],
    }).notNull().default('pending'),
    subtotal: real('subtotal').notNull(),
    total: real('total').notNull(),
    currency: text('currency').notNull().default('MAD'),
    stripeSessionId: text('stripe_session_id').unique(),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantIdx: index('orders_tenant_idx').on(t.tenantId),
    statusIdx: index('orders_status_idx').on(t.tenantId, t.status),
    stripeIdx: index('orders_stripe_idx').on(t.stripeSessionId),
  })
);

// ─── Order Items ────────────────────────────────────────────
export const orderItems = sqliteTable(
  'order_items',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
    productId: text('product_id'),
    titleSnapshot: text('title_snapshot').notNull(),
    priceSnapshot: real('price_snapshot').notNull(),
    qty: integer('qty').notNull(),
  },
  (t) => ({
    orderIdx: index('order_items_order_idx').on(t.orderId),
  })
);

// ─── Subscriptions ──────────────────────────────────────────
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: id(),
    tenantId: text('tenant_id').notNull().unique(),
    stripeCustomerId: text('stripe_customer_id').unique(),
    stripeSubscriptionId: text('stripe_subscription_id').unique(),
    status: text('status', {
      enum: ['active', 'trialing', 'past_due', 'canceled', 'incomplete'],
    }).notNull().default('active'),
    plan: text('plan', { enum: ['free', 'pro', 'business'] }).notNull().default('free'),
    currentPeriodEnd: text('current_period_end'),
    createdAt: createdAt(),
  }
);

// ─── Audit Logs ─────────────────────────────────────────────
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: id(),
    tenantId: tenantId(),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    metaJson: text('meta_json'),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantIdx: index('audit_tenant_idx').on(t.tenantId),
    actorIdx: index('audit_actor_idx').on(t.actorUserId),
  })
);

// ─── Type Exports ───────────────────────────────────────────
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductImage = typeof productImages.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
