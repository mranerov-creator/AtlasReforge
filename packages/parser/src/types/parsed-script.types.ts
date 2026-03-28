/**
 * @atlasreforge/parser — Canonical output types
 *
 * This is the single source of truth for the Parser's output contract.
 * Every downstream stage in the LLM pipeline (S1–S5) consumes these types.
 * Changing anything here is a breaking change — treat with care.
 */

// ─── Language & Trigger classification ────────────────────────────────────────

export type ScriptLanguage = 'groovy' | 'java' | 'sil' | 'unknown';

export type ScriptLanguageConfidence = 'high' | 'medium' | 'low';

/**
 * Atlassian Server/DC module types that map to specific migration strategies.
 * Parsed from code patterns or atlassian-plugin.xml.
 */
export type AtlassianModuleType =
  | 'post-function'
  | 'validator'
  | 'condition'
  | 'listener'                // ScriptRunner Event Listener
  | 'jql-function'
  | 'script-console'
  | 'scheduled-job'
  | 'rest-endpoint'
  | 'web-panel'               // Velocity → Forge Custom UI
  | 'web-resource'
  | 'workflow-function'
  | 'connect-descriptor'      // atlassian-plugin.xml parsed
  | 'inline-script'           // SIL inline in workflow
  | 'field-function'          // SIL getFieldValue patterns
  | 'unknown';

export type TriggerEvent =
  | 'issue-created'
  | 'issue-updated'
  | 'issue-transitioned'
  | 'comment-added'
  | 'sprint-started'
  | 'scheduled'
  | 'manual'
  | 'unknown';

// ─── Hardcoded dependency extraction ──────────────────────────────────────────

/**
 * A custom field reference detected in the source code.
 * customfield_10048 in Server ≠ customfield_XXXXX in Cloud.
 * These MUST be resolved via the FieldMappingRegistry before code generation.
 */
export interface CustomFieldRef {
  readonly fieldId: string;            // e.g. "customfield_10048"
  readonly usageType: 'read' | 'write' | 'search' | 'unknown';
  readonly rawExpression: string;      // The exact matched string for traceability
  readonly lineNumber: number | null;
}

/**
 * A group reference. groupManager.getGroup("jira-software-users-PROD")
 * Group names differ between Server and Cloud.
 */
export interface GroupRef {
  readonly groupName: string;          // e.g. "jira-software-users-PROD"
  readonly rawExpression: string;
  readonly lineNumber: number | null;
}

/**
 * A user reference — GDPR CRITICAL.
 * userManager.getUserByName("jsmith") is illegal in Cloud.
 * Must be resolved to accountId via Atlassian User Migration API.
 */
export interface UserRef {
  readonly identifier: string;         // username, userKey, or partial email
  readonly identifierType: 'username' | 'user-key' | 'email' | 'unknown';
  readonly rawExpression: string;
  readonly lineNumber: number | null;
}

/**
 * External HTTP call detected in the script.
 * Critical for assessing Forge Egress requirements and rate limits.
 */
export interface ExternalHttpCall {
  readonly url: string | null;         // May be null if URL is dynamic
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'unknown';
  readonly isDynamic: boolean;         // URL built at runtime from variables
  readonly rawExpression: string;
  readonly lineNumber: number | null;
}

/**
 * Internal Jira REST API call (targeting /rest/api/* on the same instance).
 * Relevant for detecting self-referential REST calls that change semantics in Cloud.
 */
export interface InternalApiCall {
  readonly endpoint: string;           // e.g. "/rest/api/2/issue/{issueKey}"
  readonly apiVersion: '2' | '3' | 'agile' | 'servicedesk' | 'unknown';
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'unknown';
  readonly rawExpression: string;
  readonly lineNumber: number | null;
}

/**
 * Deprecated Server-only Java API usages. These are the 🔴 RED flags.
 * Their presence determines CloudReadinessLevel.
 */
export interface DeprecatedApiUsage {
  readonly apiClass: string;           // e.g. "ComponentAccessor", "IssueManager"
  readonly methodCall: string;         // e.g. "getIssueManager()", "getUserByName()"
  readonly deprecationReason: DeprecationReason;
  readonly cloudAlternative: string;   // What to use instead
  readonly rawExpression: string;
  readonly lineNumber: number | null;
}

export type DeprecationReason =
  | 'server-only-java-api'    // ComponentAccessor, IssueManager, etc.
  | 'sync-blocking'           // Synchronous patterns forbidden in Cloud
  | 'direct-sql'              // OFBiz SQL access
  | 'filesystem-access'       // java.io.File, groovy.io
  | 'username-usage'          // GDPR — username/userKey deprecated
  | 'dom-manipulation'        // Direct Jira DOM access
  | 'deprecated-rest-v2';     // REST API v2 endpoints removed in Cloud

/**
 * Script dependency (require/import of another script file).
 * Critical for the dependency graph in Triage view.
 */
