import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import { superviseLocalProcess, type LocalProcessResult } from './localProcessSupervisor.js';
import { waitForOwned } from './ownedWait.js';
import { OwnershipJournal, type OwnershipJournalTransport } from './ownershipJournal.js';
import { OwnedOperations } from './ownedOperations.js';
import {
  OwnershipBlockedError, OwnershipUnavailableError, scopesOverlap, validateOwnershipRecords,
  type OwnershipRecord, type WritableScope,
} from './ownershipState.js';

const config = { namespace: 'unit-test-only' } as AcsOrchestratorConfig;
const scope: WritableScope = {
  storageId: 'isolated-test-storage', mountSubPath: 'workspaces/a', sandboxName: 'as-unit',
  workspaceId: 'ws-unit', sessionId: 'session-unit', sandboxScopeId: 'scope-unit',
};
const record = (operationId = 'op-1'): OwnershipRecord => ({
  protocolVersion: 1, operationId, attemptId: `${operationId}:attempt`, invocationId: `${operationId}:invocation`,
  ownerId: 'test-owner', revision: 0, kind: 'invocation', scope,
  resource: 'reserved', outcome: 'pending', phase: 'reserved',
  createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
});
const result = (stdout = '', exitCode = 0, stderr = ''): LocalProcessResult => ({ stdout, stderr, exitCode, signal: null });

function processFixture() {
  return Object.assign(new EventEmitter(), {
    pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false, exitCode: null, signalCode: null,
    kill: vi.fn((_signal: string) => true),
  });
}

