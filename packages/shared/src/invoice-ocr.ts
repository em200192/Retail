/**
 * Instructions for reading a UK wholesale supplier invoice into structured
 * data. Used by the API's Claude OCR provider and by the offline demo, so
 * both read invoices the same way.
 */
export const INVOICE_OCR_INSTRUCTIONS = `You read UK wholesale supplier invoices (Booker, Bestway, Costco, Parfetts, Unitas, Dhamecha,
Today, Hyperama and similar) for an independent convenience shop. Extract the header and every
product line exactly as printed.

Money and quantities
- All money is integer pence (£12.34 -> 1234). unit_cost_pence and line_total_pence are EX VAT,
  exactly as the invoice's price and value columns show.
- quantity = the quantity DELIVERED (use "QTY DEL" over "QTY ORD" when both are shown), as printed
  (usually cases).
- pack_size = units in one case: "12 250ml" -> 12, "24 500ml" -> 24, "12 x 1" -> 12, "6pk" -> 6
  (if one case is one 6-pack sold as one unit, use 1), "1 Sgl" -> 1.
- rrp_pence = the recommended retail price per single unit if printed (columns like RRP, STD RRP,
  "PM" price), else null.

Price-marked packs (PMP)
- A price mark in the description ("PM175", "PM135", "PM £1.50", "£1.29", "PM150", "1.85" at the end
  of a soft-drink name) means the pack is price-marked: set is_pmp = true and pmp_price_pence to that
  price (PM175 = 175, PM135 = 135, "£1.40" = 140). Otherwise is_pmp = false and pmp_price_pence = null.

VAT
- Return the UK VAT rate code for each line: S = 20%, R = 5%, Z = 0%, E = exempt.
- Wholesalers print their OWN letters. Map them using the invoice's VAT analysis/legend when shown.
  Known conventions: Booker: A = Z (0%), B = S (20%). Parfetts: A = S (20%) for most lines.
  If unsure, use the product type: most food, milk and bakery are Z; confectionery, crisps,
  soft drinks, alcohol, household and hot food are S.

Lines to drop or fold
- A "VOID NOTE" (or a line with a negative quantity) that cancels an earlier line: drop BOTH the
  cancelled line and its void, so the result lists what was actually supplied.
- A promotional discount (e.g. "BUY 1 GET 1 FREE" followed by a negative amount): reduce the
  affected line's line_total_pence by that amount and set unit_cost_pence = line_total_pence /
  quantity (rounded). Do not output the discount as its own line.
- Sub-total, carriage, deposit and summary rows are not product lines. A delivery or service charge
  may be listed as its own line with supplier_code null.

Other rules
- supplier_code = the wholesaler's own product code (first column, e.g. 312473, 120076), copied exactly.
- barcode only if an EAN/UPC barcode is printed for the line; never guess one.
- description exactly as printed (keep sizes like 500ML).
- Dates as YYYY-MM-DD (UK invoices print DD/MM/YY). Use null for anything not printed.
- If the image is only one page of a longer invoice, extract what is on it.
- confidence: 0 to 1, how sure you are the whole extraction is right; below 0.8 if blurry, cut off,
  or the lines don't add up to the printed goods total.`;

/** The JSON shape, described for prompts that cannot use a schema. */
export const INVOICE_OCR_JSON_SHAPE = `{
  "supplier_name": string|null, "supplier_vat_number": string|null, "invoice_number": string|null,
  "invoice_date": "YYYY-MM-DD"|null, "due_date": "YYYY-MM-DD"|null,
  "subtotal_pence": int|null, "vat_pence": int|null, "total_pence": int|null, "confidence": number,
  "lines": [{ "raw_text": string|null, "supplier_code": string|null, "barcode": string|null,
    "description": string, "quantity": number|null, "pack_size": number|null,
    "unit_cost_pence": int|null, "line_total_pence": int|null, "rrp_pence": int|null,
    "vat_code": "S"|"R"|"Z"|"E"|null, "is_pmp": boolean|null, "pmp_price_pence": int|null,
    "expiry_date": "YYYY-MM-DD"|null }]
}`;

/** Turns a wholesale description into a tidy product name: "COCA COLA PM £1.65 24X500ML" -> "Coca Cola 500ml". */
export function productNameFromInvoice(description: string): string {
  let s = description
    .replace(/\bPM\s?£?\d+(\.\d{2})?p?\b/gi, '')      // PM175, PM £1.50
    .replace(/£\d+(\.\d{2})?/g, '')                   // £1.29
    .replace(/\b\d+\s?[xX]\s?(?=\d)/g, '')            // 24X500ML -> 500ML
    .replace(/\s{2,}/g, ' ').trim();
  s = s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return s.replace(/\b(\d+)(Ml|L|Ltr|G|Kg|Cl|Pk)\b/g, (_m, n, u) => `${n}${u.toLowerCase()}`) || description;
}
