/**
 * Placeholder Resolver
 *
 * Replaces all ATLAS_*() placeholders in generated code with the
 * actual Cloud values from the completed RegistrySession.
 *
 * Placeholders injected by S4 Generator:
 *   ATLAS_FIELD_ID("customfield_10048")  → "customfield_10201"
 *   ATLAS_ACCOUNT_ID("jsmith")           → "5e2a1234abcd5678ef901234"
 *   ATLAS_GROUP_ID("jira-finance-team")  → "5f3b2345bcde6789fg012345"
 *
 * SAFETY:
 *   - Only replaces mappings with status === 'mapped' or 'auto-mapped'
 *   - Skipped mappings get a comment: /* SKIPPED: jsmith → remove reference * /
 *   - Unmapped placeholders are left intact + logged as unresolvedPlaceholders
 *   - The resolver is PURE — it does not mutate the session or the store
 */

import type {
  CustomFieldMapping,
  GroupMapping,
  PlaceholderResolutionResult,
  RegistrySession,
  UserMapping,
} from '../types/registry.types.js';

// ─── Placeholder patterns ─────────────────────────────────────────────────────

const FIELD_ID_PATTERN =
  /ATLAS_FIELD_ID\s*\(\s*["'](?<id>customfield_\d{4,6})["']\s*\)/g;

const ACCOUNT_ID_PATTERN =
  /ATLAS_ACCOUNT_ID\s*\(\s*["'](?<id>[^"']+)["']\s*\)/g;

const GROUP_ID_PATTERN =
  /ATLAS_GROUP_ID\s*\(\s*["'](?<id>[^"']+)["']\s*\)/g;

// ─── Resolution helpers ───────────────────────────────────────────────────────

function resolveFieldPlaceholders(
  code: string,
  fields: ReadonlyArray<CustomFieldMapping>,
  unresolved: string[],
): string {
  const fieldMap = new Map<string, CustomFieldMapping>(
    fields.map((f) => [f.serverFieldId, f]),
  );

  return code.replace(FIELD_ID_PATTERN, (match, id: string) => {
    const mapping = fieldMap.get(id);

    if (mapping === undefined) {
      unresolved.push(match);
      return match;
    }

    if (mapping.status === 'skipped') {
      return `/* FIELD SKIPPED: ${id} — ${mapping.notes ?? 'not needed in Cloud'} */ ""`;
    }

    if (
      (mapping.status === 'mapped' || mapping.status === 'auto-mapped') &&
      mapping.cloudFieldId !== null
    ) {
      return `"${mapping.cloudFieldId}"`;
    }

    unresolved.push(match);
    return match;
  });
}

function resolveUserPlaceholders(
  code: string,
  users: ReadonlyArray<UserMapping>,
  unresolved: string[],
): string {
  const userMap = new Map<string, UserMapping>(
    users.map((u) => [u.serverIdentifier, u]),
  );

  return code.replace(ACCOUNT_ID_PATTERN, (match, id: string) => {
    const mapping = userMap.get(id);

    if (mapping === undefined) {
      unresolved.push(match);
      return match;
    }

    if (mapping.status === 'skipped' || mapping.resolutionStrategy === 'remove') {
      return `/* USER REMOVED: ${id} — ${mapping.notes ?? 'not needed in Cloud'} */ null`;
    }

    if (
      (mapping.status === 'mapped' || mapping.status === 'auto-mapped') &&
      mapping.cloudAccountId !== null
    ) {
      return `"${mapping.cloudAccountId}"`;
    }

    unresolved.push(match);
    return match;
  });
}

function resolveGroupPlaceholders(
  code: string,
  groups: ReadonlyArray<GroupMapping>,
  unresolved: string[],
): string {
  const groupMap = new Map<string, GroupMapping>(
    groups.map((g) => [g.serverGroupName, g]),
  );

  return code.replace(GROUP_ID_PATTERN, (match, id: string) => {
    const mapping = groupMap.get(id);

    if (mapping === undefined) {
      unresolved.push(match);
      return match;
    }

    if (mapping.status === 'skipped') {
      return `/* GROUP SKIPPED: ${id} — ${mapping.notes ?? 'not needed in Cloud'} */ ""`;
    }

    if (
      (mapping.status === 'mapped' || mapping.status === 'auto-mapped') &&
      mapping.cloudGroupId !== null
    ) {
      return `"${mapping.cloudGroupId}"`;
    }

    unresolved.push(match);
    return match;
  });
}

// ─── Count total placeholders in code ────────────────────────────────────────

function countPlaceholders(code: string): number {
  const fieldMatches = [...code.matchAll(new RegExp(FIELD_ID_PATTERN.source, 'g'))];
  const userMatches = [...code.matchAll(new RegExp(ACCOUNT_ID_PATTERN.source, 'g'))];
  const groupMatches = [...code.matchAll(new RegExp(GROUP_ID_PATTERN.source, 'g'))];
  return fieldMatches.length + userMatches.length + groupMatches.length;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolves all ATLAS_*() placeholders in a single code string.
 */
export function resolvePlaceholders(
  code: string,
  session: RegistrySession,
): PlaceholderResolutionResult {
  const totalPlaceholders = countPlaceholders(code);
  const unresolvedPlaceholders: string[] = [];

  let resolved = code;
  resolved = resolveFieldPlaceholders(resolved, session.customFields, unresolvedPlaceholders);
  resolved = resolveUserPlaceholders(resolved, session.users, unresolvedPlaceholders);
  resolved = resolveGroupPlaceholders(resolved, session.groups, unresolvedPlaceholders);

  const unresolved = unresolvedPlaceholders.length;

  return {
    resolvedCode: resolved,
    totalPlaceholders,
    resolved: totalPlaceholders - unresolved,
    unresolved,
    unresolvedPlaceholders: [...new Set(unresolvedPlaceholders)],
  };
}

/**
 * Resolves placeholders across multiple generated files.
 * Returns the patched files alongside resolution stats.
 */
export function resolveAllFiles(
  files: ReadonlyArray<{ filename: string; content: string }>,
  session: RegistrySession,
): {
  patchedFiles: ReadonlyArray<{ filename: string; content: string }>;
  totalResolved: number;
  totalUnresolved: number;
  unresolvedByFile: Record<string, string[]>;
} {
  let totalResolved = 0;
  let totalUnresolved = 0;
  const unresolvedByFile: Record<string, string[]> = {};
  const patchedFiles: Array<{ filename: string; content: string }> = [];

  for (const file of files) {
    const result = resolvePlaceholders(file.content, session);
    patchedFiles.push({ filename: file.filename, content: result.resolvedCode });
    totalResolved += result.resolved;
    totalUnresolved += result.unresolved;
    if (result.unresolvedPlaceholders.length > 0) {
      unresolvedByFile[file.filename] = [...result.unresolvedPlaceholders];
    }
  }

  return { patchedFiles, totalResolved, totalUnresolved, unresolvedByFile };
}
