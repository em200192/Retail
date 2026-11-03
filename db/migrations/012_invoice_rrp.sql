-- =====================================================================
-- 012_invoice_rrp.sql
-- Wholesale invoices print a recommended retail price (RRP / "STD RRP")
-- or a price-marked price per line. Keep it so a new product created from
-- the line can start with a sensible shelf price.
-- =====================================================================
ALTER TABLE supplier_invoice_lines ADD COLUMN rrp_pence bigint CHECK (rrp_pence >= 0);
