/**
 * The offline queue ("outbox") of sales and refunds waiting for
 * POST /v1/sync/push. Rules (CLAUDE.md, API conventions):
 *  - every record is sent with its device-generated id, so re-sending is safe;
 *  - `created` and `duplicate` mean the server has it -> drop it;
 *  - `rejected` -> keep it, with the server's message, for a manager to see;
 *  - a network failure leaves everything pending for the next attempt.
 */
export type QueueKind = 'sale' | 'refund';

export interface QueueItem {
  id: string;
  kind: QueueKind;
  payload: { id: string } & Record<string, unknown>;
  label: string;                 // receipt number / short description for the Sync issues screen
  createdAt: string;
  status: 'pending' | 'rejected';
  attempts: number;
  lastAttemptAt?: string | null;
  error?: string | null;
  message?: string | null;
  details?: unknown;
}

export interface QueueStore {
  all(): Promise<QueueItem[]>;
  put(item: QueueItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export type PushOutcome =
  | { id: string; status: 'created' | 'duplicate' }
  | { id: string; status: 'rejected'; error: string; message: string; details?: unknown };

export interface PushResponse { sales: PushOutcome[]; refunds: PushOutcome[] }
export type PushFn = (body: { sales: unknown[]; refunds: unknown[] }) => Promise<PushResponse>;

export interface FlushResult {
  sent: number;
  accepted: number;
  rejected: number;
  /** set when the push itself failed (offline, server down, token expired) */
  failure: unknown | null;
}

export class MemoryQueueStore implements QueueStore {
  private items = new Map<string, QueueItem>();
  async all() { return [...this.items.values()].map((i) => ({ ...i })); }
  async put(item: QueueItem) { this.items.set(item.id, { ...item }); }
  async remove(id: string) { this.items.delete(id); }
}

export class SyncQueue {
  private flushing: Promise<FlushResult> | null = null;
  private listeners = new Set<() => void>();

  constructor(private store: QueueStore, private batchSize = 100) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() { for (const l of this.listeners) l(); }

  async enqueue(kind: QueueKind, payload: QueueItem['payload'], label: string, now = new Date()): Promise<QueueItem> {
    const item: QueueItem = { id: payload.id, kind, payload, label, createdAt: now.toISOString(), status: 'pending', attempts: 0 };
    await this.store.put(item);
    this.emit();
    return item;
  }

  async items(): Promise<QueueItem[]> {
    return (await this.store.all()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async counts(): Promise<{ pending: number; rejected: number }> {
    const all = await this.store.all();
    return { pending: all.filter((i) => i.status === 'pending').length, rejected: all.filter((i) => i.status === 'rejected').length };
  }

  /** Sends everything pending (oldest first, in batches). Only one flush runs at a time. */
  flush(push: PushFn, now: () => Date = () => new Date()): Promise<FlushResult> {
    if (!this.flushing) {
      this.flushing = this.doFlush(push, now).finally(() => { this.flushing = null; });
    }
    return this.flushing;
  }

  private async doFlush(push: PushFn, now: () => Date): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, accepted: 0, rejected: 0, failure: null };
    const pending = (await this.items()).filter((i) => i.status === 'pending');
    for (let i = 0; i < pending.length; i += this.batchSize) {
      const batch = pending.slice(i, i + this.batchSize);
      // Sales go first in the request, so a refund of a sale in the same batch finds it.
      const sales = batch.filter((b) => b.kind === 'sale');
      const refunds = batch.filter((b) => b.kind === 'refund');
      const at = now().toISOString();
      let res: PushResponse;
      try {
        res = await push({ sales: sales.map((s) => s.payload), refunds: refunds.map((r) => r.payload) });
      } catch (err) {
        for (const item of batch) await this.store.put({ ...item, attempts: item.attempts + 1, lastAttemptAt: at });
        result.failure = err;
        this.emit();
        return result;
      }
      result.sent += batch.length;
      const outcomes = new Map<string, PushOutcome>();
      for (const o of [...(res.sales ?? []), ...(res.refunds ?? [])]) outcomes.set(o.id, o);
      for (const item of batch) {
        const o = outcomes.get(item.id);
        if (!o) {
          await this.store.put({ ...item, attempts: item.attempts + 1, lastAttemptAt: at });
        } else if (o.status === 'created' || o.status === 'duplicate') {
          await this.store.remove(item.id);
          result.accepted++;
        } else if (o.status === 'rejected') {
          await this.store.put({ ...item, status: 'rejected', attempts: item.attempts + 1, lastAttemptAt: at,
            error: o.error, message: o.message, details: o.details ?? null });
          result.rejected++;
        }
      }
      this.emit();
    }
    return result;
  }

  /** Put a rejected item back in the queue (e.g. after staff/permissions were fixed in the back office). */
  async retry(id: string): Promise<void> {
    const item = (await this.store.all()).find((i) => i.id === id);
    if (!item) return;
    await this.store.put({ ...item, status: 'pending', error: null, message: null, details: null });
    this.emit();
  }

  async discard(id: string): Promise<void> {
    await this.store.remove(id);
    this.emit();
  }
}
