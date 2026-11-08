import { setAuthRateLimits } from './lib/ratelimit.ts';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { type Actor, loadActor } from './lib/authz.ts';
import { type TokenClaims, verifyToken } from './lib/crypto.ts';
import type { Db, TenantContext, Tx } from './lib/db.ts';
import { forbidden, fromPgError, HttpError, unauthorized } from './lib/errors.ts';
import type { OcrProvider } from './integrations/ocr.ts';
import type { FileStore } from './integrations/files.ts';
import { authRoutes } from './routes/auth.ts';
import { orgRoutes } from './routes/org.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { stockRoutes } from './routes/stock.ts';
import { posRoutes } from './routes/pos.ts';
import { syncRoutes } from './routes/sync.ts';
import { purchasingRoutes } from './routes/purchasing.ts';
import { reportRoutes } from './routes/reports.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: TokenClaims | null;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export interface Deps {
  db: Db;
  config: Config;
  ocr?: OcrProvider;
  files?: FileStore;
}

export interface RouteCtx {
  tx: Tx;
  actor: Actor;
  auth: TokenClaims;
  tenantId: string;
}

export function contextOf(req: FastifyRequest): TenantContext {
  const a = req.auth;
  if (!a) throw unauthorized();
  return { tenantId: a.tid, staffId: a.sid, userId: a.uid ?? null, deviceId: a.did ?? null };
}

/** Runs `fn` inside withTenant() with the caller's effective permissions loaded. */
export function tenantTx<T>(deps: Deps, req: FastifyRequest, fn: (c: RouteCtx) => Promise<T>): Promise<T> {
  const ctx = contextOf(req);
  return deps.db.withTenant(ctx, async (tx) => {
    const actor = await loadActor(tx, ctx.staffId!);
    return fn({ tx, actor, auth: req.auth!, tenantId: ctx.tenantId });
  });
}

export function requirePosToken(req: FastifyRequest): Required<Pick<TokenClaims, 'did' | 'bid'>> & TokenClaims {
  const a = req.auth;
  if (!a || a.kind !== 'pos' || !a.did || !a.bid) throw forbidden('This endpoint must be called from a registered POS device');
  return a as Required<Pick<TokenClaims, 'did' | 'bid'>> & TokenClaims;
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024, trustProxy: deps.config.trustProxy });
  setAuthRateLimits(deps.config.authRateLimits);

  await app.register(cors, { origin: deps.config.corsOrigins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS' || req.routeOptions.config?.public) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = token ? verifyToken(token, deps.config.jwtSecret) : null;
    if (!claims) throw unauthorized();
    req.auth = claims;
  });

  app.setErrorHandler((err, req, reply) => {
    const httpErr = err instanceof HttpError ? err : fromPgError(err);
    if (httpErr) {
      return reply.status(httpErr.statusCode).send({ error: httpErr.code, message: httpErr.message, details: httpErr.details });
    }
    const fe = err as { statusCode?: number; message: string; code?: string };
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: fe.code ?? 'bad_request', message: fe.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  app.get('/health', { config: { public: true } }, async () => {
    await deps.db.runtime`SELECT 1`;
    return { ok: true };
  });

  await app.register(async (r) => authRoutes(r, deps));
  await app.register(async (r) => orgRoutes(r, deps));
  await app.register(async (r) => catalogRoutes(r, deps));
  await app.register(async (r) => stockRoutes(r, deps));
  await app.register(async (r) => posRoutes(r, deps));
  await app.register(async (r) => syncRoutes(r, deps));
  await app.register(async (r) => purchasingRoutes(r, deps));
  await app.register(async (r) => reportRoutes(r, deps));
  return app;
}
