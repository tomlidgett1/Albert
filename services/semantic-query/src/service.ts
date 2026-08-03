import { ulid } from "ulid";
import {
  compileSemanticQuery,
  SemanticCompilerError,
  type CompiledSemanticQuery,
  type CompiledSemanticValidationEvidence,
} from "../../../packages/compiler/src/index.js";
import {
  isAllowlistedRememberedPreference,
  semanticToolInputSchemas,
  semanticQueryIrSchema,
  type SemanticToolResponse,
} from "../../../packages/agent/src/semantic-tools.js";
import type {
  MetricContract,
  SemanticRegistry,
  TopicContract,
} from "../../../packages/semantic-registry/src/index.js";
import { contentDigest, semanticBundleHash } from "./bundle.js";
import { compileSourceQuery } from "./source-query.js";
import type {
  AnswerState,
  DataHealthSnapshot,
  SemanticServiceDependencies,
  SemanticPublicationEvidence,
  SemanticToolExecutor,
  SemanticToolName,
  SourceField,
  TenantSemanticContext,
  TrustedToolContext,
} from "./types.js";

type DefinitionDetail = Readonly<{ id: string; label: string; definition: string }>;

export class DefaultSemanticToolExecutor implements SemanticToolExecutor {
  private readonly clock: () => Date;
  private readonly cacheTtlSeconds: number;
  private readonly statementTimeoutMs: number;

  constructor(private readonly dependencies: SemanticServiceDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.cacheTtlSeconds = dependencies.cacheTtlSeconds ?? 300;
    this.statementTimeoutMs = dependencies.statementTimeoutMs ?? 10_000;
  }

  async execute(name: SemanticToolName, input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    assertTrustedContext(context);
    assertNoTenantFields(input);
    try {
      return await this.executeOnce(name, input, context);
    } catch (error) {
      if (!isIdentityGraphChanged(error)) throw error;
      // A review decision committed between context loading and query start.
      // Reload once; a second conflict fails closed instead of looping.
      return this.executeOnce(name, input, context);
    }
  }

  private async executeOnce(name: SemanticToolName, input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    switch (name) {
      case "search_catalogue": return this.searchCatalogue(input, context);
      case "get_definition": return this.getDefinition(input, context);
      case "get_capabilities": return this.getCapabilities(input, context);
      case "list_field_values": return this.listFieldValues(input, context);
      case "run_semantic_query": return this.runSemanticQuery(input, context);
      case "run_source_query": return this.runSourceQuery(input, context);
      case "get_data_health": return this.getDataHealth(input, context);
      case "remember": return this.remember(input, context);
      default: return assertNever(name);
    }
  }

  private async runSemanticQuery(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const tenant = await this.dependencies.contextProvider.load(context);
    const ir = semanticQueryIrSchema.parse(semanticToolInputSchemas.run_semantic_query.parse(input));
    const compile=(capabilities:ReadonlySet<string>)=>compileSemanticQuery(ir, this.dependencies.registry, {
      tenantId: context.tenantId,
      role: context.role,
      capabilities,
      now: this.clock().toISOString(),
      timezone: tenant.timezone,
      tradingDayCutoff: tenant.tradingDayCutoff,
      fiscalYearStartMonth: tenant.fiscalYearStartMonth,
      fiscalYearStartDay: tenant.fiscalYearStartDay,
      weekStartsOn: tenant.weekStartsOn,
      tenantParameters: tenant.tenantParameters,
      maxRows: 1000,
      maxEstimatedCost: 100,
    });
    // Resolve the governed time range with the vocabulary the tenant has
    // observed, then compile again through the stricter per-contributor gate.
    // A healthy Xero organisation can no longer make the same capability from
    // a second unavailable organisation appear tenant-wide.
    const provisionalCapabilities=new Set([
      ...tenant.capabilities,...(tenant.capabilityDetails??[]).map((detail)=>detail.id),
    ]);
    const provisional=compile(provisionalCapabilities);
    const scopedCapabilities=contributorScopedCapabilities(
      tenant,semanticTimeRange(provisional.resolvedTime),
    );
    const compiled=compile(scopedCapabilities);
    const contributingSources = contributingSemanticSources(
      compiled.validationEvidence,
      tenant,
      this.dependencies.registry,
      semanticTimeRange(compiled.resolvedTime),
    );
    const bundleHash = semanticBundleHash({
      registryVersion: this.dependencies.registry.version,
      overlayVersion: tenant.overlayVersion,
      identityGraph: identityGraphForTenant(tenant),
      packVersions: contributingSources.packVersions,
      sourceWatermarks: contributingSources.sourceWatermarks,
      ir,
    });
    const progressiveCoverage=progressiveCoverageGate(
      tenant,
      this.dependencies.registry.topics.get(compiled.topic),
      compiled.metricIds,
      this.dependencies.registry,
      compiled.resolvedTime,
    );
    if(progressiveCoverage.status==="blocked"){
      const queryId=ulid();
      const validation:SemanticToolResponse["validation"]={
        status:"blocked",checks:progressiveCoverage.checks.map((check)=>({...check})),
        warnings:[...progressiveCoverage.warnings],
      };
      const resultDigest=contentDigest({columns:compiled.resultColumns,rows:[]});
      const compilerOutputHash=contentDigest({sql:compiled.sql});
      await this.dependencies.audit.append({
        queryId,tenantId:context.tenantId,conversationId:context.conversationId,
        turnId:context.turnId,role:context.role,route:"semantic",topic:compiled.topic,
        bundleHash,registryVersion:this.dependencies.registry.version,input:ir,
        compiledSql:compiled.sql,parameterCount:compiled.parameters.length,
        resultDigest,rowCount:0,durationMs:0,cacheHit:false,state:"unavailable",validation,
      });
      return{
        state:"unavailable",resultId:`semantic:${bundleHash}`,
        provenance:{
          bundleHash,registryVersion:this.dependencies.registry.version,
          identityGraph:identityGraphForTenant(tenant),sources:[...compiled.sourceTables],
          sourceWatermarks:{...contributingSources.sourceWatermarks},
          sourceDetails:contributingSources.sourceDetails.map((detail)=>({...detail})),
          definitionsApplied:[...compiled.metricIds],
          definitionDetails:compiled.metricIds.flatMap((id)=>{
            const metric=this.dependencies.registry.metrics.get(id);
            return metric?[metricDefinitionDetail(metric)]:[];
          }),
          timeRange:{label:resolvedTimeLabel(compiled.resolvedTime),start:compiled.resolvedTime.from,
            end:compiled.resolvedTime.to,timezone:tenant.timezone},
        },
        validation,performance:{cacheHit:false,durationMs:0,rowCount:0},
        queryAudit:{queryAuditId:queryId,route:"semantic",bundleHash,
          registryVersion:this.dependencies.registry.version,resultDigest,compilerOutputHash},
      };
    }
    const publicationEvidence = await inspectPublicationEvidence(this.dependencies);
    const semanticInvariantChecks = semanticQueryInvariantChecks(
      compiled.validationEvidence,
      tenant,
      this.dependencies.registry,
      this.dependencies.registry.version,
      publicationEvidence,
      semanticTimeRange(compiled.resolvedTime),
    );
    const cacheKey = `${context.tenantId}:${bundleHash}`;
    const cached = await this.dependencies.cache.get(cacheKey, context);
    if (cached) {
      const health = await this.dependencies.dataHealth.getForTopic(context, compiled.topic);
      const topic = this.dependencies.registry.topics.get(compiled.topic);
      const freshness = freshnessWarnings(contributingSources.sourceWatermarks, topic?.freshnessMinutes ?? 120, this.clock());
      const cachedRows = cached.data?.rows ?? [];
      const validation = validateSemanticResult(
        cachedRows,
        compiled.resultColumns,
        combinedHealthStatus(health.status,progressiveCoverage.status),
        [...health.checks,...progressiveCoverage.checks],
        [...compiled.warnings, ...freshness,...progressiveCoverage.warnings],
        semanticInvariantChecks,
        cached.validation,
      );
      const state: AnswerState = validation.status === "passed"
        ? "verified"
        : validation.status === "warning" ? "qualified" : "unavailable";
      const { data: cachedData, queryAudit: _cachedQueryAudit, ...cachedMetadata } = cached;
      void _cachedQueryAudit;
      const governedCachedData = cachedData
        ? { ...cachedData, resultWindow: resultWindowForWire(compiled.resultWindow) }
        : undefined;
      const response: SemanticToolResponse = {
        ...cachedMetadata,
        state,
        ...(state !== "unavailable" && governedCachedData ? { data: governedCachedData } : {}),
        validation,
        performance: { ...cached.performance, cacheHit: true },
      };
      const queryId = ulid();
      const resultDigest = contentDigest({ columns: compiled.resultColumns, rows: cachedRows });
      const compilerOutputHash = contentDigest({ sql: compiled.sql });
      await this.dependencies.audit.append({
        queryId,
        tenantId: context.tenantId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        role: context.role,
        route: "semantic",
        topic: compiled.topic,
        bundleHash,
        registryVersion: this.dependencies.registry.version,
        input: ir,
        compiledSql: compiled.sql,
        parameterCount: compiled.parameters.length,
        resultDigest,
        rowCount: cachedRows.length,
        durationMs: 0,
        cacheHit: true,
        state,
        validation,
      });
      return {
        ...response,
        queryAudit: {
          queryAuditId: queryId,
          route: "semantic",
          bundleHash,
          registryVersion: this.dependencies.registry.version,
          resultDigest,
          compilerOutputHash,
        },
      };
    }

    const result = await this.dependencies.database.queryAsSemanticRole({
      tenantId: context.tenantId,
      sql: compiled.sql,
      parameters: compiled.parameters,
      statementTimeoutMs: this.statementTimeoutMs,
      expectedIdentityGraph: identityGraphForTenant(tenant),
      capabilityEvidence: capabilityEvidence(context),
    });
    const health = await this.dependencies.dataHealth.getForTopic(context, compiled.topic);
    const topic = this.dependencies.registry.topics.get(compiled.topic);
    const freshness = freshnessWarnings(contributingSources.sourceWatermarks, topic?.freshnessMinutes ?? 120, this.clock());
    const validation = validateSemanticResult(
      result.rows,
      compiled.resultColumns,
      combinedHealthStatus(health.status,progressiveCoverage.status),
      [...health.checks,...progressiveCoverage.checks],
      [...compiled.warnings, ...freshness,...progressiveCoverage.warnings],
      semanticInvariantChecks,
    );
    const state: AnswerState = validation.status === "passed"
      ? "verified"
      : validation.status === "warning" ? "qualified" : "unavailable";
    const visibleRows = result.rows.map(stripInternalColumns);
    const filterRefs = result.rows.map((row) => filterRefsForRow(row, compiled.dimensions));
    const definitionDetails = compiled.metricIds.flatMap((id) => {
      const metric = this.dependencies.registry.metrics.get(id);
      return metric ? [metricDefinitionDetail(metric)] : [];
    });
    const response: SemanticToolResponse = {
      state,
      resultId: `semantic:${bundleHash}`,
      ...(state !== "unavailable" ? {
        data: {
          columns: [...compiled.resultColumns],
          rows: visibleRows,
          ...(filterRefs.some((row) => Object.keys(row).length > 0) ? { filterRefs } : {}),
          resultWindow: resultWindowForWire(compiled.resultWindow),
        },
      } : {}),
      provenance: {
        bundleHash,
        registryVersion: this.dependencies.registry.version,
        identityGraph: identityGraphForTenant(tenant),
        sources: [...compiled.sourceTables],
        sourceWatermarks: { ...contributingSources.sourceWatermarks },
        sourceDetails: contributingSources.sourceDetails.map((detail) => ({ ...detail })),
        definitionsApplied: [...compiled.metricIds],
        definitionDetails,
        timeRange: {
          label: resolvedTimeLabel(compiled.resolvedTime),
          start: compiled.resolvedTime.from,
          end: compiled.resolvedTime.to,
          timezone: tenant.timezone,
        },
      },
      validation,
      performance: { cacheHit: false, durationMs: result.durationMs, rowCount: visibleRows.length },
    };
    const queryId = ulid();
    const resultDigest = contentDigest({ columns: compiled.resultColumns, rows: visibleRows });
    const compilerOutputHash = contentDigest({ sql: compiled.sql });
    await this.dependencies.audit.append({
      queryId,
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      role: context.role,
      route: "semantic",
      topic: compiled.topic,
      bundleHash,
      registryVersion: this.dependencies.registry.version,
      input: ir,
      compiledSql: compiled.sql,
      parameterCount: compiled.parameters.length,
      resultDigest,
      rowCount: visibleRows.length,
      durationMs: result.durationMs,
      cacheHit: false,
      state,
      validation,
    });
    // Keep governed rows in the server-side cache even when this execution is
    // blocked. A later authority/quality recovery can then revalidate the same
    // deterministic result without turning an unavailable cache entry into an
    // empty verified answer. The public response still withholds those rows.
    const cacheResponse = response.data
      ? response
      : {
        ...response,
        data: {
          columns: [...compiled.resultColumns],
          rows: visibleRows,
          resultWindow: resultWindowForWire(compiled.resultWindow),
        },
      };
    await this.dependencies.cache.set(cacheKey, cacheResponse, this.cacheTtlSeconds, context);
    return {
      ...response,
      queryAudit: {
        queryAuditId: queryId,
        route: "semantic",
        bundleHash,
        registryVersion: this.dependencies.registry.version,
        resultDigest,
        compilerOutputHash,
      },
    };
  }

