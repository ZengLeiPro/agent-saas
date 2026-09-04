import { describe, expect, it } from 'vitest';

import type { AppRuntime } from '../app/runtime.js';
import {
  createAssignmentResourceResolver,
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

  it('向治理 Scope 提供平台工具目录', async () => {
    const resolveCatalog = createEntitlementResourceCatalogResolver({ config: {} } as AppRuntime);

    await expect(resolveCatalog('tool')).resolves.toMatchObject({
      status: 'valid',
      items: expect.arrayContaining([
        { resourceId: 'Read', version: 1 },
        { resourceId: 'Shell', version: 1 },
      ]),
    });
  });

  it('只接受平台模型配置中存在的完整 ref', async () => {
    const resolveResource = createEntitlementResourceResolver(runtimeWithModels());

    await expect(resolveResource('model', 'group-a/model-1')).resolves.toEqual({ status: 'valid', version: 1 });
    await expect(resolveResource('model', 'group-a/missing')).resolves.toEqual({ status: 'not_found' });
  });

  it('只接受平台工具目录中存在的工具 id', async () => {
    const resolveResource = createEntitlementResourceResolver({ config: {} } as AppRuntime);

    await expect(resolveResource('tool', 'Read')).resolves.toEqual({ status: 'valid', version: 1 });
    await expect(resolveResource('tool', 'missing-tool')).resolves.toEqual({ status: 'not_found' });
  });

  it('平台未配置模型时 fail closed', async () => {
    const runtime = { config: {} } as AppRuntime;

    await expect(createEntitlementResourceCatalogResolver(runtime)('model')).resolves.toEqual({ status: 'unavailable' });
    await expect(createEntitlementResourceResolver(runtime)('model', 'group-a/model-1')).resolves.toEqual({ status: 'unavailable' });
  });

  it('DWS 委托只接受绑定本租户 active Agent account 的正式 scope id', async () => {
    const runtime = {
      config: {},
      agentDwsAccountStore: {
        getForTenant: async (tenantId: string, accountId: string) => tenantId === 'tenant-a' && accountId === 'account-a'
          ? { status: 'active', profileId: 'profile-a' }
          : null,
      },
    } as unknown as AppRuntime;
    const resolve = createAssignmentResourceResolver(runtime);
    const valid = `dws-delegation:account-a:${'a'.repeat(64)}`;

    await expect(resolve('tenant-a', 'dws_delegation', valid)).resolves.toBe('valid');
    await expect(resolve('tenant-b', 'dws_delegation', valid)).resolves.toBe('not_found');
    await expect(resolve('tenant-a', 'dws_delegation', 'dws-delegation:account-a:not-a-digest'))
      .resolves.toBe('not_found');
  });

  it('org_knowledge assignment 只接受本租户 active Context collection，依赖缺失时 fail closed', async () => {
    const runtime = {
      config: {},
      contextStore: {
        listCollections: async (tenantId: string) => [
          { tenantId, collectionId: 'collection-a', status: 'active' },
          { tenantId, collectionId: 'collection-disabled', status: 'disabled' },
        ],
      },
    } as unknown as AppRuntime;
    const resolve = createAssignmentResourceResolver(runtime);
    await expect(resolve('tenant-a', 'org_knowledge', 'collection-a')).resolves.toBe('valid');
    await expect(resolve('tenant-a', 'org_knowledge', 'collection-disabled')).resolves.toBe('not_found');
    await expect(createAssignmentResourceResolver({ config: {} } as AppRuntime)(
      'tenant-a', 'org_knowledge', 'collection-a',
    )).resolves.toBe('unavailable');
  });
});
