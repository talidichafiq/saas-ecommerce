// packages/shared/src/types.ts

export type Plan = 'free' | 'pro' | 'business';
export type Role = 'owner' | 'admin' | 'staff';
export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'cancelled' | 'refunded';
export type ProductStatus = 'active' | 'draft' | 'archived';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  createdAt: string;
  ownerUserId: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Membership {
  id: string;
  tenantId: string;
  userId: string;
  role: Role;
}

export interface Product {
  id: string;
  tenantId: string;
  title: string;
  description: string | null;
  price: number;
  salePrice: number | null;
  currency: string;
  sku: string | null;
  stock: number;
  status: ProductStatus;
  createdAt: string;
  images?: ProductImage[];
  categories?: Category[];
}

export interface ProductImage {
  id: string;
  productId: string;
  r2Key: string;
  alt: string | null;
  sortOrder: number;
  url?: string;
}

export interface Category {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
}

export interface Order {
  id: string;
  tenantId: string;
  customerEmail: string;
  status: OrderStatus;
  subtotal: number;
  total: number;
  currency: string;
  stripeSessionId: string | null;
  createdAt: string;
  items?: OrderItem[];
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string | null;
  titleSnapshot: string;
  priceSnapshot: number;
  qty: number;
}

export interface Subscription {
  id: string;
  tenantId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
}

export interface AuthSession {
  userId: string;
  tenantId: string;
  role: Role;
  plan: Plan;
}

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const PLAN_LIMITS: Record<Plan, { maxProducts: number; customDomain: boolean; team: boolean; analytics: boolean }> = {
  free: { maxProducts: 20, customDomain: false, team: false, analytics: false },
  pro: { maxProducts: Infinity, customDomain: false, team: false, analytics: true },
  business: { maxProducts: Infinity, customDomain: true, team: true, analytics: true },
};

export const CURRENCIES = ['MAD', 'EUR', 'USD'] as const;
export type Currency = typeof CURRENCIES[number];
