/**
 * useJobPolling
 *
 * Polls the /jobs/:jobId/status endpoint until the job reaches a terminal state.
 * Uses exponential backoff: 1s → 2s → 4s → max 10s between polls.
 * Stops automatically on 'completed' or 'failed'.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { getJobStatus } from '../lib/api-client.js';
import type { JobStatus, JobStatusResponse, MigrationResult } from '../types/index.js';

const TERMINAL_STATES: JobStatus[] = ['completed', 'failed'];
const INITIAL_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 10_000;
const BACKOFF_MULTIPLIER = 1.5;

interface UseJobPollingResult {
  status: JobStatus | null;
  progress: number;
  currentStage: string;
  result: MigrationResult | null;
  error: string | null;
  isPolling: boolean;
  stopPolling: () => void;
}

export function useJobPolling(jobId: string | null): UseJobPollingResult {
  const [response, setResponse] = useState<JobStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentIntervalRef = useRef(INITIAL_INTERVAL_MS);
  const isStoppedRef = useRef(false);

  const stopPolling = useCallback(() => {
    isStoppedRef.current = true;
    setIsPolling(false);
    if (intervalRef.current !== null) {
      clearTimeout(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (jobId === null || isStoppedRef.current) return;

    try {
      const data = await getJobStatus(jobId);
      setResponse(data);
      setError(null);

      if (TERMINAL_STATES.includes(data.status)) {
        stopPolling();
        return;
      }

      // Successful poll — reset interval
      currentIntervalRef.current = INITIAL_INTERVAL_MS;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Polling error';
      setError(message);
      // On error, back off more aggressively
      currentIntervalRef.current = Math.min(
        currentIntervalRef.current * 2,
        MAX_INTERVAL_MS,
      );
    }

    if (!isStoppedRef.current) {
      // Schedule next poll with current interval
      const nextInterval = Math.min(
        currentIntervalRef.current * BACKOFF_MULTIPLIER,
        MAX_INTERVAL_MS,
      );
      currentIntervalRef.current = nextInterval;
      intervalRef.current = setTimeout(() => { void poll(); }, nextInterval);
    }
  }, [jobId, stopPolling]);

  useEffect(() => {
    if (jobId === null) return;

    isStoppedRef.current = false;
    currentIntervalRef.current = INITIAL_INTERVAL_MS;
    setIsPolling(true);
    setError(null);

    // Start polling immediately
    void poll();

    return () => {
      isStoppedRef.current = true;
      if (intervalRef.current !== null) {
        clearTimeout(intervalRef.current);
      }
    };
  }, [jobId, poll]);

  return {
    status: response?.status ?? null,
    progress: response?.progress ?? 0,
    currentStage: response?.currentStage ?? '',
    result: response?.result ?? null,
    error,
    isPolling,
    stopPolling,
  };
}
