import { describe, expect, it, vi } from 'vitest';
import { MemoryQueueStore, type PushFn, SyncQueue } from '../src/logic/queue.ts';

const sale = (id: string) => ({ id, receipt_number: `MAN1-1-${id}` });

describe('offline sync queue', () => {
  it('drops created and duplicate, keeps rejected with the server message', async () => {
    const q = new SyncQueue(new MemoryQueueStore());
    await q.enqueue('sale', sale('a'), 'MAN1-1-1', new Date(1));
    await q.enqueue('sale', sale('b'), 'MAN1-1-2', new Date(2));
    await q.enqueue('sale', sale('c'), 'MAN1-1-3', new Date(3));
    const push: PushFn = async () => ({
      sales: [{ id: 'a', status: 'created' }, { id: 'b', status: 'duplicate' },
        { id: 'c', status: 'rejected', error: 'forbidden', message: 'Line 1: age-restricted item sold without a passed Challenge 25 check' }],
      refunds: [],
    });
    const r = await q.flush(push);
    expect(r).toMatchObject({ sent: 3, accepted: 2, rejected: 1, failure: null });
    const left = await q.items();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: 'c', status: 'rejected', error: 'forbidden', attempts: 1 });
    expect(left[0]!.message).toMatch(/Challenge 25/);
    // Rejected items are not re-sent automatically...
    const spy = vi.fn(push);
    await q.flush(spy);
    expect(spy).not.toHaveBeenCalled();
    // ...until someone retries them.
    await q.retry('c');
    expect(await q.counts()).toEqual({ pending: 1, rejected: 0 });
  });

  it('keeps everything pending when the network fails, then sends on reconnect', async () => {
    const q = new SyncQueue(new MemoryQueueStore());
    await q.enqueue('sale', sale('a'), 'MAN1-1-1');
    const offline: PushFn = async () => { throw new TypeError('Failed to fetch'); };
    const r = await q.flush(offline);
    expect(r.failure).toBeInstanceOf(TypeError);
    expect((await q.items())[0]).toMatchObject({ status: 'pending', attempts: 1 });
    const online: PushFn = async (body) => ({ sales: (body.sales as { id: string }[]).map((s) => ({ id: s.id, status: 'created' as const })), refunds: [] });
    await q.flush(online);
    expect(await q.counts()).toEqual({ pending: 0, rejected: 0 });
  });

  it('sends sales and refunds oldest first, in batches, one flush at a time', async () => {
    const q = new SyncQueue(new MemoryQueueStore(), 2);
    await q.enqueue('refund', { id: 'r1' }, 'Refund', new Date(5));
    await q.enqueue('sale', sale('s1'), 'MAN1-1-1', new Date(1));
    await q.enqueue('sale', sale('s2'), 'MAN1-1-2', new Date(2));
    const bodies: { sales: unknown[]; refunds: unknown[] }[] = [];
    const push: PushFn = async (body) => {
      bodies.push(body);
      await new Promise((r) => setTimeout(r, 5));
      return {
        sales: (body.sales as { id: string }[]).map((s) => ({ id: s.id, status: 'created' as const })),
        refunds: (body.refunds as { id: string }[]).map((s) => ({ id: s.id, status: 'created' as const })),
      };
    };
    const [a, b] = await Promise.all([q.flush(push), q.flush(push)]);
    expect(a).toBe(b);                 // the second call joined the running flush
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ sales: [sale('s1'), sale('s2')], refunds: [] });
    expect(bodies[1]).toEqual({ sales: [], refunds: [{ id: 'r1' }] });
    expect(await q.counts()).toEqual({ pending: 0, rejected: 0 });
  });

  it('leaves an item pending if the server did not answer for it', async () => {
    const q = new SyncQueue(new MemoryQueueStore());
    await q.enqueue('sale', sale('a'), 'x');
    await q.flush(async () => ({ sales: [], refunds: [] }));
    expect((await q.items())[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('notifies listeners when the queue changes', async () => {
    const q = new SyncQueue(new MemoryQueueStore());
    const fn = vi.fn();
    const off = q.onChange(fn);
    await q.enqueue('sale', sale('a'), 'x');
    await q.discard('a');
    off();
    await q.enqueue('sale', sale('b'), 'y');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
