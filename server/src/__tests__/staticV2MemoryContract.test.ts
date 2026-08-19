import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { buildConsolidationPrompt } from '../memory/consolidation/prompt.js';

describe('static-v2 memory contract', () => {
  it('defines the main Agent as a pure consumer and background-only writer', async () => {
    const prompt = await readFile(new URL('../../../workspace-shared/prompts/static-v2.md', import.meta.url), 'utf8');
    expect(prompt).toContain('后台记忆服务是 `MEMORY.md` 与 `memory/**` 的唯一写入者');
    expect(prompt).toContain('请求已收到；我不会在当前会话直接修改记忆');
    expect(prompt).toContain('后台产生真实回执后才能确认');
    expect(prompt).toContain('不调用任何工具');
    expect(prompt).not.toContain('调用`MemoryCommand`');
  });

  it('does not turn explicit forget requests into positive memory candidates', () => {
    const prompt = buildConsolidationPrompt({ digestText: '<memory-review-input />', maxCandidates: 5 });
    expect(prompt).toContain('忘记/删除某条记忆');
    expect(prompt).toContain('不得把要忘记的内容重新写入');
    expect(prompt).toContain('operations=[]');
  });
});
