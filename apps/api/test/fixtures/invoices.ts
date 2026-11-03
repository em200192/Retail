/**
 * What a correct OCR reading of two real invoices looks like (transcribed
 * by hand from test/fixtures/*.jpg). Used to test everything after the OCR
 * call: supplier detection, VAT letters, PMP, voids, posting, learning.
 * Booker's VOID NOTE lines are kept as negative quantities on purpose, to
 * check the server nets them out even if the reader doesn't drop them.
 */
import type { OcrInvoice } from '../../src/integrations/ocr.ts';

type Row = [code: string, description: string, pack: number, qty: number, unitPence: number, totalPence: number, rrpPence: number | null, vat: 'S' | 'Z'];

const pmpFrom = (d: string): number | null => {
  const m = /PM\s?£?(\d+)(?:\.(\d{2}))?|£(\d+)(?:\.(\d{2}))?|\s(\d)\.(\d{2})$|\s(\d{2})P$/i.exec(d);
  if (!m) return null;
  if (m[1]) return m[2] ? Number(m[1]) * 100 + Number(m[2]) : Number(m[1]) >= 100 ? Number(m[1]) : Number(m[1]) * 100;
  if (m[3]) return Number(m[3]) * 100 + Number(m[4] ?? 0);
  if (m[5]) return Number(m[5]) * 100 + Number(m[6]);
  return Number(m[7]);
};

const lines = (rows: Row[]): OcrInvoice['lines'] => rows.map(([code, description, pack, qty, unit, total, rrp, vat]) => {
  const pmp = pmpFrom(description);
  return { raw_text: null, supplier_code: code, barcode: null, description, quantity: qty, pack_size: pack, unit_cost_pence: unit,
    line_total_pence: total, rrp_pence: rrp, vat_code: vat, is_pmp: pmp !== null, pmp_price_pence: pmp, expiry_date: null };
});

// Booker Liverpool, invoice 0203530, 23/02/26 (page 1). Booker letters: A = zero-rated, B = standard.
export const bookerInvoice: OcrInvoice = {
  supplier_name: 'Booker', supplier_vat_number: 'GB 226 4302 31', invoice_number: '0203530', invoice_date: '2026-02-23', due_date: null,
  subtotal_pence: null, vat_pence: null, total_pence: null, confidence: 0.86, // continues on page 2
  lines: lines([
    ['312473', 'Red Bull Edtion Cherry PM175', 12, 6, 1165, 6990, 175, 'S'],
    ['260957', 'Buxton Still', 24, 1, 759, 759, 89, 'S'],
    ['270719', 'San Pellegrino Sparkling', 12, 1, 655, 655, 115, 'S'],
    ['270691', 'Appletiser', 12, 1, 1275, 1275, null, 'S'],
    ['305184', 'Doritos Chilli H/wave PM135', 18, 1, 1699, 1699, 135, 'Z'],
    ['286783', 'ES Protein Choc Pnut PM150', 12, 1, 899, 899, 150, 'S'],
    ['286784', 'ES Protein Sltd Crml PM150', 12, 1, 899, 899, 150, 'S'],
    ['286784', 'ES Protein Sltd Crml PM150', 12, 1, 899, 899, 150, 'S'],
    ['286784', 'ES Protein Sltd Crml PM150', 12, -1, 899, -899, 150, 'S'],          // VOID NOTE
    ['308418', 'Grenade Creme Egg 45g', 18, 1, 2025, 2025, 250, 'S'],
    ['305784', 'Blossom Soft TT White', 1, 2, 650, 1299, null, 'S'],                 // BUY 1 GET 1 FREE folded in
    ['279882', 'Starbucks Frappuccino Mocha', 8, 1, 1229, 1229, 225, 'Z'],
    ['279883', 'Starbucks Frappuccino Coffee', 8, 1, 1229, 1229, 225, 'Z'],
    ['283817', 'Peperami Pizza Bun', 8, 1, 899, 899, 150, 'Z'],
    ['298045', 'FR Roast Chicken PM125', 6, 1, 589, 589, 125, 'Z'],
    ['298047', 'Frdge Raiders Southern PM125', 6, 2, 589, 1178, 125, 'Z'],
    ['258369', 'Lichfields Asst Muffins', 12, 1, 1299, 1299, null, 'Z'],
    ['572910', 'Tabasco Pepper Sauce Orig', 12, 1, 2379, 2379, null, 'Z'],
    ['240413', 'Lakeland Semi Skimmed 10ml', 1, 3, 1299, 3897, null, 'Z'],
    ['279485', 'CT DD Four Chese Pizza PM250', 1, 4, 189, 756, 250, 'Z'],
    ['299095', 'SM Pepperoni Pizza PM150', 1, 5, 119, 595, 150, 'Z'],
    ['293419', 'Twix White Choc Twin Biscuit', 20, 1, 1319, 1319, 105, 'S'],
    ['308974', 'Terrys Cholt Orng Mini PM150', 10, 1, 959, 959, 150, 'S'],
    ['281802', 'ES Mixed Free Range Eggs', 8, 1, 1008, 1008, 180, 'Z'],
    ['281802', 'ES Mixed Free Range Eggs', 8, -1, 1008, -1008, 180, 'Z'],            // VOID NOTE
    ['281803', 'ES Mixed Free Range Eggs', 1, 8, 126, 1008, 180, 'Z'],
    ['230256', 'Aluminium Red Handle 1.4m', 1, 1, 729, 729, null, 'S'],
    ['289772', 'CP Socket Mop 12PY', 1, 1, 749, 749, null, 'S'],
    ['247792', 'CP Std Wht 2Ply Centrefeed', 1, 1, 1299, 1299, null, 'S'],
  ]),
};

