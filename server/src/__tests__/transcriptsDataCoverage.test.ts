import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_LEGACY_TRANSCRIPTS_ROOT,
  assertAllowedTranscriptPath,
  deriveProjectKey,
  getAgentTranscriptDir,
  getAnonymousAgentTranscriptDir,
  hasTranscriptOwnerRef,
  isValidSessionId,
} from '../data/transcripts/projectKey.js';
import {
  addSessionCost,
  getMetaPath,
  getSessionMetaProjectionStats,
  readSessionMeta,
  setSessionMetaProjectionSink,
  updateSessionMeta,
  writeSessionMeta,
  type SessionMeta,
} from '../data/transcripts/meta.js';

/**
 * transcripts data 层未覆盖行为补测：
 * - projectKey：sessionId 校验、路径安全校验、目录推导、owner ref 判定
 * - meta：addSessionCost 累加、updateSessionMeta 清字段语义、投影 sink 统计
 */

// ── projectKey 纯逻辑 ──────────────────────────────────────────
describe('transcripts/projectKey', () => {
  it('isValidSessionId 接受 UUID 与 sub-<uuid>，拒绝非法格式', () => {
    expect(isValidSessionId('12345678-1234-1234-1234-123456789abc')).toBe(true);
    expect(isValidSessionId('sub-12345678-1234-1234-1234-123456789abc')).toBe(true);
    expect(isValidSessionId('not-a-uuid')).toBe(false);
    expect(isValidSessionId('../evil')).toBe(false);
    // 前缀必须恰好是 sub-，其它前缀不放行
    expect(isValidSessionId('xx-12345678-1234-1234-1234-123456789abc')).toBe(false);
  });

  it('deriveProjectKey 把非字母数字替换为连字符', () => {
    expect(deriveProjectKey('/home/user/my project!')).toBe('-home-user-my-project-');
  });

  it('hasTranscriptOwnerRef 要求 tenantId 与 userId 同时存在', () => {
    expect(hasTranscriptOwnerRef({ tenantId: 't', userId: 'u' })).toBe(true);
    expect(hasTranscriptOwnerRef({ tenantId: 't' })).toBe(false);
    expect(hasTranscriptOwnerRef({ userId: 'u' })).toBe(false);
    expect(hasTranscriptOwnerRef(undefined)).toBe(false);
  });

  it('getAgentTranscriptDir 对 tenant/user 做安全分段（非法字符→_）', () => {
    // safePathSegment: /[^a-zA-Z0-9_-]/g → _；'wain/../x' 的 / . . / 四个字符各变 _
    const dir = getAgentTranscriptDir({ tenantId: 'wain/../x', userId: 'a b' });
    expect(dir).toBe(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'wain____x', 'a_b'));
  });

  it('getAnonymousAgentTranscriptDir 走 __anonymous 分桶', () => {
    const dir = getAnonymousAgentTranscriptDir('/tmp/work');
    expect(dir).toBe(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, '__anonymous', '-tmp-work'));
  });

  it('assertAllowedTranscriptPath 放行根内路径，拒绝根外路径', () => {
    const inside = join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 't', 'u', 'x.jsonl');
    expect(assertAllowedTranscriptPath(inside)).toBe(inside);
    expect(() => assertAllowedTranscriptPath(join(homedir(), 'elsewhere', 'x.jsonl')))
      .toThrow(/outside allowed directories/);
    // 前缀伪装（同级 sibling）不应被放行
    expect(() => assertAllowedTranscriptPath(`${AGENT_LEGACY_TRANSCRIPTS_ROOT}-evil${sep}x`))
      .toThrow(/outside allowed directories/);
  });
});

// ── meta：读写/累加/清字段/投影 ────────────────────────────────
describe('transcripts/meta persistence', () => {
  let dir: string;
  let transcriptPath: string;

  const baseMeta: SessionMeta = {
    userId: 'u1',
    username: 'alice',
    channel: 'web',
    createdAt: '2026-07-15T00:00:00.000Z',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transcript-meta-'));
    transcriptPath = join(dir, '12345678-1234-1234-1234-123456789abc.jsonl');
  });

  afterEach(() => {
    setSessionMetaProjectionSink(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('getMetaPath 由 transcript 路径推导 .meta.json 兄弟文件', () => {
    expect(getMetaPath(transcriptPath)).toBe(
      join(dir, '12345678-1234-1234-1234-123456789abc.meta.json'),
    );
  });

  it('writeSessionMeta 原子落盘，readSessionMeta 读回；缺失文件返回 null', async () => {
    expect(await readSessionMeta(transcriptPath)).toBeNull();
    await writeSessionMeta(transcriptPath, baseMeta);
    expect(await readSessionMeta(transcriptPath)).toEqual(baseMeta);
  });

  it('addSessionCost 累加成本；非正数或缺 meta 时 no-op', async () => {
    await writeSessionMeta(transcriptPath, baseMeta);
    await addSessionCost(transcriptPath, 1.5);
    await addSessionCost(transcriptPath, 0.25);
    expect((await readSessionMeta(transcriptPath))!.totalCostUsd).toBeCloseTo(1.75, 6);

    // 非正数不改动
    await addSessionCost(transcriptPath, 0);
    await addSessionCost(transcriptPath, -5);
    expect((await readSessionMeta(transcriptPath))!.totalCostUsd).toBeCloseTo(1.75, 6);
  });

  it('updateSessionMeta：空 customTitle 删除该字段（回退自动标题）', async () => {
    await writeSessionMeta(transcriptPath, { ...baseMeta, customTitle: '旧标题' });
    const updated = await updateSessionMeta(transcriptPath, { customTitle: '' });
    expect(updated).not.toBeNull();
    expect('customTitle' in updated!).toBe(false);
  });

  it('updateSessionMeta：清空 deletedAt 时同时删除 deletedBy（恢复语义）', async () => {
    await writeSessionMeta(transcriptPath, {
      ...baseMeta, deletedAt: '2026-07-15T01:00:00.000Z', deletedBy: 'admin',
    });
    const restored = await updateSessionMeta(transcriptPath, { deletedAt: undefined });
    expect(restored).not.toBeNull();
    expect('deletedAt' in restored!).toBe(false);
    expect('deletedBy' in restored!).toBe(false);
  });

  it('updateSessionMeta：meta 不存在时返回 null', async () => {
    expect(await updateSessionMeta(transcriptPath, { runtimeStatus: 'idle' })).toBeNull();
  });

  it('投影 sink：upsert 抛错记入 stats.failures，成功 upsert 收敛 pending', async () => {
    const upsertOk = vi.fn(async () => {});
    setSessionMetaProjectionSink({ upsert: upsertOk, delete: vi.fn() });
    await writeSessionMeta(transcriptPath, baseMeta);
    // 等待投影队列排空
    const { flushSessionMetaProjectionForTests } = await import('../data/transcripts/meta.js');
    await flushSessionMetaProjectionForTests();
    expect(upsertOk).toHaveBeenCalledTimes(1);
    expect(getSessionMetaProjectionStats().pending).toBe(0);
  });
});
