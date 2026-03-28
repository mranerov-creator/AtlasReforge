/**
 * API DTOs
 *
 * Request and response shapes for all AtlasReforge API endpoints.
 * These are the contracts between the React frontend and the NestJS API.
 *
 * Validation is handled by class-validator decorators.
 * Serialization is handled by class-transformer.
 */

// ─── Job submission ───────────────────────────────────────────────────────────

export class SubmitJobDto {
  /** The original filename (used for language detection boost) */
  filename!: string;

  /** The target migration platform. If omitted, auto-detected by S1. */
  preferredTarget?: 'forge-native' | 'forge-remote' | 'scriptrunner-cloud';

  /** Jira Cloud base URL for Field Mapping Registry validation */
  cloudBaseUrl?: string;

  /** OAuth access token for Jira Cloud API validation (never stored) */
  accessToken?: string;
}

export interface JobSubmittedResponse {
  jobId: string;
  status: 'queued';
  estimatedCostUsd: number | null;
  registrySessionUrl: string;   // URL to the Field Mapping Registry UI for this job
  statusUrl: string;            // Polling URL
}

// ─── Job status ───────────────────────────────────────────────────────────────

export type JobStatus =
  | 'queued'
  | 'parsing'
  | 'classifying'
  | 'extracting'
  | 'retrieving'
  | 'generating'
  | 'validating'
  | 'awaiting-registry'   // Waiting for user to complete Field Mapping Registry
  | 'completed'
  | 'failed';

export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  progress: number;             // 0–100
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  result: MigrationResultDto | null;   // Non-null when status === 'completed'
}

// ─── Migration result ─────────────────────────────────────────────────────────

export interface MigrationResultDto {
  jobId: string;
  originalFilename: string;
  completedAt: string;

  // Script analysis
  cloudReadinessScore: number;
  cloudReadinessLevel: 'green' | 'yellow' | 'red';
  recommendedTarget: string;
  complexity: string;
  linesOfCode: number;

  // Business logic summary
  businessLogic: {
    triggerDescription: string;
    purposeNarrative: string;
    inputConditions: string[];
    outputActions: string[];
    externalIntegrations: string[];
  };

  // Generated code
  forgeFiles: GeneratedFileDto[] | null;
  scriptRunnerCode: GeneratedFileDto | null;

  /**
   * Populated when recommendedTarget === 'automation-native'.
   * Contains the importable Automation rule JSON + metadata.
   */
  automationRule: AutomationRuleDto | null;

  // Diagram (Mermaid source string)
  diagram: {
    type: string;
    mermaidSource: string;
    title: string;
  };

  // Quality signals
  oauthScopes: string[];
  confidence: ConfidenceDto;
  validationIssues: ValidationIssueDto[];
  fieldMappingPlaceholders: FieldMappingPlaceholderDto[];

  // ROI — effort savings
  estimatedEffortHours: {
    consultantHours: number;
    aiAssistedHours: number;
    savingsPercent: number;
  };

  // Telemetry (for ROI dashboard)
  pipeline: {
    totalTokensUsed: number;
    totalDurationMs: number;
    totalCostUsd: number;
    modelsUsed: string[];
    stageTimings: Record<string, number>;
  };
}

export interface GeneratedFileDto {
  filename: string;
  content: string;
  language: string;
  purpose: string;
}

export interface AutomationRuleDto {
  ruleName: string;
  ruleJson: string;
  description: string;
  limitations: string[];
  postImportSteps: string[];
}

// ─── Automation import proxy ──────────────────────────────────────────────────

export class AutomationImportDto {
  /** The Automation rule JSON (Atlassian export format v1) */
  ruleJson!: string;

  /** Jira Cloud base URL, e.g. https://yourcompany.atlassian.net */
  jiraBaseUrl!: string;

  /**
   * Atlassian API token (Basic auth — never stored, used only for this request).
   * Format: base64("email:token") — the controller builds the header.
   */
  email!: string;
  apiToken!: string;
}

export interface AutomationImportResponse {
  success: boolean;
  ruleId: string | null;
  ruleName: string | null;
  ruleUrl: string | null;
  message: string;
}

export interface ConfidenceDto {
  fieldMapping: { score: number; note: string; requiresHumanReview: boolean };
  webhookLogic: { score: number; note: string; requiresHumanReview: boolean };
  userResolution: { score: number; note: string; requiresHumanReview: boolean };
  oauthScopes: { score: number; note: string; requiresHumanReview: boolean };
  overallMigration: { score: number; note: string; requiresHumanReview: boolean };
}

export interface ValidationIssueDto {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file: string;
  line: number | null;
  autoFixed: boolean;
}

export interface FieldMappingPlaceholderDto {
  placeholder: string;
  serverFieldId: string;
  description: string;
  requiredInFile: string;
}

// ─── Field Mapping Registry ───────────────────────────────────────────────────

export class UpdateFieldMappingDto {
  serverFieldId!: string;
  cloudFieldId!: string;
  cloudFieldName?: string;
  notes?: string;
}

export class UpdateGroupMappingDto {
  serverGroupName!: string;
  cloudGroupId!: string;
  cloudGroupName?: string;
  notes?: string;
}

export class UpdateUserMappingDto {
  serverIdentifier!: string;
  cloudAccountId!: string;
  cloudDisplayName?: string;
  cloudEmail?: string;
  resolutionStrategy!: 'migration-api' | 'manual-lookup' | 'service-account' | 'remove';
  notes?: string;
}

export class SkipMappingDto {
  type!: 'customField' | 'group' | 'user';
  identifier!: string;
  notes?: string;
}

// ─── RAG index stats ──────────────────────────────────────────────────────────

export interface RagStatsResponse {
  totalChunks: number;
  byCategory: Array<{
    category: string;
    totalChunks: number;
    embeddedChunks: number;
    newestCrawl: string;
  }>;
  lastCrawlAt: string | null;
}

// ─── Health check ─────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptime: number;
  services: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
    ragIndex: 'up' | 'down' | 'empty';
  };
}
