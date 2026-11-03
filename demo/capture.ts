/**
 * Records real API responses from a seeded demo shop, for the offline
 * in-page demo (demo/backend.ts). Usage:
 *   API=http://localhost:3000 npx tsx demo/capture.ts demo/build/seed.txt > demo/build/fixtures.json
 */
import { readFileSync } from 'node:fs';
import { daysAgoUK, todayUK } from '@retail/shared';

const API = process.env.API ?? 'http://localhost:3000';
const seed = readFileSync(process.argv[2]!, 'utf8');
const pairingCode = seed.trim().split('\n').pop()!.trim();
const pairing = JSON.parse(Buffer.from(pairingCode, 'base64url').toString());

async function call(method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

const login = await call('POST', '/v1/auth/login', undefined, { email: 'owner@cornershop.demo', password: 'demo-password-1' });
const T = login.token as string;
const me = await call('GET', '/v1/me', T);
const b = me.branches[0].id as string;
const get = (p: string) => call('GET', p, T);
const today = todayUK(), d6 = daysAgoUK(6), d13 = daysAgoUK(13);

const products = await get('/v1/products?limit=500');
const productDetails: Record<string, unknown> = {};
const priceHistory: Record<string, unknown> = {};
for (const p of products) {
  productDetails[p.id] = await get(`/v1/products/${p.id}`);
  priceHistory[p.id] = await get(`/v1/products/${p.id}/prices`);
}
const sales: any[] = [];
for (let d = 13; d >= 0; d--) sales.push(...(await get(`/v1/sales?branch_id=${b}&from=${daysAgoUK(d)}&to=${daysAgoUK(d)}&limit=500`)));
const saleDetails: Record<string, unknown> = {};
for (const s of sales) saleDetails[s.id] = await get(`/v1/sales/${s.id}`);
const invoices = await get(`/v1/invoices?branch_id=${b}`);
const invoiceDetails: Record<string, unknown> = {};
for (const i of invoices) invoiceDetails[i.id] = await get(`/v1/invoices/${i.id}`);
const sessions = await get(`/v1/till-sessions?branch_id=${b}`);

const hello = await call('POST', '/v1/devices/hello', undefined, { device_id: pairing.device_id, device_secret: pairing.device_secret });
const sam = await call('POST', '/v1/auth/pin-login', undefined, { device_id: pairing.device_id, device_secret: pairing.device_secret, staff_id: hello.staff.find((s: any) => s.display_name === 'Sam').id, pin: '1111' });
const pull = await call('GET', '/v1/sync/pull', sam.token);

const q = new Date(); const qs = new Date(Date.UTC(q.getFullYear(), Math.floor(q.getMonth() / 3) * 3, 1)).toISOString().slice(0, 10);
const qe = new Date(Date.UTC(q.getFullYear(), Math.floor(q.getMonth() / 3) * 3 + 3, 0)).toISOString().slice(0, 10);

const out = {
  captured_on: today,
  pairing,
  pins: { Priya: '9999', Mo: '2222', Ava: '3333', Sam: '1111', Aisha: '1212', Tom: '4444' },
  me,
  hello,
  pull,
  products, productDetails, priceHistory,
  categories: await get('/v1/categories'),
  priceLevels: await get('/v1/price-levels'),
  stock: await get(`/v1/stock?branch_id=${b}`),
  expiring: await get(`/v1/stock/expiring?branch_id=${b}`),
  movements: await get(`/v1/stock/movements?branch_id=${b}&limit=200`),
  requests: await get(`/v1/purchase-requests?branch_id=${b}`),
  purchaseList: await get(`/v1/purchase-list?branch_id=${b}`),
  suppliers: await get('/v1/suppliers'),
  purchaseOrders: await get(`/v1/purchase-orders?branch_id=${b}`),
  invoices, invoiceDetails,
  sales, saleDetails,
  staffTiles: await get(`/v1/branches/${b}/staff-tiles`),
  tillSessions: sessions,
  zReports: Object.fromEntries(await Promise.all(sessions.map(async (s: any) => [s.id, await get(`/v1/till-sessions/${s.id}/z-report`)]))),
  daily: await get(`/v1/reports/daily?branch_id=${b}&from=${d13}&to=${today}`),
  top7: await get(`/v1/reports/top-products?branch_id=${b}&from=${d6}&to=${today}&limit=50`),
  top14: {
    revenue: await get(`/v1/reports/top-products?branch_id=${b}&from=${d13}&to=${today}&limit=50&order=revenue`),
    quantity: await get(`/v1/reports/top-products?branch_id=${b}&from=${d13}&to=${today}&limit=50&order=quantity`),
    margin: await get(`/v1/reports/top-products?branch_id=${b}&from=${d13}&to=${today}&limit=50&order=margin`),
  },
  staffActivity: await get(`/v1/reports/staff-activity?branch_id=${b}&from=${d13}&to=${today}`),
  vat: { period_start: qs, period_end: qe, data: await get(`/v1/reports/vat?from=${qs}&to=${qe}`) },
  staff: await get('/v1/staff'),
  roles: await get('/v1/roles'),
  permissions: await get('/v1/permissions'),
  branches: await get('/v1/branches'),
  devices: await get('/v1/devices'),
  expenseCategories: await get('/v1/expense-categories'),
};
process.stdout.write(JSON.stringify(out));
