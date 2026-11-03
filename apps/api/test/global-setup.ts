import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Creates a FRESH database for the run, applies every migration with the
 * real migrate.sh, and creates login roles that are members of app_runtime /
 * app_worker — so RLS is genuinely enforced in the tests.
 * Needs a superuser connection: TEST_ADMIN_URL (default postgres://root:root@localhost/postgres).
 */
export default async function setup() {
  const adminUrl = process.env.TEST_ADMIN_URL ?? 'postgres://root:root@localhost/postgres';
  const dbName = process.env.TEST_DB_NAME ?? 'retail_test';
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  const dbUrl = u.toString();
  const migrate = fileURLToPath(new URL('../../../db/migrate.sh', import.meta.url));
  execFileSync(migrate, { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' });

  const db = postgres(dbUrl, { max: 1, onnotice: () => {} });
  await db.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retail_api_test') THEN
        CREATE ROLE retail_api_test LOGIN PASSWORD 'retail_api_test' IN ROLE app_runtime;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retail_worker_test') THEN
        CREATE ROLE retail_worker_test LOGIN PASSWORD 'retail_worker_test' IN ROLE app_worker;
      END IF;
    END $$;`);
  // A few shared UK catalogue rows (global reference data).
  await db`INSERT INTO catalog_products (gtin, name, brand, size_text, vat_code, is_pmp, pmp_price_pence, min_age)
           VALUES ('5010677015486', 'Walkers Ready Salted 32.5g', 'Walkers', '32.5g', 'S', true, 125, NULL),
                  ('5000213001134', 'Guinness Draught 4x440ml', 'Guinness', '4x440ml', 'S', false, NULL, 18)
           ON CONFLICT DO NOTHING`;
  await db.end();

  const api = new URL(dbUrl); api.username = 'retail_api_test'; api.password = 'retail_api_test';
  const worker = new URL(dbUrl); worker.username = 'retail_worker_test'; worker.password = 'retail_worker_test';
  process.env.TEST_DATABASE_URL = api.toString();
  process.env.TEST_WORKER_DATABASE_URL = worker.toString();
  process.env.TEST_SUPER_URL = dbUrl;
}
