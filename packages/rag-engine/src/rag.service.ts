/**
 * RAG Service
 *
 * The main entry point for the rag-engine package.
 * Orchestrates the full lifecycle:
 *
 *   WRITE PATH (weekly crawl job):
 *     crawl() → fetch pages → chunk → store raw → embed batch → update vectors
 *
 *   READ PATH (per migration request):
 *     retrieve(query) → embed query → pgvector cosine search → return docs
 *
 * This service is consumed by two callers:
 *   1. apps/worker — the BullMQ weekly crawl processor
 *   2. packages/llm-orchestrator — Stage 3 RAG retrieval
 *
 * The RagService implements the RagRetriever interface from llm-orchestrator
 * so it can be injected directly into OrchestratorDeps.
 */

import type { Pool } from 'pg';
import { crawlAll } from './crawler/atlassian-docs.crawler.js';
import type { CrawlerDeps, CrawlProgressEvent } from './crawler/atlassian-docs.crawler.js';
import { CRAWL_TARGETS } from './crawler/crawl-targets.js';
import {
  embedBatch,
  embedText,
} from './embeddings/openai-embeddings.js';
import { PgvectorRetriever } from './retrieval/pgvector.retriever.js';
import type { IndexStats } from './retrieval/pgvector.retriever.js';
import type {
  CrawlRunResult,
  CrawlTarget,
  DocumentChunk,
  RagEngineConfig,
  RetrievedDocument,
} from './types/rag.types.js';
import { DEFAULT_RAG_CONFIG } from './types/rag.types.js';

// ─── RAG Service ──────────────────────────────────────────────────────────────

export class RagService {
  private readonly retriever: PgvectorRetriever;
  private readonly config: RagEngineConfig;

  constructor(pool: Pool, config: RagEngineConfig) {
    this.retriever = new PgvectorRetriever(pool);
    this.config = config;
  }

  // ─── Initialization ───────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await this.retriever.initSchema();
  }

  // ─── WRITE PATH: Weekly crawl ─────────────────────────────────────────────

  /**
   * Runs a full crawl cycle:
   *   1. Fetches all target URLs
   *   2. Chunks changed pages
   *   3. Stores raw chunks to DB
   *   4. Embeds pending chunks in batches
   *   5. Returns a run report
   */
  async runCrawl(
    options: {
      targets?: ReadonlyArray<CrawlTarget>;
      onProgress?: (event: CrawlProgressEvent) => void;
    } = {},
  ): Promise<CrawlRunResult> {
    const targets = options.targets ?? CRAWL_TARGETS;

    const crawlerDeps: CrawlerDeps = {
      getStoredHash: (url) => this.retriever.getStoredHash(url),
      storeChunks: (chunks) => this.retriever.upsertRawChunks(chunks),
      ...(options.onProgress !== undefined && { onProgress: options.onProgress }),
    };

    // Step 1: Crawl and store raw chunks
    const crawlResult = await crawlAll(crawlerDeps, {
      crawlConcurrency: this.config.crawlConcurrency,
      crawlDelayMs: this.config.crawlDelayMs,
      maxChunkTokens: this.config.maxChunkTokens,
      chunkOverlapTokens: this.config.chunkOverlapTokens,
    }, targets);

    // Step 2: Embed all pending chunks (those without embeddings yet)
    await this.embedPendingChunks();

    // Step 3: Clean up stale documents (not crawled in 60 days)
    await this.retriever.deleteStaleDocuments(60);

    return crawlResult;
  }

  /**
   * Processes the pending embedding queue in batches.
   * Called after each crawl run, and can also run independently to
   * recover from embedding failures.
   */
  async embedPendingChunks(batchSize = 100): Promise<number> {
    let totalEmbedded = 0;
    let hasMore = true;

    while (hasMore) {
      const pending = await this.retriever.getPendingEmbeddings(batchSize);

      if (pending.length === 0) {
        hasMore = false;
        break;
      }

      // Embed the batch
      const texts = pending.map((p) => p.content);
      const { embeddings } = await embedBatch(
        texts,
        this.config.openAiApiKey,
        this.config.embeddingModel,
        this.config.embeddingDimensions,
      );

      // Update each chunk with its embedding
      for (let i = 0; i < pending.length; i++) {
        const chunk = pending[i];
        const embedding = embeddings[i];
        if (chunk === undefined || embedding === undefined) continue;

        await this.retriever.updateEmbedding(
          chunk.id,
          embedding,
          this.config.embeddingModel,
        );
      }

      totalEmbedded += pending.length;

      // If we got fewer than batchSize, there are no more pending chunks
      if (pending.length < batchSize) {
        hasMore = false;
      }
    }

    return totalEmbedded;
  }

  // ─── READ PATH: Retrieval ─────────────────────────────────────────────────

  /**
   * Retrieves the most relevant documents for a query string.
   * Implements the RagRetriever interface from @atlasreforge/llm-orchestrator.
   *
   * Process:
   *   1. Embed the query text
   *   2. Run cosine similarity search in pgvector
   *   3. Return sorted results above similarity threshold
   */
  async retrieve(
    query: string,
    topK: number,
    categoryFilter?: string,
  ): Promise<ReadonlyArray<RetrievedDocument>> {
    // Embed the query
    const { embedding } = await embedText(
      query,
      this.config.openAiApiKey,
      this.config.embeddingModel,
      this.config.embeddingDimensions,
    );

    const retrievalQuery = {
      text: query,
      topK,
      similarityThreshold: this.config.similarityThreshold,
      ...(categoryFilter !== undefined && {
        categoryFilter: categoryFilter as RetrievedDocument['category'],
      }),
    };
    return this.retriever.retrieve(embedding, retrievalQuery);
  }

  // ─── Stats / Observability ────────────────────────────────────────────────

  async getIndexStats(): Promise<IndexStats> {
    return this.retriever.getIndexStats();
  }
}

// ─── Factory function ─────────────────────────────────────────────────────────

/**
 * Creates a fully configured RagService.
 * Reads config from environment variables with sensible defaults.
 */
export function createRagService(
  pool: Pool,
  overrides: Partial<RagEngineConfig> = {},
): RagService {
  const config: RagEngineConfig = {
    databaseUrl: process.env['DATABASE_URL'] ?? '',
    openAiApiKey: process.env['OPENAI_API_KEY'] ?? '',
    ...DEFAULT_RAG_CONFIG,
    ...overrides,
  };

  if (config.databaseUrl === '') {
    throw new Error('DATABASE_URL environment variable is required');
  }
  if (config.openAiApiKey === '') {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  return new RagService(pool, config);
}

// Re-export key types used by consumers
export type { DocumentChunk, RetrievedDocument, CrawlRunResult, IndexStats };
