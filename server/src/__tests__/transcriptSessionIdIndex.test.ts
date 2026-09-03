import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import {
  findTranscriptPathBySessionId,
  listExistingTranscriptSessionIds,
} from '../data/transcripts/store.js';

/**
 * 启动 prune 曾对每个 sessionId 各递归一次整棵 transcripts 树（O(N×M)）。
 * 改用一次性索引后，必须锁住「索引集合」与「逐个查找」语义完全等价，
 * 否则 prune 会误删仍有 transcript 的 group sessionId。
 */
describe('transcript sessionId 索引与逐个查找语义等价', () => {
  let caseDir: string;
  const present = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const absent = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    mkdirSync(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
    caseDir = mkdtempSync(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'idx-test-'));
    const userDir = join(caseDir, 'user-1');
    mkdirSync(userDir, { recursive: true });
    for (const sid of present) writeFileSync(join(userDir, `${sid}.jsonl`), '{"timestamp":"2026-09-03T00:00:00.000Z"}\n');
    // 非 transcript 文件与非法 sessionId 都不得进入索引
    writeFileSync(join(userDir, `${present[0]}.meta.json`), '{}');
    writeFileSync(join(userDir, 'not-a-session.jsonl'), '{}');
  });

  afterEach(() => {
    rmSync(caseDir, { recursive: true, force: true });
  });

  it('索引包含全部已存在 transcript 的 sessionId', async () => {
    const ids = await listExistingTranscriptSessionIds();
    for (const sid of present) expect(ids.has(sid)).toBe(true);
  });

  it('索引不含缺失会话、非法 sessionId 与 meta 文件', async () => {
    const ids = await listExistingTranscriptSessionIds();
    expect(ids.has(absent)).toBe(false);
    expect(ids.has('not-a-session')).toBe(false);
    expect([...ids].some((id) => id.endsWith('.meta'))).toBe(false);
  });

  it('对每个候选 id，索引判定与 findTranscriptPathBySessionId 结果一致', async () => {
    const ids = await listExistingTranscriptSessionIds();
    for (const sid of [...present, absent, 'not-a-session', '']) {
      const foundPath = await findTranscriptPathBySessionId(sid);
      expect(ids.has(sid)).toBe(foundPath !== null);
    }
  });

  it('索引里的 id 能被逐个查找定位回同名 transcript 文件', async () => {
    const path0 = await findTranscriptPathBySessionId(present[0]!);
    expect(path0).not.toBeNull();
    expect(basename(path0!)).toBe(`${present[0]}.jsonl`);
  });
});
