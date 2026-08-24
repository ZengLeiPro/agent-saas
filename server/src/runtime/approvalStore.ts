import { randomUUID } from 'crypto';
import { dirname, resolve } from 'node:path';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { appendTrustedFile, readTrustedFile, relativeToTrustedRoot } from '../security/trustedFile.js';
import type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStore,
  EventStore,
  PlatformEvent,
} from './types.js';

type ApprovalLogEntry =
  | { type: 'created'; record: ApprovalRecord }
  | { type: 'resolved'; id: string; decision: ApprovalDecision; resolvedAt: string; message?: string };

const approvalLocks = new Map<string, Promise<void>>();
const approvalReadsInFlight = new Map<string, Promise<string | null>>();

function defaultTrustedRoot(filePath: string): string {
  try {
    relativeToTrustedRoot(AGENT_LEGACY_TRANSCRIPTS_ROOT, filePath);
    return AGENT_LEGACY_TRANSCRIPTS_ROOT;
  } catch (error) {
    if (!process.argv.some((argument) => argument.includes('vitest'))) throw error;
    return dirname(filePath);
  }
}

export function getApprovalLogPath(transcriptPath: string): string {
  return transcriptPath.endsWith('.jsonl')
    ? transcriptPath.slice(0, -'.jsonl'.length) + '.approvals.jsonl'
    : `${transcriptPath}.approvals.jsonl`;
}

export class FileApprovalStore implements ApprovalStore {
  private readonly trustedRoot: string;
  private readonly relativePath: string;
  private readonly cacheKey: string;

  constructor(private readonly filePath: string, trustedRoot = defaultTrustedRoot(filePath)) {
    this.trustedRoot = trustedRoot;
    this.relativePath = relativeToTrustedRoot(trustedRoot, filePath);
    this.cacheKey = resolve(trustedRoot, this.relativePath);
  }

