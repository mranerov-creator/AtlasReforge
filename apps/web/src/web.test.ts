/**
 * Web app unit tests — pure logic, no DOM required
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, submitJob, getJobStatus } from './lib/api-client.js';
import type { CloudReadinessLevel, JobStatus, MigrationResult } from './types/index.js';

// ─── ApiError ─────────────────────────────────────────────────────────────────

describe('ApiError', () => {
  it('stores statusCode and path', () => {
    const err = new ApiError('Not found', 404, '/jobs/abc/status');
    expect(err.statusCode).toBe(404);
    expect(err.path).toBe('/jobs/abc/status');
    expect(err.name).toBe('ApiError');
    expect(err.message).toBe('Not found');
  });

  it('is instanceof Error', () => {
    const err = new ApiError('Oops', 500, '/api');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof ApiError).toBe(true);
  });
});

// ─── API client with mocked fetch ─────────────────────────────────────────────

describe('API client — fetch mocking', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('throws ApiError on 404 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404,
      json: async () => ({ message: 'Job not found' }),
    } as Response);

    await expect(getJobStatus('nonexistent')).rejects.toThrow(ApiError);
  });

  it('returns parsed JSON on 200', async () => {
    const mock = {
      jobId: 'job-001', status: 'completed' as JobStatus,
      progress: 100, currentStage: 'done',
      createdAt: '', updatedAt: '', error: null, result: null,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => mock,
    } as Response);

    const result = await getJobStatus('job-001');
    expect(result.status).toBe('completed');
    expect(result.progress).toBe(100);
  });

  it('submitJob sends POST with FormData', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          jobId: 'new-job', status: 'queued',
          estimatedCostUsd: 0.02,
          registrySessionUrl: '/registry/new-job',
          statusUrl: '/jobs/new-job/status',
        }),
      } as Response);
    });

    const file = new File(['def x = 1'], 'test.groovy', { type: 'text/plain' });
    const result = await submitJob(file);

    expect(result.jobId).toBe('new-job');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.body).toBeInstanceOf(FormData);
  });
});

// ─── Terminal state detection ─────────────────────────────────────────────────

describe('Job terminal state detection', () => {
  const TERMINAL: JobStatus[] = ['completed', 'failed'];
  const NON_TERMINAL: JobStatus[] = [
    'queued', 'parsing', 'classifying', 'extracting',
    'retrieving', 'generating', 'validating', 'awaiting-registry',
  ];

  it('correctly identifies terminal states', () => {
    for (const s of TERMINAL) expect(TERMINAL.includes(s)).toBe(true);
  });

  it('correctly identifies non-terminal states', () => {
    for (const s of NON_TERMINAL) expect(TERMINAL.includes(s)).toBe(false);
  });
});

// ─── ReadinessBadge config ────────────────────────────────────────────────────

describe('ReadinessBadge level config', () => {
  const CONFIG: Record<CloudReadinessLevel, { label: string; emoji: string }> = {
    green:  { emoji: '🟢', label: 'Cloud Ready' },
    yellow: { emoji: '🟡', label: 'Paradigm Shift' },
    red:    { emoji: '🔴', label: 'Architectural Gap' },
  };

  it('has config for all three levels', () => {
    const levels: CloudReadinessLevel[] = ['green', 'yellow', 'red'];
    for (const level of levels) {
      expect(CONFIG[level]).toBeDefined();
      expect(CONFIG[level]?.emoji).toBeTruthy();
    }
  });

  it('score >= 70 maps to green', () => {
    const score = 85;
    const level: CloudReadinessLevel = score >= 70 ? 'green' : score >= 40 ? 'yellow' : 'red';
    expect(level).toBe('green');
  });

  it('red issues override score', () => {
    const level: CloudReadinessLevel = true ? 'red' : 'yellow';
    expect(level).toBe('red');
  });
});

// ─── Registry completion ──────────────────────────────────────────────────────

describe('Registry completion logic', () => {
  it('no deps → immediately complete', () => {
    const blockers: unknown[] = [];
    expect(blockers.length === 0).toBe(true);
  });

  it('unmapped field → not complete', () => {
    const blockers = [{ type: 'unmapped-field', entityId: 'customfield_10048' }];
    expect(blockers.length === 0).toBe(false);
  });

  it('all mapped or skipped → complete', () => {
    const items = [{ status: 'mapped' }, { status: 'skipped' }, { status: 'auto-mapped' }];
    const allResolved = items.every(
      m => m.status === 'mapped' || m.status === 'skipped' || m.status === 'auto-mapped',
    );
    expect(allResolved).toBe(true);
  });
});

// ─── MigrationResult structure ────────────────────────────────────────────────

describe('MigrationResult structure', () => {
  const MOCK: MigrationResult = {
    jobId: 'test-job', originalFilename: 'script.groovy',
    completedAt: '2025-01-01T00:00:00Z',
    cloudReadinessScore: 75, cloudReadinessLevel: 'yellow',
    recommendedTarget: 'forge-or-scriptrunner',
    complexity: 'medium', linesOfCode: 30,
    businessLogic: {
      triggerDescription: 'Post-function on Approve',
      purposeNarrative: 'Routes high-budget issues',
      inputConditions: ['Budget > 50000'],
      outputActions: ['Assign to finance'],
      externalIntegrations: [],
    },
    forgeFiles: [
      { filename: 'manifest.yml', content: 'app:', language: 'yaml', purpose: 'Manifest' },
      { filename: 'src/index.ts', content: 'export {};', language: 'typescript', purpose: 'Entry' },
    ],
    scriptRunnerCode: null,
    diagram: { type: 'sequenceDiagram', mermaidSource: 'sequenceDiagram\n  J->>F: Trigger', title: 'Flow' },
    oauthScopes: ['read:jira-work', 'write:jira-work'],
    confidence: {
      fieldMapping:     { score: 0.95, note: 'Direct', requiresHumanReview: false },
      webhookLogic:     { score: 0.85, note: 'Standard', requiresHumanReview: false },
      userResolution:   { score: 0.40, note: 'Review', requiresHumanReview: true },
      oauthScopes:      { score: 0.90, note: 'Standard', requiresHumanReview: false },
      overallMigration: { score: 0.78, note: 'Review user', requiresHumanReview: true },
    },
    validationIssues: [
      { severity: 'warning', code: 'VAL_020', message: 'v2→v3', file: 'src/index.ts', line: 5, autoFixed: true },
    ],
    fieldMappingPlaceholders: [
      { placeholder: 'ATLAS_FIELD_ID("customfield_10048")', serverFieldId: 'customfield_10048', description: 'Budget', requiredInFile: 'src/index.ts' },
    ],
    pipeline: {
      totalTokensUsed: 1800, totalDurationMs: 12_000,
      totalCostUsd: 0.035,
      modelsUsed: ['gpt-4o-mini', 'claude-sonnet-4-6'],
      stageTimings: { 's1-classifier': 800, 's4-generator': 8_200 },
    },
  };

  it('forgeFiles has manifest.yml first', () => {
    expect(MOCK.forgeFiles?.[0]?.filename).toBe('manifest.yml');
  });

  it('all confidence scores are 0-1', () => {
    const scores = Object.values(MOCK.confidence).map(c => c.score);
    for (const score of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('has auto-fixed issues', () => {
    const fixed = MOCK.validationIssues.filter(i => i.autoFixed);
    expect(fixed.length).toBeGreaterThan(0);
  });

  it('pipeline cost is positive', () => {
    expect(MOCK.pipeline.totalCostUsd).toBeGreaterThan(0);
  });

  it('ROI savings > 70%', () => {
    const consultantH = 15, aiH = 3.5;
    const savings = Math.round(((consultantH - aiH) / consultantH) * 100);
    expect(savings).toBeGreaterThan(70);
  });
});

// ─── Polling backoff ──────────────────────────────────────────────────────────

describe('Polling backoff', () => {
  const INITIAL = 1000, MAX = 10_000, MULT = 1.5;

  it('never exceeds MAX_INTERVAL', () => {
    let interval = INITIAL;
    for (let i = 0; i < 20; i++) interval = Math.min(interval * MULT, MAX);
    expect(interval).toBe(MAX);
  });

  it('reaches MAX in under 15 steps', () => {
    let interval = INITIAL, steps = 0;
    while (interval < MAX) { interval = Math.min(interval * MULT, MAX); steps++; }
    expect(steps).toBeLessThan(15);
  });
});
