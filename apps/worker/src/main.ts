/**
 * AtlasReforge Worker — Entry point
 *
 * Bootstraps two BullMQ workers:
 *   1. migration-worker  — processes script migration jobs (S1→S5 pipeline)
 *   2. rag-crawl-worker  — runs weekly Atlassian docs crawl + embedding
 *
 * DESIGN:
 *   - Single Node.js process, multiple BullMQ Worker instances
 *   - Each worker runs in its own async context
 *   - Graceful shutdown: drains in-flight jobs before exit (SIGTERM/SIGINT)
 *   - Health: exposes a simple HTTP /health endpoint for container probes
 *
 * EPHEMERAL GUARANTEE:
 *   - scriptContent from job data is used in-memory and never written to disk/DB
 *   - accessToken is used only for registry validation calls, never logged
 */

import dotenv from 'dotenv';
import path from 'node:path';

// Resolve .env.local from monorepo root (3 dirs up: src/ → worker/ → apps/ → root/)
const envPath = path.resolve(__dirname, '../../../.env.local');
dotenv.config({ path: envPath });
import http from 'node:http';
import { Worker, type Job } from 'bullmq';
import { ParserService } from '@atlasreforge/parser';
import {
  OrchestratorService,
  OpenAIProvider,
  AnthropicProvider,
  NoopRagRetriever,
  DEFAULT_ORCHESTRATOR_CONFIG,
  PipelineError,
} from '@atlasreforge/llm-orchestrator';
import {
  RegistryService,
  InMemoryRegistryStore,
} from '@atlasreforge/field-registry';
import { QUEUES, JOB_NAMES } from '@atlasreforge/shared';
import type { MigrationJobData, RagCrawlJobData } from '@atlasreforge/shared';

// ─── Config ───────────────────────────────────────────────────────────────────

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const redisUrl = new URL(REDIS_URL);
const REDIS_CONNECTION = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379', 10),
};

const WORKER_CONCURRENCY = parseInt(process.env['WORKER_CONCURRENCY'] ?? '3', 10);
const HEALTH_PORT = parseInt(process.env['HEALTH_PORT'] ?? '3002', 10);
const NODE_ENV = process.env['NODE_ENV'] ?? 'development';

// ─── Services (shared across concurrent jobs) ─────────────────────────────────

const parserService = new ParserService({ enableAst: false });

const orchestratorService = new OrchestratorService({
  ...DEFAULT_ORCHESTRATOR_CONFIG,
  maxRetries: NODE_ENV === 'production' ? 2 : 0,
  ragEnabled: false, // Enable when rag-engine is wired
});

// Registry store shared in-process — Redis-backed in production
const registryStore = new InMemoryRegistryStore();
const registryService = new RegistryService(registryStore);

// ─── LLM provider factory ─────────────────────────────────────────────────────

function buildLlmProviders(): {
  classifierProvider: OpenAIProvider;
  generatorProvider: AnthropicProvider;
} | null {
  const openAiKey = process.env['OPENAI_API_KEY'];
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];

  if (!openAiKey || !anthropicKey) {
    log('warn', 'No LLM API keys configured — pipeline will return mock results');
    return null;
  }

  return {
    classifierProvider: new OpenAIProvider({
      apiKey: openAiKey,
      modelId: 'gpt-4o-mini',
    }),
    generatorProvider: new AnthropicProvider({
      apiKey: anthropicKey,
      modelId: 'claude-sonnet-4-6',
    }),
  };
}

// ─── Progress stage map ───────────────────────────────────────────────────────

const STAGE_PROGRESS: Record<string, number> = {
  parsing: 10,
  classifying: 25,
  extracting: 40,
  retrieving: 55,
  generating: 75,
  validating: 90,
  resolving: 95,
  completed: 100,
};

// ─── Migration job processor ──────────────────────────────────────────────────

