// packages/db/src/seed.ts
// Run: pnpm db:seed
// Usage: node --experimental-vm-modules seed.js <D1_DATABASE_ID>

import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

const DB = process.env.D1_DB_NAME ?? 'saas-ecommerce-db';

function sql(query: string) {
  const escaped = query.replace(/'/g, "'\\''");
  execSync(`wrangler d1 execute ${DB} --command='${escaped}'`, { stdio: 'inherit' });
}

async function hashPassword(password: string): Promise<string> {
  // Simple bcrypt-like hash using Node crypto (in prod use bcrypt in Worker)
  const hash = createHash('sha256').update(password + 'seed-salt').digest('hex');
  return `$sha256$${hash}`;
}

async function main() {
  console.log('🌱 Seeding database...');

  const ownerId = randomUUID();
  const tenantId = randomUUID();
  const passwordHash = await hashPassword('password123');

  // Owner user
  sql(`INSERT OR IGNORE INTO users (id, email, password_hash, name, email_verified)
    VALUES ('${ownerId}', 'owner@demo.com', '${passwordHash}', 'Demo Owner', 1)`);

  // Demo tenant
  sql(`INSERT OR IGNORE INTO tenants (id, name, slug, plan, owner_user_id)
    VALUES ('${tenantId}', 'متجر التجربة', 'demo', 'pro', '${ownerId}')`);

  // Membership
  sql(`INSERT OR IGNORE INTO memberships (id, tenant_id, user_id, role)
    VALUES ('${randomUUID()}', '${tenantId}', '${ownerId}', 'owner')`);

  // Subscription
  sql(`INSERT OR IGNORE INTO subscriptions (id, tenant_id, status, plan)
    VALUES ('${randomUUID()}', '${tenantId}', 'active', 'pro')`);

  // Categories
  const catId1 = randomUUID();
  const catId2 = randomUUID();
  sql(`INSERT OR IGNORE INTO categories (id, tenant_id, name, slug)
    VALUES ('${catId1}', '${tenantId}', 'ملابس', 'clothes')`);
  sql(`INSERT OR IGNORE INTO categories (id, tenant_id, name, slug)
    VALUES ('${catId2}', '${tenantId}', 'إلكترونيات', 'electronics')`);

  // Products
  for (let i = 1; i <= 6; i++) {
    const productId = randomUUID();
    sql(`INSERT OR IGNORE INTO products (id, tenant_id, title, description, price, currency, stock, status)
      VALUES ('${productId}', '${tenantId}', 'منتج تجريبي ${i}', 'وصف المنتج التجريبي رقم ${i}', ${i * 99}, 'MAD', ${i * 10}, 'active')`);
    sql(`INSERT OR IGNORE INTO product_categories (id, tenant_id, product_id, category_id)
      VALUES ('${randomUUID()}', '${tenantId}', '${productId}', '${i % 2 === 0 ? catId1 : catId2}')`);
  }

  console.log('✅ Seed complete!');
  console.log('📧 Login: owner@demo.com / password123');
  console.log(`🏪 Store slug: demo`);
}

main().catch(console.error);
