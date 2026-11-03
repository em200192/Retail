'use client';
import useSWR, { type SWRConfiguration } from 'swr';

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
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, friendly(data), data?.details);
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

/** Reads a File as base64 (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
