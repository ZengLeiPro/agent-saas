import { describe, expect, it } from 'vitest';
import {
  connectorActionLabel,
  connectorStatusLabel,
  connectorStatusTone,
  isAuthSessionInProgress,
  resolveCredentialConnectorStatus,
  resolvePollingConnectorStatus,
} from './connectorStatus';

const base = {
  loading: false,
  connections: [],
  authSessionStatus: null,
  connecting: false,
  runtimeEnabled: true,
  serviceUnavailable: false,
} as const;

describe('轮询式连接器状态（钉钉 DWS / 飞书）', () => {
  it('授权会话中间态判定', () => {
    expect(isAuthSessionInProgress('starting')).toBe(true);
    expect(isAuthSessionInProgress('awaiting_user')).toBe(true);
    expect(isAuthSessionInProgress('connected')).toBe(false);
    expect(isAuthSessionInProgress('expired')).toBe(false);
    expect(isAuthSessionInProgress(null)).toBe(false);
  });

  it('服务不可用优先于一切（fail closed，不给出可点入口）', () => {
    expect(
      resolvePollingConnectorStatus({ ...base, serviceUnavailable: true, loading: true }),
    ).toBe('unavailable');
  });

  it('判定顺序与 Web dingtalkConnectorStatus 一致', () => {
    expect(resolvePollingConnectorStatus({ ...base, loading: true })).toBe('loading');
    expect(resolvePollingConnectorStatus({ ...base, authSessionStatus: 'awaiting_user' })).toBe(
      'authorizing',
    );
    expect(resolvePollingConnectorStatus({ ...base, connecting: true })).toBe('authorizing');
    expect(
      resolvePollingConnectorStatus({
        ...base,
        connections: [{ status: 'connected' }, { status: 'disconnected' }],
      }),
    ).toBe('needs-reconnect');
    expect(
      resolvePollingConnectorStatus({
        ...base,
        connections: [{ status: 'connected' }, { status: 'error' }],
      }),
    ).toBe('error');
    expect(resolvePollingConnectorStatus({ ...base, connections: [{ status: 'pending' }] })).toBe(
      'pending',
    );
  });

  it('已连接但运行时被暂停显示已暂停', () => {
    expect(
      resolvePollingConnectorStatus({
        ...base,
        connections: [{ status: 'connected' }],
        runtimeEnabled: false,
      }),
    ).toBe('paused');
    expect(resolvePollingConnectorStatus({ ...base, connections: [{ status: 'connected' }] })).toBe(
      'connected',
    );
  });

  it('无任何连接为未连接', () => {
    expect(resolvePollingConnectorStatus(base)).toBe('disconnected');
  });
});

describe('凭据式连接器状态（GitHub / X / Notion / Google / 阿里云）', () => {
  it('平台未配置 → 服务暂不可用', () => {
    expect(
      resolveCredentialConnectorStatus({
        loading: false,
        status: 'disconnected',
        runtimeEnabled: true,
        available: false,
      }),
    ).toBe('unavailable');
    expect(
      resolveCredentialConnectorStatus({
        loading: false,
        status: 'unavailable',
        runtimeEnabled: true,
      }),
    ).toBe('unavailable');
  });

  it('Notion invalid → 需重连；connected + 暂停 → 已暂停', () => {
    expect(
      resolveCredentialConnectorStatus({ loading: false, status: 'invalid', runtimeEnabled: true }),
    ).toBe('needs-reconnect');
    expect(
      resolveCredentialConnectorStatus({
        loading: false,
        status: 'connected',
        runtimeEnabled: false,
      }),
    ).toBe('paused');
    expect(
      resolveCredentialConnectorStatus({
        loading: false,
        status: 'connected',
        runtimeEnabled: true,
      }),
    ).toBe('connected');
    expect(
      resolveCredentialConnectorStatus({ loading: true, status: undefined, runtimeEnabled: true }),
    ).toBe('loading');
    expect(
      resolveCredentialConnectorStatus({
        loading: false,
        status: 'disconnected',
        runtimeEnabled: true,
        authorizing: true,
      }),
    ).toBe('authorizing');
  });
});

describe('状态文案与色调', () => {
  it('多组织连接显示数量', () => {
    expect(connectorStatusLabel('connected')).toBe('已连接');
    expect(connectorStatusLabel('connected', 1)).toBe('已连接');
    expect(connectorStatusLabel('connected', 3)).toBe('已连接 3 个组织');
    expect(connectorStatusLabel('disconnected')).toBe('未连接');
    expect(connectorStatusLabel('paused')).toBe('已暂停');
  });

  it('按钮文案随状态与多 profile 能力变化', () => {
    expect(connectorActionLabel('disconnected')).toBe('连接');
    expect(connectorActionLabel('disconnected', { connectLabel: '连接钉钉' })).toBe('连接钉钉');
    expect(connectorActionLabel('authorizing')).toBe('等待授权');
    expect(connectorActionLabel('needs-reconnect')).toBe('重新连接');
    expect(connectorActionLabel('connected')).toBe('断开连接');
    expect(connectorActionLabel('connected', { multiProfile: true })).toBe('连接其他组织');
    expect(connectorActionLabel('unavailable')).toBe('服务暂不可用');
  });

  it('色调映射', () => {
    expect(connectorStatusTone('connected')).toBe('success');
    expect(connectorStatusTone('needs-reconnect')).toBe('danger');
    expect(connectorStatusTone('unavailable')).toBe('danger');
    expect(connectorStatusTone('error')).toBe('warning');
    expect(connectorStatusTone('authorizing')).toBe('info');
    expect(connectorStatusTone('disconnected')).toBe('muted');
  });
});
