import { describe, expect, it } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import { sandboxResourceOverride } from './provision.js';
import { parseWarmupResources } from './protocol.js';

describe('warmup resource parsing', () => {
  it.each([
    [{ cpu: '1', memoryMb: 2_048 }, { cpuLimit: '1', memoryLimit: '2048Mi' }],
    [{ cpu: '2', memoryMb: 4_096 }, { cpuLimit: '2', memoryLimit: '4096Mi' }],
  ])('strictly parses profile resources and reuses provision conversion', (body, expected) => {
    const parsed = parseWarmupResources(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(sandboxResourceOverride(
      { workspaceId: 'ws_kaiyan__u1', resources: parsed.value },
      { cpuRequest: '250m', memoryRequest: '512Mi' } as AcsOrchestratorConfig,
    )).toEqual(expected);
  });

  it.each([
    [null],
    [{}],
    [{ cpu: 1 }],
    [{ cpu: '0' }],
    [{ memoryMb: 2048.5 }],
    [{ memoryMb: 0 }],
    [{ cpu: '1', memoryMb: 2048, timeoutMs: 1000 }],
  ])('rejects malformed warmup resources: %j', (body) => {
    expect(parseWarmupResources(body).ok).toBe(false);
  });

  it('allows omitted resources for legacy SessionCatalog records', () => {
    expect(parseWarmupResources(undefined)).toEqual({ ok: true });
  });
});
