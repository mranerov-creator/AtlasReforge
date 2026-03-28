/**
 * Registry Service
 *
 * Orchestrates the full Field Mapping Registry lifecycle:
 *
 *   1. buildSession()     — creates a new session from ParsedScript dependencies
 *   2. updateField()      — user maps a Server customfield → Cloud customfield
 *   3. updateGroup()      — user maps a Server group → Cloud group ID
 *   4. updateUser()       — user maps a username → accountId
 *   5. skipMapping()      — user marks a mapping as "not needed in Cloud"
 *   6. validateAll()      — validates all mapped values against Jira Cloud API
 *   7. getCompletion()    — returns blockers preventing code generation
 *   8. resolveCode()      — replaces ATLAS_*() placeholders in generated files
 *   9. exportSession()    — exports session as JSON (for user to save + reuse)
 *  10. importSession()    — imports a previously exported session
 */

import { randomUUID } from 'node:crypto';
import {
  resolveAllFiles,
  resolvePlaceholders,
} from './resolvers/placeholder.resolver.js';
import type { RegistryStore } from './store/registry.store.js';
import type {
  BuildSessionInput,
  CompletionBlocker,
  CustomFieldMapping,
  GroupMapping,
  MappingStatus,
  PlaceholderResolutionResult,
  RegistrySession,
  SkipMappingInput,
  UpdateCustomFieldInput,
  UpdateGroupInput,
  UpdateUserInput,
  UserMapping,
} from './types/registry.types.js';
import type {
  ValidatorConfig,
} from './validators/jira-cloud.validator.js';
import {
  validateCloudAccountId,
  validateCloudField,
  validateCloudGroup,
} from './validators/jira-cloud.validator.js';

// ─── Session TTL ──────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Registry Service ─────────────────────────────────────────────────────────

export class RegistryService {
  constructor(private readonly store: RegistryStore) {}

  // ─── 1. Build session ────────────────────────────────────────────────────

  async buildSession(input: BuildSessionInput): Promise<RegistrySession> {
    const now = new Date();
    const sessionId = input.jobId;

    const customFields: CustomFieldMapping[] = [
      ...new Map(
        input.customFieldRefs.map((ref) => [ref.fieldId, ref]),
      ).values(),
    ].map((ref) => ({
      serverFieldId: ref.fieldId,
      serverFieldName: null,
      cloudFieldId: null,
      cloudFieldName: null,
      fieldType: null,
      probableBusinessPurpose: ref.probableBusinessPurpose ?? 'Unknown',
      usageType: ref.usageType,
      status: 'unmapped' as MappingStatus,
      validatedAt: null,
      notes: null,
    }));

    const groups: GroupMapping[] = [
      ...new Map(
        input.groupRefs.map((ref) => [ref.groupName, ref]),
      ).values(),
    ].map((ref) => ({
      serverGroupName: ref.groupName,
      cloudGroupId: null,
      cloudGroupName: null,
      probableRole: ref.probableRole ?? 'Unknown role',
      status: 'unmapped' as MappingStatus,
      validatedAt: null,
      notes: null,
    }));

    const users: UserMapping[] = [
      ...new Map(
        input.userRefs.map((ref) => [ref.identifier, ref]),
      ).values(),
    ].map((ref) => ({
      serverIdentifier: ref.identifier,
      identifierType: ref.identifierType,
      cloudAccountId: null,
      cloudDisplayName: null,
      cloudEmail: null,
      gdprRisk: ref.gdprRisk ?? 'high',
      resolutionStrategy: 'pending' as const,
      status: 'unmapped' as MappingStatus,
      validatedAt: null,
      notes: null,
    }));

    const session: RegistrySession = {
      sessionId,
      jobId: input.jobId,
      originalFilename: input.originalFilename,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      customFields,
      groups,
      users,
      isComplete: customFields.length === 0 && groups.length === 0 && users.length === 0,
      completionBlockers: [],
    };

    await this.store.set(this.withCompletion(session));
    return this.withCompletion(session);
  }

  // ─── 2. Update custom field ──────────────────────────────────────────────

  async updateField(
    sessionId: string,
    input: UpdateCustomFieldInput,
  ): Promise<RegistrySession> {
    const session = await this.requireSession(sessionId);

    const updated = session.customFields.map((cf) =>
      cf.serverFieldId === input.serverFieldId
        ? {
            ...cf,
            cloudFieldId: input.cloudFieldId,
            cloudFieldName: input.cloudFieldName ?? null,
            status: 'mapped' as MappingStatus,
            validatedAt: null, // Reset — needs re-validation
            notes: input.notes ?? cf.notes,
          }
        : cf,
    );

    return this.save({ ...session, customFields: updated });
  }

