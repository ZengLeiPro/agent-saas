import { chown, lstat, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  editToolDescriptor,
  prepareEditInput,
  type EditInput,
} from '../agent/workspaceHandTools.js';
import { applyWorkspaceEdits } from '../agent/editOperations.js';
import {
  createBuiltinAgentProfileRecords,
  getBuiltinProfileByBinding,
} from '../data/agentProfiles/builtins.js';
import { MEMORY_POLL_DEFAULTS } from '../cron/memoryPoll.js';
import {
  invokeMemoryConsolidationDraftTool,
  commitMemoryConsolidationDraft,
  discardMemoryConsolidationDraft,
  recoverMemoryConsolidationPreparedCommit,
} from '../memory/consolidation/draft.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('记忆工具输入和预算', () => {
  it('模型仅看到 edits，旧单条输入仍转换为一条操作', () => {
    const schema = z.toJSONSchema(editToolDescriptor.schema);
    expect(Object.keys(schema.properties ?? {})).toEqual(['file_path', 'edits']);
    const input = editToolDescriptor.schema.parse(
      prepareEditInput({ file_path: 'MEMORY.md', old_string: '旧', new_string: '新' }),
    ) as EditInput;
    expect(input).toEqual({
      file_path: 'MEMORY.md',
      edits: [{ old_string: '旧', new_string: '新' }],
    });
    expect(applyWorkspaceEdits('旧', input.edits!, 'MEMORY.md').updatedContent).toBe('新');
  });
  it('拒绝补位空字符串、重叠和多处匹配，失败不降级覆盖', () => {
    expect(() =>
      editToolDescriptor.schema.parse({
        file_path: 'MEMORY.md',
        edits: [{ old_string: '', new_string: '' }],
      }),
    ).toThrow();
    const op = { old_string: 'abc', new_string: 'xyz' };
    expect(() => applyWorkspaceEdits('abc', [op, op], 'MEMORY.md')).toThrow(/overlap/);
    expect(() => applyWorkspaceEdits('abc abc', [op], 'MEMORY.md')).toThrow();
  });
  it('新轮询预算1000，历史v1/v2和旧L2 Profile仍为30', () => {
    expect(MEMORY_POLL_DEFAULTS.maxTurns).toBe(1000);
    expect(getBuiltinProfileByBinding('memory_poll').version.config.limits.maxTurns).toBe(1000);
    const history = createBuiltinAgentProfileRecords('2026-07-22T00:00:00Z').versions.filter(
      (v) => v.profileId === 'arp_system_memory_poll' && v.versionNumber < 3,
    );
    expect(history.map((v) => v.config.limits.maxTurns)).toEqual([30, 30]);
    expect(getBuiltinProfileByBinding('memory_consolidate').version.config.limits.maxTurns).toBe(
      30,
    );
  });
});

describe.skipIf(process.platform !== 'linux')('Linux 记忆草稿落盘', () => {
  it('规范 edits 在 L2 草稿中执行，提交前不改原文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-edits-'));
    dirs.push(root);
    await writeFile(join(root, 'MEMORY.md'), '旧事实\n第二条\n');
    const context = {
      sessionId: 'memory-health-draft',
      workspace: { root, executionTarget: 'server-local' },
    };
    await invokeMemoryConsolidationDraftTool(
      {
        toolId: 'Edit',
        input: { edits: [{ old_string: '旧事实', new_string: '新事实' }] },
      } as never,
      context as never,
      'MEMORY.md',
    );
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toContain('旧事实');
    await commitMemoryConsolidationDraft(context.sessionId);
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toContain('新事实');
    await discardMemoryConsolidationDraft(context.sessionId);
  });
  it.skipIf(process.getuid?.() !== 0)(
    'root Worker 提交后 uid501可读取并修改新文件、新目录和原有600文件',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'memory-owner-'));
      dirs.push(root);
      await chown(root, 501, 20);
      await writeFile(join(root, 'MEMORY.md'), '旧', { mode: 0o600 });
      await chmod(join(root, 'MEMORY.md'), 0o600);
      await recoverMemoryConsolidationPreparedCommit(root, {
        version: 1,
        entries: [
          { relativePath: 'MEMORY.md', baseline: '旧', staged: '新' },
          { relativePath: 'memory/topics/事实.md', baseline: null, staged: '事实' },
        ],
      });
      for (const path of ['MEMORY.md', 'memory', 'memory/topics', 'memory/topics/事实.md']) {
        const stat = await lstat(join(root, path));
        expect([stat.uid, stat.gid]).toEqual([501, 20]);
      }
      expect((await lstat(join(root, 'MEMORY.md'))).mode & 0o777).toBe(0o600);
      const result = execFileSync(
        process.execPath,
        [
          '-e',
          'const fs=require("node:fs");for(const p of process.argv.slice(1)){fs.readFileSync(p);fs.appendFileSync(p,"可写")}console.log("跨身份读写通过")',
          join(root, 'MEMORY.md'),
          join(root, 'memory/topics/事实.md'),
        ],
        { uid: 501, gid: 20, encoding: 'utf8' },
      );
      expect(result.trim()).toBe('跨身份读写通过');
    },
  );
});
