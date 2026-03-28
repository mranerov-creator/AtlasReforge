/**
 * Cloud Compatibility Analyzer
 *
 * Pure function — no LLM, no I/O, no side effects.
 * Input: DependencyMap + script metadata
 * Output: CloudReadinessReport with 🟢🟡🔴 classification
 *
 * This is intentionally kept LLM-free so it can:
 *   1. Run synchronously in Stage 1 of the pipeline
 *   2. Be used by Stage 5 (auto-validation) to check generated code
 *   3. Be unit tested exhaustively with deterministic inputs
 */

import type {
  AtlassianModuleType,
  CloudReadinessIssue,
  CloudReadinessLevel,
  CloudReadinessReport,
  DependencyMap,
  EstimatedEffort,
  MigrationTarget,
  ScriptComplexity,
  ScriptLanguage,
} from '../types/parsed-script.types.js';

// ─── Rule definitions ─────────────────────────────────────────────────────────

interface CompatibilityRule {
  readonly code: string;
  readonly evaluate: (
    deps: DependencyMap,
    ctx: AnalysisContext,
  ) => CloudReadinessIssue | null;
}

interface AnalysisContext {
  readonly language: ScriptLanguage;
  readonly moduleType: AtlassianModuleType;
  readonly linesOfCode: number;
}

