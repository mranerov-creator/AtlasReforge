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
  AutomationOperation,
  AutomationSuitability,
  CloudReadinessIssue,
  CloudReadinessLevel,
  CloudReadinessReport,
  DependencyMap,
  EstimatedEffort,
  MigrationTarget,
  ScriptComplexity,
  ScriptLanguage,
  TriggerEvent,
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
  readonly triggerEvent: TriggerEvent;
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

  // ── AUTOMATION-NATIVE rules (CR-021–030) ────────────────────────────────

  {
    code: 'CR-021',
    evaluate: (deps) => {
      // Complex external HTTP calls are a blocker for automation-native
      const complexHttp = deps.externalHttpCalls.filter((c) => c.isDynamic);
      if (complexHttp.length === 0) return null;
      return {
        level: 'yellow',
        category: 'deprecated-api',
        title: `${complexHttp.length} dynamic external HTTP call(s) — not expressible in Automation`,
        description:
          'Automation rules support static HTTP requests but not dynamic URL construction at runtime. Consider Forge for this script.',
        affectedExpression: complexHttp.map((c) => c.rawExpression).slice(0, 2).join(', '),
        lineNumber: complexHttp[0]?.lineNumber ?? null,
        cloudAlternative: 'Forge fetch() with dynamic URL construction',
        requiresFieldMappingRegistry: false,
      };
    },
  },

  {
    code: 'CR-022',
    evaluate: (deps) => {
      // Script dependencies are a blocker for automation-native
      if (deps.scriptDependencies.length === 0) return null;
      return {
        level: 'yellow',
        category: 'deprecated-api',
        title: 'Cross-script dependencies — not supported in Automation',
        description:
          'Automation rules are self-contained. Scripts that require/import other scripts cannot be expressed as a single rule.',
        affectedExpression: deps.scriptDependencies.map((d) => d.importedPath).join(', '),
        lineNumber: deps.scriptDependencies[0]?.lineNumber ?? null,
        cloudAlternative: 'Consolidate logic into a single Forge function or ScriptRunner script.',
        requiresFieldMappingRegistry: false,
      };
    },
  },
];

// ─── Automation Suitability Analysis ─────────────────────────────────────────

/**
 * Map from TriggerEvent to Atlassian Cloud Automation trigger label.
 * Only events with direct Automation equivalents are included.
 */
const AUTOMATION_TRIGGER_MAP: Partial<Record<TriggerEvent, string>> = {
  'issue-created':      'Issue created',
  'issue-updated':      'Issue updated',
  'issue-transitioned': 'Issue transitioned',
  'comment-added':      'Comment created',
  'scheduled':          'Scheduled',
  'sprint-started':     'Sprint created',
};

/**
 * Groovy/SIL patterns that map to Automation actions/conditions.
 */
