import { evaluateLimit, type LimitCode, type LimitDecision, type Permission } from '@retail/shared';
import { verifySecret } from './crypto.ts';
import type { Tx } from './db.ts';
import { forbidden, notFound } from './errors.ts';

export interface Actor {
  staffId: string;
  roleKey: string | null;
  isOwner: boolean;
  permissions: Set<string>;
  limits: Map<string, number>;
  branchIds: Set<string>;
}

/** Effective permissions + limits for a staff member (v_staff_permissions / v_staff_limits). */
export async function loadActor(tx: Tx, staffId: string): Promise<Actor> {
  const [staff] = await tx<{ id: string; system_key: string | null; status: string }[]>`
    SELECT s.id, r.system_key, s.status
    FROM staff s JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
    WHERE s.id = ${staffId}`;
  if (!staff || staff.status !== 'active') throw forbidden('Staff member is not active');
  const [perms, limits, branches] = await Promise.all([
    tx<{ permission_code: string }[]>`SELECT permission_code FROM v_staff_permissions WHERE staff_id = ${staffId}`,
    tx<{ limit_code: string; value: number }[]>`SELECT limit_code, value FROM v_staff_limits WHERE staff_id = ${staffId}`,
    tx<{ branch_id: string }[]>`SELECT branch_id FROM staff_branch_access WHERE staff_id = ${staffId}`,
  ]);
  return {
    staffId,
    roleKey: staff.system_key,
    isOwner: staff.system_key === 'owner',
    permissions: new Set(perms.map((p) => p.permission_code)),
    limits: new Map(limits.map((l) => [l.limit_code, l.value])),
    branchIds: new Set(branches.map((b) => b.branch_id)),
  };
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.permissions.has(permission);
}

export function requirePermission(actor: Actor, ...permissions: Permission[]): void {
  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length) throw forbidden(`Missing permission: ${missing.join(', ')}`, { missing });
}

export function requireAnyPermission(actor: Actor, ...permissions: Permission[]): void {
  if (!permissions.some((p) => actor.permissions.has(p))) {
    throw forbidden(`Requires one of: ${permissions.join(', ')}`, { required_any: permissions });
  }
}

/** Owners can work in every branch; everyone else needs a staff_branch_access row. */
export function hasBranchAccess(actor: Actor, branchId: string): boolean {
  return actor.isOwner || actor.branchIds.has(branchId);
}

export function requireBranchAccess(actor: Actor, branchId: string): void {
  if (!hasBranchAccess(actor, branchId)) throw forbidden('No access to this branch');
}

export async function requireBranchExists(tx: Tx, branchId: string): Promise<{ id: string; code: string; timezone: string }> {
  const [b] = await tx<{ id: string; code: string; timezone: string }[]>`
    SELECT id, code, timezone FROM branches WHERE id = ${branchId} AND is_active`;
  if (!b) throw notFound('Branch');
  return b;
}

export function limitDecision(actor: Actor, code: LimitCode, value: number): LimitDecision {
  return evaluateLimit(value, actor.limits.get(code), actor.isOwner);
}

export interface ApprovalInput {
  approver_staff_id: string;
  approver_pin: string;
}

/**
 * Checks a manager's PIN approval of someone else's action: right PIN, holds
 * pos.approve + the action permission, not approving themselves, and within
 * their OWN explicit cap. Returns the approver. Records nothing.
 */
export async function verifyApprover(
  tx: Tx,
  opts: { actor: Actor; actionCode: Permission; limitCode?: LimitCode; value: number; approval: ApprovalInput },
): Promise<Actor> {
  if (opts.approval.approver_staff_id === opts.actor.staffId) throw forbidden('You cannot approve your own action');
  const [approver] = await tx<{ pos_pin_hash: string | null }[]>`
    SELECT pos_pin_hash FROM staff WHERE id = ${opts.approval.approver_staff_id} AND status = 'active'`;
  if (!approver || !(await verifySecret(opts.approval.approver_pin, approver.pos_pin_hash))) {
    throw forbidden('Approval PIN is incorrect');
  }
  const approverActor = await loadActor(tx, opts.approval.approver_staff_id);
  requirePermission(approverActor, 'pos.approve', opts.actionCode);
  // An approver is bound by their OWN explicit cap (e.g. a manager's £200
  // refund limit). Per-shift counters describe the requester, not the approver.
  const approverCap = opts.limitCode && !opts.limitCode.endsWith('.max_per_shift')
    ? approverActor.limits.get(opts.limitCode) : undefined;
  if (!approverActor.isOwner && approverCap !== undefined && opts.value > approverCap) {
    throw forbidden('This is also over the approver\'s limit');
  }
  return approverActor;
}

/**
 * Online manager approval (back office / till while connected): verifies the
 * approver's PIN and that they may approve, records a pos_approvals row and
 * returns its id. Within-limit actions are recorded as 'self_authorised'.
 */
export async function authoriseAction(
  tx: Tx,
  opts: {
    actor: Actor;
    branchId: string;
    deviceId: string | null;
    actionCode: Permission;
    limitCode?: LimitCode;
    value: number;
    reason?: string | null;
    approval?: ApprovalInput | null;
    saleId?: string | null;
  },
): Promise<{ approvalId: string; outcome: 'self_authorised' | 'approved' }> {
  const decision = opts.limitCode ? limitDecision(opts.actor, opts.limitCode, opts.value) : 'self_authorised';
  let approvedBy: string | null = null;
  let outcome: 'self_authorised' | 'approved' = 'self_authorised';

  if (decision === 'needs_approval') {
    if (!opts.approval) {
      throw forbidden('Over your limit: a manager must approve this action', {
        needs_approval: true, action: opts.actionCode, limit: opts.limitCode, value: opts.value,
      });
    }
    const approverActor = await verifyApprover(tx, { ...opts, approval: opts.approval });
    approvedBy = approverActor.staffId;
    outcome = 'approved';
  }

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO pos_approvals (tenant_id, id, branch_id, device_id, sale_id, action_code, requested_by,
                               approved_by, outcome, value, reason)
    VALUES (app_current_tenant(), gen_random_uuid(), ${opts.branchId}, ${opts.deviceId}, ${opts.saleId ?? null},
            ${opts.actionCode}, ${opts.actor.staffId}, ${approvedBy}, ${outcome}, ${opts.value}, ${opts.reason ?? null})
    RETURNING id`;
  return { approvalId: row!.id, outcome };
}
