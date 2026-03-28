/**
 * API Client
 *
 * Typed fetch wrapper for the AtlasReforge REST API.
 * All methods are async and throw ApiError on non-2xx responses.
 */

import type {
  JobStatusResponse,
  MigrationResult,
  RegistrySession,
} from '../types/index.js';

const BASE_URL = '/api/v1';

// ─── Error type ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Accept: 'application/json',
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
    ...init,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: 'Unknown error' })) as { message?: string };
    throw new ApiError(
      body.message ?? `HTTP ${response.status}`,
      response.status,
      path,
    );
  }

  return response.json() as Promise<T>;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export interface SubmitJobResponse {
  jobId: string;
  status: string;
  estimatedCostUsd: number | null;
  registrySessionUrl: string;
  statusUrl: string;
}

export async function submitJob(
  file: File,
  options: {
    preferredTarget?: string;
    cloudBaseUrl?: string;
    accessToken?: string;
  } = {},
): Promise<SubmitJobResponse> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  if (options.preferredTarget) formData.append('preferredTarget', options.preferredTarget);
  if (options.cloudBaseUrl) formData.append('cloudBaseUrl', options.cloudBaseUrl);
  if (options.accessToken) formData.append('accessToken', options.accessToken);

  return request<SubmitJobResponse>('/jobs', {
    method: 'POST',
    body: formData,
  });
}

export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
  return request<JobStatusResponse>(`/jobs/${jobId}/status`);
}

export async function getJobResult(jobId: string): Promise<MigrationResult> {
  return request<MigrationResult>(`/jobs/${jobId}/result`);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export async function getRegistrySession(jobId: string): Promise<RegistrySession> {
  return request<RegistrySession>(`/registry/${jobId}`);
}

export async function updateFieldMapping(
  jobId: string,
  serverFieldId: string,
  cloudFieldId: string,
  cloudFieldName?: string,
): Promise<RegistrySession> {
  return request<RegistrySession>(`/registry/${jobId}/fields`, {
    method: 'PUT',
    body: JSON.stringify({ serverFieldId, cloudFieldId, cloudFieldName }),
  });
}

export async function updateGroupMapping(
  jobId: string,
  serverGroupName: string,
  cloudGroupId: string,
  cloudGroupName?: string,
): Promise<RegistrySession> {
  return request<RegistrySession>(`/registry/${jobId}/groups`, {
    method: 'PUT',
    body: JSON.stringify({ serverGroupName, cloudGroupId, cloudGroupName }),
  });
}

export async function updateUserMapping(
  jobId: string,
  serverIdentifier: string,
  cloudAccountId: string,
  resolutionStrategy: string,
  cloudDisplayName?: string,
): Promise<RegistrySession> {
  return request<RegistrySession>(`/registry/${jobId}/users`, {
    method: 'PUT',
    body: JSON.stringify({
      serverIdentifier,
      cloudAccountId,
      resolutionStrategy,
      cloudDisplayName,
    }),
  });
}

export async function skipMapping(
  jobId: string,
  type: 'customField' | 'group' | 'user',
  identifier: string,
  notes?: string,
): Promise<RegistrySession> {
  return request<RegistrySession>(`/registry/${jobId}/skip`, {
    method: 'POST',
    body: JSON.stringify({ type, identifier, notes }),
  });
}

export async function validateRegistry(
  jobId: string,
  cloudBaseUrl: string,
  accessToken: string,
): Promise<RegistrySession> {
  return request<RegistrySession>(`/registry/${jobId}/validate`, {
    method: 'POST',
    body: JSON.stringify({ cloudBaseUrl, accessToken }),
  });
}

export async function exportRegistry(
  jobId: string,
): Promise<{ json: string; filename: string }> {
  return request<{ json: string; filename: string }>(`/registry/${jobId}/export`);
}

export async function resolveCode(
  jobId: string,
  code: string,
): Promise<{
  resolvedCode: string;
  totalPlaceholders: number;
  resolved: number;
  unresolved: number;
  unresolvedPlaceholders: string[];
}> {
  return request(`/registry/${jobId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

// ─── Automation import proxy ──────────────────────────────────────────────────

export interface AutomationImportRequest {
  ruleJson: string;
  jiraBaseUrl: string;
  email: string;
  apiToken: string;
}

export interface AutomationImportResponse {
  success: boolean;
  ruleId: string | null;
  ruleName: string | null;
  ruleUrl: string | null;
  message: string;
}

export async function importAutomationRule(
  payload: AutomationImportRequest,
): Promise<AutomationImportResponse> {
  return request<AutomationImportResponse>('/automation/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
