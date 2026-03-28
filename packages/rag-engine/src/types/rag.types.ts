/**
 * @atlasreforge/rag-engine — Types
 *
 * These types are intentionally decoupled from @atlasreforge/llm-orchestrator.
 * The RagDocument interface in the orchestrator is a read-side view (retrieval output).
 * These types cover the full lifecycle: crawl → chunk → embed → store → retrieve.
 */

// ─── Crawl layer ──────────────────────────────────────────────────────────────

/**
 * A crawl target — one URL with metadata about what it covers.
 * The crawler fires one fetch per target and extracts text content.
 */
export interface CrawlTarget {
  readonly url: string;
  readonly category: DocCategory;
  readonly priority: 'high' | 'medium' | 'low';
  readonly expectedUpdateFrequency: 'weekly' | 'monthly' | 'rarely';
}

export type DocCategory =
  | 'forge-api'           // developer.atlassian.com/platform/forge/
  | 'rest-api-v3'         // developer.atlassian.com/cloud/jira/platform/rest/v3/
  | 'scriptrunner-cloud'  // scriptrunner.adaptavist.com/cloud/
  | 'connect-api'         // developer.atlassian.com/cloud/jira/platform/connect/
  | 'forge-manifest'      // Forge manifest.yml reference
  | 'oauth-scopes'        // OAuth 2.0 scopes reference
  | 'migration-guide';    // Server → Cloud migration guides

export interface CrawledPage {
  readonly url: string;
  readonly title: string;
  readonly rawText: string;          // Extracted plain text (HTML stripped)
  readonly contentHash: string;      // SHA-256 — used for change detection
  readonly crawledAt: string;        // ISO 8601
  readonly category: DocCategory;
  readonly httpStatus: number;
}

// ─── Chunk layer ──────────────────────────────────────────────────────────────

/**
 * A chunk is a semantically coherent slice of a crawled page.
 * Code blocks are kept intact — never split mid-block.
 *
 * Target: 400–600 tokens per chunk, 50-token overlap between adjacent chunks.
 */
export interface DocumentChunk {
  readonly id: string;               // Deterministic: SHA-256(url + chunkIndex)
  readonly sourceUrl: string;
  readonly sourceTitle: string;
  readonly category: DocCategory;
  readonly chunkIndex: number;       // Position within the source page
  readonly totalChunks: number;      // Total chunks from this page
  readonly content: string;          // The actual text content
  readonly contentHash: string;      // SHA-256 of chunk content
  readonly tokenEstimate: number;    // Approximate token count
  readonly hasCodeBlock: boolean;    // True if chunk contains a code sample
  readonly crawledAt: string;        // Inherited from CrawledPage
}

// ─── Embedding layer ──────────────────────────────────────────────────────────

export interface EmbeddedChunk extends DocumentChunk {
  readonly embedding: ReadonlyArray<number>;   // 1536-dim vector (text-embedding-3-small)
  readonly embeddedAt: string;                 // ISO 8601
  readonly embeddingModel: string;             // e.g. "text-embedding-3-small"
}

// ─── Storage layer (pgvector) ─────────────────────────────────────────────────

/**
 * The database row shape for the rag_documents table.
 * The embedding column uses pgvector's vector(1536) type.
 */
export interface RagDocumentRow {
  readonly id: string;               // UUID
  readonly source_url: string;
  readonly title: string;
  readonly category: DocCategory;
  readonly chunk_index: number;
  readonly total_chunks: number;
  readonly content: string;
  readonly content_hash: string;
  readonly token_estimate: number;
  readonly has_code_block: boolean;
  readonly embedding: string;        // pgvector format: '[0.1, 0.2, ...]'
  readonly crawled_at: string;
  readonly embedded_at: string;
  readonly embedding_model: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// ─── Retrieval layer ──────────────────────────────────────────────────────────

export interface RetrievalQuery {
  readonly text: string;
  readonly topK: number;
  readonly similarityThreshold: number;   // 0–1, default 0.70
  readonly categoryFilter?: DocCategory;  // Optional — filter by doc type
}

export interface RetrievedDocument {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly content: string;
  readonly category: DocCategory;
  readonly similarity: number;            // Cosine similarity 0–1
  readonly retrievedAt: string;           // crawled_at of the doc (freshness signal)
  readonly hasCodeBlock: boolean;
}

// ─── Crawler run metadata ─────────────────────────────────────────────────────

export interface CrawlRunResult {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly targetsAttempted: number;
  readonly targetsSucceeded: number;
  readonly targetsFailed: number;
  readonly chunksCreated: number;
  readonly chunksSkipped: number;       // Unchanged — hash match
  readonly chunksEmbedded: number;
  readonly errors: ReadonlyArray<CrawlError>;
}

export interface CrawlError {
  readonly url: string;
  readonly error: string;
  readonly phase: 'fetch' | 'parse' | 'chunk' | 'embed' | 'store';
}

// ─── RAG engine config ────────────────────────────────────────────────────────

export interface RagEngineConfig {
  readonly databaseUrl: string;
  readonly openAiApiKey: string;
  readonly embeddingModel: string;        // Default: 'text-embedding-3-small'
  readonly embeddingDimensions: number;   // Default: 1536
  readonly similarityThreshold: number;   // Default: 0.70
  readonly maxChunkTokens: number;        // Default: 500
  readonly chunkOverlapTokens: number;    // Default: 50
  readonly crawlConcurrency: number;      // Default: 3 (respectful crawling)
  readonly crawlDelayMs: number;          // Default: 500ms between requests
}

export const DEFAULT_RAG_CONFIG: Omit<RagEngineConfig, 'databaseUrl' | 'openAiApiKey'> = {
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
  similarityThreshold: 0.70,
  maxChunkTokens: 500,
  chunkOverlapTokens: 50,
  crawlConcurrency: 3,
  crawlDelayMs: 500,
};
