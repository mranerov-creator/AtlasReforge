/**
 * Registry Store
 *
 * In-memory session store for RegistrySession objects.
 * In production this is backed by Redis (the NestJS layer injects a Redis
 * adapter). This in-memory implementation is used for:
 *   - Unit tests (no Redis dependency)
 *   - Single-instance development
 *   - The store interface is the contract Redis must satisfy
 *
 * EPHEMERAL PRINCIPLE:
 *   Sessions expire after 24h. Code is never persisted.
 *   On expiry, the session is gone — user must re-upload.
 */

import type { RegistrySession } from '../types/registry.types.js';

export interface RegistryStore {
  get(sessionId: string): Promise<RegistrySession | null>;
  set(session: RegistrySession): Promise<void>;
  delete(sessionId: string): Promise<void>;
  exists(sessionId: string): Promise<boolean>;
}

// ─── In-memory implementation (dev + tests) ───────────────────────────────────

interface StoredEntry {
  session: RegistrySession;
  expiresAt: number;    // Unix timestamp ms
}

export class InMemoryRegistryStore implements RegistryStore {
  private readonly store = new Map<string, StoredEntry>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly evictionIntervalMs = 60_000) {
    // Run eviction check every minute
    this.evictionTimer = setInterval(() => {
      this.evict();
    }, this.evictionIntervalMs);

    // Allow Node to exit even if timer is still running
    if (typeof this.evictionTimer.unref === 'function') {
      this.evictionTimer.unref();
    }
  }

  async get(sessionId: string): Promise<RegistrySession | null> {
    const entry = this.store.get(sessionId);
    if (entry === undefined) return null;

    // Lazy eviction on read
    if (Date.now() > entry.expiresAt) {
      this.store.delete(sessionId);
      return null;
    }

    return entry.session;
  }

  async set(session: RegistrySession): Promise<void> {
    const expiresAt = new Date(session.expiresAt).getTime();
    this.store.set(session.sessionId, { session, expiresAt });
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  async exists(sessionId: string): Promise<boolean> {
    const session = await this.get(sessionId);
    return session !== null;
  }

  /** Returns active session count — useful for tests and monitoring. */
  size(): number {
    this.evict();
    return this.store.size;
  }

  /** Force-evict all expired sessions. */
  evict(): void {
    const now = Date.now();
    for (const [id, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(id);
      }
    }
  }

  /** Clear all sessions — used in tests. */
  clear(): void {
    this.store.clear();
  }

  destroy(): void {
    if (this.evictionTimer !== null) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.store.clear();
  }
}
