import { describe, expect, it, vi } from 'vitest';

import { controlPlaneFetch, isLoopbackControlPlane } from './controlPlaneFetch.js';

describe('controlPlaneFetch', () => {
  it('只把 HTTP loopback 识别为同机控制面', () => {
    expect(isLoopbackControlPlane('http://127.0.0.1:3410')).toBe(true);
    expect(isLoopbackControlPlane('http://[::1]:3410')).toBe(true);
    expect(isLoopbackControlPlane('https://127.0.0.1:3410')).toBe(false);
    expect(isLoopbackControlPlane('http://10.0.0.8:3410')).toBe(false);
    expect(isLoopbackControlPlane('not-a-url')).toBe(false);
  });

  it('显式注入不会被 loopback 规则覆盖', () => {
    const injected = vi.fn<typeof fetch>();
    expect(controlPlaneFetch('http://127.0.0.1:3410', injected)).toBe(injected);
  });

  it('全局 fetch 被 Staging 代理接管后仍只让 loopback 使用启动前直连实现', () => {
    const previous = globalThis.fetch;
    const guarded = vi.fn<typeof fetch>();
    globalThis.fetch = guarded;
    try {
      expect(controlPlaneFetch('http://127.0.0.1:3410')).not.toBe(guarded);
      expect(controlPlaneFetch('https://acs.example.test')).toBe(guarded);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
