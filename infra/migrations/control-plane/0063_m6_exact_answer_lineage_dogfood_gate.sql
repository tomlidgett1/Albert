BEGIN;

-- M6 is release evidence, not a topic/count smoke test.  These reviewed case
-- contracts are intentionally database-owned so the diagnostic collector
-- cannot choose a friendlier question, lens, period or trace shape at runtime.
CREATE TABLE IF NOT EXISTS control_plane.protected_dogfood_answer_case_contracts (
  case_key text PRIMARY KEY CHECK (case_key IN ('flagship','category')),
  contract_version integer NOT NULL CHECK (contract_version>0),
  contract jsonb NOT NULL CHECK (
    jsonb_typeof(contract)='object'
    AND contract ?& ARRAY['schemaVersion','caseKey']
  ),
  contract_digest text NOT NULL UNIQUE CHECK (contract_digest ~ '^[a-f0-9]{64}$'),
  CHECK (contract_digest=control_plane.dogfood_evidence_sha256(contract)),
  CHECK ((contract->>'schemaVersion')::integer IS NOT DISTINCT FROM contract_version),
  CHECK (contract->>'caseKey' IS NOT DISTINCT FROM case_key)
);

INSERT INTO control_plane.protected_dogfood_answer_case_contracts(
  case_key,contract_version,contract,contract_digest
)
SELECT case_key,1,contract,control_plane.dogfood_evidence_sha256(contract)
FROM (VALUES
  ('flagship', $flagship$
    {
      "schemaVersion": 1,
      "caseKey": "flagship",
      "caseId": "workforce-best-net-sales",
      "initialQuestion": "Which of my employees working today performed best over the last six months?",
      "clarificationQuestion": "What should ‘performed best’ mean for this answer?",
      "clarificationOptions": [
        {"id":"employee.gross_margin","label":"Gross profit"},
        {"id":"employee.gross_profit_per_labour_hour","label":"Gross profit per worked hour"},
        {"id":"employee.net_sales","label":"Net sales"}
      ],
      "confirmation": {
        "optionId": "employee.net_sales",
        "label": "Net sales",
        "preference": "employee.performance_default",
        "value": "commerce.net_sales_ex_gst"
      },
      "answerQuestion": "Net sales",
      "answerStates": ["verified","qualified"],
      "rosterIr": {
        "kind":"single",
        "topic":"workforce_labour",
        "metrics":["rostered_hours"],
        "dimensions":["worker"],
        "filters":[],
        "time":{"field":"business_date","range":{"type":"today"},"compare":"none"},
        "sort":[{"metric":"rostered_hours","dir":"desc"}],
        "limit":50,
        "parameters":{}
      },
      "performanceIr": {
        "kind":"composite",
        "topic":"workforce_sales",
        "metrics":["sales_per_labour_hour"],
        "alignOn":["worker"],
        "selectedLens":"net_sales_ex_gst",
        "salesMetric":"net_sales_ex_gst",
        "labourMetric":"worked_hours",
        "rangeType":"absolute",
        "rangeMonths":6,
        "sort":[{"metric":"net_sales_ex_gst","dir":"desc"}],
        "limit":50,
        "parameters":{}
      },
      "trace": {
        "queryCount":2,
        "tableCount":2,
        "minimumNarrativeCount":4,
        "minimumValidationCount":2,
        "minimumChartCount":0
      }
    }
  $flagship$::jsonb),
  ('category', $category$
    {
      "schemaVersion": 1,
      "caseKey": "category",
      "caseId": "sales-category",
      "question": "Which categories are performing well this month?",
      "answerStates": ["verified","qualified"],
      "normalizedIr": {
        "kind":"single",
        "topic":"sales_performance",
        "metrics":["net_sales_ex_gst"],
        "dimensions":["product.category"],
        "filters":[],
        "time":{"field":"business_date","range":{"type":"month_to_date"},"compare":"none"},
        "sort":[{"metric":"net_sales_ex_gst","dir":"desc"}],
        "limit":20,
        "parameters":{"category_mode":"as_currently_classified"}
      },
      "trace": {
        "queryCount":1,
        "tableCount":1,
        "minimumNarrativeCount":3,
        "minimumValidationCount":1,
        "minimumChartCount":1
      }
    }
  $category$::jsonb)
) AS seed(case_key,contract)
ON CONFLICT(case_key) DO UPDATE SET
  contract_version=excluded.contract_version,
  contract=excluded.contract,
  contract_digest=excluded.contract_digest;

