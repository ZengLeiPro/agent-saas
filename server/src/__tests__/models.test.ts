import { describe, expect, it } from 'vitest';

import {
  getPublicModelList,
  getTenantPublicModelList,
  isModelAllowedForTenant,
  resolveContextAccountingFromModels,
  resolveModelRef,
  toRunModelOptions,
} from '../app/models.js';
import type { ModelsConfig } from '../app/config.js';

const modelsConfig: ModelsConfig = {
  default: 'openai-agents/doubao',
  allowCrossGroupSwitch: false,
  groups: [
    {
      id: 'openai-agents',
      name: 'OpenAI Agents',
      apiKey: 'sk-test',
      baseUrl: 'https://example.invalid/v1',
      extraBody: { provider_group: true, temperature: 0.2 },
      reasoning_effort: 'medium',
      models: [
        { id: 'doubao', name: 'Doubao Pro', value: 'doubao-pro' },
        {
          id: 'kimi',
          name: 'Kimi 2.6',
          value: 'kimi-2.6',
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          extraBody: { temperature: 0.7, provider_model: true },
        },
      ],
    },
  ],
};

describe('OpenAI-only model resolver', () => {
  it('returns a public model list without connection secrets', () => {
    expect(getPublicModelList(modelsConfig)).toEqual({
      default: 'openai-agents/doubao',
      allowCrossGroupSwitch: false,
      showGroupNames: true,
      groups: [
        {
          id: 'openai-agents',
          name: 'OpenAI Agents',
          models: [
            { id: 'doubao', name: 'Doubao Pro' },
            { id: 'kimi', name: 'Kimi 2.6' },
          ],
        },
      ],
    });
  });

  it('resolves configured model refs into raw runtime model options', () => {
    const resolved = resolveModelRef(modelsConfig, 'openai-agents/kimi');

    expect(resolved).toEqual({
      model: 'kimi-2.6',
      connection: {
        apiKey: 'sk-test',
        baseUrl: 'https://example.invalid/v1',
      },
      providerOptions: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
        extraBody: {
          provider_group: true,
          provider_model: true,
          temperature: 0.7,
        },
      },
    });
    expect(toRunModelOptions(resolved!)).toEqual({
      model: 'kimi-2.6',
      modelConnection: {
        apiKey: 'sk-test',
        baseUrl: 'https://example.invalid/v1',
      },
      modelProviderOptions: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
        extraBody: {
          provider_group: true,
          provider_model: true,
          temperature: 0.7,
        },
      },
    });
  });

  it('falls back to default when a model ref is stale', () => {
    expect(resolveModelRef(modelsConfig, 'openai-agents/removed')).toEqual({
      model: 'doubao-pro',
      connection: {
        apiKey: 'sk-test',
        baseUrl: 'https://example.invalid/v1',
      },
      providerOptions: {
        reasoningEffort: 'medium',
        extraBody: {
          provider_group: true,
          temperature: 0.2,
        },
      },
    });
  });

  it('classifies current-context accounting by model dispatch semantics', () => {
    const contextModelsConfig: ModelsConfig = {
      default: 'chat/gpt',
      allowCrossGroupSwitch: true,
      groups: [
        {
          id: 'chat',
          name: 'Chat',
          apiKey: 'sk-test',
          models: [
            { id: 'gpt', name: 'GPT', value: 'gpt' },
          ],
        },
        {
          id: 'ark',
          name: 'Ark Responses',
          apiKey: 'sk-test',
          protocol: 'responses',
          models: [
            { id: 'glm', name: 'GLM', value: 'glm' },
            { id: 'full-history', name: 'Full History', value: 'full-history', disable_response_chaining: true },
          ],
        },
        {
          id: 'proxy',
          name: 'Responses Proxy',
          apiKey: 'sk-test',
          protocol: 'responses',
          disable_response_chaining: true,
          models: [
            { id: 'gpt', name: 'GPT', value: 'gpt' },
          ],
        },
      ],
    };

    expect(resolveContextAccountingFromModels(contextModelsConfig, 'ark/glm')).toMatchObject({
      exact: false,
      kind: 'stateful_response_unknown',
      source: 'stateful_response',
      label: 'Responses 接力中',
    });
    expect(resolveContextAccountingFromModels(contextModelsConfig, 'ark/full-history')).toMatchObject({
      exact: true,
      kind: 'exact_current',
      source: 'provider_usage',
      label: '当前上下文',
    });
    expect(resolveContextAccountingFromModels(contextModelsConfig, 'proxy/gpt')).toMatchObject({
      exact: true,
      kind: 'exact_current',
      source: 'provider_usage',
    });
    expect(resolveContextAccountingFromModels(contextModelsConfig, 'chat/gpt')).toMatchObject({
      exact: true,
      kind: 'exact_current',
      source: 'provider_usage',
    });
    expect(resolveContextAccountingFromModels(contextModelsConfig, 'ark/removed')).toMatchObject({
      exact: false,
      kind: 'unknown',
      source: 'unknown',
    });
  });

  it('filters tenant model list and applies tenant display overrides', () => {
    const tenantList = getTenantPublicModelList(modelsConfig, {
      features: {
        filesEnabled: true,
        cronEnabled: true,
        mcpEnabled: true,
        customSkillsEnabled: true,
        debugModeAllowed: false,
      },
      quotas: {},
      models: {
        defaultModel: 'openai-agents/kimi',
        allowedModels: ['openai-agents/kimi'],
        allowUserModelSwitch: true,
        showGroupNames: true,
        displayOverrides: {
          'openai-agents/kimi': {
            displayName: '高性能模型',
            description: '适合复杂任务',
            recommended: true,
            groupDisplayName: '组织模型',
          },
        },
      },
      mcp: {
        allowTenantServers: true,
        allowGlobalServers: true,
        defaultEnabledServerIds: [],
      },
      branding: {},
      security: {
        requireDingtalkBinding: false,
      },
    });

    expect(tenantList).toEqual({
      default: 'openai-agents/kimi',
      allowCrossGroupSwitch: false,
      showGroupNames: true,
      groups: [
        {
          id: 'openai-agents',
          name: '组织模型',
          models: [
            {
              id: 'kimi',
              name: '高性能模型',
              description: '适合复杂任务',
              recommended: true,
            },
          ],
        },
      ],
    });
    expect(isModelAllowedForTenant(modelsConfig, undefined, 'openai-agents/doubao')).toBe(true);
    expect(isModelAllowedForTenant(modelsConfig, {
      features: {
        filesEnabled: true,
        cronEnabled: true,
        mcpEnabled: true,
        customSkillsEnabled: true,
        debugModeAllowed: false,
      },
      quotas: {},
      models: {
        allowedModels: ['openai-agents/kimi'],
        allowUserModelSwitch: true,
        showGroupNames: false,
      },
      mcp: {
        allowTenantServers: true,
        allowGlobalServers: true,
        defaultEnabledServerIds: [],
      },
      branding: {},
      security: {
        requireDingtalkBinding: false,
      },
    }, 'openai-agents/doubao')).toBe(false);
  });
});
