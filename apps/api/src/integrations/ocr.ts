import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import type { Config } from '../config.ts';

/**
 * What OCR (or a human keying an invoice in by hand) produces. Amounts are
 * integer pence; quantity is what is printed (usually cases).
 */
export const ocrInvoiceSchema = z.object({
  supplier_name: z.string().nullable(),
  supplier_vat_number: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable().describe('YYYY-MM-DD'),
  due_date: z.string().nullable().describe('YYYY-MM-DD'),
  subtotal_pence: z.number().int().nullable(),
  vat_pence: z.number().int().nullable(),
  total_pence: z.number().int().nullable(),
  confidence: z.number().min(0).max(1).describe('How sure you are the whole extraction is right'),
  lines: z.array(z.object({
    raw_text: z.string().nullable(),
    supplier_code: z.string().nullable().describe("The wholesaler's own product code"),
    barcode: z.string().nullable().describe('EAN/UPC if printed'),
    description: z.string(),
    quantity: z.number().nullable().describe('Quantity as printed (cases or units)'),
    pack_size: z.number().nullable().describe('Units per case, e.g. 24 for "24x330ml"'),
    unit_cost_pence: z.number().int().nullable().describe('Cost per quantity unit as printed, ex VAT'),
    line_total_pence: z.number().int().nullable().describe('Line total ex VAT'),
    vat_code: z.enum(['S', 'R', 'Z', 'E']).nullable(),
    is_pmp: z.boolean().nullable().describe('Price-marked pack'),
    pmp_price_pence: z.number().int().nullable(),
    expiry_date: z.string().nullable().describe('YYYY-MM-DD if printed'),
  })),
});
export type OcrInvoice = z.infer<typeof ocrInvoiceSchema>;

export interface OcrInput {
  bytes: Buffer;
  mimeType: string;
  /** Wholesaler hint, e.g. 'booker' (global_suppliers.invoice_parser_key). */
  parserKey?: string | null;
}

export interface OcrOutput {
  provider: string;
  model: string;
  result: OcrInvoice;
  raw: unknown;
}

export interface OcrProvider {
  extract(input: OcrInput): Promise<OcrOutput>;
}

export class OcrRefusedError extends Error {}

const SYSTEM = `You read UK wholesale supplier invoices (Booker, Bestway, Costco, Parfetts, Unitas, Dhamecha and similar)
for an independent convenience shop. Extract the header and every product line exactly as printed.
- All money is integer pence (e.g. £12.34 -> 1234). Line costs are ex VAT.
- Supplier codes matter more than descriptions: copy them exactly.
- Use null for anything not printed; never guess barcodes or codes.
- UK VAT codes: S = 20%, R = 5%, Z = 0%, E = exempt. Most food is Z.
- PMP means price-marked pack; record the printed retail price when shown.
- Set confidence below 0.8 if the scan is blurry, cut off, or totals don't add up.`;

/** Claude vision OCR via the official SDK with schema-validated JSON output. */
export class ClaudeOcrProvider implements OcrProvider {
  private client: Anthropic;
  constructor(apiKey: string | undefined, private model: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async extract(input: OcrInput): Promise<OcrOutput> {
    const data = input.bytes.toString('base64');
    const fileBlock: Anthropic.Beta.BetaContentBlockParam = input.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: input.mimeType as 'image/jpeg' | 'image/png' | 'image/webp', data } };

    // Server-side fallback: if the primary model declines, the API re-runs the
    // request on a fallback model chosen by refusal category, in the same call.
    const response = await this.client.beta.messages.parse({
      model: this.model,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: 'medium', format: zodOutputFormat(ocrInvoiceSchema) },
      messages: [{
        role: 'user',
        content: [
          fileBlock,
          { type: 'text', text: `Extract this supplier invoice.${input.parserKey ? ` Wholesaler: ${input.parserKey}.` : ''}` },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') {
      throw new OcrRefusedError(`OCR declined: ${response.stop_details?.explanation ?? 'no reason given'}`);
    }
    if (response.stop_reason === 'max_tokens') throw new Error('Invoice too long: output was cut off');
    if (!response.parsed_output) throw new Error('OCR did not return valid JSON');
    return { provider: 'anthropic', model: response.model, result: response.parsed_output, raw: response.parsed_output };
  }
}

/** Deterministic provider for tests/dev: returns whatever was queued for a storage key. */
export class MockOcrProvider implements OcrProvider {
  readonly queued: OcrInvoice[] = [];
  async extract(): Promise<OcrOutput> {
    const next = this.queued.shift();
    if (!next) throw new Error('MockOcrProvider: nothing queued');
    return { provider: 'mock', model: 'mock', result: next, raw: next };
  }
}

export function createOcrProvider(config: Config): OcrProvider | undefined {
  return config.anthropicApiKey ? new ClaudeOcrProvider(config.anthropicApiKey, config.ocrModel) : undefined;
}
