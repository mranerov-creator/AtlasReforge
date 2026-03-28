/**
 * @atlasreforge/parser — Public API
 */

// Types
export type {
  AtlassianModuleType,
  AutomationOperation,
  AutomationRuleOutput,
  AutomationSuitability,
  BusinessLogicSummary,
  CloudReadinessIssue,
  CloudReadinessLevel,
  CloudReadinessReport,
  ConfidenceScores,
  CustomFieldRef,
  DependencyMap,
  DeprecatedApiUsage,
  DeprecationReason,
  EstimatedEffort,
  ExternalHttpCall,
  GroupRef,
  InternalApiCall,
  IssueCategory,
  MigrationTarget,
  ParsedScript,
  ParsedScriptShell,
  ParseError,
  ParseStrategy,
  ParseStrategyMetadata,
  ParseWarning,
  ScriptComplexity,
  ScriptDependency,
  ScriptLanguage,
  ScriptLanguageConfidence,
  TriggerEvent,
  UserRef,
} from './types/parsed-script.types.js';

// Service
export { ParserService } from './parser.service.js';
export type { ParserInput, ParserServiceConfig } from './parser.service.js';

// Detectors (exported for use in tests and downstream stages)
export { detectLanguage } from './detectors/language.detector.js';
export type { LanguageDetectionResult } from './detectors/language.detector.js';
export { detectModuleType } from './detectors/module-type.detector.js';
export type { ModuleTypeDetectionResult } from './detectors/module-type.detector.js';

// Extractors
export { extractDependencies } from './extractors/dependency.extractor.js';

// Analyzer
export {
  analyzeCloudCompatibility,
  assessAutomationSuitability,
  resolveComplexity,
} from './analyzers/cloud-compatibility.analyzer.js';

// LLM client interface (for DI)
export type { LlmClient } from './strategies/llm-semantic.strategy.js';
