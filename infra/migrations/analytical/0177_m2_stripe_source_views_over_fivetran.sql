-- 0177: Stripe Cube contract reads Fivetran's official Stripe ERD.
--
-- Fivetran lands native table names (charge, invoice, subscription_history)
-- into one destination schema per connection (stripe_<connection_ulid>).
-- Union views live in source_stripe_fivetran.* (built by
-- ingestion.rebuild_fivetran_source_views('stripe')). Official views
-- source_stripe.st_* filter tenant + soft-deletes, hide Fivetran bookkeeping
-- as business facts, and keep stable column names for CubeCore.

BEGIN;

CREATE SCHEMA IF NOT EXISTS source_stripe;
CREATE SCHEMA IF NOT EXISTS source_stripe_fivetran;

GRANT USAGE ON SCHEMA source_stripe TO transform_rw, diagnostic_ro, semantic_ro;
GRANT USAGE ON SCHEMA source_stripe_fivetran TO transform_rw, diagnostic_ro, semantic_ro;

ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_stripe
  GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro, semantic_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_stripe_fivetran
  GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro, semantic_ro;

-- Stripe amounts are in the smallest currency unit. Zero-decimal currencies
-- stay as whole units; two-decimal currencies divide by 100.
CREATE OR REPLACE FUNCTION source_stripe.stripe_major_units(amount numeric, currency text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN amount IS NULL THEN NULL
    WHEN upper(coalesce(currency, '')) IN (
      'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
      'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
    ) THEN amount
    ELSE amount / 100.0
  END;
$$;

GRANT EXECUTE ON FUNCTION source_stripe.stripe_major_units(numeric, text) TO transform_rw, diagnostic_ro, semantic_ro;

-- Official Fivetran Stripe ERD table names (live connector ERD, 2026-08).
-- Aliases (invoice_line_item, subscription) cover dbt_stripe naming.
CREATE TABLE IF NOT EXISTS ingestion.stripe_erd_tables (
  table_name text PRIMARY KEY
);

INSERT INTO ingestion.stripe_erd_tables (table_name) VALUES
  ('account'),
  ('apple_pay_domain'),
  ('application_fee'),
  ('application_fee_refund'),
  ('attribute'),
  ('au_becs_debit'),
  ('authorization'),
  ('balance_transaction'),
  ('bank_account'),
  ('billing_meter'),
  ('billing_meter_event_summary'),
  ('capability'),
  ('card'),
  ('cardholder'),
  ('cash_balance'),
  ('cash_balance_transaction'),
  ('charge'),
  ('charge_payment_method_details'),
  ('card_payments_fees_transaction_level_1'),
  ('checkout_session'),
  ('checkout_session_custom_field'),
  ('checkout_session_custom_field_dropdown_option'),
  ('checkout_session_line_item'),
  ('checkout_session_line_item_discount'),
  ('checkout_session_line_item_tax_rate'),
  ('checkout_session_discount'),
  ('checkout_session_tax'),
  ('checkout_session_tax_rate'),
  ('checkout_session_payment_method'),
  ('checkout_session_shipping'),
  ('checkout_session_shipping_address_allowed_countries'),
  ('checkout_session_shipping_option'),
  ('coupon'),
  ('coupon_product'),
  ('credit_grant'),
  ('credit_grant_applicability_price'),
  ('credit_grant_applicability_config_scope_prices'),
  ('credit_note'),
  ('credit_note_line_item'),
  ('credit_note_tax_rate'),
  ('customer'),
  ('customer_balance_transaction'),
  ('customer_discount'),
  ('customer_tax'),
  ('discount'),
  ('dispute'),
  ('dispute_balance_transaction'),
  ('early_fraud_warning'),
  ('fee'),
  ('file'),
  ('file_link'),
  ('fpx'),
  ('ideal'),
  ('invoice'),
  ('invoice_account_tax'),
  ('invoice_custom_field'),
  ('invoice_discount'),
  ('invoice_item'),
  ('invoice_item_tax_rate'),
  ('invoice_line'),
  ('invoice_line_item'),
  ('invoice_line_item_tax_rate'),
  ('invoice_payment'),
  ('invoice_tax_rate'),
  ('issuing_card'),
  ('issuing_dispute'),
  ('issuing_transaction'),
  ('order_item'),
  ('order_return'),
  ('order_return_item'),
  ('payment_intent'),
  ('payment_link'),
  ('payment_link_line_item'),
  ('payment_method'),
  ('payment_method_card'),
  ('payment_method_card_present'),
  ('payout'),
  ('payout_balance_transaction'),
  ('person'),
  ('phase'),
  ('phase_plan'),
  ('plan'),
  ('price'),
  ('price_currency_option'),
  ('product'),
  ('promotion_code'),
  ('quote'),
  ('quote_line_item'),
  ('quote_tax'),
  ('refund'),
  ('review'),
  ('sepa_debit'),
  ('setup_attempt'),
  ('setup_intent'),
  ('shipping_method'),
  ('shipping_rate'),
  ('sku'),
  ('source'),
  ('subscription'),
  ('subscription_discount'),
  ('subscription_history'),
  ('subscription_item'),
  ('subscription_schedule'),
  ('subscription_tax_rate'),
  ('tax_amount'),
  ('tax_rate'),
  ('tier'),
  ('topup'),
  ('transaction'),
  ('transfer'),
  ('transfer_reversal'),
  ('upcoming_invoice'),
  ('upcoming_invoice_line'),
  ('upcoming_invoice_discount'),
  ('usage_record')
ON CONFLICT (table_name) DO NOTHING;

GRANT SELECT ON ingestion.stripe_erd_tables TO transform_rw, diagnostic_ro, semantic_ro;

CREATE OR REPLACE FUNCTION ingestion.stripe_rel(p_schema text, p_table text)
RETURNS regclass
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_schema IS NULL OR p_schema !~ '^[a-z][a-z0-9_]{0,62}$'
     OR p_table IS NULL OR p_table !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RETURN NULL;
  END IF;
  RETURN to_regclass(format('%I.%I', p_schema, p_table));
END;
$$;

CREATE OR REPLACE FUNCTION ingestion.stripe_attr_sql(
  p_rel regclass,
  p_alias text,
  p_candidates text[],
  p_type text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  candidate text;
BEGIN
  IF p_rel IS NULL THEN
    RETURN format('NULL::%s', p_type);
  END IF;
  FOREACH candidate IN ARRAY p_candidates LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = p_rel
         AND attribute.attname = candidate
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    ) THEN
      RETURN format('%I.%I::%s', p_alias, candidate, p_type);
    END IF;
  END LOOP;
  RETURN format('NULL::%s', p_type);
END;
$$;

CREATE OR REPLACE FUNCTION ingestion.stripe_first_rel(p_schema text, p_candidates text[])
RETURNS regclass
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  candidate text;
  found regclass;
BEGIN
  FOREACH candidate IN ARRAY p_candidates LOOP
    found := ingestion.stripe_rel(p_schema, candidate);
    IF found IS NOT NULL THEN
      RETURN found;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION ingestion.stripe_rel_name(p_rel regclass)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT class.relname
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = p_rel;
$$;

-- Recreate an official Stripe view from a SELECT list. Drops dependents via
-- the shared helper so later union-shape changes restore Cube views.
CREATE OR REPLACE FUNCTION ingestion.replace_stripe_official_view(
  p_view text,
  p_select text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF to_regclass(format('source_stripe.%I', p_view)) IS NOT NULL
     AND to_regprocedure('ingestion.recreate_view_with_dependents(text, text, text)') IS NOT NULL THEN
    PERFORM ingestion.recreate_view_with_dependents('source_stripe', p_view, p_select);
  ELSE
    EXECUTE format('CREATE OR REPLACE VIEW source_stripe.%I WITH (security_barrier = true) AS %s', p_view, p_select);
  END IF;
  EXECUTE format('ALTER VIEW source_stripe.%I SET (security_barrier = true)', p_view);
  EXECUTE format('GRANT SELECT ON source_stripe.%I TO transform_rw, diagnostic_ro, semantic_ro', p_view);
END;
$$;

CREATE TABLE IF NOT EXISTS ingestion.stripe_contract_views (
  view_name text PRIMARY KEY,
  source_tables text[] NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion.stripe_contract_columns (
  view_name text NOT NULL REFERENCES ingestion.stripe_contract_views(view_name) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  column_name text NOT NULL,
  candidates text[] NOT NULL,
  data_type text NOT NULL,
  PRIMARY KEY (view_name, column_name)
);

INSERT INTO ingestion.stripe_contract_views (view_name, source_tables) VALUES
  ('st_charge', ARRAY['charge']),
  ('st_payment_intent', ARRAY['payment_intent']),
  ('st_refund', ARRAY['refund']),
  ('st_dispute', ARRAY['dispute']),
  ('st_customer', ARRAY['customer']),
  ('st_invoice', ARRAY['invoice']),
  ('st_invoice_line', ARRAY['invoice_line_item', 'invoice_line']),
  ('st_subscription', ARRAY['subscription_history', 'subscription']),
  ('st_subscription_item', ARRAY['subscription_item']),
  ('st_product', ARRAY['product']),
  ('st_price', ARRAY['price']),
  ('st_payout', ARRAY['payout']),
  ('st_balance_transaction', ARRAY['balance_transaction']),
  ('st_payout_balance_transaction', ARRAY['payout_balance_transaction']),
  ('st_checkout_session', ARRAY['checkout_session']),
  ('st_application_fee', ARRAY['application_fee']),
  ('st_transfer', ARRAY['transfer']),
  ('st_credit_note', ARRAY['credit_note']),
  ('st_coupon', ARRAY['coupon']),
  ('st_account', ARRAY['account'])
ON CONFLICT (view_name) DO UPDATE SET source_tables = EXCLUDED.source_tables;

INSERT INTO ingestion.stripe_contract_columns (view_name, ordinal, column_name, candidates, data_type) VALUES
  ('st_charge', 1, 'id', ARRAY['id'], 'text'),
  ('st_charge', 2, 'amount', ARRAY['amount'], 'numeric'),
  ('st_charge', 3, 'amount_refunded', ARRAY['amount_refunded'], 'numeric'),
  ('st_charge', 4, 'application_fee_amount', ARRAY['application_fee_amount'], 'numeric'),
  ('st_charge', 5, 'balance_transaction_id', ARRAY['balance_transaction_id', 'balance_transaction'], 'text'),
  ('st_charge', 6, 'captured', ARRAY['captured'], 'boolean'),
  ('st_charge', 7, 'created', ARRAY['created'], 'timestamptz'),
  ('st_charge', 8, 'currency', ARRAY['currency'], 'text'),
  ('st_charge', 9, 'customer_id', ARRAY['customer_id', 'customer'], 'text'),
  ('st_charge', 10, 'description', ARRAY['description'], 'text'),
  ('st_charge', 11, 'failure_code', ARRAY['failure_code'], 'text'),
  ('st_charge', 12, 'failure_message', ARRAY['failure_message'], 'text'),
  ('st_charge', 13, 'invoice_id', ARRAY['invoice_id', 'invoice'], 'text'),
  ('st_charge', 14, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_charge', 15, 'paid', ARRAY['paid'], 'boolean'),
  ('st_charge', 16, 'payment_intent_id', ARRAY['payment_intent_id', 'payment_intent'], 'text'),
  ('st_charge', 17, 'payment_method_id', ARRAY['payment_method_id', 'payment_method'], 'text'),
  ('st_charge', 18, 'receipt_email', ARRAY['receipt_email'], 'text'),
  ('st_charge', 19, 'receipt_number', ARRAY['receipt_number'], 'text'),
  ('st_charge', 20, 'refunded', ARRAY['refunded'], 'boolean'),
  ('st_charge', 21, 'status', ARRAY['status'], 'text'),
  ('st_charge', 22, 'disputed', ARRAY['disputed'], 'boolean'),
  ('st_charge', 23, 'outcome_type', ARRAY['outcome_type', 'outcome_network_status'], 'text'),
  ('st_charge', 24, 'billing_detail_email', ARRAY['billing_detail_email', 'billing_details_email'], 'text'),
  ('st_charge', 25, 'billing_detail_name', ARRAY['billing_detail_name', 'billing_details_name'], 'text'),
  ('st_payment_intent', 1, 'id', ARRAY['id'], 'text'),
  ('st_payment_intent', 2, 'amount', ARRAY['amount'], 'numeric'),
  ('st_payment_intent', 3, 'amount_capturable', ARRAY['amount_capturable'], 'numeric'),
  ('st_payment_intent', 4, 'amount_received', ARRAY['amount_received'], 'numeric'),
  ('st_payment_intent', 5, 'currency', ARRAY['currency'], 'text'),
  ('st_payment_intent', 6, 'customer_id', ARRAY['customer_id', 'customer'], 'text'),
  ('st_payment_intent', 7, 'description', ARRAY['description'], 'text'),
  ('st_payment_intent', 8, 'status', ARRAY['status'], 'text'),
  ('st_payment_intent', 9, 'payment_method_id', ARRAY['payment_method_id', 'payment_method'], 'text'),
  ('st_payment_intent', 10, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_payment_intent', 11, 'created', ARRAY['created'], 'timestamptz'),
  ('st_payment_intent', 12, 'canceled_at', ARRAY['canceled_at'], 'timestamptz'),
  ('st_payment_intent', 13, 'cancellation_reason', ARRAY['cancellation_reason'], 'text'),
  ('st_refund', 1, 'id', ARRAY['id'], 'text'),
  ('st_refund', 2, 'amount', ARRAY['amount'], 'numeric'),
  ('st_refund', 3, 'currency', ARRAY['currency'], 'text'),
  ('st_refund', 4, 'charge_id', ARRAY['charge_id', 'charge'], 'text'),
  ('st_refund', 5, 'payment_intent_id', ARRAY['payment_intent_id', 'payment_intent'], 'text'),
  ('st_refund', 6, 'status', ARRAY['status'], 'text'),
  ('st_refund', 7, 'reason', ARRAY['reason'], 'text'),
  ('st_refund', 8, 'receipt_number', ARRAY['receipt_number'], 'text'),
  ('st_refund', 9, 'created', ARRAY['created'], 'timestamptz'),
  ('st_dispute', 1, 'id', ARRAY['id'], 'text'),
  ('st_dispute', 2, 'amount', ARRAY['amount'], 'numeric'),
  ('st_dispute', 3, 'currency', ARRAY['currency'], 'text'),
  ('st_dispute', 4, 'charge_id', ARRAY['charge_id', 'charge'], 'text'),
  ('st_dispute', 5, 'reason', ARRAY['reason'], 'text'),
  ('st_dispute', 6, 'status', ARRAY['status'], 'text'),
  ('st_dispute', 7, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_dispute', 8, 'created', ARRAY['created'], 'timestamptz'),
  ('st_dispute', 9, 'evidence_due_by', ARRAY['evidence_details_due_by', 'evidence_due_by'], 'timestamptz'),
  ('st_customer', 1, 'id', ARRAY['id'], 'text'),
  ('st_customer', 2, 'name', ARRAY['name'], 'text'),
  ('st_customer', 3, 'email', ARRAY['email'], 'text'),
  ('st_customer', 4, 'phone', ARRAY['phone'], 'text'),
  ('st_customer', 5, 'description', ARRAY['description'], 'text'),
  ('st_customer', 6, 'currency', ARRAY['currency'], 'text'),
  ('st_customer', 7, 'balance', ARRAY['balance', 'account_balance'], 'numeric'),
  ('st_customer', 8, 'delinquent', ARRAY['delinquent'], 'boolean'),
  ('st_customer', 9, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_customer', 10, 'is_deleted', ARRAY['is_deleted'], 'boolean'),
  ('st_customer', 11, 'address_city', ARRAY['address_city'], 'text'),
  ('st_customer', 12, 'address_state', ARRAY['address_state'], 'text'),
  ('st_customer', 13, 'address_country', ARRAY['address_country'], 'text'),
  ('st_customer', 14, 'created', ARRAY['created'], 'timestamptz'),
  ('st_invoice', 1, 'id', ARRAY['id'], 'text'),
  ('st_invoice', 2, 'number', ARRAY['number'], 'text'),
  ('st_invoice', 3, 'status', ARRAY['status'], 'text'),
  ('st_invoice', 4, 'customer_id', ARRAY['customer_id', 'customer'], 'text'),
  ('st_invoice', 5, 'subscription_id', ARRAY['subscription_id', 'subscription'], 'text'),
  ('st_invoice', 6, 'charge_id', ARRAY['charge_id', 'charge'], 'text'),
  ('st_invoice', 7, 'payment_intent_id', ARRAY['payment_intent_id', 'payment_intent'], 'text'),
  ('st_invoice', 8, 'currency', ARRAY['currency'], 'text'),
  ('st_invoice', 9, 'amount_due', ARRAY['amount_due'], 'numeric'),
  ('st_invoice', 10, 'amount_paid', ARRAY['amount_paid'], 'numeric'),
  ('st_invoice', 11, 'amount_remaining', ARRAY['amount_remaining'], 'numeric'),
  ('st_invoice', 12, 'subtotal', ARRAY['subtotal'], 'numeric'),
  ('st_invoice', 13, 'tax', ARRAY['tax'], 'numeric'),
  ('st_invoice', 14, 'total', ARRAY['total'], 'numeric'),
  ('st_invoice', 15, 'paid', ARRAY['paid'], 'boolean'),
  ('st_invoice', 16, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_invoice', 17, 'billing_reason', ARRAY['billing_reason'], 'text'),
  ('st_invoice', 18, 'created', ARRAY['created'], 'timestamptz'),
  ('st_invoice', 19, 'due_date', ARRAY['due_date'], 'timestamptz'),
  ('st_invoice', 20, 'period_start', ARRAY['period_start'], 'timestamptz'),
  ('st_invoice', 21, 'period_end', ARRAY['period_end'], 'timestamptz'),
  ('st_invoice', 22, 'status_paid_at', ARRAY['status_transitions_paid_at'], 'timestamptz'),
  ('st_invoice_line', 1, 'id', ARRAY['id', 'unique_id'], 'text'),
  ('st_invoice_line', 2, 'invoice_id', ARRAY['invoice_id', 'invoice'], 'text'),
  ('st_invoice_line', 3, 'price_id', ARRAY['price_id', 'price'], 'text'),
  ('st_invoice_line', 4, 'subscription_id', ARRAY['subscription_id', 'subscription'], 'text'),
  ('st_invoice_line', 5, 'description', ARRAY['description'], 'text'),
  ('st_invoice_line', 6, 'currency', ARRAY['currency'], 'text'),
  ('st_invoice_line', 7, 'amount', ARRAY['amount'], 'numeric'),
  ('st_invoice_line', 8, 'quantity', ARRAY['quantity'], 'numeric'),
  ('st_invoice_line', 9, 'proration', ARRAY['proration'], 'boolean'),
  ('st_invoice_line', 10, 'type', ARRAY['type'], 'text'),
  ('st_subscription', 1, 'id', ARRAY['id'], 'text'),
  ('st_subscription', 2, 'status', ARRAY['status'], 'text'),
  ('st_subscription', 3, 'customer_id', ARRAY['customer_id', 'customer'], 'text'),
  ('st_subscription', 4, 'latest_invoice_id', ARRAY['latest_invoice_id', 'latest_invoice'], 'text'),
  ('st_subscription', 5, 'cancel_at_period_end', ARRAY['cancel_at_period_end'], 'boolean'),
  ('st_subscription', 6, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_subscription', 7, 'created', ARRAY['created'], 'timestamptz'),
  ('st_subscription', 8, 'start_date', ARRAY['start_date'], 'timestamptz'),
  ('st_subscription', 9, 'current_period_start', ARRAY['current_period_start'], 'timestamptz'),
  ('st_subscription', 10, 'current_period_end', ARRAY['current_period_end'], 'timestamptz'),
  ('st_subscription', 11, 'cancel_at', ARRAY['cancel_at'], 'timestamptz'),
  ('st_subscription', 12, 'canceled_at', ARRAY['canceled_at'], 'timestamptz'),
  ('st_subscription', 13, 'ended_at', ARRAY['ended_at'], 'timestamptz'),
  ('st_subscription_item', 1, 'id', ARRAY['id'], 'text'),
  ('st_subscription_item', 2, 'subscription_id', ARRAY['subscription_id', 'subscription'], 'text'),
  ('st_subscription_item', 3, 'price_id', ARRAY['price_id', 'price', 'plan'], 'text'),
  ('st_subscription_item', 4, 'quantity', ARRAY['quantity'], 'numeric'),
  ('st_subscription_item', 5, 'created', ARRAY['created'], 'timestamptz'),
  ('st_product', 1, 'id', ARRAY['id'], 'text'),
  ('st_product', 2, 'name', ARRAY['name'], 'text'),
  ('st_product', 3, 'description', ARRAY['description'], 'text'),
  ('st_product', 4, 'type', ARRAY['type'], 'text'),
  ('st_product', 5, 'active', ARRAY['active'], 'boolean'),
  ('st_product', 6, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_product', 7, 'is_deleted', ARRAY['is_deleted'], 'boolean'),
  ('st_product', 8, 'created', ARRAY['created', 'create'], 'timestamptz'),
  ('st_product', 9, 'updated', ARRAY['updated'], 'timestamptz'),
  ('st_price', 1, 'id', ARRAY['id'], 'text'),
  ('st_price', 2, 'product_id', ARRAY['product_id', 'product'], 'text'),
  ('st_price', 3, 'nickname', ARRAY['nickname'], 'text'),
  ('st_price', 4, 'type', ARRAY['type'], 'text'),
  ('st_price', 5, 'currency', ARRAY['currency'], 'text'),
  ('st_price', 6, 'unit_amount', ARRAY['unit_amount'], 'numeric'),
  ('st_price', 7, 'active', ARRAY['active'], 'boolean'),
  ('st_price', 8, 'recurring_interval', ARRAY['recurring_interval'], 'text'),
  ('st_price', 9, 'recurring_interval_count', ARRAY['recurring_interval_count'], 'numeric'),
  ('st_price', 10, 'created', ARRAY['created'], 'timestamptz'),
  ('st_payout', 1, 'id', ARRAY['id'], 'text'),
  ('st_payout', 2, 'amount', ARRAY['amount'], 'numeric'),
  ('st_payout', 3, 'currency', ARRAY['currency'], 'text'),
  ('st_payout', 4, 'status', ARRAY['status'], 'text'),
  ('st_payout', 5, 'type', ARRAY['type'], 'text'),
  ('st_payout', 6, 'method', ARRAY['method'], 'text'),
  ('st_payout', 7, 'automatic', ARRAY['automatic'], 'boolean'),
  ('st_payout', 8, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_payout', 9, 'description', ARRAY['description'], 'text'),
  ('st_payout', 10, 'created', ARRAY['created'], 'timestamptz'),
  ('st_payout', 11, 'arrival_date', ARRAY['arrival_date'], 'timestamptz'),
  ('st_balance_transaction', 1, 'id', ARRAY['id'], 'text'),
  ('st_balance_transaction', 2, 'amount', ARRAY['amount'], 'numeric'),
  ('st_balance_transaction', 3, 'fee', ARRAY['fee'], 'numeric'),
  ('st_balance_transaction', 4, 'net', ARRAY['net'], 'numeric'),
  ('st_balance_transaction', 5, 'currency', ARRAY['currency'], 'text'),
  ('st_balance_transaction', 6, 'type', ARRAY['type'], 'text'),
  ('st_balance_transaction', 7, 'reporting_category', ARRAY['reporting_category'], 'text'),
  ('st_balance_transaction', 8, 'status', ARRAY['status'], 'text'),
  ('st_balance_transaction', 9, 'source', ARRAY['source'], 'text'),
  ('st_balance_transaction', 10, 'description', ARRAY['description'], 'text'),
  ('st_balance_transaction', 11, 'created', ARRAY['created'], 'timestamptz'),
  ('st_balance_transaction', 12, 'available_on', ARRAY['available_on'], 'timestamptz'),
  ('st_payout_balance_transaction', 1, 'payout_id', ARRAY['payout_id'], 'text'),
  ('st_payout_balance_transaction', 2, 'balance_transaction_id', ARRAY['balance_transaction_id'], 'text'),
  ('st_checkout_session', 1, 'id', ARRAY['id'], 'text'),
  ('st_checkout_session', 2, 'status', ARRAY['status'], 'text'),
  ('st_checkout_session', 3, 'mode', ARRAY['mode'], 'text'),
  ('st_checkout_session', 4, 'payment_status', ARRAY['payment_status'], 'text'),
  ('st_checkout_session', 5, 'customer_id', ARRAY['customer_id', 'customer'], 'text'),
  ('st_checkout_session', 6, 'payment_intent_id', ARRAY['payment_intent_id', 'payment_intent'], 'text'),
  ('st_checkout_session', 7, 'subscription_id', ARRAY['subscription_id', 'subscription'], 'text'),
  ('st_checkout_session', 8, 'currency', ARRAY['currency'], 'text'),
  ('st_checkout_session', 9, 'amount_total', ARRAY['amount_total'], 'numeric'),
  ('st_checkout_session', 10, 'amount_subtotal', ARRAY['amount_subtotal'], 'numeric'),
  ('st_checkout_session', 11, 'created', ARRAY['created'], 'timestamptz'),
  ('st_application_fee', 1, 'id', ARRAY['id'], 'text'),
  ('st_application_fee', 2, 'amount', ARRAY['amount'], 'numeric'),
  ('st_application_fee', 3, 'amount_refunded', ARRAY['amount_refunded'], 'numeric'),
  ('st_application_fee', 4, 'currency', ARRAY['currency'], 'text'),
  ('st_application_fee', 5, 'charge_id', ARRAY['charge_id', 'charge'], 'text'),
  ('st_application_fee', 6, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_application_fee', 7, 'created', ARRAY['created'], 'timestamptz'),
  ('st_transfer', 1, 'id', ARRAY['id'], 'text'),
  ('st_transfer', 2, 'amount', ARRAY['amount'], 'numeric'),
  ('st_transfer', 3, 'amount_reversed', ARRAY['amount_reversed'], 'numeric'),
  ('st_transfer', 4, 'currency', ARRAY['currency'], 'text'),
  ('st_transfer', 5, 'destination', ARRAY['destination'], 'text'),
  ('st_transfer', 6, 'reversed', ARRAY['reversed'], 'boolean'),
  ('st_transfer', 7, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_transfer', 8, 'description', ARRAY['description'], 'text'),
  ('st_transfer', 9, 'created', ARRAY['created'], 'timestamptz'),
  ('st_credit_note', 1, 'id', ARRAY['id'], 'text'),
  ('st_credit_note', 2, 'number', ARRAY['number'], 'text'),
  ('st_credit_note', 3, 'status', ARRAY['status'], 'text'),
  ('st_credit_note', 4, 'type', ARRAY['type'], 'text'),
  ('st_credit_note', 5, 'reason', ARRAY['reason'], 'text'),
  ('st_credit_note', 6, 'invoice_id', ARRAY['invoice_id', 'invoice'], 'text'),
  ('st_credit_note', 7, 'currency', ARRAY['currency'], 'text'),
  ('st_credit_note', 8, 'amount', ARRAY['amount'], 'numeric'),
  ('st_credit_note', 9, 'total', ARRAY['total'], 'numeric'),
  ('st_credit_note', 10, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_credit_note', 11, 'created', ARRAY['created'], 'timestamptz'),
  ('st_coupon', 1, 'id', ARRAY['id'], 'text'),
  ('st_coupon', 2, 'name', ARRAY['name'], 'text'),
  ('st_coupon', 3, 'percent_off', ARRAY['percent_off'], 'numeric'),
  ('st_coupon', 4, 'amount_off', ARRAY['amount_off'], 'numeric'),
  ('st_coupon', 5, 'currency', ARRAY['currency'], 'text'),
  ('st_coupon', 6, 'duration', ARRAY['duration'], 'text'),
  ('st_coupon', 7, 'valid', ARRAY['valid'], 'boolean'),
  ('st_coupon', 8, 'livemode', ARRAY['livemode'], 'boolean'),
  ('st_coupon', 9, 'created', ARRAY['created'], 'timestamptz'),
  ('st_account', 1, 'id', ARRAY['id'], 'text'),
  ('st_account', 2, 'business_profile_name', ARRAY['business_profile_name'], 'text'),
  ('st_account', 3, 'email', ARRAY['email'], 'text'),
  ('st_account', 4, 'country', ARRAY['country'], 'text'),
  ('st_account', 5, 'default_currency', ARRAY['default_currency'], 'text'),
  ('st_account', 6, 'charges_enabled', ARRAY['charges_enabled'], 'boolean'),
  ('st_account', 7, 'payouts_enabled', ARRAY['payouts_enabled'], 'boolean'),
  ('st_account', 8, 'type', ARRAY['type'], 'text')
ON CONFLICT (view_name, column_name) DO UPDATE
  SET ordinal = EXCLUDED.ordinal,
      candidates = EXCLUDED.candidates,
      data_type = EXCLUDED.data_type;

GRANT SELECT ON ingestion.stripe_contract_views, ingestion.stripe_contract_columns
  TO transform_rw, diagnostic_ro, semantic_ro;

CREATE OR REPLACE FUNCTION ingestion.rebuild_stripe_official_views()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  rebuilt integer := 0;
  contract record;
  source_rel regclass;
  source_name text;
  body text;
  select_list text;
  id_expr text;
  deleted_pred text;
  extra_pred text;
  col record;
  table_name text;
  column_rec record;
BEGIN
  FOR contract IN
    SELECT view_name, source_tables
      FROM ingestion.stripe_contract_views
     ORDER BY view_name
  LOOP
    source_rel := ingestion.stripe_first_rel('source_stripe_fivetran', contract.source_tables);
    source_name := ingestion.stripe_rel_name(source_rel);
    select_list := '';
    FOR col IN
      SELECT column_name, candidates, data_type
        FROM ingestion.stripe_contract_columns
       WHERE view_name = contract.view_name
       ORDER BY ordinal
    LOOP
      IF select_list <> '' THEN
        select_list := select_list || ', ';
      END IF;
      select_list := select_list || format(
        '%s AS %I',
        ingestion.stripe_attr_sql(source_rel, 'src', col.candidates, col.data_type),
        col.column_name
      );
    END LOOP;
    IF source_rel IS NULL THEN
      body := format(
        'SELECT NULL::text AS tenant_id, NULL::text AS row_key, %s WHERE false',
        (
          SELECT string_agg(format('NULL::%s AS %I', data_type, column_name), ', ' ORDER BY ordinal)
            FROM ingestion.stripe_contract_columns
           WHERE view_name = contract.view_name
        )
      );
    ELSE
      id_expr := ingestion.stripe_attr_sql(
        source_rel, 'src',
        CASE WHEN contract.view_name = 'st_payout_balance_transaction'
          THEN ARRAY['payout_id'] ELSE ARRAY['id', 'unique_id', '_fivetran_id'] END,
        'text'
      );
      IF contract.view_name = 'st_payout_balance_transaction' THEN
        id_expr := format(
          '%s || '':'' || %s',
          ingestion.stripe_attr_sql(source_rel, 'src', ARRAY['payout_id'], 'text'),
          ingestion.stripe_attr_sql(source_rel, 'src', ARRAY['balance_transaction_id'], 'text')
        );
      END IF;
      extra_pred := 'true';
      IF contract.view_name = 'st_subscription' AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute
         WHERE attrelid = source_rel AND attname = '_fivetran_active' AND NOT attisdropped
      ) THEN
        extra_pred := 'COALESCE(src._fivetran_active, true)';
      END IF;
      deleted_pred := ingestion.stripe_attr_sql(source_rel, 'src', ARRAY['_fivetran_deleted'], 'boolean');
      body := format(
        $sql$
          SELECT src.tenant_id,
                 src.tenant_id || ':' || %s AS row_key,
                 %s
            FROM source_stripe_fivetran.%I AS src
           WHERE src.tenant_id = (SELECT ingestion.current_tenant_id())
             AND NOT COALESCE(%s, false)
             AND %s
        $sql$,
        id_expr, select_list, source_name, deleted_pred, extra_pred
      );
    END IF;
    PERFORM ingestion.replace_stripe_official_view(contract.view_name, body);
    rebuilt := rebuilt + 1;
  END LOOP;

  FOR table_name IN
    SELECT erd.table_name
      FROM ingestion.stripe_erd_tables AS erd
     WHERE erd.table_name NOT IN (
       'charge', 'payment_intent', 'refund', 'dispute', 'customer', 'invoice',
       'invoice_line', 'invoice_line_item', 'subscription', 'subscription_history',
       'subscription_item', 'product', 'price', 'payout', 'balance_transaction',
       'payout_balance_transaction', 'checkout_session', 'application_fee',
       'transfer', 'credit_note', 'coupon', 'account'
     )
     ORDER BY erd.table_name
  LOOP
    source_rel := ingestion.stripe_rel('source_stripe_fivetran', table_name);
    IF source_rel IS NULL THEN
      body := $sql$ SELECT NULL::text AS tenant_id, NULL::text AS row_key, NULL::text AS id WHERE false $sql$;
    ELSE
      id_expr := ingestion.stripe_attr_sql(source_rel, 'src', ARRAY['id', '_fivetran_id'], 'text');
      select_list := format('src.tenant_id, src.tenant_id || '':'' || %s AS row_key', id_expr);
      FOR column_rec IN
        SELECT attribute.attname AS name, format_type(attribute.atttypid, attribute.atttypmod) AS type
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = source_rel
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attname NOT IN ('tenant_id', '_fivetran_synced', '_fivetran_id')
         ORDER BY attribute.attnum
      LOOP
        IF column_rec.name = '_fivetran_deleted' THEN
          CONTINUE;
        END IF;
        select_list := select_list || format(', src.%I::%s AS %I', column_rec.name, column_rec.type, column_rec.name);
      END LOOP;
      deleted_pred := ingestion.stripe_attr_sql(source_rel, 'src', ARRAY['_fivetran_deleted'], 'boolean');
      body := format(
        'SELECT %s FROM source_stripe_fivetran.%I AS src WHERE src.tenant_id = (SELECT ingestion.current_tenant_id()) AND NOT COALESCE(%s, false)',
        select_list, table_name, deleted_pred
      );
    END IF;
    PERFORM ingestion.replace_stripe_official_view('st_' || table_name, body);
    rebuilt := rebuilt + 1;
  END LOOP;

  PERFORM ingestion.replace_stripe_official_view('st_source_catalog', $sql$
    SELECT
      (SELECT ingestion.current_tenant_id()) AS tenant_id,
      (SELECT ingestion.current_tenant_id()) || ':' || erd.table_name AS row_key,
      erd.table_name,
      CASE
        WHEN erd.table_name IN (
          'charge', 'payment_intent', 'refund', 'dispute', 'customer', 'invoice',
          'invoice_line', 'invoice_line_item', 'subscription', 'subscription_history',
          'subscription_item', 'product', 'price', 'payout', 'balance_transaction',
          'payout_balance_transaction', 'checkout_session', 'application_fee',
          'transfer', 'credit_note', 'coupon', 'account'
        ) THEN CASE erd.table_name
          WHEN 'invoice_line_item' THEN 'st_invoice_line'
          WHEN 'subscription_history' THEN 'st_subscription'
          ELSE 'st_' || erd.table_name
        END
        ELSE 'st_' || erd.table_name
      END AS official_view,
      to_regclass(format('source_stripe_fivetran.%I', erd.table_name)) IS NOT NULL AS landed
    FROM ingestion.stripe_erd_tables AS erd
  $sql$);
  rebuilt := rebuilt + 1;
  RETURN rebuilt;
END;
$$;

GRANT EXECUTE ON FUNCTION ingestion.rebuild_stripe_official_views() TO ingest_rw, transform_rw;

SELECT ingestion.rebuild_stripe_official_views();

COMMENT ON SCHEMA source_stripe IS
  'Official Stripe views over Fivetran ERD unions. Cubes read st_* only.';
COMMENT ON SCHEMA source_stripe_fivetran IS
  'Union of tenant-isolated Fivetran Stripe destination schemas.';

COMMIT;
