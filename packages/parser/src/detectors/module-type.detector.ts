/**
 * Module Type Detector
 *
 * Identifies the Atlassian module type (post-function, validator, listener, etc.)
 * from code patterns. This drives the migration strategy selection downstream.
 */

import type {
  AtlassianModuleType,
  TriggerEvent,
} from '../types/parsed-script.types.js';

interface ModuleSignature {
  readonly patterns: ReadonlyArray<RegExp>;
  readonly weight: number;
}

const MODULE_SIGNATURES: Record<
  Exclude<AtlassianModuleType, 'unknown'>,
  ModuleSignature
> = {
  'post-function': {
    patterns: [
      /postFunction/i,
      /AbstractJiraFunctionProvider/,
      /WorkflowFunction/,
      /FunctionProvider/,
      /transitionIssue/i,
      /issue\.store\(\)/,                 // Groovy SR post-function pattern
      /issue\.setStatus/,
    ],
    weight: 10,
  },
  validator: {
    patterns: [
      /\bvalidat/i,
      /AbstractWorkflowValidator/,
      /WorkflowValidator/,
      /addError/,
      /invalidInput/,
      /ValidationException/,
      /return\s+false.*invalid/i,
      // SIL-specific: validator returns a boolean to block/allow a transition
      /\/\/\s*[Bb]lock\s+transition/,
      /\/\/\s*[Vv]alidat/,
      /^\s*return\s+false;\s*$/m,
      /^\s*return\s+true;\s*$/m,
    ],
    weight: 10,
  },
  condition: {
    patterns: [
      /\bCondition\b/,
      /AbstractWorkflowCondition/,
      /WorkflowCondition/,
      /passesCondition/,
      /return\s+(true|false)\s*$/m,       // Condition scripts return boolean
    ],
    weight: 8,
  },
  listener: {
    patterns: [
      /IssueEvent/,
      /AbstractIssueEventListener/,
      /\bevent\.getIssue\(\)/,
      /\bonEvent\(/,
      /JiraIssueEvent/,
      /EventPublisher/,
      /\blistener\b/i,
    ],
    weight: 10,
  },
  'jql-function': {
    patterns: [
      /AbstractJqlFunction/,
      /JqlFunction/,
      /getValues\(/,
      /getFunctionName\(/,
      /operand.*query/i,
    ],
    weight: 10,
  },
  'script-console': {
    patterns: [
      /log\.info\(/,
      /println\s/,
      /System\.out\.println/,
      /\bconsole\b/i,
    ],
    weight: 3,  // Low weight — many scripts log, this is a weak signal
  },
  'scheduled-job': {
    patterns: [
      /ScheduledService/,
      /\bcron\b/i,
      /JobDetail/,
      /Scheduler/,
      /\bschedule\b/i,
      /runAs\s*\(\s*"[\w.]+"\s*,/,       // SIL scheduled pattern
    ],
    weight: 10,
  },
  'rest-endpoint': {
    patterns: [
      /@GET\b/,
      /@POST\b/,
      /@PUT\b/,
      /@DELETE\b/,
      /\bRESTEndpoint\b/,
      /CORSRequestBuilder/,
      /Response\.ok\(/,
    ],
    weight: 10,
  },
  'web-panel': {
    patterns: [
      /velocity/i,
      /VelocityParamFactory/,
      /WebPanel/,
      /#\s*\w+.*velocity/i,              // Velocity template directives
      /#set\s*\(/,                        // Velocity #set directive
      /#foreach\s*\(/,                    // Velocity #foreach
    ],
    weight: 10,
  },
  'web-resource': {
    patterns: [
      /WebResourceManager/,
      /requireResource/i,
      /pluginResourceLocator/i,
    ],
    weight: 8,
  },
  'workflow-function': {
    patterns: [
      /WorkflowScheme/,
      /ActionDescriptor/,
      /StepDescriptor/,
      /JiraWorkflow/,
      /workflow.*transition/i,
    ],
    weight: 9,
  },
  'connect-descriptor': {
    patterns: [
      /atlassian-plugin\.xml/i,
      /<atlassian-plugin\b/,
      /<workflow-function\b/,
      /<web-panel\b/,
      /<rest\b/,
      /connectDescriptor/i,
    ],
    weight: 10,
  },
  'inline-script': {
    patterns: [
      /inline.*script/i,
      /getFieldValue\s*\(\s*"[\w-]+"\s*\)/,  // SIL inline patterns
      /setFieldValue\s*\(\s*"[\w-]+"/,
    ],
    weight: 5,
  },
  'field-function': {
    patterns: [
      /getFieldValue\s*\(/,
      /setFieldValue\s*\(/,
      /getCustomField\s*\(/,
      /FieldFunction/,
      /AbstractCustomFieldType/,
    ],
    weight: 8,
  },

  // ── SIL (Power Scripts / cPrime/Appfire) specific ──────────────────────

  'live-field': {
    // 🔴 Live Fields manipulate the Jira DOM in real time.
    // Functions start with 'lf' (Live Field prefix — Power Scripts convention).
    // ALWAYS a red blocker — Cloud forbids DOM manipulation.
    patterns: [
      /\blfHide\s*\(/,
      /\blfShow\s*\(/,
      /\blfDisable\s*\(/,
      /\blfEnable\s*\(/,
      /\blfWatch\s*\(/,
      /\blfRestrictSelect\s*\(/,
      /\blfSetValue\s*\(/,
      /\blfGetValue\s*\(/,
      /\blf[A-Z]\w+\s*\(/,              // Any lf* function (Live Field family)
    ],
    weight: 15,  // Highest weight — unambiguous SIL Live Field signal
  },

  'scripted-field': {
    // 🟡 Calculated fields: compute a value at read-time, no write side-effects.
    // In Cloud, must be rewritten as event-driven field updates via webhook.
    patterns: [
      /\/\/ Scripted [Ff]ield/,
      /\/\/ Calculated [Ff]ield/,
      /return\s+\w+.*;\/\/\s*field value/i,
      /getFieldValue.*return/i,              // Reads multiple fields and returns
      /\/\*.*scripted.*field.*\*\//i,
    ],
    weight: 9,
  },

  'mail-handler': {
    // SIL Incoming Mail Handler: processes inbound email to create/update issues
    patterns: [
      /\bmailMessage\b/i,
      /\bgetEmailSubject\s*\(/,
      /\bgetEmailBody\s*\(/,
      /\bgetEmailFrom\s*\(/,
      /\bgetEmailAttachments\s*\(/,
      /\bIncomingMailHandler\b/,
      /\bemailMessage\.get/i,
      /\/\/ Mail [Hh]andler/,
      /\/\/ Incoming [Mm]ail/,
    ],
    weight: 12,
  },

  'sil-rest-endpoint': {
    // SIL exposes a custom REST URL. Must be rewritten as Forge webtrigger.
    patterns: [
      /\bRESTEndpoint\b/,
      /\brestResponse\b/i,
      /\brestRequest\b/i,
      /\bgetRestParam\s*\(/,
      /\bgetRequestBody\s*\(/,
      /\/\/\s*REST [Ee]ndpoint/,
      /\/rest\/sil\//i,
    ],
    weight: 12,
  },

  'jql-alias': {
    // SIL custom JQL function. Must be rewritten as Forge JQL function module.
    patterns: [
      /\bJQLAlias\b/,
      /\bjqlAlias\b/,
      /\bgetJQLResults\s*\(/,
      /\bcreateJQLAlias\s*\(/,
      /\/\/ JQL [Aa]lias/,
      /\/\/ Custom JQL/,
      /\bregisterJQL\s*\(/,
    ],
    weight: 12,
  },

  // ── ScriptRunner (Adaptavist / Groovy) specific ──────────────────────

  'behaviour': {
    // 🔴 SR Behaviours: manipulate form fields in the browser via server-side Groovy.
    // DOM manipulation is forbidden in Atlassian Cloud.
    // Signals: Behaviours-specific API methods starting with get/set on field objects.
    patterns: [
      /\bgetFieldById\s*\(/,
      /\.setHidden\s*\(/,
      /\.setReadOnly\s*\(/,
      /\.setRequired\s*\(/,
      /\.setError\s*\(/,
      /\.clearError\s*\(/,
      /\.setFormValue\s*\(/,
      /\.getFormValue\s*\(/,
      /\.setAllowedValues\s*\(/,       // SR dropdown filtering
      /com\.onresolve\.jira\.groovy\.behaviours/,
      /BehavioursService/,
      /\/\/ Behaviour/i,
      /\bBehaviour\b/,
    ],
    weight: 15,  // Highest — unambiguous SR Behaviour signal
  },

  'script-fragment': {
    // 🔴 SR Script Fragments: inject HTML/Velocity panels into Jira UI.
    // Velocity templates and direct HTML injection are forbidden in Cloud.
    patterns: [
      /WebItemModuleDescriptor/,
      /WebPanelModuleDescriptor/,
      /\.vm['"]\s*$/m,                  // Velocity template file extension
      /VelocityTemplatingEngine/,
      /velocity\.getTemplate\s*\(/,
      /\bwebResourceManager\b/,
      /<\?xml.*web-item/i,
      /\bFragmentCondition\b/,
      /com\.atlassian\.plugin\.web/,
      /\/\/ Script [Ff]ragment/,
      /\bscriptFragment\b/i,
    ],
    weight: 12,
  },

  'escalation-service': {
    // 🟡 SR Scheduled Escalation Service: bulk JQL iteration + field updates.
    // Timeout risk in Cloud (25s Forge limit). Must paginate + batch.
    patterns: [
      /ScheduledJobService/,
      /EscalationService/,
      /escalationService/,
      /\.search\s*\([^)]*jql/i,         // JQL search in scheduled context
      /searchService\.searchOverrideSecurity/,
      /com\.onresolve\.scriptrunner\.jobs/,
      /\/\/ Escalation/i,
      /\/\/ Scheduled [Ee]scalation/,
      /getIssueManager.*scheduled/i,
    ],
    weight: 11,
  },
};

const TRIGGER_SIGNATURES: Record<
  Exclude<TriggerEvent, 'unknown'>,
  ReadonlyArray<RegExp>
> = {
  'issue-created': [
    /issue.*creat/i,
    /IssueCreated/,
    /EVENT_TYPE_ID_ISSUE_CREATED/,
    /onIssueCreated/i,
  ],
  'issue-updated': [
    /issue.*updat/i,
    /IssueUpdated/,
    /EVENT_TYPE_ID_ISSUE_UPDATED/,
    /onIssueUpdated/i,
  ],
  'issue-transitioned': [
    /transition/i,
    /workflowAction/i,
    /IssueTransitioned/,
    /postFunction/i,
  ],
  'comment-added': [
    /comment.*add/i,
    /IssueCommented/,
    /CommentCreated/,
    /onCommentAdded/i,
  ],
  'sprint-started': [
    /sprint.*start/i,
    /SprintStarted/,
    /onSprintStarted/i,
  ],
  scheduled: [
    /cron/i,
    /schedule/i,
    /ScheduledService/,
    /JobDetail/,
  ],
  manual: [
    /manual/i,
    /userTriggered/i,
    /onClick/i,
  ],
};

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ModuleTypeDetectionResult {
  readonly moduleType: AtlassianModuleType;
  readonly triggerEvent: TriggerEvent;
  readonly moduleConfidence: number;   // 0-1
  readonly triggerConfidence: number;  // 0-1
}

export function detectModuleType(content: string): ModuleTypeDetectionResult {
  const moduleScores = (
    Object.entries(MODULE_SIGNATURES) as Array<
      [Exclude<AtlassianModuleType, 'unknown'>, ModuleSignature]
    >
  ).map(([type, sig]) => {
    const hits = sig.patterns.filter((p) => p.test(content)).length;
    // Diminishing returns: first 2 hits count fully, additional hits add 30% each.
    // Prevents accumulation-heavy types (field-function) from drowning
    // semantically strong single-hit types (validator with 'return false').
    const diminished = hits === 0 ? 0 : sig.weight * Math.min(3, 1 + (hits - 1) * 0.3);
    return { type, score: Math.round(diminished * 10) / 10 };
  });

  moduleScores.sort((a, b) => b.score - a.score);
  const topModule = moduleScores[0];

  const triggerScores = (
    Object.entries(TRIGGER_SIGNATURES) as Array<
      [Exclude<TriggerEvent, 'unknown'>, ReadonlyArray<RegExp>]
    >
  ).map(([event, patterns]) => {
    const hits = patterns.filter((p) => p.test(content)).length;
    return { event, score: hits };
  });

  triggerScores.sort((a, b) => b.score - a.score);
  const topTrigger = triggerScores[0];

  const maxModuleScore =
    moduleScores.reduce((max, s) => Math.max(max, s.score), 0) || 1;
  const maxTriggerScore =
    triggerScores.reduce((max, s) => Math.max(max, s.score), 0) || 1;

  return {
    moduleType:
      topModule !== undefined && topModule.score > 0
        ? topModule.type
        : 'unknown',
    triggerEvent:
      topTrigger !== undefined && topTrigger.score > 0
        ? topTrigger.event
        : 'unknown',
    moduleConfidence:
      topModule !== undefined
        ? Math.min(1, topModule.score / maxModuleScore)
        : 0,
    triggerConfidence:
      topTrigger !== undefined
        ? Math.min(1, topTrigger.score / maxTriggerScore)
        : 0,
  };
}
