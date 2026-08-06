-- Parent context on the child staging tables, so a nested row maps standalone.
--
-- The per-stream walk projects sale lines, sale payments and purchase-order
-- lines as first-class rows, but a line alone cannot know whether its sale
-- completed or was voided, and a payment alone carries no location. The spec
-- now declares these as parent-projected columns (Sale.completed on a sale
-- line, Order.vendorID on an order line), the projection resolves them from
-- the walked parent record, and these columns receive them. Names follow the
-- staging derivation: snake_case of the vendor field the projection stages.

BEGIN;

ALTER TABLE source_lightspeed."ls_sale_lines"
  ADD COLUMN IF NOT EXISTS "completed" boolean,
  ADD COLUMN IF NOT EXISTS "voided" boolean,
  ADD COLUMN IF NOT EXISTS "complete_time" timestamptz;

ALTER TABLE source_lightspeed."ls_sale_payments"
  ADD COLUMN IF NOT EXISTS "completed" boolean,
  ADD COLUMN IF NOT EXISTS "voided" boolean,
  ADD COLUMN IF NOT EXISTS "complete_time" timestamptz,
  ADD COLUMN IF NOT EXISTS "shop_id" numeric(19,4);

ALTER TABLE source_lightspeed."ls_purchase_order_lines"
  ADD COLUMN IF NOT EXISTS "vendor_id" numeric(19,4),
  ADD COLUMN IF NOT EXISTS "shop_id" numeric(19,4),
  ADD COLUMN IF NOT EXISTS "complete" boolean,
  ADD COLUMN IF NOT EXISTS "ordered_date" timestamptz,
  ADD COLUMN IF NOT EXISTS "received_date" timestamptz,
  ADD COLUMN IF NOT EXISTS "archived" boolean,
  ADD COLUMN IF NOT EXISTS "vendor_currency_code" text;

COMMIT;
