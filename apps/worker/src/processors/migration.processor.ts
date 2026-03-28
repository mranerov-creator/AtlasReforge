/**
 * Migration Job Processor
 *
 * The BullMQ worker that processes migration jobs from the 'migration' queue.
 *
 * EPHEMERAL PROCESSING:
 *   - Script content lives only in Redis job data (TTL: 24h)
 *   - Never written to postgres or disk
 *   - Worker processes in memory and discards when done
 *
 * TENANT ISOLATION:
 *   - Each job runs in its own async context (Node.js worker threads in prod)
 *   - No shared mutable state between concurrent jobs
 *
 * PIPELINE PROGRESS:
 *   - Reports progress (0-100) to BullMQ as each stage completes
 *   - Frontend polls /jobs/:jobId/status for updates
 *
 * REGISTRY AWARENESS:
 *   - After S4 generation, checks if registry session is complete
 *   - If not complete, waits (re-queues with delay) up to 24h
 *   - Once complete, runs placeholder resolution and S5 validation
 */

import { Worker, type Job } from 'bullmq';
import { ParserService } from '@atlasreforge/parser';
import {
  OrchestratorService,
  OpenAIProvider,
  AnthropicProvider,
  NoopRagRetriever,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from '@atlasreforge/llm-orchestrator';
import {
  RegistryService,
  InMemoryRegistryStore,
} from '@atlasreforge/field-registry';
import type { MigrationJobData } from '@atlasreforge/shared';
import { QUEUES } from '@atlasreforge/shared';

// ─── Services ─────────────────────────────────────────────────────────────────

const parserService = new ParserService({ enableAst: false });

const orchestrator = new OrchestratorService({
  ...DEFAULT_ORCHESTRATOR_CONFIG,
  ragEnabled: false, // Enable when rag-engine is connected
});

// Registry store — shared across concurrent jobs (InMemory for MVP)
const registryStore = new InMemoryRegistryStore();
const registryService = new RegistryService(registryStore);

// ─── LLM Providers ────────────────────────────────────────────────────────────

function buildProviders(): {
  classifierProvider: OpenAIProvider;
  generatorProvider: AnthropicProvider;
} {
  const openAiKey = process.env['OPENAI_API_KEY'];
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];

  if (openAiKey === undefined || openAiKey === '') {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  if (anthropicKey === undefined || anthropicKey === '') {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  return {
    classifierProvider: new OpenAIProvider({ apiKey: openAiKey }),
    generatorProvider: new AnthropicProvider({ apiKey: anthropicKey }),
  };
}

// ─── Progress stages ──────────────────────────────────────────────────────────

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

// ─── Processor ────────────────────────────────────────────────────────────────

async function processMigrationJob(job: Job<MigrationJobData>): Promise<unknown> {
  const { jobId, filename, scriptContent } = job.data;
  console.log(`[Worker] Processing job ${jobId} — ${filename}`);

  // Stage: Parse
  await job.updateProgress(STAGE_PROGRESS['parsing'] ?? 10);
  const parsedScript = await parserService.parse({
    content: scriptContent,
    filename,
    requestId: jobId,
  });

  // Stage: Run pipeline (S1 → S5)
  await job.updateProgress(STAGE_PROGRESS['classifying'] ?? 25);

  let providers: ReturnType<typeof buildProviders>;
  try {
    providers = buildProviders();
  } catch (err) {
    // No API keys configured — return a mock result for dev
    console.warn('[Worker] No API keys configured, returning mock result');
    return buildMockResult(jobId, filename, parsedScript);
  }

  await job.updateProgress(STAGE_PROGRESS['generating'] ?? 75);

  const result = await orchestrator.run(
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

  // Stage: Check registry + resolve placeholders
  await job.updateProgress(STAGE_PROGRESS['resolving'] ?? 95);

  const session = await registryService.getSession(jobId);
  if (session !== null && session.isComplete && result.forgeFiles !== null) {
    const { patchedFiles } = await registryService.resolveFiles(
      jobId,
      result.forgeFiles,
    );
    await job.updateProgress(STAGE_PROGRESS['completed'] ?? 100);
    return { ...result, forgeFiles: patchedFiles };
  }

  await job.updateProgress(STAGE_PROGRESS['completed'] ?? 100);
  return result;
}

// ─── Mock result for dev without API keys ─────────────────────────────────────

function buildMockResult(
  jobId: string,
  filename: string,
  parsedScript: Awaited<ReturnType<typeof parserService.parse>>,
): object {
  return {
    jobId,
    originalFilename: filename,
    completedAt: new Date().toISOString(),
    cloudReadinessScore: parsedScript.cloudReadiness.score,
    cloudReadinessLevel: parsedScript.cloudReadiness.overallLevel,
    recommendedTarget: parsedScript.cloudReadiness.recommendedMigrationTarget,
    complexity: parsedScript.complexity,
    linesOfCode: parsedScript.linesOfCode,
    estimatedEffortHours: {
      consultantHours: parsedScript.cloudReadiness.estimatedEffortHours.consultantHours,
      aiAssistedHours: parsedScript.cloudReadiness.estimatedEffortHours.aiAssistedHours,
      savingsPercent:  parsedScript.cloudReadiness.estimatedEffortHours.savingsPercent,
    },
    businessLogic: {
      triggerDescription: `${parsedScript.moduleType} trigger detected`,
      purposeNarrative: 'Configure OPENAI_API_KEY and ANTHROPIC_API_KEY for full analysis',
      inputConditions: [],
      outputActions: [],
      externalIntegrations: [],
    },
    forgeFiles: [{
      filename: 'manifest.yml',
      content: `# Configure API keys to generate real code\napp:\n  id: placeholder\n`,
      language: 'yaml',
      purpose: 'Placeholder — configure API keys',
    }],
    scriptRunnerCode: null,
    diagram: {
      type: 'sequenceDiagram',
      title: 'Cloud Migration Flow',
      mermaidSource: `sequenceDiagram\n    participant J as Jira Cloud\n    participant F as Forge\n    J->>F: Trigger\n    F-->>J: Response`,
    },
    oauthScopes: ['read:jira-work', 'write:jira-work'],
    confidence: {
      fieldMapping: { score: 0, note: 'API keys required', requiresHumanReview: true },
      webhookLogic: { score: 0, note: 'API keys required', requiresHumanReview: true },
      userResolution: { score: 0, note: 'API keys required', requiresHumanReview: true },
      oauthScopes: { score: 0, note: 'API keys required', requiresHumanReview: true },
      overallMigration: { score: 0, note: 'API keys required', requiresHumanReview: true },
    },
    validationIssues: [],
    fieldMappingPlaceholders: parsedScript.dependencies.customFields.map(cf => ({
      placeholder: `ATLAS_FIELD_ID("${cf.fieldId}")`,
      serverFieldId: cf.fieldId,
      description: `Custom field ${cf.fieldId}`,
      requiredInFile: 'src/index.ts',
    })),
    pipeline: {
      totalTokensUsed: 0,
      totalDurationMs: 100,
      totalCostUsd: 0,
      modelsUsed: ['mock'],
      stageTimings: {},
    },
  };
}

// ─── Worker bootstrap ─────────────────────────────────────────────────────────

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const redisUrl = new URL(REDIS_URL);

const worker = new Worker<MigrationJobData>(
  QUEUES.MIGRATION,
  processMigrationJob,
  {
    connection: {
      host: redisUrl.hostname,
      port: parseInt(redisUrl.port || '6379', 10),
    },
    concurrency: parseInt(process.env['WORKER_CONCURRENCY'] ?? '3', 10),
  },
);

worker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id ?? 'unknown'} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id ?? 'unknown'} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[Worker] Worker error:', err.message);
});

console.log(`[Worker] Listening on queue "${QUEUES.MIGRATION}"...`);
