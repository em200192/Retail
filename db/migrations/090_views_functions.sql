-- =====================================================================
-- 090_views_functions.sql
-- Read helpers. All views use security_invoker so RLS still applies.
-- =====================================================================

-- Price resolution: requested level beats default level, branch price
-- beats all-branch price, highest qualifying quantity break, newest.
CREATE OR REPLACE FUNCTION resolve_price(
  p_product      uuid,
  p_price_level  uuid,
  p_branch       uuid,
  p_qty          numeric     DEFAULT 1,
  p_at           timestamptz DEFAULT now()
) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT pp.price_pence
  FROM product_prices pp
  JOIN price_levels pl ON pl.tenant_id = pp.tenant_id AND pl.id = pp.price_level_id
  WHERE pp.tenant_id = app_current_tenant()
    AND pp.product_id = p_product
    AND (pp.price_level_id = p_price_level OR pl.is_default)
    AND (pp.branch_id = p_branch OR pp.branch_id IS NULL)
    AND pp.min_qty <= p_qty
    AND pp.valid_from <= p_at
    AND (pp.valid_to IS NULL OR pp.valid_to > p_at)
  ORDER BY (pp.price_level_id IS NOT DISTINCT FROM p_price_level) DESC,
           (pp.branch_id IS NOT NULL) DESC,
           pp.min_qty DESC,
           pp.valid_from DESC
  LIMIT 1
$$;

-- On-hand minus stock held for accepted online orders.
CREATE VIEW v_stock_availability WITH (security_invoker = true) AS
SELECT sl.tenant_id,
       sl.branch_id,
       sl.product_id,
       sl.quantity                                   AS on_hand,
       COALESCE(r.reserved, 0)                       AS reserved,
       sl.quantity - COALESCE(r.reserved, 0)         AS available
FROM stock_levels sl
LEFT JOIN (
  SELECT tenant_id, branch_id, product_id, SUM(quantity) AS reserved
  FROM stock_reservations
  WHERE status = 'active'
  GROUP BY tenant_id, branch_id, product_id
) r USING (tenant_id, branch_id, product_id);

-- Products at or below their reorder point (branch setting beats product default).
CREATE VIEW v_low_stock WITH (security_invoker = true) AS
SELECT sl.tenant_id,
       sl.branch_id,
       sl.product_id,
       p.name,
       sl.quantity,
       COALESCE(pbs.reorder_point, p.reorder_point) AS reorder_point,
       COALESCE(pbs.reorder_qty,   p.reorder_qty)   AS reorder_qty
FROM stock_levels sl
JOIN products p
  ON p.tenant_id = sl.tenant_id AND p.id = sl.product_id
LEFT JOIN product_branch_settings pbs
  ON pbs.tenant_id = sl.tenant_id AND pbs.branch_id = sl.branch_id AND pbs.product_id = sl.product_id
WHERE p.track_stock
  AND p.archived_at IS NULL
  AND COALESCE(pbs.is_ranged, true)
  AND COALESCE(pbs.reorder_point, p.reorder_point) IS NOT NULL
  AND sl.quantity <= COALESCE(pbs.reorder_point, p.reorder_point);

-- Batches expiring within 3 days (drive "Reduced to clear" suggestions).
CREATE VIEW v_expiring_soon WITH (security_invoker = true) AS
SELECT b.tenant_id, b.branch_id, b.product_id, p.name, b.id AS batch_id,
       b.expiry_date, b.qty_remaining,
       (b.expiry_date - CURRENT_DATE) AS days_left
FROM stock_batches b
JOIN products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
WHERE b.qty_remaining > 0
  AND b.expiry_date IS NOT NULL
  AND b.expiry_date <= CURRENT_DATE + 3;

-- Effective permissions = role permissions - revoked overrides + granted overrides.
CREATE VIEW v_staff_permissions WITH (security_invoker = true) AS
SELECT s.tenant_id, s.id AS staff_id, rp.permission_code
FROM staff s
JOIN role_permissions rp ON rp.tenant_id = s.tenant_id AND rp.role_id = s.role_id
WHERE s.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM staff_permission_overrides o
    WHERE o.tenant_id = s.tenant_id AND o.staff_id = s.id
      AND o.permission_code = rp.permission_code AND NOT o.granted)
UNION
SELECT o.tenant_id, o.staff_id, o.permission_code
FROM staff_permission_overrides o
JOIN staff s ON s.tenant_id = o.tenant_id AND s.id = o.staff_id AND s.status = 'active'
WHERE o.granted;

-- Effective limits = personal override, else role limit.
CREATE VIEW v_staff_limits WITH (security_invoker = true) AS
SELECT s.tenant_id, s.id AS staff_id, ld.code AS limit_code, ld.unit,
       COALESCE(so.value, rl.value) AS value
FROM staff s
CROSS JOIN limit_definitions ld
LEFT JOIN role_limits rl
  ON rl.tenant_id = s.tenant_id AND rl.role_id = s.role_id AND rl.limit_code = ld.code
LEFT JOIN staff_limit_overrides so
  ON so.tenant_id = s.tenant_id AND so.staff_id = s.id AND so.limit_code = ld.code
WHERE COALESCE(so.value, rl.value) IS NOT NULL;

CREATE OR REPLACE FUNCTION staff_has_permission(p_staff uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM v_staff_permissions
    WHERE tenant_id = app_current_tenant()
      AND staff_id = p_staff
      AND permission_code = p_permission)
$$;

-- Returns NULL when no limit is defined (caller decides: NULL = not allowed).
CREATE OR REPLACE FUNCTION staff_limit(p_staff uuid, p_limit text)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT value FROM v_staff_limits
  WHERE tenant_id = app_current_tenant()
    AND staff_id = p_staff
    AND limit_code = p_limit
$$;

-- VAT rate in force on a given date.
CREATE OR REPLACE FUNCTION vat_rate_on(p_code text, p_on date DEFAULT CURRENT_DATE)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT rate_percent FROM vat_rates
  WHERE code = p_code
    AND valid_from <= p_on
    AND (valid_to IS NULL OR valid_to > p_on)
  ORDER BY valid_from DESC
  LIMIT 1
$$;
