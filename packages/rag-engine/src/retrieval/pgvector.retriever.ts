/**
 * pgvector Retriever
 *
 * Handles all database operations for the RAG engine:
 *   - Schema initialization (CREATE TABLE + indexes)
 *   - Upsert of embedded chunks (INSERT ON CONFLICT DO UPDATE)
 *   - Cosine similarity search via pgvector <=> operator
 *   - Stored hash lookup for change detection
 *   - Stale document cleanup
 *
 * Uses the `pg` client directly — no ORM overhead for vector operations.
 * pgvector's <=> operator is native SQL — ORMs don't add value here.
 */

import type { Pool, PoolClient } from 'pg';
import { toPgvectorString } from '../embeddings/openai-embeddings.js';
import type {
  DocCategory,
  EmbeddedChunk,
  RagDocumentRow,
  RetrievalQuery,
  RetrievedDocument,
} from '../types/rag.types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const INIT_SQL = `
-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Main RAG documents table
CREATE TABLE IF NOT EXISTS rag_documents (
  id               TEXT PRIMARY KEY,
  source_url       TEXT NOT NULL,
  title            TEXT NOT NULL,
  category         TEXT NOT NULL,
  chunk_index      INTEGER NOT NULL,
  total_chunks     INTEGER NOT NULL,
  content          TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  token_estimate   INTEGER NOT NULL DEFAULT 0,
  has_code_block   BOOLEAN NOT NULL DEFAULT FALSE,
  embedding        vector(1536),
  crawled_at       TIMESTAMPTZ NOT NULL,
  embedded_at      TIMESTAMPTZ,
  embedding_model  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cosine similarity index (IVFFlat — good for ~100k docs)
-- Lists=100 is a good default for up to ~1M vectors
CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx
  ON rag_documents
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Hash lookup index (for change detection)
CREATE INDEX IF NOT EXISTS rag_documents_url_hash_idx
  ON rag_documents (source_url, content_hash);

-- Category filter index
CREATE INDEX IF NOT EXISTS rag_documents_category_idx
  ON rag_documents (category);

-- Freshness index
CREATE INDEX IF NOT EXISTS rag_documents_crawled_at_idx
  ON rag_documents (crawled_at);

-- Stored hash lookup view (one row per source URL — latest hash)
CREATE OR REPLACE VIEW rag_url_hashes AS
  SELECT DISTINCT ON (source_url)
    source_url,
    content_hash,
    crawled_at
  FROM rag_documents
  ORDER BY source_url, crawled_at DESC;

-- Crawl run log (for observability)
CREATE TABLE IF NOT EXISTS rag_crawl_runs (
  id                  TEXT PRIMARY KEY,
  started_at          TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  targets_attempted   INTEGER NOT NULL DEFAULT 0,
  targets_succeeded   INTEGER NOT NULL DEFAULT 0,
  targets_failed      INTEGER NOT NULL DEFAULT 0,
  chunks_created      INTEGER NOT NULL DEFAULT 0,
  chunks_skipped      INTEGER NOT NULL DEFAULT 0,
  errors              JSONB NOT NULL DEFAULT '[]'
);
`;

// ─── Retriever class ──────────────────────────────────────────────────────────

export class PgvectorRetriever {
  constructor(private readonly pool: Pool) {}

  // ─── Schema ──────────────────────────────────────────────────────────────

  async initSchema(): Promise<void> {
    await this.pool.query(INIT_SQL);
  }

  // ─── Change detection ─────────────────────────────────────────────────────

  async getStoredHash(url: string): Promise<string | null> {
    const result = await this.pool.query<{ content_hash: string }>(
      `SELECT content_hash FROM rag_url_hashes WHERE source_url = $1`,
      [url],
    );
    return result.rows[0]?.content_hash ?? null;
  }

  // ─── Upsert chunks ────────────────────────────────────────────────────────

  /**
   * Upserts a batch of embedded chunks.
   * Uses ON CONFLICT DO UPDATE to handle re-crawled pages cleanly.
   * Runs in a single transaction per batch.
   */
  async upsertEmbeddedChunks(
    chunks: ReadonlyArray<EmbeddedChunk>,
  ): Promise<void> {
    if (chunks.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO rag_documents (
            id, source_url, title, category, chunk_index, total_chunks,
            content, content_hash, token_estimate, has_code_block,
            embedding, crawled_at, embedded_at, embedding_model,
            created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11::vector, $12, NOW(), $13,
            NOW(), NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            content       = EXCLUDED.content,
            content_hash  = EXCLUDED.content_hash,
            embedding     = EXCLUDED.embedding,
            embedded_at   = NOW(),
            updated_at    = NOW()`,
          [
            chunk.id,
            chunk.sourceUrl,
            chunk.sourceTitle,
            chunk.category,
            chunk.chunkIndex,
            chunk.totalChunks,
            chunk.content,
            chunk.contentHash,
            chunk.tokenEstimate,
            chunk.hasCodeBlock,
            toPgvectorString(chunk.embedding),
            chunk.crawledAt,
            chunk.embeddingModel,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Stores raw chunks (without embeddings) — used by the crawler before embedding.
   * Embedding is added in a separate pass by the RagService.
   */
  async upsertRawChunks(
    chunks: ReadonlyArray<Omit<EmbeddedChunk, 'embedding' | 'embeddedAt' | 'embeddingModel'>>,
  ): Promise<void> {
    if (chunks.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO rag_documents (
            id, source_url, title, category, chunk_index, total_chunks,
            content, content_hash, token_estimate, has_code_block,
            crawled_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, NOW(), NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            content       = EXCLUDED.content,
            content_hash  = EXCLUDED.content_hash,
            updated_at    = NOW()`,
          [
            chunk.id,
            chunk.sourceUrl,
            chunk.sourceTitle,
            chunk.category,
            chunk.chunkIndex,
            chunk.totalChunks,
            chunk.content,
            chunk.contentHash,
            chunk.tokenEstimate,
            chunk.hasCodeBlock,
            chunk.crawledAt,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Retrieval ────────────────────────────────────────────────────────────

  /**
   * Cosine similarity search using pgvector's <=> operator.
   * Returns documents sorted by similarity (highest first).
   *
   * The query embeds the search term externally and passes the vector here.
   * This keeps the DB layer free of API calls.
   */
  async retrieve(
    queryEmbedding: ReadonlyArray<number>,
    query: RetrievalQuery,
  ): Promise<ReadonlyArray<RetrievedDocument>> {
    const categoryFilter =
      query.categoryFilter !== undefined
        ? 'AND category = $4'
        : '';

    const params: Array<string | number> = [
      toPgvectorString(queryEmbedding),
      query.topK,
      query.similarityThreshold,
    ];

    if (query.categoryFilter !== undefined) {
      params.push(query.categoryFilter);
    }

    const result = await this.pool.query<RagDocumentRow & { similarity: number }>(
      `SELECT
        id,
        source_url,
        title,
        category,
        content,
        has_code_block,
        crawled_at,
        1 - (embedding <=> $1::vector) AS similarity
      FROM rag_documents
      WHERE embedding IS NOT NULL
        AND 1 - (embedding <=> $1::vector) >= $3
        ${categoryFilter}
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      source: row.source_url,
      title: row.title,
      content: row.content,
      category: row.category as DocCategory,
      similarity: row.similarity,
      retrievedAt: row.crawled_at,
      hasCodeBlock: row.has_code_block,
    }));
  }

  // ─── Pending embedding queue ──────────────────────────────────────────────

  /**
   * Returns chunks that have been crawled but not yet embedded.
   * The RagService polls this to process the embedding queue.
   */
  async getPendingEmbeddings(
    limit = 200,
  ): Promise<ReadonlyArray<{ id: string; content: string }>> {
    const result = await this.pool.query<{ id: string; content: string }>(
      `SELECT id, content
       FROM rag_documents
       WHERE embedding IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /**
   * Updates the embedding for a specific chunk.
   */
  async updateEmbedding(
    chunkId: string,
    embedding: ReadonlyArray<number>,
    model: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE rag_documents
       SET embedding      = $2::vector,
           embedded_at    = NOW(),
           embedding_model = $3,
           updated_at     = NOW()
       WHERE id = $1`,
      [chunkId, toPgvectorString(embedding), model],
    );
  }

  // ─── Stale document cleanup ───────────────────────────────────────────────

  /**
   * Removes documents that haven't been crawled in the given number of days.
   * Prevents the index from growing with deleted/moved pages.
   */
  async deleteStaleDocuments(olderThanDays = 60): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM rag_documents
       WHERE crawled_at < NOW() - INTERVAL '1 day' * $1
       RETURNING id`,
      [olderThanDays],
    );
    return result.rowCount ?? 0;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getIndexStats(): Promise<IndexStats> {
    const result = await this.pool.query<{
      category: string;
      total: string;
      embedded: string;
      oldest_crawl: string;
      newest_crawl: string;
    }>(
      `SELECT
        category,
        COUNT(*) AS total,
        COUNT(embedding) AS embedded,
        MIN(crawled_at) AS oldest_crawl,
        MAX(crawled_at) AS newest_crawl
       FROM rag_documents
       GROUP BY category
       ORDER BY category`,
    );

    return {
      byCategory: result.rows.map((row) => ({
        category: row.category as DocCategory,
        totalChunks: parseInt(row.total, 10),
        embeddedChunks: parseInt(row.embedded, 10),
        oldestCrawl: row.oldest_crawl,
        newestCrawl: row.newest_crawl,
      })),
      totalChunks: result.rows.reduce((sum, r) => sum + parseInt(r.total, 10), 0),
    };
  }
}

export interface IndexStats {
  readonly byCategory: ReadonlyArray<{
    readonly category: DocCategory;
    readonly totalChunks: number;
    readonly embeddedChunks: number;
    readonly oldestCrawl: string;
    readonly newestCrawl: string;
  }>;
  readonly totalChunks: number;
}
