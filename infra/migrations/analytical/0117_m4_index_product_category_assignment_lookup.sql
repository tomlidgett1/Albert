-- core.product_category_assignment carried only its (tenant_id, id) primary
-- key, but nothing reads it that way. Both marts resolve a variant's category
-- through the same effective-dated lateral:
--
--   SELECT assignment.product_category_id
--     FROM core.product_category_assignment assignment
--    WHERE assignment.tenant_id = ... AND assignment.product_variant_id = ...
--      AND assignment.effective_from <= now()
--      AND (assignment.effective_to IS NULL OR assignment.effective_to > now())
--    ORDER BY assignment.effective_from DESC, assignment.id DESC
--    LIMIT 1
--
-- With no index on that access path each lateral sequentially scanned the whole
-- table. mart.inventory_health_day runs it once per dense row: 16,699 rows
-- scanned 34,368 times, about 574 million row visits, so every inventory
-- question exceeded the statement timeout. mart.commerce_sales_event runs the
-- same lateral per sales event.
--
-- Index the real access path, leading with the equality columns and carrying
-- the ordering so the LIMIT 1 stops at the first row.

BEGIN;

CREATE INDEX IF NOT EXISTS product_category_assignment_variant_effective_idx
  ON core.product_category_assignment (
    tenant_id, product_variant_id, effective_from DESC, id DESC
  )
  INCLUDE (product_category_id, effective_to);

COMMENT ON INDEX core.product_category_assignment_variant_effective_idx IS
  'Serves the effective-dated category lateral used by mart.inventory_health_day and mart.commerce_sales_event.';

COMMIT;
