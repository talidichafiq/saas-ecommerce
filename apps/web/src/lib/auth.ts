// apps/web/src/lib/auth.ts
// ✅ Auth state = UI cache فقط (non-sensitive)
// ✅ Session الحقيقية = HttpOnly cookie (مش مرئية لـ JS)
// ✅ كل API call بـ credentials:'include' تلقائياً (من api.ts)
// ✅ لا token، لا password، لا sensitive data هنا

import { atom } from 'nanostores';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
}

export interface AuthState {
  user: AuthUser | null;
  tenantSlug: string | null;
  tenantId: string | null;
  tenantName: string | null;
  role: string | null;
  plan: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export const authStore = atom<AuthState>({
  user: null,
  tenantSlug: null,
  tenantId: null,
  tenantName: null,
  role: null,
  plan: null,
  isLoading: true,
  isAuthenticated: false,
});

/** Initialize from localStorage UI cache (called on page load) */
export function initAuth() {
  if (typeof localStorage === 'undefined') return;

  const userRaw = localStorage.getItem('auth_user');
  const user: AuthUser | null = userRaw ? JSON.parse(userRaw) : null;

  authStore.set({
    user,
    tenantSlug: localStorage.getItem('tenant_slug'),
    tenantId: localStorage.getItem('tenant_id'),
    tenantName: localStorage.getItem('tenant_name'),
    role: localStorage.getItem('tenant_role'),
    plan: localStorage.getItem('tenant_plan'),
    isLoading: false,
    isAuthenticated: !!user,
  });
}

/** Called after successful login/register */
export function setAuth(user: AuthUser, tenant?: {
  id: string;
  slug: string;
  name?: string;
  role: string;
  plan: string;
}) {
  if (typeof localStorage === 'undefined') return;

  localStorage.setItem('auth_user', JSON.stringify(user));
  if (tenant) {
    localStorage.setItem('tenant_id', tenant.id);
    localStorage.setItem('tenant_slug', tenant.slug);
    localStorage.setItem('tenant_role', tenant.role);
    localStorage.setItem('tenant_plan', tenant.plan);
    if (tenant.name) localStorage.setItem('tenant_name', tenant.name);
  }

  authStore.set({
    user,
    tenantId: tenant?.id ?? null,
    tenantSlug: tenant?.slug ?? null,
    tenantName: tenant?.name ?? null,
    role: tenant?.role ?? null,
    plan: tenant?.plan ?? null,
    isLoading: false,
    isAuthenticated: true,
  });
}

/** Called after logout — clears all UI state (session cleared server-side) */
export function clearAuth() {
  if (typeof localStorage === 'undefined') return;

  [
    'auth_user',
    'tenant_id',
    'tenant_slug',
    'tenant_role',
    'tenant_plan',
    'tenant_name',
  ].forEach(k => localStorage.removeItem(k));

  authStore.set({
    user: null,
    tenantSlug: null,
    tenantId: null,
    tenantName: null,
    role: null,
    plan: null,
    isLoading: false,
    isAuthenticated: false,
  });
}

/** Refresh plan/role from server (call after billing changes) */
export async function refreshAuthFromServer(apiUrl: string) {
  const tenantSlug = localStorage.getItem('tenant_slug');
  if (!tenantSlug) return;

  const res = await fetch(`${apiUrl}/auth/me`, {
    credentials: 'include',
    headers: { 'X-Tenant-Slug': tenantSlug },
  });

  if (!res.ok) return;

  const data = await res.json();
  if (data.user) {
    const tenant = data.tenants?.find((t: any) => t.slug === tenantSlug);
    setAuth(data.user, tenant ? {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      role: tenant.role,
      plan: tenant.plan,
    } : undefined);
  }
}