-- Node's contentDigest uses a whitespace-free, recursively key-sorted JSON
-- encoding.  Reproduce that encoding so a visible table must hash to the
-- immutable analytical query result it claims to render.
CREATE OR REPLACE FUNCTION control_plane.dogfood_stable_json_text(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path=pg_catalog
AS $$
DECLARE rendered text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(
        to_jsonb(entry.key)::text||':'||control_plane.dogfood_stable_json_text(entry.value),
        ',' ORDER BY entry.key
      ),'')||'}'
        INTO rendered
        FROM jsonb_each(p_value) entry;
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(
        control_plane.dogfood_stable_json_text(item.value),
        ',' ORDER BY item.ordinal
      ),'')||']'
        INTO rendered
        FROM jsonb_array_elements(p_value) WITH ORDINALITY item(value,ordinal);
    ELSE
      rendered:=p_value::text;
  END CASE;
  RETURN rendered;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.dogfood_stable_json_sha256(p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path=pg_catalog
AS $$
  SELECT encode(extensions.digest(
    convert_to(control_plane.dogfood_stable_json_text(p_value),'UTF8'),'sha256'
  ),'hex')
$$;

-- Recompute both content addresses from the stored immutable columns.  This
-- prevents a hand-inserted row with merely well-shaped digest strings from
-- becoming release evidence.
CREATE OR REPLACE FUNCTION control_plane.protected_dogfood_answer_artifact_digests(
  p_tenant_id text,
  p_answer_artifact_id text
) RETURNS TABLE(calculated_trace_digest text,calculated_artifact_digest text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  WITH selected AS (
    SELECT artifact.*
      FROM control_plane.answer_artifacts artifact
     WHERE artifact.tenant_id=p_tenant_id
       AND artifact.answer_artifact_id=p_answer_artifact_id
  ),trace AS (
    SELECT coalesce(jsonb_agg(event.event_payload ORDER BY event.sequence_number),'[]'::jsonb)
             AS document
      FROM control_plane.answer_execution_events event
     WHERE event.tenant_id=p_tenant_id
       AND event.answer_artifact_id=p_answer_artifact_id
  ),documents AS (
    SELECT selected.*,trace.document AS trace_document,
           control_plane.dogfood_evidence_sha256(trace.document) AS trace_hash
      FROM selected CROSS JOIN trace
  )
  SELECT document.trace_hash,
         control_plane.dogfood_evidence_sha256(jsonb_build_object(
           'schemaVersion',1,
           'tenantId',document.tenant_id,
           'conversationId',document.conversation_id,
           'turnId',document.turn_id,
           'turnNumber',document.turn_number,
           'questionText',document.question_text,
           'answerState',document.answer_state,
           'finalNarrative',document.answer_text,
           'interpretedPlan',document.interpreted_plan,
           'semanticIr',document.semantic_ir,
           'queryExecutions',document.query_executions,
           'resultDigest',document.result_digest,
           'validationOutcomes',document.validation_outcomes,
           'provenance',document.provenance,
           'semanticBundleHash',document.semantic_bundle_hash,
           'traceDigest',document.trace_hash,
           'runtimeProfile',document.runtime_profile,
           'providerResponseId',document.provider_response_id,
           'providerUsage',document.provider_usage,
           'modelUsageDigest',document.model_usage_digest
         ))
    FROM documents document
$$;

CREATE OR REPLACE FUNCTION control_plane.dogfood_answer_artifact_evidence(
  p_tenant_id text,p_answer_artifact_id text,p_kind text,p_category_topic text,
  p_barrier_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE artifact control_plane.answer_artifacts%ROWTYPE;
DECLARE clarification_artifact control_plane.answer_artifacts%ROWTYPE;
DECLARE contract jsonb;contract_version integer;contract_digest text;
DECLARE calculated_trace text;calculated_artifact text;
DECLARE clarification_trace text;clarification_digest text;
DECLARE trace_document jsonb;query_plan_document jsonb;provenance_document jsonb;
DECLARE query_count integer;event_count integer;query_event_count integer;
DECLARE table_count integer;answer_count integer;
DECLARE narrative_count integer;chart_count integer;validation_count integer;
DECLARE first_query integer;last_answer integer;previous_boundary integer:=0;
DECLARE query_record record;query_item jsonb;ir jsonb;table_event jsonb;
DECLARE table_sequence integer;observation_sequence integer;next_boundary integer;
DECLARE expected_dimensions jsonb;required_metric text;required_connectors text[];
DECLARE visible_result_digest text;from_text text;to_text text;
DECLARE from_at timestamptz;to_at timestamptz;question_binding jsonb;
DECLARE question_digest text;semantic_plan_digest text;trace_contract_digest text;
DECLARE provenance_digest text;lineage_binding_digest text;result jsonb;
BEGIN
  IF coalesce(p_kind,'') NOT IN ('flagship','category')
     OR coalesce(control_plane.is_ulid(p_tenant_id),false) IS NOT TRUE
     OR coalesce(control_plane.is_ulid(p_answer_artifact_id),false) IS NOT TRUE
     OR p_barrier_at IS NULL OR p_barrier_at>clock_timestamp()
     OR p_category_topic IS DISTINCT FROM 'sales_performance' THEN
    RAISE EXCEPTION 'dogfood answer case input is invalid' USING ERRCODE='22023';
  END IF;

  SELECT expected.contract_version,expected.contract,expected.contract_digest
    INTO contract_version,contract,contract_digest
    FROM control_plane.protected_dogfood_answer_case_contracts expected
   WHERE expected.case_key=p_kind;
  IF contract IS NULL OR contract_version IS DISTINCT FROM 1
     OR contract_digest IS DISTINCT FROM control_plane.dogfood_evidence_sha256(contract) THEN
    RAISE EXCEPTION 'dogfood answer case contract is unavailable' USING ERRCODE='55000';
  END IF;

  SELECT * INTO artifact
    FROM control_plane.answer_artifacts candidate
   WHERE candidate.tenant_id=p_tenant_id
     AND candidate.answer_artifact_id=p_answer_artifact_id;
  IF NOT FOUND OR artifact.finalized_at IS NULL
     OR artifact.created_at<p_barrier_at OR artifact.finalized_at<p_barrier_at
     OR artifact.finalized_at<artifact.created_at
     OR coalesce(artifact.answer_state,'') NOT IN ('verified','qualified')
     OR coalesce(contract->'answerStates' ? artifact.answer_state,false) IS NOT TRUE
     OR artifact.compiled_sql IS NOT NULL
     OR artifact.turn_id IS NULL
     OR artifact.provider_response_id IS NULL
     OR coalesce(artifact.model_usage_digest,'') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'dogfood answer artifact is not finalized reviewed evidence' USING ERRCODE='55000';
  END IF;

  SELECT calculated_trace_digest,calculated_artifact_digest
    INTO calculated_trace,calculated_artifact
    FROM control_plane.protected_dogfood_answer_artifact_digests(
      p_tenant_id,p_answer_artifact_id
    );
  IF calculated_trace IS DISTINCT FROM artifact.trace_digest
     OR calculated_artifact IS DISTINCT FROM artifact.artifact_digest THEN
    RAISE EXCEPTION 'dogfood answer content addresses do not match the stored lineage'
      USING ERRCODE='55000';
  END IF;

  SELECT coalesce(jsonb_agg(event.event_payload ORDER BY event.sequence_number),'[]'::jsonb),
         count(*),count(*) FILTER (WHERE event.event_type='query'),
         count(*) FILTER (WHERE event.event_type='table'),
         count(*) FILTER (WHERE event.event_type='answer'),
         count(*) FILTER (WHERE event.event_type='narrative'),
         count(*) FILTER (WHERE event.event_type='chart'),
         count(*) FILTER (WHERE event.event_type='validation'),
         min(event.sequence_number) FILTER (WHERE event.event_type='query'),
         max(event.sequence_number) FILTER (WHERE event.event_type='answer')
    INTO trace_document,event_count,query_event_count,table_count,answer_count,
         narrative_count,chart_count,
         validation_count,first_query,last_answer
    FROM control_plane.answer_execution_events event
   WHERE event.tenant_id=p_tenant_id
     AND event.answer_artifact_id=p_answer_artifact_id;
  query_count:=jsonb_array_length(artifact.query_executions);

  IF event_count=0 OR first_query IS NULL OR answer_count IS DISTINCT FROM 1
     OR last_answer IS DISTINCT FROM event_count
     OR (trace_document->(event_count-1)->>'type') IS DISTINCT FROM 'answer'
     OR EXISTS (
       SELECT 1 FROM control_plane.answer_execution_events event
        WHERE event.tenant_id=p_tenant_id
          AND event.answer_artifact_id=p_answer_artifact_id
          AND (
            event.occurred_at<p_barrier_at
            OR event.event_payload->>'sequence' IS NULL
            OR event.sequence_number IS DISTINCT FROM (event.event_payload->>'sequence')::integer
            OR event.event_type IS DISTINCT FROM event.event_payload->>'type'
            OR NOT control_plane.is_ulid(coalesce(event.event_payload->>'id',''))
            OR event.event_payload->>'occurredAt' IS NULL
            OR abs(extract(epoch FROM (
              (event.event_payload->>'occurredAt')::timestamptz-event.occurred_at
            )))>300
            OR event.source_turn_event_id IS NULL
            OR event.conversation_id IS DISTINCT FROM artifact.conversation_id
            OR event.turn_id IS DISTINCT FROM artifact.turn_id
            OR coalesce(event.event_type,'') NOT IN (
              'progress','narrative','query','table','validation','chart','answer'
            )
            OR CASE event.event_type
              WHEN 'progress' THEN event.event_payload->>'status' IS DISTINCT FROM 'running'
              WHEN 'narrative' THEN coalesce(event.event_payload->>'status','') NOT IN ('running','complete')
              WHEN 'validation' THEN coalesce(event.event_payload->>'status','') NOT IN ('complete','warning')
              ELSE event.event_payload->>'status' IS DISTINCT FROM 'complete'
            END
            OR NOT EXISTS (
              SELECT 1
                FROM control_plane.conversation_turn_events source
               WHERE source.tenant_id=event.tenant_id
                 AND source.turn_event_id=event.source_turn_event_id
                 AND source.conversation_id IS NOT DISTINCT FROM event.conversation_id
                 AND source.turn_id IS NOT DISTINCT FROM event.turn_id
                 AND source.sequence_number IS NOT DISTINCT FROM event.sequence_number
                 AND source.event IS NOT DISTINCT FROM event.event_payload
                 AND source.occurred_at IS NOT DISTINCT FROM event.occurred_at
            )
            OR control_plane.trace_event_has_forbidden_key(event.event_payload)
          )
     ) OR EXISTS (
       SELECT expected.sequence_number
         FROM generate_series(1,event_count) expected(sequence_number)
       EXCEPT
       SELECT event.sequence_number
         FROM control_plane.answer_execution_events event
        WHERE event.tenant_id=p_tenant_id
          AND event.answer_artifact_id=p_answer_artifact_id
     ) OR NOT EXISTS (
       SELECT 1 FROM control_plane.answer_execution_events event
        WHERE event.tenant_id=p_tenant_id
          AND event.answer_artifact_id=p_answer_artifact_id
          AND event.event_type='progress'
          AND event.sequence_number<first_query
          AND event.event_payload->>'label'='Understanding the question'
     ) OR NOT EXISTS (
       SELECT 1 FROM control_plane.answer_execution_events event
        WHERE event.tenant_id=p_tenant_id
          AND event.answer_artifact_id=p_answer_artifact_id
          AND event.event_type='narrative'
          AND event.sequence_number<first_query
          AND event.event_payload->>'text'=
            'I’m matching the question to Albert’s governed business definitions.'
     ) OR NOT EXISTS (
       SELECT 1 FROM control_plane.answer_execution_events event
        WHERE event.tenant_id=p_tenant_id
          AND event.answer_artifact_id=p_answer_artifact_id
          AND event.event_type='narrative'
          AND event.sequence_number<first_query
          AND event.event_payload->>'text'=
            'I checked that the connected sources can support this analysis before querying.'
     ) THEN
    RAISE EXCEPTION 'dogfood answer trace is not a contiguous public tool narrative'
      USING ERRCODE='55000';
  END IF;

  IF query_count IS DISTINCT FROM (contract#>>'{trace,queryCount}')::integer
     OR query_event_count IS DISTINCT FROM query_count
     OR table_count IS DISTINCT FROM (contract#>>'{trace,tableCount}')::integer
     OR coalesce(narrative_count,0)<coalesce((contract#>>'{trace,minimumNarrativeCount}')::integer,2147483647)
     OR coalesce(validation_count,0)<coalesce((contract#>>'{trace,minimumValidationCount}')::integer,2147483647)
     OR coalesce(chart_count,0)<coalesce((contract#>>'{trace,minimumChartCount}')::integer,2147483647)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(artifact.query_executions) query
        WHERE jsonb_typeof(query) IS DISTINCT FROM 'object'
           OR NOT (query ?& ARRAY[
             'queryAuditId','route','topic','bundleHash','registryVersion',
             'normalizedIr','compilerOutputHash','resultDigest','answerState','validation'
           ])
           OR query-ARRAY[
             'queryAuditId','route','topic','bundleHash','registryVersion',
             'normalizedIr','compilerOutputHash','resultDigest','answerState','validation'
           ] IS DISTINCT FROM '{}'::jsonb
           OR query->>'route' IS DISTINCT FROM 'semantic'
           OR query->>'topic' IS DISTINCT FROM query#>>'{normalizedIr,topic}'
           OR NOT control_plane.is_ulid(coalesce(query->>'queryAuditId',''))
           OR coalesce(query->>'bundleHash','') !~ '^[a-f0-9]{64}$'
           OR coalesce(query->>'compilerOutputHash','') !~ '^[a-f0-9]{64}$'
           OR coalesce(query->>'resultDigest','') !~ '^[a-f0-9]{64}$'
           OR length(coalesce(query->>'registryVersion','')) NOT BETWEEN 1 AND 160
           OR jsonb_typeof(query->'normalizedIr') IS DISTINCT FROM 'object'
           OR jsonb_typeof(query->'validation') IS DISTINCT FROM 'object'
           OR coalesce(query#>>'{validation,status}','') NOT IN ('passed','warning')
           OR coalesce(query->>'answerState','') NOT IN ('verified','qualified')
     ) THEN
    RAISE EXCEPTION 'dogfood answer query evidence does not match the reviewed case shape'
      USING ERRCODE='55000';
  END IF;

  IF artifact.answer_state='verified' AND (
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(artifact.query_executions) query
       WHERE query->>'answerState' IS DISTINCT FROM 'verified'
          OR query#>>'{validation,status}' IS DISTINCT FROM 'passed'
    ) OR EXISTS (
      SELECT 1 FROM control_plane.answer_execution_events event
       WHERE event.tenant_id=p_tenant_id
         AND event.answer_artifact_id=p_answer_artifact_id
         AND event.event_type='validation'
         AND event.event_payload->>'outcome' IS DISTINCT FROM 'passed'
    )
  ) THEN
    RAISE EXCEPTION 'a Verified dogfood answer contains qualified evidence' USING ERRCODE='55000';
  ELSIF artifact.answer_state='qualified' AND NOT (
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(artifact.query_executions) query
       WHERE query->>'answerState'='qualified'
          OR query#>>'{validation,status}'='warning'
    ) OR EXISTS (
      SELECT 1 FROM control_plane.answer_execution_events event
       WHERE event.tenant_id=p_tenant_id
         AND event.answer_artifact_id=p_answer_artifact_id
         AND event.event_type='validation'
         AND event.event_payload->>'outcome'='qualified'
    )
  ) THEN
    RAISE EXCEPTION 'a Qualified dogfood answer has no durable qualification reason'
      USING ERRCODE='55000';
  END IF;

  IF p_kind='category' THEN
    IF artifact.question_text IS DISTINCT FROM contract->>'question'
       OR artifact.query_executions->0->'normalizedIr' IS DISTINCT FROM contract->'normalizedIr'
       OR artifact.semantic_bundle_hash IS DISTINCT FROM
          artifact.query_executions->0->>'bundleHash' THEN
      RAISE EXCEPTION 'category answer does not bind the reviewed question and semantic IR'
        USING ERRCODE='55000';
    END IF;
    question_binding:=jsonb_build_object('question',artifact.question_text);
  ELSE
    IF artifact.question_text IS DISTINCT FROM contract->>'answerQuestion'
       OR artifact.query_executions->0->'normalizedIr' IS DISTINCT FROM contract->'rosterIr'
       OR artifact.semantic_bundle_hash IS NOT NULL THEN
      RAISE EXCEPTION 'flagship answer does not bind the reviewed roster and lens turn'
        USING ERRCODE='55000';
    END IF;
    ir:=artifact.query_executions->1->'normalizedIr';
    IF ir->>'kind' IS DISTINCT FROM 'composite'
       OR ir->>'topic' IS DISTINCT FROM contract#>>'{performanceIr,topic}'
       OR ir->'metrics' IS DISTINCT FROM contract#>'{performanceIr,metrics}'
       OR ir->'alignOn' IS DISTINCT FROM contract#>'{performanceIr,alignOn}'
       OR ir->'sort' IS DISTINCT FROM contract#>'{performanceIr,sort}'
       OR ir->'parameters' IS DISTINCT FROM contract#>'{performanceIr,parameters}'
       OR (ir->>'limit')::integer IS DISTINCT FROM (contract#>>'{performanceIr,limit}')::integer
       OR jsonb_array_length(ir->'queries') IS DISTINCT FROM 2
       OR ir-ARRAY['kind','topic','metrics','queries','alignOn','sort','limit','parameters'] IS DISTINCT FROM '{}'::jsonb
       OR ir#>>'{queries,0,topic}' IS DISTINCT FROM 'sales_performance'
       OR ir#>'{queries,0,metrics}' IS DISTINCT FROM jsonb_build_array(contract#>>'{performanceIr,salesMetric}')
       OR ir#>'{queries,0,dimensions}' IS DISTINCT FROM '["worker"]'::jsonb
       OR ir#>'{queries,0,parameters}' IS DISTINCT FROM '{}'::jsonb
       OR ir#>>'{queries,1,topic}' IS DISTINCT FROM 'workforce_labour'
       OR ir#>'{queries,1,metrics}' IS DISTINCT FROM jsonb_build_array(contract#>>'{performanceIr,labourMetric}')
       OR ir#>'{queries,1,dimensions}' IS DISTINCT FROM '["worker"]'::jsonb
       OR ir#>'{queries,1,parameters}' IS DISTINCT FROM '{}'::jsonb
       OR ir#>'{queries,0,filters}' IS DISTINCT FROM ir#>'{queries,1,filters}'
       OR jsonb_array_length(ir#>'{queries,0,filters}') IS DISTINCT FROM 1
       OR ir#>>'{queries,0,filters,0,field}' IS DISTINCT FROM 'worker'
       OR ir#>>'{queries,0,filters,0,op}' IS DISTINCT FROM 'in'
       OR jsonb_typeof(ir#>'{queries,0,filters,0,values}') IS DISTINCT FROM 'array'
       OR coalesce(jsonb_array_length(ir#>'{queries,0,filters,0,values}'),0) NOT BETWEEN 1 AND 100
       OR (ir#>'{queries,0,filters,0}')-
          ARRAY['field','op','values'] IS DISTINCT FROM '{}'::jsonb
       OR ir#>'{queries,0,time}' IS DISTINCT FROM ir#>'{queries,1,time}'
       OR ir#>>'{queries,0,time,field}' IS DISTINCT FROM 'business_date'
       OR ir#>>'{queries,0,time,range,type}' IS DISTINCT FROM 'absolute'
       OR ir#>>'{queries,0,time,compare}' IS DISTINCT FROM 'none'
       OR (ir#>'{queries,0,time}')-
          ARRAY['field','range','compare'] IS DISTINCT FROM '{}'::jsonb
       OR (ir#>'{queries,0,time,range}')-
          ARRAY['type','from','to'] IS DISTINCT FROM '{}'::jsonb
       OR ((ir#>'{queries,0}')-
          ARRAY['topic','metrics','dimensions','filters','time','parameters']) IS DISTINCT FROM '{}'::jsonb
       OR ((ir#>'{queries,1}')-
          ARRAY['topic','metrics','dimensions','filters','time','parameters']) IS DISTINCT FROM '{}'::jsonb
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(ir#>'{queries,0,filters,0,values}') value
          WHERE NOT control_plane.is_ulid(value)
       ) OR (
         SELECT count(*) IS DISTINCT FROM count(DISTINCT value)
           FROM jsonb_array_elements_text(ir#>'{queries,0,filters,0,values}') value
       ) THEN
      RAISE EXCEPTION 'flagship answer does not contain the exact aggregate-then-align plan'
        USING ERRCODE='55000';
    END IF;
    from_text:=ir#>>'{queries,0,time,range,from}';
    to_text:=ir#>>'{queries,0,time,range,to}';
    IF from_text IS NULL OR to_text IS NULL THEN
      RAISE EXCEPTION 'flagship six-month range is missing' USING ERRCODE='55000';
    END IF;
    BEGIN
      from_at:=from_text::timestamptz;
      to_at:=to_text::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'flagship six-month range is invalid' USING ERRCODE='55000';
    END;
    IF to_at<=from_at OR from_at+interval '6 months' IS DISTINCT FROM to_at
       OR abs(extract(epoch FROM (artifact.finalized_at-to_at)))>129600 THEN
      RAISE EXCEPTION 'flagship performance range is not exactly six months'
        USING ERRCODE='55000';
    END IF;

    SELECT candidate.* INTO clarification_artifact
      FROM control_plane.answer_artifacts candidate
      JOIN control_plane.conversation_turns offered_turn
        ON offered_turn.tenant_id=candidate.tenant_id
       AND offered_turn.turn_id=candidate.turn_id
      JOIN control_plane.clarification_prompts prompt
        ON prompt.tenant_id=offered_turn.tenant_id
       AND prompt.offered_turn_id=offered_turn.turn_id
      JOIN control_plane.clarification_options selected_option
        ON selected_option.tenant_id=prompt.tenant_id
       AND selected_option.offered_turn_id=prompt.offered_turn_id
       AND selected_option.option_id=prompt.consumed_option_id
     WHERE candidate.tenant_id=p_tenant_id
       AND candidate.conversation_id=artifact.conversation_id
       AND candidate.turn_number=artifact.turn_number-1
       AND candidate.answer_state='clarification'
       AND candidate.question_text=contract->>'initialQuestion'
       AND candidate.answer_text=contract->>'clarificationQuestion'
       AND candidate.created_at>=p_barrier_at
       AND candidate.finalized_at>=p_barrier_at
       AND prompt.question=contract->>'clarificationQuestion'
       AND prompt.consumed_turn_id=artifact.turn_id
       AND prompt.consumed_option_id=contract#>>'{confirmation,optionId}'
       AND prompt.consumed_at>=p_barrier_at
       AND selected_option.option_label=contract#>>'{confirmation,label}'
       AND selected_option.preference_key=contract#>>'{confirmation,preference}'
       AND selected_option.preference_value=contract#>>'{confirmation,value}'
       AND artifact.question_text=selected_option.option_label;
    IF NOT FOUND OR clarification_artifact.query_executions IS DISTINCT FROM '[]'::jsonb
       OR clarification_artifact.finalized_at IS NULL
       OR EXISTS (
         SELECT 1
           FROM control_plane.answer_execution_events clarification_event
          WHERE clarification_event.tenant_id=p_tenant_id
            AND clarification_event.answer_artifact_id=clarification_artifact.answer_artifact_id
            AND clarification_event.occurred_at<p_barrier_at
       )
       OR (
         SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id',option.option_id,'label',option.option_label
         ) ORDER BY option.option_id),'[]'::jsonb)
           FROM control_plane.clarification_options option
          WHERE option.tenant_id=p_tenant_id
            AND option.offered_turn_id=clarification_artifact.turn_id
       ) IS DISTINCT FROM contract->'clarificationOptions' THEN
      RAISE EXCEPTION 'flagship answer is not the one-use reviewed clarification flow'
        USING ERRCODE='55000';
    END IF;
    SELECT calculated_trace_digest,calculated_artifact_digest
      INTO clarification_trace,clarification_digest
      FROM control_plane.protected_dogfood_answer_artifact_digests(
        p_tenant_id,clarification_artifact.answer_artifact_id
      );
    IF clarification_trace IS DISTINCT FROM clarification_artifact.trace_digest
       OR clarification_digest IS DISTINCT FROM clarification_artifact.artifact_digest THEN
      RAISE EXCEPTION 'flagship clarification content addresses are invalid'
        USING ERRCODE='55000';
    END IF;
    question_binding:=jsonb_build_object(
      'initialQuestion',clarification_artifact.question_text,
      'clarificationQuestion',clarification_artifact.answer_text,
      'clarificationArtifactDigest',clarification_artifact.artifact_digest,
      'optionId',contract#>>'{confirmation,optionId}',
      'answerQuestion',artifact.question_text
    );
  END IF;

  -- Match each visible query/table pair to the ordered immutable query audit.
  -- The result hash recomputation binds the exact columns and rows, while the
  -- bundle hash binds the table and provenance to that semantic IR execution.
  FOR query_record IN
    SELECT event.sequence_number,event.event_payload,
           row_number() OVER (ORDER BY event.sequence_number)::integer AS ordinal
      FROM control_plane.answer_execution_events event
     WHERE event.tenant_id=p_tenant_id
       AND event.answer_artifact_id=p_answer_artifact_id
       AND event.event_type='query'
     ORDER BY event.sequence_number
  LOOP
    query_item:=artifact.query_executions->(query_record.ordinal-1);
    ir:=query_item->'normalizedIr';
    SELECT event.sequence_number,event.event_payload
      INTO table_sequence,table_event
      FROM control_plane.answer_execution_events event
     WHERE event.tenant_id=p_tenant_id
       AND event.answer_artifact_id=p_answer_artifact_id
       AND event.event_type='table'
     ORDER BY event.sequence_number
     OFFSET query_record.ordinal-1 LIMIT 1;
    expected_dimensions:=CASE WHEN ir->>'kind'='composite'
      THEN ir->'alignOn' ELSE ir->'dimensions' END;
    IF p_kind='flagship' AND query_record.ordinal=2 THEN
      required_metric:=contract#>>'{performanceIr,selectedLens}';
      required_connectors:=ARRAY['deputy','lightspeed'];
    ELSIF p_kind='flagship' THEN
      required_metric:='rostered_hours';required_connectors:=ARRAY['deputy'];
    ELSE
      required_metric:='net_sales_ex_gst';required_connectors:=ARRAY['lightspeed'];
    END IF;
    SELECT min(event.sequence_number) INTO observation_sequence
      FROM control_plane.answer_execution_events event
     WHERE event.tenant_id=p_tenant_id
       AND event.answer_artifact_id=p_answer_artifact_id
       AND event.event_type='narrative'
       AND event.sequence_number>table_sequence;
    SELECT coalesce(min(event.sequence_number),last_answer) INTO next_boundary
      FROM control_plane.answer_execution_events event
     WHERE event.tenant_id=p_tenant_id
       AND event.answer_artifact_id=p_answer_artifact_id
       AND event.event_type IN ('query','chart','answer')
       AND event.sequence_number>table_sequence;
    visible_result_digest:=control_plane.dogfood_stable_json_sha256(jsonb_build_object(
      'columns',(
        SELECT coalesce(jsonb_agg(column_item->>'key' ORDER BY ordinal),'[]'::jsonb)
          FROM jsonb_array_elements(table_event->'columns')
               WITH ORDINALITY column_entry(column_item,ordinal)
      ),
      'rows',table_event->'rows'
    ));
    IF table_event IS NULL OR table_sequence IS NULL
       OR query_record.sequence_number>=table_sequence
       OR query_record.sequence_number<=previous_boundary
       OR table_event->>'resultId' IS DISTINCT FROM 'semantic:'||(query_item->>'bundleHash')
       OR table_event#>>'{provenance,semanticBundleHash}' IS DISTINCT FROM query_item->>'bundleHash'
       OR visible_result_digest IS DISTINCT FROM query_item->>'resultDigest'
       OR query_record.event_payload->>'topic' IS DISTINCT FROM ir->>'topic'
       OR query_record.event_payload->'metrics' IS DISTINCT FROM ir->'metrics'
       OR query_record.event_payload->'dimensions' IS DISTINCT FROM expected_dimensions
       OR query_record.event_payload->'timeRange' IS DISTINCT FROM table_event#>'{provenance,timeRange}'
       OR length(btrim(coalesce(query_record.event_payload->>'lens',''))) NOT BETWEEN 1 AND 500
       OR jsonb_typeof(table_event->'columns') IS DISTINCT FROM 'array'
       OR jsonb_array_length(table_event->'columns')<2
       OR jsonb_typeof(table_event->'rows') IS DISTINCT FROM 'array'
       OR coalesce(jsonb_array_length(table_event->'rows'),0)=0
       OR jsonb_typeof(table_event#>'{provenance,sources}') IS DISTINCT FROM 'array'
       OR jsonb_typeof(table_event#>'{provenance,definitions}') IS DISTINCT FROM 'array'
       OR coalesce(table_event#>>'{provenance,identityGraph,hash}','') !~ '^[a-f0-9]{32}$'
       OR coalesce((table_event#>>'{provenance,identityGraph,version}')::integer,0)<1
       OR table_event#>>'{provenance,timeRange,timezone}' IS DISTINCT FROM 'Australia/Melbourne'
       OR table_event#>>'{provenance,timeRange,start}' IS NULL
       OR table_event#>>'{provenance,timeRange,end}' IS NULL
       OR (table_event#>>'{provenance,timeRange,start}')::timestamptz>=
          (table_event#>>'{provenance,timeRange,end}')::timestamptz
       OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(table_event#>'{provenance,definitions}') definition
          WHERE definition->>'metric'=required_metric
             OR definition->>'metric' LIKE '%.'||required_metric
       ) OR (
         SELECT array_agg(DISTINCT source->>'connector' ORDER BY source->>'connector')
           FROM jsonb_array_elements(table_event#>'{provenance,sources}') source
       ) IS DISTINCT FROM required_connectors
       OR EXISTS (
         SELECT dimension
           FROM jsonb_array_elements_text(expected_dimensions) dimension
         EXCEPT
         SELECT column_item->>'key'
           FROM jsonb_array_elements(table_event->'columns') column_item
       ) OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(table_event->'columns') column_item
          WHERE column_item->>'key'=required_metric
       ) OR NOT EXISTS (
         SELECT 1 FROM control_plane.answer_execution_events progress
          WHERE progress.tenant_id=p_tenant_id
            AND progress.answer_artifact_id=p_answer_artifact_id
            AND progress.event_type='progress'
            AND progress.event_payload->>'label'='Running the governed analysis'
            AND progress.sequence_number>previous_boundary
            AND progress.sequence_number<query_record.sequence_number
       ) OR NOT EXISTS (
         SELECT 1 FROM control_plane.answer_execution_events validation
          WHERE validation.tenant_id=p_tenant_id
            AND validation.answer_artifact_id=p_answer_artifact_id
            AND validation.event_type='validation'
            AND validation.sequence_number>table_sequence
            AND validation.sequence_number<observation_sequence
            AND validation.event_payload->>'outcome' IN ('passed','qualified')
       ) OR observation_sequence IS NULL OR next_boundary IS NULL
       OR observation_sequence>=next_boundary THEN
      RAISE EXCEPTION 'dogfood answer table % is not bound to its exact semantic query and trace',
        query_record.ordinal USING ERRCODE='55000';
    END IF;

    IF ir->>'kind'='single' AND ir#>>'{time,range,type}'='month_to_date' AND (
      extract(day FROM (table_event#>>'{provenance,timeRange,start}')::timestamptz
        AT TIME ZONE 'Australia/Melbourne') IS DISTINCT FROM 1::numeric
      OR date_trunc('month',(table_event#>>'{provenance,timeRange,start}')::timestamptz
        AT TIME ZONE 'Australia/Melbourne') IS DISTINCT FROM
         date_trunc('month',(table_event#>>'{provenance,timeRange,end}')::timestamptz
        AT TIME ZONE 'Australia/Melbourne')
      OR artifact.finalized_at NOT BETWEEN
         (table_event#>>'{provenance,timeRange,start}')::timestamptz AND
         (table_event#>>'{provenance,timeRange,end}')::timestamptz
      OR (table_event#>>'{provenance,timeRange,end}')::timestamptz-
         artifact.finalized_at>interval '36 hours'
    ) THEN
      RAISE EXCEPTION 'category table is not the resolved month-to-date period'
        USING ERRCODE='55000';
    ELSIF ir->>'kind'='composite' AND (
      (table_event#>>'{provenance,timeRange,start}')::timestamptz IS DISTINCT FROM from_at
      OR (table_event#>>'{provenance,timeRange,end}')::timestamptz IS DISTINCT FROM to_at
    ) THEN
      RAISE EXCEPTION 'flagship table period differs from its six-month IR'
        USING ERRCODE='55000';
    ELSIF ir->>'kind'='single' AND ir#>>'{time,range,type}'='today' AND (
      (table_event#>>'{provenance,timeRange,end}')::timestamptz-
        (table_event#>>'{provenance,timeRange,start}')::timestamptz NOT BETWEEN
          interval '1 second' AND interval '36 hours'
      OR ((table_event#>>'{provenance,timeRange,start}')::timestamptz
        AT TIME ZONE 'Australia/Melbourne')::date IS DISTINCT FROM
         (((table_event#>>'{provenance,timeRange,end}')::timestamptz-interval '1 microsecond')
        AT TIME ZONE 'Australia/Melbourne')::date
      OR ((table_event#>>'{provenance,timeRange,start}')::timestamptz
        AT TIME ZONE 'Australia/Melbourne')::date IS DISTINCT FROM
         (to_at AT TIME ZONE 'Australia/Melbourne')::date
    ) THEN
      RAISE EXCEPTION 'flagship roster table is not the reviewed local today period'
        USING ERRCODE='55000';
    END IF;
    previous_boundary:=observation_sequence;
  END LOOP;

  -- Every chart is table-backed and references real keys; the final answer is
  -- grounded to real cells in the last governed table and repeats its exact
  -- provenance rather than a model-authored source story.
  IF EXISTS (
    SELECT 1 FROM control_plane.answer_execution_events chart
     WHERE chart.tenant_id=p_tenant_id
       AND chart.answer_artifact_id=p_answer_artifact_id
       AND chart.event_type='chart'
       AND NOT EXISTS (
         SELECT 1 FROM control_plane.answer_execution_events result_table
          WHERE result_table.tenant_id=chart.tenant_id
            AND result_table.answer_artifact_id=chart.answer_artifact_id
            AND result_table.event_type='table'
            AND result_table.sequence_number<chart.sequence_number
            AND result_table.event_payload->>'resultId'=chart.event_payload->>'dataRef'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(result_table.event_payload->'columns') column_item
               WHERE column_item->>'key'=chart.event_payload->>'xKey'
            )
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(result_table.event_payload->'columns') column_item
               WHERE column_item->>'key'=chart.event_payload->>'yKey'
            )
       )
  ) OR EXISTS (
    SELECT 1 FROM control_plane.answer_execution_events answer
     WHERE answer.tenant_id=p_tenant_id
       AND answer.answer_artifact_id=p_answer_artifact_id
       AND answer.event_type='answer'
       AND (
         lower(answer.event_payload->>'state') IS DISTINCT FROM artifact.answer_state
         OR answer.event_payload#>>'{provenance,semanticBundleHash}' IS DISTINCT FROM
            artifact.query_executions->(query_count-1)->>'bundleHash'
         OR answer.event_payload->'provenance' IS DISTINCT FROM (
           SELECT table_event.event_payload->'provenance'
             FROM control_plane.answer_execution_events table_event
            WHERE table_event.tenant_id=p_tenant_id
              AND table_event.answer_artifact_id=p_answer_artifact_id
              AND table_event.event_type='table'
            ORDER BY table_event.sequence_number DESC LIMIT 1
         )
         OR jsonb_typeof(answer.event_payload->'claims') IS DISTINCT FROM 'array'
         OR coalesce(jsonb_array_length(answer.event_payload->'claims'),0)=0
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(answer.event_payload->'claims') claim
            WHERE jsonb_typeof(claim->'refs') IS DISTINCT FROM 'array'
               OR coalesce(jsonb_array_length(claim->'refs'),0)=0
         )
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(answer.event_payload->'claims') claim,
                         jsonb_array_elements(claim->'refs') ref
            WHERE NOT EXISTS (
                 SELECT 1 FROM control_plane.answer_execution_events result_table
                  WHERE result_table.tenant_id=p_tenant_id
                    AND result_table.answer_artifact_id=p_answer_artifact_id
                    AND result_table.event_type='table'
                    AND result_table.event_payload->>'resultId'=ref->>'resultId'
                    AND (ref->>'rowIndex') ~ '^[0-9]+$'
                    AND (ref->>'rowIndex')::integer<
                        jsonb_array_length(result_table.event_payload->'rows')
                    AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements(result_table.event_payload->'columns') column_item
                       WHERE column_item->>'key'=ref->>'columnKey'
                    )
               )
         )
       )
  ) THEN
    RAISE EXCEPTION 'dogfood charts or final answer are not grounded to governed table cells'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM control_plane.answer_execution_events answer,
                  jsonb_array_elements(answer.event_payload->'claims') claim,
                  jsonb_array_elements(claim->'refs') ref
     WHERE answer.tenant_id=p_tenant_id
       AND answer.answer_artifact_id=p_answer_artifact_id
       AND answer.event_type='answer'
       AND ref->>'columnKey' IS NOT DISTINCT FROM CASE WHEN p_kind='flagship'
         THEN contract#>>'{performanceIr,selectedLens}' ELSE 'net_sales_ex_gst' END
  ) THEN
    RAISE EXCEPTION 'dogfood final answer does not cite the reviewed metric cells'
      USING ERRCODE='55000';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'queryAuditId',query->>'queryAuditId',
    'normalizedIr',query->'normalizedIr',
    'bundleHash',query->>'bundleHash',
    'compilerOutputHash',query->>'compilerOutputHash',
    'resultDigest',query->>'resultDigest',
    'registryVersion',query->>'registryVersion',
    'validation',query->'validation'
  ) ORDER BY ordinal) INTO query_plan_document
    FROM jsonb_array_elements(artifact.query_executions)
         WITH ORDINALITY source(query,ordinal);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'sequence',event.sequence_number,
    'type',event.event_type,
    'status',event.event_payload->>'status',
    'topic',event.event_payload->>'topic',
    'resultId',event.event_payload->>'resultId',
    'dataRef',event.event_payload->>'dataRef'
  ) ORDER BY event.sequence_number),'[]'::jsonb) INTO trace_document
    FROM control_plane.answer_execution_events event
   WHERE event.tenant_id=p_tenant_id
     AND event.answer_artifact_id=p_answer_artifact_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'sequence',event.sequence_number,'provenance',event.event_payload->'provenance'
  ) ORDER BY event.sequence_number),'[]'::jsonb) INTO provenance_document
    FROM control_plane.answer_execution_events event
   WHERE event.tenant_id=p_tenant_id
     AND event.answer_artifact_id=p_answer_artifact_id
     AND event.event_type IN ('table','answer');

  question_digest:=control_plane.dogfood_evidence_sha256(question_binding);
  semantic_plan_digest:=control_plane.dogfood_evidence_sha256(query_plan_document);
  trace_contract_digest:=control_plane.dogfood_evidence_sha256(trace_document);
  provenance_digest:=control_plane.dogfood_evidence_sha256(provenance_document);
  lineage_binding_digest:=control_plane.dogfood_evidence_sha256(jsonb_build_object(
    'caseContractDigest',contract_digest,
    'questionDigest',question_digest,
    'semanticPlanDigest',semantic_plan_digest,
    'traceDigest',artifact.trace_digest,
    'traceContractDigest',trace_contract_digest,
    'provenanceDigest',provenance_digest,
    'artifactDigest',artifact.artifact_digest
  ));
  result:=jsonb_build_object(
    'artifactDigest',artifact.artifact_digest,
    'traceDigest',artifact.trace_digest,
    'answerState',artifact.answer_state,
    'queryCount',query_count,
    'provenanceComplete',true,
    'sequentialNarrative',true,
    'chartPresent',chart_count>0,
    'contractVersion',contract_version,
    'caseContractDigest',contract_digest,
    'questionDigest',question_digest,
    'semanticPlanDigest',semantic_plan_digest,
    'traceContractDigest',trace_contract_digest,
    'provenanceDigest',provenance_digest,
    'lineageBindingDigest',lineage_binding_digest
  );
  RETURN result;
END;
$$;

REVOKE ALL ON TABLE control_plane.protected_dogfood_answer_case_contracts
FROM PUBLIC,anon,authenticated,service_role,
  albert_sync_control,albert_transform_control,albert_semantic_control,
  albert_operator_diagnostic_control,albert_webhook_control,albert_deletion_control;
REVOKE ALL ON FUNCTION
  control_plane.dogfood_stable_json_text(jsonb),
  control_plane.dogfood_stable_json_sha256(jsonb),
  control_plane.protected_dogfood_answer_artifact_digests(text,text),
  control_plane.dogfood_answer_artifact_evidence(text,text,text,text,timestamptz)
FROM PUBLIC,anon,authenticated,service_role,
  albert_sync_control,albert_transform_control,albert_semantic_control,
  albert_operator_diagnostic_control,albert_webhook_control,albert_deletion_control;

COMMIT;