  private async runSourceQuery(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const parsed = semanticToolInputSchemas.run_source_query.parse(input);
    const tenant = await this.dependencies.contextProvider.load(context);
    const catalogue = await this.dependencies.sourceCatalogue.listFields(context, parsed.connectionId, parsed.sourceTable);
    const compiled = compileSourceQuery(parsed, context.tenantId, context.role, catalogue);
    const sourceThrough = tenant.sourceWatermarks[parsed.connectionId];
    if (!sourceThrough || !Number.isFinite(Date.parse(sourceThrough))) {
      throw new Error("The selected source has no valid watermark, so freshness provenance cannot be established.");
    }
    const bundleHash = semanticBundleHash({
      registryVersion: this.dependencies.registry.version,
      overlayVersion: tenant.overlayVersion,
      identityGraph: identityGraphForTenant(tenant),
      packVersions: { [compiled.connectorId]: compiled.packVersion },
      sourceWatermarks: { [parsed.connectionId]: sourceThrough },
      ir: { route: "source_exploration", ...parsed },
    });
    const result = await this.dependencies.database.queryAsSemanticRole({
      tenantId: context.tenantId,
      sql: compiled.sql,
      parameters: compiled.parameters,
      statementTimeoutMs: this.statementTimeoutMs,
      expectedIdentityGraph: identityGraphForTenant(tenant),
      capabilityEvidence: capabilityEvidence(context),
    });
    const authoritativeConnections = compiled.authorityConcept
      ? authorityConnectionIds(tenant,compiled.authorityConcept,currentSemanticTimeRange(this.clock))
      : [];
    const authorityWarning = authoritativeConnections.length===0
      ? `No authoritative source is configured for ${compiled.authorityConcept}; this result remains exploratory.`
      : !authoritativeConnections.includes(parsed.connectionId)
        ? `This source is not authoritative for ${compiled.authorityConcept}; ${authoritativeConnections.join(", ")} ${authoritativeConnections.length===1?"is":"are"} authoritative.`
        : undefined;
    const warnings = authorityWarning ? [authorityWarning] : [];
    const validation = {
      status: (warnings.length ? "warning" : "passed") as "warning" | "passed",
      checks: [{ checkId: "single_source", status: "passed" }, { checkId: "pii_gate", status: "passed" }],
      warnings,
    };
    const queryId = ulid();
    const promotionCandidateId = await this.dependencies.audit.promoteSourceField({
      queryId,
      context,
      connectionId: parsed.connectionId,
      connectorId: compiled.connectorId,
      sourceTable: parsed.sourceTable,
      sourceFields: [...new Set([
        ...parsed.fields,
        ...parsed.groupBy,
        ...parsed.aggregates.flatMap((aggregate) => aggregate.field ? [aggregate.field] : []),
      ])],
      questionDigest: contentDigest({ conversationId: context.conversationId, turnId: context.turnId, input: parsed }),
      ...(parsed.requestedMetricConcept ? { requestedMetricConcept: parsed.requestedMetricConcept } : {}),
    });
    const definitionsApplied = compiled.fieldDefinitions.map((field) => `${parsed.sourceTable}.${field.field}`);
    const response: SemanticToolResponse = {
      state: "exploratory",
      resultId: `source:${bundleHash}`,
      promotionCandidateId,
      data: { columns: [...compiled.columns], rows: result.rows.map(stripInternalColumns) },
      provenance: {
        bundleHash,
        registryVersion: this.dependencies.registry.version,
        identityGraph: identityGraphForTenant(tenant),
        sources: [compiled.source],
        sourceWatermarks: { [parsed.connectionId]: sourceThrough },
        sourceDetails: sourceDetailsForSource(tenant, compiled.connectorId, parsed.connectionId, sourceThrough),
        definitionsApplied,
        definitionDetails: compiled.fieldDefinitions.map((field) => ({
          id: `${parsed.sourceTable}.${field.field}`,
          label: humanize(field.field),
          definition: field.definition,
        })),
        timeRange: {
          label: compiled.resolvedTime.label,
          start: compiled.resolvedTime.start,
          end: compiled.resolvedTime.end,
          timezone: tenant.timezone,
        },
        ...(authorityWarning ? { authorityWarning } : {}),
      },
      validation,
      performance: { cacheHit: false, durationMs: result.durationMs, rowCount: result.rows.length },
    };
    const resultDigest = contentDigest({ columns: compiled.columns, rows: response.data?.rows ?? [] });
    const compilerOutputHash = contentDigest({ sql: compiled.sql });
    await this.dependencies.audit.append({
      queryId,
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      role: context.role,
      route: "source_exploration",
      bundleHash,
      registryVersion: this.dependencies.registry.version,
      input: parsed,
      compiledSql: compiled.sql,
      parameterCount: compiled.parameters.length,
      resultDigest,
      rowCount: result.rows.length,
      durationMs: result.durationMs,
      cacheHit: false,
      state: "exploratory",
      validation,
    });
    return {
      ...response,
      queryAudit: {
        queryAuditId: queryId,
        route: "source_exploration",
        bundleHash,
        registryVersion: this.dependencies.registry.version,
        resultDigest,
        compilerOutputHash,
      },
    };
  }

