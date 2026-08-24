import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadToolDescription } from '../agent/tools/descriptionLoader.js';
import { parseAppConfig, type AppConfig } from '../app/config.js';
import { createSharedConfigRefresher } from '../app/sharedConfigRefresher.js';
import {
  createRawApprovalResumeDispatch,
  createRawInteractionResumeDispatch,
  createRawRuntimeRunDispatch,
  wakeRuntimeSession,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatchTypes.js';
import type { RunRecord } from '../runtime/runStore.js';
import { TextOnlyAdapter } from './helpers/subagentModelAdapters.js';

const SHARED_DIR = resolve(process.cwd(), '../workspace-shared');
const REPLACEMENT = '只写入管理员批准的交付文件。';

function rawConfig(toolControls?: AppConfig['toolControls'], timezone = 'UTC') {
  return {
    agent: { cwd: './workspace' },
    server: { timezone },
    ...(toolControls ? { toolControls } : {}),
  };
}

async function consume(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // 只需驱动真实 dispatch 完成。
  }
}

describe('runtime toolControls shared refresh', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('显式 modelConnection 的普通 Run 在执行边界应用替换并在清除后恢复默认描述', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-tool-controls-refresh-'));
    cleanupDirs.add(root);
    const processCwd = join(root, 'server');
    const agentCwd = join(root, 'workspace');
    const configPath = join(root, 'config.json');
    await mkdir(processCwd, { recursive: true });
    await mkdir(agentCwd, { recursive: true });
    await writeFile(configPath, JSON.stringify(rawConfig(), null, 2), 'utf-8');

    const appConfig = parseAppConfig(rawConfig());
    const refresher = createSharedConfigRefresher({
      config: appConfig,
      processCwd,
      target: { updateGuardrailModelConfigs: () => {} },
      minStatIntervalMs: 0,
    });
    const adapter = new TextOnlyAdapter('完成');
    let dispatchConfig: RawRuntimeRunDispatchConfig;
    dispatchConfig = {
      agentCwd,
      sharedDir: SHARED_DIR,
      memory: { enabled: false },
      modelAdapterFactory: () => adapter,
      toolControls: appConfig.toolControls,
      refreshSharedConfig: () => {
        refresher.refreshIfChanged();
        dispatchConfig.toolControls = appConfig.toolControls;
      },
    };
    const dispatch = createRawRuntimeRunDispatch(dispatchConfig);
    const run = (chatId: string) => consume(dispatch(
      { channel: 'web', chatId, content: '检查工具描述' },
      { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: 'tenant-tool-controls' } },
      {
        modelConnection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid' },
        executionTarget: 'server-local',
        skipSystemPrompt: true,
        maxTurns: 1,
      },
    ));

    const replacement = {
      tools: {
        Write: { descriptionOverride: { mode: 'replace' as const, text: REPLACEMENT } },
      },
    } satisfies NonNullable<AppConfig['toolControls']>;
    await writeFile(configPath, JSON.stringify(rawConfig(replacement), null, 2), 'utf-8');
    await run('replace-description');

    expect(adapter.requests.at(-1)?.tools.find((tool) => tool.name === 'Write')?.description)
      .toBe(REPLACEMENT);

    await writeFile(configPath, JSON.stringify(rawConfig(undefined, 'Asia/Shanghai'), null, 2), 'utf-8');
    await run('clear-description');

    expect(adapter.requests.at(-1)?.tools.find((tool) => tool.name === 'Write')?.description)
      .toBe(loadToolDescription('Write'));
  });

  it('approval resume、interaction resume 与 scheduler wake 都先刷新共享配置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-refresh-boundaries-'));
    cleanupDirs.add(root);
    const refreshSharedConfig = vi.fn();
    const config: RawRuntimeRunDispatchConfig = {
      agentCwd: root,
      sharedDir: SHARED_DIR,
      refreshSharedConfig,
    };

    await consume(createRawApprovalResumeDispatch(config)({
      context: { channel: 'cron' },
    } as never));
    await consume(createRawInteractionResumeDispatch(config)({
      context: { channel: 'cron' },
    } as never));
    const missingRun: RunRecord = {
      runId: 'run-missing',
      sessionId: 'session-missing',
      status: 'pending',
      requestedAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      metadata: {},
    };
    await expect(wakeRuntimeSession(config, missingRun)).rejects.toThrow('session metadata not found');

    expect(refreshSharedConfig).toHaveBeenCalledTimes(3);
  });
});