// Parfetts Anfield, invoice 30028525, 27/10/2026 (pages 1-2 of 4: 53 lines). Parfetts letter A = standard rate.
export const parfettsInvoice: OcrInvoice = {
  supplier_name: 'Parfetts', supplier_vat_number: '707 7417 28', invoice_number: '30028525', invoice_date: '2026-10-27', due_date: null,
  subtotal_pence: null, vat_pence: null, total_pence: null, confidence: 0.9,
  lines: lines([
    ['120076', 'TIZER £1', 12, 1, 689, 689, 100, 'S'], ['129228', 'RUB SPR PINE &PASS £1.29', 12, 1, 759, 759, 129, 'S'],
    ['129205', 'VIMTO RTD S/CAP £1.30', 12, 1, 879, 879, 130, 'S'], ['129206', 'VIMTO RTD NAS S/CAP 1.30', 12, 1, 879, 879, 130, 'S'],
    ['128340', 'FANTA LEMON £1.40', 12, 1, 875, 875, 140, 'S'], ['123720', 'LUC EN ORIGINAL PM £1.50', 24, 1, 1879, 1879, 150, 'S'],
    ['129140', 'LUC SP ORANGE PM £1.60', 12, 2, 1139, 2278, 160, 'S'], ['129141', 'LUCO SPORT RASP £1.60', 12, 1, 1139, 1139, 160, 'S'],
    ['127585', 'OASIS CITR PUNCH £1.40', 12, 1, 959, 959, 140, 'S'], ['127043', 'DR PEPPER £1.40', 12, 2, 825, 1650, 140, 'S'],
    ['128721', 'DR PEPPER ZRO CHRY £1.40', 12, 1, 825, 825, 140, 'S'], ['273541', 'COKE CHERRY 1.85', 12, 1, 1279, 1279, 185, 'S'],
    ['127007', 'DIET COKE £1.40', 12, 1, 899, 899, 140, 'S'], ['129296', 'RED BULL £1.75', 24, 1, 2199, 2199, 175, 'S'],
    ['274897', 'RB W/ED PAS & BER PM1.75', 12, 1, 1219, 1219, 175, 'S'], ['129302', 'RED BULL APRICOT £1.75', 12, 1, 1219, 1219, 175, 'S'],
    ['273534', 'COCA COLA £1.15', 24, 2, 1489, 2978, 115, 'S'], ['273526', 'COCA COLA CHERRY £1.15', 24, 1, 1415, 1415, 115, 'S'],
    ['122924', 'DIET COKE PM 90P', 24, 1, 1099, 1099, 90, 'S'], ['273535', 'COCA COLA ZERO 90P', 24, 1, 885, 885, 90, 'S'],
    ['123324', 'PEPS COLA MAX 85P', 24, 1, 999, 999, 85, 'S'], ['129198', 'VIMTO ORIGINAL 80P', 24, 1, 859, 859, 80, 'S'],
    ['129199', 'VIMTO NAS 80P', 24, 1, 859, 859, 80, 'S'], ['129391', 'BARR IRN BRU 85P', 24, 1, 979, 979, 85, 'S'],
    ['273540', 'SPRITE 90P', 24, 1, 929, 929, 90, 'S'], ['274269', 'FANTA TWIST PM £1.89', 6, 1, 659, 659, 189, 'S'],
    ['127274', 'DR PEPPER £2.15', 6, 1, 729, 729, 215, 'S'], ['103143', 'DIET COKE £1.99', 6, 1, 649, 649, 199, 'S'],
    ['128749', 'PEPSI COLA MAX PM £2.19', 6, 1, 839, 839, 219, 'S'], ['128750', 'PEPSI MAX CHERRY £2.19', 6, 1, 839, 839, 219, 'S'],
    ['274495', 'COCA COLA £2.85', 6, 1, 1089, 1089, 285, 'S'], ['127254', 'LUC SPORT ORANGE £2', 12, 1, 1189, 1189, 150, 'S'],
    ['121025', 'LUCO ENERGY ORIGINAL £2', 12, 1, 1399, 1399, 200, 'S'], ['127255', 'LUC SPORT RASPBERRY £2', 12, 1, 1189, 1189, 150, 'S'],
    ['274746', 'RB PEACH GB AL CAN £2.80', 12, 1, 2039, 2039, 280, 'S'], ['129351', 'RED BULL SPR CHRRY £2.80', 12, 2, 2039, 4078, 280, 'S'],
    ['273499', 'RB CITRUS ZEST £2.80', 12, 1, 2039, 2039, 280, 'S'], ['129354', 'RED BULL S/F ENERGY 2.65', 12, 2, 1909, 3818, 265, 'S'],
    ['129355', 'RED BULL ENERGY £2.80', 12, 1, 2049, 2049, 280, 'S'], ['129291', 'RED BULL S/F £2.15', 12, 1, 1249, 1249, 165, 'S'],
    ['129292', 'RED BULL £2.20', 24, 3, 2599, 7797, 175, 'S'], ['273547', 'MONSTER AUS LEMON £1.85', 12, 1, 969, 969, 185, 'S'],
    ['273826', 'MON EN THE DOCTOR 1.85', 12, 1, 969, 969, 185, 'S'], ['129414', 'MONSTER ULTRA GUAVA 1.75', 12, 3, 859, 2577, 125, 'S'],
    ['129416', 'MONSTER VIKIN BRRY 1.85', 12, 1, 969, 969, 185, 'S'], ['273291', 'MONSTER ENERGY £1.85', 12, 2, 969, 1938, 140, 'S'],
    ['129497', 'MONS ENERGY P PUNCH 1.85', 12, 2, 969, 1938, 140, 'S'], ['273552', 'MONSTER MAN LOCO PM1.85', 12, 1, 969, 969, 140, 'S'],
    ['273775', 'MONST ULT PEA KEEN £1.75', 12, 1, 859, 859, 175, 'S'], ['273470', 'MONSTER PUNCH MIXXD 1.85', 12, 2, 969, 1938, 185, 'S'],
    ['273479', 'MON ULT STRAW DREAM 1.75', 12, 2, 859, 1718, 125, 'S'], ['273543', 'MONSTER ULTRA 1.75', 12, 3, 859, 2577, 125, 'S'],
    ['273292', 'MONST NITRO SUP DRY 1.85', 12, 1, 969, 969, 185, 'S'],
  ]),
};