const MAPPABLE_OPERATION_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
  automationEquivalent: string;
}> = [
  { pattern: /issue\.setField|\.set\s*\(/i,                   label: 'Set field value',         automationEquivalent: 'Edit issue fields'              },
  { pattern: /addComment|issue\.comment/i,                     label: 'Add comment',             automationEquivalent: 'Add comment'                    },
  { pattern: /transitionIssue|performTransition/i,             label: 'Transition issue',        automationEquivalent: 'Transition issue'                },
  { pattern: /assignIssue|issue\.assignee/i,                   label: 'Assign issue',            automationEquivalent: 'Assign issue'                   },
  { pattern: /sendEmail|EmailUtils|\.sendMail/i,               label: 'Send email',              automationEquivalent: 'Send email'                     },
  { pattern: /createSubtask|issueService\.create/i,            label: 'Create subtask',          automationEquivalent: 'Create sub-task'                },
  { pattern: /JqlQueryBuilder|searchService\.search/i,         label: 'JQL lookup',              automationEquivalent: 'Lookup issues (JQL)'            },
  { pattern: /issue\.priority|setPriority/i,                   label: 'Set priority',            automationEquivalent: 'Edit issue fields → Priority'   },
  { pattern: /addWatcher|watcherManager/i,                     label: 'Add watcher',             automationEquivalent: 'Edit watchers'                  },
  { pattern: /addLabel|issue\.labels/i,                        label: 'Add/set label',           automationEquivalent: 'Edit issue fields → Labels'     },
];

const UNMAPPABLE_OPERATION_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  { pattern: /ComponentAccessor|IssueManager|UserManager/,  label: 'Server Java API (ComponentAccessor)' },
  { pattern: /java\.io\.File|new File\(/,                    label: 'Filesystem access'                   },
  { pattern: /groovy\.sql|ofBizDelegator/i,                  label: 'Direct SQL / OFBiz access'           },
  { pattern: /PluginAccessor|ModuleDescriptor/i,             label: 'Plugin API access'                   },
];

function detectAutomationOperations(
  rawContent: string,
): { mappable: AutomationOperation[]; unmappable: AutomationOperation[] } {
  const mappable: AutomationOperation[] = [];
  const unmappable: AutomationOperation[] = [];

  for (const { pattern, label, automationEquivalent } of MAPPABLE_OPERATION_PATTERNS) {
    const match = rawContent.match(pattern);
    if (match !== null) {
      mappable.push({
        label,
        sourceExpression: match[0] ?? label,
        automationEquivalent,
      });
    }
  }

  for (const { pattern, label } of UNMAPPABLE_OPERATION_PATTERNS) {
    const match = rawContent.match(pattern);
    if (match !== null) {
      unmappable.push({
        label,
        sourceExpression: match[0] ?? label,
        automationEquivalent: null,
      });
    }
  }

  return { mappable, unmappable };
}

/**
 * Determines whether a script is a viable automation-native migration candidate.
 *
 * Rules:
 *   - Trigger MUST have a direct Automation equivalent
 *   - Script complexity MUST be low or medium
 *   - No deprecated Server Java APIs
 *   - No filesystem/SQL access
 *   - No script dependencies (Automation rules are self-contained)
 *   - At least one mappable operation detected
 */
export function assessAutomationSuitability(
  deps: DependencyMap,
  ctx: AnalysisContext,
  rawScriptContent: string,
): AutomationSuitability {
  const mappedTrigger = AUTOMATION_TRIGGER_MAP[ctx.triggerEvent] ?? null;

  // Hard blockers
  const hasServerApis = deps.deprecatedApis.some(
    (a) => a.deprecationReason === 'server-only-java-api',
  );
  const hasFilesystem = deps.deprecatedApis.some(
    (a) => a.deprecationReason === 'filesystem-access',
  );
  const hasSql = deps.deprecatedApis.some(
    (a) => a.deprecationReason === 'direct-sql',
  );
  const hasScriptDeps = deps.scriptDependencies.length > 0;
  const complexity = resolveComplexity(deps, ctx.linesOfCode);
  const isComplexityBlocker = complexity === 'high' || complexity === 'critical';

  const { mappable, unmappable } = detectAutomationOperations(rawScriptContent);

  // Automation requires a known trigger
  if (mappedTrigger === null) {
    return {
      isSuitable: false,
      confidence: 'low',
      mappedTrigger: null,
      mappableOperations: mappable,
      unmappableOperations: unmappable,
      rationale: `Trigger event '${ctx.triggerEvent}' has no direct equivalent in Atlassian Cloud Automation. Consider Forge or ScriptRunner.`,
    };
  }

  if (hasServerApis || hasFilesystem || hasSql) {
    return {
      isSuitable: false,
      confidence: 'low',
      mappedTrigger,
      mappableOperations: mappable,
      unmappableOperations: unmappable,
      rationale: 'Script uses Server-only Java APIs, filesystem, or direct SQL access — incompatible with Automation rules.',
    };
  }

  if (hasScriptDeps) {
    return {
      isSuitable: false,
      confidence: 'low',
      mappedTrigger,
      mappableOperations: mappable,
      unmappableOperations: unmappable,
      rationale: 'Script has cross-script dependencies. Automation rules are self-contained and cannot reference other scripts.',
    };
  }

  if (isComplexityBlocker) {
    return {
      isSuitable: false,
      confidence: 'low',
      mappedTrigger,
      mappableOperations: mappable,
      unmappableOperations: unmappable,
      rationale: `Script complexity is '${complexity}'. Automation rules are best suited for low/medium complexity scripts.`,
    };
  }

  if (unmappable.length > 0) {
    return {
      isSuitable: false,
      confidence: 'medium',
      mappedTrigger,
      mappableOperations: mappable,
      unmappableOperations: unmappable,
      rationale: `Script trigger maps to Automation ('${mappedTrigger}') but contains ${unmappable.length} operation(s) not expressible in Automation rules.`,
    };
  }

  if (mappable.length === 0) {
    return {
      isSuitable: false,
      confidence: 'low',
      mappedTrigger,
      mappableOperations: [],
      unmappableOperations: [],
      rationale: 'No recognisable Automation-mappable operations detected in the script body.',
    };
  }

  // All checks passed — suitable!
  const confidence = unmappable.length === 0 && complexity === 'low' ? 'high' : 'medium';
  return {
    isSuitable: true,
    confidence,
    mappedTrigger,
    mappableOperations: mappable,
    unmappableOperations: unmappable,
    rationale: `Script trigger maps to Automation ('${mappedTrigger}') and all ${mappable.length} detected operation(s) have Automation equivalents. No blockers detected.`,
  };
}


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
  automationSuitability: AutomationSuitability | null,
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

  // Automation-native wins when confidence is high or medium with no blockers
  if (
    automationSuitability?.isSuitable === true &&
    (automationSuitability.confidence === 'high' ||
      automationSuitability.confidence === 'medium')
  ) {
    return 'automation-native';
  }

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
  rawScriptContent?: string,
): CloudReadinessReport {
  const complexity = resolveComplexity(deps, ctx.linesOfCode);

  // Run all rules and collect non-null issues
  const issues = RULES.map((rule) => rule.evaluate(deps, ctx)).filter(
    (issue): issue is CloudReadinessIssue => issue !== null,
  );

  // Assess automation-native suitability (requires raw content for pattern detection)
  const automationSuitability =
    rawScriptContent !== undefined && rawScriptContent.length > 0
      ? assessAutomationSuitability(deps, ctx, rawScriptContent)
      : null;

  const overallLevel = resolveOverallLevel(issues);
  const score = calculateScore(issues);
  const migrationTarget = resolveMigrationTarget(issues, ctx, automationSuitability);
  const effort = estimateEffort(complexity);

  return {
    overallLevel,
    score,
    issues,
    recommendedMigrationTarget: migrationTarget,
    estimatedEffortHours: effort,
    automationSuitability,
  };
}