  private async searchCatalogue(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const { question } = semanticToolInputSchemas.search_catalogue.parse(input);
    const tenant = await this.dependencies.contextProvider.load(context);
    const ranked = this.dependencies.catalogueSearch
      ? await this.dependencies.catalogueSearch.search(question, 50)
      : undefined;
    const terms = searchTerms(question);
    const rankedMetricIds = ranked
      ? ranked.filter((hit) => hit.kind === "metric").map((hit) => hit.semanticId)
      : [];
    const rankedDimensionIds = ranked
      ? ranked.filter((hit) => hit.kind === "field").map((hit) => hit.semanticId)
      : [];
    const relatedTopicIds = [
      ...rankedMetricIds.flatMap((metricId) =>
        [...this.dependencies.registry.topics.values()]
          .filter((topic) => topic.metrics.includes(metricId))
          .map((topic) => topic.id)),
      ...rankedDimensionIds.flatMap((dimensionId) =>
        [...this.dependencies.registry.topics.values()]
          .filter((topic) => topic.approvedDimensions.includes(dimensionId))
          .map((topic) => topic.id)),
    ];
    const topicIds = ranked
      ? uniqueStrings([
          ...ranked.filter((hit) => hit.kind === "topic").map((hit) => hit.semanticId),
          ...relatedTopicIds,
        ])
      : [...this.dependencies.registry.topics.values()]
          .filter((topic) => topic.roles.includes(context.role))
          .map((topic) => ({ topic, score: scoreTopic(topic, terms) }))
          .filter(({ score }) => score > 0 || terms.length === 0)
          .sort(byScoreThenId((item) => item.topic.id))
          .map(({ topic }) => topic.id);
    const topics = topicIds
      .flatMap((id) => {
        const topic = this.dependencies.registry.topics.get(id);
        return topic && topic.roles.includes(context.role) ? [topic] : [];
      })
      .slice(0, 6)
      .map((topic) => ({
        id: topic.id,
        label: topic.label,
        description: topic.description,
        answerable: topicIsAnswerable(topic, tenant, this.clock),
      }));
    const topicMetricIds = topics.flatMap(({ id }) => this.dependencies.registry.topics.get(id)?.metrics ?? []);
    const metricIds = ranked
      ? uniqueStrings([...rankedMetricIds, ...topicMetricIds])
      : [...this.dependencies.registry.metrics.values()]
          .filter((metric) => topicMetricIds.includes(metric.id))
          .map((metric) => ({ metric, score: scoreMetric(metric, terms) }))
          .sort(byScoreThenId((item) => item.metric.id))
          .map(({ metric }) => metric.id);
    const metrics = metricIds
      .flatMap((id) => {
        const metric = this.dependencies.registry.metrics.get(id);
        return metric && metricIsVisible(id, this.dependencies.registry, context.role) ? [metric] : [];
      })
      .slice(0, 12)
      .map((metric) => ({ id: metric.id, label: metric.label, description: metric.description, unit: metric.unit }));
    const dimensionIds = ranked
      ? uniqueStrings([...rankedDimensionIds,...topics.flatMap(({ id }) => this.dependencies.registry.topics.get(id)?.approvedDimensions ?? [])])
      : uniqueStrings(topics.flatMap(({ id }) => this.dependencies.registry.topics.get(id)?.approvedDimensions ?? []));
    const dimensions = dimensionIds
      .filter((dimensionId) => [...this.dependencies.registry.topics.values()].some((topic) =>
        topic.roles.includes(context.role) && topic.approvedDimensions.includes(dimensionId)))
      .slice(0,12)
      .map((dimensionId) => ({
        id: dimensionId,
        label: humanize(dimensionId),
        topics: [...this.dependencies.registry.topics.values()]
          .filter((topic) => topic.roles.includes(context.role) && topic.approvedDimensions.includes(dimensionId))
          .map((topic) => topic.id),
      }));
    const fieldReferences = ranked?.flatMap((hit) =>
      hit.kind === "source_field" && hit.sourceFieldReference ? [hit.sourceFieldReference] : []) ?? [];
    const sourceFields = ranked && this.dependencies.sourceCatalogue.resolveRankedFields
      ? await this.dependencies.sourceCatalogue.resolveRankedFields(context, fieldReferences, 12)
      : this.dependencies.sourceCatalogue.searchFields
        ? await this.dependencies.sourceCatalogue.searchFields(context, question, 12)
        : [];
    const fields = sourceFields.map((field) => ({
      id: sourceFieldId(field),
      connectorId: field.connectorId,
      connectionId: field.connectionId,
      sourceTable: field.sourceTable,
      field: field.sourceField,
      definition: field.definition,
      fieldType: field.fieldType,
    }));
    const definitionsApplied = [
      ...topics.map(({ id }) => id),...metrics.map(({ id }) => id),
      ...dimensions.map(({ id }) => id),...fields.map(({ id }) => id),
    ];
    return metadataResponse(tenant, this.dependencies.registry.version, { route: "search_catalogue", question }, {
      catalogue: {
        topics, metrics, dimensions, fields,
        tenantContext: {
          defaults: { ...tenant.defaults },
          dossier: dossierForWire(tenant.dossier),
        },
      },
      definitionsApplied,
      definitionDetails: [
        ...metrics.map((metric) => ({ id: metric.id, label: metric.label, definition: metric.description })),
        ...dimensions.map((dimension) => ({ id: dimension.id, label: dimension.label, definition: `Governed dimension available to ${dimension.topics.join(", ")}.` })),
        ...fields.map((field) => ({ id: field.id, label: humanize(field.field), definition: field.definition })),
      ],
    });
  }

  private async getDefinition(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const { name } = semanticToolInputSchemas.get_definition.parse(input);
    const tenant = await this.dependencies.contextProvider.load(context);
    const metric = resolveMetricDefinition(name, this.dependencies.registry.metrics);
    const topic = resolveTopicDefinition(name, this.dependencies.registry.topics);
    const dimension = resolveDimensionDefinition(name, this.dependencies.registry, context.role);
    let sourceField: SourceField | undefined;
    if (!metric && !topic && !dimension && this.dependencies.sourceCatalogue.searchFields) {
      const candidates = await this.dependencies.sourceCatalogue.searchFields(context, name, 10);
      sourceField = candidates.find((field) => sourceFieldId(field) === name || field.sourceField === name);
    }
    if (!metric && !topic && !dimension && !sourceField) {
      throw new SemanticCompilerError("UNKNOWN_METRIC", `No governed definition named ${name}.`);
    }
    if (topic && !topic.roles.includes(context.role)) {
      throw new SemanticCompilerError("FORBIDDEN_ROLE", `Role ${context.role} cannot access Topic ${topic.id}.`);
    }
    if (metric && !metricIsVisible(metric.id, this.dependencies.registry, context.role)) {
      throw new SemanticCompilerError("FORBIDDEN_ROLE", `Role ${context.role} cannot access metric ${metric.id}.`);
    }
    const definition = metric
      ? publicMetricDefinition(metric)
      : topic ?? dimension ?? publicSourceFieldDefinition(sourceField as SourceField);
    const detail = metric
      ? metricDefinitionDetail(metric)
      : topic ? topicDefinitionDetail(topic)
        : sourceField
          ? { id: sourceFieldId(sourceField), label: humanize(sourceField.sourceField), definition: sourceField.definition }
          : { id: name, label: humanize(name), definition: `Governed dimension ${name}.` };
    return metadataResponse(tenant, this.dependencies.registry.version, { route: "get_definition", name }, {
      definition,
      definitionsApplied: [detail.id],
      definitionDetails: [detail],
    });
  }

