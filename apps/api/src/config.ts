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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET ?? (production ? undefined : 'dev-only-secret-change-me-dev-only-secret');
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be set (32+ chars)');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');
  return {
    databaseUrl,
    workerDatabaseUrl: env.WORKER_DATABASE_URL ?? databaseUrl,
    jwtSecret,
    userTokenTtlSeconds: Number(env.USER_TOKEN_TTL_SECONDS ?? 12 * 3600),
    posTokenTtlSeconds: Number(env.POS_TOKEN_TTL_SECONDS ?? 14 * 3600),
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    ocrModel: env.OCR_MODEL ?? 'claude-opus-5-5',
  };
}