  // ─── 3. Update group ─────────────────────────────────────────────────────

  async updateGroup(
    sessionId: string,
    input: UpdateGroupInput,
  ): Promise<RegistrySession> {
    const session = await this.requireSession(sessionId);

    const updated = session.groups.map((g) =>
      g.serverGroupName === input.serverGroupName
        ? {
            ...g,
            cloudGroupId: input.cloudGroupId,
            cloudGroupName: input.cloudGroupName ?? null,
            status: 'mapped' as MappingStatus,
            validatedAt: null,
            notes: input.notes ?? g.notes,
          }
        : g,
    );

    return this.save({ ...session, groups: updated });
  }

  // ─── 4. Update user ──────────────────────────────────────────────────────

  async updateUser(
    sessionId: string,
    input: UpdateUserInput,
  ): Promise<RegistrySession> {
    const session = await this.requireSession(sessionId);

    const updated = session.users.map((u) =>
      u.serverIdentifier === input.serverIdentifier
        ? {
            ...u,
            cloudAccountId: input.cloudAccountId,
            cloudDisplayName: input.cloudDisplayName ?? null,
            cloudEmail: input.cloudEmail ?? null,
            resolutionStrategy: input.resolutionStrategy,
            status: 'mapped' as MappingStatus,
            validatedAt: null,
            notes: input.notes ?? u.notes,
          }
        : u,
    );

    return this.save({ ...session, users: updated });
  }

  // ─── 5. Skip mapping ─────────────────────────────────────────────────────

  async skipMapping(
    sessionId: string,
    input: SkipMappingInput,
  ): Promise<RegistrySession> {
    const session = await this.requireSession(sessionId);

    let updated = { ...session };

    if (input.type === 'customField') {
      updated = {
        ...updated,
        customFields: session.customFields.map((cf) =>
          cf.serverFieldId === input.identifier
            ? { ...cf, status: 'skipped' as MappingStatus, notes: input.notes ?? cf.notes }
            : cf,
        ),
      };
    } else if (input.type === 'group') {
      updated = {
        ...updated,
        groups: session.groups.map((g) =>
          g.serverGroupName === input.identifier
            ? { ...g, status: 'skipped' as MappingStatus, notes: input.notes ?? g.notes }
            : g,
        ),
      };
    } else {
      updated = {
        ...updated,
        users: session.users.map((u) =>
          u.serverIdentifier === input.identifier
            ? { ...u, status: 'skipped' as MappingStatus, resolutionStrategy: 'remove' as const, notes: input.notes ?? u.notes }
            : u,
        ),
      };
    }

    return this.save(updated);
  }

  // ─── 6. Validate all mapped values ───────────────────────────────────────

  async validateAll(
    sessionId: string,
    validatorConfig: ValidatorConfig,
  ): Promise<RegistrySession> {
    const session = await this.requireSession(sessionId);
    const now = new Date().toISOString();

    // Validate custom fields
    const validatedFields: CustomFieldMapping[] = [];
    for (const cf of session.customFields) {
      if (cf.status !== 'mapped' || cf.cloudFieldId === null) {
        validatedFields.push(cf);
        continue;
      }
      const result = await validateCloudField(cf.cloudFieldId, validatorConfig);
      validatedFields.push({
        ...cf,
        cloudFieldName: result.fieldName ?? cf.cloudFieldName,
        fieldType: result.fieldType ?? cf.fieldType,
        status: result.valid ? 'mapped' : 'unmapped',
        validatedAt: result.valid ? now : null,
        notes: result.valid ? cf.notes : `Validation failed: ${result.error ?? 'unknown'}`,
      });
      // Respectful rate limiting
      await delay(validatorConfig.requestDelayMs ?? 150);
    }

    // Validate groups
    const validatedGroups: GroupMapping[] = [];
    for (const g of session.groups) {
      if (g.status !== 'mapped' || g.cloudGroupId === null) {
        validatedGroups.push(g);
        continue;
      }
      const result = await validateCloudGroup(g.cloudGroupId, validatorConfig);
      validatedGroups.push({
        ...g,
        cloudGroupName: result.groupName ?? g.cloudGroupName,
        status: result.valid ? 'mapped' : 'unmapped',
        validatedAt: result.valid ? now : null,
        notes: result.valid ? g.notes : `Validation failed: ${result.error ?? 'unknown'}`,
      });
      await delay(validatorConfig.requestDelayMs ?? 150);
    }

    // Validate users
    const validatedUsers: UserMapping[] = [];
    for (const u of session.users) {
      if (u.status !== 'mapped' || u.cloudAccountId === null) {
        validatedUsers.push(u);
        continue;
      }
      const result = await validateCloudAccountId(u.cloudAccountId, validatorConfig);
      validatedUsers.push({
        ...u,
        cloudDisplayName: result.displayName ?? u.cloudDisplayName,
        cloudEmail: result.email ?? u.cloudEmail,
        status: result.valid ? 'mapped' : 'unmapped',
        validatedAt: result.valid ? now : null,
        notes: result.valid ? u.notes : `Validation failed: ${result.error ?? 'unknown'}`,
      });
      await delay(validatorConfig.requestDelayMs ?? 150);
    }

    return this.save({
      ...session,
      customFields: validatedFields,
      groups: validatedGroups,
      users: validatedUsers,
    });
  }

