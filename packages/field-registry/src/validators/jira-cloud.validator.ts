/**
 * Jira Cloud Validator
 *
 * Validates mapping entries against the actual Jira Cloud instance
 * via REST API v3. Called when the user provides a Cloud value in the UI.
 *
 * DESIGN:
 * - Validation is OPTIONAL but strongly recommended before code generation
 * - The registry is usable with unvalidated mappings (user takes responsibility)
 * - A validated mapping gets a validatedAt timestamp and status 'mapped'
 * - An invalid mapping gets status 'unmapped' with an error message
 *
 * AUTH:
 * - Uses Atlassian OAuth 2.0 access token (provided by the user at job start)
 * - The token is NEVER stored — passed per-request only
 * - Cloud URL is per-tenant: https://{tenant}.atlassian.net
 *
 * RATE LIMITING:
 * - Atlassian REST API: 10 req/sec per OAuth token
 * - We batch validation calls with 150ms delay between requests
 */

import type {
  JiraCloudField,
  JiraCloudGroup,
  JiraCloudUser,
} from '../types/registry.types.js';

export interface ValidatorConfig {
  readonly cloudBaseUrl: string;    // e.g. "https://mycompany.atlassian.net"
  readonly accessToken: string;     // OAuth 2.0 Bearer token
  readonly requestDelayMs?: number; // Default: 150ms — rate limit safety
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function jiraGet<T>(
  baseUrl: string,
  token: string,
  path: string,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new JiraValidationError(
      `Jira API error ${response.status} for ${path}`,
      response.status,
    );
  }

  return response.json() as Promise<T>;
}

// ─── Field validation ─────────────────────────────────────────────────────────

export interface FieldValidationResult {
  readonly fieldId: string;
  readonly valid: boolean;
  readonly fieldName: string | null;
  readonly fieldType: string | null;
  readonly error: string | null;
}

/**
 * Validates a Cloud customfield ID by checking GET /rest/api/3/field.
 * Returns null fieldName if the field doesn't exist.
 */
export async function validateCloudField(
  cloudFieldId: string,
  config: ValidatorConfig,
): Promise<FieldValidationResult> {
  try {
    // Jira doesn't have a single-field endpoint — we fetch all and filter
    // This response is cached by Jira and typically fast (~50ms)
    const fields = await jiraGet<JiraCloudField[]>(
      config.cloudBaseUrl,
      config.accessToken,
      '/rest/api/3/field',
    );

    const field = fields.find((f) => f.id === cloudFieldId);

    if (field === undefined) {
      return {
        fieldId: cloudFieldId,
        valid: false,
        fieldName: null,
        fieldType: null,
        error: `Field "${cloudFieldId}" not found in Cloud instance`,
      };
    }

    return {
      fieldId: cloudFieldId,
      valid: true,
      fieldName: field.name,
      fieldType: field.schema?.custom ?? null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      fieldId: cloudFieldId,
      valid: false,
      fieldName: null,
      fieldType: null,
      error: message,
    };
  }
}

// ─── Group validation ─────────────────────────────────────────────────────────

export interface GroupValidationResult {
  readonly groupId: string;
  readonly valid: boolean;
  readonly groupName: string | null;
  readonly error: string | null;
}

export async function validateCloudGroup(
  cloudGroupId: string,
  config: ValidatorConfig,
): Promise<GroupValidationResult> {
  try {
    const response = await jiraGet<{ values: JiraCloudGroup[] }>(
      config.cloudBaseUrl,
      config.accessToken,
      `/rest/api/3/group?groupId=${encodeURIComponent(cloudGroupId)}&maxResults=1`,
    );

    const group = response.values[0];

    if (group === undefined) {
      return {
        groupId: cloudGroupId,
        valid: false,
        groupName: null,
        error: `Group "${cloudGroupId}" not found in Cloud instance`,
      };
    }

    return {
      groupId: cloudGroupId,
      valid: true,
      groupName: group.name,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      groupId: cloudGroupId,
      valid: false,
      groupName: null,
      error: message,
    };
  }
}

// ─── User / accountId validation ──────────────────────────────────────────────

export interface UserValidationResult {
  readonly accountId: string;
  readonly valid: boolean;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly active: boolean | null;
  readonly error: string | null;
}

export async function validateCloudAccountId(
  accountId: string,
  config: ValidatorConfig,
): Promise<UserValidationResult> {
  try {
    const user = await jiraGet<JiraCloudUser>(
      config.cloudBaseUrl,
      config.accessToken,
      `/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`,
    );

    return {
      accountId,
      valid: true,
      displayName: user.displayName,
      email: user.emailAddress,
      active: user.active,
      error: null,
    };
  } catch (err) {
    if (err instanceof JiraValidationError && err.statusCode === 404) {
      return {
        accountId,
        valid: false,
        displayName: null,
        email: null,
        active: null,
        error: `accountId "${accountId}" not found in Cloud instance`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      accountId,
      valid: false,
      displayName: null,
      email: null,
      active: null,
      error: message,
    };
  }
}

// ─── Auto-mapper: find Cloud field by name match ──────────────────────────────

export interface AutoMapResult {
  readonly serverFieldId: string;
  readonly serverFieldName: string | null;
  readonly cloudFieldId: string | null;
  readonly cloudFieldName: string | null;
  readonly confidence: 'exact' | 'fuzzy' | 'none';
}

/**
 * Attempts to auto-map a Server field to a Cloud field by name similarity.
 * Used when the user hasn't provided an explicit mapping.
 *
 * Exact match: same field name (case-insensitive) → confidence 'exact'
 * Fuzzy match: name contains the server name → confidence 'fuzzy'
 * No match: → confidence 'none', cloudFieldId null
 */
export async function autoMapFieldByName(
  serverFieldId: string,
  serverFieldName: string,
  config: ValidatorConfig,
): Promise<AutoMapResult> {
  try {
    const allFields = await jiraGet<JiraCloudField[]>(
      config.cloudBaseUrl,
      config.accessToken,
      '/rest/api/3/field',
    );

    // Only consider custom fields
    const customFields = allFields.filter((f) => f.id.startsWith('customfield_'));

    const normalizedServer = serverFieldName.toLowerCase().trim();

    // Exact match first
    const exactMatch = customFields.find(
      (f) => f.name.toLowerCase().trim() === normalizedServer,
    );

    if (exactMatch !== undefined) {
      return {
        serverFieldId,
        serverFieldName,
        cloudFieldId: exactMatch.id,
        cloudFieldName: exactMatch.name,
        confidence: 'exact',
      };
    }

    // Fuzzy: cloud field name contains server name or vice versa
    const fuzzyMatch = customFields.find(
      (f) =>
        f.name.toLowerCase().includes(normalizedServer) ||
        normalizedServer.includes(f.name.toLowerCase()),
    );

    if (fuzzyMatch !== undefined) {
      return {
        serverFieldId,
        serverFieldName,
        cloudFieldId: fuzzyMatch.id,
        cloudFieldName: fuzzyMatch.name,
        confidence: 'fuzzy',
      };
    }

    return {
      serverFieldId,
      serverFieldName,
      cloudFieldId: null,
      cloudFieldName: null,
      confidence: 'none',
    };
  } catch {
    return {
      serverFieldId,
      serverFieldName,
      cloudFieldId: null,
      cloudFieldName: null,
      confidence: 'none',
    };
  }
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class JiraValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'JiraValidationError';
  }
}
