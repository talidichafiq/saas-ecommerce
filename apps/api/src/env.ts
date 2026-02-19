// apps/api/src/env.ts
export interface Env {
  // Cloudflare bindings
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE_LIMIT: KVNamespace;
  RATE_LIMITER_DO: DurableObjectNamespace;  // Strong-consistency rate limiting

  // Secrets (wrangler secret put)
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  ADMIN_SECRET: string;

  // Vars (wrangler.toml [vars])
  APP_URL: string;
  API_URL: string;
  CORS_ORIGINS: string;
}
