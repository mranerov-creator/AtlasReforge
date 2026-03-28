/**
 * OpenAI Embeddings
 *
 * Generates vector embeddings using text-embedding-3-small (1536 dimensions).
 *
 * DESIGN DECISIONS:
 * - text-embedding-3-small: best cost/quality ratio for retrieval tasks ($0.02/1M tokens)
 * - Batch size: 100 texts per API call (OpenAI limit is 2048, but 100 is safer for rate limits)
 * - Retry: exponential backoff on 429 (rate limit) and 5xx errors
 * - The embedding is stored as a pgvector string '[0.1, 0.2, ...]' — Postgres handles the format
 */

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;
const BATCH_SIZE = 100;

interface OpenAIEmbeddingRequest {
  input: string[];
  model: string;
  dimensions?: number;
}

interface OpenAIEmbeddingResponse {
  data: Array<{
    index: number;
    embedding: number[];
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
  model: string;
}

export interface EmbeddingResult {
  readonly embedding: ReadonlyArray<number>;
  readonly tokensUsed: number;
}

export interface BatchEmbeddingResult {
  readonly embeddings: ReadonlyArray<ReadonlyArray<number>>;
  readonly totalTokensUsed: number;
}

// ─── Single embedding ─────────────────────────────────────────────────────────

export async function embedText(
  text: string,
  apiKey: string,
  model = DEFAULT_MODEL,
  dimensions = DEFAULT_DIMENSIONS,
): Promise<EmbeddingResult> {
  const result = await embedBatch([text], apiKey, model, dimensions);
  const embedding = result.embeddings[0];
  if (embedding === undefined) {
    throw new EmbeddingError('No embedding returned for single text');
  }
  return { embedding, tokensUsed: result.totalTokensUsed };
}

// ─── Batch embedding ──────────────────────────────────────────────────────────

export async function embedBatch(
  texts: ReadonlyArray<string>,
  apiKey: string,
  model = DEFAULT_MODEL,
  dimensions = DEFAULT_DIMENSIONS,
): Promise<BatchEmbeddingResult> {
  if (texts.length === 0) {
    return { embeddings: [], totalTokensUsed: 0 };
  }

  const allEmbeddings: Array<ReadonlyArray<number>> = [];
  let totalTokensUsed = 0;

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await embedBatchWithRetry(batch, apiKey, model, dimensions);
    allEmbeddings.push(...result.embeddings);
    totalTokensUsed += result.totalTokensUsed;
  }

  return { embeddings: allEmbeddings, totalTokensUsed };
}

async function embedBatchWithRetry(
  texts: ReadonlyArray<string>,
  apiKey: string,
  model: string,
  dimensions: number,
  maxRetries = 3,
): Promise<BatchEmbeddingResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callEmbeddingsApi(texts, apiKey, model, dimensions);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (err instanceof EmbeddingApiError) {
        // Don't retry client errors
        if (err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
          throw err;
        }
        // 429: respect Retry-After header or use exponential backoff
        const delay = err.retryAfterMs ?? Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  throw lastError ?? new EmbeddingError('Unknown error in embedding retry loop');
}

async function callEmbeddingsApi(
  texts: ReadonlyArray<string>,
  apiKey: string,
  model: string,
  dimensions: number,
): Promise<BatchEmbeddingResult> {
  const body: OpenAIEmbeddingRequest = {
    input: [...texts],
    model,
    ...(dimensions !== 1536 && { dimensions }), // Only send if non-default
  };

  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After');
    const retryAfterMs = retryAfter !== null ? parseInt(retryAfter, 10) * 1000 : undefined;
    const errorText = await response.text();
    throw new EmbeddingApiError(
      `OpenAI embeddings API error ${response.status}: ${errorText}`,
      response.status,
      retryAfterMs,
    );
  }

  const data = (await response.json()) as OpenAIEmbeddingResponse;

  // Sort by index to ensure order matches input
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  const embeddings = sorted.map((item) => item.embedding as ReadonlyArray<number>);

  return {
    embeddings,
    totalTokensUsed: data.usage.total_tokens,
  };
}

// ─── pgvector format ──────────────────────────────────────────────────────────

/**
 * Converts a float array to pgvector's string format: '[0.1,0.2,0.3]'
 */
export function toPgvectorString(embedding: ReadonlyArray<number>): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Parses pgvector string back to float array.
 */
export function fromPgvectorString(pgvector: string): ReadonlyArray<number> {
  return pgvector
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(Number);
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export class EmbeddingApiError extends EmbeddingError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'EmbeddingApiError';
  }
}
