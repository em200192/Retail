import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, tenantTx } from '../app.ts';
import { requireBranchExists, requirePermission } from '../lib/authz.ts';
import { hashDeviceSecret, hashSecret, newDeviceSecret, safeEqualHex, signToken, verifySecret } from '../lib/crypto.ts';
import { conflict, forbidden, unauthorized } from '../lib/errors.ts';
import { parse, uuid } from '../lib/validate.ts';

const branchCode = z.string().regex(/^[A-Za-z0-9]{2,8}$/, '2-8 letters/digits (used in receipt numbers)');

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  full_name: z.string().min(1).max(200),
  business: z.object({
    legal_name: z.string().min(1),
    trading_name: z.string().optional(),
    vat_number: z.string().optional(),
    vat_registered: z.boolean().default(true),
  }),
  branch: z.object({
    code: branchCode,
    name: z.string().min(1),
    address_line1: z.string().optional(),
    city: z.string().optional(),
    postcode: z.string().optional(),
  }),
});

const loginSchema = z.object({ email: z.string().email(), password: z.string(), tenant_id: uuid.optional() });

const pinLoginSchema = z.object({
  device_id: uuid,
  device_secret: z.string().min(20),
  staff_id: uuid,
  pin: z.string().regex(/^\d{4,8}$/),
});

