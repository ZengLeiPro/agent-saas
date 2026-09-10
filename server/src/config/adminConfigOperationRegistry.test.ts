import { describe, expect, it } from 'vitest';

import {
  assertAdminConfigOperationScope,
  changedConfigTokenPaths,
} from './adminConfigOperationRegistry.js';

describe('admin config operation scope', () => {
  it('把带点的系统提示语 ID 当作单个 token', () => {
    const before = { systemPrompts: { 'utility.title': 'old', 'main.static': 'keep' } };
    const after = { systemPrompts: { 'utility.title': 'new', 'main.static': 'keep' } };
    expect(changedConfigTokenPaths(before, after)).toEqual([['systemPrompts', 'utility.title']]);
    expect(() =>
      assertAdminConfigOperationScope(
        { id: 'system-prompts.set', target: 'utility.title' },
        before,
        after,
      ),
    ).not.toThrow();
  });

  it('单提示语操作不能覆盖相邻提示语', () => {
    expect(() =>
      assertAdminConfigOperationScope(
        { id: 'system-prompts.set', target: 'utility.title' },
        { systemPrompts: { 'utility.title': 'old', 'main.static': 'keep' } },
        { systemPrompts: { 'utility.title': 'new', 'main.static': 'lost' } },
      ),
    ).toThrow(/未授权配置范围/u);
  });

  it('生图引擎保存不能改 pricing，价格保存也不能改引擎', () => {
    const before = {
      imageGenTools: { enabled: true, pricing: { seedream: { creditsPerImage: 1 } } },
    };
    expect(() =>
      assertAdminConfigOperationScope({ id: 'image-gen.config' }, before, {
        imageGenTools: { enabled: false, pricing: { seedream: { creditsPerImage: 2 } } },
      }),
    ).toThrow(/未授权配置范围/u);
    expect(() =>
      assertAdminConfigOperationScope({ id: 'image-gen.pricing' }, before, {
        imageGenTools: { enabled: false, pricing: { seedream: { creditsPerImage: 1 } } },
      }),
    ).toThrow(/未授权配置范围/u);
  });

  it('Codex 排序只能修改凭据顺序字段', () => {
    const before = { codexSubscription: { enabled: true, credentialRefs: ['a', 'b'] } };
    expect(() =>
      assertAdminConfigOperationScope({ id: 'codex.order' }, before, {
        codexSubscription: { enabled: false, credentialRefs: ['b', 'a'] },
      }),
    ).toThrow(/未授权配置范围/u);
  });
});
