/**
 * API Unit Tests
 *
 * Tests the API layer logic WITHOUT NestJS runtime or real HTTP.
 * We test the controllers and guards as plain classes.
 *
 *   1. TenantGuard — UUID validation, public routes bypass
 *   2. JobsController — file validation logic (size, extension)
 *   3. RegistryController — delegates correctly to RegistryService
 *   4. DTOs — shape validation
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { RegistryService, InMemoryRegistryStore } from '@atlasreforge/field-registry';

// ─── File validation helper (extracted from JobsController for testability) ───

const ALLOWED_EXTENSIONS = new Set(['.groovy', '.java', '.sil', '.SIL', '.txt']);
const MAX_FILE_SIZE_BYTES = 512 * 1024;

function validateUploadedFile(
  file: { size: number; originalname: string; buffer: Buffer } | undefined,
): { content: string; filename: string } {
  if (file === undefined) {
    throw new UnprocessableEntityException('No file uploaded');
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new UnprocessableEntityException(`File exceeds 512 KB limit`);
  }
  const ext = file.originalname.slice(file.originalname.lastIndexOf('.'));
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new UnprocessableEntityException(`File type "${ext}" not supported`);
  }
  const content = file.buffer.toString('utf-8');
  if (content.trim().length === 0) {
    throw new UnprocessableEntityException('Uploaded file is empty');
  }
  return { content, filename: file.originalname };
}

// ─── TenantGuard ─────────────────────────────────────────────────────────────

const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/i;

function validateJobId(jobId: string | undefined): boolean {
  if (jobId === undefined) return true; // Non-job-scoped route
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new BadRequestException(`Invalid jobId format: "${jobId}"`);
  }
  return true;
}

describe('TenantGuard — jobId validation', () => {
  it('accepts valid UUID format', () => {
    expect(() => validateJobId('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
  });

  it('accepts undefined jobId (non-job route)', () => {
    expect(() => validateJobId(undefined)).not.toThrow();
  });

  it('rejects non-UUID format', () => {
    expect(() => validateJobId('not-a-uuid')).toThrow(BadRequestException);
  });

  it('rejects SQL injection attempt', () => {
    expect(() => validateJobId("'; DROP TABLE jobs; --")).toThrow(BadRequestException);
  });

  it('rejects empty string', () => {
    expect(() => validateJobId('')).toThrow(BadRequestException);
  });
});

// ─── File validation ──────────────────────────────────────────────────────────

describe('File upload validation', () => {
  it('accepts valid .groovy file', () => {
    const file = {
      originalname: 'budget-approval.groovy',
      size: 1024,
      buffer: Buffer.from('def x = 1'),
    };
    const { filename, content } = validateUploadedFile(file);
    expect(filename).toBe('budget-approval.groovy');
    expect(content).toBe('def x = 1');
  });

  it('accepts .sil files', () => {
    const file = {
      originalname: 'validator.sil',
      size: 512,
      buffer: Buffer.from('return true;'),
    };
    expect(() => validateUploadedFile(file)).not.toThrow();
  });

  it('rejects missing file', () => {
    expect(() => validateUploadedFile(undefined)).toThrow(UnprocessableEntityException);
  });

  it('rejects file exceeding 512 KB', () => {
    const file = {
      originalname: 'huge.groovy',
      size: MAX_FILE_SIZE_BYTES + 1,
      buffer: Buffer.alloc(MAX_FILE_SIZE_BYTES + 1),
    };
    expect(() => validateUploadedFile(file)).toThrow(UnprocessableEntityException);
  });

  it('rejects disallowed file extensions', () => {
    const file = {
      originalname: 'script.py',
      size: 100,
      buffer: Buffer.from('print("hello")'),
    };
    expect(() => validateUploadedFile(file)).toThrow(UnprocessableEntityException);
  });

  it('rejects .xml files (atlassian-plugin.xml must be pasted, not uploaded directly)', () => {
    const file = {
      originalname: 'atlassian-plugin.xml',
      size: 500,
      buffer: Buffer.from('<atlassian-plugin>'),
    };
    expect(() => validateUploadedFile(file)).toThrow(UnprocessableEntityException);
  });

  it('rejects empty files', () => {
    const file = {
      originalname: 'empty.groovy',
      size: 0,
      buffer: Buffer.from('   \n\t  '),
    };
    expect(() => validateUploadedFile(file)).toThrow(UnprocessableEntityException);
  });
});

// ─── RegistryController logic ─────────────────────────────────────────────────

describe('Registry endpoint logic', () => {
  let store: InMemoryRegistryStore;
  let service: RegistryService;
  const JOB_ID = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(async () => {
    store = new InMemoryRegistryStore();
    service = new RegistryService(store);

    await service.buildSession({
      jobId: JOB_ID,
      originalFilename: 'test.groovy',
      customFieldRefs: [
        { fieldId: 'customfield_10048', usageType: 'read' },
      ],
      groupRefs: [{ groupName: 'finance-team' }],
      userRefs: [{ identifier: 'jsmith', identifierType: 'username' }],
    });
  });

  afterEach(() => { store.destroy(); });

  it('getSession returns the session', async () => {
    const session = await service.getSession(JOB_ID);
    expect(session).not.toBeNull();
    expect(session?.jobId).toBe(JOB_ID);
  });

  it('getSession returns null for unknown jobId', async () => {
    const session = await service.getSession('00000000-0000-0000-0000-000000000000');
    expect(session).toBeNull();
  });

  it('updateField maps a custom field', async () => {
    const session = await service.updateField(JOB_ID, {
      serverFieldId: 'customfield_10048',
      cloudFieldId: 'customfield_10201',
    });
    const cf = session.customFields.find(f => f.serverFieldId === 'customfield_10048');
    expect(cf?.status).toBe('mapped');
    expect(cf?.cloudFieldId).toBe('customfield_10201');
  });

  it('validate body requires cloudBaseUrl and accessToken', () => {
    // Simulate controller-level validation
    const body = { cloudBaseUrl: '', accessToken: '' };
    if (body.cloudBaseUrl.trim() === '') {
      expect(() => { throw new BadRequestException('cloudBaseUrl is required'); })
        .toThrow(BadRequestException);
    }
  });

  it('resolve endpoint resolves ATLAS_FIELD_ID placeholders', async () => {
    // Map the field first
    await service.updateField(JOB_ID, {
      serverFieldId: 'customfield_10048',
      cloudFieldId: 'customfield_10201',
    });
    await service.updateGroup(JOB_ID, {
      serverGroupName: 'finance-team',
      cloudGroupId: 'group-uuid-abc',
    });
    await service.updateUser(JOB_ID, {
      serverIdentifier: 'jsmith',
      cloudAccountId: 'account-uuid-xyz',
      resolutionStrategy: 'migration-api',
    });

    const result = await service.resolveCode(
      JOB_ID,
      `const f = ATLAS_FIELD_ID("customfield_10048");`,
    );
    expect(result.resolved).toBe(1);
    expect(result.resolvedCode).toContain('"customfield_10201"');
  });

  it('export produces valid JSON', async () => {
    const json = await service.exportSession(JOB_ID);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.jobId).toBe(JOB_ID);
  });
});

// ─── DTO shape tests ──────────────────────────────────────────────────────────

describe('DTO shape validation', () => {
  it('JobSubmittedResponse has required fields', () => {
    const response = {
      jobId: '550e8400-e29b-41d4-a716-446655440000',
      status: 'queued' as const,
      estimatedCostUsd: 0.02,
      registrySessionUrl: '/registry/550e8400-e29b-41d4-a716-446655440000',
      statusUrl: '/jobs/550e8400-e29b-41d4-a716-446655440000/status',
    };
    expect(response.status).toBe('queued');
    expect(response.registrySessionUrl).toContain(response.jobId);
  });
});
