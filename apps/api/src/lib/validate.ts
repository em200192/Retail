import { z } from 'zod';
import { badRequest } from './errors.ts';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest('Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const pence = z.number().int().nonnegative();
export const positivePence = z.number().int().positive();
export const quantity = z.number().finite().refine((n) => Math.round(n * 1000) === n * 1000 || Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, 'max 3 decimals');
export const vatCode = z.enum(['S', 'R', 'Z', 'E']);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const isoDateTime = z.string().datetime({ offset: true });
export const idParam = z.object({ id: uuid });