  private async getCapabilities(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const { topic: topicId } = semanticToolInputSchemas.get_capabilities.parse(input);
    const tenant = await this.dependencies.contextProvider.load(context);
    const topic = this.dependencies.registry.topics.get(topicId);
    if (!topic) throw new SemanticCompilerError("UNKNOWN_TOPIC", `Unknown semantic Topic: ${topicId}.`);
    if (!topic.roles.includes(context.role)) {
      throw new SemanticCompilerError("FORBIDDEN_ROLE", `Role ${context.role} cannot access Topic ${topicId}.`);
    }
    const required = [...new Set(topic.requiredCapabilities)];
    const relevant = [...new Set([
      ...required,
      ...topic.metrics.flatMap((id) => this.dependencies.registry.metrics.get(id)?.requiredCapabilities ?? []),
    ])];
    const scopedCapabilities=contributorScopedCapabilities(
      tenant,currentSemanticTimeRange(this.clock),
    );
    const capabilities = {
      topic: topicId,
      answerable: required.every((item) => scopedCapabilities.has(item)),
      required,
      available: required.filter((item) => scopedCapabilities.has(item)),
      missing: required.filter((item) => !scopedCapabilities.has(item)),
      details: relevant.map((id)=>capabilityDetail(id,required.includes(id),tenant,scopedCapabilities)),
    };
    return metadataResponse(tenant, this.dependencies.registry.version, { route: "get_capabilities", topic: topicId }, {
      capabilities,
      definitionsApplied: [topicId],
      definitionDetails: [topicDefinitionDetail(topic)],
    });
  }

  private async listFieldValues(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const parsed = semanticToolInputSchemas.list_field_values.parse(input);
    const tenant = await this.dependencies.contextProvider.load(context);
    const dimension = resolveCanonicalDimension(parsed.field, this.dependencies.registry, context.role);
    let fieldValues: readonly Readonly<{ value: string; count?: number }>[];
    if (dimension) {
      const parameters: unknown[] = [context.tenantId];
      let queryPredicate = "";
      if (parsed.query) {
        parameters.push(`%${escapeLike(parsed.query)}%`);
        queryPredicate = ` AND ${quoteIdentifier(dimension.displayField)} ILIKE $2 ESCAPE '\\'`;
      }
      parameters.push(parsed.limit);
      const limitParameter = `$${parameters.length}`;
      const result = await this.dependencies.database.queryAsSemanticRole({
        tenantId: context.tenantId,
        statementTimeoutMs: Math.min(this.statementTimeoutMs, 5_000),
        parameters,
        expectedIdentityGraph: identityGraphForTenant(tenant),
        capabilityEvidence: capabilityEvidence(context),
        sql: `SELECT ${quoteIdentifier(dimension.displayField)}::text AS value\nFROM ${quoteQualified(dimension.table)}\nWHERE tenant_id=$1${queryPredicate}\nORDER BY ${quoteIdentifier(dimension.displayField)}\nLIMIT ${limitParameter}`,
      });
      fieldValues = result.rows.flatMap((row) => typeof row.value === "string" ? [{ value: row.value }] : []);
    } else if (this.dependencies.sourceCatalogue.listFieldValues) {
      fieldValues = await this.dependencies.sourceCatalogue.listFieldValues(context, parsed.field, parsed.query, parsed.limit);
    } else {
      throw new SemanticCompilerError("ILLEGAL_DIMENSION", `Field ${parsed.field} is not an allowlisted governed dimension or source field.`);
    }
    return metadataResponse(tenant, this.dependencies.registry.version, { route: "list_field_values", ...parsed }, {
      fieldValues: [...fieldValues],
      definitionsApplied: [parsed.field],
      definitionDetails: [{ id: parsed.field, label: humanize(parsed.field), definition: `Allowlisted values for ${parsed.field}.` }],
    });
  }

  private async getDataHealth(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const { domain } = semanticToolInputSchemas.get_data_health.parse(input);
    const tenant = await this.dependencies.contextProvider.load(context);
    const snapshot = this.dependencies.registry.topics.has(domain)
      ? await this.dependencies.dataHealth.getForTopic(context, domain)
      : this.dependencies.dataHealth.getForDomain
        ? await this.dependencies.dataHealth.getForDomain(context, domain)
        : (() => { throw new SemanticCompilerError("UNKNOWN_TOPIC", `No governed data-health domain named ${domain}.`); })();
    const warnings = healthWarnings(snapshot);
    return metadataResponse(tenant, this.dependencies.registry.version, { route: "get_data_health", domain }, {
      dataHealth: {
        domain,
        status: snapshot.status,
        ...(latestWatermark(tenant.sourceWatermarks) ? { dataThrough: latestWatermark(tenant.sourceWatermarks) } : {}),
        checks: snapshot.checks.map((check) => ({ ...check })),
        warnings,
      },
      definitionsApplied: [domain],
      definitionDetails: [{ id: domain, label: humanize(domain), definition: `Governed quality and freshness health for ${domain}.` }],
    });
  }

  private async remember(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const parsed = semanticToolInputSchemas.remember.parse(input);
    if (context.confirmedPreference === undefined
      || context.confirmedValue === undefined
      || parsed.preference !== context.confirmedPreference
      || parsed.value !== context.confirmedValue
      || !isAllowlistedRememberedPreference(parsed.preference, parsed.value)) {
      throw new SemanticCompilerError("INVALID_PARAMETER", "A matching server-side user confirmation is required before remembering a preference.");
    }
    if (context.role !== "owner" && context.role !== "manager") {
      throw new SemanticCompilerError("FORBIDDEN_ROLE", "Only an owner or manager can publish a tenant preference.");
    }
    if (!this.dependencies.preferenceStore) throw new Error("Tenant preference storage is not configured.");
    const overlayVersion = await this.dependencies.preferenceStore.remember(context, parsed.preference, parsed.value);
    const tenant = await this.dependencies.contextProvider.load(context);
    return metadataResponse(tenant, this.dependencies.registry.version, { route: "remember", preference: parsed.preference, overlayVersion }, {
      rememberedPreference: { preference: parsed.preference, overlayVersion },
      definitionsApplied: [parsed.preference],
      definitionDetails: [{ id: parsed.preference, label: humanize(parsed.preference), definition: "Explicitly confirmed tenant preference." }],
    });
  }
}

type ProgressiveCoverageGate=Readonly<{
  status:"passed"|"warning"|"blocked";
  checks:readonly Readonly<Record<string,unknown>>[];
  warnings:readonly string[];
}>;

