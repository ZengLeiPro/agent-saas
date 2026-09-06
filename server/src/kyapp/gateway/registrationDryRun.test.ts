/**
 * WP3 Phase B：模型端工具注册 dry-run（规范 §8.1）。
 */
import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestCapability } from '@kaiyan/ky-app-contract';

import { runKyAppToolRegistrationDryRun } from '../systems/publishGate.js';
import { createKyAppToolRegistrationDryRun, dryRunToolRegistration } from './registrationDryRun.js';

function capability(overrides: Partial<ManifestCapability> = {}): ManifestCapability {
  return {
    id: 'order.search',
    name: '查订单',
    description: '按条件查询订单列表。',
    riskLevel: 'read_only',
    approval: 'none',
    safeToRetry: true,
    inputSchema: {
      type: 'object',
      properties: { keyword: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...overrides,
  } as ManifestCapability;
}

function manifest(capabilities: ManifestCapability[], systemId = 'demo-erp'): Manifest {
  return {
    contractVersion: 1,
    systemId,
    name: '演示 ERP',
    capabilities,
  } as unknown as Manifest;
}

describe('注册 dry-run', () => {
  it('合法 manifest 通过', () => {
    expect(() => dryRunToolRegistration(manifest([capability()]))).not.toThrow();
  });

  it('拒 Unicode property escapes（08-23 事故）', () => {
    const bad = capability({
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: '形如 \\p{Han}+ 的编号' } },
        additionalProperties: false,
      },
    });
    expect(() => dryRunToolRegistration(manifest([bad]))).toThrow(/Unicode property escapes/u);
  });

  it('拒 lookbehind 与命名组', () => {
    for (const value of ['(?<=x)y', '(?<name>x)']) {
      const bad = capability({
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string', description: value } },
          additionalProperties: false,
        },
      });
      expect(() => dryRunToolRegistration(manifest([bad]))).toThrow();
    }
  });

  it('拒 §4.5 能力 schema 子集禁用的关键字（含嵌套层）', () => {
    const bad = capability({
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'object', properties: { b: { anyOf: [{ type: 'string' }] } } } },
        additionalProperties: false,
      },
    });
    expect(() => dryRunToolRegistration(manifest([bad]))).toThrow(/anyOf/u);
    const withPattern = capability({
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'string', pattern: '^x$' } },
        additionalProperties: false,
      },
    });
    expect(() => dryRunToolRegistration(manifest([withPattern]))).toThrow(/pattern/u);
  });

  it('拒过长工具名与描述', () => {
    const longId = 'a'.repeat(60);
    expect(() => dryRunToolRegistration(manifest([capability({ id: longId })]))).toThrow();
    expect(() =>
      dryRunToolRegistration(manifest([capability({ description: '很长'.repeat(200) })])),
    ).toThrow(/description/u);
  });

  it('拒规范化后撞名（`-` 与 `.` 都会变成 `_`）', () => {
    expect(() =>
      dryRunToolRegistration(
        manifest([capability({ id: 'order.search' }), capability({ id: 'order-search' })]),
      ),
    ).toThrow(/重复/u);
  });

  it('缺 systemId 直接拒', () => {
    expect(() => dryRunToolRegistration({ capabilities: [] } as unknown as Manifest)).toThrow(
      /systemId/u,
    );
  });

  it('接进发布门禁：通过为 passed，失败为 failed（不是 skipped）', async () => {
    const hook = createKyAppToolRegistrationDryRun();
    await expect(runKyAppToolRegistrationDryRun(manifest([capability()]), hook)).resolves.toEqual({
      status: 'passed',
    });
    const bad = manifest([
      capability({
        inputSchema: { type: 'object', properties: { a: { type: 'string', pattern: '\\p{L}' } } },
      }),
    ]);
    const outcome = await runKyAppToolRegistrationDryRun(bad, hook);
    expect(outcome.status).toBe('failed');
    // 未配置钩子仍是 skipped —— skipped ≠ 通过。
    await expect(
      runKyAppToolRegistrationDryRun(manifest([capability()]), undefined),
    ).resolves.toMatchObject({
      status: 'skipped',
    });
  });
});