/** In-memory transport only. All journal parsing/CAS/admission logic is the real module. */
function journalFixture(initial: OwnershipRecord[] = []) {
  let revision = initial.length ? 1 : 0;
  let records = structuredClone(initial);
  const run = vi.fn<OwnershipJournalTransport['run']>(async (args, options) => {
    if (args[0] === 'get') {
      return result(revision ? JSON.stringify({ metadata: { resourceVersion: String(revision) },
        data: { 'journal.json': JSON.stringify({ protocolVersion: 1, records }) } }) : '');
    }
    const body = JSON.parse(options?.input ?? '{}');
    if (args[0] === 'create' && revision) return result('', 1, 'AlreadyExists');
    if (args[0] === 'replace' && body.metadata.resourceVersion !== String(revision)) return result('', 1, 'Conflict');
    records = JSON.parse(body.data['journal.json']).records;
    revision += 1;
    return result('persisted');
  });
  return { run, journal: new OwnershipJournal(config, { run }), records: () => structuredClone(records) };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('actual ownership primitives (new-module coverage, not baseline reproductions)', () => {
  it('detaching one waiter preserves its owner and another waiter', async () => {
    const controller = new AbortController();
    let complete!: (value: number) => void;
    const work = new Promise<number>((resolve) => { complete = resolve; });
    const one = waitForOwned(work, { phase: 'follower', signal: controller.signal });
    const two = waitForOwned(work, { phase: 'peer' });
    const rejected = expect(one).rejects.toMatchObject({ code: 'wait_cancelled' });
    controller.abort();
    await rejected;
    complete(42);
    expect(await two).toBe(42);
    expect(await work).toBe(42);
  });

  it('observes late owner rejection after the waiter deadline', async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const work = new Promise<never>((_resolve, reject) => { fail = reject; });
    const waiting = waitForOwned(work, { phase: 'late-owner', timeoutMs: 10 });
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'wait_timed_out' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    fail(new Error('late owner result'));
    await Promise.resolve();
  });

  it('escalates local TERM to KILL without claiming remote death', async () => {
    vi.useFakeTimers();
    const child = processFixture();
    const waiting = superviseLocalProcess(child as unknown as ChildProcessWithoutNullStreams, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(4_010);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await waiting).toMatchObject({ exitCode: -1, remoteState: 'unknown', reason: 'timeout' });
  });

  it('bounds inherited stdio even when the parent exits with code zero', async () => {
    vi.useFakeTimers();
    const child = processFixture();
    const waiting = superviseLocalProcess(child as unknown as ChildProcessWithoutNullStreams);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await waiting).toMatchObject({ exitCode: -1, remoteState: 'unknown', reason: 'stdio_timeout' });
  });

  it('retains UTF-8 decoder state across local output chunks', async () => {
    const child = processFixture();
    const waiting = superviseLocalProcess(child as unknown as ChildProcessWithoutNullStreams);
    const bytes = Buffer.from('中文事件');
    child.stdout.write(bytes.subarray(0, 1));
    child.stdout.write(bytes.subarray(1, 5));
    child.stdout.write(bytes.subarray(5));
    child.emit('close', 0, null);
    expect((await waiting).stdout).toBe('中文事件');
  });

  it('does not confuse path ancestors with string-prefix siblings or other storage', () => {
    expect(scopesOverlap(scope, { ...scope, mountSubPath: 'workspaces/a/nested' })).toBe(true);
    expect(scopesOverlap(scope, { ...scope, mountSubPath: 'workspaces/ab' })).toBe(false);
    expect(scopesOverlap(scope, { ...scope, storageId: 'different-storage' })).toBe(false);
  });

  it('rejects future journal protocols instead of treating them as empty', () => {
    expect(() => validateOwnershipRecords({ protocolVersion: 2, records: [] })).toThrow(OwnershipUnavailableError);
  });

  it('retains an old unresolved record and rejects overlapping ownership', async () => {
    const old = { ...record(), resource: 'unknown' as const };
    const fixture = journalFixture([old]);
    await expect(fixture.journal.reserve(record('op-2'), (existing) => scopesOverlap(existing.scope, scope)))
      .rejects.toBeInstanceOf(OwnershipBlockedError);
    expect(fixture.records()).toEqual([old]);
  });

  it('treats forbidden inventory as unavailable, never as no owners', async () => {
    const run = vi.fn<OwnershipJournalTransport['run']>(async () => result('', 1, 'Forbidden'));
    const journal = new OwnershipJournal(config, { run });
    await expect(journal.read()).rejects.toBeInstanceOf(OwnershipUnavailableError);
    expect(journal.snapshot().available).toBe(false);
  });

  it('does not retry an ambiguously committed mutation as a fresh reservation', async () => {
    const run = vi.fn<OwnershipJournalTransport['run']>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce({ ...result('', -1), remoteState: 'unknown' });
    const journal = new OwnershipJournal(config, { run });
    await expect(journal.reserve(record(), () => false)).rejects.toBeInstanceOf(OwnershipUnavailableError);
    expect(run.mock.calls.length).toBe(2);
  });

  it('rejects a stale attempt revision and terminal-to-running resurrection', async () => {
    const fixture = journalFixture([record()]);
    const stopped: OwnershipRecord = { ...record(), revision: 1, resource: 'stopped', outcome: 'success' };
    await fixture.journal.update(stopped, 0);
    await expect(fixture.journal.update({ ...record(), revision: 1 }, 0)).rejects.toBeInstanceOf(OwnershipBlockedError);
    await expect(fixture.journal.update({ ...record(), revision: 2, resource: 'running' }, 1)).rejects.toBeInstanceOf(OwnershipBlockedError);
  });

  it('does not settle an outcome merely because cancellation was requested', async () => {
    const owners = new OwnedOperations();
    const operation = await owners.begin({ kind: 'invocation', invocationId: 'logical', attemptId: 'attempt', scope });
    operation.requestCancel();
    expect(operation.record.outcome).toBe('pending');
    await operation.complete('success', { kind: 'never_dispatched', attemptId: 'attempt' }, 'not_started');
    expect(operation.record.outcome).toBe('success');
    expect(operation.requestCancel().requested).toBe(false);
  });

  it('does not erase an unknown blocker when a timed-out persistence call later succeeds', async () => {
    vi.useFakeTimers();
    let finish!: (value: OwnershipRecord) => void;
    let attempted!: OwnershipRecord;
    const journal = {
      reserve: async (value: OwnershipRecord) => value,
      update: async (value: OwnershipRecord) => {
        attempted = value;
        return await new Promise<OwnershipRecord>((resolve) => { finish = resolve; });
      },
      snapshot: () => ({ available: true, records: [] }),
    } as unknown as OwnershipJournal;
    const owners = new OwnedOperations(journal);
    const operation = await owners.begin({ kind: 'invocation', invocationId: 'late', attemptId: 'late-attempt', scope });
    const updating = operation.update({ resource: 'running', phase: 'dispatch' });
    const rejected = expect(updating).rejects.toMatchObject({ code: 'wait_timed_out' });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(operation.record.resource).toBe('unknown');
    finish(attempted);
    await vi.advanceTimersByTimeAsync(0);
    expect(operation.record.resource).toBe('unknown');
    expect(owners.drainBlockers()).toBe(1);
  });

  it('keeps a local truthful blocker when durable reservation fails', async () => {
    const run = vi.fn<OwnershipJournalTransport['run']>(async () => result('', 1, 'Forbidden'));
    const owners = new OwnedOperations(new OwnershipJournal(config, { run }));
    await expect(owners.begin({ kind: 'invocation', invocationId: 'logical', attemptId: 'attempt', scope }))
      .rejects.toBeInstanceOf(OwnershipUnavailableError);
    // One unresolved owner plus one unavailable-journal blocker.
    expect(owners.drainBlockers()).toBe(2);
    expect(owners.records()[0]?.resource).toBe('unknown');
  });
});
