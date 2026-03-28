/**
 * Orchestrator Service
 *
 * The main entry point for the LLM pipeline. Wires all 5 stages together:
 *
 *   S1 (Classify) → S2 (Extract) → S3 (Retrieve) → S4 (Generate) → S5 (Validate)
 *
 * Responsibilities:
 *   - Stage sequencing and error isolation (stage failure ≠ pipeline crash)
 *   - Per-stage timing for cost/performance monitoring
 *   - Retry orchestration (delegated to withRetry in providers)
 *   - Assembling the final MigrationResult for the API layer
 *   - Enforcing stage timeouts (prevents runaway LLM calls)
 *
 * This class is designed to be consumed by the BullMQ worker processor.
 * It is stateless — all state lives in the job payload and the returned result.
 */

import type { CustomFieldRef, GroupRef, ParsedScriptShell, UserRef } from '@atlasreforge/parser';
import { runS1Classifier } from './stages/s1-classifier.js';
import { runS2Extractor } from './stages/s2-extractor.js';
import { NoopRagRetriever, runS3Retrieval } from './stages/s3-retrieval.js';
import { runS4Generator } from './stages/s4-generator.js';
import { runS4bAutomationGenerator } from './stages/s4b-automation-generator.js';
import { runS5Validator } from './stages/s5-validator.js';
import type {
  DEFAULT_ORCHESTRATOR_CONFIG,
  LlmProvider,
  MigrationResult,
  OrchestratorConfig,
  PipelineTelemetry,
  RagRetriever,
  S1ClassifierOutput,
  S2ExtractionOutput,
  S3RetrievalOutput,
  S4GeneratorOutput,
  S4bGeneratorOutput,
  S5ValidationOutput,
} from './types/pipeline.types.js';

export type { OrchestratorConfig } from './types/pipeline.types.js';
export { DEFAULT_ORCHESTRATOR_CONFIG } from './types/pipeline.types.js';

// ─── Stage timeout wrapper ────────────────────────────────────────────────────

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stageName: string,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Stage ${stageName} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );
  return Promise.race([promise, timeout]);
}

// ─── Orchestrator input ───────────────────────────────────────────────────────

export interface OrchestratorInput {
  readonly jobId: string;
  readonly parsedScript: ParsedScriptShell;
  readonly rawScriptContent: string;        // Original script content — ephemeral, from job queue
}

