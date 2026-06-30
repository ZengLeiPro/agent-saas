import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRuntime } from '../app/runtime.js';

async function createFixture(config: unknown): Promise<{ rootDir: string; processCwd: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-runtime-test-'));
  const processCwd = join(rootDir, 'server');
  await mkdir(processCwd, { recursive: true });
  await writeFile(join(rootDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  return { rootDir, processCwd };
}

describe('createRuntime', () => {
  const cleanupRoots = new Set<string>();

  afterEach(async () => {
    for (const root of cleanupRoots) {
      await rm(root, { recursive: true, force: true });
    }
    cleanupRoots.clear();
  });

  it('assembles runtime with web channel and cron enabled by default', async () => {
    const { rootDir, processCwd } = await createFixture({
      agent: {
        cwd: './workspace',
        maxTurns: 12,
      },
      server: {
        timezone: 'Asia/Shanghai',
      },
    });
    cleanupRoots.add(rootDir);

    const runtime = await createRuntime({ processCwd });

    expect(runtime.processCwd).toBe(processCwd);
    expect(runtime.sessionBasePath).toBe(processCwd);
    expect(runtime.agentCwd).toBe(join(processCwd, 'workspace'));
    expect(runtime.uploadsDir).toBe(join(processCwd, 'workspace', 'uploads'));
    expect(existsSync(runtime.agentCwd)).toBe(true);
    expect(runtime.agentOptionsConfig.agent).toEqual(runtime.config.agent);
    expect(runtime.agentOptionsConfig.sharedDir).toBe(runtime.sharedDir);
    expect(runtime.channelManager.getChannel('web')).toBeDefined();
    expect(runtime.channelManager.getChannel('dingtalk')).toBeUndefined();
    expect(runtime.cronRuntime.enabled).toBe(true);
    expect(runtime.cronRuntime.service).toBeTruthy();
  });

  it('registers dingtalk channel and disables cron when configured', async () => {
    const { rootDir, processCwd } = await createFixture({
      agent: {},
      server: {},
      cron: { enabled: false },
      dingtalk: {
        enabled: true,
        mode: 'webhook',
        robots: {
          demo: {
            name: 'demo',
            appKey: 'test-app-key',
            appSecret: 'test-app-secret',
          },
        },
      },
    });
    cleanupRoots.add(rootDir);

    const runtime = await createRuntime({ processCwd });

    expect(runtime.channelManager.getChannel('web')).toBeDefined();
    expect(runtime.channelManager.getChannel('dingtalk')).toBeDefined();
    expect(runtime.cronRuntime.enabled).toBe(false);
    expect(runtime.cronRuntime.service).toBeNull();
  });

  it('throws readable error when dingtalk is enabled but robots are missing', async () => {
    const { rootDir, processCwd } = await createFixture({
      agent: {},
      server: {},
      dingtalk: {
        enabled: true,
        mode: 'webhook',
      },
    });
    cleanupRoots.add(rootDir);

    await expect(createRuntime({ processCwd })).rejects.toThrowError(/dingtalk\.robots/);
  });

  it('normalizes legacy dingtalk appKey/appSecret into robots', async () => {
    const { rootDir, processCwd } = await createFixture({
      agent: {},
      server: {},
      dingtalk: {
        enabled: true,
        mode: 'webhook',
        appKey: 'legacy-app-key',
        appSecret: 'legacy-app-secret',
      },
    });
    cleanupRoots.add(rootDir);

    const runtime = await createRuntime({ processCwd });

    expect(runtime.channelManager.getChannel('dingtalk')).toBeDefined();
    expect(runtime.config.dingtalk?.robots?.['legacy-app-key']).toMatchObject({
      name: 'legacy-app-key',
      appKey: 'legacy-app-key',
      appSecret: 'legacy-app-secret',
    });
  });
});
