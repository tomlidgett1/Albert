-- Governed analytical reads were about 18x slower than the same SQL run as
-- albert_migration_owner: 2.2-2.7s became roughly 40s, past the 25s statement
-- timeout, so every inventory question failed.
--
-- 0083 replaced the cheap SQL core.current_tenant_id() with a plpgsql
-- SECURITY DEFINER function that verifies a signed capability token. That is
-- the right boundary, but every RLS policy names it as a bare call:
--
--   USING (tenant_id = core.current_tenant_id())
--
-- PostgreSQL does not fold a zero-argument STABLE function into a per-scan
-- InitPlan. Only IMMUTABLE expressions are constant-folded, so as written the
-- verifier runs once per candidate row, per relation, per rescan. Measured on
-- the dogfood tenant with a real albert_semantic_read_runtime session holding a
-- signed token, over a 20,000-row table with a sequential scan:
--
--   USING (tenant_id = core.current_tenant_id())            6984 ms  (349us/row)
--   USING (tenant_id = (SELECT core.current_tenant_id()))    172 ms
--   USING (tenant_id = current_setting('albert.tenant_id'))  175 ms  (pre-0083)
--
-- One verification costs about 340us -- HMAC, a token JSON parse, a signing key
-- lookup and the pg_auth_members role-boundary scan in
-- capability_internal.expected_runtime_binding(). That is a sensible price once
-- per query and a fatal one once per row. mart.inventory_health_day is a
-- security_invoker view whose internals scan six tenant relations and drive a
-- lateral per dense row, so it paid that price tens of thousands of times.
--
-- Wrapping the call in a scalar subquery makes it an uncorrelated InitPlan,
-- which PostgreSQL evaluates once per query execution and caches in a
-- PARAM_EXEC slot -- it is not re-evaluated on nested-loop rescans:
--
--   ->  Seq Scan on subquery_call
--         Filter: (tenant_id = (InitPlan 1).col1)
--
-- Nothing about the capability boundary changes. The same SECURITY DEFINER
-- verifier runs, against the same token, and still raises on a missing,
-- expired, unsigned, wrong-audience or revoked capability; the RLS predicate is
-- unchanged apart from when it is evaluated. Because the token is verified
-- before any row is examined, a query that fails verification still returns no
-- rows. This is deliberately not a memoisation: no value the calling role can
-- write is trusted, so there is nothing new to forge.
--
-- Every ALL policy in the analytical stream that names either verifier is
-- rewritten, USING and WITH CHECK alike -- WITH CHECK runs per written row on
-- the ingest and transform paths and carried the same cost.

BEGIN;

-- core
ALTER POLICY tenant_isolation ON core.channel
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.commerce_order
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.commerce_order_line
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.commerce_payment
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.commerce_refund_line
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.customer_account
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.employment_episode
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.entity_identity_edge
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.entity_resolution
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.entity_source_link
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.event_link
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.finance_bank_transaction
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.finance_invoice_line
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.finance_journal_line
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.gl_account
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.inventory_balance_snapshot
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.inventory_movement
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.legal_entity
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.location
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.order_line_source_observation
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.order_source_observation
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.person
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.product
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.product_category
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.product_category_assignment
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.product_variant
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.purchase_order_line
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.register
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.source_authority
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.stock_location
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.supplier
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.tax_code
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.worker
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.workforce_leave
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.workforce_shift
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON core.workforce_time_entry
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));

-- mart
ALTER POLICY tenant_isolation ON mart.labour_day_location
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON mart.sales_day_location
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));

-- quality
ALTER POLICY tenant_isolation ON quality.check_result
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.connector_check_observation
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.connector_stream_page_evidence
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.connector_stream_state
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.finding
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.pipeline_stats
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.reconciliation_identity_evidence
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.reconciliation_snapshot
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.reconciliation_snapshot_page
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON quality.reconciliation_tombstone_application
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));

-- semantic_internal
ALTER POLICY tenant_isolation ON semantic_internal.canonical_record_state
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.canonical_transform_commits
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.connector_pack_source_field_snapshot
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.connector_pack_tenant_capability_snapshot
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.identity_decision_history
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.identity_graph_state
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.identity_link_baseline
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.identity_observation
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.identity_review_projection_outbox
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.lightspeed_order_dependency_replay_audit
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.pipeline_stats_projection_outbox
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.pipeline_table_stats_projection_outbox
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.promotion_candidate_outbox
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.query_audit
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.readiness_projection_outbox
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.result_cache
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.source_field_allowlist
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));
ALTER POLICY tenant_isolation ON semantic_internal.tenant_capability
  USING (tenant_id = (SELECT core.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT core.current_tenant_id()));

-- ingestion
ALTER POLICY tenant_scope ON ingestion.batch_manifests
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON ingestion.canonical_staging_batch_records
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON ingestion.landing_commits
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON ingestion.quarantine_records
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON ingestion.source_records
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

-- source_deputy
ALTER POLICY tenant_scope ON source_deputy.companies
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_deputy.contacts
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_deputy.employees
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_deputy.leave
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_deputy.operational_units
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_deputy.rosters
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_deputy.timesheets
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

-- source_lightspeed
ALTER POLICY tenant_scope ON source_lightspeed.categories
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.customers
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.employees
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.inventory_logs
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.item_shops
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.items
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.order_lines
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.orders
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.payment_types
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.sales
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.shops
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.tax_categories
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_lightspeed.vendors
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

-- source_xero
ALTER POLICY tenant_scope ON source_xero.accounts
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.bank_transactions
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.contacts
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.credit_notes
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.invoices
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.journals
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.manual_journals
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.organisation
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.payments
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.tax_rates
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));
ALTER POLICY tenant_scope ON source_xero.tracking_categories
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

COMMIT;
