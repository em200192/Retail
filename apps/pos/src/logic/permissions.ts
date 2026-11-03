import { evaluateDiscount, evaluateLimit, type LimitCode, type LimitDecision, type Permission } from '@retail/shared';
import type { StaffMember } from './catalog.ts';

/** Device-side permission checks against the synced effective permission set (the server re-checks on sync). */
export function can(staff: StaffMember | null | undefined, permission: Permission): boolean {
  return !!staff && staff.permissions.includes(permission);
}

export const isOwner = (staff: StaffMember | null | undefined) => staff?.role_key === 'owner';

export function limitOf(staff: StaffMember, code: LimitCode): number | null {
  const v = staff.limits[code];
  return v === undefined || v === null ? null : Number(v);
}

export function limitDecision(staff: StaffMember, code: LimitCode, value: number): LimitDecision {
  return evaluateLimit(value, limitOf(staff, code), isOwner(staff));
}

export function discountDecision(staff: StaffMember, percent: number, amountPence: number): LimitDecision {
  return evaluateDiscount(percent, amountPence, {
    maxPercent: limitOf(staff, 'pos.discount.max_percent'),
    maxAmountPence: limitOf(staff, 'pos.discount.max_amount_pence'),
  }, isOwner(staff));
}

/**
 * Who may approve `action` for `requester`: holds pos.approve + the action
 * permission, is not the requester, and (for amount/percent caps) is within
 * their OWN explicit cap. Mirrors verifyApprover() on the server.
 */
export function eligibleApprovers(staff: StaffMember[], requesterId: string, action: Permission, limit?: { code: LimitCode; value: number }): StaffMember[] {
  return staff.filter((s) => {
    if (s.id === requesterId || !can(s, 'pos.approve') || !can(s, action)) return false;
    if (limit && !limit.code.endsWith('.max_per_shift') && !isOwner(s)) {
      const cap = limitOf(s, limit.code);
      if (cap !== null && limit.value > cap) return false;
    }
    return true;
  });
}
