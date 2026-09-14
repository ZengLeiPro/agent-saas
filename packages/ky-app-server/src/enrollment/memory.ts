import { randomBytes } from 'node:crypto';

import type { EnrollmentAttempt, EnrollmentAttemptStore, EphemeralSecretStore } from './types.js';

export class MemoryEnrollmentAttemptStore implements EnrollmentAttemptStore {
  private readonly values = new Map<string, EnrollmentAttempt>();

  async create(attempt: EnrollmentAttempt): Promise<EnrollmentAttempt> {
    const current = this.values.get(attempt.operationId);
    if (current) return current;
    this.values.set(attempt.operationId, attempt);
    return attempt;
  }

  async get(operationId: string): Promise<EnrollmentAttempt | null> {
    return this.values.get(operationId) ?? null;
  }

  async getByStateHash(stateHash: string): Promise<EnrollmentAttempt | null> {
    return [...this.values.values()].find((value) => value.stateHash === stateHash) ?? null;
  }

  async beginExchange(operationId: string, now: number): Promise<boolean> {
    const current = this.values.get(operationId);
    if (
      !current ||
      (current.status !== 'pending' && current.status !== 'exchanging') ||
      current.expiresAt <= now
    )
      return false;
    this.values.set(operationId, { ...current, status: 'exchanging' });
    return true;
  }

  async finish(operationId: string, status: 'consumed' | 'failed'): Promise<void> {
    const current = this.values.get(operationId);
    if (!current || current.status !== 'exchanging') throw new Error('enrollment_attempt_conflict');
    this.values.set(operationId, { ...current, status });
  }
}

export class MemoryEphemeralSecretStore implements EphemeralSecretStore {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(value: string, expiresAt: number): Promise<string> {
    const ref = `memory:${randomBytes(16).toString('base64url')}`;
    this.values.set(ref, { value, expiresAt });
    return ref;
  }

  async get(ref: string): Promise<string | null> {
    const stored = this.values.get(ref);
    return stored && stored.expiresAt > this.now() ? stored.value : null;
  }

  async set(ref: string, value: string, expiresAt: number): Promise<void> {
    if (!this.values.has(ref)) throw new Error('secret_ref_not_found');
    this.values.set(ref, { value, expiresAt });
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
}
