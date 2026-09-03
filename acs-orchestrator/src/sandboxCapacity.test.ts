import { describe, expect, it, vi } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import {
  canAdmitWithReclaimableUsage,
  enforceSandboxCapacity,
  parseCpuMillicores,
  parseMemoryBytes,
  usageForRef,
  zeroUsage,
} from './sandboxCapacity.js';

const config = (overrides: Partial<AcsOrchestratorConfig> = {}) => ({
  cpuRequest: '1',
  cpuLimit: '2',
  memoryRequest: '2Gi',
  memoryLimit: '4Gi',
  maxRunningSandboxes: 2,
  maxAllocatedCpuMillicores: 4_000,
  maxAllocatedMemoryMib: 8_192,
  ...overrides,
}) as AcsOrchestratorConfig;

describe('Sandbox weighted capacity', () => {
  it('parses Kubernetes CPU and memory quantities', () => {
    expect(parseCpuMillicores('750m')).toBe(750);
    expect(parseCpuMillicores('1.5')).toBe(1_500);
    expect(parseMemoryBytes('2Gi')).toBe(2 * 1024 ** 3);
    expect(parseMemoryBytes('500M')).toBe(500_000_000);
  });

  it('uses the larger request/limit and honors per-Sandbox overrides', () => {
    const usage = usageForRef({
      name: 'as-new', workspaceId: 'ws', sessionId: 's', sandboxScopeId: 'scope', mountSubPath: 'workspaces/u',
      resources: { cpuLimit: '3', memoryLimit: '6Gi' },
    }, config());
    expect(usage).toEqual({ count: 1, cpuMillicores: 3_000, memoryBytes: 6 * 1024 ** 3 });
  });

  it('只回收安全的 Paused Sandbox，不回收 Running', async () => {
    const evict = vi.fn(async () => true);
    const result = await enforceSandboxCapacity({
      sandboxes: [
        { name: 'as-running', phase: 'Running', lastActiveAt: '2026-08-24T10:00:00Z' },
        { name: 'as-paused', phase: 'Paused', lastActiveAt: '2026-08-24T09:00:00Z' },
      ],
      currentName: 'as-new',
      desiredUsage: { count: 1, cpuMillicores: 2_000, memoryBytes: 4 * 1024 ** 3 },
      pendingUsage: zeroUsage(),
      config: config(),
      allowEviction: true,
      canEvict: () => true,
      evict,
    });
    expect(result.evicted).toEqual(['as-paused']);
    expect(evict).toHaveBeenCalledTimes(1);
    expect(evict).toHaveBeenCalledWith(expect.objectContaining({ name: 'as-paused' }));
  });

  it('按最早 lifecycle deadline 回收，而不是按旧 lastActiveAt 顺序', async () => {
    const evict = vi.fn(async () => true);
    const result = await enforceSandboxCapacity({
      sandboxes: [
        {
          name: 'as-old-activity', phase: 'Paused', lastActiveAt: '2024-01-01T00:00:00Z',
          retentionDeadline: '2023-01-02T00:00:00Z', workloadClass: 'interactive',
        },
        {
          name: 'as-urgent-deadline', phase: 'Paused', lastActiveAt: '2024-02-01T00:00:00Z',
          retentionDeadline: '2023-01-01T00:00:00Z', workloadClass: 'interactive',
        },
      ],
      currentName: 'as-new', desiredUsage: { count: 1, cpuMillicores: 2_000, memoryBytes: 4 * 1024 ** 3 },
      pendingUsage: zeroUsage(), config: config(), allowEviction: true, canEvict: () => true, evict,
    });
    expect(result.evicted).toEqual(['as-urgent-deadline']);
  });

  it('fails with a structured snapshot when no safe capacity remains', async () => {
    const promise = enforceSandboxCapacity({
      sandboxes: [{ name: 'as-running', phase: 'Running' }, { name: 'as-deleting', phase: 'Deleting' }],
      currentName: 'as-new',
      desiredUsage: { count: 1, cpuMillicores: 2_000, memoryBytes: 4 * 1024 ** 3 },
      pendingUsage: zeroUsage(),
      config: config(),
      allowEviction: true,
      canEvict: () => true,
      evict: async () => true,
    });
    await expect(promise).rejects.toMatchObject({
      name: 'SandboxCapacityError',
      code: 'ACS_CAPACITY_EXHAUSTED',
      snapshot: { count: 3, cpuMillicores: 6_000 },
    });
  });

  it('reports execution readiness only when safe Paused capacity is sufficient', () => {
    const allocated = { count: 2, cpuMillicores: 4_000, memoryBytes: 8 * 1024 ** 3 };
    const desired = { count: 1, cpuMillicores: 2_000, memoryBytes: 4 * 1024 ** 3 };
    expect(canAdmitWithReclaimableUsage(
      allocated,
      desired,
      { count: 1, cpuMillicores: 1_000, memoryBytes: 2 * 1024 ** 3 },
      config(),
    )).toBe(false);
    expect(canAdmitWithReclaimableUsage(
      allocated,
      desired,
      { count: 1, cpuMillicores: 2_000, memoryBytes: 4 * 1024 ** 3 },
      config(),
    )).toBe(true);
  });
});
