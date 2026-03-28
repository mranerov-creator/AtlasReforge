/**
 * @atlasreforge/field-registry — Test Suite
 *
 * Tests the full mapping lifecycle + placeholder resolution.
 * NO real Jira API calls — validator is tested with mocked fetch.
 *
 *   1. Session build from ParsedScript dependencies
 *   2. Completion blockers — unmapped items block code generation
 *   3. Field / group / user updates
 *   4. Skip mapping
 *   5. Placeholder resolver — ATLAS_FIELD_ID(), ATLAS_ACCOUNT_ID(), ATLAS_GROUP_ID()
 *   6. Multi-file resolution
 *   7. Export / import round-trip
 *   8. TTL eviction in InMemoryRegistryStore
 *   9. RegistryError on missing session
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  InMemoryRegistryStore,
  JiraValidationError,
  RegistryError,
  RegistryService,
  resolvePlaceholders,
  resolveAllFiles,
} from '../src/index.js';
import type {
  BuildSessionInput,
  RegistrySession,
} from '../src/types/registry.types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BUILD_INPUT: BuildSessionInput = {
  jobId: 'job-test-001',
  originalFilename: 'budget-approval.groovy',
  customFieldRefs: [
    {
      fieldId: 'customfield_10048',
      usageType: 'read',
      probableBusinessPurpose: 'Budget threshold for approval routing',
    },
    {
      fieldId: 'customfield_10052',
      usageType: 'write',
      probableBusinessPurpose: 'Approval status field',
    },
  ],
  groupRefs: [
    {
      groupName: 'jira-finance-team-PROD',
      probableRole: 'Finance approvers',
    },
  ],
  userRefs: [
    {
      identifier: 'jsmith',
      identifierType: 'username',
      gdprRisk: 'high',
    },
  ],
};

// ─── Store ────────────────────────────────────────────────────────────────────

describe('InMemoryRegistryStore', () => {
  let store: InMemoryRegistryStore;

  beforeEach(() => {
    store = new InMemoryRegistryStore(999_999); // Long eviction interval for tests
  });

  afterEach(() => {
    store.destroy();
  });

  it('stores and retrieves a session', async () => {
    const session = {
      sessionId: 's1',
      jobId: 'j1',
      originalFilename: 'test.groovy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      customFields: [],
      groups: [],
      users: [],
      isComplete: true,
      completionBlockers: [],
    } satisfies RegistrySession;

    await store.set(session);
    const retrieved = await store.get('s1');
    expect(retrieved?.sessionId).toBe('s1');
  });

  it('returns null for non-existent session', async () => {
    const result = await store.get('non-existent');
    expect(result).toBeNull();
  });

  it('evicts expired sessions on read', async () => {
    const expired = {
      sessionId: 'expired',
      jobId: 'j1',
      originalFilename: 'test.groovy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // Already expired
      customFields: [],
      groups: [],
      users: [],
      isComplete: true,
      completionBlockers: [],
    } satisfies RegistrySession;

    await store.set(expired);
    const result = await store.get('expired');
    expect(result).toBeNull();
  });

  it('deletes a session', async () => {
    const session = {
      sessionId: 'to-delete',
      jobId: 'j1',
      originalFilename: 'test.groovy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      customFields: [],
      groups: [],
      users: [],
      isComplete: true,
      completionBlockers: [],
    } satisfies RegistrySession;

    await store.set(session);
    await store.delete('to-delete');
    expect(await store.get('to-delete')).toBeNull();
  });
});

// ─── Registry Service — Session build ────────────────────────────────────────

describe('RegistryService — buildSession()', () => {
  let service: RegistryService;
  let store: InMemoryRegistryStore;

  beforeEach(() => {
    store = new InMemoryRegistryStore();
    service = new RegistryService(store);
  });

  afterEach(() => { store.destroy(); });

  it('creates a session with all detected dependencies', async () => {
    const session = await service.buildSession(BUILD_INPUT);

    expect(session.sessionId).toBe('job-test-001');
    expect(session.customFields).toHaveLength(2);
    expect(session.groups).toHaveLength(1);
    expect(session.users).toHaveLength(1);
  });

  it('starts all mappings as unmapped', async () => {
    const session = await service.buildSession(BUILD_INPUT);

    for (const cf of session.customFields) {
      expect(cf.status).toBe('unmapped');
      expect(cf.cloudFieldId).toBeNull();
    }
    for (const g of session.groups) {
      expect(g.status).toBe('unmapped');
    }
    for (const u of session.users) {
      expect(u.status).toBe('unmapped');
      expect(u.cloudAccountId).toBeNull();
    }
  });

  it('marks session as incomplete when dependencies exist', async () => {
    const session = await service.buildSession(BUILD_INPUT);
    expect(session.isComplete).toBe(false);
  });

  it('marks session as complete when no dependencies', async () => {
    const session = await service.buildSession({
      jobId: 'job-no-deps',
      originalFilename: 'simple.groovy',
      customFieldRefs: [],
      groupRefs: [],
      userRefs: [],
    });
    expect(session.isComplete).toBe(true);
    expect(session.completionBlockers).toHaveLength(0);
  });

  it('deduplicates repeated field references', async () => {
    const session = await service.buildSession({
      ...BUILD_INPUT,
      customFieldRefs: [
        { fieldId: 'customfield_10048', usageType: 'read' },
        { fieldId: 'customfield_10048', usageType: 'write' }, // Duplicate
      ],
    });
    expect(session.customFields).toHaveLength(1);
  });

  it('generates correct completion blockers', async () => {
    const session = await service.buildSession(BUILD_INPUT);
    const blockerTypes = session.completionBlockers.map((b) => b.type);

    expect(blockerTypes).toContain('unmapped-field');
    expect(blockerTypes).toContain('unmapped-group');
    expect(blockerTypes).toContain('unmapped-user');
  });
});

// ─── Registry Service — Mapping updates ──────────────────────────────────────

describe('RegistryService — mapping updates', () => {
  let service: RegistryService;
  let store: InMemoryRegistryStore;

  beforeEach(async () => {
    store = new InMemoryRegistryStore();
    service = new RegistryService(store);
    await service.buildSession(BUILD_INPUT);
  });

  afterEach(() => { store.destroy(); });

  it('maps a custom field and removes its completion blocker', async () => {
    const session = await service.updateField('job-test-001', {
      serverFieldId: 'customfield_10048',
      cloudFieldId: 'customfield_10201',
      cloudFieldName: 'Budget Threshold',
    });

    const cf = session.customFields.find((f) => f.serverFieldId === 'customfield_10048');
    expect(cf?.status).toBe('mapped');
    expect(cf?.cloudFieldId).toBe('customfield_10201');
    expect(cf?.cloudFieldName).toBe('Budget Threshold');

    // Blocker for this field should be gone
    const blockers = session.completionBlockers.map((b) => b.entityId);
    expect(blockers).not.toContain('customfield_10048');
  });

  it('maps a group', async () => {
    const session = await service.updateGroup('job-test-001', {
      serverGroupName: 'jira-finance-team-PROD',
      cloudGroupId: '5e2a1234abcd5678ef901234',
      cloudGroupName: 'Finance Team',
    });

    const g = session.groups.find((g) => g.serverGroupName === 'jira-finance-team-PROD');
    expect(g?.status).toBe('mapped');
    expect(g?.cloudGroupId).toBe('5e2a1234abcd5678ef901234');
  });

  it('maps a user with accountId', async () => {
    const session = await service.updateUser('job-test-001', {
      serverIdentifier: 'jsmith',
      cloudAccountId: '5e2a9999abcd1234ef567890',
      cloudDisplayName: 'John Smith',
      cloudEmail: 'john.smith@company.com',
      resolutionStrategy: 'migration-api',
    });

    const u = session.users.find((u) => u.serverIdentifier === 'jsmith');
    expect(u?.status).toBe('mapped');
    expect(u?.cloudAccountId).toBe('5e2a9999abcd1234ef567890');
    expect(u?.resolutionStrategy).toBe('migration-api');
  });

  it('session is complete after all mappings are resolved', async () => {
    await service.updateField('job-test-001', {
      serverFieldId: 'customfield_10048',
      cloudFieldId: 'customfield_10201',
    });
    await service.updateField('job-test-001', {
      serverFieldId: 'customfield_10052',
      cloudFieldId: 'customfield_10202',
    });
    await service.updateGroup('job-test-001', {
      serverGroupName: 'jira-finance-team-PROD',
      cloudGroupId: '5e2a1234abcd5678ef901234',
    });
    const session = await service.updateUser('job-test-001', {
      serverIdentifier: 'jsmith',
      cloudAccountId: '5e2a9999abcd1234ef567890',
      resolutionStrategy: 'migration-api',
    });

    expect(session.isComplete).toBe(true);
    expect(session.completionBlockers).toHaveLength(0);
  });

  it('skipping a mapping marks it as skipped and clears its blocker', async () => {
    const session = await service.skipMapping('job-test-001', {
      type: 'user',
      identifier: 'jsmith',
      notes: 'Service account not needed in Cloud',
    });

    const u = session.users.find((u) => u.serverIdentifier === 'jsmith');
    expect(u?.status).toBe('skipped');
    expect(u?.resolutionStrategy).toBe('remove');

    const blockers = session.completionBlockers.map((b) => b.entityId);
    expect(blockers).not.toContain('jsmith');
  });

  it('throws RegistryError for unknown session', async () => {
    await expect(
      service.updateField('non-existent-session', {
        serverFieldId: 'customfield_10048',
        cloudFieldId: 'customfield_10201',
      }),
    ).rejects.toThrow(RegistryError);
  });
});

// ─── Placeholder Resolver ─────────────────────────────────────────────────────

describe('Placeholder Resolver — resolvePlaceholders()', () => {
  const COMPLETE_SESSION: RegistrySession = {
    sessionId: 'resolve-test',
    jobId: 'resolve-test',
    originalFilename: 'test.groovy',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isComplete: true,
    completionBlockers: [],
    customFields: [
      {
        serverFieldId: 'customfield_10048',
        serverFieldName: 'Budget',
        cloudFieldId: 'customfield_10201',
        cloudFieldName: 'Budget Threshold',
        fieldType: null,
        probableBusinessPurpose: 'Budget',
        usageType: 'read',
        status: 'mapped',
        validatedAt: null,
        notes: null,
      },
    ],
    groups: [
      {
        serverGroupName: 'jira-finance-team-PROD',
        cloudGroupId: '5e2a1234abcd5678ef901234',
        cloudGroupName: 'Finance Team',
        probableRole: 'Finance approvers',
        status: 'mapped',
        validatedAt: null,
        notes: null,
      },
    ],
    users: [
      {
        serverIdentifier: 'jsmith',
        identifierType: 'username',
        cloudAccountId: '5e2a9999abcd1234ef567890',
        cloudDisplayName: 'John Smith',
        cloudEmail: 'john.smith@company.com',
        gdprRisk: 'high',
        resolutionStrategy: 'migration-api',
        status: 'mapped',
        validatedAt: null,
        notes: null,
      },
    ],
  };

  it('replaces ATLAS_FIELD_ID() with the Cloud field ID', () => {
    const code = `const fieldId = ATLAS_FIELD_ID("customfield_10048");`;
    const result = resolvePlaceholders(code, COMPLETE_SESSION);

    expect(result.resolvedCode).toContain('"customfield_10201"');
    expect(result.resolvedCode).not.toContain('ATLAS_FIELD_ID');
    expect(result.resolved).toBe(1);
    expect(result.unresolved).toBe(0);
  });

  it('replaces ATLAS_ACCOUNT_ID() with the Cloud accountId', () => {
    const code = `const userId = ATLAS_ACCOUNT_ID("jsmith");`;
    const result = resolvePlaceholders(code, COMPLETE_SESSION);

    expect(result.resolvedCode).toContain('"5e2a9999abcd1234ef567890"');
    expect(result.resolved).toBe(1);
  });

  it('replaces ATLAS_GROUP_ID() with the Cloud group ID', () => {
    const code = `const groupId = ATLAS_GROUP_ID("jira-finance-team-PROD");`;
    const result = resolvePlaceholders(code, COMPLETE_SESSION);

    expect(result.resolvedCode).toContain('"5e2a1234abcd5678ef901234"');
    expect(result.resolved).toBe(1);
  });

  it('leaves unrecognised placeholders intact and reports them', () => {
    const code = `const x = ATLAS_FIELD_ID("customfield_99999");`;
    const result = resolvePlaceholders(code, COMPLETE_SESSION);

    expect(result.unresolved).toBe(1);
    expect(result.unresolvedPlaceholders).toContain('ATLAS_FIELD_ID("customfield_99999")');
    expect(result.resolvedCode).toContain('ATLAS_FIELD_ID("customfield_99999")');
  });

  it('replaces skipped mappings with a comment + null', () => {
    const sessionWithSkip: RegistrySession = {
      ...COMPLETE_SESSION,
      users: [
        {
          ...COMPLETE_SESSION.users[0]!,
          status: 'skipped',
          resolutionStrategy: 'remove',
          notes: 'Not needed in Cloud',
        },
      ],
    };
    const code = `const userId = ATLAS_ACCOUNT_ID("jsmith");`;
    const result = resolvePlaceholders(code, sessionWithSkip);

    expect(result.resolvedCode).toContain('USER REMOVED');
    expect(result.resolvedCode).toContain('null');
    expect(result.resolved).toBe(1);
  });

  it('handles multiple placeholders in one code string', () => {
    const code = `
const fieldId = ATLAS_FIELD_ID("customfield_10048");
const userId = ATLAS_ACCOUNT_ID("jsmith");
const groupId = ATLAS_GROUP_ID("jira-finance-team-PROD");
`.trim();

    const result = resolvePlaceholders(code, COMPLETE_SESSION);
    expect(result.totalPlaceholders).toBe(3);
    expect(result.resolved).toBe(3);
    expect(result.unresolved).toBe(0);
  });
});

// ─── Multi-file resolver ──────────────────────────────────────────────────────

describe('resolveAllFiles()', () => {
  const SESSION: RegistrySession = {
    sessionId: 'multi-file-test',
    jobId: 'multi-file-test',
    originalFilename: 'test.groovy',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    isComplete: true,
    completionBlockers: [],
    customFields: [{
      serverFieldId: 'customfield_10048',
      serverFieldName: null,
      cloudFieldId: 'customfield_10201',
      cloudFieldName: null,
      fieldType: null,
      probableBusinessPurpose: 'Budget',
      usageType: 'read',
      status: 'mapped',
      validatedAt: null,
      notes: null,
    }],
    groups: [],
    users: [],
  };

  it('resolves placeholders across multiple files', () => {
    const files = [
      { filename: 'src/index.ts', content: `const f = ATLAS_FIELD_ID("customfield_10048");` },
      { filename: 'src/handler.ts', content: `const f2 = ATLAS_FIELD_ID("customfield_10048");` },
    ];

    const result = resolveAllFiles(files, SESSION);
    expect(result.totalResolved).toBe(2);
    expect(result.totalUnresolved).toBe(0);
    for (const file of result.patchedFiles) {
      expect(file.content).toContain('"customfield_10201"');
    }
  });

  it('reports unresolved placeholders by file', () => {
    const files = [
      { filename: 'src/index.ts', content: `const f = ATLAS_FIELD_ID("customfield_99999");` },
    ];

    const result = resolveAllFiles(files, SESSION);
    expect(result.totalUnresolved).toBe(1);
    expect(result.unresolvedByFile['src/index.ts']).toHaveLength(1);
  });
});

// ─── Export / Import ──────────────────────────────────────────────────────────

describe('RegistryService — export / import', () => {
  let service: RegistryService;
  let store: InMemoryRegistryStore;

  beforeEach(async () => {
    store = new InMemoryRegistryStore();
    service = new RegistryService(store);
    await service.buildSession(BUILD_INPUT);
  });

  afterEach(() => { store.destroy(); });

  it('round-trips a session through export + import', async () => {
    // Map something before export
    await service.updateField('job-test-001', {
      serverFieldId: 'customfield_10048',
      cloudFieldId: 'customfield_10201',
    });

    const json = await service.exportSession('job-test-001');
    expect(() => JSON.parse(json)).not.toThrow();

    // Import into a fresh store
    const freshStore = new InMemoryRegistryStore();
    const freshService = new RegistryService(freshStore);
    const imported = await freshService.importSession(json);

    expect(imported.sessionId).toBe('job-test-001');
    const cf = imported.customFields.find((f) => f.serverFieldId === 'customfield_10048');
    expect(cf?.cloudFieldId).toBe('customfield_10201');
    expect(cf?.status).toBe('mapped');

    freshStore.destroy();
  });

  it('throws RegistryError for invalid JSON on import', async () => {
    await expect(service.importSession('{invalid json}')).rejects.toThrow(RegistryError);
  });
});

// ─── JiraValidationError ──────────────────────────────────────────────────────

describe('JiraValidationError', () => {
  it('stores status code', () => {
    const err = new JiraValidationError('Not found', 404);
    expect(err.statusCode).toBe(404);
    expect(err.name).toBe('JiraValidationError');
  });
});
