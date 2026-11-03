import { LIMITS, PERMISSIONS } from '@retail/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Deps, tenantTx } from '../app.ts';
import { requireBranchAccess, requireBranchExists, requirePermission } from '../lib/authz.ts';
import { hashSecret } from '../lib/crypto.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { idParam, isoDate, parse, uuid } from '../lib/validate.ts';

const permissionCode = z.enum(PERMISSIONS);
const limitCode = z.enum(LIMITS);

const branchSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9]{2,8}$/),
  name: z.string().min(1),
  address_line1: z.string().nullish(),
  address_line2: z.string().nullish(),
  city: z.string().nullish(),
  postcode: z.string().nullish(),
  phone: z.string().nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  geofence_m: z.number().int().positive().optional(),
  timezone: z.string().optional(),
});

const staffSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().nullish(),
  display_name: z.string().min(1).optional(),
  role_id: uuid,
  email: z.string().email().nullish(),
  phone: z.string().nullish(),
  employee_number: z.string().nullish(),
  employment_type: z.enum(['full_time', 'part_time', 'zero_hours', 'casual', 'contractor']).optional(),
  date_of_birth: isoDate.nullish(),
  start_date: isoDate.nullish(),
  branch_ids: z.array(uuid).min(1),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
});

export async function orgRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------ branches
  app.get('/v1/branches', async (req) =>
    tenantTx(deps, req, async ({ tx, actor }) => {
      const rows = await tx`SELECT * FROM branches ORDER BY name`;
      return rows.filter((b) => actor.isOwner || actor.branchIds.has(b.id as string));
    }));

  app.post('/v1/branches', async (req, reply) => {
    const body = parse(branchSchema, req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'branches.manage');
      const [b] = await tx`
        INSERT INTO branches ${tx({ ...body, code: body.code.toUpperCase(), tenant_id: tenantId } as never)} RETURNING *`;
      if (!actor.isOwner) {
        await tx`INSERT INTO staff_branch_access (tenant_id, staff_id, branch_id) VALUES (${tenantId}, ${actor.staffId}, ${b!.id})`;
      }
      return b;
    });
    return reply.status(201).send(row);
  });

  app.patch('/v1/branches/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(branchSchema.partial().extend({ is_active: z.boolean().optional() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'branches.manage');
      requireBranchAccess(actor, id);
      if (body.code) body.code = body.code.toUpperCase();
      const [b] = await tx`UPDATE branches SET ${tx(body as never)} WHERE id = ${id} RETURNING *`;
      if (!b) throw notFound('Branch');
      return b;
    });
  });

  // ------------------------------------------------------------ devices & tills
  app.get('/v1/devices', async (req) =>
    tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'branches.manage');
      return tx`
        SELECT id, branch_id, name, kind, platform, app_version, device_no, last_seen_at, last_sync_at, is_active, registered_at
        FROM devices ORDER BY branch_id, device_no NULLS LAST, name`;
    }));

  app.patch('/v1/devices/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ name: z.string().min(1).optional(), is_active: z.boolean().optional() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'branches.manage');
      const [d] = await tx`UPDATE devices SET ${tx(body as never)} WHERE id = ${id}
                            RETURNING id, branch_id, name, kind, device_no, is_active`;
      if (!d) throw notFound('Device');
      return d;
    });
  });

  app.get('/v1/tills', async (req) => {
    const q = parse(z.object({ branch_id: uuid.optional() }), req.query);
    return tenantTx(deps, req, async ({ tx }) => tx`
      SELECT t.*, (SELECT s.id FROM till_sessions s WHERE s.tenant_id = t.tenant_id AND s.till_id = t.id AND s.status = 'open')
                  AS open_session_id
      FROM tills t WHERE ${q.branch_id ? tx`t.branch_id = ${q.branch_id}` : tx`true`} ORDER BY t.name`);
  });

  app.post('/v1/tills', async (req, reply) => {
    const body = parse(z.object({ branch_id: uuid, name: z.string().min(1), device_id: uuid.nullish() }), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'branches.manage');
      await requireBranchExists(tx, body.branch_id);
      const [t] = await tx`INSERT INTO tills ${tx({ ...body, tenant_id: tenantId } as never)} RETURNING *`;
      return t;
    });
    return reply.status(201).send(row);
  });

  // ------------------------------------------------------------ roles
  app.get('/v1/permissions', async (req) =>
    tenantTx(deps, req, async ({ tx }) => ({
      permissions: await tx`SELECT * FROM permissions ORDER BY module, code`,
      limits: await tx`SELECT * FROM limit_definitions ORDER BY code`,
    })));

  app.get('/v1/roles', async (req) =>
    tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'staff.view');
      return tx`
        SELECT r.id, r.name, r.system_key, r.description,
               COALESCE((SELECT array_agg(permission_code ORDER BY permission_code) FROM role_permissions rp
                         WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id), '{}') AS permissions,
               COALESCE((SELECT jsonb_object_agg(limit_code, value) FROM role_limits rl
                         WHERE rl.tenant_id = r.tenant_id AND rl.role_id = r.id), '{}') AS limits
        FROM roles r ORDER BY r.name`;
    }));

  app.post('/v1/roles', async (req, reply) => {
    const body = parse(z.object({ name: z.string().min(1), description: z.string().nullish(),
      permissions: z.array(permissionCode).default([]) }), req.body);
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'roles.manage');
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO roles (tenant_id, name, description) VALUES (${tenantId}, ${body.name}, ${body.description ?? null})
        RETURNING *`;
      if (body.permissions.length) {
        await tx`INSERT INTO role_permissions ${tx(body.permissions.map((p) =>
          ({ tenant_id: tenantId, role_id: r!.id, permission_code: p })) as never)}`;
      }
      return r;
    });
    return reply.status(201).send(row);
  });

  app.put('/v1/roles/:id/permissions', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ permissions: z.array(permissionCode) }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'roles.manage');
      const [role] = await tx<{ system_key: string | null }[]>`SELECT system_key FROM roles WHERE id = ${id}`;
      if (!role) throw notFound('Role');
      if (role.system_key === 'owner') throw forbidden('The Owner role always has every permission');
      await tx`DELETE FROM role_permissions WHERE role_id = ${id}`;
      const perms = [...new Set(body.permissions)];
      if (perms.length) {
        await tx`INSERT INTO role_permissions ${tx(perms.map((p) => ({ tenant_id: tenantId, role_id: id, permission_code: p })) as never)}`;
      }
      return { role_id: id, permissions: perms.sort() };
    });
  });

  // value null = remove the limit (= "needs approval" for that action)
  app.put('/v1/roles/:id/limits', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ limits: z.record(limitCode, z.number().nonnegative().nullable()) }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'roles.manage');
      const [role] = await tx`SELECT 1 FROM roles WHERE id = ${id}`;
      if (!role) throw notFound('Role');
      for (const [code, value] of Object.entries(body.limits)) {
        if (value === null) await tx`DELETE FROM role_limits WHERE role_id = ${id} AND limit_code = ${code}`;
        else await tx`
          INSERT INTO role_limits (tenant_id, role_id, limit_code, value) VALUES (${tenantId}, ${id}, ${code}, ${value})
          ON CONFLICT (tenant_id, role_id, limit_code) DO UPDATE SET value = EXCLUDED.value`;
      }
      return tx`SELECT limit_code, value FROM role_limits WHERE role_id = ${id} ORDER BY limit_code`;
    });
  });

  // ------------------------------------------------------------ staff
  app.get('/v1/staff', async (req) =>
    tenantTx(deps, req, async ({ tx, actor }) => {
      requirePermission(actor, 'staff.view');
      return tx`
        SELECT s.id, s.first_name, s.last_name, s.display_name, s.email, s.phone, s.employee_number, s.employment_type,
               s.status, s.start_date, s.end_date, s.role_id, r.name AS role_name, (s.pos_pin_hash IS NOT NULL) AS has_pin,
               COALESCE((SELECT array_agg(branch_id) FROM staff_branch_access a
                         WHERE a.tenant_id = s.tenant_id AND a.staff_id = s.id), '{}') AS branch_ids
        FROM staff s JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
        ORDER BY s.status, s.display_name`;
    }));

  // Light list for the till's login screen (names only, for the branch).
  app.get('/v1/branches/:id/staff-tiles', async (req) => {
    const { id } = parse(idParam, req.params);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      requireBranchAccess(actor, id);
      return tx`
        SELECT s.id, s.display_name FROM staff s
        JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
        WHERE s.status = 'active' AND s.pos_pin_hash IS NOT NULL
          AND (r.system_key = 'owner' OR EXISTS (SELECT 1 FROM staff_branch_access a
               WHERE a.tenant_id = s.tenant_id AND a.staff_id = s.id AND a.branch_id = ${id}))
        ORDER BY s.display_name`;
    });
  });

  app.post('/v1/staff', async (req, reply) => {
    const body = parse(staffSchema, req.body);
    const pinHash = body.pin ? await hashSecret(body.pin) : null;
    const row = await tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'staff.manage');
      const [role] = await tx<{ system_key: string | null }[]>`SELECT system_key FROM roles WHERE id = ${body.role_id}`;
      if (!role) throw notFound('Role');
      if (role.system_key === 'owner' && !actor.isOwner) throw forbidden('Only an owner can add another owner');
      for (const b of body.branch_ids) requireBranchAccess(actor, b);
      const { branch_ids, pin, ...fields } = body;
      const [s] = await tx<{ id: string }[]>`
        INSERT INTO staff ${tx({ ...fields, tenant_id: tenantId, display_name: body.display_name ?? body.first_name,
          pos_pin_hash: pinHash } as never)}
        RETURNING id, first_name, last_name, display_name, role_id, status`;
      await tx`INSERT INTO staff_branch_access ${tx(branch_ids.map((b, i) =>
        ({ tenant_id: tenantId, staff_id: s!.id, branch_id: b, is_primary: i === 0 })) as never)}`;
      return { ...s, branch_ids };
    });
    return reply.status(201).send(row);
  });

  app.patch('/v1/staff/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(staffSchema.omit({ pin: true }).partial()
      .extend({ status: z.enum(['invited', 'active', 'suspended', 'left']).optional(), end_date: isoDate.nullish() }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'staff.manage');
      const [target] = await tx<{ system_key: string | null }[]>`
        SELECT r.system_key FROM staff s JOIN roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id WHERE s.id = ${id}`;
      if (!target) throw notFound('Staff member');
      if (target.system_key === 'owner' && !actor.isOwner) throw forbidden('Only an owner can change an owner');
      if (body.role_id) {
        const [role] = await tx<{ system_key: string | null }[]>`SELECT system_key FROM roles WHERE id = ${body.role_id}`;
        if (!role) throw notFound('Role');
        if (role.system_key === 'owner' && !actor.isOwner) throw forbidden('Only an owner can make someone an owner');
      }
      const { branch_ids, ...fields } = body;
      if (Object.keys(fields).length) await tx`UPDATE staff SET ${tx(fields as never)} WHERE id = ${id}`;
      if (branch_ids) {
        for (const b of branch_ids) requireBranchAccess(actor, b);
        await tx`DELETE FROM staff_branch_access WHERE staff_id = ${id}`;
        await tx`INSERT INTO staff_branch_access ${tx(branch_ids.map((b, i) =>
          ({ tenant_id: tenantId, staff_id: id, branch_id: b, is_primary: i === 0 })) as never)}`;
      }
      const [s] = await tx`SELECT id, first_name, last_name, display_name, role_id, status FROM staff WHERE id = ${id}`;
      return s;
    });
  });

  // Staff set their own PIN; managers with staff.manage can reset anyone's.
  app.put('/v1/staff/:id/pin', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/) }), req.body);
    const pinHash = await hashSecret(body.pin);
    return tenantTx(deps, req, async ({ tx, actor }) => {
      if (id !== actor.staffId) requirePermission(actor, 'staff.manage');
      const [s] = await tx`UPDATE staff SET pos_pin_hash = ${pinHash} WHERE id = ${id} RETURNING id`;
      if (!s) throw notFound('Staff member');
      return { ok: true };
    });
  });

  // Per-person exceptions. permissions: code -> true (grant) | false (revoke) | null (clear)
  app.put('/v1/staff/:id/overrides', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      permissions: z.record(permissionCode, z.boolean().nullable()).default({}),
      limits: z.record(limitCode, z.number().nonnegative().nullable()).default({}),
      reason: z.string().nullish(),
    }), req.body);
    return tenantTx(deps, req, async ({ tx, actor, tenantId }) => {
      requirePermission(actor, 'roles.manage');
      const [s] = await tx`SELECT 1 FROM staff WHERE id = ${id}`;
      if (!s) throw notFound('Staff member');
      for (const [code, granted] of Object.entries(body.permissions)) {
        if (granted === null) await tx`DELETE FROM staff_permission_overrides WHERE staff_id = ${id} AND permission_code = ${code}`;
        else await tx`
          INSERT INTO staff_permission_overrides (tenant_id, staff_id, permission_code, granted, reason, created_by)
          VALUES (${tenantId}, ${id}, ${code}, ${granted}, ${body.reason ?? null}, ${actor.staffId})
          ON CONFLICT (tenant_id, staff_id, permission_code)
          DO UPDATE SET granted = EXCLUDED.granted, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by`;
      }
      for (const [code, value] of Object.entries(body.limits)) {
        if (value === null) await tx`DELETE FROM staff_limit_overrides WHERE staff_id = ${id} AND limit_code = ${code}`;
        else await tx`
          INSERT INTO staff_limit_overrides (tenant_id, staff_id, limit_code, value) VALUES (${tenantId}, ${id}, ${code}, ${value})
          ON CONFLICT (tenant_id, staff_id, limit_code) DO UPDATE SET value = EXCLUDED.value`;
      }
      return {
        permissions: (await tx`SELECT permission_code FROM v_staff_permissions WHERE staff_id = ${id} ORDER BY 1`)
          .map((r) => r.permission_code),
        limits: Object.fromEntries((await tx`SELECT limit_code, value FROM v_staff_limits WHERE staff_id = ${id}`)
          .map((r) => [r.limit_code, r.value])),
      };
    });
  });
}
