/**
 * useRegistry
 *
 * Manages all Field Mapping Registry interactions for a given jobId.
 * Provides optimistic UI updates: the session state is updated immediately
 * in the component while the API call fires in the background.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getRegistrySession,
  updateFieldMapping,
  updateGroupMapping,
  updateUserMapping,
  skipMapping,
  validateRegistry,
  exportRegistry,
} from '../lib/api-client.js';
import type { RegistrySession } from '../types/index.js';

interface UseRegistryResult {
  session: RegistrySession | null;
  loading: boolean;
  error: string | null;
  updateField: (serverFieldId: string, cloudFieldId: string, name?: string) => Promise<void>;
  updateGroup: (serverGroupName: string, cloudGroupId: string, name?: string) => Promise<void>;
  updateUser: (serverIdentifier: string, cloudAccountId: string, strategy: string, name?: string) => Promise<void>;
  skip: (type: 'customField' | 'group' | 'user', identifier: string, notes?: string) => Promise<void>;
  validate: (cloudBaseUrl: string, accessToken: string) => Promise<void>;
  exportSession: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useRegistry(jobId: string | null): UseRegistryResult {
  const [session, setSession] = useState<RegistrySession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (jobId === null) return;
    setLoading(true);
    try {
      const data = await getRegistrySession(jobId);
      setSession(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load registry');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateField = useCallback(async (
    serverFieldId: string,
    cloudFieldId: string,
    name?: string,
  ) => {
    if (jobId === null) return;
    const updated = await updateFieldMapping(jobId, serverFieldId, cloudFieldId, name);
    setSession(updated);
  }, [jobId]);

  const updateGroup = useCallback(async (
    serverGroupName: string,
    cloudGroupId: string,
    name?: string,
  ) => {
    if (jobId === null) return;
    const updated = await updateGroupMapping(jobId, serverGroupName, cloudGroupId, name);
    setSession(updated);
  }, [jobId]);

  const updateUser = useCallback(async (
    serverIdentifier: string,
    cloudAccountId: string,
    strategy: string,
    name?: string,
  ) => {
    if (jobId === null) return;
    const updated = await updateUserMapping(jobId, serverIdentifier, cloudAccountId, strategy, name);
    setSession(updated);
  }, [jobId]);

  const skip = useCallback(async (
    type: 'customField' | 'group' | 'user',
    identifier: string,
    notes?: string,
  ) => {
    if (jobId === null) return;
    const updated = await skipMapping(jobId, type, identifier, notes);
    setSession(updated);
  }, [jobId]);

  const validate = useCallback(async (cloudBaseUrl: string, accessToken: string) => {
    if (jobId === null) return;
    setLoading(true);
    try {
      const updated = await validateRegistry(jobId, cloudBaseUrl, accessToken);
      setSession(updated);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  const exportSession = useCallback(async () => {
    if (jobId === null) return;
    const { json, filename } = await exportRegistry(jobId);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [jobId]);

  return {
    session,
    loading,
    error,
    updateField,
    updateGroup,
    updateUser,
    skip,
    validate,
    exportSession,
    refresh,
  };
}
