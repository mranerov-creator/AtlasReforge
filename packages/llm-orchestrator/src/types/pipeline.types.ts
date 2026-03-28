/**
 * @atlasreforge/llm-orchestrator — Pipeline types
 *
 * These types define the data contract between each of the 5 pipeline stages.
 * Each stage has a typed Input and Output. The orchestrator threads them together.
 *
 * Flow:
 *   ParsedScriptShell (from @atlasreforge/parser)
 *     → S1ClassifierOutput
 *     → S2ExtractionOutput
 *     → S3RetrievalOutput
 *     → S4GeneratorOutput
 *     → S5ValidationOutput  ← this is the final MigrationResult
 */

import type {
  AtlassianModuleType,
  AutomationRuleOutput,
  AutomationSuitability,
  MigrationTarget,
  ParsedScriptShell,
  ScriptComplexity,
  ScriptLanguage,
  TriggerEvent,
} from '@atlasreforge/parser';

// ─── Shared primitives ────────────────────────────────────────────────────────

/**
 * Per-block confidence metadata emitted by Stage 4.
 * Drives the Monaco editor highlighting — low-confidence blocks are underlined.
 */
export interface BlockConfidence {
  readonly score: number;          // 0–1
  readonly note: string;           // Human-readable caveat
  readonly requiresHumanReview: boolean;
}

export interface CodeConfidenceMap {
  readonly fieldMapping: BlockConfidence;
  readonly webhookLogic: BlockConfidence;
  readonly userResolution: BlockConfidence;
  readonly oauthScopes: BlockConfidence;
  readonly overallMigration: BlockConfidence;
}

/**
 * A generated file ready for deployment.
 */
export interface GeneratedFile {
  readonly filename: string;
  readonly content: string;
  readonly language: 'typescript' | 'javascript' | 'groovy' | 'yaml' | 'json';
  readonly purpose: string;        // e.g. "Forge manifest", "resolver entry point"
}

/**
 * Mermaid diagram string for sequence/flow rendering.
 */
export interface GeneratedDiagram {
  readonly type: 'sequenceDiagram' | 'flowchart' | 'stateDiagram';
  readonly mermaidSource: string;
  readonly title: string;
}

// ─── Stage 1 — Classifier ─────────────────────────────────────────────────────

/**
 * Input to S1: the raw ParsedScriptShell from the parser.
 * We pass the full shell but S1 only uses classification signals.
 */
export type S1Input = ParsedScriptShell;

export interface S1ClassifierOutput {
  readonly language: ScriptLanguage;
  readonly moduleType: AtlassianModuleType;
  readonly triggerEvent: TriggerEvent;
  readonly complexity: ScriptComplexity;
  readonly migrationTarget: MigrationTarget;
  readonly requiresFieldMappingRegistry: boolean;
  readonly requiresUserMigration: boolean;       // Has GDPR username refs
  readonly hasExternalIntegrations: boolean;
  readonly estimatedPipelineCost: PipelineCostEstimate;
  readonly tokensUsed: number;
}

export interface PipelineCostEstimate {
  readonly s2ExtractorTokens: number;
  readonly s3RetrievalDocCount: number;
  readonly s4GeneratorTokens: number;
  readonly totalEstimatedUsd: number;
}

// ─── Stage 2 — Structured Extractor ──────────────────────────────────────────

export interface S2Input {
  readonly parsedScript: ParsedScriptShell;
  readonly classifierOutput: S1ClassifierOutput;
}

/**
 * S2 enriches the DependencyMap with semantic context the regex extractor
 * can't capture: what does each custom field represent in business terms?
 * What is the purpose of each group check?
 */
export interface EnrichedCustomField {
  readonly fieldId: string;
  readonly probableBusinessPurpose: string;   // e.g. "Budget threshold for approval routing"
  readonly usageType: 'read' | 'write' | 'search' | 'unknown';
  readonly suggestedForgeStorageKey: string;  // e.g. "budget_threshold"
  readonly requiresFieldMappingRegistry: boolean;
}

export interface EnrichedGroup {
  readonly groupName: string;
  readonly probableRole: string;              // e.g. "Finance approvers group"
  readonly cloudEquivalentPattern: string;    // How to check in Cloud REST API v3
}

