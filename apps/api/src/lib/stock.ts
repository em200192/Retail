import type { Tx } from './db.ts';
import { enqueueEvent } from './outbox.ts';

export type MovementType =
  | 'sale' | 'refund' | 'receipt' | 'adjustment' | 'waste' | 'transfer_out' | 'transfer_in'
  | 'stocktake' | 'online_order' | 'return_to_supplier' | 'opening';

export interface MovementInput {
  branchId: string;
  productId: string;
  quantity: number;               // signed, base units
  movementType: MovementType;
  reasonCode?: string | null;
  reason?: string | null;
  unitCostPence?: number | null;
  referenceType?: string | null;
  referenceId?: string | null;
  batchId?: string | null;
  staffId?: string | null;
  deviceId?: string | null;
  occurredAt?: Date | string | null;
}

/**
 * The ONLY way stock changes: append to the stock_movements ledger (a
 * trigger maintains stock_levels) and emit a stock.changed outbox event in
 * the same transaction so delivery platforms get the new level.
 */
export async function postMovements(tx: Tx, tenantId: string, movements: MovementInput[]): Promise<void> {
  const rows = movements
    .filter((m) => m.quantity !== 0)
    .map((m) => ({
      tenant_id: tenantId,
      branch_id: m.branchId,
      product_id: m.productId,
      quantity: Math.round(m.quantity * 1000) / 1000,
      movement_type: m.movementType,
      reason_code: m.reasonCode ?? null,
      reason: m.reason ?? null,
      unit_cost_pence: m.unitCostPence ?? null,
      reference_type: m.referenceType ?? null,
      reference_id: m.referenceId ?? null,
      batch_id: m.batchId ?? null,
      staff_id: m.staffId ?? null,
      device_id: m.deviceId ?? null,
      occurred_at: m.occurredAt ? new Date(m.occurredAt) : new Date(),
    }));
  if (rows.length === 0) return;
  await tx`INSERT INTO stock_movements ${tx(rows as never)}`;

  const byBranch = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byBranch.has(r.branch_id)) byBranch.set(r.branch_id, new Set());
    byBranch.get(r.branch_id)!.add(r.product_id);
  }
  for (const [branchId, products] of byBranch) {
    await enqueueEvent(tx, tenantId, 'stock.changed', 'branch', branchId, {
      branch_id: branchId, product_ids: [...products], movement_types: [...new Set(rows.map((r) => r.movement_type))],
    });
  }
}
