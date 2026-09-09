// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NativeOAuthCallback from '../../app/oauth/callback';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  consume: vi.fn(),
  params: {
    code: 'oauth-code',
    state: 'state-12345678',
    redirect: 'ky-agent://oauth/callback',
  },
}));

vi.mock('expo-router', async () => {
  const React = await import('react');
  return {
    Stack: Object.assign(() => null, {
      Screen: ({ options }: { options: { title: string } }) =>
        React.createElement('span', null, options.title),
    }),
    useLocalSearchParams: () => h.params,
    useRouter: () => ({ replace: h.replace }),
  };
});

vi.mock('react-native', async () => {
  const React = await import('react');
  const make =
    (tag: string): React.FC<Record<string, unknown>> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ children, onPress, testID }: any) =>
      React.createElement(
        tag,
        {
          'data-testid': testID ?? undefined,
          ...(onPress ? { onClick: onPress } : {}),
        },
        children,
      );
  return {
    View: make('div'),
    Text: make('span'),
    Pressable: make('button'),
    ActivityIndicator: make('div'),
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    identity: { userId: 'user-1', tenantId: 'tenant-a', generation: 1 },
  }),
}));

vi.mock('../services/nativeOAuthHandoff', () => ({
  consumeNativeOAuthCallback: h.consume,
}));

describe('移动端 OAuth callback 页面', () => {
  beforeEach(() => {
    h.replace.mockReset();
    h.consume.mockReset();
    h.consume.mockResolvedValue({
      status: 'succeeded',
      connectorId: 'Google Workspace',
    });
  });

  afterEach(cleanup);

  it('授权成功后只引导返回能力中心的连接器页面', async () => {
    render(<NativeOAuthCallback />);

    expect(screen.getByText('连接器授权')).toBeTruthy();
    expect(
      await screen.findByText('Google Workspace 已完成授权；返回能力中心后会重新校验连接状态。'),
    ).toBeTruthy();
    expect(screen.queryByText('连接与授权')).toBeNull();
    expect(screen.queryByText(/返回个人设置/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '返回连接器' }));
    expect(h.replace).toHaveBeenCalledWith('/capabilities/connectors');
  });
});
