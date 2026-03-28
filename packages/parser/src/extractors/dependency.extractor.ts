/**
 * Dependency Extractor
 *
 * Deterministic, regex-based extraction of hardcoded dependencies.
 * NO LLM involved here — this must be 100% reproducible and testable.
 *
 * This is the most critical extractor in the pipeline: the Field Mapping
 * Registry UI is driven entirely by what this extractor finds.
 */

import type {
  CustomFieldRef,
  DependencyMap,
  DeprecatedApiUsage,
  ExternalHttpCall,
  GroupRef,
  InternalApiCall,
  ScriptDependency,
  UserRef,
} from '../types/parsed-script.types.js';

// ─── Extraction helpers ───────────────────────────────────────────────────────

interface RawMatch {
  readonly match: string;
  readonly lineNumber: number;
}

function extractWithLineNumbers(
  content: string,
  pattern: RegExp,
): ReadonlyArray<RawMatch> {
  const lines = content.split('\n');
  const results: RawMatch[] = [];

  // We need a global flag to iterate matches
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let m: RegExpExecArray | null;

    globalPattern.lastIndex = 0;
    while ((m = globalPattern.exec(line)) !== null) {
      results.push({ match: m[0], lineNumber: i + 1 });
    }
  }

  return results;
}

function dedupe<T extends { readonly rawExpression: string }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.rawExpression)) return false;
    seen.add(item.rawExpression);
    return true;
  });
}

// ─── Custom Field extractor ───────────────────────────────────────────────────

