/**
 * @atlasreforge/field-registry — Types
 *
 * The Field Mapping Registry solves the "hardcoded ID hell" problem:
 *
 *   customfield_10048 (Server) ≠ customfield_XXXXX (Cloud)
 *   "jira-finance-team-PROD" (Server group) ≠ groupId in Cloud
 *   "jsmith" (username) ≠ accountId in Cloud (GDPR)
 *
 * A RegistrySession is the user's mapping document for ONE migration job.
 * It is populated via the UI before S4 code generation runs.
 * Without it, generated code has ATLAS_FIELD_ID() placeholders that
 * cannot be deployed.
 *
 * PERSISTENCE MODEL:
 * - Sessions are stored server-side (Redis TTL: 24h)
 * - Never persisted to long-term DB (ephemeral processing principle)
 * - Exported as JSON for the user to download and reuse across jobs
 */

// ─── Custom Field Mapping ─────────────────────────────────────────────────────

export type MappingStatus =
  | 'unmapped'     // User hasn't provided the Cloud value yet
  | 'mapped'       // User has provided + system has validated
  | 'skipped'      // User explicitly says "not needed in Cloud"
  | 'auto-mapped'; // System found an exact match via Jira API

export interface CustomFieldMapping {
  readonly serverFieldId: string;       // e.g. "customfield_10048"
  readonly serverFieldName: string | null;  // e.g. "Budget Threshold" (from API lookup)
  readonly cloudFieldId: string | null; // e.g. "customfield_10201" (user-provided or auto)
  readonly cloudFieldName: string | null;
  readonly fieldType: string | null;    // e.g. "com.atlassian.jira.plugin.system.customfieldtypes:float"
  readonly probableBusinessPurpose: string; // From S2 enrichment
  readonly usageType: 'read' | 'write' | 'search' | 'unknown';
  readonly status: MappingStatus;
  readonly validatedAt: string | null;  // ISO 8601 — when mapping was confirmed via API
  readonly notes: string | null;        // User-provided notes
}

// ─── Group Mapping ────────────────────────────────────────────────────────────

export interface GroupMapping {
  readonly serverGroupName: string;     // e.g. "jira-finance-team-PROD"
  readonly cloudGroupId: string | null; // e.g. "5e2a1234..." (Cloud group ID, not name)
  readonly cloudGroupName: string | null;
  readonly probableRole: string;        // From S2 enrichment
  readonly status: MappingStatus;
  readonly validatedAt: string | null;
  readonly notes: string | null;
}

// ─── User Mapping (GDPR critical) ────────────────────────────────────────────

export type GdprRisk = 'high' | 'medium' | 'low';
export type UserResolutionStrategy =
  | 'migration-api'     // Resolved via Atlassian User Migration API
  | 'manual-lookup'     // User looked up accountId manually in Jira Cloud
  | 'service-account'   // Replace with a Cloud service account
  | 'remove'            // Remove user reference entirely (not needed in Cloud)
  | 'pending';          // Not yet resolved

export interface UserMapping {
  readonly serverIdentifier: string;    // username or userKey
  readonly identifierType: 'username' | 'user-key' | 'email' | 'unknown';
  readonly cloudAccountId: string | null; // The accountId in Cloud (GDPR-compliant)
  readonly cloudDisplayName: string | null;
  readonly cloudEmail: string | null;
  readonly gdprRisk: GdprRisk;
  readonly resolutionStrategy: UserResolutionStrategy;
  readonly status: MappingStatus;
  readonly validatedAt: string | null;
  readonly notes: string | null;
}

// ─── Registry Session ─────────────────────────────────────────────────────────

/**
 * The complete mapping document for one migration job.
 * Created when a job starts, completed before S4 code generation.
 */
export interface RegistrySession {
  readonly sessionId: string;           // Matches the job ID
  readonly jobId: string;
  readonly originalFilename: string;
  readonly createdAt: string;           // ISO 8601
  readonly updatedAt: string;
  readonly expiresAt: string;           // ISO 8601 — 24h TTL
  readonly customFields: ReadonlyArray<CustomFieldMapping>;
  readonly groups: ReadonlyArray<GroupMapping>;
  readonly users: ReadonlyArray<UserMapping>;
  readonly isComplete: boolean;         // True when all mandatory mappings are resolved
  readonly completionBlockers: ReadonlyArray<CompletionBlocker>;
}

/**
 * A blocker that prevents the registry from being marked complete.
 * These are surfaced in the UI with clear user action required.
 */
export interface CompletionBlocker {
  readonly type: 'unmapped-field' | 'unmapped-group' | 'unmapped-user' | 'validation-failed';
  readonly entityId: string;            // The serverFieldId, groupName, or userIdentifier
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

// ─── Placeholder resolution ───────────────────────────────────────────────────

/**
 * Result of resolving all ATLAS_FIELD_ID() placeholders in generated code.
 * This is applied to S4 output AFTER the registry is complete.
 */
export interface PlaceholderResolutionResult {
  readonly resolvedCode: string;
  readonly totalPlaceholders: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly unresolvedPlaceholders: ReadonlyArray<string>;
}

// ─── Jira Cloud API response shapes (for validation) ─────────────────────────

export interface JiraCloudField {
  readonly id: string;                  // "customfield_10201"
  readonly name: string;                // "Budget Threshold"
  readonly schema?: { type: string; custom: string };
}

export interface JiraCloudGroup {
  readonly groupId: string;             // Cloud group UUID
  readonly name: string;
}

export interface JiraCloudUser {
  readonly accountId: string;
  readonly displayName: string;
  readonly emailAddress: string;
  readonly active: boolean;
}

// ─── Registry session input (for building from ParsedScript) ──────────────────

export interface BuildSessionInput {
  readonly jobId: string;
  readonly originalFilename: string;
  readonly customFieldRefs: ReadonlyArray<{
    fieldId: string;
    usageType: 'read' | 'write' | 'search' | 'unknown';
    probableBusinessPurpose?: string;
  }>;
  readonly groupRefs: ReadonlyArray<{
    groupName: string;
    probableRole?: string;
  }>;
  readonly userRefs: ReadonlyArray<{
    identifier: string;
    identifierType: 'username' | 'user-key' | 'email' | 'unknown';
    gdprRisk?: GdprRisk;
  }>;
}

// ─── Update inputs (from UI form submissions) ─────────────────────────────────

export interface UpdateCustomFieldInput {
  readonly serverFieldId: string;
  readonly cloudFieldId: string;
  readonly cloudFieldName?: string;
  readonly notes?: string;
}

export interface UpdateGroupInput {
  readonly serverGroupName: string;
  readonly cloudGroupId: string;
  readonly cloudGroupName?: string;
  readonly notes?: string;
}

export interface UpdateUserInput {
  readonly serverIdentifier: string;
  readonly cloudAccountId: string;
  readonly cloudDisplayName?: string;
  readonly cloudEmail?: string;
  readonly resolutionStrategy: UserResolutionStrategy;
  readonly notes?: string;
}

export interface SkipMappingInput {
  readonly type: 'customField' | 'group' | 'user';
  readonly identifier: string;          // serverFieldId, groupName, or serverIdentifier
  readonly notes?: string;
}
