import { describe, expect, it, vi } from 'vitest';

import {
  resolveRuntimeModelOptions,
  resolveRuntimeModelRef,
  resolveWakeModelRef,
} from '../runtime/rawRuntimeRunDispatch.js';

describe('resolveRuntimeModelOptions', () => {
  it('resolves a stored UI model ref into runtime model connection with tenant scope', () => {
    const modelResolver = vi.fn((ref: string) => ref === 'openai-agents/kimi'
      ? {
          model: 'kimi-k2',
          connection: { apiKey: 'sk-model-group', baseUrl: 'https://models.example/v1' },
          providerOptions: { reasoningEffort: 'high' as const },
        }
      : null);
    const resolved = resolveRuntimeModelOptions(
      { modelResolver },
      'openai-agents/kimi',
      undefined,
      undefined,
      'tenant-a',
    );

    expect(modelResolver).toHaveBeenCalledWith('openai-agents/kimi', 'tenant-a');
    expect(resolved).toEqual({
      model: 'kimi-k2',
      modelConnection: {
        apiKey: 'sk-model-group',
        baseUrl: 'https://models.example/v1',
      },
      modelProviderOptions: { reasoningEffort: 'high' },
    });
  });

  it('fails closed when a tenant-scoped model ref can no longer be resolved', () => {
    expect(() => resolveRuntimeModelOptions(
      { modelResolver: () => null },
      'openai-agents/disabled',
      undefined,
      undefined,
      'tenant-a',
    )).toThrow('模型不可用：openai-agents/disabled');
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

  it('resolves the tenant default when the client sends before its model list is ready', () => {
    const defaultModelResolver = vi.fn(() => ({
      ref: 'ark-agents/glm-5.3',
      model: 'glm-5.3',
      connection: { apiKey: 'sk-staging' },
    }));

    const modelRef = resolveRuntimeModelRef(
      { modelResolver: () => null, defaultModelResolver },
      undefined,
      'pantheon',
    );

    expect(modelRef).toBe('ark-agents/glm-5.3');
    expect(defaultModelResolver).toHaveBeenCalledWith('pantheon');
    expect(resolveRuntimeModelOptions({
      modelResolver: (ref) => ref === modelRef
        ? { model: 'glm-5.3', connection: { apiKey: 'sk-staging' } }
        : null,
    }, modelRef, undefined, undefined, 'pantheon')).toMatchObject({
      model: 'glm-5.3',
      modelConnection: { apiKey: 'sk-staging' },
    });
  });

  it('does not replace an explicit connection with the configured default ref', () => {
    const defaultModelResolver = vi.fn(() => ({ ref: 'ark-agents/glm-5.3', model: 'glm-5.3' }));

    expect(resolveRuntimeModelRef(
      { modelResolver: () => null, defaultModelResolver },
      undefined,
      'pantheon',
      true,
    )).toBeUndefined();
    expect(defaultModelResolver).not.toHaveBeenCalled();
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