export interface EnrichedUserRef {
  readonly identifier: string;
  readonly identifierType: 'username' | 'user-key' | 'email' | 'unknown';
  readonly gdprRisk: 'high' | 'medium' | 'low';
  readonly resolutionStrategy: string;        // e.g. "Resolve via User Migration API"
}

export interface S2ExtractionOutput {
  readonly enrichedCustomFields: ReadonlyArray<EnrichedCustomField>;
  readonly enrichedGroups: ReadonlyArray<EnrichedGroup>;
  readonly enrichedUserRefs: ReadonlyArray<EnrichedUserRef>;
  readonly businessLogicSummary: BusinessLogicSummary;
  readonly detectedPatterns: ReadonlyArray<DetectedPattern>;
  readonly tokensUsed: number;
}

export interface BusinessLogicSummary {
  readonly triggerDescription: string;
  readonly purposeNarrative: string;
  readonly inputConditions: ReadonlyArray<string>;
  readonly outputActions: ReadonlyArray<string>;
  readonly externalIntegrations: ReadonlyArray<string>;
}

/**
 * A high-level pattern detected in the script that maps to a known
 * Forge/ScriptRunner implementation pattern in the RAG corpus.
 */
export interface DetectedPattern {
  readonly patternId: string;      // e.g. "PATTERN_BUDGET_ROUTING", "PATTERN_GROUP_CHECK"
  readonly description: string;
  readonly relevantRagQuery: string;  // What to search for in the RAG index
}

// ─── Stage 3 — RAG Retrieval ──────────────────────────────────────────────────

export interface S3Input {
  readonly classifierOutput: S1ClassifierOutput;
  readonly extractionOutput: S2ExtractionOutput;
}

export interface RagDocument {
  readonly id: string;
  readonly source: string;         // e.g. "developer.atlassian.com/forge/api/requestJira"
  readonly title: string;
  readonly content: string;        // The actual doc chunk
  readonly similarity: number;     // 0–1 cosine similarity
  readonly retrievedAt: string;    // ISO 8601 — age tracking
}

export interface S3RetrievalOutput {
  readonly documents: ReadonlyArray<RagDocument>;
  readonly totalRetrieved: number;
  readonly queryCount: number;     // How many RAG queries were fired
  readonly stalestDocAge: string | null;  // ISO 8601 of oldest doc — freshness warning
}

// ─── Stage 4 — Code Generator ─────────────────────────────────────────────────

export interface S4Input {
  readonly parsedScript: ParsedScriptShell;
  readonly classifierOutput: S1ClassifierOutput;
  readonly extractionOutput: S2ExtractionOutput;
  readonly retrievalOutput: S3RetrievalOutput;
}

export interface S4GeneratorOutput {
  readonly forgeFiles: ReadonlyArray<GeneratedFile> | null;
  readonly scriptRunnerCode: GeneratedFile | null;
  readonly diagram: GeneratedDiagram;
  readonly oauthScopes: ReadonlyArray<string>;
  readonly confidence: CodeConfidenceMap;
  readonly fieldMappingPlaceholders: ReadonlyArray<FieldMappingPlaceholder>;
  readonly tokensUsed: number;
  readonly modelUsed: string;
}

/**
 * A placeholder in generated code that requires the Field Mapping Registry
 * to be filled before deployment.
 *
 * Example: ATLAS_FIELD_ID("budget_threshold") in the generated code
 * gets replaced with the actual Cloud customfield ID from the registry.
 */
export interface FieldMappingPlaceholder {
  readonly placeholder: string;        // e.g. "ATLAS_FIELD_ID_customfield_10048"
  readonly serverFieldId: string;      // The original Server field ID
  readonly description: string;        // What this field represents
  readonly requiredInFile: string;     // Which generated file uses this placeholder
}


// ─── Stage 4b — Automation Rule Generator ─────────────────────────────────────

export interface S4bInput {
  readonly parsedScript: ParsedScriptShell;
  readonly classifierOutput: S1ClassifierOutput;
  readonly extractionOutput: S2ExtractionOutput;
  readonly automationSuitability: AutomationSuitability;
}

/**
 * Confidence map specific to Automation rule generation.
 * Different dimensions from Forge/SR generation (no oauthScopes/webhookLogic).
 */
export interface AutomationConfidenceMap {
  readonly triggerMapping: BlockConfidence;
  readonly conditionMapping: BlockConfidence;
  readonly actionMapping: BlockConfidence;
  readonly overallMigration: BlockConfidence;
}

