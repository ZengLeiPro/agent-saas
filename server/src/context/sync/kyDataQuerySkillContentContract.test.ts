import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const skillRoot = join(repoRoot, 'workspace-shared', '.ky-agent', 'skills-pool', 'ky-data-query');

function readSkillFile(...parts: string[]) {
  return readFile(join(skillRoot, ...parts), 'utf-8');
}

describe('ky-data-query 能力发现契约', () => {
  it('把 capabilities 作为完整能力入口，不允许用 entities 缺席推断未接入', async () => {
    const skill = await readSkillFile('SKILL.md');

    expect(skill).toContain('## 能力发现协议（所有业务域强制）');
    expect(skill).toContain('必须先查 `azeroth capabilities`');
    expect(skill).toContain('不得因为 `azeroth entities` 没有某个名字，就断言该业务域未接入');
    expect(skill).toContain(
      '`azeroth entities`：仅列由 shared schema 自动发现的标准 CRUD/只读实体',
    );
    expect(skill).toContain('`capabilities` → `xiaohongshu datasets`');
  });

  it('主 Skill 只保留小红书路由纪律，动态查询细节下沉到 reference', async () => {
    const [skill, spotlight] = await Promise.all([
      readSkillFile('SKILL.md'),
      readSkillFile('references', 'xiaohongshu-spotlight.md'),
    ]);
    const section = skill.split('## 小红书聚光投放数据')[1]?.split('## 官网埋点 / SEO 监测')[0];

    expect(section).toContain(
      '[references/xiaohongshu-spotlight.md](references/xiaohongshu-spotlight.md)',
    );
    expect(section).toContain('不得因 `entities` 无此项而判定未接入');
    expect(section).toContain('不在本文硬编码');
    expect(section).not.toContain('### 强制查询流程');
    expect(section).not.toMatch(/\b(?:13|66)\s*个/);

    expect(spotlight).toContain('目录发现 → 参数理解 → 单页探测 → 全量分页导出');
    expect(spotlight).toContain('query-dataset <datasetId>');
    expect(spotlight).toContain('--all --page-size 100');
    expect(spotlight).toContain('“完整分析”的覆盖矩阵');
  });
});
