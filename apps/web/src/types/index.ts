/**
 * Frontend types — mirrors the API DTOs but typed for React consumption.
 * We don't import from @atlasreforge/api directly (different module system).
 */

// ─── Job lifecycle ────────────────────────────────────────────────────────────

export type JobStatus =
  | 'queued'
  | 'parsing'
  | 'classifying'
  | 'extracting'
  | 'retrieving'
  | 'generating'
  | 'validating'
  | 'awaiting-registry'
  | 'completed'
  | 'failed';

export type CloudReadinessLevel = 'green' | 'yellow' | 'red';
export type MigrationTarget =
  | 'forge-native'
  | 'forge-remote'
  | 'scriptrunner-cloud'
  | 'forge-or-scriptrunner'
  | 'manual-rewrite';

export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  progress: number;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  result: MigrationResult | null;
}

export interface MigrationResult {
  jobId: string;
  originalFilename: string;
  completedAt: string;
  cloudReadinessScore: number;
  cloudReadinessLevel: CloudReadinessLevel;
  recommendedTarget: MigrationTarget;
  complexity: string;
  linesOfCode: number;
  businessLogic: BusinessLogicSummary;
  forgeFiles: GeneratedFile[] | null;
  scriptRunnerCode: GeneratedFile | null;
  diagram: MermaidDiagram;
  oauthScopes: string[];
  confidence: ConfidenceMap;
  validationIssues: ValidationIssue[];
  fieldMappingPlaceholders: FieldMappingPlaceholder[];
  pipeline: PipelineTelemetry;
}

export interface BusinessLogicSummary {
  triggerDescription: string;
  purposeNarrative: string;
  inputConditions: string[];
  outputActions: string[];
  externalIntegrations: string[];
}

export interface GeneratedFile {
  filename: string;
  content: string;
  language: string;
  purpose: string;
}

export interface MermaidDiagram {
  type: string;
  mermaidSource: string;
  title: string;
}

export interface ConfidenceMap {
  fieldMapping: ConfidenceBlock;
  webhookLogic: ConfidenceBlock;
  userResolution: ConfidenceBlock;
  oauthScopes: ConfidenceBlock;
  overallMigration: ConfidenceBlock;
}

export interface ConfidenceBlock {
  score: number;
  note: string;
  requiresHumanReview: boolean;
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file: string;
  line: number | null;
  autoFixed: boolean;
}

export interface FieldMappingPlaceholder {
  placeholder: string;
  serverFieldId: string;
  description: string;
  requiredInFile: string;
}

export interface PipelineTelemetry {
  totalTokensUsed: number;
  totalDurationMs: number;
  totalCostUsd: number;
  modelsUsed: string[];
  stageTimings: Record<string, number>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export type MappingStatus = 'unmapped' | 'mapped' | 'skipped' | 'auto-mapped';

export interface RegistrySession {
  sessionId: string;
  jobId: string;
  originalFilename: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  customFields: CustomFieldMapping[];
  groups: GroupMapping[];
  users: UserMapping[];
  isComplete: boolean;
  completionBlockers: CompletionBlocker[];
}

export interface CustomFieldMapping {
  serverFieldId: string;
  serverFieldName: string | null;
  cloudFieldId: string | null;
  cloudFieldName: string | null;
  probableBusinessPurpose: string;
  usageType: 'read' | 'write' | 'search' | 'unknown';
  status: MappingStatus;
  validatedAt: string | null;
  notes: string | null;
}

export interface GroupMapping {
  serverGroupName: string;
  cloudGroupId: string | null;
  cloudGroupName: string | null;
  probableRole: string;
  status: MappingStatus;
  validatedAt: string | null;
  notes: string | null;
}

export interface UserMapping {
  serverIdentifier: string;
  identifierType: string;
  cloudAccountId: string | null;
  cloudDisplayName: string | null;
  gdprRisk: 'high' | 'medium' | 'low';
  resolutionStrategy: string;
  status: MappingStatus;
  validatedAt: string | null;
  notes: string | null;
}

export interface CompletionBlocker {
  type: string;
  entityId: string;
  message: string;
  severity: 'error' | 'warning';
}

// ─── UI state ─────────────────────────────────────────────────────────────────

export type ActiveTab = 'summary' | 'forge' | 'scriptrunner' | 'diagram';

export interface WorkspaceState {
  jobId: string;
  filename: string;
  status: JobStatus;
  result: MigrationResult | null;
  activeTab: ActiveTab;
  selectedFile: GeneratedFile | null;
}