  async create(request: ApprovalRequest): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      ...request,
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.append({ type: 'created', record });
    return record;
  }

  async resolve(id: string, decision: ApprovalDecision, message?: string): Promise<void> {
    await this.append({
      type: 'resolved',
      id,
      decision,
      resolvedAt: new Date().toISOString(),
      ...(message ? { message } : {}),
    });
  }

  async resolvePending(id: string, decision: ApprovalDecision, message?: string): Promise<ApprovalRecord | null> {
    return this.withApprovalLock(id, async () => {
      const records = await this.readLatest();
      const existing = records.get(id);
      if (!existing || existing.status !== 'pending') return null;
      const resolvedAt = new Date().toISOString();
      await this.append({
        type: 'resolved',
        id,
        decision,
        resolvedAt,
        ...(message ? { message } : {}),
      });
      return {
        ...existing,
        status: decision,
        resolvedAt,
        ...(message ? { message } : {}),
      };
    });
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const records = await this.readLatest();
    return records.get(id) ?? null;
  }

  async list(sessionId?: string): Promise<ApprovalRecord[]> {
    const records = await this.readLatest();
    return [...records.values()].filter((record) =>
      !sessionId || record.sessionId === sessionId,
    );
  }

  async listPending(sessionId?: string): Promise<ApprovalRecord[]> {
    return (await this.list(sessionId)).filter((record) => record.status === 'pending');
  }

  private async append(entry: ApprovalLogEntry): Promise<void> {
    await appendTrustedFile(this.trustedRoot, this.relativePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  private async readLatest(): Promise<Map<string, ApprovalRecord>> {
    // 并发去重：与 FileEventStore 同源治理 EMFILE。
    let pending = approvalReadsInFlight.get(this.cacheKey);
    if (!pending) {
      pending = readTrustedFile(this.trustedRoot, this.relativePath, 'utf-8')
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        })
        .finally(() => approvalReadsInFlight.delete(this.cacheKey));
      approvalReadsInFlight.set(this.cacheKey, pending);
    }
    const raw = await pending;
    if (raw === null) return new Map();

    const records = new Map<string, ApprovalRecord>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: ApprovalLogEntry;
      try {
        entry = JSON.parse(trimmed) as ApprovalLogEntry;
      } catch {
        continue;
      }
      if (entry.type === 'created') {
        records.set(entry.record.id, entry.record);
      } else {
        const existing = records.get(entry.id);
        if (!existing) continue;
        records.set(entry.id, {
          ...existing,
          status: entry.decision,
          resolvedAt: entry.resolvedAt,
          ...(entry.message ? { message: entry.message } : {}),
        });
      }
    }
    return records;
  }

  private async withApprovalLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.filePath}:${id}`;
    const previous = approvalLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    approvalLocks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (approvalLocks.get(key) === chained) {
        approvalLocks.delete(key);
      }
    }
  }
}

export function buildApprovalRecordsFromEvents(
  events: PlatformEvent[],
  sessionId?: string,
): ApprovalRecord[] {
  const records = new Map<string, ApprovalRecord>();

  for (const event of events) {
    if (sessionId && 'sessionId' in event && event.sessionId !== sessionId) continue;
    if (event.type === 'approval_requested') {
      records.set(event.approvalId, {
        id: event.approvalId,
        sessionId: event.sessionId,
        runId: event.runId,
        toolCallId: event.toolCallId,
        toolId: event.toolId,
        toolName: event.toolName,
        displayName: event.displayName,
        executionTarget: event.executionTarget,
        input: event.input,
        status: 'pending',
        createdAt: event.timestamp,
      });
    } else if (event.type === 'approval_resolved') {
      const existing = records.get(event.approvalId);
      if (!existing) continue;
      records.set(event.approvalId, {
        ...existing,
        status: event.decision,
        resolvedAt: event.timestamp,
        ...(event.message ? { message: event.message } : {}),
      });
    }
  }

  return [...records.values()];
}

export class EventBackedApprovalStore implements ApprovalStore {
  constructor(
    private readonly eventStore: EventStore,
    private readonly sessionId: string,
    private readonly tenantId?: string,
  ) {}

  async create(request: ApprovalRequest): Promise<ApprovalRecord> {
    const id = randomUUID();
    const event = await this.append({
      type: 'approval_requested',
      runId: request.runId,
      sessionId: request.sessionId,
      approvalId: id,
      toolCallId: request.toolCallId,
      toolId: request.toolId,
      toolName: request.toolName,
      displayName: request.displayName,
      executionTarget: request.executionTarget,
      input: request.input,
    });
    return {
      ...request,
      id,
      status: 'pending',
      createdAt: event.timestamp,
    };
  }

  async resolve(id: string, decision: ApprovalDecision, message?: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    await this.append({
      type: 'approval_resolved',
      runId: existing.runId,
      sessionId: existing.sessionId,
      approvalId: id,
      decision,
      ...(message ? { message } : {}),
    });
  }

  async resolvePending(id: string, decision: ApprovalDecision, message?: string): Promise<ApprovalRecord | null> {
    return this.withApprovalLock(id, async () => {
      const existing = await this.get(id);
      if (!existing || existing.status !== 'pending') return null;
      const resolvedEvent = await this.append({
        type: 'approval_resolved',
        runId: existing.runId,
        sessionId: existing.sessionId,
        approvalId: id,
        decision,
        ...(message ? { message } : {}),
      });
      return {
        ...existing,
        status: decision,
        resolvedAt: resolvedEvent.timestamp,
        ...(message ? { message } : {}),
      };
    });
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    return (await this.list(this.sessionId)).find((record) => record.id === id) ?? null;
  }

  async list(sessionId = this.sessionId): Promise<ApprovalRecord[]> {
    const events = await this.eventStore.list(this.requireTenantId(), sessionId, {
      includeTypes: ['approval_requested', 'approval_resolved'],
    });
    return buildApprovalRecordsFromEvents(events, sessionId);
  }

  async listPending(sessionId = this.sessionId): Promise<ApprovalRecord[]> {
    return (await this.list(sessionId)).filter((record) => record.status === 'pending');
  }

  private append(event: Parameters<EventStore['append']>[0]): ReturnType<EventStore['append']> {
    return this.eventStore.append(event, { tenantId: this.requireTenantId() });
  }

  private requireTenantId(): string {
    if (!this.tenantId) throw new Error('EventBackedApprovalStore tenantId is required');
    return this.tenantId;
  }

  private async withApprovalLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const key = `event:${this.sessionId}:${id}`;
    const previous = approvalLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    approvalLocks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (approvalLocks.get(key) === chained) {
        approvalLocks.delete(key);
      }
    }
  }
}
