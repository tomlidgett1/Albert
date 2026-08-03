import OpenAI from "openai";

export const ALBERT_CATALOGUE_EMBEDDING_MODEL = "text-embedding-3-large";
export const ALBERT_CATALOGUE_EMBEDDING_DIMENSIONS = 1536;
const MAX_EMBEDDING_BATCH = 100;

export type EmbeddingProvider = Readonly<{
  model: typeof ALBERT_CATALOGUE_EMBEDDING_MODEL;
  dimensions: typeof ALBERT_CATALOGUE_EMBEDDING_DIMENSIONS;
  embedQuery(input: string): Promise<readonly number[]>;
  embedDocuments(inputs: readonly string[]): Promise<readonly (readonly number[])[]>;
}>;

type EmbeddingClient = Readonly<{
  embeddings: Readonly<{
    create(input: Readonly<{
      model: string;
      input: string | readonly string[];
      dimensions: number;
      encoding_format: "float";
    }>): Promise<Readonly<{
      data: readonly Readonly<{ index: number; embedding: readonly number[] }>[];
    }>>;
  }>;
}>;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model = ALBERT_CATALOGUE_EMBEDDING_MODEL;
  readonly dimensions = ALBERT_CATALOGUE_EMBEDDING_DIMENSIONS;
  private readonly client: EmbeddingClient;

  constructor(options: Readonly<{
    apiKey?: string;
    baseURL?: string;
    timeoutMs?: number;
    client?: EmbeddingClient;
  }>) {
    if (options.client) {
      this.client = options.client;
      return;
    }
    if (!options.apiKey?.trim()) throw new Error("OPENAI_API_KEY is required for catalogue embeddings.");
    if (!options.baseURL?.trim()) throw new Error("OPENAI_BASE_URL is required for catalogue embeddings.");
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 20_000,
      maxRetries: 2,
    }) as unknown as EmbeddingClient;
  }

  async embedQuery(input: string): Promise<readonly number[]> {
    const normalized = normalizeInput(input);
    const embeddings = await this.create([normalized]);
    const embedding = embeddings[0];
    if (!embedding) throw new Error("OpenAI returned no catalogue query embedding.");
    return embedding;
  }

  async embedDocuments(inputs: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (!inputs.length) return Object.freeze([]);
    const normalized = inputs.map(normalizeInput);
    const embeddings: (readonly number[])[] = [];
    for (let offset = 0; offset < normalized.length; offset += MAX_EMBEDDING_BATCH) {
      embeddings.push(...await this.create(normalized.slice(offset, offset + MAX_EMBEDDING_BATCH)));
    }
    return Object.freeze(embeddings);
  }

  private async create(inputs: readonly string[]): Promise<readonly (readonly number[])[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: inputs,
      dimensions: this.dimensions,
      encoding_format: "float",
    });
    if (response.data.length !== inputs.length) {
      throw new Error(`OpenAI returned ${response.data.length} embeddings for ${inputs.length} catalogue documents.`);
    }
    const ordered = [...response.data].sort((left, right) => left.index - right.index);
    return Object.freeze(ordered.map((item, index) => {
      if (item.index !== index) throw new Error("OpenAI catalogue embedding indexes are incomplete or duplicated.");
      return validateEmbedding(item.embedding, this.dimensions);
    }));
  }
}

export function serializePgVector(embedding: readonly number[]): string {
  const validated = validateEmbedding(embedding, ALBERT_CATALOGUE_EMBEDDING_DIMENSIONS);
  return `[${validated.join(",")}]`;
}

function normalizeInput(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Catalogue embedding input cannot be empty.");
  if (normalized.length > 20_000) throw new Error("Catalogue embedding input exceeds 20,000 characters.");
  return normalized;
}

function validateEmbedding(value: readonly number[], dimensions: number): readonly number[] {
  if (value.length !== dimensions) {
    throw new Error(`Catalogue embedding must contain exactly ${dimensions} finite dimensions; received ${value.length}.`);
  }
  if (value.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new Error("Catalogue embedding contains a non-finite coordinate.");
  }
  return Object.freeze([...value]);
}
