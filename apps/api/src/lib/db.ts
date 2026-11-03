import postgres from 'postgres';

// postgres.js' TransactionSql type loses its call signatures in some
// versions; we use the plain Sql type for both pools and transactions.
export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = Sql;

export function createPool(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    transform: { undefined: null },
    types: {
      // bigint pence -> JS number (safe up to £90 trillion)
      bigint: {
        to: 20, from: [20], serialize: (x: number | bigint) => x.toString(),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new RangeError(`int8 out of JS safe range: ${x}`);
          return n;
        },
      },
      // numeric quantities / rates -> JS number (numeric(14,3), numeric(5,2))
      numeric: { to: 1700, from: [1700], serialize: (x: number | string) => String(x), parse: (x: string) => Number(x) },
      // keep DATE columns as 'YYYY-MM-DD' strings (no timezone shifting)
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  }) as unknown as Sql;
}

export interface TenantContext {
  tenantId: string;
  staffId: string | null;
  userId: string | null;
  deviceId: string | null;
}

/**
 * The ONLY way the API touches tenant data. Every transaction starts by
 * switching to app_runtime (so RLS applies even if the login role were a
 * superuser) and setting the transaction-local request context.
 * tenantId always comes from the verified token, never the request body.
 */
export class Db {
  constructor(
    readonly runtime: Sql,
    readonly worker: Sql,
  ) {}

  async withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return (await this.runtime.begin(async (tx) => {
      const t = tx as unknown as Tx;
      await t`
        SELECT set_config('role', 'app_runtime', true),
               set_config('app.tenant_id', ${ctx.tenantId}, true),
               set_config('app.staff_id',  ${ctx.staffId ?? ''}, true),
               set_config('app.user_id',   ${ctx.userId ?? ''}, true),
               set_config('app.device_id', ${ctx.deviceId ?? ''}, true)`;
      return fn(t);
    })) as T;
  }

  /**
   * Bypasses RLS. Only for auth (password hashes, device secrets), signup and
   * background jobs. Callers MUST filter tenant_id explicitly.
   */
  async asWorker<T>(fn: (tx: Tx) => Promise<T>, ctx?: Partial<TenantContext>): Promise<T> {
    return (await this.worker.begin(async (tx) => {
      const t = tx as unknown as Tx;
      await t`
        SELECT set_config('role', 'app_worker', true),
               set_config('app.tenant_id', ${ctx?.tenantId ?? ''}, true),
               set_config('app.staff_id',  ${ctx?.staffId ?? ''}, true),
               set_config('app.user_id',   ${ctx?.userId ?? ''}, true),
               set_config('app.device_id', ${ctx?.deviceId ?? ''}, true)`;
      return fn(t);
    })) as T;
  }

  async close(): Promise<void> {
    await Promise.all([this.runtime.end({ timeout: 5 }), this.worker === this.runtime ? null : this.worker.end({ timeout: 5 })]);
  }
}
