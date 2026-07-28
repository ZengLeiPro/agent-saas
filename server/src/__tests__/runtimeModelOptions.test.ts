import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeModelOptions, resolveWakeModelRef } from '../runtime/rawRuntimeRunDispatch.js';

describe('resolveRuntimeModelOptions', () => {
  it('resolves a stored UI model ref into runtime model connection', () => {
    const resolved = resolveRuntimeModelOptions({
      modelResolver: (ref) => ref === 'openai-agents/kimi'
        ? {
            model: 'kimi-k2',
            connection: { apiKey: 'sk-model-group', baseUrl: 'https://models.example/v1' },
            providerOptions: { reasoningEffort: 'high' },
          }
        : null,
    }, 'openai-agents/kimi');

    expect(resolved).toEqual({
      model: 'kimi-k2',
      modelConnection: {
        apiKey: 'sk-model-group',
        baseUrl: 'https://models.example/v1',
      },
      modelProviderOptions: { reasoningEffort: 'high' },
    });
  });

  it('keeps explicit modelConnection instead of resolving again', () => {
    const modelResolver = vi.fn(() => ({
      model: 'default-model',
      connection: { apiKey: 'sk-default' },
    }));

    expect(resolveRuntimeModelOptions(
      { modelResolver },
      'already-resolved-model',
      { apiKey: 'sk-explicit', baseUrl: 'https://explicit.example/v1' },
      { thinking: { type: 'enabled' } },
    )).toEqual({
      model: 'already-resolved-model',
      modelConnection: {
        apiKey: 'sk-explicit',
        baseUrl: 'https://explicit.example/v1',
      },
      modelProviderOptions: { thinking: { type: 'enabled' } },
    });
    expect(modelResolver).not.toHaveBeenCalled();
  });

  it('restores the stable model ref instead of the provider model value', () => {
    expect(resolveWakeModelRef({
      model: 'gpt-5.6-sol',
      metadata: { modelRef: 'kaiyan-llm/gpt-5.6-sol-high' },
    }, {
      modelRef: 'kaiyan-llm/gpt56-sol-medium',
    })).toBe('kaiyan-llm/gpt-5.6-sol-high');

    expect(resolveWakeModelRef({
      model: 'gpt-5.6-sol',
      metadata: {},
    }, {
      modelRef: 'kaiyan-llm/gpt56-sol-medium',
    })).toBe('kaiyan-llm/gpt56-sol-medium');
  });
});
