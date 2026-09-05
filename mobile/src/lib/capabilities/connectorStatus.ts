/**
 * 连接器卡片状态映射 —— 对齐 Web `CapabilityCenter/DingtalkConnector.tsx`
 * 的 `dingtalkConnectorStatus()` 与各 token 型连接器卡的状态文案。
 *
 * 两类连接器的状态来源不同，但落到卡片上只有一套语义：
 * - 轮询式（钉钉 DWS / 飞书）：服务端 `connections[]` + `authSession`；
 * - 凭据式（GitHub / X / Notion / Google Workspace / 阿里云）：`connection.status`
 *   + `runtimeEnabled`。
 *
 * 纯函数，无网络与 RN 依赖。
 */

export type ConnectorStatus =
  | 'loading'
  | 'authorizing'
  | 'needs-reconnect'
  | 'error'
  | 'pending'
  | 'paused'
  | 'connected'
  | 'unavailable'
  | 'disconnected';

/** 轮询式连接器的单条组织连接（DWS profile / 飞书租户）。 */
export interface PollingConnectionView {
  status: 'pending' | 'connected' | 'error' | 'disconnected';
}

export interface PollingConnectorInput {
  loading: boolean;
  connections: readonly PollingConnectionView[];
  /** 授权会话状态；null 表示当前没有进行中的授权 */
  authSessionStatus?: 'starting' | 'awaiting_user' | 'connected' | 'failed' | 'expired' | null;
  connecting: boolean;
  runtimeEnabled: boolean;
  /** 服务端授权服务不可用（HTTP 503） */
  serviceUnavailable: boolean;
}

/** 授权会话是否处于「已发起、等用户在浏览器里完成」的中间态。 */
export function isAuthSessionInProgress(
  status: PollingConnectorInput['authSessionStatus'],
): boolean {
  return status === 'starting' || status === 'awaiting_user';
}

/** 与 Web `dingtalkConnectorStatus()` 的判定顺序逐条对齐。 */
export function resolvePollingConnectorStatus(input: PollingConnectorInput): ConnectorStatus {
  if (input.serviceUnavailable) return 'unavailable';
  if (input.loading) return 'loading';
  if (isAuthSessionInProgress(input.authSessionStatus) || input.connecting) {
    return 'authorizing';
  }
  if (input.connections.some((item) => item.status === 'disconnected')) {
    return 'needs-reconnect';
  }
  if (input.connections.some((item) => item.status === 'error')) return 'error';
  if (input.connections.some((item) => item.status === 'pending')) return 'pending';
  const connected = input.connections.filter((item) => item.status === 'connected');
  if (connected.length > 0) return input.runtimeEnabled ? 'connected' : 'paused';
  return 'disconnected';
}

export interface CredentialConnectorInput {
  loading: boolean;
  /** 服务端连接状态；Notion 额外有 invalid / unavailable */
  status: 'connected' | 'disconnected' | 'invalid' | 'unavailable' | undefined;
  runtimeEnabled: boolean;
  /** 平台未配置该连接器（如 Notion / Google 的 available=false） */
  available?: boolean;
  /** 授权会话进行中（Notion OAuth） */
  authorizing?: boolean;
}

export function resolveCredentialConnectorStatus(input: CredentialConnectorInput): ConnectorStatus {
  if (input.available === false || input.status === 'unavailable') return 'unavailable';
  if (input.loading) return 'loading';
  if (input.authorizing) return 'authorizing';
  if (input.status === 'invalid') return 'needs-reconnect';
  if (input.status === 'connected') return input.runtimeEnabled ? 'connected' : 'paused';
  return 'disconnected';
}

const STATUS_LABEL: Record<ConnectorStatus, string> = {
  loading: '检测中',
  authorizing: '等待授权',
  'needs-reconnect': '需重连',
  error: '重试中',
  pending: '检测中',
  paused: '已暂停',
  connected: '已连接',
  unavailable: '服务暂不可用',
  disconnected: '未连接',
};

export function connectorStatusLabel(status: ConnectorStatus, connectedCount = 0): string {
  if (status === 'connected' && connectedCount > 1) {
    return `已连接 ${connectedCount} 个组织`;
  }
  return STATUS_LABEL[status];
}

/** 卡片主按钮文案；`hasAnyConnection` 用于「连接其他组织」这类多 profile 场景。 */
export function connectorActionLabel(
  status: ConnectorStatus,
  options?: { hasAnyConnection?: boolean; multiProfile?: boolean; connectLabel?: string },
): string {
  if (status === 'unavailable') return '服务暂不可用';
  if (status === 'authorizing') return '等待授权';
  if (status === 'needs-reconnect') return '重新连接';
  if (status === 'connected' || status === 'paused' || status === 'pending') {
    return options?.multiProfile ? '连接其他组织' : '断开连接';
  }
  if (options?.hasAnyConnection && options.multiProfile) return '连接其他组织';
  return options?.connectLabel ?? '连接';
}

/** 状态映射到 `ui/StatusBadge` 的语义色族键。 */
export type ConnectorStatusTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export function connectorStatusTone(status: ConnectorStatus): ConnectorStatusTone {
  if (status === 'connected') return 'success';
  if (status === 'needs-reconnect' || status === 'unavailable') return 'danger';
  if (status === 'error') return 'warning';
  if (status === 'authorizing' || status === 'pending' || status === 'loading') return 'info';
  return 'muted';
}
