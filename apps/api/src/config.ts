export interface Config {
  /** Login role that is a member of app_runtime. RLS is always enforced for it. */
  databaseUrl: string;
  /** Login role that is a member of app_worker (bypasses RLS). Auth + background jobs only. */
  workerDatabaseUrl: string;
  jwtSecret: string;
  userTokenTtlSeconds: number;
  posTokenTtlSeconds: number;
  host: string;
  port: number;
  anthropicApiKey?: string;
  ocrModel: string;
  /** Browser origins allowed to call the API directly (the till's web build). Comma-separated. */
  corsOrigins: string[];
  /** Behind a load balancer: trust X-Forwarded-For (true, a hop count, or proxy addresses) so limits are per customer IP. */
  trustProxy: boolean | string | ((addr: string, hop: number) => boolean);
  /** Wrong-password / wrong-PIN lockouts. Only switched off in tests. */
  authRateLimits: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  // Blank values (e.g. an untouched .env.example line) count as unset.
  const jwtSecret = env.JWT_SECRET || (production ? undefined : 'dev-only-secret-change-me-dev-only-secret');
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be set (32+ chars)');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');
  return {
    databaseUrl,
    workerDatabaseUrl: env.WORKER_DATABASE_URL || databaseUrl,
    jwtSecret,
    userTokenTtlSeconds: Number(env.USER_TOKEN_TTL_SECONDS ?? 12 * 3600),
    posTokenTtlSeconds: Number(env.POS_TOKEN_TTL_SECONDS ?? 14 * 3600),
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    ocrModel: env.OCR_MODEL || 'claude-opus-5-5',
    trustProxy: env.TRUST_PROXY === 'true' ? true
      : env.TRUST_PROXY && /^\d+$/.test(env.TRUST_PROXY) ? ((_a: string, hop: number) => hop < Number(env.TRUST_PROXY))
      : env.TRUST_PROXY || false,
    authRateLimits: env.AUTH_RATE_LIMITS !== 'off',
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:8081,http://localhost:19006').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
