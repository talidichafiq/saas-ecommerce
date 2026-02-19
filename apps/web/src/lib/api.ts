// apps/web/src/lib/api.ts
// ✅ Cookie-based auth: credentials: 'include' على كل request
// ✅ لا Authorization header، لا localStorage token
// ✅ 401 → redirect تلقائي لصفحة login

const API_BASE = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8787';

interface RequestOptions extends RequestInit {
  tenantSlug?: string;
}

async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { tenantSlug, ...fetchOpts } = opts;

  const headers = new Headers(fetchOpts.headers ?? {});

  // Set JSON content-type for all non-FormData requests
  if (!(fetchOpts.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (tenantSlug) headers.set('X-Tenant-Slug', tenantSlug);

  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOpts,
    headers,
    credentials: 'include',  // ✅ Always send HttpOnly session cookie
  });

  // Auto-redirect on session expiry
  if (res.status === 401 && typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    if (!url.pathname.startsWith('/auth/')) {
      window.location.href = `/auth/login?redirect=${encodeURIComponent(url.pathname)}`;
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error((body as any).error ?? `HTTP ${res.status}`) as any;
    err.status = res.status;
    err.data = body;
    throw err;
  }

  // Handle 204 No Content
  if (res.status === 204) return {} as T;

  return res.json();
}

export const api = {
  get: <T = unknown>(path: string, opts?: RequestOptions) =>
    request<T>(path, { method: 'GET', ...opts }),

  post: <T = unknown>(path: string, body: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), ...opts }),

  patch: <T = unknown>(path: string, body: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body), ...opts }),

  delete: <T = unknown>(path: string, opts?: RequestOptions) =>
    request<T>(path, { method: 'DELETE', ...opts }),

  upload: <T = unknown>(path: string, formData: FormData, opts?: RequestOptions) => {
    const { tenantSlug, ...rest } = opts ?? {};
    const headers = new Headers();
    if (tenantSlug) headers.set('X-Tenant-Slug', tenantSlug);
    // Don't set Content-Type — browser sets multipart boundary automatically
    return request<T>(path, { method: 'POST', body: formData, headers, credentials: 'include', ...rest });
  },
};

// ─── Tenant UI state helpers (non-sensitive, safe in localStorage) ─────────

export function getTenantSlug(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem('tenant_slug');
}

export function setTenantData(data: {
  id: string;
  slug: string;
  role: string;
  plan: string;
  name?: string;
}) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem('tenant_id', data.id);
  localStorage.setItem('tenant_slug', data.slug);
  localStorage.setItem('tenant_role', data.role);
  localStorage.setItem('tenant_plan', data.plan);
  if (data.name) localStorage.setItem('tenant_name', data.name);
}

export function clearTenantData() {
  if (typeof localStorage === 'undefined') return;
  ['tenant_id', 'tenant_slug', 'tenant_role', 'tenant_plan', 'tenant_name', 'auth_user'].forEach(k =>
    localStorage.removeItem(k)
  );
}

export async function logout(apiUrl?: string): Promise<void> {
  const base = apiUrl ?? API_BASE;
  await fetch(`${base}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {});
  clearTenantData();
  window.location.href = '/auth/login';
}
