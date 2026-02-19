// apps/web/astro.config.mjs
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: {
      enabled: true,  // Enables Cloudflare bindings in dev
    },
    runtime: {
      mode: 'local',
    },
  }),
  integrations: [
    react(),
    tailwind({ applyBaseStyles: false }),
  ],
  vite: {
    ssr: {
      external: ['node:crypto', 'node:buffer'],
    },
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  },
  i18n: {
    defaultLocale: 'ar',
    locales: ['ar', 'en'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
