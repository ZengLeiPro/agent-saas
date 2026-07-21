import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRuntime } from '../app/runtime.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import type { GuardrailModelConfig } from '../agent/guardrail.js';
import { InMemoryWorkflowDemoStore } from '../data/workflowDemos/store.js';

async function createFixture(config: unknown): Promise<{ rootDir: string; processCwd: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-runtime-cov-'));
  const processCwd = join(rootDir, 'server');
  await mkdir(processCwd, { recursive: true });
  await writeFile(join(rootDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  return { rootDir, processCwd };
}

describe('createRuntime 运行时装配（补充分支）', () => {
  const cleanupRoots = new Set<string>();
  afterEach(async () => {
    for (const root of cleanupRoots) await rm(root, { recursive: true, force: true });
    cleanupRoots.clear();
  });

  it('processRole 缺省为 all，可显式指定 ws-only', async () => {
    const { rootDir, processCwd } = await createFixture({ agent: {}, server: {} });
    cleanupRoots.add(rootDir);

    const runtimeAll = await createRuntime({ processCwd });
    expect(runtimeAll.processRole).toBe('all');

    const { rootDir: r2, processCwd: cwd2 } = await createFixture({ agent: {}, server: {} });
    cleanupRoots.add(r2);
    const runtimeWs = await createRuntime({ processCwd: cwd2, processRole: 'ws-only' });
    expect(runtimeWs.processRole).toBe('ws-only');
  });

  it('guardrail 配置缺省时门禁模型链为空数组；updateGuardrailModelConfigs 热写后 getter 取到最新链（同一 getter 引用不失效）', async () => {
    const { rootDir, processCwd } = await createFixture({ agent: {}, server: {} });
    cleanupRoots.add(rootDir);
    const runtime = await createRuntime({ processCwd });

    // 未配置 guardrail → 空数组（门禁模块 fail-open 不激活）
    expect(runtime.getGuardrailModelConfigs()).toEqual([]);

    const getter = runtime.getGuardrailModelConfigs;
    const next: GuardrailModelConfig[] = [
      { model: 'glm-5.2', connection: { apiKey: 'sk-x', baseUrl: 'https://x/v1' } },
    ];
    runtime.updateGuardrailModelConfigs(next);

    // 关键不变量：捕获旧 getter 引用后仍能读到热更后的链（避免 stale 数组引用坑）
    expect(getter()).toEqual(next);
    expect(runtime.getGuardrailModelConfigs()).toEqual(next);
  });

  it('无 auth（开发形态）时 skills warmup 直接判定为 done，runDeferredStartupTasks 无任务可跑', async () => {
    const { rootDir, processCwd } = await createFixture({ agent: {}, server: {} });
    cleanupRoots.add(rootDir);
    const runtime = await createRuntime({ processCwd });

    // 无 userStore → 无多用户物化需求 → 直接 done（runtime.ts:773-775）
    expect(runtime.getSkillsWarmupStatus()).toEqual({ state: 'done' });
    // getSkillsWarmupStatus 返回快照拷贝（{ ...skillsWarmup }），互不别名
    expect(runtime.getSkillsWarmupStatus()).not.toBe(runtime.getSkillsWarmupStatus());

    await runtime.runDeferredStartupTasks();
    // 无 auth → deferredStartupTasks 里没有 skills-warmup 任务 → 状态不变
    expect(runtime.getSkillsWarmupStatus().state).toBe('done');
  });

  it('runtimeEventStoreFor（file backend）为每个 transcriptPath 构造 FileEventStore', async () => {
    const { rootDir, processCwd } = await createFixture({ agent: {}, server: {} });
    cleanupRoots.add(rootDir);
    const runtime = await createRuntime({ processCwd });

    const store = runtime.runtimeEventStoreFor(join(processCwd, 'workspace', 'alice', 'session.jsonl'));
    expect(store).toBeInstanceOf(FileEventStore);
    // 空 session 读回空列表（验证是可用的真实 store，不是占位对象）
    await expect(store.list('nonexistent-session')).resolves.toEqual([]);
  });

  it('memory 缺省启用：getMemoryIndexService 存在且当前无 PG backend 时返回 null（file backend 不建索引服务）', async () => {
    const { rootDir, processCwd } = await createFixture({ agent: {}, server: {} });
    cleanupRoots.add(rootDir);
    const runtime = await createRuntime({ processCwd });

    expect(typeof runtime.getMemoryIndexService).toBe('function');
    // file backend + 未配 memory.index → memoryIndexServiceRef.current 为 null
    expect(runtime.getMemoryIndexService?.()).toBeNull();
  });

  it('装配出基础目录与 groupStore / sessionShareStore / dispatchMetricsStore 等必备句柄', async () => {
    const { rootDir, processCwd } = await createFixture({
      agent: { cwd: './workspace' },
      server: {},
    });
    cleanupRoots.add(rootDir);
    const runtime = await createRuntime({ processCwd });

    expect(runtime.agentCwd).toBe(join(processCwd, 'workspace'));
    expect(existsSync(runtime.agentCwd)).toBe(true);
    expect(runtime.tenantSkillsRootDir).toBe(join(processCwd, 'data', 'tenant-skills'));
    // 这些 store 无论 backend 都必装（AppRuntime 非可选字段）
    expect(runtime.groupStore).toBeTruthy();
    expect(runtime.sessionShareStore).toBeTruthy();
    expect(runtime.workflowDemoStore).toBeInstanceOf(InMemoryWorkflowDemoStore);
    expect(runtime.dispatchMetricsStore).toBeTruthy();
    // file backend → 不应有 PG-only 句柄
    expect(runtime.runtimePgEventStore).toBeUndefined();
    expect(runtime.billingService).toBeUndefined();
  });
});
