import { describe, expect, it } from 'vitest';
import {
  parseModelRef,
  resolveLockedModelGroupId,
  resolveSelectedModelName,
  selectableModelGroups,
} from './modelSelection';

const modelList = {
  groups: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        { id: 'opus', name: 'Opus' },
        { id: 'haiku', name: 'Haiku' },
      ],
    },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] },
  ],
  allowCrossGroupSwitch: false,
};

describe('modelSelection', () => {
  it('按首个斜杠拆分 ref', () => {
    expect(parseModelRef('anthropic/opus')).toEqual({ groupId: 'anthropic', modelId: 'opus' });
    expect(parseModelRef('a/b/c')).toEqual({ groupId: 'a', modelId: 'b/c' });
    expect(parseModelRef('opus')).toBeNull();
    expect(parseModelRef(null)).toBeNull();
  });

  it('已开始的会话锁定分组，新会话与允许跨组时不锁', () => {
    expect(
      resolveLockedModelGroupId({ sessionId: 's-1', selectedModel: 'anthropic/opus', modelList }),
    ).toBe('anthropic');
    expect(
      resolveLockedModelGroupId({ sessionId: null, selectedModel: 'anthropic/opus', modelList }),
    ).toBeNull();
    expect(
      resolveLockedModelGroupId({ sessionId: 'new', selectedModel: 'anthropic/opus', modelList }),
    ).toBeNull();
    expect(
      resolveLockedModelGroupId({ sessionId: 's-1', selectedModel: null, modelList }),
    ).toBeNull();
    expect(
      resolveLockedModelGroupId({
        sessionId: 's-1',
        selectedModel: 'anthropic/opus',
        modelList: { allowCrossGroupSwitch: true },
      }),
    ).toBeNull();
  });

  it('展示名解析失败时回落 null', () => {
    expect(resolveSelectedModelName(modelList, 'anthropic/opus')).toBe('Opus');
    expect(resolveSelectedModelName(modelList, 'anthropic/gone')).toBeNull();
    expect(resolveSelectedModelName(modelList, 'gone/opus')).toBeNull();
    expect(resolveSelectedModelName(modelList, 'opus')).toBeNull();
    expect(resolveSelectedModelName(null, 'anthropic/opus')).toBeNull();
  });

  it('锁组后只剩锁定分组', () => {
    expect(selectableModelGroups(modelList, null).map((group) => group.id)).toEqual([
      'anthropic',
      'openai',
    ]);
    expect(selectableModelGroups(modelList, 'openai').map((group) => group.id)).toEqual(['openai']);
    expect(selectableModelGroups(null, null)).toEqual([]);
  });
});