const CUSTOM_FIELD_PATTERNS = [
  // Groovy: cf.getCustomFieldObject("customfield_10048")
  /getCustomFieldObject\s*\(\s*["'](?<fieldId>customfield_\d+)["']\s*\)/,
  // Groovy: issue.setCustomFieldValue(cfField, ...)
  /["'](?<fieldId>customfield_\d+)["']/,
  // Generic: any direct customfield_ reference
  /\b(?<fieldId>customfield_\d{4,6})\b/,
] as const;

const CUSTOM_FIELD_WRITE_PATTERNS = [
  /setCustomFieldValue/,
  /setValue\s*\(/,
  /updateValue\s*\(/,
];

const CUSTOM_FIELD_READ_PATTERNS = [
  /getCustomFieldValue/,
  /getCustomFieldObject/,   // Fetching field definition is a read-type operation
  /getValue\s*\(/,
  /cf\.get\s*\(/,
];

const CUSTOM_FIELD_SEARCH_PATTERNS = [/in\s+JQL/i, /jqlQueryParser/];

export function extractCustomFields(
  content: string,
): ReadonlyArray<CustomFieldRef> {
  const found: CustomFieldRef[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';

    // Extract all customfield_XXXXX references in this line
    const fieldIdPattern = /\bcustomfield_(\d{4,6})\b/g;
    let match: RegExpExecArray | null;

    while ((match = fieldIdPattern.exec(line)) !== null) {
      const fieldId = `customfield_${match[1]}`;
      const rawExpression = match[0];

      // Determine usage type from surrounding context
      let usageType: CustomFieldRef['usageType'] = 'unknown';
      if (CUSTOM_FIELD_WRITE_PATTERNS.some((p) => p.test(line))) {
        usageType = 'write';
      } else if (CUSTOM_FIELD_READ_PATTERNS.some((p) => p.test(line))) {
        usageType = 'read';
      } else if (CUSTOM_FIELD_SEARCH_PATTERNS.some((p) => p.test(line))) {
        usageType = 'search';
      }

      found.push({
        fieldId,
        usageType,
        rawExpression,
        lineNumber: lineIdx + 1,
      });
    }
  }

  return dedupe(found);
}

// ─── Group reference extractor ────────────────────────────────────────────────

const GROUP_PATTERNS = [
  /groupManager\.getGroup\s*\(\s*["'](?<name>[^"']+)["']\s*\)/g,
  /GroupUtils\.getGroupByName\s*\(\s*["'](?<name>[^"']+)["']\s*\)/g,
  /getGroupByName\s*\(\s*["'](?<name>[^"']+)["']\s*\)/g,
  /inGroup\s*\(\s*["'](?<name>[^"']+)["']\s*\)/g,
  // SIL patterns
  /getUsersFromGroup\s*\(\s*["'](?<name>[^"']+)["']\s*\)/g,
  /isUserInGroup\s*\(\s*\w+\s*,\s*["'](?<name>[^"']+)["']\s*\)/g,
] as const;

export function extractGroups(content: string): ReadonlyArray<GroupRef> {
  const found: GroupRef[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';

    for (const pattern of GROUP_PATTERNS) {
      const p = new RegExp(pattern.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = p.exec(line)) !== null) {
        const groupName = m.groups?.['name'];
        if (groupName !== undefined && groupName.length > 0) {
          found.push({
            groupName,
            rawExpression: m[0],
            lineNumber: lineIdx + 1,
          });
        }
      }
    }
  }

  return dedupe(found);
}

// ─── User reference extractor (GDPR critical) ─────────────────────────────────

const USER_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  type: UserRef['identifierType'];
}> = [
  {
    pattern:
      /userManager\.getUserByName\s*\(\s*["'](?<id>[^"']+)["']\s*\)/g,
    type: 'username',
  },
  {
    pattern:
      /getUserByName\s*\(\s*["'](?<id>[^"']+)["']\s*\)/g,
    type: 'username',
  },
  {
    pattern:
      /getUser\s*\(\s*["'](?<id>[^"']+)["']\s*\)/g,
    type: 'username',
  },
  {
    pattern: /runAs\s*\(\s*["'](?<id>[^"']+)["']/g,
    type: 'username',
  },
  {
    pattern: /userKey\s*=\s*["'](?<id>[^"']+)["']/g,
    type: 'user-key',
  },
  {
    pattern:
      /assignee\s*=\s*["'](?<id>[a-z0-9._-]{2,30})["']/gi,
    type: 'username',
  },
];

export function extractUsers(content: string): ReadonlyArray<UserRef> {
  const found: UserRef[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';

    for (const { pattern, type } of USER_PATTERNS) {
      const p = new RegExp(pattern.source, 'gi');
      let m: RegExpExecArray | null;
      while ((m = p.exec(line)) !== null) {
        const identifier = m.groups?.['id'];
        if (identifier !== undefined && identifier.length > 0) {
          found.push({
            identifier,
            identifierType: type,
            rawExpression: m[0],
            lineNumber: lineIdx + 1,
          });
        }
      }
    }
  }

  return dedupe(found);
}

// ─── External HTTP call extractor ─────────────────────────────────────────────

const HTTP_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  method: ExternalHttpCall['method'];
}> = [
  { pattern: /Unirest\.get\s*\(\s*["'](?<url>[^"']+)["']/g, method: 'GET' },
  { pattern: /Unirest\.post\s*\(\s*["'](?<url>[^"']+)["']/g, method: 'POST' },
  { pattern: /Unirest\.put\s*\(\s*["'](?<url>[^"']+)["']/g, method: 'PUT' },
  {
    pattern: /Unirest\.delete\s*\(\s*["'](?<url>[^"']+)["']/g,
    method: 'DELETE',
  },
  // Java HttpClient / HttpRequest
  {
    pattern:
      /HttpRequest\.newBuilder\(\).*uri\(URI\.create\(["'](?<url>[^"']+)["']\)/gs,
    method: 'unknown',
  },
  // Generic URL references (dynamic)
  {
    pattern: /new\s+URL\s*\(\s*["'](?<url>https?:\/\/[^"']+)["']/g,
    method: 'unknown',
  },
  // SIL HTTP calls
  { pattern: /httpGet\s*\(\s*["'](?<url>[^"']+)["']/g, method: 'GET' },
  { pattern: /httpPost\s*\(\s*["'](?<url>[^"']+)["']/g, method: 'POST' },
];

export function extractExternalHttpCalls(
  content: string,
): ReadonlyArray<ExternalHttpCall> {
  const found: ExternalHttpCall[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';

    for (const { pattern, method } of HTTP_PATTERNS) {
      const p = new RegExp(pattern.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = p.exec(line)) !== null) {
        const url = m.groups?.['url'] ?? null;
        const isDynamic =
          url === null ||
          url.includes('${') ||
          url.includes('+') ||
          /\$\w+/.test(url);

        // Skip internal Jira REST calls — those go to extractInternalApiCalls
        if (url !== null && /\/rest\/api\//i.test(url)) continue;
        if (url !== null && /localhost|127\.0\.0\.1/.test(url)) continue;

        found.push({
          url,
          method,
          isDynamic,
          rawExpression: m[0].trim(),
          lineNumber: lineIdx + 1,
        });
      }
    }
  }

  return dedupe(found);
}

// ─── Internal Jira API call extractor ────────────────────────────────────────

const INTERNAL_API_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  version: InternalApiCall['apiVersion'];
  method: InternalApiCall['method'];
}> = [
  {
    pattern:
      /\/rest\/api\/3\/(?<endpoint>[\w/{}?=&]+)/g,
    version: '3',
    method: 'unknown',
  },
  {
    pattern:
      /\/rest\/api\/2\/(?<endpoint>[\w/{}?=&]+)/g,
    version: '2',
    method: 'unknown',
  },
  {
    pattern:
      /\/rest\/agile\/[\d.]+\/(?<endpoint>[\w/{}?=&]+)/g,
    version: 'agile',
    method: 'unknown',
  },
  {
    pattern:
      /\/rest\/servicedeskapi\/(?<endpoint>[\w/{}?=&]+)/g,
    version: 'servicedesk',
    method: 'unknown',
  },
];

// Method detection helpers
const METHOD_BEFORE_PATTERN =
  /(?:Unirest|httpClient)\.(get|post|put|delete|patch)\s*\(/gi;

export function extractInternalApiCalls(
  content: string,
): ReadonlyArray<InternalApiCall> {
  const found: InternalApiCall[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';

    for (const { pattern, version } of INTERNAL_API_PATTERNS) {
      const p = new RegExp(pattern.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = p.exec(line)) !== null) {
        const endpoint = m.groups?.['endpoint'] ?? m[0];

        // Try to detect HTTP method from the same line
        let method: InternalApiCall['method'] = 'unknown';
        const methodMatch = new RegExp(METHOD_BEFORE_PATTERN.source, 'gi').exec(
          line,
        );
        if (methodMatch?.[1] !== undefined) {
          method = methodMatch[1].toUpperCase() as InternalApiCall['method'];
        }

        found.push({
          endpoint: `/rest/api/${version}/${endpoint}`,
          apiVersion: version,
          method,
          rawExpression: m[0],
          lineNumber: lineIdx + 1,
        });
      }
    }
  }

  return dedupe(found);
}

// ─── Deprecated API extractor ─────────────────────────────────────────────────

interface DeprecatedApiDefinition {
  readonly pattern: RegExp;
  readonly apiClass: string;
  readonly deprecationReason: DeprecatedApiUsage['deprecationReason'];
  readonly cloudAlternative: string;
}

const DEPRECATED_API_DEFINITIONS: ReadonlyArray<DeprecatedApiDefinition> = [
  // ── Java Server-only APIs ───────────────────────────────────────────────
  {
    pattern: /ComponentAccessor\.\w+/g,
    apiClass: 'ComponentAccessor',
    deprecationReason: 'server-only-java-api',
    cloudAlternative:
      'Use @forge/api requestJira() or ScriptRunner Cloud REST calls',
  },
  {
    pattern: /IssueManager\b/g,
    apiClass: 'IssueManager',
    deprecationReason: 'server-only-java-api',
    cloudAlternative: 'REST API v3: GET /rest/api/3/issue/{issueIdOrKey}',
  },
  {
    pattern: /UserManager\b/g,
    apiClass: 'UserManager',
    deprecationReason: 'server-only-java-api',
    cloudAlternative: 'REST API v3: GET /rest/api/3/user?accountId={accountId}',
  },
  {
    pattern: /GroupManager\b/g,
    apiClass: 'GroupManager',
    deprecationReason: 'server-only-java-api',
    cloudAlternative: 'REST API v3: GET /rest/api/3/group/member',
  },
  {
    pattern: /CustomFieldManager\b/g,
    apiClass: 'CustomFieldManager',
    deprecationReason: 'server-only-java-api',
    cloudAlternative: 'REST API v3: GET /rest/api/3/field',
  },
  {
    pattern: /WorkflowManager\b/g,
    apiClass: 'WorkflowManager',
    deprecationReason: 'server-only-java-api',
    cloudAlternative: 'REST API v3: GET /rest/api/3/workflow/search',
  },
  {
    pattern: /ProjectManager\b/g,
    apiClass: 'ProjectManager',
    deprecationReason: 'server-only-java-api',
    cloudAlternative: 'REST API v3: GET /rest/api/3/project',
  },

  // ── Filesystem access ───────────────────────────────────────────────────
  {
    pattern: /new\s+File\s*\(/g,
    apiClass: 'java.io.File',
    deprecationReason: 'filesystem-access',
    cloudAlternative:
      'Use Atlassian Media API for file storage in Cloud. Forge has no filesystem.',
  },
  {
    pattern: /new\s+FileWriter\s*\(/g,
    apiClass: 'java.io.FileWriter',
    deprecationReason: 'filesystem-access',
    cloudAlternative: 'Atlassian Media API or Confluence attachment API',
  },
  {
    pattern: /Files\.write\s*\(/g,
    apiClass: 'java.nio.Files',
    deprecationReason: 'filesystem-access',
    cloudAlternative: 'Atlassian Media API',
  },

  // ── Direct SQL (OFBiz) ──────────────────────────────────────────────────
  {
    pattern: /EntityCondition\b/g,
    apiClass: 'OFBiz EntityCondition',
    deprecationReason: 'direct-sql',
    cloudAlternative:
      'Use Jira REST API for data access. No direct DB in Cloud.',
  },
  {
    pattern: /ofBizDelegator\b/g,
    apiClass: 'OfBizDelegator',
    deprecationReason: 'direct-sql',
    cloudAlternative: 'REST API v3 or Forge Storage API',
  },

  // ── GDPR — username/userKey usage ──────────────────────────────────────
  {
    pattern: /getUserByName\s*\(\s*["'][^"']+["']\s*\)/g,
    apiClass: 'getUserByName()',
    deprecationReason: 'username-usage',
    cloudAlternative:
      'Use accountId exclusively. Resolve via Atlassian User Migration API.',
  },
  {
    pattern: /\.getUsername\(\)/g,
    apiClass: 'ApplicationUser.getUsername()',
    deprecationReason: 'username-usage',
    cloudAlternative: 'Use user.accountId — username is deprecated in Cloud',
  },
  {
    pattern: /userKey\s*=\s*["'][^"']+["']/g,
    apiClass: 'userKey hardcoded',
    deprecationReason: 'username-usage',
    cloudAlternative: 'Replace userKey with accountId from User Migration API',
  },

  // ── REST API v2 deprecated endpoints ───────────────────────────────────
  {
    pattern: /\/rest\/api\/2\/user\?username=/g,
    apiClass: 'REST API v2 /user?username=',
    deprecationReason: 'deprecated-rest-v2',
    cloudAlternative:
      'GET /rest/api/3/user/search?accountId={accountId} or /user?accountId=',
  },
];

export function extractDeprecatedApis(
  content: string,
): ReadonlyArray<DeprecatedApiUsage> {
  const found: DeprecatedApiUsage[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';

    for (const def of DEPRECATED_API_DEFINITIONS) {
      const p = new RegExp(def.pattern.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = p.exec(line)) !== null) {
        found.push({
          apiClass: def.apiClass,
          methodCall: m[0],
          deprecationReason: def.deprecationReason,
          cloudAlternative: def.cloudAlternative,
          rawExpression: m[0],
          lineNumber: lineIdx + 1,
        });
      }
    }
  }

  return dedupe(found);
}

// ─── Script dependency extractor ─────────────────────────────────────────────

const SCRIPT_DEP_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  type: ScriptDependency['importType'];
}> = [
  {
    pattern: /require\s*\(\s*["'](?<path>[^"']+\.(?:sil|groovy|js))["']/gi,
    type: 'require',
  },
  {
    pattern: /include\s*["'](?<path>[^"']+\.sil)["']/gi,
    type: 'include',
  },
  {
    pattern:
      /^import\s+(?:static\s+)?(?<path>[\w.]+)\s*;?\s*$/gm,
    type: 'import',
  },
];

export function extractScriptDependencies(
  content: string,
): ReadonlyArray<ScriptDependency> {
  const found: ScriptDependency[] = [];
  const lines = content.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';

    for (const { pattern, type } of SCRIPT_DEP_PATTERNS) {
      const p = new RegExp(pattern.source, 'gi');
      let m: RegExpExecArray | null;
      while ((m = p.exec(line)) !== null) {
        const importedPath = m.groups?.['path'];
        if (importedPath !== undefined) {
          found.push({
            importedPath,
            importType: type,
            rawExpression: m[0].trim(),
            lineNumber: lineIdx + 1,
          });
        }
      }
    }
  }

  return dedupe(found);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export function extractDependencies(content: string): DependencyMap {
  return {
    customFields: extractCustomFields(content),
    groups: extractGroups(content),
    users: extractUsers(content),
    externalHttpCalls: extractExternalHttpCalls(content),
    internalApiCalls: extractInternalApiCalls(content),
    deprecatedApis: extractDeprecatedApis(content),
    scriptDependencies: extractScriptDependencies(content),
  };
}
