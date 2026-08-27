import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRawRuntimeRunDispatch } from '../runtime/rawRuntimeRunDispatch.js';
import { MemorySessionCatalog } from './runtimeStage2.testHelpers.js';

const SHARED_DIR = resolve(process.cwd(), '../workspace-shared');
const TENANT_ID = 'tenant-test';

describe('synchronous Web sandbox profile dispatch', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('pins a new session from inbound sandboxProfile metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-web-profile-pin-'));
    cleanupDirs.add(cwd);
    const sessionCatalog = new MemorySessionCatalog();
    const abortController = new AbortController();
    abortController.abort('test_complete_after_pin');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const dispatch = createRawRuntimeRunDispatch({
      agentCwd: cwd,
      sharedDir: SHARED_DIR,
      sessionCatalog,
      memory: { enabled: false },
    });
    let sessionId: string | undefined;
    for await (const event of dispatch(
      { channel: 'web', chatId: '', content: '同步 coding 首轮', metadata: { sandboxProfile: 'coding' } },
      { channel: 'web', user: { id: 'user-coding', username: 'coder', role: 'user', tenantId: TENANT_ID } },
      { abortController, modelConnection: { apiKey: 'sk-test' }, skipSystemPrompt: true, maxTurns: 1 },
    )) {
      if (event.type === 'session_init') sessionId = event.sessionId;
    }

    expect(sessionId).toBeTruthy();
    await expect(sessionCatalog.get(sessionId!)).resolves.toMatchObject({ sandboxProfile: 'coding' });
  });
});
