/**
 * Atlassian Docs Crawler
 *
 * Fetches each CrawlTarget URL, extracts plain text, and returns CrawledPages.
 *
 * DESIGN DECISIONS:
 * - Rate limiting: crawlDelayMs between requests (default 500ms) — be a respectful crawler
 * - Concurrency: max 3 parallel fetches (configurable)
 * - Change detection: content hash compared against stored hash in DB
 *   If hash is unchanged → skip re-embedding (saves OpenAI cost)
 * - Error isolation: one failed URL doesn't abort the full crawl run
 * - User-Agent: identifies AtlasReforge to Atlassian (transparent crawling)
 *
 * WHAT THIS DOES NOT DO:
 * - Does not follow links (single-page fetcher, not a spider)
 * - Does not handle pagination within a page
 * - Does not parse JavaScript-rendered content (Atlassian docs are SSR)
 */

import { createHash } from 'node:crypto';
import {
  buildChunks,
  extractTextFromHtml,
  extractTitleFromHtml,
} from './chunker.js';
import { CRAWL_TARGETS } from './crawl-targets.js';
import type {
  CrawlError,
  CrawlRunResult,
  CrawlTarget,
  CrawledPage,
  DocumentChunk,
  RagEngineConfig,
} from '../types/rag.types.js';

const USER_AGENT =
  'AtlasReforge-RAGCrawler/1.0 (+https://github.com/mranerov-creator/AtlasReforge; respectful-bot)';

// ─── Fetch single page ────────────────────────────────────────────────────────

export async function fetchPage(
  target: CrawlTarget,
  timeoutMs = 15_000,
): Promise<CrawledPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(target.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new CrawlFetchError(
      `HTTP ${response.status} for ${target.url}`,
      response.status,
    );
  }

  const html = await response.text();
  const title = extractTitleFromHtml(html);
  const rawText = extractTextFromHtml(html);
  const contentHash = createHash('sha256').update(rawText).digest('hex');

  return {
    url: target.url,
    title,
    rawText,
    contentHash,
    crawledAt: new Date().toISOString(),
    category: target.category,
    httpStatus: response.status,
  };
}

// ─── Change detector ──────────────────────────────────────────────────────────

/**
 * Compares content hash of a freshly crawled page against what's stored in DB.
 * Returns true if the page has changed and needs re-embedding.
 */
export function hasContentChanged(
  freshHash: string,
  storedHash: string | null,
): boolean {
  return storedHash === null || freshHash !== storedHash;
}

// ─── Batch crawler ────────────────────────────────────────────────────────────

export interface CrawlerDeps {
  /**
   * Returns the stored content hash for a given URL (null if never crawled).
   * Used for change detection — avoids re-embedding unchanged pages.
   */
  getStoredHash(url: string): Promise<string | null>;

  /**
   * Persists chunks to the vector store.
   */
  storeChunks(chunks: ReadonlyArray<DocumentChunk>): Promise<void>;

  /**
   * Optional progress callback — useful for CLI output and job monitoring.
   */
  onProgress?: (event: CrawlProgressEvent) => void;
}

export type CrawlProgressEvent =
  | { type: 'fetch-start'; url: string }
  | { type: 'fetch-done'; url: string; changed: boolean }
  | { type: 'fetch-error'; url: string; error: string }
  | { type: 'chunks-stored'; url: string; count: number };

/**
 * Crawls all targets with concurrency limiting and rate limiting.
 * Returns a full run report.
 */
export async function crawlAll(
  deps: CrawlerDeps,
  config: Pick<RagEngineConfig, 'crawlConcurrency' | 'crawlDelayMs' | 'maxChunkTokens' | 'chunkOverlapTokens'>,
  targets: ReadonlyArray<CrawlTarget> = CRAWL_TARGETS,
): Promise<CrawlRunResult> {
  const runId = createHash('sha256')
    .update(new Date().toISOString())
    .digest('hex')
    .slice(0, 16);

  const startedAt = new Date().toISOString();
  const errors: CrawlError[] = [];

  let targetsSucceeded = 0;
  let targetsFailed = 0;
  let chunksCreated = 0;
  let chunksSkipped = 0;
  let chunksEmbedded = 0;

  // Process targets in batches of crawlConcurrency
  for (let i = 0; i < targets.length; i += config.crawlConcurrency) {
    const batch = targets.slice(i, i + config.crawlConcurrency);

    await Promise.all(
      batch.map(async (target) => {
        deps.onProgress?.({ type: 'fetch-start', url: target.url });

        // 1. Fetch the page
        let page: CrawledPage;
        try {
          page = await fetchPage(target);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ url: target.url, error: message, phase: 'fetch' });
          deps.onProgress?.({ type: 'fetch-error', url: target.url, error: message });
          targetsFailed++;
          return;
        }

        // 2. Change detection
        let storedHash: string | null;
        try {
          storedHash = await deps.getStoredHash(target.url);
        } catch {
          storedHash = null; // If hash lookup fails, re-process the page
        }

        const changed = hasContentChanged(page.contentHash, storedHash);
        deps.onProgress?.({ type: 'fetch-done', url: target.url, changed });

        if (!changed) {
          // Page unchanged — count all its previous chunks as skipped
          chunksSkipped++;
          targetsSucceeded++;
          return;
        }

        // 3. Chunk
        let chunks: ReadonlyArray<DocumentChunk>;
        try {
          chunks = buildChunks(page, target, {
            maxTokens: config.maxChunkTokens,
            overlapTokens: config.chunkOverlapTokens,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ url: target.url, error: message, phase: 'chunk' });
          targetsFailed++;
          return;
        }

        // 4. Store (embedding happens in the RagService after this)
        try {
          await deps.storeChunks(chunks);
          chunksCreated += chunks.length;
          chunksEmbedded += chunks.length;
          deps.onProgress?.({ type: 'chunks-stored', url: target.url, count: chunks.length });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ url: target.url, error: message, phase: 'store' });
          targetsFailed++;
          return;
        }

        targetsSucceeded++;
      }),
    );

    // Rate limiting between batches
    if (i + config.crawlConcurrency < targets.length) {
      await new Promise((resolve) => setTimeout(resolve, config.crawlDelayMs));
    }
  }

  return {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    targetsAttempted: targets.length,
    targetsSucceeded,
    targetsFailed,
    chunksCreated,
    chunksSkipped,
    chunksEmbedded,
    errors,
  };
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class CrawlFetchError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CrawlFetchError';
  }
}
