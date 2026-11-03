/**
 * Real invoice reading for the offline demo: the page asks Claude (through
 * the artifact `sample` capability, on the viewer's own account and with
 * their permission) to read photos or PDF pages of a supplier invoice.
 * The same instructions the API's OCR provider uses.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { INVOICE_OCR_INSTRUCTIONS, INVOICE_OCR_JSON_SHAPE } from '@retail/shared';

export class ReadError extends Error {}

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new ReadError('Could not load the PDF reader'));
    document.head.appendChild(s);
  });
}

async function pdfJs(): Promise<any> {
  const w = window as any;
  if (!w.pdfjsLib) {
    await loadScript(PDFJS + 'pdf.min.js');
    // Run pdf.js on the main thread (workers from other hosts are blocked here).
    await loadScript(PDFJS + 'pdf.worker.min.js');
    w.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  }
  return w.pdfjsLib;
}

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new ReadError('Could not prepare the image'))), 'image/jpeg', 0.9));
}

/** A tall page is sent as top and bottom halves (with a small overlap) so small print stays readable. */
async function splitPage(src: CanvasImageSource & { width: number; height: number }): Promise<Blob[]> {
  const parts = src.height > src.width * 1.15 ? 2 : 1;
  const overlap = parts > 1 ? Math.round(src.height * 0.04) : 0;
  const sliceH = Math.ceil(src.height / parts);
  const out: Blob[] = [];
  for (let i = 0; i < parts; i++) {
    const y = Math.max(0, i * sliceH - overlap);
    const h = Math.min(src.height - y, sliceH + overlap * (i === 0 ? 1 : 2));
    const c = document.createElement('canvas');
    c.width = src.width; c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, y, src.width, h, 0, 0, src.width, h);
    out.push(await canvasToBlob(c));
  }
  return out;
}

/** Each page of the file as one or two JPEG blobs. */
export async function pagesFromFile(base64: string, mime: string, maxPages = 6): Promise<Blob[][]> {
  if (mime === 'application/pdf') {
    const lib = await pdfJs();
    const doc = await lib.getDocument({ data: b64ToBytes(base64) }).promise;
    const pages: Blob[][] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 1700 / base.width) });
      const c = document.createElement('canvas');
      c.width = Math.round(viewport.width); c.height = Math.round(viewport.height);
      await page.render({ canvasContext: c.getContext('2d')!, viewport }).promise;
      pages.push(await splitPage(c));
    }
    return pages;
  }
  const blob = new Blob([b64ToBytes(base64)], { type: mime });
  const bmp = await createImageBitmap(blob);
  return [await splitPage(bmp)];
}

const FRIENDLY: Record<string, string> = {
  not_granted: 'Reading invoices needs your permission to use Claude. Upload again and choose Allow.',
  sampling_disabled: 'Claude isn’t available on this account, so the invoice can’t be read here.',
  images_unavailable: 'This view can’t send images to Claude. Open the demo on claude.ai or in the Claude app.',
  image_rejected: 'That image couldn’t be used. Try a clearer photo, or a PDF.',
  rate_limited: 'Too many requests just now. Wait a minute and upload again.',
  refused: 'Claude couldn’t read this file. Try a clearer photo of the invoice.',
  invalid_json: 'The reading came back incomplete. Upload again, or try one page at a time.',
};

/** Reads every page with Claude and merges them into one invoice. */
export async function readInvoice(pages: Blob[][], onProgress: (msg: string, vars?: Record<string, string | number>) => void): Promise<any> {
  const claude = (window as any).claude;
  const sample = claude?.use ? await claude.use('sample') : null;
  if (!sample) throw new ReadError('Reading invoices needs Claude. Open this demo on claude.ai or in the Claude app.');
  const limits = await sample.limits().catch(() => null);
  if (!limits?.images) throw new ReadError(FRIENDLY.images_unavailable!);
  const merged: any = { lines: [] };
  for (const [i, imgs] of pages.entries()) {
    onProgress(pages.length > 1 ? 'Reading page {i} of {n}…' : 'Reading the invoice…', { i: i + 1, n: pages.length });
    const prompt = `${INVOICE_OCR_INSTRUCTIONS}

The attached image${imgs.length > 1 ? 's are the top and bottom halves' : ' is'} of page ${i + 1} of ${pages.length} of one supplier invoice.${imgs.length > 1 ? ' The halves overlap slightly: list each line only once.' : ''}${i > 0 ? ' Header fields may be null on later pages.' : ''}

Reply with only one JSON object of this shape:
${INVOICE_OCR_JSON_SHAPE}`;
    let part: any;
    try {
      part = await sample.json(prompt, { images: imgs.slice(0, limits.images.maxCount ?? imgs.length) });
    } catch (e: any) {
      throw new ReadError(FRIENDLY[e?.code] ?? 'Claude couldn’t read the invoice just now. Upload it again in a moment.');
    }
    if (!part || !Array.isArray(part.lines)) throw new ReadError(FRIENDLY.invalid_json!);
    for (const k of ['supplier_name', 'supplier_vat_number', 'invoice_number', 'invoice_date', 'due_date', 'subtotal_pence', 'vat_pence', 'total_pence']) {
      if (merged[k] == null && part[k] != null) merged[k] = part[k];
    }
    merged.confidence = Math.min(merged.confidence ?? 1, typeof part.confidence === 'number' ? part.confidence : 0.7);
    merged.lines.push(...part.lines);
  }
  return merged;
}

// ---------------------------------------------------------------- matching
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)) {
    const p = `  ${w} `;
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}
/** pg_trgm-style similarity (0..1), so the demo matches names like the database does. */
export function similarity(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  return both / (A.size + B.size - both);
}
