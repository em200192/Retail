/**
 * Seeds a realistic demo shop for previewing the web back-office and the till.
 *   DATABASE_URL=... WORKER_DATABASE_URL=... npx tsx scripts/seed-demo.ts
 * Prints the owner login and a till pairing code.
 */
import { type BasketLine, buildSalePayload, daysAgoUK, formatReceiptNumber, priceBasket, uuidv7 } from '@retail/shared';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createPool, Db } from '../src/lib/db.ts';
import { refreshDailySummaries } from '../src/worker/jobs.ts';

const config = loadConfig();
const db = new Db(createPool(config.databaseUrl), createPool(config.workerDatabaseUrl));
const app = await buildApp({ db, config });
const apiUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${config.port}`;

async function call(method: string, url: string, token: string | null, payload?: unknown) {
  const r = await app.inject({ method: method as 'GET', url, payload: payload as never, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = r.body ? r.json() : undefined;
  if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
  return body;
}

// Deterministic pseudo-random so every seed looks the same.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;

const email = process.env.DEMO_EMAIL ?? 'owner@cornershop.demo';
const password = process.env.DEMO_PASSWORD ?? 'demo-password-1';
const signup = await call('POST', '/v1/auth/signup', null, {
  email, password, full_name: 'Priya Shah',
  business: { legal_name: 'Shah Convenience Ltd', trading_name: 'Shah\'s Corner Shop', vat_number: 'GB123456789' },
  branch: { code: 'MAN1', name: 'Wilmslow Road', address_line1: '214 Wilmslow Road', city: 'Manchester', postcode: 'M14 6LE' },
});
const T = signup.token as string;
const branchId = signup.branch_id as string;
await call('PUT', `/v1/staff/${signup.staff_id}/pin`, T, { pin: '9999' });

const roles = await call('GET', '/v1/roles', T) as { id: string; system_key: string }[];
const role = (k: string) => roles.find((r) => r.system_key === k)!.id;
const staff: Record<string, string> = {};
for (const [name, r, pin] of [['Sam', 'cashier', '1111'], ['Aisha', 'cashier', '1212'], ['Mo', 'manager', '2222'], ['Ava', 'supervisor', '3333'], ['Tom', 'stock', '4444']] as const) {
  staff[name] = (await call('POST', '/v1/staff', T, { first_name: name, last_name: 'Demo', role_id: role(r), branch_ids: [branchId], pin,
    email: `${name.toLowerCase()}@cornershop.demo`, employment_type: r === 'manager' ? 'full_time' : 'part_time' })).id;
}

const cats: Record<string, string> = {};
for (const [name, vat, age] of [['Dairy & chilled', 'Z', null], ['Bakery', 'Z', null], ['Soft drinks', 'S', null], ['Crisps & snacks', 'S', null],
  ['Confectionery', 'S', null], ['Grocery', 'Z', null], ['Beer, wine & spirits', 'S', 18], ['Household', 'S', null],
  ['Fruit & veg', 'Z', null], ['Health & beauty', 'S', null]] as const) {
  cats[name] = (await call('POST', '/v1/categories', T, { name, default_vat_code: vat, default_min_age: age })).id;
}

// name, category, barcode, retail pence, cost pence, pmp, reorder point, reorder qty, weekly demand
const catalogue: [string, string, string, number, number, number | null, number, number, number][] = [
  ['Cravendale Semi Skimmed Milk 2L', 'Dairy & chilled', '5000128940152', 195, 132, null, 10, 24, 60],
  ['Arla Whole Milk 1 Pint', 'Dairy & chilled', '5701215035108', 85, 52, null, 12, 24, 45],
  ['Lurpak Spreadable 500g', 'Dairy & chilled', '5740900400016', 499, 365, null, 4, 12, 9],
  ['Cathedral City Mature Cheddar 350g', 'Dairy & chilled', '5000295142893', 450, 310, null, 4, 12, 8],
  ['Free Range Eggs x6', 'Dairy & chilled', '5000000001015', 225, 150, null, 8, 30, 25],
  ['Müller Corner Strawberry 124g', 'Dairy & chilled', '4025500165604', 85, 48, null, 8, 24, 20],
  ['Warburtons Toastie White 800g', 'Bakery', '5010044000701', 155, 105, null, 8, 20, 40],
  ['Hovis Soft White Medium 800g', 'Bakery', '5010003000158', 145, 98, null, 6, 16, 25],
  ['Coca-Cola Original 500ml', 'Soft drinks', '5449000000996', 175, 72, 165, 24, 48, 80],
  ['Pepsi Max 500ml', 'Soft drinks', '4060800001979', 165, 64, 149, 18, 48, 50],
  ['Irn-Bru 330ml Can', 'Soft drinks', '5010102242500', 99, 41, null, 12, 24, 30],
  ['Lucozade Energy Orange 380ml', 'Soft drinks', '5000112548167', 165, 75, 150, 12, 24, 28],
  ['Red Bull Energy 250ml', 'Soft drinks', '9002490100070', 165, 95, null, 12, 24, 35],
  ['Highland Spring Still Water 500ml', 'Soft drinks', '5010156000507', 95, 30, null, 18, 24, 40],
  ['Walkers Ready Salted 32.5g', 'Crisps & snacks', '5000328657950', 125, 52, 125, 24, 32, 60],
  ['Walkers Cheese & Onion 32.5g', 'Crisps & snacks', '5000328657981', 125, 52, 125, 24, 32, 55],
  ['Pringles Original 165g', 'Crisps & snacks', '5053990101573', 325, 210, null, 6, 12, 12],
  ['Doritos Chilli Heatwave 150g', 'Crisps & snacks', '5000328479408', 249, 145, 225, 6, 12, 10],
  ['Cadbury Dairy Milk 45g', 'Confectionery', '7622210449283', 125, 62, null, 24, 48, 70],
  ['Mars Bar 51g', 'Confectionery', '5000159407236', 99, 48, null, 24, 48, 50],
  ['Kit Kat 4 Finger 41.5g', 'Confectionery', '7613035338855', 99, 46, null, 24, 48, 45],
  ['Haribo Starmix 140g', 'Confectionery', '5010013032262', 135, 74, 125, 12, 24, 22],
  ['Heinz Baked Beanz 415g', 'Grocery', '5000157024671', 150, 70, null, 12, 24, 30],
  ['Warburtons Crumpets x6', 'Bakery', '5010044004099', 125, 78, null, 6, 12, 18],
  ['PG Tips 80 Tea Bags', 'Grocery', '8722700055464', 349, 225, null, 4, 12, 10],
  ['Nescafé Original 100g', 'Grocery', '7613035460679', 450, 300, null, 4, 12, 8],
  ['Tilda Basmati Rice 500g', 'Grocery', '5011157630204', 249, 160, null, 4, 10, 7],
  ['Kingsmill 50/50 800g', 'Bakery', '5010003060701', 155, 102, null, 4, 12, 15],
  ['Stella Artois 4x440ml', 'Beer, wine & spirits', '5410228203582', 650, 430, null, 6, 12, 18],
  ['Carling 4x440ml', 'Beer, wine & spirits', '5000213006801', 600, 395, null, 6, 12, 15],
  ['Echo Falls Rosé 75cl', 'Beer, wine & spirits', '5010186008016', 650, 420, null, 4, 6, 9],
  ['Smirnoff Red Vodka 70cl', 'Beer, wine & spirits', '5410316000215', 1800, 1290, null, 3, 6, 4],
  ['Andrex Classic Clean Toilet Tissue 4 Roll', 'Household', '5029053001084', 375, 230, null, 6, 12, 10],
  ['Fairy Original Washing Up Liquid 433ml', 'Household', '8001090202007', 160, 95, 150, 4, 12, 7],
  ['Bananas (loose, each)', 'Fruit & veg', '2000000000015', 25, 12, null, 30, 60, 90],
  ['Paracetamol 500mg x16', 'Health & beauty', '5000158062641', 79, 22, null, 6, 12, 10],
];

const products: { id: string; name: string; price: number; cost: number; vat: 'S' | 'Z'; pmp: number | null; minAge: number | null; barcode: string; weekly: number }[] = [];
for (const [name, cat, barcode, price, cost, pmp, rp, rq, weekly] of catalogue) {
  const p = await call('POST', '/v1/products', T, {
    name, category_id: cats[cat], reorder_point: rp, reorder_qty: rq, price_pence: price,
    track_expiry: cat === 'Dairy & chilled' || cat === 'Bakery',
    barcodes: [{ barcode, is_primary: true, is_pmp: pmp !== null, pmp_price_pence: pmp }],
  });
  products.push({ id: p.id, name, price, cost, vat: p.vat_code, pmp, minAge: p.min_age, barcode, weekly });
}
// A trade price for the milk and a multibuy break on water.
const levels = await call('GET', '/v1/price-levels', T) as { id: string; code: string }[];
await call('POST', `/v1/products/${products[0]!.id}/prices`, T, { price_pence: 179, price_level_id: levels.find((l) => l.code === 'trade')!.id });
await call('POST', `/v1/products/${products[13]!.id}/prices`, T, { price_pence: 80, min_qty: 4 });

// Suppliers + supplier codes (the OCR learning table).
const booker = await call('POST', '/v1/suppliers', T, { name: 'Booker', order_method: 'portal', order_days: [2, 5], lead_time_days: 1, account_number: 'BK-448812' });
const bestway = await call('POST', '/v1/suppliers', T, { name: 'Bestway', email: 'orders@bestway.demo', order_method: 'email', order_days: [1, 4], lead_time_days: 2 });
for (const [i, p] of products.entries()) {
  const sup = i % 3 === 0 ? bestway : booker;
  const pack = p.weekly > 30 ? 24 : 12;
  await call('POST', `/v1/suppliers/${sup.id}/products`, T, { product_id: p.id, supplier_code: `${sup.name.slice(0, 2).toUpperCase()}${100000 + i * 37}`,
    pack_size: pack, case_cost_pence: p.cost * pack, is_preferred: true });
}

// Opening stock 3 weeks ago, with expiry dates for chilled & bakery.
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
await call('POST', '/v1/stock/receipts', T, { branch_id: branchId, opening: true, lines: products.map((p, i) => ({
  product_id: p.id, quantity: Math.round(p.weekly * 2.6) + 5, unit_cost_pence: p.cost,
  expiry_date: i < 8 || i === 23 || i === 27 ? inDays(i % 4 === 0 ? 1 : i % 4 === 1 ? 2 : 6) : null })) });

// Register the till.
const dev = await call('POST', '/v1/devices', T, { branch_id: branchId, name: 'Front till', kind: 'pos', platform: 'ipad', create_till: true });
const pinLogin = async (staffId: string, pin: string) => (await call('POST', '/v1/auth/pin-login', null, {
  device_id: dev.device_id, device_secret: dev.device_secret, staff_id: staffId, pin })).token as string;
const samToken = await pinLogin(staff.Sam!, '1111');

// Two weeks of sales (no till session for history; today's on an open session).
let seq = 0;
const rates = { S: 20, Z: 0 } as const;
const sessionToday = (await call('POST', '/v1/till-sessions', samToken, { id: uuidv7(), till_id: dev.till_id, opening_float_pence: 15000 })).id as string;
const sales = [];
const now = Date.now();
for (let day = 13; day >= 0; day--) {
  const weekend = [0, 6].includes(new Date(now - day * 86400000).getDay());
  const baskets = Math.round((weekend ? 95 : 70) * (0.85 + rnd() * 0.3)) / (day === 0 ? 2.2 : 1);
  for (let b = 0; b < baskets; b++) {
    const hour = 7 + Math.floor(rnd() * 14);
    const at = new Date(now - day * 86400000);
    at.setHours(hour, Math.floor(rnd() * 60), 0, 0);
    if (at.getTime() > now) at.setTime(now - Math.floor(rnd() * 3600000));
    const n = 1 + Math.floor(rnd() * 4);
    const lines: BasketLine[] = [];
    const checks = [];
    for (let k = 0; k < n; k++) {
      const p = products[Math.floor(Math.pow(rnd(), 1.6) * products.length)]!;
      const unit = p.pmp !== null ? Math.min(p.price, p.pmp) : p.price;
      let ageCheckId: string | null = null;
      if (p.minAge) {
        ageCheckId = uuidv7();
        checks.push({ id: ageCheckId, productId: p.id, staffId: staff.Sam!, requiredAge: 25, outcome: rnd() > 0.3 ? 'looked_over_25' as const : 'id_checked_ok' as const, occurredAt: at.toISOString() });
      }
      lines.push({ id: uuidv7(), productId: p.id, description: p.name, barcode: p.barcode, quantity: 1 + (rnd() > 0.85 ? 1 : 0),
        unitPricePence: unit, vatCode: p.vat, vatRatePercent: rates[p.vat], isPmp: p.pmp !== null, pmpPricePence: p.pmp, unitCostPence: p.cost, ageCheckId });
    }
    const total = priceBasket(lines).totals.total;
    const card = rnd() > 0.38;
    const tendered = card ? null : [500, 1000, 2000].find((x) => x >= total) ?? Math.ceil(total / 1000) * 1000;
    seq++;
    sales.push(buildSalePayload({
      id: uuidv7(at.getTime()), receiptNumber: formatReceiptNumber('MAN1', dev.device_no, seq), staffId: rnd() > 0.5 ? staff.Sam! : staff.Aisha!,
      tillSessionId: day === 0 ? sessionToday : null, lines, ageChecks: checks, startedAt: at.toISOString(), completedAt: at.toISOString(),
      payments: [{ id: uuidv7(), method: card ? 'card' : 'cash', amountPence: total, tenderedPence: tendered, changePence: tendered !== null ? tendered - total : null,
        occurredAt: at.toISOString(), ...(card ? { provider: 'dojo', providerTxnRef: `dj_${seq}`, cardBrand: pick(['visa', 'mastercard', 'amex']), cardLast4: String(1000 + Math.floor(rnd() * 8999)) } : {}) }],
    }));
  }
}
for (let i = 0; i < sales.length; i += 200) {
  const r = await call('POST', '/v1/sync/push', samToken, { sales: sales.slice(i, i + 200) });
  const rejected = r.sales.filter((s: any) => s.status === 'rejected');
  if (rejected.length) throw new Error(`seed sale rejected: ${JSON.stringify(rejected[0])}`);
}

// Some waste, a staff request or two, a no-sale, a supplier invoice awaiting review.
await call('POST', '/v1/stock/waste', T, { branch_id: branchId, product_id: products[5]!.id, quantity: 3, reason_code: 'expired' });
await call('POST', '/v1/stock/waste', T, { branch_id: branchId, product_id: products[6]!.id, quantity: 2, reason_code: 'damaged' });
const tomToken = await pinLogin(staff.Tom!, '4444');
await call('POST', '/v1/purchase-requests', samToken, { branch_id: branchId, product_id: products[12]!.id, quantity: 24, priority: 'urgent', note: 'Fridge is empty' });
await call('POST', '/v1/purchase-requests', tomToken, { branch_id: branchId, free_text: 'Oat milk 1L — customers keep asking', priority: 'normal' });
await call('POST', '/v1/purchase-list/generate', T, { branch_id: branchId });

const inv = await call('POST', '/v1/invoices', T, { branch_id: branchId, file_name: 'booker-INV-58213.pdf', mime_type: 'application/pdf',
  content_base64: Buffer.from('%PDF-1.4 demo invoice').toString('base64') }).catch(() => null);
if (inv) {
  await call('PUT', `/v1/invoices/${inv.id}/extraction`, T, {
    supplier_name: 'Booker Ltd', supplier_vat_number: null, invoice_number: 'INV-58213', invoice_date: daysAgoUK(1), due_date: null,
    subtotal_pence: 11880, vat_pence: 1584, total_pence: 13464, confidence: 0.93,
    lines: [
      { raw_text: null, supplier_code: 'BO100037', barcode: null, description: 'ARLA WHOLE MILK 1PT', quantity: 2, pack_size: 24, unit_cost_pence: 1248, line_total_pence: 2496, vat_code: 'Z', is_pmp: false, pmp_price_pence: null, expiry_date: inDays(7) },
      { raw_text: null, supplier_code: null, barcode: '5449000000996', description: 'COCA COLA PM £1.65 24X500ML', quantity: 2, pack_size: 24, unit_cost_pence: 1728, line_total_pence: 3456, vat_code: 'S', is_pmp: true, pmp_price_pence: 165, expiry_date: null },
      { raw_text: null, supplier_code: '889922', barcode: null, description: 'CADBURY DAIRY MILK 48X45G', quantity: 1, pack_size: 48, unit_cost_pence: 2976, line_total_pence: 2976, vat_code: 'S', is_pmp: false, pmp_price_pence: null, expiry_date: null },
      { raw_text: null, supplier_code: '771100', barcode: null, description: 'OATLY BARISTA 6X1L', quantity: 1, pack_size: 6, unit_cost_pence: 1080, line_total_pence: 1080, vat_code: 'Z', is_pmp: false, pmp_price_pence: null, expiry_date: null },
      { raw_text: null, supplier_code: null, barcode: null, description: 'DELIVERY CHARGE', quantity: 1, pack_size: null, unit_cost_pence: 1872, line_total_pence: 1872, vat_code: 'S', is_pmp: null, pmp_price_pence: null, expiry_date: null },
    ],
  });
}

for (let d = 0; d <= 13; d++) await refreshDailySummaries(db, { tenantId: signup.tenant_id, date: daysAgoUK(d) });

const pairing = Buffer.from(JSON.stringify({ api: apiUrl, device_id: dev.device_id, device_secret: dev.device_secret })).toString('base64url');
console.log(`
✓ Demo shop seeded: Shah's Corner Shop (${products.length} products, ${sales.length} sales over 14 days)

  Back-office login:  ${email}  /  ${password}
  Till staff PINs:    Priya (owner) 9999 · Mo (manager) 2222 · Ava (supervisor) 3333
                      Sam (cashier) 1111 · Aisha (cashier) 1212 · Tom (stock) 4444
  Till pairing code:
${pairing}
`);
await app.close();
await db.close();
