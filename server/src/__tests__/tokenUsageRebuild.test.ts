import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getBusinessDb, __resetBusinessDbForTest } from '../data/db/business.js';
import { runBusinessMigrations } from '../data/db/migrations.js';
import { createTokenUsageStore } from '../data/usage/store.js';
import {
  rebuildTokenUsageFromJsonl,
  parseUsernameFromProjectKey,
  resetRebuildState,
} from '../data/usage/rebuildFromJsonl.js';

describe('parseUsernameFromProjectKey', () => {
  const prefix = '-Users-admin-workspace-';

  it('parses simple username', () => {
    expect(parseUsernameFromProjectKey('-Users-admin-workspace-zenglei', prefix)).toBe('zenglei');
  });

  it('rejects non-matching projectKey', () => {
    expect(parseUsernameFromProjectKey('-Users-admin-code-agent', prefix)).toBeNull();
  });

  it('rejects username with non-alphanumeric chars', () => {
    expect(parseUsernameFromProjectKey('-Users-admin-workspace-some-subdir', prefix)).toBeNull();
  });

  it('accepts underscore in username', () => {
    expect(parseUsernameFromProjectKey('-Users-admin-workspace-foo_bar', prefix)).toBe('foo_bar');
  });

  it('rejects empty tail', () => {
    expect(parseUsernameFromProjectKey('-Users-admin-workspace-', prefix)).toBeNull();
  });
});