const RULES: ReadonlyArray<CompatibilityRule> = [
  // ── RED rules — blockers ────────────────────────────────────────────────

  {
    code: 'CR-001',
    evaluate: (deps) => {
      const fsApis = deps.deprecatedApis.filter(
        (a) => a.deprecationReason === 'filesystem-access',
      );
      if (fsApis.length === 0) return null;
      return {
        level: 'red',
        category: 'filesystem-access',
        title: 'Filesystem access detected (java.io.File)',
        description:
          'Forge has no filesystem. Files must be stored via Atlassian Media API or Confluence attachments.',
        affectedExpression: fsApis.map((a) => a.apiClass).join(', '),
        lineNumber: fsApis[0]?.lineNumber ?? null,
        cloudAlternative: 'Atlassian Media API: POST /rest/api/3/attachment',
        requiresFieldMappingRegistry: false,
      };
    },
  },

  {
    code: 'CR-002',
    evaluate: (deps) => {
      const sqlApis = deps.deprecatedApis.filter(
        (a) => a.deprecationReason === 'direct-sql',
      );
      if (sqlApis.length === 0) return null;
      return {
        level: 'red',
        category: 'deprecated-api',
        title: 'Direct SQL/OFBiz database access',
        description:
          'Cloud has no OFBiz access. All data must go through REST API v3 or Forge Storage.',
        affectedExpression: sqlApis.map((a) => a.apiClass).join(', '),
        lineNumber: sqlApis[0]?.lineNumber ?? null,
        cloudAlternative:
          'Forge Storage API or REST API v3 for Jira entity access',
        requiresFieldMappingRegistry: false,
      };
    },
  },

  {
    code: 'CR-003',
    evaluate: (_deps, ctx) => {
      if (ctx.moduleType !== 'web-panel') return null;
      return {
        level: 'red',
        category: 'deprecated-api',
        title: 'Velocity Web Panel — no Cloud equivalent',
        description:
          'Velocity templates have zero coverage in Cloud. This requires a full rewrite as a Forge Custom UI React component.',
        affectedExpression: 'web-panel module',
        lineNumber: null,
        cloudAlternative:
          'Forge Custom UI: React component deployed via manifest.yml ui-kit or custom-ui',
        requiresFieldMappingRegistry: false,
      };
    },
  },

  // ── YELLOW rules — paradigm shifts ──────────────────────────────────────

  {
    code: 'CR-010',
    evaluate: (deps) => {
      const userRefs = deps.users;
      if (userRefs.length === 0) return null;
      return {
        level: 'yellow',
        category: 'gdpr-user-reference',
        title: `${userRefs.length} username/userKey reference(s) — GDPR violation in Cloud`,
        description:
          'Cloud strictly forbids username and userKey. All user references must use accountId.',
        affectedExpression: userRefs.map((u) => u.identifier).join(', '),
        lineNumber: userRefs[0]?.lineNumber ?? null,
        cloudAlternative:
          'Resolve via Atlassian User Migration API. Replace all user.name with user.accountId.',
        requiresFieldMappingRegistry: true,
      };
    },
  },

  {
    code: 'CR-011',
    evaluate: (deps) => {
      const groups = deps.groups;
      if (groups.length === 0) return null;
      return {
        level: 'yellow',
        category: 'hardcoded-ids',
        title: `${groups.length} hardcoded group name(s) detected`,
        description:
          'Group names differ between Server and Cloud environments. Must be mapped via Field Mapping Registry.',
        affectedExpression: groups.map((g) => g.groupName).join(', '),
        lineNumber: groups[0]?.lineNumber ?? null,
        cloudAlternative:
          'Map group names to Cloud group IDs via REST API v3: GET /rest/api/3/group',
        requiresFieldMappingRegistry: true,
      };
    },
  },

  {
    code: 'CR-012',
    evaluate: (deps) => {
      const fields = deps.customFields;
      if (fields.length === 0) return null;
      return {
        level: 'yellow',
        category: 'hardcoded-ids',
        title: `${fields.length} hardcoded custom field ID(s) detected`,
        description:
          'customfield_XXXXX IDs are environment-specific. The same field has a different ID in Cloud.',
        affectedExpression: [...new Set(fields.map((f) => f.fieldId))].join(
          ', ',
        ),
        lineNumber: fields[0]?.lineNumber ?? null,
        cloudAlternative:
          'Map Server field IDs to Cloud field IDs via Field Mapping Registry before migration.',
        requiresFieldMappingRegistry: true,
      };
    },
  },

  {
    code: 'CR-013',
    evaluate: (_deps, ctx) => {
      // Listeners are async in Cloud — synchronous abort pattern doesn't work
      if (ctx.moduleType !== 'listener') return null;
      return {
        level: 'yellow',
        category: 'sync-to-async-paradigm',
        title: 'Synchronous listener — webhooks are async in Cloud',
        description:
          'Server listeners can abort actions synchronously. In Cloud, webhooks are fire-and-forget. Use Forge validators for pre-condition logic.',
        affectedExpression: 'listener module',
        lineNumber: null,
        cloudAlternative:
          'Redesign abort logic as a Forge validator. Notifications as async webhooks/automations.',
        requiresFieldMappingRegistry: false,
      };
    },
  },

  {
    code: 'CR-014',
    evaluate: (deps, ctx) => {
      // Detect potential Forge timeout risk (25s limit)
      const hasExternalCalls = deps.externalHttpCalls.length > 0;
      const hasMultipleApiCalls = deps.internalApiCalls.length > 3;
      const isLargeScript = ctx.linesOfCode > 150;

      if (
        !(hasExternalCalls && isLargeScript) &&
        !(hasMultipleApiCalls && isLargeScript)
      )
        return null;

      return {
        level: 'yellow',
        category: 'timeout-risk',
        title:
          'Potential Forge timeout risk (25s execution limit)',
        description: `Script has ${ctx.linesOfCode} LOC with ${deps.externalHttpCalls.length} external calls and ${deps.internalApiCalls.length} internal API calls. Forge functions must complete in 25 seconds.`,
        affectedExpression: 'script execution time',
        lineNumber: null,
        cloudAlternative:
          'Consider Forge Remote for heavy computation. Implement pagination. Break into smaller async jobs.',
        requiresFieldMappingRegistry: false,
      };
    },
  },

  {
    code: 'CR-015',
    evaluate: (deps) => {
      const v2Calls = deps.internalApiCalls.filter(
        (c) => c.apiVersion === '2',
      );
      if (v2Calls.length === 0) return null;
      return {
        level: 'yellow',
        category: 'deprecated-api',
        title: `${v2Calls.length} REST API v2 call(s) — upgrade to v3`,
        description:
          'REST API v2 is deprecated in Cloud. Some v2 endpoints are removed. All calls must target v3.',
        affectedExpression: v2Calls
          .map((c) => c.endpoint)
          .slice(0, 3)
          .join(', '),
        lineNumber: v2Calls[0]?.lineNumber ?? null,
        cloudAlternative:
          'Migrate to REST API v3. Most endpoints are backwards compatible with minor changes.',
        requiresFieldMappingRegistry: false,
      };
    },
  },

  {
    code: 'CR-016',
    evaluate: (_deps, ctx) => {
      if (ctx.moduleType !== 'connect-descriptor') return null;
      return {
        level: 'yellow',
        category: 'connect-to-forge',
        title: 'Atlassian Connect app detected — migrate to Forge',
        description:
          'Connect apps require an external server and JWT auth. Forge is serverless and the recommended migration target.',
        affectedExpression: 'atlassian-plugin.xml',
        lineNumber: null,
        cloudAlternative:
          'Migrate to Forge. Use Forge Remote for logic that exceeds Forge execution limits.',
        requiresFieldMappingRegistry: false,
      };
    },
  },

  // ── GREEN rules — direct migration confirmation ──────────────────────────

  {
    code: 'CR-020',
    evaluate: (deps) => {
      // If only v3 internal API calls and no deprecated APIs → green signal
      const hasOnlyV3 =
        deps.internalApiCalls.length > 0 &&
        deps.internalApiCalls.every((c) => c.apiVersion === '3');
      const noDeprecated = deps.deprecatedApis.length === 0;
      const noFilesystem = deps.deprecatedApis.filter(
        (a) => a.deprecationReason === 'filesystem-access',
      ).length === 0;

      if (hasOnlyV3 && noDeprecated && noFilesystem) {
        return {
          level: 'green',
          category: 'deprecated-api',
          title: 'REST API v3 already in use — direct migration path',
          description:
            'Script already targets REST API v3. Migration is straightforward.',
          affectedExpression: 'REST API usage',
          lineNumber: null,
          cloudAlternative: null,
          requiresFieldMappingRegistry: false,
        };
      }
      return null;
    },
  },
];