async function processMigration(job: Job<MigrationJobData>): Promise<unknown> {
  const { jobId, filename, scriptContent } = job.data;
  log('info', `[Job ${jobId}] Starting — ${filename}`);

  const updateStage = async (stage: string): Promise<void> => {
    await job.updateProgress(STAGE_PROGRESS[stage] ?? 0);
    // Attach current stage to job data for status polling
    await job.updateData({ ...job.data, currentStage: stage });
  };

  // ── Phase 1: Parse (synchronous, fast) ───────────────────────────────────
  await updateStage('parsing');

  const parsedScript = await parserService.parse({
    content: scriptContent,
    filename,
    requestId: jobId,
  });

  log('info', `[Job ${jobId}] Parsed: ${parsedScript.language} ${parsedScript.moduleType} — ${parsedScript.cloudReadiness.overallLevel}`);

  // ── Phase 2: LLM Pipeline (S1→S5) ────────────────────────────────────────
  await updateStage('classifying');

  const providers = buildLlmProviders();

  if (providers === null) {
    // Dev mode without API keys — return mock result immediately
    log('warn', `[Job ${jobId}] Mock mode — no API keys`);
    await updateStage('completed');
    return buildMockResult(jobId, filename, parsedScript, scriptContent);
  }

  let pipelineResult: Awaited<ReturnType<typeof orchestratorService.run>>;

  try {
    pipelineResult = await orchestratorService.run(
      {
        jobId,
        parsedScript,
        rawScriptContent: scriptContent,
      },
      {
        classifierProvider: providers.classifierProvider,
        generatorProvider: providers.generatorProvider,
        ragRetriever: new NoopRagRetriever(),
      },
    );
  } catch (err) {
    if (err instanceof PipelineError) {
      log('error', `[Job ${jobId}] Pipeline failed at ${err.stage}: ${err.message}`);
    } else {
      log('error', `[Job ${jobId}] Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err; // Let BullMQ handle retry logic
  }

  // ── Phase 3: Registry placeholder resolution ──────────────────────────────
  await updateStage('resolving');

  let resolvedResult = pipelineResult;
  const session = await registryService.getSession(jobId);

  if (session !== null && session.isComplete && pipelineResult.forgeFiles !== null) {
    try {
      const { patchedFiles } = await registryService.resolveFiles(
        jobId,
        pipelineResult.forgeFiles,
      );
      // Rebuild result with resolved placeholders
      resolvedResult = {
        ...pipelineResult,
        forgeFiles: patchedFiles as typeof pipelineResult.forgeFiles,
      };
      log('info', `[Job ${jobId}] Placeholders resolved from completed registry`);
    } catch (err) {
      log('warn', `[Job ${jobId}] Registry resolution failed — returning unresolved: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (session !== null && !session.isComplete) {
    log('info', `[Job ${jobId}] Registry incomplete (${session.completionBlockers.length} blockers) — code has unresolved placeholders`);
  }

  await updateStage('completed');
  log('info', `[Job ${jobId}] Complete — ${pipelineResult.pipeline.totalDurationMs}ms, $${pipelineResult.pipeline.totalCostUsd}`);

  // ── Wrap orchestrator result with parser-derived metadata ──────────────
  // The orchestrator returns code/confidence/diagram, but the frontend also
  // needs filename, readiness level, complexity, LOC, effort estimates, etc.
  // These come from the parser output — exactly like the mock result does.
  return {
    ...resolvedResult,
    originalFilename: filename,
    cloudReadinessLevel: parsedScript.cloudReadiness.overallLevel,
    recommendedTarget: parsedScript.cloudReadiness.recommendedMigrationTarget,
    complexity: parsedScript.complexity,
    linesOfCode: parsedScript.linesOfCode,
    workflowContext: parsedScript.workflowContext ?? null,
    estimatedEffortHours: {
      consultantHours: parsedScript.cloudReadiness.estimatedEffortHours.consultantHours,
      aiAssistedHours: parsedScript.cloudReadiness.estimatedEffortHours.aiAssistedHours,
      savingsPercent:  parsedScript.cloudReadiness.estimatedEffortHours.savingsPercent,
    },
  };
}

// ─── RAG crawl processor ──────────────────────────────────────────────────────

async function processRagCrawl(job: Job<RagCrawlJobData>): Promise<unknown> {
  log('info', `[RAG Crawl] Starting — triggered by: ${job.data.triggeredBy}`);
  // Full RAG crawl implementation in rag-engine module
  // For now, log and no-op until rag-engine is connected to postgres
  log('info', '[RAG Crawl] Skipping — rag-engine not connected to postgres yet');
  return { status: 'skipped', reason: 'rag-engine not configured' };
}

// ─── Mock result for dev without API keys ─────────────────────────────────────

function buildMockResult(
  jobId: string,
  filename: string,
  parsedScript: Awaited<ReturnType<typeof parserService.parse>>,
  rawScriptContent: string,
): object {
  return {
    jobId,
    originalFilename: filename,
    originalContent: rawScriptContent,
    completedAt: new Date().toISOString(),
    cloudReadinessScore: parsedScript.cloudReadiness.score,
    cloudReadinessLevel: parsedScript.cloudReadiness.overallLevel,
    recommendedTarget: parsedScript.cloudReadiness.recommendedMigrationTarget,
    complexity: parsedScript.complexity,
    linesOfCode: parsedScript.linesOfCode,
    workflowContext: parsedScript.workflowContext ?? null,
    estimatedEffortHours: {
      consultantHours: parsedScript.cloudReadiness.estimatedEffortHours.consultantHours,
      aiAssistedHours: parsedScript.cloudReadiness.estimatedEffortHours.aiAssistedHours,
      savingsPercent:  parsedScript.cloudReadiness.estimatedEffortHours.savingsPercent,
    },
    businessLogic: {
      triggerDescription: `${parsedScript.moduleType} — configure API keys for full analysis`,
      purposeNarrative: 'Set OPENAI_API_KEY + ANTHROPIC_API_KEY in .env.local to enable code generation.',
      inputConditions: [],
      outputActions: [],
      externalIntegrations: [],
    },
    forgeFiles: [{
      filename: 'manifest.yml',
      content: `# AtlasReforge — Mock output\n# Configure API keys for real generation\napp:\n  id: atlasreforge-placeholder\n  name: AtlasReforge Placeholder\nmodules: {}\npermissions:\n  scopes: []\n`,
      language: 'yaml',
      purpose: 'Placeholder manifest — configure API keys for real output',
    }],
    scriptRunnerCode: null,
    diagram: {
      type: 'sequenceDiagram',
      title: 'Cloud Migration Flow (Mock)',
      mermaidSource: `sequenceDiagram
    participant J as Jira Cloud
    participant F as Forge Function
    J->>F: Trigger (${parsedScript.moduleType})
    Note over F: Configure API keys<br/>for real migration code
    F-->>J: Response`,
    },
    oauthScopes: ['read:jira-work', 'write:jira-work'],
    confidence: {
      fieldMapping:     { score: 0, note: 'API keys required', requiresHumanReview: true },
      webhookLogic:     { score: 0, note: 'API keys required', requiresHumanReview: true },
      userResolution:   { score: 0, note: 'API keys required', requiresHumanReview: true },
      oauthScopes:      { score: 0, note: 'API keys required', requiresHumanReview: true },
      overallMigration: { score: 0, note: 'API keys required', requiresHumanReview: true },
    },
    validationIssues: [],
    fieldMappingPlaceholders: parsedScript.dependencies.customFields.map(cf => ({
      placeholder: `ATLAS_FIELD_ID("${cf.fieldId}")`,
      serverFieldId: cf.fieldId,
      description: `Custom field detected: ${cf.fieldId}`,
      requiredInFile: 'src/index.ts',
    })),
    pipeline: {
      totalTokensUsed: 0,
      totalDurationMs: 0,
      totalCostUsd: 0,
      modelsUsed: ['mock'],
      stageTimings: {},
    },
  };
}

// ─── Worker instances ─────────────────────────────────────────────────────────

const migrationWorker = new Worker<MigrationJobData>(
  QUEUES.MIGRATION,
  processMigration,
  {
    connection: REDIS_CONNECTION,
    concurrency: WORKER_CONCURRENCY,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  },
);

const ragCrawlWorker = new Worker<RagCrawlJobData>(
  QUEUES.RAG_CRAWL,
  processRagCrawl,
  {
    connection: REDIS_CONNECTION,
    concurrency: 1, // Crawl is sequential by design
  },
);

// ─── Event handlers ───────────────────────────────────────────────────────────

migrationWorker.on('completed', (job) => {
  log('info', `[Job ${job.id ?? '?'}] ✅ Completed`);
});

migrationWorker.on('failed', (job, err) => {
  log('error', `[Job ${job?.id ?? '?'}] ❌ Failed: ${err.message}`);
});

migrationWorker.on('error', (err) => {
  log('error', `[MigrationWorker] Error: ${err.message}`);
});

ragCrawlWorker.on('completed', (job) => {
  log('info', `[RAG Crawl ${job.id ?? '?'}] ✅ Completed`);
});

ragCrawlWorker.on('error', (err) => {
  log('error', `[RagCrawlWorker] Error: ${err.message}`);
});

// ─── Health HTTP server ───────────────────────────────────────────────────────
// Used by Docker HEALTHCHECK and Kubernetes readiness probes

const healthServer = http.createServer((_req, res) => {
  const isRunning =
    !migrationWorker.closing && !ragCrawlWorker.closing;

  const body = JSON.stringify({
    status: isRunning ? 'ok' : 'draining',
    queues: {
      migration: !migrationWorker.closing ? 'active' : 'closing',
      ragCrawl:  !ragCrawlWorker.closing  ? 'active' : 'closing',
    },
    concurrency: WORKER_CONCURRENCY,
    uptime: Math.floor(process.uptime()),
  });

  res.writeHead(isRunning ? 200 : 503, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
});

healthServer.listen(HEALTH_PORT, () => {
  log('info', `Health endpoint: http://0.0.0.0:${HEALTH_PORT}/health`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log('info', `${signal} received — draining workers...`);

  // Stop accepting new jobs
  await Promise.all([
    migrationWorker.pause(true),  // true = locally pause only
    ragCrawlWorker.pause(true),
  ]);

  // Wait for in-flight jobs to complete (max 30s)
  const DRAIN_TIMEOUT_MS = 30_000;
  const drainTimer = setTimeout(() => {
    log('warn', 'Drain timeout reached — force closing');
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);

  try {
    await Promise.all([
      migrationWorker.close(),
      ragCrawlWorker.close(),
    ]);
    clearTimeout(drainTimer);
    healthServer.close();
    registryStore.destroy();
    log('info', 'Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    log('error', `Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${String(reason)}`);
});

// ─── Startup log ──────────────────────────────────────────────────────────────

log('info', '─────────────────────────────────────────');
log('info', '⚡ AtlasReforge Worker starting');
log('info', `   Queue: ${QUEUES.MIGRATION} (concurrency: ${WORKER_CONCURRENCY})`);
log('info', `   Queue: ${QUEUES.RAG_CRAWL} (concurrency: 1)`);
log('info', `   Redis: ${redisUrl.hostname}:${redisUrl.port || '6379'}`);
log('info', `   Mode:  ${NODE_ENV}`);
log('info', `   LLM:   ${buildLlmProviders() !== null ? 'configured' : 'mock (no API keys)'}`);
log('info', '─────────────────────────────────────────');

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const ts = new Date().toISOString();
  const prefix = { info: '✓', warn: '⚠', error: '✗' }[level];
  console[level === 'error' ? 'error' : 'log'](`${ts} ${prefix} ${message}`);
}