describe('rebuildTokenUsageFromJsonl', () => {
  const cleanupDirs = new Set<string>();
  let dataDir: string;
  /**
   * 新 Agent SaaS layout 根：`<root>/<tenantId>/<userId>/*.jsonl`。
   * 这里测试不写新 layout fixture，但仍 mock 到临时目录，避免实现走默认值
   * 去扫真实 `~/.agent-saas/legacy-transcripts` 污染主机。
   */
  let newProjectsRoot: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tu-rebuild-data-'));
    newProjectsRoot = await mkdtemp(join(tmpdir(), 'tu-rebuild-new-'));
    cleanupDirs.add(dataDir);
    cleanupDirs.add(newProjectsRoot);
    __resetBusinessDbForTest();
  });

  afterEach(async () => {
    __resetBusinessDbForTest();
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  /** 写到新 Agent SaaS layout。旧 projectKey 入参仅用于复用历史测试夹具命名。 */
  async function writeJsonl(projectKey: string, sessionId: string, lines: object[], meta?: object) {
    const username = parseUsernameFromProjectKey(projectKey, '-Users-admin-workspace-');
    const dir = username
      ? join(newProjectsRoot, 'kaiyan', username)
      : newProjectsRoot;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
    if (meta) {
      await writeFile(join(dir, `${sessionId}.meta.json`), JSON.stringify(meta));
    }
  }

  it('performs full rebuild on first run', async () => {
    await writeJsonl('-Users-admin-workspace-zenglei', 'session1', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: {
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
          },
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-05-16T10:00:00+08:00',
        message: {
          model: 'claude-opus-4-6',
          usage: { input_tokens: 30, output_tokens: 70, cache_read_input_tokens: 500 },
        },
      },
      { type: 'user', timestamp: '2026-05-16T08:01:00+08:00' }, // 非 assistant，应忽略
    ]);

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const stats = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      log: () => {},
    });

    expect(stats.performed).toBe(true);
    expect(stats.filesScanned).toBe(1);
    expect(stats.rowsWritten).toBe(2); // 分钟表按 08:00 / 10:00 写 2 个桶

    const store = createTokenUsageStore(db);
    const rows = store.listByDate('2026-05-16');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'zenglei',
      model: 'claude-opus-4-6',
      channel: 'web',
      inputTokens: 130,
      outputTokens: 120,
      cacheReadTokens: 1500,
      cacheCreationTokens: 200,
      // 本地 pricing.ts 算（claude-opus-4-6 同上）：
      // 5*130 + 25*120 + 0.5*1500 + 10*200 = 6400 micro USD
      costUsdMicro: 6_400,
      turnCount: 2,    // 两条 assistant message
    });
    expect(store.getOverview('2026-05-16T08:00', '2026-05-16T08:59').totalInputTokens).toBe(100);
    expect(store.getOverview('2026-05-16T10:00', '2026-05-16T10:59').totalInputTokens).toBe(30);
  });

  it('skips rebuild on second run (rebuild_state exists)', async () => {
    await writeJsonl('-Users-admin-workspace-zenglei', 'session1', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: {
          model: 'claude-opus-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]);

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);

    const r1 = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      log: () => {},
    });
    expect(r1.performed).toBe(true);

    const r2 = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      log: () => {},
    });
    expect(r2.performed).toBe(false);
  });

  it('force=true triggers rebuild even when state exists', async () => {
    await writeJsonl('-Users-admin-workspace-zenglei', 'session1', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    await rebuildTokenUsageFromJsonl(db, { agentCwd: '/Users/admin/workspace', projectsRoot: newProjectsRoot });
    const r2 = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      force: true,
    });
    expect(r2.performed).toBe(true);
  });

  it('resetRebuildState allows next run to rebuild', async () => {
    await writeJsonl('-Users-admin-workspace-zenglei', 'session1', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    await rebuildTokenUsageFromJsonl(db, { agentCwd: '/Users/admin/workspace', projectsRoot: newProjectsRoot });
    resetRebuildState(db);
    const r2 = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
    });
    expect(r2.performed).toBe(true);
  });

  it('reads meta.json channel field', async () => {
    await writeJsonl(
      '-Users-admin-workspace-zenglei',
      'session1',
      [
        {
          type: 'assistant',
          timestamp: '2026-05-16T08:00:00+08:00',
          message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ],
      {
        userId: 'u-1',
        username: 'zenglei',
        channel: 'cron',
        createdAt: '2026-05-16T00:00:00Z',
      },
    );

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    await rebuildTokenUsageFromJsonl(db, { agentCwd: '/Users/admin/workspace', projectsRoot: newProjectsRoot });

    const store = createTokenUsageStore(db);
    const rows = store.listByDate('2026-05-16');
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('cron');
  });

  it('ignores non-workspace project keys', async () => {
    // 这种 projectKey 不符合 username 规则，应被跳过
    await writeJsonl('-Users-admin-code-agent', 'session1', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: { model: 'm', usage: { input_tokens: 100, output_tokens: 50 } },
      },
    ]);

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const stats = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
    });

    expect(stats.filesScanned).toBe(0); // 此 projectKey 不匹配前缀，连扫都不扫
    const store = createTokenUsageStore(db);
    expect(store.listByDate('2026-05-16')).toHaveLength(0);
  });

  it('separates same model across multiple users', async () => {
    await writeJsonl('-Users-admin-workspace-zenglei', 'session1', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: { model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50 } },
      },
    ]);
    await writeJsonl('-Users-admin-workspace-yiping', 'session2', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: { model: 'claude-opus-4-6', usage: { input_tokens: 200, output_tokens: 80 } },
      },
    ]);

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    await rebuildTokenUsageFromJsonl(db, { agentCwd: '/Users/admin/workspace', projectsRoot: newProjectsRoot });

    const store = createTokenUsageStore(db);
    const rows = store.listByDate('2026-05-16').sort((a, b) => a.username.localeCompare(b.username));
    expect(rows).toHaveLength(2);
    expect(rows[0].username).toBe('yiping');
    expect(rows[0].inputTokens).toBe(200);
    expect(rows[1].username).toBe('zenglei');
    expect(rows[1].inputTokens).toBe(100);
  });

  // ─────────────────────────────────────────────────────────────────
  // 新 Agent SaaS layout 覆盖
  // 路径：<newProjectsRoot>/<tenantId>/<userId>/<sessionId>.jsonl
  // username 解析：meta.username 优先；缺失则以路径 parts[1] (=userId) 兜底
  // ─────────────────────────────────────────────────────────────────

  /** 写到新 Agent SaaS layout (`<root>/<tenantId>/<userId>/<sessionId>.jsonl`)。 */
  async function writeNewLayoutJsonl(
    tenantId: string,
    userId: string,
    sessionId: string,
    lines: object[],
    meta?: object,
  ) {
    const dir = join(newProjectsRoot, tenantId, userId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
    if (meta) {
      await writeFile(join(dir, `${sessionId}.meta.json`), JSON.stringify(meta));
    }
  }

  it('new layout: meta.username 优先于 userId 兜底', async () => {
    await writeNewLayoutJsonl(
      'kaiyan',
      'u-001',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      [
        {
          type: 'assistant',
          timestamp: '2026-05-16T08:00:00+08:00',
          message: { model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50 } },
        },
      ],
      { userId: 'u-001', username: 'zenglei', channel: 'web', createdAt: '2026-05-16T00:00:00Z' },
    );

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const stats = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      log: () => {},
    });

    expect(stats.filesScanned).toBe(1);
    const store = createTokenUsageStore(db);
    const rows = store.listByDate('2026-05-16');
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('zenglei'); // 不是 'u-001'
    expect(rows[0].inputTokens).toBe(100);
  });

  it('new layout: meta 缺失时用 userId (path parts[1]) 兜底', async () => {
    await writeNewLayoutJsonl(
      'kaiyan',
      'u-002',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      [
        {
          type: 'assistant',
          timestamp: '2026-05-16T08:00:00+08:00',
          message: { model: 'claude-opus-4-6', usage: { input_tokens: 50, output_tokens: 25 } },
        },
      ],
      // 注意：不写 meta
    );

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      log: () => {},
    });

    const store = createTokenUsageStore(db);
    const rows = store.listByDate('2026-05-16');
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('u-002');
  });

  it('new layout: tenant 顶层裸 jsonl 没 userId 子目录 → 跳过', async () => {
    // 直接放在 <root>/<tenantId>/ 下，没有 userId 一层
    const dir = join(newProjectsRoot, 'kaiyan');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'orphan-session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    );

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const stats = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      log: () => {},
    });

    expect(stats.filesScanned).toBe(0);
    const store = createTokenUsageStore(db);
    const rows = store.listByDate('2026-05-16');
    expect(rows).toHaveLength(0);
  });

  it('new layout: 同用户多个 transcript 合并到同一桶', async () => {
    // 新 layout（带 meta.username）
    await writeNewLayoutJsonl(
      'kaiyan',
      'u-001',
      'session-new',
      [
        {
          type: 'assistant',
          timestamp: '2026-05-16T08:00:00+08:00',
          message: { model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50 } },
        },
      ],
      { userId: 'u-001', username: 'zenglei', channel: 'web', createdAt: '2026-05-16T00:00:00Z' },
    );
    // 第二个 transcript（同分钟、同 model、同 channel 触发合桶）
    await writeJsonl('-Users-admin-workspace-zenglei', 'session-legacy', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T08:00:00+08:00',
        message: { model: 'claude-opus-4-6', usage: { input_tokens: 30, output_tokens: 20 } },
      },
    ]);

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    const stats = await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      log: () => {},
    });

    expect(stats.filesScanned).toBe(2);
    const store = createTokenUsageStore(db);
    const rows = store.listByDate('2026-05-16');
    // 同 (date, username, model, channel) → 应合并成 1 行（store 是 UPSERT 累加）
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('zenglei');
    expect(rows[0].inputTokens).toBe(130);   // 100 + 30
    expect(rows[0].outputTokens).toBe(70);   // 50 + 20
    expect(rows[0].turnCount).toBe(2);       // 两条 assistant
  });

  it('new layout: meta.channel 被读取（直接走 readSessionMeta，不靠 inferChannel）', async () => {
    await writeNewLayoutJsonl(
      'kaiyan',
      'u-001',
      'session-cron',
      [
        {
          type: 'assistant',
          timestamp: '2026-05-16T08:00:00+08:00',
          message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ],
      { userId: 'u-001', username: 'zenglei', channel: 'cron', createdAt: '2026-05-16T00:00:00Z' },
    );

    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    await rebuildTokenUsageFromJsonl(db, {
      agentCwd: '/Users/admin/workspace',
      projectsRoot: newProjectsRoot,
      log: () => {},
    });

    const store = createTokenUsageStore(db);
    const rows = store.listByDate('2026-05-16');
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('cron');
  });
});
