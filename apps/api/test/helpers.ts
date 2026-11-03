import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BasketLine, buildSalePayload, formatReceiptNumber, priceBasket, uuidv7 } from '@retail/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { LocalFileStore } from '../src/integrations/files.ts';
import { MockOcrProvider } from '../src/integrations/ocr.ts';
import { createPool, Db } from '../src/lib/db.ts';

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  ocr: MockOcrProvider;
  files: LocalFileStore;
}

export function useTestApp(): TestEnv {
  const env = {} as TestEnv;
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL,
      WORKER_DATABASE_URL: process.env.TEST_WORKER_DATABASE_URL, JWT_SECRET: 'test-secret-test-secret-test-secret-123' });
    env.db = new Db(createPool(config.databaseUrl, { max: 5 }), createPool(config.workerDatabaseUrl, { max: 3 }));
    env.ocr = new MockOcrProvider();
    env.files = new LocalFileStore(mkdtempSync(join(tmpdir(), 'retail-files-')));
    env.app = await buildApp({ db: env.db, config, ocr: env.ocr, files: env.files });
  });
  afterAll(async () => {
    await env.app?.close();
    await env.db?.close();
  });
  return env;
}

export interface Res<T = any> { status: number; body: T }

export function client(app: FastifyInstance, token?: string) {
  const call = async <T = any>(method: string, url: string, payload?: unknown): Promise<Res<T>> => {
    const r = await app.inject({
      method: method as 'GET', url, payload: payload as never,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: r.statusCode, body: r.body ? r.json() : undefined } as Res<T>;
  };
  return {
    get: <T = any>(url: string) => call<T>('GET', url),
    post: <T = any>(url: string, body?: unknown) => call<T>('POST', url, body ?? {}),
    put: <T = any>(url: string, body?: unknown) => call<T>('PUT', url, body ?? {}),
    patch: <T = any>(url: string, body?: unknown) => call<T>('PATCH', url, body ?? {}),
    delete: <T = any>(url: string) => call<T>('DELETE', url),
  };
}
export type Client = ReturnType<typeof client>;

let shopSeq = 0;
/** A fresh shop: owner account, first branch, a registered till and staff with PINs. */
export async function newShop(app: FastifyInstance, opts: { code?: string } = {}) {
  shopSeq++;
  const tag = `${Date.now().toString(36)}${shopSeq}`;
  const code = opts.code ?? `S${shopSeq}`;
  const signup = await client(app).post('/v1/auth/signup', {
    email: `owner-${tag}@example.com`, password: 'correct horse battery', full_name: 'Priya Shah',
    business: { legal_name: `Shop ${tag} Ltd`, trading_name: `Corner Shop ${tag}` },
    branch: { code, name: 'High Street', postcode: 'M1 1AA' },
  });
  if (signup.status !== 201) throw new Error(`signup failed: ${JSON.stringify(signup.body)}`);
  const owner = client(app, signup.body.token);
  const { branch_id: branchId, staff_id: ownerId, tenant_id: tenantId } = signup.body;
  await owner.put(`/v1/staff/${ownerId}/pin`, { pin: '9999' });

  const roles = (await owner.get('/v1/roles')).body as { id: string; system_key: string }[];
  const roleId = (k: string) => roles.find((r) => r.system_key === k)!.id;
  const mkStaff = async (name: string, role: string, pin: string) => {
    const r = await owner.post('/v1/staff', { first_name: name, role_id: roleId(role), branch_ids: [branchId], pin, email: `${name.toLowerCase()}-${tag}@example.com` });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.id as string;
  };
  const cashierId = await mkStaff('Sam', 'cashier', '1111');
  const managerId = await mkStaff('Mo', 'manager', '2222');
  const supervisorId = await mkStaff('Ava', 'supervisor', '3333');

  const dev = await owner.post('/v1/devices', { branch_id: branchId, name: 'Till 1', kind: 'pos', platform: 'ipad', create_till: true });
  if (dev.status !== 201) throw new Error(JSON.stringify(dev.body));
  const pinLogin = async (staffId: string, pin: string) => {
    const r = await client(app).post('/v1/auth/pin-login', { device_id: dev.body.device_id, device_secret: dev.body.device_secret, staff_id: staffId, pin });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    return client(app, r.body.token);
  };
  return {
    tenantId, branchId, branchCode: code, ownerId, cashierId, managerId, supervisorId, roleId,
    owner, ownerToken: signup.body.token as string, email: `owner-${tag}@example.com`,
    deviceId: dev.body.device_id as string, deviceNo: dev.body.device_no as number, deviceSecret: dev.body.device_secret as string,
    tillId: dev.body.till_id as string,
    pinLogin,
  };
}
export type Shop = Awaited<ReturnType<typeof newShop>>;

let receiptSeq = 0;

export interface LineSpec {
  productId?: string; description?: string; qty: number; unitPrice: number; vatCode?: 'S' | 'R' | 'Z' | 'E';
  barcode?: string; pmpPrice?: number; lineDiscount?: number; voidedBy?: string; ageCheckId?: string;
}

/**
 * Builds a sale exactly the way the POS device does offline — through the
 * shared buildSalePayload() the till app uses.
 */
export function buildSale(shop: Shop, staffId: string, lines: LineSpec[], opts: {
  tillSessionId?: string | null; isTraining?: boolean; basketDiscount?: number; method?: 'cash' | 'card';
  discounts?: any[]; approvals?: any[]; ageChecks?: any[]; customerId?: string; at?: Date;
} = {}) {
  const at = (opts.at ?? new Date()).toISOString();
  const rates: Record<string, number> = { S: 20, R: 5, Z: 0, E: 0 };
  const basket: BasketLine[] = lines.map((l, i) => ({
    id: uuidv7(), productId: l.productId ?? null, description: l.description ?? `Item ${i + 1}`, barcode: l.barcode ?? null,
    quantity: l.qty, unitPricePence: l.unitPrice, vatCode: l.vatCode ?? 'S', vatRatePercent: rates[l.vatCode ?? 'S']!,
    isPmp: l.pmpPrice !== undefined, pmpPricePence: l.pmpPrice ?? null, lineDiscountPence: l.lineDiscount ?? 0,
    ageCheckId: l.ageCheckId ?? null, voidedBy: l.voidedBy ?? null, voidReason: l.voidedBy ? 'Customer changed mind' : null,
  }));
  const total = priceBasket(basket, opts.basketDiscount ?? 0).totals.total;
  receiptSeq++;
  const method = opts.method ?? 'cash';
  const tendered = method === 'cash' ? Math.ceil(total / 500) * 500 : null;
  const payload = buildSalePayload({
    id: uuidv7(), receiptNumber: formatReceiptNumber(shop.branchCode, shop.deviceNo, receiptSeq), staffId,
    tillSessionId: opts.tillSessionId ?? null, customerId: opts.customerId ?? null, isTraining: opts.isTraining ?? false,
    lines: basket, basketDiscountPence: opts.basketDiscount ?? 0, startedAt: at, completedAt: at,
    payments: total > 0 ? [{
      id: uuidv7(), method, amountPence: total, tenderedPence: tendered, changePence: tendered !== null ? tendered - total : null,
      occurredAt: at,
      ...(method === 'card' ? { provider: 'dojo', providerTxnRef: `txn-${receiptSeq}`, cardBrand: 'visa', cardLast4: '4242' } : {}),
    }] : [],
  });
  // Tests pass raw wire-format discounts/approvals/age checks to probe the server rules.
  return {
    ...payload,
    discounts: (opts.discounts ?? []) as any[],
    approvals: (opts.approvals ?? []) as any[],
    age_checks: (opts.ageChecks ?? []) as any[],
  };
}

/** Creates a product with a retail price and barcode; returns its id. */
export async function mkProduct(c: Client, p: { name: string; price: number; barcode?: string; vat?: 'S' | 'R' | 'Z' | 'E';
  min_age?: number; reorder_point?: number; reorder_qty?: number; pmp?: number; track_expiry?: boolean; extraBarcodes?: unknown[] }) {
  const r = await c.post('/v1/products', {
    name: p.name, vat_code: p.vat ?? 'S', min_age: p.min_age, reorder_point: p.reorder_point, reorder_qty: p.reorder_qty,
    track_expiry: p.track_expiry, price_pence: p.price,
    barcodes: [
      ...(p.barcode ? [{ barcode: p.barcode, is_primary: true, is_pmp: p.pmp !== undefined, pmp_price_pence: p.pmp ?? null }] : []),
      ...(p.extraBarcodes ?? []),
    ],
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.id as string;
}
