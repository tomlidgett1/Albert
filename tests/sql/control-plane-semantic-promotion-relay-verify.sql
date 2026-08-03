\set ON_ERROR_STOP on

DO $$
DECLARE item control_plane.semantic_inbox%ROWTYPE;
BEGIN
  SELECT * INTO STRICT item FROM control_plane.semantic_inbox
   WHERE tenant_id='01H00000000000000000004301'
     AND semantic_inbox_item_id='01H00000000000000000004303';
  IF item.occurrence_count<>2
     OR item.sample_question !~ '^Question content withheld; digest [a-f0-9]{12}$'
     OR item.evidence ? 'question'
     OR item.evidence ? 'rawQuestion'
     OR item.latest_question_digest<>repeat('d',64)
     OR (SELECT count(*) FROM control_plane.semantic_promotion_deliveries delivery
          WHERE delivery.tenant_id=item.tenant_id
            AND delivery.semantic_inbox_item_id=item.semantic_inbox_item_id)<>2
     OR (SELECT count(*) FROM control_plane.audit_log audit
          WHERE audit.tenant_id=item.tenant_id
            AND audit.action='semantic.promotion_candidate_accepted'
            AND audit.resource_id=item.semantic_inbox_item_id)<>2 THEN
    RAISE EXCEPTION 'durable semantic inbox projection evidence is invalid';
  END IF;
END;
$$;
