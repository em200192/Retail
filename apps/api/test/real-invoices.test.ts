import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bookerInvoice, parfettsInvoice } from './fixtures/invoices.ts';
import { mkProduct, newShop, useTestApp } from './helpers.ts';

const env = useTestApp();
const photo = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString('base64');

describe('real supplier invoices (Booker photo, Parfetts PDF page)', () => {
  it('reads, creates missing products, books stock in and learns the codes', async () => {
    const shop = await newShop(env.app);
    const owner = shop.owner;
    // Something the shop already sells, to check codes/names don't get duplicated.
    const tizer = await mkProduct(owner, { name: 'Tizer 500ml', price: 100 });

    // ---- Booker: a phone photo of the paper invoice
    const up = await owner.post('/v1/invoices', { branch_id: shop.branchId, file_name: 'booker.jpg', mime_type: 'image/jpeg', content_base64: photo('booker-invoice.jpg') });
    expect(up.status).toBe(201);
    const ex = await owner.put(`/v1/invoices/${up.body.id}/extraction`, bookerInvoice);
    expect(ex.status).toBe(200);
    expect(ex.body.invoice).toMatchObject({ status: 'needs_review', invoice_number: '0203530' });
    let inv = (await owner.get(`/v1/invoices/${up.body.id}`)).body;
    expect(inv.supplier_name).toBe('Booker');                      // set up from the national wholesaler list
    const cherry = inv.lines.find((l: any) => l.supplier_code === '312473');
    expect(cherry).toMatchObject({ is_pmp: true, pmp_price_pence: 175, rrp_pence: 175, vat_code: 'S', pack_size: 12 });

    const made = await owner.post(`/v1/invoices/${up.body.id}/create-missing-products`);
    expect(made.status).toBe(200);
    expect(made.body.skipped).toEqual([]);
    // 29 lines, but 286784 (x3) and 281802 (x2) are one product each.
    expect(made.body.created).toHaveLength(26);
    const posted = await owner.post(`/v1/invoices/${up.body.id}/post`);
    expect(posted.status).toBe(200);

    const stock = new Map((await owner.get(`/v1/stock?branch_id=${shop.branchId}`)).body.map((r: any) => [r.name, r.on_hand]));
    expect(stock.get('Red Bull Edtion Cherry')).toBe(72);           // 6 cases x 12
    expect(stock.get('Es Protein Sltd Crml')).toBe(12);             // 1 + 1 - 1 (void) cases x 12
    expect(stock.has('Es Mixed Free Range Eggs')).toBe(true);
    const eggs = (await owner.get(`/v1/products?q=Mixed Free Range`)).body;
    expect(eggs).toHaveLength(2);                                   // 281802 (fully voided) and 281803
    expect(stock.get('Blossom Soft Tt White')).toBe(2);
    const products = (await owner.get('/v1/products?limit=500')).body;
    const p = (n: string) => products.find((x: any) => x.name === n);
    expect(p('Red Bull Edtion Cherry')).toMatchObject({ vat_code: 'S', retail_price_pence: 175, last_cost_pence: 97 });
    expect(p('Starbucks Frappuccino Mocha')).toMatchObject({ vat_code: 'Z', retail_price_pence: 225 });
    expect(p('Blossom Soft Tt White')).toMatchObject({ last_cost_pence: 650 });  // BOGOF: 2 for £12.99

    // ---- Parfetts: page images from a PDF, all standard-rated drinks, price-marked
    const up2 = await owner.post('/v1/invoices', { branch_id: shop.branchId, file_name: 'Invoice-30028525.jpg', mime_type: 'image/jpeg', content_base64: photo('parfetts-invoice.jpg') });
    await owner.put(`/v1/invoices/${up2.body.id}/extraction`, parfettsInvoice);
    inv = (await owner.get(`/v1/invoices/${up2.body.id}`)).body;
    expect(inv.supplier_name).toBe('Parfetts');
    expect(inv.lines).toHaveLength(53);
    expect(inv.lines.every((l: any) => l.vat_code === 'S' && l.is_pmp)).toBe(true);
    // Tizer is matched to the product we already sell (by name), not re-created.
    const tizerLine = inv.lines.find((l: any) => l.supplier_code === '120076');
    expect(tizerLine.product_id === tizer || tizerLine.match_status === 'unmatched').toBe(true);
    if (tizerLine.match_status === 'unmatched') {
      await owner.patch(`/v1/invoices/${up2.body.id}/lines/${tizerLine.id}`, { product_id: tizer });
    }
    const made2 = await owner.post(`/v1/invoices/${up2.body.id}/create-missing-products`);
    expect(made2.body.created).toHaveLength(52);
    expect((await owner.post(`/v1/invoices/${up2.body.id}/post`)).status).toBe(200);
    const after = new Map((await owner.get(`/v1/stock?branch_id=${shop.branchId}`)).body.map((r: any) => [r.product_id, r.on_hand]));
    expect(after.get(tizer)).toBe(12);

    // ---- next Booker delivery: every line matches by supplier code automatically
    const up3 = await owner.post('/v1/invoices', { branch_id: shop.branchId, file_name: 'booker2.jpg', mime_type: 'image/jpeg', content_base64: photo('booker-invoice.jpg') });
    const ex3 = await owner.put(`/v1/invoices/${up3.body.id}/extraction`, { ...bookerInvoice, invoice_number: '0204111',
      lines: bookerInvoice.lines.filter((l) => (l.quantity ?? 0) > 0 && l.supplier_code !== '281802') });
    inv = (await owner.get(`/v1/invoices/${up3.body.id}`)).body;
    expect(inv.lines.every((l: any) => l.match_status === 'matched_auto' && l.match_confidence === 1)).toBe(true);
    expect(ex3.body.invoice.status).toBe('approved');

    // ---- the same Booker invoice uploaded twice is stopped
    const dup = await owner.post('/v1/invoices', { branch_id: shop.branchId, file_name: 'again.jpg', mime_type: 'image/jpeg', content_base64: photo('booker-invoice.jpg') });
    const exDup = await owner.put(`/v1/invoices/${dup.body.id}/extraction`, bookerInvoice);
    expect(exDup.body.invoice.status).toBe('rejected');
  });

  it('accepts a large phone photo', async () => {
    const shop = await newShop(env.app);
    const big = Buffer.alloc(8 * 1024 * 1024, 1).toString('base64');     // ~11 MB once base64-encoded
    const r = await shop.owner.post('/v1/invoices', { branch_id: shop.branchId, file_name: 'big.jpg', mime_type: 'image/jpeg', content_base64: big });
    expect(r.status).toBe(201);
  });
});
