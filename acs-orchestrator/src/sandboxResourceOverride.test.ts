import { describe, expect, it } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import type { WorkspaceRecipe } from './protocol.js';
import { sandboxResourceOverride } from './provision.js';

/**
 * per-tenant/workspace 规格可配（2026-08-10，A 方案批次 3）。
 * 复用 WorkspaceRecipe 里既有却从未生效的 `resources.cpu` / `resources.memoryMb`。
 */
function cfg(cpuRequest: string, memoryRequest: string): AcsOrchestratorConfig {
  return { cpuRequest, memoryRequest } as unknown as AcsOrchestratorConfig;
}
function recipe(resources?: WorkspaceRecipe['resources']): WorkspaceRecipe {
  return { workspaceId: 'ws_kaiyan__u1', ...(resources ? { resources } : {}) } as WorkspaceRecipe;
}

describe('sandboxResourceOverride', () => {
  it('未指定规格时返回 undefined（回落全局默认）', () => {
    expect(sandboxResourceOverride(recipe(), cfg('500m', '1Gi'))).toBeUndefined();
    expect(sandboxResourceOverride(recipe({ timeoutMs: 1000 }), cfg('500m', '1Gi'))).toBeUndefined();
  });

  it('只覆盖 CPU 时不动内存，反之亦然', () => {
    expect(sandboxResourceOverride(recipe({ cpu: '4' }), cfg('500m', '1Gi'))).toEqual({ cpuLimit: '4' });
    expect(sandboxResourceOverride(recipe({ memoryMb: 8192 }), cfg('500m', '1Gi'))).toEqual({ memoryLimit: '8192Mi' });
  });

  it('放大规格时 request 保持全局默认不变', () => {
    const out = sandboxResourceOverride(recipe({ cpu: '4', memoryMb: 8192 }), cfg('500m', '1Gi'));
    expect(out).toEqual({ cpuLimit: '4', memoryLimit: '8192Mi' });
  });

  it('缩小到低于全局 request 时必须同步收敛 request（否则 k8s 拒绝创建 pod）', () => {
    // 全局 request 500m/1Gi，租户要 250m/512Mi —— limit < request 是非法的
    const out = sandboxResourceOverride(recipe({ cpu: '250m', memoryMb: 512 }), cfg('500m', '1Gi'));
    expect(out).toEqual({
      cpuLimit: '250m',
      cpuRequest: '250m',
      memoryLimit: '512Mi',
      memoryRequest: '512Mi',
    });
  });

  it('CPU 单位 m 与整核可混用比较', () => {
    // 1000m == 1 核，等于全局 request，不需要收敛
    expect(sandboxResourceOverride(recipe({ cpu: '1000m' }), cfg('1', '1Gi'))).toEqual({ cpuLimit: '1000m' });
    // 900m < 1 核，需要收敛
    expect(sandboxResourceOverride(recipe({ cpu: '900m' }), cfg('1', '1Gi'))).toEqual({
      cpuLimit: '900m',
      cpuRequest: '900m',
    });
  });

  it('内存单位 Gi/Mi 换算正确', () => {
    // 全局 request 2Gi = 2048Mi，租户要 1024Mi → 需收敛
    expect(sandboxResourceOverride(recipe({ memoryMb: 1024 }), cfg('500m', '2Gi'))).toEqual({
      memoryLimit: '1024Mi',
      memoryRequest: '1024Mi',
    });
  });

  it('非法值被忽略而非报错——一个手滑配置不该让整个租户卡在 provision 失败', () => {
    expect(sandboxResourceOverride(recipe({ cpu: '   ' }), cfg('500m', '1Gi'))).toBeUndefined();
    expect(sandboxResourceOverride(recipe({ memoryMb: 0 }), cfg('500m', '1Gi'))).toBeUndefined();
    expect(sandboxResourceOverride(recipe({ memoryMb: -1 }), cfg('500m', '1Gi'))).toBeUndefined();
    expect(sandboxResourceOverride(recipe({ memoryMb: Number.NaN }), cfg('500m', '1Gi'))).toBeUndefined();
  });
});
