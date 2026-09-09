import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OwnedOperations } from './ownedOperations.js';
import type { OwnershipJournal } from './ownershipJournal.js';

interface DiagnosticsOptions {
  authorize(req: IncomingMessage, res: ServerResponse): boolean;
  operations: OwnedOperations;
  journal: OwnershipJournal;
  counts(): { requests: number; recovery: number; draining: boolean };
}

/** Snapshots only: this route never calls health, kubectl, a remote tool or a database. */
export function handleOperationDiagnostics(req: IncomingMessage, res: ServerResponse, options: DiagnosticsOptions): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== '/diagnostics/drain' && path !== '/operations' && !/^\/operations\/[^/]+(?:\/cancel)?$/.test(path)) return false;
  if (!options.authorize(req, res)) return true;
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const snapshots = options.operations.snapshot();
  if (req.method === 'GET' && path === '/diagnostics/drain') {
    const journal = options.journal.snapshot();
    send(200, {
      protocolVersion: 1, ...options.counts(), ownedWork: options.operations.drainBlockers(),
      httpWaiters: snapshots.reduce((sum, item) => sum + item.waiters, 0),
      journalAvailable: journal.available,
      persistedUnresolved: journal.records.filter((item) => !['stopped', 'not_started', 'background_owned'].includes(item.resource)).length,
      blockers: snapshots.filter((item) => !['stopped', 'not_started'].includes(item.resource)).slice(0, 50),
    });
    return true;
  }
  if (req.method === 'GET' && path === '/operations') {
    send(200, { protocolVersion: 1, total: snapshots.length, operations: snapshots.slice(0, 50), truncated: snapshots.length > 50 });
    return true;
  }
  const id = path.split('/')[2];
  const operation = id ? options.operations.get(id) : undefined;
  if (!operation) { send(404, { error: 'operation_not_found' }); return true; }
  if (req.method === 'GET' && !path.endsWith('/cancel')) {
    send(200, snapshots.find((item) => item.operationId === id));
    return true;
  }
  if (req.method === 'POST' && path.endsWith('/cancel')) {
    const attempt = req.headers['x-acs-attempt-id'];
    if (typeof attempt !== 'string' || attempt !== operation.record.attemptId) {
      send(409, { error: 'attempt_fence_mismatch' });
      return true;
    }
    const result = operation.requestCancel();
    send(202, { operationId: id, attemptId: attempt, ...result, remoteStopped: false });
    return true;
  }
  send(405, { error: 'method_not_allowed' });
  return true;
}
