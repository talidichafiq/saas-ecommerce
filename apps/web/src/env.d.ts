/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
  readonly PUBLIC_APP_NAME: string;
  readonly PUBLIC_STRIPE_PUBLISHABLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type Runtime = import('@astrojs/cloudflare').Runtime<{
  DB: D1Database;
  R2: R2Bucket;
  KV_RATE_LIMIT: KVNamespace;
}>;

declare namespace App {
  interface Locals extends Runtime {}
}
