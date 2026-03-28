/**
 * @atlasreforge/rag-engine — Public API
 */

// Main service
export { RagService, createRagService } from './rag.service.js';
export type { DocumentChunk, RetrievedDocument, CrawlRunResult, IndexStats } from './rag.service.js';

// Types
export type {
  CrawlTarget,
  CrawledPage,
  DocCategory,
  DocumentChunk as RagChunk,
  EmbeddedChunk,
  RagEngineConfig,
  RagDocumentRow,
  RetrievalQuery,
  RetrievedDocument as RagResult,
  CrawlRunResult as CrawlReport,
  CrawlError,
} from './types/rag.types.js';
export { DEFAULT_RAG_CONFIG } from './types/rag.types.js';

// Crawler
export { CRAWL_TARGETS } from './crawler/crawl-targets.js';
export {
  fetchPage,
  hasContentChanged,
  crawlAll,
  CrawlFetchError,
} from './crawler/atlassian-docs.crawler.js';
export type { CrawlerDeps, CrawlProgressEvent } from './crawler/atlassian-docs.crawler.js';

// Chunker
export {
  extractTextFromHtml,
  extractTitleFromHtml,
  estimateTokens,
  chunkText,
  buildChunks,
} from './crawler/chunker.js';

// Embeddings
export {
  embedText,
  embedBatch,
  toPgvectorString,
  fromPgvectorString,
  EmbeddingError,
  EmbeddingApiError,
} from './embeddings/openai-embeddings.js';

// Retriever (for direct use / testing)
export { PgvectorRetriever, INIT_SQL } from './retrieval/pgvector.retriever.js';
export type { IndexStats as PgIndexStats } from './retrieval/pgvector.retriever.js';
