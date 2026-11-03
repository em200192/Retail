export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message: string, details?: unknown) => new HttpError(403, 'forbidden', message, details);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);
export const unprocessable = (message: string, details?: unknown) => new HttpError(422, 'unprocessable', message, details);

/** Maps PostgreSQL errors raised by constraints / RLS to HTTP errors. */
export function fromPgError(err: unknown): HttpError | null {
  const e = err as { code?: string; constraint_name?: string; message?: string; detail?: string };
  if (typeof e?.code !== 'string' || e.code.length !== 5) return null;
  const details = { pg_code: e.code, constraint: e.constraint_name, detail: e.detail };
  switch (e.code) {
    case '23505': return new HttpError(409, 'duplicate', 'A record with these details already exists', details);
    case '23503': return new HttpError(422, 'invalid_reference', 'Referenced record does not exist', details);
    case '23514': return new HttpError(422, 'check_violation', e.message ?? 'Constraint violated', details);
    case '23502': return new HttpError(422, 'missing_value', e.message ?? 'Required value missing', details);
    case '42501': return new HttpError(403, 'forbidden', e.message ?? 'Not allowed', details);
    case '22P02': return new HttpError(400, 'invalid_input', e.message ?? 'Invalid input', details);
    case 'P0001': return new HttpError(422, 'rejected', e.message ?? 'Rejected', details);
    default: return null;
  }
}