export interface S4bGeneratorOutput {
  /** Re-exported from parser for convenience — the rule + import JSON. */
  readonly automationRule: AutomationRuleOutput;

  /** Mermaid flowchart of the automation rule flow. */
  readonly diagram: GeneratedDiagram;

  /** Confidence per mapping dimension. */
  readonly confidence: AutomationConfidenceMap;

  /** Custom field placeholders needing registry resolution before import. */
  readonly fieldMappingPlaceholders: ReadonlyArray<FieldMappingPlaceholder>;

  readonly tokensUsed: number;
  readonly modelUsed: string;
}

// ─── Stage 5 — Auto-validator ─────────────────────────────────────────────────

export interface S5Input {
  readonly generatorOutput: S4GeneratorOutput;
  readonly parsedScript: ParsedScriptShell;
}

export interface S5ValidationIssue {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;             // e.g. "VAL_001"
  readonly message: string;
  readonly file: string;             // Which generated file has this issue
  readonly line: number | null;
  readonly autoFixed: boolean;       // Did the validator auto-correct this?
}

export interface S5ValidationOutput {
  readonly passed: boolean;
  readonly issues: ReadonlyArray<S5ValidationIssue>;
  readonly autoFixCount: number;
  readonly generatorOutput: S4GeneratorOutput;   // Potentially patched output
}

// ─── Final Migration Result ───────────────────────────────────────────────────

/**
 * The complete output of the orchestrator — what the API serves to the frontend.
 */
export interface MigrationResult {
  readonly jobId: string;
  readonly completedAt: string;     // ISO 8601

  // Core outputs
  readonly forgeFiles: ReadonlyArray<GeneratedFile> | null;
  readonly scriptRunnerCode: GeneratedFile | null;

  /**
   * Populated when migrationTarget === 'automation-native'.
   * Contains the importable Automation rule JSON + metadata.
   * Null for Forge and ScriptRunner targets.
   */
  readonly automationRule: AutomationRuleOutput | null;

  readonly diagram: GeneratedDiagram;

  // Context
  readonly businessLogic: BusinessLogicSummary;
  readonly oauthScopes: ReadonlyArray<string>;

  // Quality signals for the UI
  readonly confidence: CodeConfidenceMap;
  readonly cloudReadinessScore: number;          // From parser's CloudReadinessReport
  readonly validationIssues: ReadonlyArray<S5ValidationIssue>;
  readonly fieldMappingPlaceholders: ReadonlyArray<FieldMappingPlaceholder>;

  // Cost / telemetry
  readonly pipeline: PipelineTelemetry;
}

export interface PipelineTelemetry {
  readonly totalTokensUsed: number;
  readonly totalDurationMs: number;
  readonly stageTimings: Record<string, number>;   // stage name → ms
  readonly totalCostUsd: number;
  readonly modelsUsed: ReadonlyArray<string>;
}

// ─── Orchestrator config ──────────────────────────────────────────────────────

export interface OrchestratorConfig {
  readonly classifierModel: string;   // cheap: gpt-4o-mini
  readonly generatorModel: string;    // powerful: claude-sonnet-4-6
  readonly maxRetries: number;        // per-stage retry limit
  readonly stageTimeoutMs: number;    // individual stage timeout
  readonly ragEnabled: boolean;       // can disable for testing
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  classifierModel: 'gpt-4o-mini',
  generatorModel: 'claude-sonnet-4-6',
  maxRetries: 2,
  stageTimeoutMs: 45_000,
  ragEnabled: true,
};

// ─── LLM Provider abstraction ─────────────────────────────────────────────────

/**
 * Thin abstraction over OpenAI / Anthropic.
 * The orchestrator is model-agnostic — concrete implementations live in providers/.
 */
export interface LlmProvider {
  readonly modelId: string;
  complete(params: LlmCompleteParams): Promise<LlmCompleteResult>;
}

export interface LlmCompleteParams {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly jsonMode?: boolean;         // Force JSON output mode if model supports it
}

export interface LlmCompleteResult {
  readonly content: string;
  readonly tokensUsed: number;
  readonly modelId: string;
  readonly durationMs: number;
}

// ─── RAG retriever abstraction ────────────────────────────────────────────────

export interface RagRetriever {
  retrieve(query: string, topK: number): Promise<ReadonlyArray<RagDocument>>;
}