  // ─── 7. Get session ───────────────────────────────────────────────────────

  async getSession(sessionId: string): Promise<RegistrySession | null> {
    return this.store.get(sessionId);
  }

  // ─── 8. Resolve code ──────────────────────────────────────────────────────

  async resolveCode(
    sessionId: string,
    code: string,
  ): Promise<PlaceholderResolutionResult> {
    const session = await this.requireSession(sessionId);
    return resolvePlaceholders(code, session);
  }

  async resolveFiles(
    sessionId: string,
    files: ReadonlyArray<{ filename: string; content: string }>,
  ): Promise<ReturnType<typeof resolveAllFiles>> {
    const session = await this.requireSession(sessionId);
    return resolveAllFiles(files, session);
  }

  // ─── 9. Export / Import ───────────────────────────────────────────────────

  async exportSession(sessionId: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    return JSON.stringify(session, null, 2);
  }

  async importSession(json: string): Promise<RegistrySession> {
    let session: RegistrySession;
    try {
      session = JSON.parse(json) as RegistrySession;
    } catch {
      throw new RegistryError('Invalid session JSON');
    }

    if (typeof session.sessionId !== 'string' || typeof session.jobId !== 'string') {
      throw new RegistryError('Session JSON is missing required fields');
    }

    // Reset expiry to 24h from now on import
    const refreshed: RegistrySession = {
      ...session,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    };

    await this.store.set(this.withCompletion(refreshed));
    return this.withCompletion(refreshed);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async requireSession(sessionId: string): Promise<RegistrySession> {
    const session = await this.store.get(sessionId);
    if (session === null) {
      throw new RegistryError(`Session "${sessionId}" not found or expired`);
    }
    return session;
  }

  private async save(session: RegistrySession): Promise<RegistrySession> {
    const withMeta: RegistrySession = {
      ...session,
      updatedAt: new Date().toISOString(),
    };
    const withComp = this.withCompletion(withMeta);
    await this.store.set(withComp);
    return withComp;
  }

  /**
   * Computes isComplete and completionBlockers.
   * A session is complete when all mappings are resolved (mapped or skipped).
   */
  private withCompletion(session: RegistrySession): RegistrySession {
    const blockers: CompletionBlocker[] = [];

    for (const cf of session.customFields) {
      if (cf.status === 'unmapped') {
        blockers.push({
          type: 'unmapped-field',
          entityId: cf.serverFieldId,
          message: `Custom field "${cf.serverFieldId}" (${cf.probableBusinessPurpose}) has no Cloud mapping`,
          severity: 'error',
        });
      }
    }

    for (const g of session.groups) {
      if (g.status === 'unmapped') {
        blockers.push({
          type: 'unmapped-group',
          entityId: g.serverGroupName,
          message: `Group "${g.serverGroupName}" has no Cloud group ID mapping`,
          severity: 'error',
        });
      }
    }

    for (const u of session.users) {
      if (u.status === 'unmapped') {
        blockers.push({
          type: 'unmapped-user',
          entityId: u.serverIdentifier,
          message: `User "${u.serverIdentifier}" has no Cloud accountId (GDPR risk: ${u.gdprRisk})`,
          severity: u.gdprRisk === 'high' ? 'error' : 'warning',
        });
      }
    }

    return {
      ...session,
      isComplete: blockers.length === 0,
      completionBlockers: blockers,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}
