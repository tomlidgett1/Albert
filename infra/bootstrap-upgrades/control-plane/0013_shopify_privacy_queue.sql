BEGIN;

-- Existing control-plane databases predate the isolated Shopify customer
-- privacy queue. Fresh databases receive the same installer from
-- control_plane_role.sql. Migration 0130 consumes this fixed-input helper.
CREATE OR REPLACE FUNCTION extensions.albert_install_shopify_privacy_queue()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pgmq.meta WHERE queue_name = 'albert_shopify_privacy'
  ) THEN
    PERFORM pgmq.create('albert_shopify_privacy');
  END IF;
  GRANT ALL PRIVILEGES ON TABLE
    pgmq.q_albert_shopify_privacy,
    pgmq.a_albert_shopify_privacy
  TO albert_control_migration_owner;
  GRANT ALL PRIVILEGES ON SEQUENCE pgmq.q_albert_shopify_privacy_msg_id_seq
  TO albert_control_migration_owner;
END;
$$;

ALTER FUNCTION extensions.albert_install_shopify_privacy_queue()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION extensions.albert_install_shopify_privacy_queue()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_deletion_control;
GRANT EXECUTE ON FUNCTION extensions.albert_install_shopify_privacy_queue()
  TO albert_control_migration_owner;

COMMIT;
