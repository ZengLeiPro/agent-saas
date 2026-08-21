import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { buildConsolidationPrompt } from '../memory/consolidation/prompt.js';

describe('static-v2 memory contract', () => {
  it('不再把主 Agent 禁写规则放进 System Prompt，普通会话仍不得虚报完成', async () => {
    const prompt = await readFile(new URL('../../../workspace-shared/prompts/static-v2.md', import.meta.url), 'utf8');
    expect(prompt).not.toContain('后台记忆服务是 `MEMORY.md` 与 `memory/**` 的唯一写入者');
    expect(prompt).not.toContain('不得用Write、Edit、Shell');
    expect(prompt).toContain('请求已收到；我不会在当前会话直接修改记忆');
    expect(prompt).toContain('后台产生真实回执后才能确认');
  });

  it('隐藏 Run 收到普通 user 审查消息并直接维护真实 Markdown', () => {
    const prompt = buildConsolidationPrompt({
      fromSessionSequence: 10,
      toSessionSequence: 42,
      forgottenSubjects: ['旧健身安排'],
    });
    expect(prompt).toContain('会话结束后的记忆审查阶段');
    expect(prompt).toContain('父会话 Context Projection 已完整保留');
    expect(prompt).toContain('直接维护当前用户工作区里的真实记忆 Markdown');
    expect(prompt).toContain('Write/Edit');
    expect(prompt).toContain('旧健身安排');
    expect(prompt).toContain('不得从会话历史重新写回');
    expect(prompt).not.toContain('MemoryCommit');
    expect(prompt).not.toContain('operations=[]');
  });
});
