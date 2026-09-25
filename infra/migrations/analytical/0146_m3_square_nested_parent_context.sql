BEGIN;

-- Square child-list objects do not consistently echo the identifier used in
-- the endpoint path. Preserve that request evidence beside (never inside) the
-- immutable API payload so semantic and canonical joins can use the true
-- parent without parsing a composite landing identity.
DO $migration$
DECLARE
  source_table text;
BEGIN
  FOR source_table IN
    SELECT table_name
    FROM (VALUES
      ('square_merchants'),
      ('square_locations'),
      ('square_merchant_custom_attribute_definitions'),
      ('square_merchant_custom_attributes'),
      ('square_location_custom_attribute_definitions'),
      ('square_location_custom_attributes'),
      ('square_orders'),
      ('square_order_custom_attribute_definitions'),
      ('square_order_custom_attributes'),
      ('square_payments'),
      ('square_refunds'),
      ('square_payment_links'),
      ('square_checkout_merchant_settings'),
      ('square_checkout_location_settings'),
      ('square_catalog_objects'),
      ('square_inventory_counts'),
      ('square_inventory_changes'),
      ('square_inventory_adjustment_reasons'),
      ('square_transfer_orders'),
      ('square_customers'),
      ('square_customer_custom_attribute_definitions'),
      ('square_customer_custom_attributes'),
      ('square_customer_groups'),
      ('square_customer_segments'),
      ('square_jobs'),
      ('square_team_members'),
      ('square_team_member_wage_settings'),
      ('square_break_types'),
      ('square_scheduled_shifts'),
      ('square_timecards'),
      ('square_team_member_wages'),
      ('square_workweek_configs'),
      ('square_cash_drawer_shifts'),
      ('square_cash_drawer_shift_events'),
      ('square_payouts'),
      ('square_payout_entries'),
      ('square_bank_accounts'),
      ('square_cards'),
      ('square_gift_cards'),
      ('square_gift_card_activities'),
      ('square_loyalty_accounts'),
      ('square_loyalty_events'),
      ('square_loyalty_programs'),
      ('square_loyalty_promotions'),
      ('square_loyalty_rewards'),
      ('square_invoices'),
      ('square_subscriptions'),
      ('square_subscription_events'),
      ('square_bookings'),
      ('square_booking_custom_attribute_definitions'),
      ('square_booking_custom_attributes'),
      ('square_booking_business_profile'),
      ('square_booking_location_profiles'),
      ('square_booking_team_member_profiles'),
      ('square_disputes'),
      ('square_dispute_evidence'),
      ('square_vendors'),
      ('square_channels'),
      ('square_devices'),
      ('square_sites'),
      ('square_snippets'),
      ('square_terminal_actions'),
      ('square_terminal_checkouts'),
      ('square_terminal_refunds')
    ) AS declared_square_stream(table_name)
  LOOP
    EXECUTE format(
      'ALTER TABLE source_square.%I ADD COLUMN IF NOT EXISTS parent_context jsonb NOT NULL DEFAULT ''{}''::jsonb',
      source_table
    );
    EXECUTE format(
      'ALTER TABLE source_square.%I ADD CONSTRAINT %I CHECK (jsonb_typeof(parent_context) = ''object'')',
      source_table,
      source_table || '_parent_context_object_ck'
    );
  END LOOP;
END
$migration$;

COMMIT;
