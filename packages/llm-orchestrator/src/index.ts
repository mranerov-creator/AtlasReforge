/**
 * @atlasreforge/llm-orchestrator — Public API
 */

// Main service
export {
  OrchestratorService,
  PipelineError,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from './orchestrator.service.js';
export type {
  OrchestratorConfig,
  OrchestratorInput,
  OrchestratorDeps,
} from './orchestrator.service.js';

// Pipeline types
export type {
  BlockConfidence,
  BusinessLogicSummary,
  CodeConfidenceMap,
  DetectedPattern,
  EnrichedCustomField,
  EnrichedGroup,
  EnrichedUserRef,
  FieldMappingPlaceholder,
  GeneratedDiagram,
  GeneratedFile,
  LlmCompleteParams,
  LlmCompleteResult,
  LlmProvider,
  MigrationResult,
  PipelineCostEstimate,
  PipelineTelemetry,
  RagDocument,
  RagRetriever,
  S1ClassifierOutput,
  S2ExtractionOutput,
  S3RetrievalOutput,
  S4GeneratorOutput,
  S5ValidationIssue,
  S5ValidationOutput,
} from './types/pipeline.types.js';

// Providers
export {
  AnthropicProvider,
  OpenAIProvider,
  LlmProviderError,
  JsonParseError,
  parseJsonResponse,
  withRetry,
} from './providers/llm.providers.js';

// Stage exports (for testing and direct use)
export { runS1Classifier } from './stages/s1-classifier.js';
export { runS2Extractor } from './stages/s2-extractor.js';
export {
  runS3Retrieval,
  NoopRagRetriever,
  InMemoryRagRetriever,
} from './stages/s3-retrieval.js';
export { runS4Generator } from './stages/s4-generator.js';
export { runS5Validator } from './stages/s5-validator.js';

// Meta-prompts (exported for inspection and testing)
export {
  GENERATED_CODE_VALIDATION_RULES,
} from './meta-prompts/prompts.js';
