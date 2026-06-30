import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeModelOptions } from '../runtime/rawRuntimeRunDispatch.js';

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
});