export interface OrchestratorDeps {
  readonly classifierProvider: LlmProvider;
  readonly generatorProvider: LlmProvider;
  readonly ragRetriever?: RagRetriever;     // Optional — falls back to NoopRagRetriever
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class OrchestratorService {
  private readonly config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  async run(
    input: OrchestratorInput,
    deps: OrchestratorDeps,
  ): Promise<MigrationResult> {
    const pipelineStart = Date.now();
    const stageTimings: Record<string, number> = {};
    const modelsUsed: string[] = [];
    let totalTokens = 0;

    const retriever =
      this.config.ragEnabled
        ? (deps.ragRetriever ?? new NoopRagRetriever())
        : new NoopRagRetriever();

    // ── Stage 1: Classify ──────────────────────────────────────────────────
    const s1Start = Date.now();
    let s1Output: S1ClassifierOutput;
    try {
      s1Output = await withTimeout(
        runS1Classifier(
          input.parsedScript,
          deps.classifierProvider,
          deps.generatorProvider.modelId,
          this.config.maxRetries,
        ),
        this.config.stageTimeoutMs,
        'S1-Classifier',
      );
      totalTokens += s1Output.tokensUsed;
      modelsUsed.push(deps.classifierProvider.modelId);
    } catch (err) {
      // S1 failure is fatal — we can't proceed without classification
      throw new PipelineError('S1', err instanceof Error ? err.message : String(err));
    } finally {
      stageTimings['s1-classifier'] = Date.now() - s1Start;
    }

    // ── Stage 2: Extract ───────────────────────────────────────────────────
    const s2Start = Date.now();
    let s2Output: S2ExtractionOutput;
    try {
      s2Output = await withTimeout(
        runS2Extractor(
          input.parsedScript,
          s1Output,
          deps.classifierProvider,  // S2 also uses the cheap model
          this.config.maxRetries,
        ),
        this.config.stageTimeoutMs,
        'S2-Extractor',
      );
      totalTokens += s2Output.tokensUsed;
    } catch (err) {
      // S2 failure is non-fatal — we continue with empty enrichment
      s2Output = buildEmptyS2(input.parsedScript);
      stageTimings['s2-extractor-error'] = Date.now() - s2Start;
    } finally {
      stageTimings['s2-extractor'] = Date.now() - s2Start;
    }

    // ── Stage 3: Retrieve ──────────────────────────────────────────────────
    const s3Start = Date.now();
    let s3Output: S3RetrievalOutput;
    try {
      s3Output = await withTimeout(
        runS3Retrieval(s1Output, s2Output, retriever),
        this.config.stageTimeoutMs,
        'S3-Retrieval',
      );
    } catch {
      // S3 failure is non-fatal — generate without RAG context
      s3Output = { documents: [], totalRetrieved: 0, queryCount: 0, stalestDocAge: null };
    } finally {
      stageTimings['s3-retrieval'] = Date.now() - s3Start;
    }

    // ── Stage 4 / 4b: Generate (conditional dispatch) ─────────────────────
    //
    // 'automation-native' scripts bypass Forge/SR generation entirely
    // and go directly to the Automation rule generator (Stage 4b).
    // All other targets use the standard Stage 4 generator.
    const s4Start = Date.now();
    let s4Output: S4GeneratorOutput | null = null;
    let s4bOutput: S4bGeneratorOutput | null = null;
    const isAutomationNative = s1Output.migrationTarget === 'automation-native';

    try {
      if (isAutomationNative) {
        // ── 4b: Automation rule generator ─────────────────────────────────
        const automationSuitability = input.parsedScript.cloudReadiness.automationSuitability;

        if (automationSuitability === null) {
          // Suitability was not computed (rawScriptContent was not passed to parser).
          // Fall back to standard S4 to avoid a silent failure.
          s4Output = await withTimeout(
            runS4Generator(
              input.parsedScript,
              input.rawScriptContent,
              s1Output,
              s2Output,
              s3Output,
              deps.generatorProvider,
              this.config.maxRetries,
            ),
            this.config.stageTimeoutMs,
            'S4-Generator-Fallback',
          );
        } else {
          s4bOutput = await withTimeout(
            runS4bAutomationGenerator(
              input.parsedScript,
              input.rawScriptContent,
              s1Output,
              s2Output,
              automationSuitability,
              deps.generatorProvider,
              this.config.maxRetries,
            ),
            this.config.stageTimeoutMs,
            'S4b-AutomationGenerator',
          );
          totalTokens += s4bOutput.tokensUsed;
          modelsUsed.push(s4bOutput.modelUsed);
        }
      } else {
        // ── 4: Standard Forge / ScriptRunner generator ─────────────────────
        s4Output = await withTimeout(
          runS4Generator(
            input.parsedScript,
            input.rawScriptContent,
            s1Output,
            s2Output,
            s3Output,
            deps.generatorProvider,
            this.config.maxRetries,
          ),
          this.config.stageTimeoutMs,
          'S4-Generator',
        );
        totalTokens += s4Output.tokensUsed;
        modelsUsed.push(s4Output.modelUsed);
      }
    } catch (err) {
      throw new PipelineError(
        isAutomationNative ? 'S4b' : 'S4',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      stageTimings[isAutomationNative ? 's4b-automation-generator' : 's4-generator'] = Date.now() - s4Start;
    }

    // ── Stage 5: Validate ──────────────────────────────────────────────────
    // S5 validates generated TypeScript/Groovy code for Cloud anti-patterns.
    // Automation rule JSON has no executable code — skip validation for 4b output.
    const s5Start = Date.now();
    let s5Output: S5ValidationOutput;
    try {
      if (s4Output !== null) {
        s5Output = runS5Validator({    // S5 is synchronous — no LLM, no I/O
          generatorOutput: s4Output,
          parsedScript: input.parsedScript,
        });
      } else {
        // automation-native: S5 not applicable — return pass with zero issues
        s5Output = {
          passed: true,
          issues: [],
          autoFixCount: 0,
          generatorOutput: buildEmptyS4ForAutomation(),
        };
      }
    } catch {
      // S5 failure: return unvalidated output with a warning
      s5Output = {
        passed: false,
        issues: [{
          severity: 'warning',
          code: 'VAL_999',
          message: 'Auto-validator threw an unexpected error. Manual review required.',
          file: 'n/a',
          line: null,
          autoFixed: false,
        }],
        autoFixCount: 0,
        generatorOutput: s4Output ?? buildEmptyS4ForAutomation(),
      };
    } finally {
      stageTimings['s5-validator'] = Date.now() - s5Start;
    }

    // ── Assemble final result ──────────────────────────────────────────────
    const totalDurationMs = Date.now() - pipelineStart;

    // Estimate total cost from token usage and model pricing
    const totalCostUsd = estimateCost(
      deps.classifierProvider.modelId,
      deps.generatorProvider.modelId,
      s1Output.tokensUsed + s2Output.tokensUsed,
      s4Output?.tokensUsed ?? 0,
    );

    const telemetry: PipelineTelemetry = {
      totalTokensUsed: totalTokens,
      totalDurationMs,
      stageTimings,
      totalCostUsd,
      modelsUsed: [...new Set(modelsUsed)],
    };

    // Assemble from whichever stage ran (S4 vs S4b)
    const finalOutput = s5Output.generatorOutput;

    // For automation-native: use S4b outputs; otherwise use S4/S5 outputs
    const diagram        = s4bOutput?.diagram        ?? finalOutput.diagram;
    const fieldPlaceholders = s4bOutput?.fieldMappingPlaceholders ?? finalOutput.fieldMappingPlaceholders;

    return {
      jobId: input.jobId,
      completedAt: new Date().toISOString(),
      forgeFiles: isAutomationNative ? null : finalOutput.forgeFiles,
      scriptRunnerCode: isAutomationNative ? null : finalOutput.scriptRunnerCode,
      automationRule: s4bOutput?.automationRule ?? null,
      diagram,
      businessLogic: s2Output.businessLogicSummary,
      oauthScopes: isAutomationNative ? [] : finalOutput.oauthScopes,
      confidence: finalOutput.confidence,
      cloudReadinessScore: input.parsedScript.cloudReadiness.score,
      validationIssues: s5Output.issues,
      fieldMappingPlaceholders: fieldPlaceholders,
      pipeline: telemetry,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COST_PER_1M: Record<string, number> = {
  'gpt-4o-mini': 0.15,
  'claude-sonnet-4-6': 3.0,
  'claude-haiku-4-5-20251001': 0.25,
};

function estimateCost(
  cheapModelId: string,
  expensiveModelId: string,
  cheapTokens: number,
  expensiveTokens: number,
): number {
  const cheapRate = COST_PER_1M[cheapModelId] ?? 0.15;
  const expRate = COST_PER_1M[expensiveModelId] ?? 3.0;
  const cost =
    (cheapTokens / 1_000_000) * cheapRate +
    (expensiveTokens / 1_000_000) * expRate;
  return Math.round(cost * 10000) / 10000;
}

function buildEmptyS2(script: ParsedScriptShell): S2ExtractionOutput {
  return {
    enrichedCustomFields: script.dependencies.customFields.map((cf: CustomFieldRef) => ({
      fieldId: cf.fieldId,
      probableBusinessPurpose: 'Unknown — S2 extraction failed',
      usageType: cf.usageType,
      suggestedForgeStorageKey: cf.fieldId.replace('customfield_', 'field_'),
      requiresFieldMappingRegistry: true,
    })),
    enrichedGroups: script.dependencies.groups.map((g: GroupRef) => ({
      groupName: g.groupName,
      probableRole: 'Unknown — S2 extraction failed',
      cloudEquivalentPattern: 'GET /rest/api/3/group/member?groupId={groupId}',
    })),
    enrichedUserRefs: script.dependencies.users.map((u: UserRef) => ({
      identifier: u.identifier,
      identifierType: u.identifierType,
      gdprRisk: 'high' as const,
      resolutionStrategy: 'Resolve via Atlassian User Migration API',
    })),
    businessLogicSummary: {
      triggerDescription: `${script.moduleType} trigger`,
      purposeNarrative: 'S2 extraction failed — review original script',
      inputConditions: [],
      outputActions: [],
      externalIntegrations: [],
    },
    detectedPatterns: [],
    tokensUsed: 0,
  };
}

// ─── Empty S4 shell for automation-native bypass ─────────────────────────────

/**
 * When migrationTarget === 'automation-native', S4 is bypassed entirely.
 * S5 expects an S4GeneratorOutput — this provides a safe empty shell.
 */
function buildEmptyS4ForAutomation(): S4GeneratorOutput {
  return {
    forgeFiles: null,
    scriptRunnerCode: null,
    diagram: {
      type: 'flowchart',
      mermaidSource: 'flowchart TD\n  A([Automation Rule]) --> B([See automation tab])',
      title: 'Automation Rule — see Automation tab',
    },
    oauthScopes: [],
    confidence: {
      fieldMapping:     { score: 1, note: 'N/A — automation-native target', requiresHumanReview: false },
      webhookLogic:     { score: 1, note: 'N/A — automation-native target', requiresHumanReview: false },
      userResolution:   { score: 1, note: 'N/A — automation-native target', requiresHumanReview: false },
      oauthScopes:      { score: 1, note: 'N/A — automation-native target', requiresHumanReview: false },
      overallMigration: { score: 1, note: 'N/A — automation-native target', requiresHumanReview: false },
    },
    fieldMappingPlaceholders: [],
    tokensUsed: 0,
    modelUsed: 'n/a',
  };
}

// ─── Pipeline error ───────────────────────────────────────────────────────────

export class PipelineError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(`Pipeline failed at ${stage}: ${message}`);
    this.name = 'PipelineError';
  }
}
