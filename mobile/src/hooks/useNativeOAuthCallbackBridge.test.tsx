// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNativeOAuthCallbackBridge } from './useNativeOAuthCallbackBridge';

const h = vi.hoisted(() => ({
  initial: null as string | null,
  handler: null as null | ((event: { url: string }) => void),
  replace: vi.fn(), remove: vi.fn(),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock('react-native', () => ({ Linking: {
  getInitialURL: vi.fn(async () => h.initial),
  addEventListener: vi.fn((_name: string, handler: (event: { url: string }) => void) => { h.handler = handler; return { remove: h.remove }; }),
} }));
vi.mock('../platform/nativeOAuthCallbackPolicy', () => ({ getNativeOAuthCallbackAllowlist: () => ['agent-saas://oauth/callback', 'https://mobile.example.test/oauth/callback'] }));

const query = `state=${'s'.repeat(64)}&code=${'c'.repeat(48)}&provider=google-workspace&redirect=${encodeURIComponent('agent-saas://oauth/callback')}&generation=2`;
function Harness() { useNativeOAuthCallbackBridge(); return null; }

afterEach(cleanup);
beforeEach(() => { h.initial = null; h.handler = null; vi.clearAllMocks(); });

describe('M30-01 cold/warm Linking bridge', () => {
  it('routes a cold-start initialURL', async () => {
    h.initial = `agent-saas://oauth/callback?${query}`;
    render(<Harness />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/oauth/callback' })));
  });

  it('routes a warm verified HTTPS Linking event', async () => {
    render(<Harness />);
    const url = `https://mobile.example.test/oauth/callback?state=${'s'.repeat(64)}&error=ACCESS_DENIED&provider=google-workspace&redirect=${encodeURIComponent('https://mobile.example.test/oauth/callback')}&generation=2`;
    await act(async () => { h.handler?.({ url }); });
    expect(h.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/oauth/callback', params: expect.objectContaining({ error: 'ACCESS_DENIED' }) }));
  });

  it('ignores unknown domain/route and removes listener on unmount', async () => {
    const mounted = render(<Harness />);
    await act(async () => { h.handler?.({ url: `https://evil.test/oauth/callback?${query}` }); });
    expect(h.replace).not.toHaveBeenCalled();
    mounted.unmount(); expect(h.remove).toHaveBeenCalledOnce();
  });
});