function progressiveCoverageGate(
  tenant:TenantSemanticContext,
  topic:TopicContract|undefined,
  metricIds:readonly string[],
  registry:SemanticRegistry,
  resolvedTime:CompiledSemanticQuery["resolvedTime"],
):ProgressiveCoverageGate{
  if(!topic)return{status:"blocked",checks:[{checkId:"progressive_coverage",status:"blocked",reason:"Topic contract is missing."}],warnings:["The Topic coverage contract is unavailable."]};
  const coverageRows=tenant.progressiveCoverage??[];
  if(!coverageRows.length)return{status:"passed",checks:[],warnings:[]};
  const earliestRequested=[resolvedTime.from,resolvedTime.comparisonFrom]
    .filter((value):value is string=>typeof value==="string")
    .map((value)=>Date.parse(value)).filter(Number.isFinite)
    .sort((left,right)=>left-right)[0]??Date.parse(resolvedTime.from);
  const checks:Readonly<Record<string,unknown>>[]=[];
  const warnings:string[]=[];
  let blocked=false;
  const seen=new Set<string>();
  const authorityRange=semanticTimeRange(resolvedTime);
  const requiredCapabilities=[...new Set([
    ...topic.requiredCapabilities,
    ...metricIds.flatMap((metricId)=>registry.metrics.get(metricId)?.requiredCapabilities??[]),
  ])];
  for(const capability of requiredCapabilities){
    const contributorIds=authorityConnectionIds(
      tenant,capabilityAuthorityConcept(capability),authorityRange,
    );
    const candidates=(tenant.capabilityDetails??[]).filter((detail)=>
      detail.id===capability&&capabilityObservationAvailable(detail)&&
      typeof detail.connectionId==="string"&&typeof detail.coverage.stream==="string"
      &&(contributorIds.length===0||contributorIds.includes(detail.connectionId))
    );
    for(const connectionId of contributorIds){
      if(candidates.some((candidate)=>candidate.connectionId===connectionId))continue;
      if(!coverageRows.some((coverage)=>coverage.connectionId===connectionId))continue;
      blocked=true;
      checks.push({
        checkId:`progressive_coverage:${connectionId}:missing_target_stream`,
        status:"blocked",capability,connectionId,reasonCode:"progressive_target_stream_missing",
      });
      warnings.push(`${capability} is unavailable because its current progressive stream coverage is missing.`);
    }
    if(!candidates.length)continue;
    for(const contributor of candidates){
      const stream=String(contributor.coverage.stream);
      const key=`${contributor.connectionId}:${stream}`;
      if(seen.has(key))continue;
      seen.add(key);
      const coverage=coverageRows.find((row)=>
        row.connectionId===contributor.connectionId&&row.stream===stream
      );
      if(!coverage){
        if(coverageRows.some((row)=>row.connectionId===contributor.connectionId)){
          blocked=true;
          checks.push({
            checkId:`progressive_coverage:${key}`,status:"blocked",capability,
            connectionId:contributor.connectionId,stream,
            reasonCode:"progressive_target_stream_missing",
          });
          warnings.push(`${capability} is unavailable because current coverage for ${stream} is missing.`);
        }
        continue;
      }
      if(coverage.status==="superseded")continue;
      const insideStart=earliestRequested>=Date.parse(coverage.coveredFrom);
      const queryable=coverage.status==="queryable"&&insideStart;
      checks.push({
        checkId:`progressive_coverage:${key}`,
        status:queryable?"warning":"blocked",
        capability,connectionId:contributor.connectionId,stream,
        coverageStatus:coverage.status,coveredFrom:coverage.coveredFrom,
        coveredTo:coverage.coveredTo,requestedFrom:new Date(earliestRequested).toISOString(),
      });
      if(!queryable){
        blocked=true;
        warnings.push(coverage.status!=="queryable"
          ? `${capability} is unavailable until every page and declared master dependency for ${stream} has transformed.`
          : `${capability} is unavailable before ${coverage.coveredFrom}; deeper history is still backfilling.`);
      }else{
        warnings.push(`${coverage.qualification} ${stream} is covered from ${coverage.coveredFrom} through ${coverage.coveredTo}.`);
      }
    }
  }
  return{status:blocked?"blocked":warnings.length?"warning":"passed",checks,warnings};
}

function capabilityAuthorityConcept(capability:string):string{
  if(capability.startsWith("inventory."))return"stock";
  if(capability.startsWith("workforce.shifts"))return"planned_shifts";
  if(capability.startsWith("workforce."))return"worked_hours";
  if(capability==="finance.bank_transactions"||capability==="finance.payments")return"cash_settlement";
  if(capability.startsWith("finance."))return"statutory_finance";
  if(capability==="commerce.orders.customer")return"customer_master";
  return"operational_sales";
}

type SemanticTimeRange=Readonly<{from:string;to:string}>;
type AuthoritySelection=NonNullable<TenantSemanticContext["authoritySelections"]>[number];

function semanticTimeRange(resolved:CompiledSemanticQuery["resolvedTime"]):SemanticTimeRange{
  const starts=[resolved.from,resolved.comparisonFrom].filter((value):value is string=>typeof value==="string");
  const ends=[resolved.to,resolved.comparisonTo].filter((value):value is string=>typeof value==="string");
  const from=new Date(Math.min(...starts.map((value)=>Date.parse(value))));
  const to=new Date(Math.max(...ends.map((value)=>Date.parse(value))));
  if(!Number.isFinite(from.valueOf())||!Number.isFinite(to.valueOf())||from>=to){
    throw new Error("Compiled semantic authority range is invalid.");
  }
  return Object.freeze({from:from.toISOString(),to:to.toISOString()});
}

function currentSemanticTimeRange(clock:()=>Date):SemanticTimeRange{
  const now=clock();
  if(!Number.isFinite(now.valueOf()))throw new Error("Semantic authority clock is invalid.");
  return Object.freeze({from:now.toISOString(),to:new Date(now.valueOf()+1).toISOString()});
}

function authoritySelectionsForRange(
  tenant:TenantSemanticContext,
  concept:string,
  range:SemanticTimeRange,
):AuthoritySelection[]{
  if(tenant.authoritySelections===undefined){
    const connectionId=tenant.authorityByConcept[concept];
    if(!connectionId)return[];
    return [{
      concept,scopeType:"tenant",scopeId:"legacy",connectionId,
      effectiveFrom:new Date(0).toISOString(),
      controlEligible:tenant.sourceDetails?.find((detail)=>detail.connectionId===connectionId)?.authorityEligible!==false,
    }];
  }
  const from=Date.parse(range.from);const to=Date.parse(range.to);
  const overlapping=tenant.authoritySelections.filter((selection)=>
    selection.concept===concept
    &&Date.parse(selection.effectiveFrom)<to
    &&(!selection.effectiveTo||Date.parse(selection.effectiveTo)>from)
  );
  // Tenant rows are legacy/default fallbacks. Once a precise authority exists
  // for a concept and period it is the only admissible contributor set.
  const scoped=overlapping.filter((selection)=>selection.scopeType!=="tenant");
  return [...(scoped.length?scoped:overlapping)];
}

function authorityConnectionIds(
  tenant:TenantSemanticContext,concept:string,range:SemanticTimeRange,
):string[]{
  return [...new Set(authoritySelectionsForRange(tenant,concept,range)
    .map((selection)=>selection.connectionId))].sort();
}

function capabilityObservationAvailable(
  detail:NonNullable<TenantSemanticContext["capabilityDetails"]>[number],
):boolean{
  return detail.available!==false&&(detail.support==="full"||detail.support==="partial");
}

function contributorScopedCapabilities(
  tenant:TenantSemanticContext,range:SemanticTimeRange,
):ReadonlySet<string>{
  // Existing in-process fixtures pre-date scoped authority. Production always
  // supplies authoritySelections (including an empty array), which fails
  // closed below when no authoritative contributor exists.
  if(tenant.authoritySelections===undefined)return tenant.capabilities;
  const available=new Set<string>();
  const details=tenant.capabilityDetails??[];
  for(const capability of new Set(details.map((detail)=>detail.id))){
    const concept=capabilityAuthorityConcept(capability);
    const selections=authoritySelectionsForRange(tenant,concept,range);
    const contributors=[...new Set(selections.map((selection)=>selection.connectionId))];
    if(contributors.length===0)continue;
    const everyContributorReady=contributors.every((connectionId)=>{
      const source=tenant.sourceDetails?.find((detail)=>detail.connectionId===connectionId);
      if(!source||source.authorityEligible===false)return false;
      if(selections.some((selection)=>selection.connectionId===connectionId&&selection.controlEligible===false))return false;
      return details.some((detail)=>
        detail.id===capability&&detail.connectionId===connectionId
        &&detail.connectorId===source.connectorId&&capabilityObservationAvailable(detail)
      );
    });
    if(everyContributorReady)available.add(capability);
  }
  return available;
}

function combinedHealthStatus(
  health:"passed"|"warning"|"failed"|"blocked",
  coverage:"passed"|"warning"|"blocked",
):"passed"|"warning"|"failed"|"blocked"{
  if(health==="blocked"||coverage==="blocked")return"blocked";
  if(health==="failed")return"failed";
  if(health==="warning"||coverage==="warning")return"warning";
  return"passed";
}

function capabilityEvidence(context: TrustedToolContext): Readonly<{
  conversationId: string;
  turnId: string;
}> {
  return Object.freeze({ conversationId: context.conversationId, turnId: context.turnId });
}

function validateSemanticResult(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly string[],
  healthStatus: "passed" | "warning" | "failed" | "blocked",
  checks: readonly Readonly<Record<string, unknown>>[],
  warnings: readonly string[],
  semanticInvariantChecks: readonly Readonly<Record<string, unknown>>[],
  previous?: SemanticToolResponse["validation"],
): SemanticToolResponse["validation"] {
  const shapeFailures = rows.filter((row) => columns.some((column) => !(column in row))).length;
  const currentSliceChecks = semanticSliceChecks(rows);
  const previousSliceChecks = (previous?.checks ?? []).filter((check) =>
    typeof check.checkId === "string" && check.checkId.startsWith("slice_"),
  );
  const sliceChecks = currentSliceChecks.length > 0 ? currentSliceChecks : previousSliceChecks;
  const sliceWarnings = sliceChecks
    .filter((check) => check.status !== "passed")
    .map((check) => sliceCheckWarning(check));
  const semanticWarnings = semanticInvariantChecks
    .filter((check) => check.status !== "passed")
    .map((check) => semanticInvariantWarning(check));
  const combinedWarnings = [
    ...warnings,
    ...semanticWarnings,
    ...sliceWarnings,
    ...(shapeFailures ? [`${shapeFailures} result rows did not match the compiled result shape.`] : []),
  ];
  const sliceBlocked = sliceChecks.some((check) => check.status === "blocked" || check.status === "failed");
  const semanticBlocked = semanticInvariantChecks.some((check) =>
    check.status === "blocked" || check.status === "failed");
  const status: SemanticToolResponse["validation"]["status"] = healthStatus === "failed" || healthStatus === "blocked" || shapeFailures || sliceBlocked || semanticBlocked
    ? healthStatus === "blocked" || sliceBlocked || semanticBlocked ? "blocked" : "failed"
    : healthStatus === "warning" || combinedWarnings.length ? "warning" : "passed";
  const semanticCheckIds = new Set(semanticInvariantChecks.map((check) => check.checkId));
  return {
    status,
    checks: [
      ...checks.filter((check) => !semanticCheckIds.has(check.checkId)).map((check) => ({ ...check })),
      ...semanticInvariantChecks.map((check) => ({ ...check })),
      ...sliceChecks.map((check) => ({ ...check })),
      { checkId: "result_shape", status: shapeFailures ? "failed" : "passed", failingRows: shapeFailures },
    ],
    warnings: combinedWarnings,
  };
}

