/**
 * WP2a DoD：发布门禁用例（规范 §8.1）。
 * 规范点名的每一类语义 diff 各来一条，确认都能触发非发布者复核。
 */
import { describe, expect, it } from 'vitest';

import type { Manifest } from '@kaiyan/ky-app-contract';

import {
  evaluateKyAppPublishGate,
  runKyAppToolRegistrationDryRun,
} from '../systems/publishGate.js';
import { buildManifest } from './harness.js';

function manifest(override: Record<string, unknown> = {}): Manifest {
  return buildManifest(override) as unknown as Manifest;
}

function withCapability(patch: Record<string, unknown>): Manifest {
  const base = manifest();
  const capability = { ...base.capabilities[0]!, ...patch };
  return { ...base, capabilities: [capability] } as Manifest;
}

function withInput(patch: Record<string, unknown>): Manifest {
  const base = manifest();
  const capability = base.capabilities[0]!;
  return {
    ...base,
    capabilities: [
      {
        ...capability,
        inputSchema: {
          ...capability.inputSchema,
          ...patch,
          properties: {
            ...(capability.inputSchema.properties as Record<string, unknown>),
            ...((patch.properties as Record<string, unknown> | undefined) ?? {}),
          },
        },
      },
    ],
  } as Manifest;
}

describe('发布门禁语义 diff', () => {
  it('首个版本一律进人工风险审核', () => {
    const gate = evaluateKyAppPublishGate({ previous: null, next: manifest() });
    expect(gate.reviewRequired).toBe(true);
    expect(gate.reasons[0]).toContain('首个版本');
  });

  it('完全相同的 manifest 不触发复核', () => {
    const gate = evaluateKyAppPublishGate({ previous: manifest(), next: manifest() });
    expect(gate).toEqual({ reviewRequired: false, reasons: [] });
  });

  it('riskLevel 降低触发复核', () => {
    const previous = withCapability({
      riskLevel: 'external_write',
      approval: 'required',
      safeToRetry: false,
    });
    const gate = evaluateKyAppPublishGate({ previous, next: manifest() });
    expect(gate.reviewRequired).toBe(true);
    expect(gate.reasons.join('；')).toContain('riskLevel 由 external_write 降为 read_only');
  });

  it('required 删除触发复核', () => {
    const next = withInput({ required: [] });
    const gate = evaluateKyAppPublishGate({ previous: manifest(), next });
    expect(gate.reasons.join('；')).toContain('required 删除了字段 keyword');
  });

  it('enum 扩张触发复核', () => {
    const next = withInput({
      properties: { channel: { type: 'string', enum: ['web', 'app', 'openapi'] } },
    });
    const gate = evaluateKyAppPublishGate({ previous: manifest(), next });
    expect(gate.reasons.join('；')).toContain('enum 扩张');
  });

  it('minimum 降低触发复核', () => {
    const next = withInput({
      properties: { limit: { type: 'integer', minimum: 0, maximum: 20 } },
    });
    const gate = evaluateKyAppPublishGate({ previous: manifest(), next });
    expect(gate.reasons.join('；')).toContain('minimum 由 1 降到 0');
  });

  it('maximum 升高触发复核', () => {
    const next = withInput({
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
    });
    const gate = evaluateKyAppPublishGate({ previous: manifest(), next });
    expect(gate.reasons.join('；')).toContain('maximum 由 20 升到 500');
  });

  it('additionalProperties 放宽触发复核', () => {
    const next = withInput({ additionalProperties: true });
    const gate = evaluateKyAppPublishGate({ previous: manifest(), next });
    expect(gate.reasons.join('；')).toContain('additionalProperties 由 false 放宽');
  });

  it('新增能力与移除能力都触发复核', () => {
    const base = manifest();
    const added = {
      ...base,
      capabilities: [
        ...base.capabilities,
        { ...base.capabilities[0]!, id: 'order.cancel', name: '取消订单' },
      ],
    } as Manifest;
    expect(evaluateKyAppPublishGate({ previous: base, next: added }).reasons.join('；')).toContain(
      'order.cancel: 新增能力',
    );
    expect(evaluateKyAppPublishGate({ previous: added, next: base }).reasons.join('；')).toContain(
      'order.cancel: 已从 manifest 移除或改名',
    );
  });

  it('description 变更触发复核（能力级与系统级）', () => {
    const capabilityChanged = withCapability({ description: '改写后的说明：返回订单列表。' });
    expect(
      evaluateKyAppPublishGate({ previous: manifest(), next: capabilityChanged }).reasons.join(
        '；',
      ),
    ).toContain('description 变更');
    const systemChanged = manifest({ description: '换了系统简介' });
    expect(
      evaluateKyAppPublishGate({ previous: manifest(), next: systemChanged }).reasons.join('；'),
    ).toContain('系统 description 变更');
  });

  it('pathPrefixes 新增触发复核', () => {
    const next = manifest({
      pathPrefixes: { user: ['/api/app/', '/api/portal/'], admin: ['/api/admin/'] },
    });
    expect(evaluateKyAppPublishGate({ previous: manifest(), next }).reasons.join('；')).toContain(
      'pathPrefixes 新增 /api/portal/',
    );
  });

  it('收紧不触发复核（新增 required、enum 收缩、上界变小）', () => {
    const next = withInput({
      required: ['keyword', 'limit'],
      properties: {
        channel: { type: 'string', enum: ['web'] },
        limit: { type: 'integer', minimum: 2, maximum: 10 },
      },
    });
    expect(evaluateKyAppPublishGate({ previous: manifest(), next }).reviewRequired).toBe(false);
  });

  it('工具注册 dry-run 未配置记 skipped，配置后按结果分流', async () => {
    await expect(runKyAppToolRegistrationDryRun(manifest(), undefined)).resolves.toMatchObject({
      status: 'skipped',
    });
    await expect(
      runKyAppToolRegistrationDryRun(manifest(), async () => undefined),
    ).resolves.toEqual({ status: 'passed' });
    await expect(
      runKyAppToolRegistrationDryRun(manifest(), async () => {
        throw new Error('模型端拒绝了这个工具名');
      }),
    ).resolves.toMatchObject({ status: 'failed', reason: '模型端拒绝了这个工具名' });
  });
});
