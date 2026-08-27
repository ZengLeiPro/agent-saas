import { describe, expect, it } from 'vitest';

import {
  applySandboxProfileResources,
  resolveSessionSandboxProfile,
  sandboxResourcesFromHand,
  sandboxResourcesForSessionHand,
} from './sandboxProfile.js';

describe('sandboxProfile', () => {
  it('defaults new sessions to daily and legacy persisted sessions to coding', () => {
    expect(resolveSessionSandboxProfile({})).toBe('daily');
    expect(resolveSessionSandboxProfile({ existing: {} })).toBe('coding');
  });

  it('accepts only allowlisted profiles for new sessions', () => {
    expect(resolveSessionSandboxProfile({ requested: 'coding' })).toBe('coding');
    expect(resolveSessionSandboxProfile({ requested: 'daily' })).toBe('daily');
    expect(resolveSessionSandboxProfile({ requested: 'oversized' })).toBe('daily');
  });

  it('keeps persisted profile authoritative over continuation requests', () => {
    expect(resolveSessionSandboxProfile({
      existing: { sandboxProfile: 'daily' },
      requested: 'coding',
    })).toBe('daily');
  });

  it('forces taskboard profile to coding', () => {
    expect(resolveSessionSandboxProfile({
      existing: { sandboxProfile: 'daily' },
      forceProfile: 'coding',
    })).toBe('coding');
  });

  it('maps daily/coding to ACS CPU and memory while preserving unrelated limits', () => {
    expect(applySandboxProfileResources({ resources: { diskMb: 8192, timeoutMs: 60_000 } }, 'daily'))
      .toMatchObject({ resources: { cpu: '1', memoryMb: 2048, diskMb: 8192, timeoutMs: 60_000 } });
    expect(applySandboxProfileResources({ resources: { cpu: '9', memoryMb: 99 } }, 'coding'))
      .toMatchObject({ resources: { cpu: '2', memoryMb: 4096 } });
  });

  it('reads the final registered hand resources for later execute calls', () => {
    expect(sandboxResourcesFromHand({ metadata: { recipe: { resources: { cpu: '4', memoryMb: 8192 } } } }))
      .toEqual({ cpu: '4', memoryMb: 8192 });
    expect(sandboxResourcesFromHand({ metadata: { recipe: { resources: { cpu: '', memoryMb: 0 } } } }))
      .toBeUndefined();
    expect(sandboxResourcesForSessionHand([
      { handId: 'session-1:server-remote', metadata: { recipe: { resources: { cpu: '1', memoryMb: 2048 } } } },
    ], 'session-1', 'server-remote')).toEqual({ cpu: '1', memoryMb: 2048 });
  });
});
