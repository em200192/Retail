/** Thin HTTP client for the Counter API (/v1). Network failures become ApiError status 0. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
  get offline() { return this.status === 0; }
  get needsApproval() {
    return this.status === 403 && !!(this.details as { needs_approval?: boolean } | undefined)?.needs_approval;
  }
}

export interface ApiOptions { timeoutMs?: number; token?: string | null }

export async function apiRequest<T>(base: string, method: string, path: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'offline', 'No connection to the server');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch { /* not JSON */ }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return json as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.offline ? 'Offline — this needs a connection to the server.' : err.message;
  return err instanceof Error ? err.message : String(err);
}