export interface ScriptDependency {
  readonly importedPath: string;       // e.g. "shared-utils.sil", "lib/helpers.groovy"
  readonly importType: 'require' | 'import' | 'include' | 'unknown';
  readonly rawExpression: string;
  readonly lineNumber: number | null;
}

/**
 * Aggregated map of all hardcoded dependencies found in the script.
 */
export interface DependencyMap {
  readonly customFields: ReadonlyArray<CustomFieldRef>;
  readonly groups: ReadonlyArray<GroupRef>;
  readonly users: ReadonlyArray<UserRef>;
  readonly externalHttpCalls: ReadonlyArray<ExternalHttpCall>;
  readonly internalApiCalls: ReadonlyArray<InternalApiCall>;
  readonly deprecatedApis: ReadonlyArray<DeprecatedApiUsage>;
  readonly scriptDependencies: ReadonlyArray<ScriptDependency>;
}

// ─── Cloud Readiness Analysis ─────────────────────────────────────────────────

export type CloudReadinessLevel =
  | 'green'    // 🟢 Direct migration — full API coverage
  | 'yellow'   // 🟡 Paradigm shift required — redesign needed
  | 'red';     // 🔴 No coverage — architectural blocker

export interface CloudReadinessIssue {
  readonly level: CloudReadinessLevel;
  readonly category: IssueCategory;
  readonly title: string;
  readonly description: string;
  readonly affectedExpression: string;
  readonly lineNumber: number | null;
  readonly cloudAlternative: string | null;
  readonly requiresFieldMappingRegistry: boolean;
}

export type IssueCategory =
  | 'deprecated-api'
  | 'sync-to-async-paradigm'
  | 'gdpr-user-reference'
  | 'filesystem-access'
  | 'direct-sql'
  | 'hardcoded-ids'           // customfield IDs, group names
  | 'timeout-risk'            // Logic likely to exceed 25s Forge limit
  | 'missing-oauth-scope'     // Detected API usage requires specific scope
  | 'connect-to-forge';       // Connect-specific module needing Forge Remote

export interface CloudReadinessReport {
  readonly overallLevel: CloudReadinessLevel;
  readonly score: number;                          // 0-100
  readonly issues: ReadonlyArray<CloudReadinessIssue>;
  readonly recommendedMigrationTarget: MigrationTarget;
  readonly estimatedEffortHours: EstimatedEffort;

  /**
   * Populated when the analyzer detects the script may be expressible
   * as a native Atlassian Cloud Automation rule.
   * Null when automation-native is not a viable target.
   */
  readonly automationSuitability: AutomationSuitability | null;
}

export type MigrationTarget =
  | 'forge-native'            // Full Forge app (manifest + resolvers + frontend)
  | 'forge-remote'            // Forge with external backend (heavy compute)
  | 'scriptrunner-cloud'      // ScriptRunner for Cloud (Groovy REST)
  | 'forge-or-scriptrunner'   // Either viable — depends on license/preference
  | 'automation-native'       // 🔵 Atlassian Cloud Automation rule (no-code/low-code)
  | 'manual-rewrite';         // Too complex for automated migration

// ─── Automation Native types ──────────────────────────────────────────────────

/**
 * Suitability assessment for migrating a script to Atlassian Cloud Automation.
 * Produced by the cloud-compatibility analyzer BEFORE LLM stages run.
 */
export interface AutomationSuitability {
  /** Whether this script is a candidate for automation-native migration. */
  readonly isSuitable: boolean;

  /**
   * Confidence level in the suitability assessment.
   *   high   — trigger + all operations map 1:1 to Automation primitives
   *   medium — trigger maps, some operations need minor adaptation
   *   low    — trigger maps but operations are partially unsupported
   */
  readonly confidence: 'high' | 'medium' | 'low';

  /**
   * Automation trigger that maps to the detected script trigger.
   * e.g. "Issue created", "Issue transitioned", "Scheduled"
   */
  readonly mappedTrigger: string | null;

  /** Operations the script performs that map to Automation actions/conditions. */
  readonly mappableOperations: ReadonlyArray<AutomationOperation>;

  /** Operations that CANNOT be expressed in Automation — blockers for this target. */
  readonly unmappableOperations: ReadonlyArray<AutomationOperation>;

  /**
   * Human-readable rationale for the suitability decision.
   * Displayed in the frontend triage card.
   */
  readonly rationale: string;
}

export interface AutomationOperation {
  /** Short label for the operation, e.g. "Set field value", "HTTP request" */
  readonly label: string;

  /** The raw code expression that triggered this detection */
  readonly sourceExpression: string;

  /** Automation equivalent action/condition key, null if unmappable */
  readonly automationEquivalent: string | null;
}

/**
 * The output of Stage 4b — the generated Atlassian Cloud Automation rule.
 * This is the no-code/low-code counterpart to Forge's forgeFiles.
 */
