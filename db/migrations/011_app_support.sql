-- =====================================================================
-- 011_app_support.sql
-- Small additions needed by the API layer.
-- =====================================================================

-- Receipt numbers are '{branch_code}-{device_no}-{seq}' and generated
-- offline, so every POS device needs a short number unique per branch.
ALTER TABLE devices ADD COLUMN device_no smallint CHECK (device_no > 0);
CREATE UNIQUE INDEX devices_branch_no_uq ON devices (tenant_id, branch_id, device_no)
  WHERE device_no IS NOT NULL;

-- The rounding rule used everywhere (API, device, SQL): VAT contained in a
-- VAT-inclusive amount, rounded half-up to the nearest penny, per line.
-- Mirrors vatFromGross() in packages/shared/src/money.ts.
CREATE OR REPLACE FUNCTION vat_from_gross(p_gross_pence bigint, p_rate_percent numeric)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_rate_percent = 0 THEN 0
              ELSE sign(p_gross_pence) * floor(abs(p_gross_pence) * p_rate_percent / (100 + p_rate_percent) + 0.5)
         END::bigint
$$;
