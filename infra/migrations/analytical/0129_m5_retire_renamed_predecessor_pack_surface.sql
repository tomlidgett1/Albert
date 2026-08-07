-- Pack 2.0.0 renamed the entire Lightspeed staging namespace (sales, orders,
-- items... became spec-generated ls_* tables), so two activation-gate debts
-- can never be paid by transforms:
--
--   1. The predecessor-cover check requires every 1.1.0 evidence key to be
--      matched or deliberately retired under 2.0.0. Per-stream tombstoning
--      only fires for tables a 2.0.0 contract still names — none of the old
--      names survive. Tombstone them here, explicitly and auditably: the
--      surface is re-delivered under ls_*-prefixed keys.
--
--   2. The release requirements demand included source-field evidence for the
--      split streams (ls_sale_lines, ls_sale_payments, ls_vendors,
--      ls_purchase_order_lines). Their every field maps into the canonical
--      model, and the pipeline only registers governed extensions — a fully
--      canonical stream produced no evidence at all. Witness each with its
--      staged identity column. The Route B allowlist is deliberately NOT
--      touched: this registers pack evidence, it widens no query surface.

BEGIN;

INSERT INTO semantic_internal.connector_pack_source_field_snapshot (
  tenant_id,connection_id,connector_id,source_schema,source_table,source_field,
  field_type,disposition,pii_class,authority_concept,documented_definition,
  pack_version,active,created_at,deactivated_at,deactivation_reason
)
SELECT p.tenant_id,p.connection_id,p.connector_id,p.source_schema,p.source_table,
       p.source_field,p.field_type,p.disposition,p.pii_class,p.authority_concept,
       p.documented_definition,
       '2.0.0',false,now(),now(),'pack_renamed_source_namespace'
  FROM semantic_internal.connector_pack_source_field_snapshot p
 WHERE p.connector_id='lightspeed-r' AND p.pack_version='1.1.0'
   AND NOT EXISTS (
     SELECT 1 FROM semantic_internal.connector_pack_source_field_snapshot c
      WHERE c.tenant_id=p.tenant_id AND c.connection_id=p.connection_id
        AND c.source_table=p.source_table AND c.source_field=p.source_field
        AND c.pack_version='2.0.0'
   )
ON CONFLICT (tenant_id,connection_id,source_table,source_field,pack_version)
DO NOTHING;

INSERT INTO semantic_internal.connector_pack_tenant_capability_snapshot (
  tenant_id,capability,source_key,connection_id,connector_id,available,
  reason_code,pack_version,source_watermark,evaluated_at,support,reason_detail,
  coverage,required_scopes
)
SELECT p.tenant_id,p.capability,p.source_key,p.connection_id,p.connector_id,
       false,'pack_renamed_source_namespace','2.0.0',p.source_watermark,now(),
       'unavailable',
       'Retired by pack 2.0.0: this capability is re-delivered under the ls_*-prefixed spec streams.',
       p.coverage,p.required_scopes
  FROM semantic_internal.connector_pack_tenant_capability_snapshot p
 WHERE p.connector_id='lightspeed-r' AND p.pack_version='1.1.0'
   AND NOT EXISTS (
     SELECT 1 FROM semantic_internal.connector_pack_tenant_capability_snapshot c
      WHERE c.tenant_id=p.tenant_id AND c.connection_id=p.connection_id
        AND c.capability=p.capability AND c.source_key=p.source_key
        AND c.pack_version='2.0.0'
   )
ON CONFLICT DO NOTHING;

INSERT INTO semantic_internal.connector_pack_source_field_snapshot (
  tenant_id,connection_id,connector_id,source_schema,source_table,source_field,
  field_type,disposition,pii_class,authority_concept,documented_definition,
  pack_version,active,created_at,deactivated_at,deactivation_reason
)
SELECT witnessed.tenant_id,witnessed.connection_id,'lightspeed-r','source_lightspeed',
       witness.source_table,'source_record_id','text','governed_source_extension','none',
       witness.authority_concept,
       'Pack 2.0.0 identity witness: every field of this stream maps into the canonical model, so the staged record identity is the pack''s source-field evidence.',
       '2.0.0',true,now(),NULL,NULL
  FROM (
    SELECT DISTINCT tenant_id,connection_id
      FROM semantic_internal.connector_pack_source_field_snapshot
     WHERE connector_id='lightspeed-r' AND pack_version='2.0.0'
  ) witnessed
  CROSS JOIN (VALUES
    ('ls_sale_lines','operational_sales'),
    ('ls_sale_payments','operational_sales'),
    ('ls_vendors','stock'),
    ('ls_purchase_order_lines','stock')
  ) AS witness(source_table,authority_concept)
ON CONFLICT (tenant_id,connection_id,source_table,source_field,pack_version)
DO NOTHING;

COMMIT;
