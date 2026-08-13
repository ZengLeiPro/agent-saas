import { describe, expect, it } from 'vitest';

import type { AppRuntime } from '../app/runtime.js';
import {
  createEntitlementResourceCatalogResolver,
  createEntitlementResourceResolver,
} from '../app/runtimeAssignmentResourceResolver.js';

function runtimeWithModels(): AppRuntime {
  return {
    config: {
      models: {
        default: 'group-a/model-1',
        allowCrossGroupSwitch: true,
        groups: [
          {
            id: 'group-a',
            name: 'A 组',
            models: [
              { id: 'model-1', name: '模型一', value: 'upstream-model-1' },
              { id: 'model-2', name: '模型二', value: 'upstream-model-2' },
            ],
          },
        ],
      },
    },
  } as AppRuntime;
}

describe('runtime entitlement model resolver', () => {
  it('向治理 Scope 提供平台模型目录', async () => {
    const resolveCatalog = createEntitlementResourceCatalogResolver(runtimeWithModels());

    await expect(resolveCatalog('model')).resolves.toEqual({
      status: 'valid',
      items: [
        { resourceId: 'group-a/model-1', version: 1 },
        { resourceId: 'group-a/model-2', version: 1 },
      ],
    });
  });

  it('只接受平台模型配置中存在的完整 ref', async () => {
    const resolveResource = createEntitlementResourceResolver(runtimeWithModels());

    await expect(resolveResource('model', 'group-a/model-1')).resolves.toEqual({ status: 'valid', version: 1 });
    await expect(resolveResource('model', 'group-a/missing')).resolves.toEqual({ status: 'not_found' });
  });

  it('平台未配置模型时 fail closed', async () => {
    const runtime = { config: {} } as AppRuntime;

    await expect(createEntitlementResourceCatalogResolver(runtime)('model')).resolves.toEqual({ status: 'unavailable' });
    await expect(createEntitlementResourceResolver(runtime)('model', 'group-a/model-1')).resolves.toEqual({ status: 'unavailable' });
  });
});