// ─── Score calculator ─────────────────────────────────────────────────────────

function calculateScore(issues: ReadonlyArray<CloudReadinessIssue>): number {
  const redCount = issues.filter((i) => i.level === 'red').length;
  const yellowCount = issues.filter((i) => i.level === 'yellow').length;

  // Each RED issue deducts 25 points (max 4 RED = 0 score)
  // Each YELLOW issue deducts 10 points
  const score = 100 - redCount * 25 - yellowCount * 10;
  return Math.max(0, Math.min(100, score));
}

function resolveOverallLevel(
  issues: ReadonlyArray<CloudReadinessIssue>,
): CloudReadinessLevel {
  if (issues.some((i) => i.level === 'red')) return 'red';
  if (issues.some((i) => i.level === 'yellow')) return 'yellow';
  return 'green';
}

// ─── Migration target resolver ────────────────────────────────────────────────

function resolveMigrationTarget(
  issues: ReadonlyArray<CloudReadinessIssue>,
  ctx: AnalysisContext,
): MigrationTarget {
  const hasWebPanel = issues.some(
    (i) => i.category === 'deprecated-api' && i.title.includes('Velocity'),
  );
  const hasConnectDescriptor = ctx.moduleType === 'connect-descriptor';
  const hasTimeoutRisk = issues.some((i) => i.category === 'timeout-risk');
  const hasFilesystem = issues.some(
    (i) => i.category === 'filesystem-access',
  );

  if (hasConnectDescriptor) return 'forge-remote';
  if (hasWebPanel) return 'forge-native';
  if (hasFilesystem) return 'manual-rewrite';
  if (hasTimeoutRisk) return 'forge-remote';

  if (ctx.language === 'groovy' && ctx.moduleType !== 'web-panel') {
    return 'forge-or-scriptrunner';
  }

  return 'forge-native';
}

// ─── Effort estimator ─────────────────────────────────────────────────────────

const EFFORT_TABLE: Record<
  ScriptComplexity,
  { consultant: number; aiAssisted: number }
> = {
  low: { consultant: 4, aiAssisted: 1 },
  medium: { consultant: 8, aiAssisted: 2 },
  high: { consultant: 15, aiAssisted: 3.5 },
  critical: { consultant: 30, aiAssisted: 6 },
};

function estimateEffort(complexity: ScriptComplexity): EstimatedEffort {
  const base = EFFORT_TABLE[complexity];
  const savingsPercent = Math.round(
    ((base.consultant - base.aiAssisted) / base.consultant) * 100,
  );
  return {
    consultantHours: base.consultant,
    aiAssistedHours: base.aiAssisted,
    savingsPercent,
  };
}

// ─── Complexity resolver ──────────────────────────────────────────────────────

export function resolveComplexity(
  deps: DependencyMap,
  linesOfCode: number,
): ScriptComplexity {
  let score = 0;

  score += deps.deprecatedApis.length * 5;
  score += deps.externalHttpCalls.length * 3;
  score += deps.users.length * 4;       // GDPR issues are complex to resolve
  score += deps.groups.length * 2;
  score += deps.customFields.length * 2;
  score += deps.scriptDependencies.length * 3;
  score += Math.floor(linesOfCode / 50);  // Every 50 LOC adds 1 point

  if (score >= 20) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function analyzeCloudCompatibility(
  deps: DependencyMap,
  ctx: AnalysisContext,
): CloudReadinessReport {
  const complexity = resolveComplexity(deps, ctx.linesOfCode);

  // Run all rules and collect non-null issues
  const issues = RULES.map((rule) => rule.evaluate(deps, ctx)).filter(
    (issue): issue is CloudReadinessIssue => issue !== null,
  );

  const overallLevel = resolveOverallLevel(issues);
  const score = calculateScore(issues);
  const migrationTarget = resolveMigrationTarget(issues, ctx);
  const effort = estimateEffort(complexity);

  return {
    overallLevel,
    score,
    issues,
    recommendedMigrationTarget: migrationTarget,
    estimatedEffortHours: effort,
  };
}
