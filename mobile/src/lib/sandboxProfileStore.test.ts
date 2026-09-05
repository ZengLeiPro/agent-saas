import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDraftSandboxProfile,
  resetDraftSandboxProfile,
  setDraftSandboxProfile,
  subscribeDraftSandboxProfile,
} from './sandboxProfileStore';

afterEach(() => {
  resetDraftSandboxProfile();
});

describe('sandboxProfileStore', () => {
  it('默认日常档位', () => {
    expect(getDraftSandboxProfile()).toBe('daily');
  });

  it('写入后可读，重置回默认', () => {
    setDraftSandboxProfile('coding');
    expect(getDraftSandboxProfile()).toBe('coding');
    resetDraftSandboxProfile();
    expect(getDraftSandboxProfile()).toBe('daily');
  });

  it('只有值真的变化才通知订阅者，退订后不再收到通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDraftSandboxProfile(listener);
    setDraftSandboxProfile('coding');
    setDraftSandboxProfile('coding');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setDraftSandboxProfile('daily');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