async function inspectPublicationEvidence(
  dependencies: SemanticServiceDependencies,
): Promise<SemanticPublicationEvidence | undefined> {
  if (!dependencies.publicationEvidence) return undefined;
  try {
    return await dependencies.publicationEvidence.inspect();
  } catch {
    return undefined;
  }
}

function semanticQueryInvariantChecks(
  evidence: CompiledSemanticValidationEvidence,
  tenant: TenantSemanticContext,
  registry: SemanticRegistry,
  registryVersion: string,
  publication: SemanticPublicationEvidence | undefined,
  authorityRange:SemanticTimeRange,
): Readonly<Record<string, unknown>>[] {
  const validPlan = evidence.planKind === "single_fact"
    ? evidence.factIds.length === 1 && evidence.alignOn.length === 0
    : evidence.factIds.length >= 2 && evidence.alignOn.length > 0;
  const unsafeJoins = evidence.joins.filter((join) =>
    join.cardinality !== "many_to_one" && join.cardinality !== "one_to_one");
  const fanoutPassed = validPlan && unsafeJoins.length === 0;

  const ratioMetrics = evidence.metrics.filter((metric) => metric.aggregation === "ratio");
  const invalidRatioMetrics = ratioMetrics.filter((metric) => {
    if (metric.testKinds.includes("aggregate_then_align")) {
      return evidence.planKind !== "aggregate_then_align"
        || evidence.factIds.length < 2
        || evidence.alignOn.length === 0;
    }
    const baseFactIsExecutable = registry.facts.has(metric.baseFact);
    if (!baseFactIsExecutable) {
      return evidence.planKind !== "aggregate_then_align"
        || evidence.factIds.length < 2
        || evidence.alignOn.length === 0;
    }
    return metric.dependencyMetricIds.some((dependencyId) => {
      const dependency = registry.metrics.get(dependencyId);
      return !dependency
        || dependency.baseFact !== metric.baseFact
        || dependency.grain !== metric.grain;
    });
  });

  const snapshotMetrics = evidence.metrics.filter((metric) =>
    metric.snapshotAccesses.length > 0 || metric.testKinds.includes("snapshot_not_summed"));
  const invalidSnapshotMetrics = snapshotMetrics.filter((metric) =>
    metric.snapshotAccesses.some((access) => access.operation === "sum")
      || (metric.testKinds.includes("snapshot_not_summed") && metric.snapshotAccesses.length === 0));

  const authorities = semanticAuthorityConcepts(evidence, registry);
  const authorityProofs:Readonly<Record<string,unknown>>[]=[];
  for(const concept of authorities){
    const selections=authoritySelectionsForRange(tenant,concept,authorityRange);
    if(selections.length===0){
      authorityProofs.push({concept,status:"blocked",reasonCode:"authority_selection_missing"});
      continue;
    }
    for(const selection of selections){
      const connectionId=selection.connectionId;
      const source=tenant.sourceDetails?.find((detail)=>detail.connectionId===connectionId);
      const watermark=tenant.sourceWatermarks[connectionId];
      const packVersion=source?tenant.packVersions[source.connectorId]:undefined;
      const controlEligible=selection.controlEligible!==false&&source?.authorityEligible!==false;
      const liveMetadata=Boolean(
        controlEligible&&source&&watermark&&packVersion
        &&Number.isFinite(Date.parse(source.dataThrough))
        &&Number.isFinite(Date.parse(watermark))
        &&Date.parse(source.dataThrough)===Date.parse(watermark)
      );
      authorityProofs.push({
        concept,connectionId,
        ...(tenant.authoritySelections!==undefined?{
          scopeType:selection.scopeType,scopeId:selection.scopeId,
          effectiveFrom:selection.effectiveFrom,
          ...(selection.effectiveTo?{effectiveTo:selection.effectiveTo}:{}),
        }:{}),
        ...(source?{connectorId:source.connectorId}:{}),
        status:liveMetadata?"passed":"blocked",
        ...(liveMetadata?{}:{reasonCode:controlEligible
          ?"authority_source_metadata_missing":"authority_connection_ineligible"}),
      });
    }
  }
  const authorityPassed = authorityProofs.length > 0
    && authorityProofs.every((proof) => proof.status === "passed");

  const publicationPassed = Boolean(
    publication?.activePublicationMatches
    && publication.registryVersion === registryVersion
    && /^[a-f0-9]{64}$/u.test(publication.registryHash),
  );

  return [
    {
      checkId: "no_fanout",
      status: fanoutPassed ? "passed" : "blocked",
      planKind: evidence.planKind,
      factCount: evidence.factIds.length,
      joinCount: evidence.joins.length,
      joinCardinalities: [...new Set(evidence.joins.map((join) => join.cardinality))].sort(),
      ...(fanoutPassed ? {} : { reasonCode: validPlan ? "fanout_join_detected" : "invalid_compiled_plan" }),
    },
    {
      checkId: "grain_compatible_ratios",
      status: invalidRatioMetrics.length === 0 ? "passed" : "blocked",
      evaluatedMetrics: ratioMetrics.map((metric) => metric.metricId),
      incompatibleMetrics: invalidRatioMetrics.map((metric) => metric.metricId),
      planKind: evidence.planKind,
      alignOn: [...evidence.alignOn],
      ...(invalidRatioMetrics.length === 0 ? {} : { reasonCode: "ratio_grain_incompatible" }),
    },
    {
      checkId: "snapshot_not_summed",
      status: invalidSnapshotMetrics.length === 0 ? "passed" : "blocked",
      evaluatedMetrics: snapshotMetrics.map((metric) => metric.metricId),
      accesses: snapshotMetrics.flatMap((metric) => metric.snapshotAccesses.map((access) => ({
        metricId: metric.metricId,
        factId: access.factId,
        field: access.field,
        operation: access.operation,
      }))),
      ...(invalidSnapshotMetrics.length === 0 ? {} : { reasonCode: "snapshot_additivity_violated" }),
    },
    {
      checkId: "authority_respected",
      status: authorityPassed ? "passed" : "blocked",
      concepts: authorityProofs,
      ...(authorityPassed ? {} : { reasonCode: "authority_evidence_incomplete" }),
    },
    {
      checkId: "golden_fixture_match",
      status: publicationPassed ? "passed" : "blocked",
      registryVersion,
      ...(publication ? {
        publicationRegistryVersion: publication.registryVersion,
        publicationRegistryHash: publication.registryHash,
        activePublicationMatches: publication.activePublicationMatches,
      } : {}),
      evidenceKind: "active_content_addressed_publication",
      ...(publicationPassed ? {} : { reasonCode: "exact_fixture_gated_publication_missing" }),
    },
  ];
}

function semanticInvariantWarning(check: Readonly<Record<string, unknown>>): string {
  const checkId = String(check.checkId ?? "semantic_validation");
  const reasonCode = String(check.reasonCode ?? "semantic_evidence_incomplete");
  return `${checkId}: ${reasonCode}; verified output was withheld.`;
}

