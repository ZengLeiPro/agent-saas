/**
 * descriptionLoader 行为测试：
 *  - 真实文件 hit（Edit.md）：返回非空、归一化正确
 *  - 不存在的 tool id：fail-fast（throw + 路径在错误消息中）
 *  - cache 命中：连续两次调用只读盘一次
 *  - 路径推导：DESCRIPTIONS_DIR_PATH 指向 server/src/agent/descriptions/
 */

import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  DESCRIPTIONS_DIR_PATH,
  clearToolDescriptionCache,
  loadToolDescription,
} from '../agent/tools/descriptionLoader.js';

// 命名约定：测试用临时 md 一律 `__test_*.md` 前缀，对应 .gitignore 规则。
// 进程 SIGKILL 时 try/finally 兜不住，afterAll 再扫一遍残留。
const TEST_PREFIX = '__test_';

describe('loadToolDescription', () => {
  afterEach(() => {
    clearToolDescriptionCache();
  });

  afterAll(() => {
    // 防御性兜底：扫 descriptions 目录，把所有 __test_*.md 残留扫掉，
    // 避免 SIGKILL / IDE 杀进程导致的临时文件污染生产源码目录。
    try {
      for (const name of readdirSync(DESCRIPTIONS_DIR_PATH)) {
        if (name.startsWith(TEST_PREFIX) && name.endsWith('.md')) {
          try {
            unlinkSync(join(DESCRIPTIONS_DIR_PATH, name));
          } catch {
            // 忽略
          }
        }
      }
    } catch {
      // 忽略
    }
  });

  it('reads Edit.md and normalizes multi-line markdown into a single line', () => {
    const desc = loadToolDescription('Edit');
    expect(desc.length).toBeGreaterThan(50);
    // 归一化后必须是单行
    expect(desc).not.toContain('\n');
    // 不会有 trailing / leading 空白
    expect(desc).toBe(desc.trim());
    // 关键内容仍在
    expect(desc).toContain('对工作区文本文件执行精确字符串替换');
    expect(desc).toContain('.ky-agent/settings.json');
  });

  it('throws with descriptive path when the md file is missing', () => {
    expect(() => loadToolDescription('this_tool_does_not_exist')).toThrow(
      /description file not found for "this_tool_does_not_exist"/,
    );
    expect(() => loadToolDescription('this_tool_does_not_exist')).toThrow(
      /this_tool_does_not_exist\.md/,
    );
  });

  it('throws when md file exists but normalized content is empty', () => {
    const id = `${TEST_PREFIX}empty`;
    const path = join(DESCRIPTIONS_DIR_PATH, `${id}.md`);
    writeFileSync(path, '   \n  \n\n');
    try {
      expect(() => loadToolDescription(id)).toThrow(/is empty/);
    } finally {
      unlinkSync(path);
    }
  });

  it('cache: 多次调用返回相同结果且不受 md 文件后续删除影响', () => {
    const id = `${TEST_PREFIX}cache`;
    const path = join(DESCRIPTIONS_DIR_PATH, `${id}.md`);
    writeFileSync(path, 'first content sentence one.\nsecond sentence two.');
    try {
      const first = loadToolDescription(id);
      expect(first).toBe('first content sentence one. second sentence two.');
      // 删除 md 文件——若 cache 失效会 throw；命中 cache 则仍返回原值
      unlinkSync(path);
      const second = loadToolDescription(id);
      expect(second).toBe(first);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it('DESCRIPTIONS_DIR_PATH resolves to server/src/agent/descriptions/', () => {
    expect(DESCRIPTIONS_DIR_PATH.endsWith(join('agent', 'descriptions'))).toBe(true);
    expect(existsSync(DESCRIPTIONS_DIR_PATH)).toBe(true);
    // workspace 与 brain-only 工具的代表性 description 文件
    for (const id of ['Read', 'Edit', 'Shell', 'TodoWrite', 'AskUserQuestion', 'CreateArtifact']) {
      expect(existsSync(join(DESCRIPTIONS_DIR_PATH, `${id}.md`))).toBe(true);
    }
  });
});
