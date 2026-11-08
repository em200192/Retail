'use client';
import useSWR, { type SWRConfiguration } from 'swr';
import { hardNavigate } from './nav';
import { t } from './i18n';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) { super(message); }
  get needsApproval() { return !!this.details?.needs_approval; }
}

/** Calls the API through the same-origin proxy (session cookie -> Bearer token). */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/proxy${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    hardNavigate(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch {
    // Not JSON (e.g. an HTML error page from a proxy): never crash the screen on it.
    throw new ApiError(res.ok ? 502 : res.status, t('Counter cannot reach the server right now. Try again in a minute.'));
  }
  if (!res.ok) throw new ApiError(res.status, t(friendly(data)), data?.details);
  return data as T;
}

function friendly(data: any): string {
  if (!data) return 'Something went wrong';
  if (Array.isArray(data.details) && data.details[0]?.message) {
    return data.details.map((d: any) => (d.path ? `${d.path}: ${d.message}` : d.message)).join(' · ');
  }
  return data.message ?? 'Something went wrong';
}

export function useApi<T = any>(path: string | null, config?: SWRConfiguration) {
  return useSWR<T>(path, (p: string) => api<T>(p), { revalidateOnFocus: true, keepPreviousData: true, ...config });
}

/**
 * Prepares an invoice file for upload: PDFs go as they are; photos (incl.
 * iPhone HEIC) are converted to JPEG and scaled so the long edge is at most
 * 2400px — sharp enough to read, small enough to upload on mobile data.
 */
export async function prepareInvoiceFile(file: File): Promise<{ name: string; mime: string; base64: string }> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    return { name: file.name, mime: 'application/pdf', base64: await fileToBase64(file) };
  }
  const bitmap = await loadImage(file);
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not read the photo'))), 'image/jpeg', 0.85));
  return { name: file.name.replace(/\.(heic|heif|png|webp|jpe?g)$/i, '') + '.jpg', mime: 'image/jpeg', base64: await fileToBase64(blob) };
}

async function loadImage(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions); } catch { /* fall back */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('This photo format can’t be read. Choose a JPG, PNG or PDF.');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Reads a File as base64 (no data: prefix). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
