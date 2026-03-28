/**
 * Job constants — shared between apps/api and apps/worker.
 *
 * These MUST live in a shared package, never in an app,
 * because both the producer (api) and consumer (worker) need them.
 */

export const QUEUES = {
  MIGRATION: 'migration',
  RAG_CRAWL: 'rag-crawl',
} as const;

export const JOB_NAMES = {
  PROCESS_SCRIPT: 'process-script',
  CRAWL_DOCS: 'crawl-atlassian-docs',
  EMBED_PENDING: 'embed-pending-chunks',
} as const;

/** BullMQ job data for a migration job */
export interface MigrationJobData {
  jobId: string;
  filename: string;
  scriptContent: string;       // Ephemeral — never persisted to DB
  preferredTarget?: string;
  cloudBaseUrl?: string;
  accessToken?: string;        // Ephemeral — never persisted
  tenantId: string;
  submittedAt: string;         // ISO 8601
  currentStage?: string;       // Updated by worker for progress reporting
}

/** BullMQ job data for RAG crawl */
export interface RagCrawlJobData {
  triggeredBy: 'scheduler' | 'manual';
  triggeredAt: string;
}
