import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apportion, formatReceiptNumber, lineAmount, uuidv7, vatFromGross } from '@retail/shared';
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
 * Builds a sale exactly the way the POS device does offline: UUIDv7 ids,
 * receipt number, shared rounding for line totals and VAT, basket discount
 * apportioned over the lines, payments that add up.
 */
export function buildSale(shop: Shop, staffId: string, lines: LineSpec[], opts: {
  tillSessionId?: string | null; isTraining?: boolean; basketDiscount?: number; method?: 'cash' | 'card';
  discounts?: unknown[]; approvals?: unknown[]; ageChecks?: unknown[]; customerId?: string; at?: Date;
} = {}) {
  const at = (opts.at ?? new Date()).toISOString();
  const rates: Record<string, number> = { S: 20, R: 5, Z: 0, E: 0 };
  const built = lines.map((l, i) => ({ l, i, base: lineAmount(l.unitPrice, l.qty) }));
  const live = built.filter((b) => !b.l.voidedBy);
  const basketShares = opts.basketDiscount ? apportion(opts.basketDiscount, live.map((b) => b.base - (b.l.lineDiscount ?? 0))) : [];
  let liveIdx = 0;
  const saleLines = built.map(({ l, i, base }) => {
    const share = l.voidedBy ? 0 : (basketShares[liveIdx++] ?? 0);
    const lineDiscount = (l.lineDiscount ?? 0) + share;
    const total = base - lineDiscount;
    const code = l.vatCode ?? 'S';
    return {
      id: uuidv7(), line_no: i + 1, product_id: l.productId ?? null, barcode_scanned: l.barcode ?? null,
      description: l.description ?? `Item ${i + 1}`, quantity: l.qty, unit_price_pence: l.unitPrice,
      is_pmp: l.pmpPrice !== undefined, pmp_price_pence: l.pmpPrice ?? null, line_discount_pence: lineDiscount,
      promotion_discount_pence: 0, line_total_pence: total, vat_code: code, vat_rate_percent: rates[code]!,
      vat_pence: vatFromGross(total, rates[code]!), age_check_id: l.ageCheckId ?? null,
      is_voided: !!l.voidedBy, voided_by: l.voidedBy ?? null, void_reason: l.voidedBy ? 'Customer changed mind' : null,
    };
  });
  const liveLines = saleLines.filter((l) => !l.is_voided);
  const subtotal = liveLines.reduce((a, l) => a + lineAmount(l.unit_price_pence, l.quantity), 0);
  const discount = liveLines.reduce((a, l) => a + l.line_discount_pence, 0);
  const total = liveLines.reduce((a, l) => a + l.line_total_pence, 0);
  const vat = liveLines.reduce((a, l) => a + l.vat_pence, 0);
  receiptSeq++;
  const method = opts.method ?? 'cash';
  return {
    id: uuidv7(), till_session_id: opts.tillSessionId ?? null, staff_id: staffId, customer_id: opts.customerId ?? null,
    receipt_number: formatReceiptNumber(shop.branchCode, shop.deviceNo, receiptSeq), status: 'completed' as const,
    is_training: opts.isTraining ?? false, subtotal_pence: subtotal, discount_pence: discount, total_pence: total, vat_pence: vat,
    started_at: at, completed_at: at,
    lines: saleLines,
    payments: total > 0 ? [{
      id: uuidv7(), method, amount_pence: total, tendered_pence: method === 'cash' ? Math.ceil(total / 500) * 500 : null,
      change_pence: method === 'cash' ? Math.ceil(total / 500) * 500 - total : null, status: 'approved', occurred_at: at,
      ...(method === 'card' ? { provider: 'dojo', provider_txn_ref: `txn-${receiptSeq}`, card_brand: 'visa', card_last4: '4242' } : {}),
    }] : [],
    discounts: opts.discounts ?? [],
    approvals: opts.approvals ?? [],
    age_checks: opts.ageChecks ?? [],
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
