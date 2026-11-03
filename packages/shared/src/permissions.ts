/**
 * Permission and limit codes. These MUST match db/migrations/100_seed.sql —
 * add new codes there first (a test checks the two stay in sync).
 */
export const PERMISSIONS = [
  'pos.sell', 'pos.discount', 'pos.price_override', 'pos.void_line', 'pos.void_sale', 'pos.refund',
  'pos.refund_unreceipted', 'pos.no_sale', 'pos.paid_out', 'pos.open_till', 'pos.close_till', 'pos.z_report',
  'pos.training_mode', 'pos.approve',
  'products.view', 'products.edit', 'prices.edit', 'promotions.manage', 'labels.print',
  'stock.view', 'stock.adjust', 'stock.waste', 'stock.transfer', 'stock.count',
  'purchasing.request', 'purchasing.manage_list', 'purchasing.order', 'invoices.upload', 'invoices.approve',
  'suppliers.manage',
  'customers.view', 'customers.manage',
  'orders.handle',
  'time.clock', 'time.edit', 'time.approve', 'rota.manage', 'leave.request', 'leave.approve', 'payroll.export',
  'staff.view', 'staff.manage', 'staff.documents', 'roles.manage',
  'tasks.own', 'tasks.manage', 'quizzes.take', 'quizzes.manage', 'performance.view',
  'reports.sales', 'reports.stock', 'reports.financial', 'reports.staff', 'finance.expenses', 'finance.vat',
  'ai.ask', 'ai.insights',
  'compliance.manage', 'integrations.manage', 'branches.manage', 'settings.manage', 'billing.manage', 'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const LIMITS = [
  'pos.discount.max_percent',
  'pos.discount.max_amount_pence',
  'pos.price_override.max_percent',
  'pos.refund.max_amount_pence',
  'pos.paid_out.max_amount_pence',
  'pos.void_line.max_per_shift',
  'pos.no_sale.max_per_shift',
  'stock.adjust.max_qty',
] as const;
export type LimitCode = (typeof LIMITS)[number];

export type LimitDecision = 'self_authorised' | 'needs_approval';

/**
 * The one rule for numeric limits, used on the server and on the device:
 *  - the Owner role is unrestricted;
 *  - a NULL (undefined) limit means "not allowed without approval";
 *  - otherwise the value must be <= the limit.
 */
export function evaluateLimit(value: number, limit: number | null | undefined, isOwner: boolean): LimitDecision {
  if (isOwner) return 'self_authorised';
  if (limit === null || limit === undefined) return 'needs_approval';
  return value <= limit ? 'self_authorised' : 'needs_approval';
}

/**
 * Manual discounts are checked against two limits: the percent cap is
 * required; the amount cap, when set, applies on top of it.
 */
export function evaluateDiscount(
  percent: number,
  amountPence: number,
  limits: { maxPercent: number | null | undefined; maxAmountPence: number | null | undefined },
  isOwner: boolean,
): LimitDecision {
  if (isOwner) return 'self_authorised';
  if (evaluateLimit(percent, limits.maxPercent, false) === 'needs_approval') return 'needs_approval';
  if (limits.maxAmountPence !== null && limits.maxAmountPence !== undefined && amountPence > limits.maxAmountPence) {
    return 'needs_approval';
  }
  return 'self_authorised';
}
