import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addSessionCost,
  flushSessionMetaProjectionForTests,
  notifySessionMetaDeleted,
  setSessionMetaProjectionSink,
  updateSessionMeta,
  writeSessionMeta,
  type SessionMeta,
} from '../data/transcripts/meta.js';
import { getAgentTranscriptDir } from '../data/transcripts/projectKey.js';
import { deleteSession } from '../data/transcripts/store.js';
import {
  buildRuntimeSessionProjectionRecord,
  scanRuntimeSessionMetaFiles,
  type RuntimeSessionProjectionRecord,
} from '../runtime/sessionProjectionStore.js';

describe('runtime session projection hook', () => {
  const cleanupDirs = new Set<string>();
  let projected: Map<string, RuntimeSessionProjectionRecord>;

  beforeEach(() => {
    projected = new Map();
    setSessionMetaProjectionSink({
      upsert: async (transcriptPath, meta) => {
        const cost = meta.totalCostUsd ?? 0;
        await sleep(Math.max(0, 20 - cost));
        const record = buildRuntimeSessionProjectionRecord(transcriptPath, meta);
        if (record) projected.set(record.sessionId, record);
      },
      delete: async (sessionId) => {
        await sleep(1);
        projected.delete(sessionId);
      },
    });
  });

  afterEach(async () => {
    setSessionMetaProjectionSink(undefined);
    await flushSessionMetaProjectionForTests();
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('serializes high-frequency addSessionCost projections so the final total wins', async () => {
    const { sessionId, transcriptPath, dir } = await makeTempTranscript();
    cleanupDirs.add(dir);
    await writeSessionMeta(transcriptPath, baseMeta({ tenantId: 'kaiyan' }));

    await Promise.all(Array.from({ length: 20 }, () => addSessionCost(transcriptPath, 0.25)));
    await flushSessionMetaProjectionForTests();

    expect(projected.get(sessionId)).toMatchObject({
      sessionId,
      tenantId: 'kaiyan',
      totalCostUsd: 5,
    });
  });

  it('syncs soft delete and restore transitions', async () => {
    const { sessionId, transcriptPath, dir } = await makeTempTranscript();
    cleanupDirs.add(dir);
    const meta = baseMeta({ tenantId: 'kaiyan' });
    await writeSessionMeta(transcriptPath, meta);

    const deletedAt = '2026-07-06T12:00:00.000Z';
    await updateSessionMeta(transcriptPath, { deletedAt, deletedBy: 'alice' });
    await flushSessionMetaProjectionForTests();
    expect(projected.get(sessionId)?.deletedAt).toBe(deletedAt);

    await writeSessionMeta(transcriptPath, meta);
    await flushSessionMetaProjectionForTests();
    expect(projected.get(sessionId)?.deletedAt).toBeUndefined();
  });

  it('removes ghost sessions after create-then-delete rollback', async () => {
    const tenantId = 'tprojtest';
    const userId = 'kyprojectiontest';
    const sessionId = randomUUID();
    const dir = getAgentTranscriptDir({ tenantId, userId });
    cleanupDirs.add(join(dir, '..'));
    await mkdir(dir, { recursive: true });
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, '');
    await writeSessionMeta(transcriptPath, baseMeta({ tenantId, userId }));
    await flushSessionMetaProjectionForTests();
    expect(projected.has(sessionId)).toBe(true);

    await deleteSession(sessionId, { deleteSidecarDir: true });
    await flushSessionMetaProjectionForTests();

    expect(projected.has(sessionId)).toBe(false);
  });

  it('handles startup-style bulk meta writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-session-bulk-'));
    cleanupDirs.add(dir);

    for (let i = 0; i < 1000; i++) {
      const sessionId = randomUUID();
      await writeSessionMeta(join(dir, `${sessionId}.jsonl`), baseMeta({ tenantId: 'kaiyan', userId: `kybulk${i}` }));
    }
    await flushSessionMetaProjectionForTests();

    expect(projected.size).toBe(1000);
  });

  it('skips invalid basenames but keeps subagent session ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-session-invalid-'));
    cleanupDirs.add(dir);

    await writeSessionMeta(join(dir, 'agent-deadbeef.jsonl'), baseMeta({ tenantId: 'kaiyan' }));
    const subSessionId = `sub-${randomUUID()}`;
    await writeSessionMeta(join(dir, `${subSessionId}.jsonl`), {
      ...baseMeta({ tenantId: 'kaiyan' }),
      kind: 'subagent',
    });
    notifySessionMetaDeleted('agent-deadbeef');
    await flushSessionMetaProjectionForTests();

    expect(projected.has('agent-deadbeef')).toBe(false);
    expect(projected.get(subSessionId)).toMatchObject({
      sessionId: subSessionId,
      kind: 'subagent',
    });
  });
});

describe('runtime session projection scanner', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('counts valid, subagent and invalid meta files during backfill scans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-session-scan-'));
    cleanupDirs.add(root);
    const userDir = join(root, 'kaiyan', 'kyu1');
    await mkdir(userDir, { recursive: true });
    const sessionId = randomUUID();
    const subSessionId = `sub-${randomUUID()}`;
    await writeFile(join(userDir, `${sessionId}.meta.json`), JSON.stringify(baseMeta({ tenantId: 'kaiyan' })));
    await writeFile(join(userDir, `${subSessionId}.meta.json`), JSON.stringify({ ...baseMeta({ tenantId: 'kaiyan' }), kind: 'subagent' satisfies SessionMeta['kind'] }));
    await writeFile(join(userDir, 'agent-deadbeef.meta.json'), JSON.stringify(baseMeta({ tenantId: 'kaiyan' })));

    const scan = await scanRuntimeSessionMetaFiles(root);

    expect(scan.scannedMetaFiles).toBe(3);
    expect(scan.skippedInvalidBasename).toBe(1);
    expect(scan.files.map((file) => file.sessionId).sort()).toEqual([sessionId, subSessionId].sort());
  });
});

async function makeTempTranscript(): Promise<{ sessionId: string; transcriptPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-session-projection-'));
  const sessionId = randomUUID();
  return { sessionId, transcriptPath: join(dir, `${sessionId}.jsonl`), dir };
}

function baseMeta(input: { tenantId: string; userId?: string }): SessionMeta {
  return {
    userId: input.userId ?? 'kyuser123',
    username: 'alice',
    tenantId: input.tenantId,
    channel: 'web',
    createdAt: '2026-07-06T10:00:00.000Z',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
