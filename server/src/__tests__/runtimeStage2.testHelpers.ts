import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';

export class MemorySessionCatalog implements SessionCatalog {
  private readonly records = new Map<string, RuntimeSessionRecord>();

  async upsert(record: RuntimeSessionRecord): Promise<void> {
    this.records.set(record.sessionId, record);
  }

  async ensure(record: RuntimeSessionRecord): Promise<void> {
    if (!this.records.has(record.sessionId)) this.records.set(record.sessionId, record);
  }

  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    return this.records.get(sessionId) ?? null;
  }

  async markStatus(sessionId: string, status: RuntimeSessionRecord['status']): Promise<void> {
    const existing = this.records.get(sessionId);
    if (existing) this.records.set(sessionId, { ...existing, status, updatedAt: new Date().toISOString() });
  }

  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return this.records.get(sessionId)?.transcriptPath ?? null;
  }
}
