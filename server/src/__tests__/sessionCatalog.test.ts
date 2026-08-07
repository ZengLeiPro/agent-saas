import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimeSessionRecord,
  FileSessionCatalog,
} from '../runtime/sessionCatalog.js';

describe('FileSessionCatalog', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('restores sessions from meta before the legacy transcript exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-catalog-meta-'));
    cleanupDirs.add(cwd);

    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId,
      userId: 'user-1',
      username: 'alice',
      userRole: 'admin',
      channel: 'web',
      cwd,
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      status: 'running',
    });
    cleanupDirs.add(dirname(record.transcriptPath));

    await catalog.upsert(record);

    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      sessionId,
      userId: 'user-1',
      username: 'alice',
      userRole: 'admin',
      channel: 'web',
      cwd,
      transcriptPath: record.transcriptPath,
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      status: 'running',
    });
  });

  it('ensure only creates the first session meta and never regresses a terminal status', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-catalog-ensure-'));
    cleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId,
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd,
      status: 'running',
    });
    cleanupDirs.add(dirname(record.transcriptPath));

    await Promise.all([catalog.ensure(record), catalog.ensure(record)]);
    await catalog.markStatus(sessionId, 'finished');
    await catalog.ensure({ ...record, username: 'stale-worker', status: 'running' });

    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      username: 'alice',
      status: 'finished',
    });
  });
});
