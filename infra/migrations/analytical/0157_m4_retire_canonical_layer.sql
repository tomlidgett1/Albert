-- Retires the canonical projection layer. V3 answers from the raw source_*
-- schemas through Cube; nothing in the runtime reads core.* facts, the marts
-- built on them, or the identity graph that the retired semantic-query service
-- projected.
--
-- core.current_tenant_id(), core.is_ulid() and core.is_currency() STAY. They
-- are generic helpers that happen to live in this schema and are depended on by
-- 546 RLS policies across 13 schemas (including every source_* landing table)
-- and 107 CHECK constraints. The schema itself is therefore kept, holding only
-- those three functions.

BEGIN;

-- 1. Functions that read canonical facts. Dropped before their tables so the
--    drop order never depends on CASCADE reaching into an unexpected object.
DROP FUNCTION IF EXISTS core.enforce_source_authority_interval() CASCADE;
DROP FUNCTION IF EXISTS core.normalize_employment_episode_interval() CASCADE;
DROP FUNCTION IF EXISTS core.protect_canonical_sync_run() CASCADE;
DROP FUNCTION IF EXISTS core.protect_fact_lineage() CASCADE;
DROP FUNCTION IF EXISTS core.assert_source_authority(text, text, text, text, text, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS core.source_is_authoritative(text, text, text, text, text, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS core.install_default_source_authority(text, text, text, text, text, text, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS core.refresh_daily_settlement_links(text, date, date, text, numeric, integer) CASCADE;

DROP FUNCTION IF EXISTS quality.run_all_invariants(text, text) CASCADE;
DROP FUNCTION IF EXISTS quality.run_domain_invariants(text, text) CASCADE;
DROP FUNCTION IF EXISTS quality.compute_stock_continuity(text) CASCADE;
DROP FUNCTION IF EXISTS quality.current_scoped_health(text, text[], text[]) CASCADE;
DROP FUNCTION IF EXISTS quality.snapshot_all_pipeline_stats(text, timestamptz, text[], jsonb) CASCADE;

DROP FUNCTION IF EXISTS semantic_internal.apply_identity_decision(text, text, text, integer, text, text, jsonb, uuid, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS semantic_internal.generate_identity_review_candidates(text) CASCADE;
DROP FUNCTION IF EXISTS semantic_internal.refresh_identity_scope_digests(text) CASCADE;
DROP FUNCTION IF EXISTS semantic_internal.record_lightspeed_order_dependency_replay(text, text, text, text, text, text, text) CASCADE;

-- 2. Identity graph and canonical transform ledgers. Their only reader was the
--    semantic-query service; their only writer was the canonical pipeline.
DROP TABLE IF EXISTS semantic_internal.identity_review_projection_outbox CASCADE;
DROP TABLE IF EXISTS semantic_internal.identity_decision_history CASCADE;
DROP TABLE IF EXISTS semantic_internal.identity_link_baseline CASCADE;
DROP TABLE IF EXISTS semantic_internal.identity_observation CASCADE;
DROP TABLE IF EXISTS semantic_internal.identity_graph_state CASCADE;
DROP TABLE IF EXISTS semantic_internal.canonical_record_state CASCADE;
DROP TABLE IF EXISTS semantic_internal.canonical_transform_commits CASCADE;
DROP TABLE IF EXISTS semantic_internal.lightspeed_order_dependency_replay_audit CASCADE;
DROP TABLE IF EXISTS semantic_internal.lightspeed_supplier_replay_gate_index CASCADE;

-- 3. Marts. Built solely from canonical facts; no cube reads them.
DROP TABLE IF EXISTS mart.sales_day_location CASCADE;
DROP TABLE IF EXISTS mart.labour_day_location CASCADE;

-- 4. Canonical facts, dimensions, bridges and their lookups.
DROP TABLE IF EXISTS core.order_line_source_observation CASCADE;
DROP TABLE IF EXISTS core.order_source_observation CASCADE;
DROP TABLE IF EXISTS core.commerce_refund_line CASCADE;
DROP TABLE IF EXISTS core.commerce_refund CASCADE;
DROP TABLE IF EXISTS core.commerce_payment_fee CASCADE;
DROP TABLE IF EXISTS core.commerce_payment CASCADE;
DROP TABLE IF EXISTS core.commerce_order_line CASCADE;
DROP TABLE IF EXISTS core.commerce_order CASCADE;
DROP TABLE IF EXISTS core.purchase_order_line CASCADE;
DROP TABLE IF EXISTS core.finance_settlement_line CASCADE;
DROP TABLE IF EXISTS core.finance_settlement CASCADE;
DROP TABLE IF EXISTS core.finance_invoice_line CASCADE;
DROP TABLE IF EXISTS core.finance_journal_line CASCADE;
DROP TABLE IF EXISTS core.finance_bank_transaction CASCADE;
DROP TABLE IF EXISTS core.inventory_movement CASCADE;
DROP TABLE IF EXISTS core.inventory_balance_snapshot CASCADE;
DROP TABLE IF EXISTS core.workforce_time_entry CASCADE;
DROP TABLE IF EXISTS core.workforce_shift CASCADE;
DROP TABLE IF EXISTS core.workforce_leave CASCADE;
DROP TABLE IF EXISTS core.employment_episode CASCADE;
DROP TABLE IF EXISTS core.product_category_assignment CASCADE;
DROP TABLE IF EXISTS core.product_category CASCADE;
DROP TABLE IF EXISTS core.product_variant CASCADE;
DROP TABLE IF EXISTS core.product CASCADE;
DROP TABLE IF EXISTS core.customer_account CASCADE;
DROP TABLE IF EXISTS core.worker CASCADE;
DROP TABLE IF EXISTS core.person CASCADE;
DROP TABLE IF EXISTS core.supplier CASCADE;
DROP TABLE IF EXISTS core.register CASCADE;
DROP TABLE IF EXISTS core.stock_location CASCADE;
DROP TABLE IF EXISTS core.location CASCADE;
DROP TABLE IF EXISTS core.channel CASCADE;
DROP TABLE IF EXISTS core.legal_entity CASCADE;
DROP TABLE IF EXISTS core.gl_account CASCADE;
DROP TABLE IF EXISTS core.tax_code CASCADE;
DROP TABLE IF EXISTS core.calendar_day CASCADE;
DROP TABLE IF EXISTS core.event_link CASCADE;
DROP TABLE IF EXISTS core.entity_identity_edge CASCADE;
DROP TABLE IF EXISTS core.entity_resolution CASCADE;
DROP TABLE IF EXISTS core.entity_source_link CASCADE;
DROP TABLE IF EXISTS core.source_authority CASCADE;

-- Lookup vocabularies that only the canonical layer constrained.
DROP TABLE IF EXISTS core.authority_concept_lookup CASCADE;
DROP TABLE IF EXISTS core.authority_scope_lookup CASCADE;
DROP TABLE IF EXISTS core.channel_type_lookup CASCADE;
DROP TABLE IF EXISTS core.commerce_status_lookup CASCADE;
DROP TABLE IF EXISTS core.confidence_band_lookup CASCADE;
DROP TABLE IF EXISTS core.employment_status_lookup CASCADE;
DROP TABLE IF EXISTS core.entity_type_lookup CASCADE;
DROP TABLE IF EXISTS core.event_link_type_lookup CASCADE;
DROP TABLE IF EXISTS core.finance_status_lookup CASCADE;
DROP TABLE IF EXISTS core.inventory_movement_type_lookup CASCADE;
DROP TABLE IF EXISTS core.line_item_type_lookup CASCADE;
DROP TABLE IF EXISTS core.match_method_lookup CASCADE;
DROP TABLE IF EXISTS core.match_status_lookup CASCADE;
DROP TABLE IF EXISTS core.payment_status_lookup CASCADE;
DROP TABLE IF EXISTS core.purchase_order_status_lookup CASCADE;
DROP TABLE IF EXISTS core.relationship_lookup CASCADE;
DROP TABLE IF EXISTS core.workforce_leave_status_lookup CASCADE;
DROP TABLE IF EXISTS core.workforce_shift_status_lookup CASCADE;
DROP TABLE IF EXISTS core.workforce_time_status_lookup CASCADE;

-- 5. Fail closed: the three retained helpers must still exist, and no canonical
--    table may survive. A silent partial drop would leave RLS unenforceable.
DO $$
DECLARE remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('core', 'mart') AND c.relkind = 'r';
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'canonical retirement left % table(s) in core/mart', remaining;
  END IF;

  IF to_regprocedure('core.current_tenant_id()') IS NULL
     OR to_regprocedure('core.is_ulid(text)') IS NULL
     OR to_regprocedure('core.is_currency(text)') IS NULL THEN
    RAISE EXCEPTION 'canonical retirement removed a retained core helper';
  END IF;
END $$;

COMMIT;
