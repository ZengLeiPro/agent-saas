import type { AcsOrchestratorConfig } from './config.js';
import type { LocalProcessResult } from './localProcessSupervisor.js';
import {
  OWNERSHIP_JOURNAL_NAME, OWNERSHIP_LIMITS, OWNERSHIP_PROTOCOL,
  OwnershipBlockedError, OwnershipUnavailableError, ownershipIsTerminal,
  validateOwnershipRecords, type OwnershipRecord,
} from './ownershipState.js';

interface JournalSnapshot {
  resourceVersion?: string;
  records: OwnershipRecord[];
}

/** The journal consumes an explicit transport result, not an assertion of remote stop. */
export interface OwnershipJournalTransport {
  run(args: string[], options?: { input?: string; timeoutMs?: number }): Promise<LocalProcessResult>;
}

/** Namespace-scoped, resourceVersion-CAS journal. No expiry authorizes ownership release. */
export class OwnershipJournal {
  private cached: OwnershipRecord[] = [];
  private available = false;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: AcsOrchestratorConfig, private readonly kubectl: OwnershipJournalTransport) {}

  snapshot(): { available: boolean; records: OwnershipRecord[] } {
    return { available: this.available, records: structuredClone(this.cached) };
  }

  async read(): Promise<OwnershipRecord[]> {
    return structuredClone((await this.readSnapshot()).records);
  }

  async reserve(record: OwnershipRecord, conflict: (existing: OwnershipRecord) => boolean): Promise<OwnershipRecord> {
    return await this.mutate((records) => {
      const existing = records.find((item) => item.operationId === record.operationId);
      if (existing) {
        if (existing.attemptId !== record.attemptId || existing.ownerId !== record.ownerId) throw new OwnershipBlockedError(existing.operationId);
        return { records, result: existing };
      }
      const blocking = records.find((item) => !ownershipIsTerminal(item) && conflict(item));
      if (blocking) throw new OwnershipBlockedError(blocking.operationId);
      // Only proved terminal records may be compacted. Unknown/running/background
      // records are never TTL-deleted, including under quota pressure.
      const retained = records.filter((item) => !ownershipIsTerminal(item));
      const recent = records.filter(ownershipIsTerminal).slice(-16);
      const next = [...retained, ...recent, record];
      if (next.length > OWNERSHIP_LIMITS.records) throw new OwnershipUnavailableError('Ownership capacity exhausted');
      return { records: next, result: record };
    });
  }

  async update(record: OwnershipRecord, expectedRevision: number): Promise<OwnershipRecord> {
    return await this.mutate((records) => {
      const index = records.findIndex((item) => item.operationId === record.operationId);
      const previous = records[index];
      if (!previous || previous.ownerId !== record.ownerId || previous.attemptId !== record.attemptId
        || previous.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
        throw new OwnershipBlockedError(record.operationId);
      }
      // A delayed renewal/update cannot turn a terminal receipt back into an owner.
      if (ownershipIsTerminal(previous) && !ownershipIsTerminal(record)) throw new OwnershipBlockedError(record.operationId);
      const next = [...records];
      next[index] = record;
      return { records: next, result: record };
    });
  }

  private async readSnapshot(): Promise<JournalSnapshot> {
    try {
      const result = await this.kubectl.run(['get', 'configmap', OWNERSHIP_JOURNAL_NAME, '--ignore-not-found', '-o', 'json'], { timeoutMs: 10_000 });
      if (result.exitCode !== 0 || result.remoteState === 'unknown') throw new OwnershipUnavailableError();
      if (!result.stdout.trim()) {
        this.cached = [];
        this.available = true;
        return { records: [] };
      }
      const raw = JSON.parse(result.stdout) as { metadata?: { resourceVersion?: unknown }; data?: Record<string, unknown> };
      const resourceVersion = raw.metadata?.resourceVersion;
      const encoded = raw.data?.['journal.json'];
      if (typeof resourceVersion !== 'string' || !resourceVersion || typeof encoded !== 'string') throw new OwnershipUnavailableError();
      const records = validateOwnershipRecords(JSON.parse(encoded));
      this.cached = structuredClone(records);
      this.available = true;
      return { resourceVersion, records };
    } catch {
      this.available = false;
      throw new OwnershipUnavailableError();
    }
  }

  private async mutate<T>(change: (records: OwnershipRecord[]) => { records: OwnershipRecord[]; result: T }): Promise<T> {
    const task = this.serial.then(async () => {
      for (let retry = 0; retry < 5; retry += 1) {
        const current = await this.readSnapshot();
        const next = change(current.records);
        const envelope = { protocolVersion: OWNERSHIP_PROTOCOL, records: next.records };
        validateOwnershipRecords(envelope);
        const body = {
          apiVersion: 'v1', kind: 'ConfigMap',
          metadata: {
            name: OWNERSHIP_JOURNAL_NAME, namespace: this.config.namespace,
            labels: { 'app.kubernetes.io/managed-by': 'agent-saas-acs' },
            ...(current.resourceVersion ? { resourceVersion: current.resourceVersion } : {}),
          },
          data: { 'journal.json': JSON.stringify(envelope) },
        };
        const result = await this.kubectl.run([current.resourceVersion ? 'replace' : 'create', '-f', '-'], {
          input: JSON.stringify(body), timeoutMs: 10_000,
        });
        if (result.exitCode === 0 && result.remoteState !== 'unknown') {
          this.cached = structuredClone(next.records);
          this.available = true;
          return next.result;
        }
        if (result.remoteState === 'unknown' || !/Conflict|AlreadyExists|already exists|object has been modified/i.test(result.stderr)) {
          this.available = false;
          throw new OwnershipUnavailableError('Ownership persistence result is unknown');
        }
      }
      throw new OwnershipUnavailableError('Ownership CAS retry budget exhausted');
    });
    this.serial = task.catch(() => undefined);
    return await task;
  }
}
