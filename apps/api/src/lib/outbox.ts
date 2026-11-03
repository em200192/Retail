import type { Tx } from './db.ts';

/**
 * Transactional outbox: call inside the SAME transaction as the business
 * change. The worker publishes it later (FOR UPDATE SKIP LOCKED).
 */
export async function enqueueEvent(
  tx: Tx,
  tenantId: string,
  eventType: string,
  aggregateType: string,
  aggregateId: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx`
    INSERT INTO outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
    VALUES (${tenantId}, ${eventType}, ${aggregateType}, ${aggregateId}, ${tx.json(payload as never)})`;
}
