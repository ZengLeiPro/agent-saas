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
import { DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';

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
      showContextTokens: true,
      allowContextTokenDetails: false,
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

  it('preserves configured group and model order in the global public list', () => {
    const reordered: ModelsConfig = {
      ...modelsConfig,
      groups: [
        { id: 'backup', name: 'Backup', models: [{ id: 'glm', name: 'GLM', value: 'glm' }] },
        { ...modelsConfig.groups[0]!, models: [...modelsConfig.groups[0]!.models].reverse() },
      ],
    };

    const publicList = getPublicModelList(reordered);
    expect(publicList.groups.map((group) => group.id)).toEqual(['backup', 'openai-agents']);
    expect(publicList.groups[1]?.models.map((model) => model.id)).toEqual(['kimi', 'doubao']);
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

  it('maps max_output_tokens config (model overrides group) to providerOptions.maxOutputTokens', () => {
    const withMaxOutput: ModelsConfig = {
      default: 'ark/glm',
      allowCrossGroupSwitch: false,
      groups: [
        {
          id: 'ark',
          name: 'Ark',
          apiKey: 'sk-test',
          baseUrl: 'https://example.invalid/v3',
          max_output_tokens: 32768,
          models: [
            { id: 'glm', name: 'GLM', value: 'glm-5.2' },
            { id: 'doubao', name: 'Doubao', value: 'doubao-pro', max_output_tokens: 49152 },
          ],
        },
      ],
    };

    // group 级兜底
    expect(resolveModelRef(withMaxOutput, 'ark/glm')?.providerOptions?.maxOutputTokens).toBe(32768);
    // model 级覆盖 group 级
    expect(resolveModelRef(withMaxOutput, 'ark/doubao')?.providerOptions?.maxOutputTokens).toBe(49152);
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
      exact: true,
      kind: 'stateful_response_exact',
      source: 'provider_usage',
      label: '当前上下文',
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
        autoCompactEnabled: false,
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
      personalization: DEFAULT_TENANT_SETTINGS.personalization,
      security: {
        requireDingtalkBinding: false,
      },
    });

    expect(tenantList).toEqual({
      default: 'openai-agents/kimi',
      allowCrossGroupSwitch: false,
      showGroupNames: true,
      showContextTokens: true,
      allowContextTokenDetails: false,
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
        autoCompactEnabled: false,
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
      personalization: DEFAULT_TENANT_SETTINGS.personalization,
      security: {
        requireDingtalkBinding: false,
      },
    }, 'openai-agents/doubao')).toBe(false);
  });

  it('propagates tenant showContextTokens policy to public model list', () => {
    const baseSettings = {
      features: {
        filesEnabled: true,
        cronEnabled: true,
        mcpEnabled: true,
        customSkillsEnabled: true,
        debugModeAllowed: false,
        autoCompactEnabled: false,
      },
      quotas: {},
      mcp: {
        allowTenantServers: true,
        allowGlobalServers: true,
        defaultEnabledServerIds: [],
      },
      branding: {},
      personalization: DEFAULT_TENANT_SETTINGS.personalization,
      security: {
        requireDingtalkBinding: false,
      },
    };

    // 关闭时透传 false
    expect(getTenantPublicModelList(modelsConfig, {
      ...baseSettings,
      models: {
        allowedModels: [],
        allowUserModelSwitch: true,
        showGroupNames: false,
        showContextTokens: false,
      },
    }).showContextTokens).toBe(false);

    expect(getTenantPublicModelList(modelsConfig, {
      ...baseSettings,
      models: {
        allowedModels: [],
        allowUserModelSwitch: true,
        showGroupNames: false,
        showContextTokens: true,
        allowContextTokenDetails: true,
      },
    }).allowContextTokenDetails).toBe(true);

    expect(getTenantPublicModelList(modelsConfig, {
      ...baseSettings,
      models: {
        allowedModels: [],
        allowUserModelSwitch: true,
        showGroupNames: false,
        showContextTokens: false,
        allowContextTokenDetails: true,
      },
    }).allowContextTokenDetails).toBe(false);

    // 缺省（存量租户）= 显示
    expect(getTenantPublicModelList(modelsConfig, {
      ...baseSettings,
      models: {
        allowedModels: [],
        allowUserModelSwitch: true,
        showGroupNames: false,
      },
    }).showContextTokens).toBe(true);

    // 无租户 settings（平台视图）= 显示
    expect(getPublicModelList(modelsConfig).showContextTokens).toBe(true);
    expect(getPublicModelList(modelsConfig).allowContextTokenDetails).toBe(false);
  });
});
