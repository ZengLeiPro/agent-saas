import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILL_PRESENTATIONS } from './builtins.js';

describe('内置技能中文展示种子', () => {
  it('覆盖当前技能池的每一个顶层技能，且名称与简介均非空', async () => {
    const poolDir = resolve(process.cwd(), '..', 'workspace-shared', '.ky-agent', 'skills-pool');
    const skillIds = (await readdir(poolDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const bySkillId = new Map(BUILTIN_SKILL_PRESENTATIONS.map((item) => [item.skillId, item]));

    expect(skillIds.filter((skillId) => !bySkillId.has(skillId))).toEqual([]);
    for (const item of BUILTIN_SKILL_PRESENTATIONS) {
      expect(item.displayName.trim().length).toBeGreaterThan(0);
      expect(item.summary.trim().length).toBeGreaterThan(0);
    }
  });
});
