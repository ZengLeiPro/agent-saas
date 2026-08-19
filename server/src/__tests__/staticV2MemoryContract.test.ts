import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('static-v2 memory contract', () => {
  it('defines the main Agent as a pure consumer and background-only writer', async () => {
    const prompt = await readFile(new URL('../../../workspace-shared/prompts/static-v2.md', import.meta.url), 'utf8');
    expect(prompt).toContain('后台记忆服务是 `MEMORY.md` 与 `memory/**` 的唯一写入者');
    expect(prompt).toContain('请求已收到，由后台处理');
    expect(prompt).toContain('不调用任何工具');
    expect(prompt).not.toContain('调用`MemoryCommand`');
  });
});