const deviceSchema = z.object({
  branch_id: uuid,
  name: z.string().min(1),
  kind: z.enum(['pos', 'handheld', 'self_checkout', 'label_printer', 'scale', 'customer_display', 'back_office']),
  platform: z.string().optional(),
  create_till: z.boolean().default(false),
});

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;

  // New shop owner signs up: user + tenant + trial subscription + default
  // roles/limits/price levels + first branch + owner staff, in ONE transaction.
  app.post('/v1/auth/signup', { config: { public: true } }, async (req, reply) => {
    const body = parse(signupSchema, req.body);
    const passwordHash = await hashSecret(body.password);
    const result = await db.asWorker(async (tx) => {
      const [existing] = await tx`SELECT 1 FROM users WHERE email = ${body.email}`;
      if (existing) throw conflict('An account with this email already exists');
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (email, full_name, password_hash) VALUES (${body.email}, ${body.full_name}, ${passwordHash})
        RETURNING id`;
      const [tenant] = await tx<{ id: string }[]>`
        INSERT INTO tenants (legal_name, trading_name, vat_number, vat_registered)
        VALUES (${body.business.legal_name}, ${body.business.trading_name ?? null}, ${body.business.vat_number ?? null},
                ${body.business.vat_registered})
        RETURNING id`;
      const tenantId = tenant!.id;
      await tx`SELECT set_config('app.user_id', ${user!.id}, true)`;
      await tx`SELECT create_tenant_defaults(${tenantId})`;
      await tx`
        INSERT INTO subscriptions (tenant_id, plan_id, status, trial_ends_at)
        VALUES (${tenantId}, 'starter', 'trialing', now() + interval '30 days')`;
      const [branch] = await tx<{ id: string }[]>`
        INSERT INTO branches (tenant_id, code, name, address_line1, city, postcode)
        VALUES (${tenantId}, ${body.branch.code.toUpperCase()}, ${body.branch.name}, ${body.branch.address_line1 ?? null},
                ${body.branch.city ?? null}, ${body.branch.postcode ?? null})
        RETURNING id`;
      const firstName = body.full_name.trim().split(/\s+/)[0]!;
      const lastName = body.full_name.trim().split(/\s+/).slice(1).join(' ') || null;
      const [staff] = await tx<{ id: string }[]>`
        INSERT INTO staff (tenant_id, user_id, role_id, first_name, last_name, display_name, email, employment_type, start_date)
        SELECT ${tenantId}, ${user!.id}, id, ${firstName}, ${lastName}, ${firstName}, ${body.email}, 'full_time', CURRENT_DATE
        FROM roles WHERE tenant_id = ${tenantId} AND system_key = 'owner'
        RETURNING id`;
      await tx`
        INSERT INTO staff_branch_access (tenant_id, staff_id, branch_id, is_primary)
        VALUES (${tenantId}, ${staff!.id}, ${branch!.id}, true)`;
      return { userId: user!.id, tenantId, staffId: staff!.id, branchId: branch!.id };
    });
    const token = signToken({ kind: 'user', tid: result.tenantId, sid: result.staffId, uid: result.userId },
      config.jwtSecret, config.userTokenTtlSeconds);
    return reply.status(201).send({
      token, user_id: result.userId, tenant_id: result.tenantId, staff_id: result.staffId, branch_id: result.branchId,
    });
  });

  // Back-office login. A person can work for several shops (tenants).
  app.post('/v1/auth/login', { config: { public: true } }, async (req) => {
    const body = parse(loginSchema, req.body);
    const found = await db.asWorker(async (tx) => {
      const [user] = await tx<{ id: string; password_hash: string | null }[]>`
        SELECT id, password_hash FROM users WHERE email = ${body.email}`;
      // Always run a hash comparison so response time doesn't reveal whether the email exists.
      const ok = await verifySecret(body.password, user?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      if (!user || !ok) return null;
      const memberships = await tx<{ tenant_id: string; staff_id: string; name: string }[]>`
        SELECT s.tenant_id, s.id AS staff_id, COALESCE(t.trading_name, t.legal_name) AS name
        FROM staff s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.user_id = ${user.id} AND s.status = 'active' AND t.status NOT IN ('suspended','cancelled')
        ORDER BY name`;
      await tx`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`;
      return { userId: user.id, memberships };
    });
    if (!found) throw unauthorized('Email or password is incorrect');
    const { memberships } = found;
    if (memberships.length === 0) throw forbidden('You do not have access to any shop');
    const chosen = body.tenant_id ? memberships.find((m) => m.tenant_id === body.tenant_id)
      : memberships.length === 1 ? memberships[0] : undefined;
    if (!chosen) {
      if (body.tenant_id) throw forbidden('You do not have access to this shop');
      return { requires_tenant_selection: true, tenants: memberships.map((m) => ({ tenant_id: m.tenant_id, name: m.name })) };
    }
    const token = signToken({ kind: 'user', tid: chosen.tenant_id, sid: chosen.staff_id, uid: found.userId },
      config.jwtSecret, config.userTokenTtlSeconds);
    return { token, tenant_id: chosen.tenant_id, staff_id: chosen.staff_id };
  });

  // Register a till / handheld. The secret is shown ONCE; the device stores it.
  app.post('/v1/devices', async (req, reply) => {
    const body = parse(deviceSchema, req.body);
    const secret = newDeviceSecret();
    const out = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'branches.manage');
      await requireBranchExists(tx, body.branch_id);
      const numbered = ['pos', 'self_checkout', 'handheld'].includes(body.kind);
      const [device] = await tx<{ id: string; device_no: number | null }[]>`
        INSERT INTO devices (tenant_id, branch_id, name, kind, platform, device_secret_hash, device_no)
        VALUES (${tenantId}, ${body.branch_id}, ${body.name}, ${body.kind}, ${body.platform ?? null},
                ${hashDeviceSecret(secret)},
                ${numbered ? tx`(SELECT COALESCE(max(device_no), 0) + 1 FROM devices WHERE branch_id = ${body.branch_id})` : null})
        RETURNING id, device_no`;
      let tillId: string | null = null;
      if (body.create_till) {
        const [till] = await tx<{ id: string }[]>`
          INSERT INTO tills (tenant_id, branch_id, device_id, name)
          VALUES (${tenantId}, ${body.branch_id}, ${device!.id}, ${body.name}) RETURNING id`;
        tillId = till!.id;
      }
      return { device_id: device!.id, device_no: device!.device_no, till_id: tillId };
    });
    return reply.status(201).send({ ...out, device_secret: secret });
  });

  // Till start-up, before anyone has logged in: the device proves itself with
  // its secret and gets the shop header (for receipts) and the staff tiles for
  // the PIN screen. Also used to validate a pairing code.
  app.post('/v1/devices/hello', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ device_id: uuid, device_secret: z.string().min(20) }), req.body);
    const out = await db.asWorker(async (tx) => {
      const [device] = await tx<{ id: string; tenant_id: string; branch_id: string; device_no: number | null; name: string;
        kind: string; device_secret_hash: string | null }[]>`
        SELECT d.id, d.tenant_id, d.branch_id, d.device_no, d.name, d.kind, d.device_secret_hash
        FROM devices d JOIN tenants t ON t.id = d.tenant_id
        WHERE d.id = ${body.device_id} AND d.is_active AND t.status NOT IN ('suspended','cancelled')`;
      if (!device?.device_secret_hash || !safeEqualHex(hashDeviceSecret(body.device_secret), device.device_secret_hash)) return null;
      const tid = device.tenant_id;
      const [tenant] = await tx`
        SELECT id, legal_name, trading_name, vat_number, vat_registered FROM tenants WHERE id = ${tid}`;
      const [branch] = await tx`
        SELECT id, code, name, address_line1, address_line2, city, postcode, phone, timezone
        FROM branches WHERE tenant_id = ${tid} AND id = ${device.branch_id}`;
      const [till] = await tx`
        SELECT t.id, t.name,
               (SELECT s.id FROM till_sessions s WHERE s.tenant_id = t.tenant_id AND s.till_id = t.id AND s.status = 'open') AS open_session_id
        FROM tills t WHERE t.tenant_id = ${tid} AND t.device_id = ${device.id} AND t.is_active
        ORDER BY t.created_at LIMIT 1`;
      const staff = await tx`
        SELECT s.id, s.display_name, r.system_key AS role_key, r.name AS role_name
        FROM staff s JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
        WHERE s.tenant_id = ${tid} AND s.status = 'active' AND s.pos_pin_hash IS NOT NULL
          AND (r.system_key = 'owner' OR EXISTS (SELECT 1 FROM staff_branch_access a
               WHERE a.tenant_id = s.tenant_id AND a.staff_id = s.id AND a.branch_id = ${device.branch_id}))
        ORDER BY s.display_name`;
      // A re-paired / reinstalled till carries on numbering after its last synced receipt.
      const [seq] = await tx<{ last_seq: number }[]>`
        SELECT COALESCE(max(split_part(receipt_number, '-', 3)::bigint), 0) AS last_seq
        FROM sales WHERE tenant_id = ${tid} AND device_id = ${device.id} AND receipt_number ~ '^[A-Za-z0-9]+-[0-9]+-[0-9]+$'`;
      await tx`UPDATE devices SET last_seen_at = now() WHERE tenant_id = ${tid} AND id = ${device.id}`;
      return {
        tenant, branch, till: till ?? null, staff,
        device: { id: device.id, device_no: device.device_no, name: device.name, kind: device.kind, last_receipt_seq: seq?.last_seq ?? 0 },
      };
    });
    if (!out) throw unauthorized('Device is not registered');
    return out;
  });

  // Staff log in on a registered device with their PIN.
  app.post('/v1/auth/pin-login', { config: { public: true } }, async (req) => {
    const body = parse(pinLoginSchema, req.body);
    const result = await db.asWorker(async (tx) => {
      const [device] = await tx<{ tenant_id: string; branch_id: string; device_secret_hash: string | null }[]>`
        SELECT d.tenant_id, d.branch_id, d.device_secret_hash
        FROM devices d JOIN tenants t ON t.id = d.tenant_id
        WHERE d.id = ${body.device_id} AND d.is_active AND t.status NOT IN ('suspended','cancelled')`;
      if (!device?.device_secret_hash || !safeEqualHex(hashDeviceSecret(body.device_secret), device.device_secret_hash)) {
        return { error: 'device' as const };
      }
      const [staff] = await tx<{ pos_pin_hash: string | null; system_key: string | null; has_access: boolean }[]>`
        SELECT s.pos_pin_hash, r.system_key,
               EXISTS (SELECT 1 FROM staff_branch_access a
                       WHERE a.tenant_id = s.tenant_id AND a.staff_id = s.id AND a.branch_id = ${device.branch_id}) AS has_access
        FROM staff s JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
        WHERE s.tenant_id = ${device.tenant_id} AND s.id = ${body.staff_id} AND s.status = 'active'`;
      if (!staff || !(await verifySecret(body.pin, staff.pos_pin_hash))) return { error: 'pin' as const };
      if (!staff.has_access && staff.system_key !== 'owner') return { error: 'branch' as const };
      await tx`UPDATE devices SET last_seen_at = now() WHERE tenant_id = ${device.tenant_id} AND id = ${body.device_id}`;
      return { tenantId: device.tenant_id, branchId: device.branch_id };
    });
    if ('error' in result) {
      if (result.error === 'device') throw unauthorized('Device is not registered');
      if (result.error === 'branch') throw forbidden('You are not set up to work at this branch');
      throw unauthorized('PIN is incorrect');
    }
    const token = signToken({ kind: 'pos', tid: result.tenantId, sid: body.staff_id, did: body.device_id, bid: result.branchId },
      config.jwtSecret, config.posTokenTtlSeconds);
    return { token, tenant_id: result.tenantId, branch_id: result.branchId, staff_id: body.staff_id };
  });

  // Who am I + effective permissions & limits (also synced to devices for offline checks).
  app.get('/v1/me', async (req) =>
    tenantTx(deps, req, async ({ tx, actor, tenantId, auth }) => {
      const [staff] = await tx`
        SELECT s.id, s.first_name, s.last_name, s.display_name, s.email, s.locale, r.id AS role_id, r.name AS role_name,
               r.system_key AS role_key
        FROM staff s JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id WHERE s.id = ${actor.staffId}`;
      const [tenant] = await tx`
        SELECT id, legal_name, trading_name, vat_registered, vat_number, status, timezone FROM tenants WHERE id = ${tenantId}`;
      const branches = await tx`SELECT id, code, name FROM branches WHERE is_active ORDER BY name`;
      return {
        staff,
        tenant,
        session: { kind: auth.kind, device_id: auth.did ?? null, branch_id: auth.bid ?? null },
        branches: branches.filter((b) => actor.isOwner || actor.branchIds.has(b.id as string)),
        permissions: [...actor.permissions].sort(),
        limits: Object.fromEntries(actor.limits),
      };
    }));
}
