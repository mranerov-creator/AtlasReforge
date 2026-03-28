/**
 * Parser Service
 *
 * The main orchestrator for the @atlasreforge/parser package.
 * Implements a 3-phase pipeline:
 *
 *   Phase 1: Detection (language + module type) — always sync, no LLM
 *   Phase 2: Extraction (dependencies) — deterministic regex, no LLM
 *   Phase 3: Strategy dispatch (AST / LLM-Semantic / Hybrid)
 *
 * The output is a ParsedScriptShell — businessLogic is null here.
 * businessLogic is populated by the LLM Orchestrator in Stage 4 (downstream).
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  isWorkflowXml,
  parseWorkflowXml,
  type WorkflowXmlParseResult,
} from './parsers/workflow-xml.parser.js';

import {
  analyzeCloudCompatibility,
  resolveComplexity,
} from './analyzers/cloud-compatibility.analyzer.js';
import { detectLanguage } from './detectors/language.detector.js';
import { detectModuleType } from './detectors/module-type.detector.js';
import { extractDependencies } from './extractors/dependency.extractor.js';
import { canHandleAst, runAstStrategy } from './strategies/ast.strategy.js';
import { runHybridStrategy } from './strategies/hybrid.strategy.js';
import type { LlmClient } from './strategies/llm-semantic.strategy.js';
import { runLlmSemanticStrategy } from './strategies/llm-semantic.strategy.js';
import type {
  ConfidenceScores,
  ParseError,
  ParsedScript,
  ParsedScriptShell,
  ParseStrategy,
  ParseStrategyMetadata,
  ParseWarning,
} from './types/parsed-script.types.js';

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface ParserInput {
  readonly content: string;
  readonly filename: string;
  readonly requestId?: string; // If provided, used as job correlation ID
}

export interface ParserServiceConfig {
  readonly llmClient?: LlmClient; // Required for SIL and Hybrid strategies
  readonly enableAst?: boolean;   // Default: true
  readonly maxContentLength?: number; // Default: 50_000 chars
}

// ─── Parser Service ───────────────────────────────────────────────────────────

export class ParserService {
  private readonly config: Required<ParserServiceConfig>;

  constructor(config: ParserServiceConfig = {}) {
    this.config = {
      llmClient: config.llmClient ?? createNoopLlmClient(),
      enableAst: config.enableAst ?? true,
      maxContentLength: config.maxContentLength ?? 50_000,
    };
  }

  async parse(input: ParserInput): Promise<ParsedScriptShell> {
    const errors: ParseError[] = [];
    const warnings: ParseWarning[] = [];
    const startedAt = new Date().toISOString();

    // ── Validate input ───────────────────────────────────────────────────
    if (input.content.length === 0) {
      errors.push({
        code: 'PARSE_001',
        message: 'Script content is empty',
        fatal: true,
        stage: 'detection',
      });
    }

    if (input.content.length > this.config.maxContentLength) {
      errors.push({
        code: 'PARSE_002',
        message: `Script exceeds maximum length of ${this.config.maxContentLength} chars`,
        fatal: true,
        stage: 'detection',
      });
    }

    if (errors.some((e) => e.fatal)) {
      return buildErrorShell(input, errors, startedAt);
    }

    // ── Phase 1: Detection ───────────────────────────────────────────────
    const langResult = detectLanguage(input.content, input.filename);
    const moduleResult = detectModuleType(input.content);

    if (langResult.language === 'unknown') {
      warnings.push({
        code: 'WARN_001',
        message:
          'Language detection returned unknown. Proceeding with LLM-Semantic strategy.',
        affectedField: 'language',
      });
    }

    if (moduleResult.moduleType === 'unknown') {
      warnings.push({
        code: 'WARN_002',
        message: 'Module type could not be determined from code patterns alone.',
        affectedField: 'moduleType',
      });
    }

    // ── Phase 2: Extraction (always deterministic regex) ─────────────────
    const dependencies = extractDependencies(input.content);

    const linesOfCode = input.content.split('\n').filter((l) => {
      const trimmed = l.trim();
      return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('*');
    }).length;

    const complexity = resolveComplexity(dependencies, linesOfCode);

    // ── Phase 3: Strategy dispatch ────────────────────────────────────────
    const strategyInput = {
      content: input.content,
      language: langResult.language,
      filename: input.filename,
    };

    let selectedStrategy: ParseStrategy;
    let strategyReason: string;
    let astCoverage: number;
    let llmTokensUsed: number | null = null;

    if (langResult.language === 'sil') {
      // SIL: always LLM-Semantic (no grammar available)
      selectedStrategy = 'llm-semantic';
      strategyReason = 'SIL has no public grammar. Using LLM as semantic parser.';

      if (this.config.llmClient) {
        const result = await runLlmSemanticStrategy(
          strategyInput,
          this.config.llmClient,
        );
        astCoverage = result.astCoverage;
        llmTokensUsed = result.llmTokensUsed;

        // Merge LLM-extracted deps with regex-extracted deps (LLM fills SIL gaps)
        mergeSilDependencies(dependencies, result.extractedDependencies);
      } else {
        warnings.push({
          code: 'WARN_003',
          message:
            'No LLM client configured. SIL parsing will use regex only (limited coverage).',
          affectedField: 'parseStrategy',
        });
        astCoverage = 0.3; // Regex-only on SIL is ~30% coverage
      }
    } else if (
      this.config.enableAst &&
      canHandleAst(strategyInput) &&
      langResult.language !== 'unknown'
    ) {
      // Java or standard Groovy: AST
      selectedStrategy = 'ast';
      strategyReason = `${langResult.language} without heavy metaprogramming — using tree-sitter AST.`;
      const result = await runAstStrategy(strategyInput);
      astCoverage = result.astCoverage;
    } else if (langResult.language === 'groovy') {
      // Groovy with metaprogramming: Hybrid
      selectedStrategy = 'hybrid';
      strategyReason =
        'Groovy with dynamic metaprogramming patterns — using AST + LLM hybrid for gap analysis.';
      const result = await runHybridStrategy(
        strategyInput,
        this.config.llmClient,
      );
      astCoverage = result.astCoverage;
      llmTokensUsed = result.llmTokensUsed;
    } else {
      // Fallback: LLM-Semantic for unknown languages
      selectedStrategy = 'llm-semantic';
      strategyReason = `Unknown language (${langResult.language}) — falling back to LLM semantic analysis.`;
      astCoverage = 0;
    }

    // ── Analysis ─────────────────────────────────────────────────────────
    const cloudReadiness = analyzeCloudCompatibility(dependencies, {
      language: langResult.language,
      moduleType: moduleResult.moduleType,
      triggerEvent: moduleResult.triggerEvent,
      linesOfCode,
    });

    // ── Confidence scores ─────────────────────────────────────────────────
    const confidence = buildConfidenceScores(
      langResult.score,
      moduleResult.moduleConfidence,
      dependencies,
      astCoverage,
      langResult.language,
    );

    // ── Assemble output ───────────────────────────────────────────────────
    const parseStrategy: ParseStrategyMetadata = {
      strategy: selectedStrategy,
      reason: strategyReason,
      astCoverage,
      llmTokensUsed,
    };

    const result: ParsedScriptShell = {
      id: input.requestId ?? randomUUID(),
      originalFilename: input.filename,
      contentHash: hashContent(input.content),
      parsedAt: startedAt,

      language: langResult.language,
      languageConfidence: langResult.confidence,
      moduleType: moduleResult.moduleType,
      triggerEvent: moduleResult.triggerEvent,
      linesOfCode,
      complexity,

      dependencies,
      cloudReadiness,
      businessLogic: null,

      workflowContext: null,
      parseStrategy,
      confidence,
      errors,
      warnings,
    };

    return result;
  }

  /**
   * Parses a Jira workflow XML export and returns all embedded scripts as ParsedScript objects.
   * Each script is extracted with its WorkflowContext and run through the standard parse() pipeline.
   */
  async parseWorkflowXml(
    xmlContent: string,
    requestId: string,
  ): Promise<{ result: WorkflowXmlParseResult; parsedScripts: ParsedScript[] }> {
    const xmlResult = parseWorkflowXml(xmlContent);
    const parsedScripts: ParsedScript[] = [];

    for (const extracted of xmlResult.scripts) {
      try {
        const parsed = await this.parse({
          content: extracted.scriptContent,
          filename: extracted.suggestedFilename,
          requestId: `${requestId}-wf-${extracted.workflowContext.scriptIndex}`,
        });

        // Patch: inject workflow context + authoritative module type from XML mapping
        const enriched: ParsedScript = {
          ...parsed,
          workflowContext: extracted.workflowContext,
          // XML function type is more authoritative than regex detection for ambiguous cases
          moduleType:
            parsed.moduleType === 'unknown' || parsed.moduleType === 'field-function'
              ? extracted.moduleType
              : parsed.moduleType,
        };

        parsedScripts.push(enriched);
      } catch {
        // Non-fatal: one script failing doesn't abort the batch
      }
    }

    return { result: xmlResult, parsedScripts };
  }

  /** Returns true if the content looks like a Jira workflow XML export. */
  isWorkflowXml(content: string): boolean {
    return isWorkflowXml(content);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function buildConfidenceScores(
  languageScore: number,
  moduleConfidence: number,
  deps: ReturnType<typeof extractDependencies>,
  astCoverage: number,
  language: string,
): ConfidenceScores {
  // Language detection: normalize score to 0-1 (max possible ~100)
  const langConfidence = Math.min(1, languageScore / 80);

  // Dependency extraction confidence: higher if deterministic (non-SIL)
  const depConfidence = language === 'sil' ? 0.6 + astCoverage * 0.4 : 0.95;

  // Cloud readiness confidence: depends on how many issues were found
  const cloudConfidence =
    deps.deprecatedApis.length > 5 ? 0.6 : 0.85;

  return {
    languageDetection: Math.round(langConfidence * 100) / 100,
    moduleTypeDetection: Math.round(moduleConfidence * 100) / 100,
    dependencyExtraction: Math.round(depConfidence * 100) / 100,
    cloudReadinessAnalysis: Math.round(cloudConfidence * 100) / 100,
    businessLogicSummary: 0, // Populated by Stage 4
  };
}

function buildErrorShell(
  input: ParserInput,
  errors: ParseError[],
  parsedAt: string,
): ParsedScriptShell {
  return {
    id: input.requestId ?? randomUUID(),
    originalFilename: input.filename,
    contentHash: hashContent(input.content),
    parsedAt,
    language: 'unknown',
    languageConfidence: 'low',
    moduleType: 'unknown',
    triggerEvent: 'unknown',
    linesOfCode: 0,
    complexity: 'low',
    dependencies: {
      customFields: [],
      groups: [],
      users: [],
      externalHttpCalls: [],
      internalApiCalls: [],
      deprecatedApis: [],
      scriptDependencies: [],
    },
    cloudReadiness: {
      overallLevel: 'red',
      score: 0,
      issues: [],
      recommendedMigrationTarget: 'manual-rewrite',
      estimatedEffortHours: { consultantHours: 0, aiAssistedHours: 0, savingsPercent: 0 },
      automationSuitability: null,
    },
    businessLogic: null,
    workflowContext: null,
    parseStrategy: {
      strategy: 'ast',
      reason: 'Parse failed before strategy selection',
      astCoverage: 0,
      llmTokensUsed: null,
    },
    confidence: {
      languageDetection: 0,
      moduleTypeDetection: 0,
      dependencyExtraction: 0,
      cloudReadinessAnalysis: 0,
      businessLogicSummary: 0,
    },
    errors,
    warnings: [],
  };
}

/**
 * Merges LLM-extracted SIL dependencies with regex-extracted ones.
 * LLM results fill gaps; regex results take precedence when both find the same entity.
 *
 * NOTE: This mutates the deps object. It's called only in the SIL path
 * where deps is a locally-constructed object (not a readonly input).
 */
function mergeSilDependencies(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llmDeps: any,
): void {
  if (llmDeps.customFields) {
    const existingIds = new Set(deps.customFields.map((f: { fieldId: string }) => f.fieldId));
    for (const field of llmDeps.customFields) {
      if (!existingIds.has(field.fieldId)) {
        deps.customFields.push(field);
      }
    }
  }
  if (llmDeps.groups) {
    const existingNames = new Set(deps.groups.map((g: { groupName: string }) => g.groupName));
    for (const group of llmDeps.groups) {
      if (!existingNames.has(group.groupName)) {
        deps.groups.push(group);
      }
    }
  }
  if (llmDeps.users) {
    const existingIds = new Set(deps.users.map((u: { identifier: string }) => u.identifier));
    for (const user of llmDeps.users) {
      if (!existingIds.has(user.identifier)) {
        deps.users.push(user);
      }
    }
  }
}

/**
 * Noop LLM client used when no LLM is configured.
 * Returns empty valid JSON so the parser doesn't crash.
 */
function createNoopLlmClient(): LlmClient {
  return {
    async complete() {
      return {
        content: '{"customFields":[],"groups":[],"users":[],"externalHttpCalls":[],"scriptDependencies":[],"confidence":0}',
        tokensUsed: 0,
      };
    },
  };
}