function semanticSliceChecks(
  rows: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>>[] {
  const aliases = new Set(rows.flatMap((row) => Object.keys(row)));
  const checks: Readonly<Record<string, unknown>>[] = [];
  for (const eligibleAlias of [...aliases].filter((alias) => alias.startsWith("__coverage_eligible__"))) {
    const suffix = eligibleAlias.slice("__coverage_eligible__".length);
    const observedAlias = `__coverage_observed__${suffix}`;
    let eligible = 0;
    let observed = 0;
    let failingRows = 0;
    for (const row of rows) {
      const rowEligible = exactCount(row[eligibleAlias]);
      const rowObserved = exactCount(row[observedAlias]);
      eligible += rowEligible;
      observed += rowObserved;
      if (rowObserved < rowEligible) failingRows += 1;
    }
    checks.push({
      checkId: `slice_cost_coverage:${suffix}`,
      status: failingRows > 0 ? "blocked" : "passed",
      eligibleRows: eligible,
      observedRows: observed,
      coverage: eligible === 0 ? 1 : observed / eligible,
      failingRows,
    });
  }
  for (const currencyAlias of [...aliases].filter((alias) => alias.startsWith("__currency_codes__"))) {
    const suffix = currencyAlias.slice("__currency_codes__".length);
    let failingRows = 0;
    const currencies = new Set<string>();
    for (const row of rows) {
      const rowCurrencies = new Set(
        String(row[currencyAlias] ?? "")
          .split(",")
          .map((currency) => currency.trim().toUpperCase())
          .filter(Boolean),
      );
      rowCurrencies.forEach((currency) => currencies.add(currency));
      if (rowCurrencies.size > 1) failingRows += 1;
    }
    checks.push({
      checkId: `slice_single_currency:${suffix}`,
      status: failingRows > 0 ? "blocked" : "passed",
      currencies: [...currencies].sort(),
      failingRows,
    });
  }
  for (const eligibleAlias of [...aliases].filter((alias) => alias.startsWith("__settlement_eligible__"))) {
    const suffix = eligibleAlias.slice("__settlement_eligible__".length);
    const linkedAlias = `__settlement_linked__${suffix}`;
    let eligible = 0;
    let linked = 0;
    let failingRows = 0;
    for (const row of rows) {
      const rowEligible = exactCount(row[eligibleAlias]);
      const rowLinked = exactCount(row[linkedAlias]);
      eligible += rowEligible;
      linked += rowLinked;
      if (rowLinked < rowEligible) failingRows += 1;
    }
    checks.push({
      checkId: `slice_settlement_bridge_coverage:${suffix}`,
      status: failingRows > 0 ? "warning" : "passed",
      eligibleTenders: eligible,
      linkedTenders: linked,
      coverage: eligible === 0 ? 1 : linked / eligible,
      failingRows,
    });
  }
  return checks;
}

function exactCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function sliceCheckWarning(check: Readonly<Record<string, unknown>>): string {
  const checkId = String(check.checkId ?? "slice_validation");
  if (checkId.startsWith("slice_cost_coverage:")) {
    return `${checkId}: missing cost observations (${String(check.observedRows ?? 0)}/${String(check.eligibleRows ?? 0)} covered); verified output was withheld.`;
  }
  if (checkId.startsWith("slice_single_currency:")) {
    return `${checkId}: multiple currencies contribute to at least one result slice; verified output was withheld.`;
  }
  if (checkId.startsWith("slice_settlement_bridge_coverage:")) {
    return `${checkId}: ${String(check.linkedTenders ?? 0)}/${String(check.eligibleTenders ?? 0)} tenders have deterministic bank-settlement links; the variance remains qualified evidence.`;
  }
  return `${checkId}: blocked.`;
}

function metadataResponse(
  tenant: TenantSemanticContext,
  registryVersion: string,
  ir: unknown,
  value: Readonly<{
    definition?: unknown;
    capabilities?: NonNullable<SemanticToolResponse["capabilities"]>;
    catalogue?: NonNullable<SemanticToolResponse["catalogue"]>;
    fieldValues?: NonNullable<SemanticToolResponse["fieldValues"]>;
    dataHealth?: NonNullable<SemanticToolResponse["dataHealth"]>;
    rememberedPreference?: NonNullable<SemanticToolResponse["rememberedPreference"]>;
    definitionsApplied: readonly string[];
    definitionDetails: readonly DefinitionDetail[];
  }>,
): SemanticToolResponse {
  return {
    state: "verified",
    ...(value.definition === undefined ? {} : { definition: value.definition }),
    ...(value.capabilities ? { capabilities: value.capabilities } : {}),
    ...(value.catalogue ? { catalogue: value.catalogue } : {}),
    ...(value.fieldValues ? { fieldValues: value.fieldValues } : {}),
    ...(value.dataHealth ? { dataHealth: value.dataHealth } : {}),
    ...(value.rememberedPreference ? { rememberedPreference: value.rememberedPreference } : {}),
    provenance: {
      bundleHash: semanticBundleHash({
        registryVersion,
        overlayVersion: tenant.overlayVersion,
        identityGraph: identityGraphForTenant(tenant),
        packVersions: tenant.packVersions,
        sourceWatermarks: tenant.sourceWatermarks,
        ir,
      }),
      registryVersion,
      identityGraph: identityGraphForTenant(tenant),
      sources: [],
      sourceWatermarks: { ...tenant.sourceWatermarks },
      sourceDetails: sourceDetailsForTenant(tenant),
      definitionsApplied: [...value.definitionsApplied],
      definitionDetails: [...value.definitionDetails],
    },
    validation: { status: "passed", checks: [], warnings: [] },
    performance: { cacheHit: false, durationMs: 0, rowCount: 0 },
  };
}

function assertNoTenantFields(value: unknown, path = "input"): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoTenantFields(item, `${path}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (normalized === "tenant" || normalized === "tenantid") {
      throw new Error(`Model input must not contain trusted tenant scope (${path}.${key}).`);
    }
    assertNoTenantFields(nested, `${path}.${key}`);
  }
}

function freshnessWarnings(watermarks: Readonly<Record<string, string>>, freshnessMinutes: number, now: Date): readonly string[] {
  const entries = Object.entries(watermarks);
  if (!entries.length) return ["No source watermark is available for freshness validation."];
  const warnings: string[] = [];
  for (const [source, value] of entries) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) { warnings.push(`Source ${source} has an invalid freshness watermark.`); continue; }
    const ageMinutes = (now.getTime() - timestamp) / 60_000;
    if (ageMinutes > freshnessMinutes) warnings.push(`Source ${source} is ${Math.floor(ageMinutes)} minutes old; this Topic requires freshness within ${freshnessMinutes} minutes.`);
  }
  return warnings;
}

function assertTrustedContext(context: TrustedToolContext): void {
  if (!context.tenantId || !context.conversationId || !context.turnId) throw new Error("Trusted tenant, conversation and turn context are required.");
  if (!["owner", "manager", "bookkeeper", "internal_operator"].includes(context.role)) throw new Error("Trusted role is invalid.");
}

function stripInternalColumns(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__")));
}

function filterRefsForRow(
  row: Readonly<Record<string, unknown>>,
  dimensions: readonly string[],
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(dimensions.flatMap((dimension) => {
    const value = row[`__key_${dimension}`];
    return typeof value === "string" && value.length > 0 ? [[dimension, value]] : [];
  })));
}

function resolveMetricDefinition(name: string, metrics: ReadonlyMap<string, MetricContract>): MetricContract | undefined {
  if (metrics.has(name)) return metrics.get(name);
  const candidates = [...metrics.values()].filter((metric) => metric.id.endsWith(`.${name}`));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveTopicDefinition(name: string, topics: ReadonlyMap<string, TopicContract>): TopicContract | undefined {
  if (topics.has(name)) return topics.get(name);
  const normalized = name.toLowerCase();
  const candidates = [...topics.values()].filter((topic) => topic.label.toLowerCase() === normalized);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveDimensionDefinition(name: string, registry: SemanticRegistry, role: TrustedToolContext["role"]): unknown | undefined {
  const topics = [...registry.topics.values()].filter((topic) => topic.roles.includes(role) && topic.approvedDimensions.includes(name));
  if (!topics.length) return undefined;
  return { id: name, kind: "dimension", label: humanize(name), topics: topics.map((topic) => topic.id) };
}

function resolveCanonicalDimension(
  name: string,
  registry: SemanticRegistry,
  role: TrustedToolContext["role"],
): Readonly<{ table: string; displayField: string }> | undefined {
  if (name === "business_date" || name === "calendar_week") return undefined;
  const visible = [...registry.topics.values()].some((topic) => topic.roles.includes(role) && topic.approvedDimensions.includes(name));
  if (!visible) return undefined;
  const candidates = new Map<string, { table: string; displayField: string }>();
  for (const fact of registry.facts.values()) {
    for (const join of fact.joins) {
      const displayField = join.fields[name];
      if (!displayField) continue;
      candidates.set(`${join.table}|${displayField}`, { table: join.table, displayField });
    }
  }
  if (candidates.size !== 1) return undefined;
  return [...candidates.values()][0];
}

function publicMetricDefinition(metric: MetricContract) {
  const { calculation, ...publicFields } = metric;
  void calculation;
  return publicFields;
}

function publicSourceFieldDefinition(field: SourceField) {
  const { sourceSchema, ...publicFields } = field;
  void sourceSchema;
  return { ...publicFields, id: sourceFieldId(field) };
}

function metricDefinitionDetail(metric: MetricContract): DefinitionDetail {
  return { id: metric.id, label: metric.label, definition: metric.description };
}

function topicDefinitionDetail(topic: TopicContract): DefinitionDetail {
  return { id: topic.id, label: topic.label, definition: topic.description };
}

function metricIsVisible(metricId: string, registry: SemanticRegistry, role: TrustedToolContext["role"]): boolean {
  return [...registry.topics.values()].some((topic) => topic.roles.includes(role) && topic.metrics.includes(metricId));
}

function topicIsAnswerable(
  topic:TopicContract,tenant:TenantSemanticContext,clock:()=>Date,
):boolean{
  const scoped=contributorScopedCapabilities(tenant,currentSemanticTimeRange(clock));
  return topic.requiredCapabilities.every((capability) => scoped.has(capability));
}

function capabilityDetail(
  id:string,
  requiredForTopic:boolean,
  tenant:TenantSemanticContext,
  scopedCapabilities:ReadonlySet<string>,
){
  const observations=(tenant.capabilityDetails??[]).filter((detail)=>detail.id===id);
  const support=observations.length===0?"unknown":observations.slice(1).reduce<"full"|"partial"|"unavailable"|"unknown">((best,current)=>
    capabilityRank(current.support)>capabilityRank(best)?current.support:best,observations[0]!.support);
  return{
    id,requiredForTopic,available:scopedCapabilities.has(id),support,
    observations:observations.map((observation)=>({
      connectorId:observation.connectorId,
      ...(observation.connectionId?{connectionId:observation.connectionId}:{}),
      support:observation.support,
      ...(observation.reasonCode?{reasonCode:observation.reasonCode}:{}),
      ...(observation.reason?{reason:observation.reason}:{}),
      coverage:{...observation.coverage},
    })),
  };
}

function capabilityRank(value:"full"|"partial"|"unavailable"|"unknown"):number{
  if(value==="full")return 4;if(value==="partial")return 3;if(value==="unknown")return 2;return 1;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sourceFieldId(field: SourceField): string {
  return `source:${field.connectionId}:${field.sourceTable}:${field.sourceField}`;
}

function identityGraphForTenant(tenant: TenantSemanticContext): Readonly<{ version: number; hash: string }> {
  return { version: tenant.identityGraphVersion, hash: tenant.identityGraphHash };
}

function dossierForWire(
  dossier: TenantSemanticContext["dossier"],
): Record<string, string | number | boolean | string[]> {
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(dossier)) {
    result[key] = Array.isArray(value) ? [...value] : value as string | number | boolean;
  }
  return result;
}

function isIdentityGraphChanged(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === "IDENTITY_GRAPH_CHANGED";
}

function contributingSemanticSources(
  evidence: CompiledSemanticValidationEvidence,
  tenant: TenantSemanticContext,
  registry: SemanticRegistry,
  authorityRange:SemanticTimeRange,
): Readonly<{
  packVersions: Readonly<Record<string, string>>;
  sourceWatermarks: Readonly<Record<string, string>>;
  sourceDetails: readonly NonNullable<SemanticToolResponse["provenance"]["sourceDetails"]>[number][];
}> {
  const authorityConcepts = semanticAuthorityConcepts(evidence, registry);
  const connectionIds = [...new Set(authorityConcepts.flatMap((concept) => {
    return authorityConnectionIds(tenant,concept,authorityRange);
  }))].sort();
  const packVersions: Record<string, string> = {};
  const sourceWatermarks: Record<string, string> = {};
  const sourceDetails: NonNullable<SemanticToolResponse["provenance"]["sourceDetails"]> = [];
  for (const connectionId of connectionIds) {
    const watermark = tenant.sourceWatermarks[connectionId];
    if (watermark !== undefined) sourceWatermarks[connectionId] = watermark;
    const detail = tenant.sourceDetails?.find((candidate) => candidate.connectionId === connectionId);
    if (!detail) continue;
    sourceDetails.push({ ...detail,...(watermark === undefined ? {} : { dataThrough: watermark }) });
    const packVersion = tenant.packVersions[detail.connectorId];
    if (packVersion !== undefined) packVersions[detail.connectorId] = packVersion;
  }
  return Object.freeze({
    packVersions: Object.freeze(packVersions),
    sourceWatermarks: Object.freeze(sourceWatermarks),
    sourceDetails: Object.freeze(sourceDetails),
  });
}

function semanticAuthorityConcepts(
  evidence: CompiledSemanticValidationEvidence,
  registry: SemanticRegistry,
): string[] {
  const concepts = new Set(evidence.metrics.map((metric) => metric.authority));
  for (const dependencyId of evidence.metrics.flatMap((metric) => metric.dependencyMetricIds)) {
    const authority = registry.metrics.get(dependencyId)?.authority;
    if (authority) concepts.add(authority);
  }
  return [...concepts].sort();
}

function resultWindowForWire(
  resultWindow: Readonly<{
    requestedLimit: number;
    orderedBeforeLimit: true;
    orderBy: readonly Readonly<{ columnKey: string; direction: "asc" | "desc" }>[];
  }>,
): NonNullable<NonNullable<SemanticToolResponse["data"]>["resultWindow"]> {
  return {
    requestedLimit: resultWindow.requestedLimit,
    orderedBeforeLimit: true,
    orderBy: resultWindow.orderBy.map((item) => ({ ...item })),
  };
}

function sourceDetailsForTenant(tenant: TenantSemanticContext): NonNullable<SemanticToolResponse["provenance"]["sourceDetails"]> {
  if (tenant.sourceDetails?.length) return tenant.sourceDetails.map((detail) => ({ ...detail }));
  return Object.entries(tenant.sourceWatermarks).map(([key, dataThrough]) => ({
    connectorId: connectorFromKey(key),
    connectionId: key,
    label: connectorLabel(connectorFromKey(key)),
    dataThrough,
  }));
}

function sourceDetailsForSource(
  tenant: TenantSemanticContext,
  connectorId: string,
  connectionId: string,
  dataThrough: string,
): NonNullable<SemanticToolResponse["provenance"]["sourceDetails"]> {
  const configured = tenant.sourceDetails?.find((detail) => detail.connectionId === connectionId);
  return [configured
    ? { ...configured, dataThrough }
    : { connectorId, connectionId, label: connectorLabel(connectorId), dataThrough }];
}

function resolvedTimeLabel(range: Readonly<{ fromBusinessDate: string; toBusinessDate: string; compare: string }>): string {
  const end = new Date(`${range.toBusinessDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const through = end.toISOString().slice(0, 10);
  const comparison = range.compare === "none" ? "" : ` · ${humanize(range.compare)}`;
  return `${range.fromBusinessDate} to ${through}${comparison}`;
}

function healthWarnings(snapshot: DataHealthSnapshot): string[] {
  return snapshot.checks
    .filter((check) => check.status !== "passed")
    .map((check) => `${check.checkId}: ${check.status}${check.details ? ` (${JSON.stringify(check.details)})` : ""}`);
}

function latestWatermark(watermarks: Readonly<Record<string, string>>): string | undefined {
  return Object.values(watermarks)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function searchTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1))];
}

