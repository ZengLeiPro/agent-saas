import { describe, expect, it } from 'vitest';

import { reasoningEffortProviderOptionShape } from '../app/reasoningEffortCapabilitySchema.js';
import { createSubagentModelCatalogGetter } from '../app/subagentModelCatalogRuntime.js';
import type { ModelsConfig } from '../app/config.js';
import type { TenantSettings } from '../data/tenants/types.js';
import { DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';

function tenantSettings(allowedModels: string[], displayName: string): TenantSettings {
  return {
    ...DEFAULT_TENANT_SETTINGS,
    models: {
      ...DEFAULT_TENANT_SETTINGS.models,
      allowedModels,
      allowUserModelSwitch: true,
      displayOverrides: {
        [allowedModels[0]!]: { displayName, description: `${displayName}说明` },
      },
    },
  };
}

describe('reasoning effort capability config', () => {
  const schema = reasoningEffortProviderOptionShape.reasoning_effort_capability;

  it('接受可信 values/default 元数据', () => {
    expect(
      schema.parse({
        support: 'supported',
        values: ['none', 'high', 'xhigh'],
        default_value: 'high',
        source: 'verified_provider',
      }),
    ).toEqual({
      support: 'supported',
      values: ['none', 'high', 'xhigh'],
      default_value: 'high',
      source: 'verified_provider',
    });
  });

  it('拒绝不在 values 中的默认值及 unsupported 伪能力', () => {
    expect(() =>
      schema.parse({
        support: 'supported',
        values: ['low', 'high'],
        default_value: 'max',
      }),
    ).toThrow('默认值必须包含在 values 中');
    expect(() =>
      schema.parse({
        support: 'unsupported',
        values: ['low'],
      }),
    ).toThrow('unsupported/unknown 能力不能声明');
  });
});

describe('runtime subagent model catalog', () => {
  let models: ModelsConfig = {
    default: 'group/a',
    allowCrossGroupSwitch: true,
    groups: [
      {
        id: 'group',
        name: '内部模型组',
        apiKey: '不得暴露的密钥',
        baseUrl: 'https://private.example/v1',
        models: [
          {
            id: 'a',
            name: '平台模型 A',
            value: 'actual-model-a',
            reasoning_effort_capability: {
              support: 'supported',
              values: ['low', 'high'],
              default_value: 'low',
              source: 'configured',
            },
          },
          {
            id: 'b',
            name: '平台模型 B',
            value: 'actual-model-b',
          },
        ],
      },
    ],
  };
  let settingsByTenant: Record<string, TenantSettings | undefined> = {
    'tenant-a': tenantSettings(['group/a'], '租户甲模型'),
    'tenant-b': tenantSettings(['group/b'], '租户乙模型'),
  };
  const getCatalog = createSubagentModelCatalogGetter({
    getRuntimeModels: () => models,
    getTenantSettings: (tenantId) => settingsByTenant[tenantId],
  });

  it('每次按当前租户投影且不泄露连接、actual model 或平台隐藏名称', () => {
    expect(getCatalog('tenant-a')).toEqual({
      defaultRef: 'group/a',
      models: [
        {
          ref: 'group/a',
          name: '租户甲模型',
          description: '租户甲模型说明',
          effort: {
            support: 'supported',
            values: ['low', 'high'],
            defaultValue: 'low',
            source: 'configured',
          },
        },
      ],
    });
    expect(getCatalog('tenant-b')).toEqual({
      defaultRef: 'group/b',
      models: [{ ref: 'group/b', name: '租户乙模型', description: '租户乙模型说明' }],
    });
    const serialized = JSON.stringify(getCatalog('tenant-a'));
    expect(serialized).not.toContain('不得暴露的密钥');
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('actual-model-a');
    expect(serialized).not.toContain('平台模型 A');
  });

  it('不缓存跨租户结果，并在运行配置变化后读取新快照', () => {
    models = {
      ...models,
      default: 'group/b',
      groups: [
        {
          ...models.groups[0]!,
          models: [{ id: 'b', name: '平台模型 B2', value: 'actual-model-b2' }],
        },
      ],
    };
    settingsByTenant = {
      ...settingsByTenant,
      'tenant-a': tenantSettings(['group/b'], '租户甲新模型'),
    };
    expect(getCatalog('tenant-a')).toEqual({
      defaultRef: 'group/b',
      models: [{ ref: 'group/b', name: '租户甲新模型', description: '租户甲新模型说明' }],
    });
  });
});
