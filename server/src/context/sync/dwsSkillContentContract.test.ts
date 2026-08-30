import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const dwsSkillRoot = join(repoRoot, 'workspace-shared', '.ky-agent', 'skills-pool', 'dws');

function readSkillFile(...parts: string[]) {
  return readFile(join(dwsSkillRoot, ...parts), 'utf-8');
}

describe('DWS v1.0.60 skill content contract', () => {
  it('uses cursor with one-shot empty-page termination while retaining minutes list next-token', async () => {
    const [minutes, liteRecipes] = await Promise.all([
      readSkillFile('references', 'products', 'minutes.md'),
      readSkillFile('references', 'best_practices', 'lite-recipes.md'),
    ]);

    expect(minutes).toContain(
      'dws minutes get transcription --id <taskUuid> --cursor <nextToken> --format json',
    );
    expect(minutes).toContain('dws minutes list mine --max 10 --next-token <nextToken>');
    expect(minutes).not.toMatch(/dws minutes get transcription[^\n]*--next-token/);
    expect(minutes).not.toContain('`get transcription` 使用 `--next-token`');
    expect(minutes).not.toContain('正确参数名是 `--next-token`');
    expect(minutes).toContain('cursor 首次返回空响应即终止翻页，不再重试');
    expect(minutes).not.toMatch(/cursor[^\n]{0,40}连续(?:返回空)?\s*2\s*次/);
    expect(liteRecipes).toContain(
      '返回 `nextToken` 时用 `--cursor <token>` 继续',
    );
    expect(liteRecipes).not.toContain(
      '返回 `nextToken` 时用 `--next-token <token>` 继续',
    );
  });

  it('does not advertise conference booking in calendar docs', async () => {
    const [calendar, intentGuide] = await Promise.all([
      readSkillFile('references', 'products', 'calendar.md'),
      readSkillFile('references', 'intent-guide.md'),
    ]);

    expect(calendar).not.toContain('conference（视频会议预约）');
    expect(intentGuide).toContain('当前开源 CLI **不提供**视频会议（conference）命令');
  });

  it('drops deleted script claims without removing Broker message capabilities', async () => {
    const skill = await readSkillFile('SKILL.md');

    expect(skill).not.toContain('、机器人消息、');
    expect(skill).not.toContain('Chat 历史导出与机器人广播已完全下沉 Runtime');
    expect(skill).not.toContain('文档创建并写入');
    expect(skill).not.toContain('文档创建后写内容');
    expect(skill).toContain('**企业专家 DWS Broker**');
    expect(skill).toContain('消息发送(文本/Markdown/图片/文件)');
  });
});