function scoreTopic(topic: TopicContract, terms: readonly string[]): number {
  return scoreText([topic.id, topic.label, topic.description, topic.aiContext, ...topic.sampleQuestions].join(" "), terms);
}

function scoreMetric(metric: MetricContract, terms: readonly string[]): number {
  return scoreText([metric.id, metric.label, metric.description, metric.aiContext, ...metric.synonyms].join(" "), terms);
}

function scoreText(value: string, terms: readonly string[]): number {
  const normalized = value.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function byScoreThenId<T>(id: (value: T) => string): (left: T & { score: number }, right: T & { score: number }) => number {
  return (left, right) => right.score - left.score || id(left).localeCompare(id(right));
}

function humanize(value: string): string {
  return value.replaceAll(".", " ").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function connectorFromKey(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("xero")) return "xero";
  if (normalized.includes("deputy")) return "deputy";
  return "lightspeed";
}

function connectorLabel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("xero")) return "Xero";
  if (normalized.startsWith("deputy")) return "Deputy";
  if (normalized.startsWith("lightspeed")) return "Lightspeed";
  return humanize(value);
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe governed identifier ${value}.`);
  return `"${value}"`;
}

function quoteQualified(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error(`Unsafe governed table ${value}.`);
  return parts.map(quoteIdentifier).join(".");
}

function assertNever(value: never): never {
  throw new Error(`Unknown semantic tool ${String(value)}.`);
}
