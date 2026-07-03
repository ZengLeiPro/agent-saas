import { describe, expect, it } from 'vitest';

import { SkillToolProvider, type EffectiveSkillsResolver, type SkillEntry } from '../agent/skillToolProvider.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';

function makeContext(): ToolCallContext {
  return {
    workspace: { root: '/tmp/ws', sessionId: 'session', executionTarget: 'server-local' },
    signal: new AbortController().signal,
    sessionId: 'session',
    channelContext: {
      channel: 'web',
      user: { id: 'admin-1', username: 'admin', role: 'admin' },
    },
  } as unknown as ToolCallContext;
}

function makeProvider(skills: SkillEntry[]): SkillToolProvider {
  const resolver: EffectiveSkillsResolver = {
    list: () => skills,
    resolveSkillDir: () => null,
  };
  return new SkillToolProvider(resolver);
}

describe('SkillToolProvider description injection', () => {
  it('injects the current user skill list into the tool description', () => {
    // 修 2026-07-03 glm-5.2 bug 根因二：xml section 注意力弱的模型在决定
    // 「调什么 skill」时更靠工具 schema 本身；把实际 skill 清单塞进 description
    // 让模型直接从工具 schema 就能拿到唯一可信来源。
    const provider = makeProvider([
      { id: 'browser', name: 'browser', description: 'Browser automation via playwright.' },
      { id: 'dws', name: 'dws', description: '钉钉全产品能力管理。' },
    ]);
    const [descriptor] = provider.list(makeContext());
    expect(descriptor.description).toContain('- `browser`: Browser automation via playwright.');
    expect(descriptor.description).toContain('- `dws`: 钉钉全产品能力管理。');
    expect(descriptor.description).toContain('当前用户可用 Skill 清单');
  });

  it('does not leak the historical case-study fake example into schema hints', () => {
    // 回归锁定：07-01 pool 已删 case-study，工具描述与 schema 都不得再暗示它存在。
    const provider = makeProvider([{ id: 'browser', name: 'browser', description: 'test' }]);
    const [descriptor] = provider.list(makeContext());
    expect(descriptor.description).not.toContain('case-study');
    const shape = (descriptor.schema as unknown as { shape: Record<string, { description?: string }> }).shape;
    const skillFieldDescription = shape?.skill?.description ?? '';
    expect(skillFieldDescription).not.toContain('case-study');
    expect(skillFieldDescription).not.toContain('image-gen');
  });

  it('warns the model explicitly when the user has no available skills', () => {
    // 空集合时不能保持沉默——glm 类模型可能仍会盲调工具试探；显式告知全部会失败。
    const provider = makeProvider([]);
    const [descriptor] = provider.list(makeContext());
    expect(descriptor.description).toContain('未启用任何 skill');
    expect(descriptor.description).toContain('不要调用');
  });
});