export interface AutomationRuleOutput {
  /**
   * The Automation rule name (will appear in the Automation rules list).
   */
  readonly ruleName: string;

  /**
   * Complete Automation rule JSON, ready to import via
   * Jira Settings → Automation → Import rule.
   * Conforms to Atlassian Automation rule export schema v1.
   */
  readonly ruleJson: string;

  /**
   * Human-readable description of the rule for documentation purposes.
   */
  readonly description: string;

  /**
   * Limitations compared to the original script — anything lost in translation.
   */
  readonly limitations: ReadonlyArray<string>;

  /**
   * Manual steps required after import (e.g. re-map custom field IDs).
   */
  readonly postImportSteps: ReadonlyArray<string>;
}

export interface EstimatedEffort {
  readonly consultantHours: number;
  readonly aiAssistedHours: number;
  readonly savingsPercent: number;
}

// ─── Parse Strategy metadata ──────────────────────────────────────────────────

export type ParseStrategy = 'ast' | 'llm-semantic' | 'hybrid';

export interface ParseStrategyMetadata {
  readonly strategy: ParseStrategy;
  readonly reason: string;           // Why this strategy was chosen
  readonly astCoverage: number;      // 0-1 — how much was handled by AST vs LLM
  readonly llmTokensUsed: number | null;
}

// ─── Confidence Scores ────────────────────────────────────────────────────────

/**
 * Per-section confidence scores for the LLM output.
 * Used to highlight low-confidence areas in the Monaco diff view.
 */
export interface ConfidenceScores {
  readonly languageDetection: number;       // 0-1
  readonly moduleTypeDetection: number;     // 0-1
  readonly dependencyExtraction: number;    // 0-1
  readonly cloudReadinessAnalysis: number;  // 0-1
  readonly businessLogicSummary: number;    // 0-1
}

// ─── Business Logic Summary ───────────────────────────────────────────────────

/**
 * Human-readable summary of what the script does.
 * Generated by the LLM in Stage 2 — NOT by regex/AST.
 * Null until LLM processing completes.
 */
export interface BusinessLogicSummary {
  readonly triggerDescription: string;     // "Script executes on 'Approve' transition"
  readonly purposeNarrative: string;       // Plain English of what it does
  readonly inputConditions: ReadonlyArray<string>;
  readonly outputActions: ReadonlyArray<string>;
  readonly externalIntegrations: ReadonlyArray<string>;
}

// ─── Root output type ─────────────────────────────────────────────────────────

/**
 * The canonical output of the Parser module.
 * This is what Stage 1 (Classifier) receives as input.
 *
 * IMMUTABILITY: All nested properties are ReadonlyArray / readonly.
 * This prevents accidental mutation across pipeline stages.
 */
export interface ParsedScript {
  // ── Identity ──────────────────────────────────────────────────────────────
  readonly id: string;                          // UUID — job correlation ID
  readonly originalFilename: string;
  readonly contentHash: string;                 // SHA-256 of raw input (for caching)
  readonly parsedAt: string;                    // ISO 8601

  // ── Classification ────────────────────────────────────────────────────────
  readonly language: ScriptLanguage;
  readonly languageConfidence: ScriptLanguageConfidence;
  readonly moduleType: AtlassianModuleType;
  readonly triggerEvent: TriggerEvent;
  readonly linesOfCode: number;
  readonly complexity: ScriptComplexity;

  // ── Extraction ────────────────────────────────────────────────────────────
  readonly dependencies: DependencyMap;

  // ── Analysis ──────────────────────────────────────────────────────────────
  readonly cloudReadiness: CloudReadinessReport;

  // ── LLM-generated content (nullable until Stage 4 completes) ──────────────
  readonly businessLogic: BusinessLogicSummary | null;

  // ── Meta ──────────────────────────────────────────────────────────────────
  readonly parseStrategy: ParseStrategyMetadata;
  readonly confidence: ConfidenceScores;
  readonly errors: ReadonlyArray<ParseError>;
  readonly warnings: ReadonlyArray<ParseWarning>;
}

export type ScriptComplexity = 'low' | 'medium' | 'high' | 'critical';

export interface ParseError {
  readonly code: string;               // e.g. "PARSE_001"
  readonly message: string;
  readonly fatal: boolean;
  readonly stage: 'detection' | 'extraction' | 'analysis' | 'llm';
}

export interface ParseWarning {
  readonly code: string;               // e.g. "WARN_001"
  readonly message: string;
  readonly affectedField: keyof ParsedScript | string;
}

// ─── Partial result during pipeline processing ────────────────────────────────

/**
 * Intermediate type used within the parser before LLM stages complete.
 * businessLogic is always null here.
 */
export type ParsedScriptShell = Omit<ParsedScript, 'businessLogic'> & {
  readonly businessLogic: null;
};
