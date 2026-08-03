import { compileSemanticQuery, SemanticCompilerError } from "../../../packages/compiler/src/index.js";
import {
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
    const compiled = compileSemanticQuery(ir, this.dependencies.registry, {
      tenantId: context.tenantId,
      role: context.role,
      capabilities: tenant.capabilities,
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
    const bundleHash = semanticBundleHash({
      registryVersion: this.dependencies.registry.version,
      overlayVersion: tenant.overlayVersion,
      identityGraph: identityGraphForTenant(tenant),
      packVersions: tenant.packVersions,
      sourceWatermarks: tenant.sourceWatermarks,
      ir,
    });
    const cacheKey = `${context.tenantId}:${bundleHash}`;
    const cached = await this.dependencies.cache.get(cacheKey);
    if (cached) {
      const health = await this.dependencies.dataHealth.getForTopic(context, compiled.topic);
      const topic = this.dependencies.registry.topics.get(compiled.topic);
      const freshness = freshnessWarnings(tenant.sourceWatermarks, topic?.freshnessMinutes ?? 120, this.clock());
      const cachedRows = cached.data?.rows ?? [];
      const validation = validateSemanticResult(
        cachedRows,
        compiled.resultColumns,
        health.status,
        health.checks,
        [...compiled.warnings, ...freshness],
      );
      const state: AnswerState = validation.status === "passed"
        ? "verified"
        : validation.status === "warning" ? "qualified" : "unavailable";
      const { data: cachedData, ...cachedMetadata } = cached;
      const response: SemanticToolResponse = {
        ...cachedMetadata,
        state,
        ...(state !== "unavailable" && cachedData ? { data: cachedData } : {}),
        validation,
        performance: { ...cached.performance, cacheHit: true },
      };
      await this.dependencies.audit.append({
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
        resultDigest: contentDigest({ columns: compiled.resultColumns, rows: cachedRows }),
        rowCount: cachedRows.length,
        durationMs: 0,
        cacheHit: true,
        state,
        validation,
      });
      return response;
    }

    const result = await this.dependencies.database.queryAsSemanticRole({
      tenantId: context.tenantId,
      sql: compiled.sql,
      parameters: compiled.parameters,
      statementTimeoutMs: this.statementTimeoutMs,
      expectedIdentityGraph: identityGraphForTenant(tenant),
    });
    const health = await this.dependencies.dataHealth.getForTopic(context, compiled.topic);
    const topic = this.dependencies.registry.topics.get(compiled.topic);
    const freshness = freshnessWarnings(tenant.sourceWatermarks, topic?.freshnessMinutes ?? 120, this.clock());
    const validation = validateSemanticResult(
      result.rows,
      compiled.resultColumns,
      health.status,
      health.checks,
      [...compiled.warnings, ...freshness],
    );
    const state: AnswerState = validation.status === "passed"
      ? "verified"
      : validation.status === "warning" ? "qualified" : "unavailable";
    const visibleRows = result.rows.map(stripInternalColumns);
    const definitionDetails = compiled.metricIds.flatMap((id) => {
      const metric = this.dependencies.registry.metrics.get(id);
      return metric ? [metricDefinitionDetail(metric)] : [];
    });
    const response: SemanticToolResponse = {
      state,
      resultId: `semantic:${bundleHash}`,
      ...(state !== "unavailable" ? { data: { columns: [...compiled.resultColumns], rows: visibleRows } } : {}),
      provenance: {
        bundleHash,
        registryVersion: this.dependencies.registry.version,
        identityGraph: identityGraphForTenant(tenant),
        sources: [...compiled.sourceTables],
        sourceWatermarks: { ...tenant.sourceWatermarks },
        sourceDetails: sourceDetailsForTenant(tenant),
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
    await this.dependencies.audit.append({
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
      resultDigest: contentDigest({ columns: compiled.resultColumns, rows: visibleRows }),
      rowCount: visibleRows.length,
      durationMs: result.durationMs,
      cacheHit: false,
      state,
      validation,
    });
    await this.dependencies.cache.set(cacheKey, response, this.cacheTtlSeconds);
    return response;
  }

  private async runSourceQuery(input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse> {
    const parsed = semanticToolInputSchemas.run_source_query.parse(input);
    const tenant = await this.dependencies.contextProvider.load(context);
    const catalogue = await this.dependencies.sourceCatalogue.listFields(context, parsed.connectionId, parsed.sourceTable);
    const compiled = compileSourceQuery(parsed, context.tenantId, context.role, catalogue);
    const bundleHash = semanticBundleHash({
      registryVersion: this.dependencies.registry.version,
      overlayVersion: tenant.overlayVersion,
      identityGraph: identityGraphForTenant(tenant),
      packVersions: tenant.packVersions,
      sourceWatermarks: tenant.sourceWatermarks,
      ir: { route: "source_exploration", ...parsed },
    });
    const result = await this.dependencies.database.queryAsSemanticRole({
      tenantId: context.tenantId,
      sql: compiled.sql,
      parameters: compiled.parameters,
      statementTimeoutMs: this.statementTimeoutMs,
      expectedIdentityGraph: identityGraphForTenant(tenant),
    });
    const authoritativeConnection = compiled.authorityConcept
      ? tenant.authorityByConcept[compiled.authorityConcept]
      : undefined;
    const authorityWarning = authoritativeConnection && authoritativeConnection !== parsed.connectionId
      ? `This source is not authoritative for ${compiled.authorityConcept}; ${authoritativeConnection} is authoritative.`
      : undefined;
    const warnings = authorityWarning ? [authorityWarning] : [];
    const validation = {
      status: (warnings.length ? "warning" : "passed") as "warning" | "passed",
      checks: [{ checkId: "single_source", status: "passed" }, { checkId: "pii_gate", status: "passed" }],
      warnings,
    };
    const promotionCandidateId = await this.dependencies.audit.promoteSourceField({
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
    const sourceThrough = tenant.sourceWatermarks[parsed.connectionId] ?? latestWatermark(tenant.sourceWatermarks) ?? this.clock().toISOString();
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
        sourceWatermarks: { ...tenant.sourceWatermarks },
        sourceDetails: sourceDetailsForSource(tenant, compiled.connectorId, parsed.connectionId, sourceThrough),
        definitionsApplied,
        definitionDetails: compiled.fieldDefinitions.map((field) => ({
          id: `${parsed.sourceTable}.${field.field}`,
          label: humanize(field.field),
          definition: field.definition,
        })),
        timeRange: {
          label: `Source exploration · data through ${sourceThrough}`,
          start: sourceThrough,
          end: sourceThrough,
          timezone: tenant.timezone,
        },
        ...(authorityWarning ? { authorityWarning } : {}),
      },
      validation,
      performance: { cacheHit: false, durationMs: result.durationMs, rowCount: result.rows.length },
    };
    await this.dependencies.audit.append({
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
      resultDigest: contentDigest({ columns: compiled.columns, rows: response.data?.rows ?? [] }),
      rowCount: result.rows.length,
      durationMs: result.durationMs,
      cacheHit: false,
      state: "exploratory",
      validation,
    });
    return response;
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
        answerable: topicIsAnswerable(topic, tenant, this.dependencies.registry),
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
    const required = [...new Set([
      ...topic.requiredCapabilities,
      ...topic.metrics.flatMap((id) => this.dependencies.registry.metrics.get(id)?.requiredCapabilities ?? []),
    ])];
    const capabilities = {
      topic: topicId,
      answerable: required.every((item) => tenant.capabilities.has(item)),
      required,
      available: required.filter((item) => tenant.capabilities.has(item)),
      missing: required.filter((item) => !tenant.capabilities.has(item)),
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
    if (context.confirmedValue === undefined || String(parsed.value) !== context.confirmedValue) {
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

function validateSemanticResult(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly string[],
  healthStatus: "passed" | "warning" | "failed" | "blocked",
  checks: readonly Readonly<Record<string, unknown>>[],
  warnings: readonly string[],
): SemanticToolResponse["validation"] {
  const shapeFailures = rows.filter((row) => columns.some((column) => !(column in row))).length;
  const combinedWarnings = [...warnings, ...(shapeFailures ? [`${shapeFailures} result rows did not match the compiled result shape.`] : [])];
  const status: SemanticToolResponse["validation"]["status"] = healthStatus === "failed" || healthStatus === "blocked" || shapeFailures
    ? healthStatus === "blocked" ? "blocked" : "failed"
    : healthStatus === "warning" || combinedWarnings.length ? "warning" : "passed";
  return {
    status,
    checks: [...checks.map((check) => ({ ...check })), { checkId: "result_shape", status: shapeFailures ? "failed" : "passed", failingRows: shapeFailures }],
    warnings: combinedWarnings,
  };
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
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__key_")));
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

function topicIsAnswerable(topic: TopicContract, tenant: TenantSemanticContext, registry: SemanticRegistry): boolean {
  const required = new Set([
    ...topic.requiredCapabilities,
    ...topic.metrics.flatMap((metricId) => registry.metrics.get(metricId)?.requiredCapabilities ?? []),
  ]);
  return [...required].every((capability) => tenant.capabilities.has(capability));
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
  return [configured ? { ...configured } : { connectorId, connectionId, label: connectorLabel(connectorId), dataThrough }];
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
