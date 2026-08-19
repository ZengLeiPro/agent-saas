import type { ConnectorConnectionStore } from './connectionStore.js';

export const NATIVE_RUNTIME_CONNECTOR_IDS = [
  'github',
  'x',
  'dws',
  'feishu',
  'notion',
  'google-workspace',
  'aliyun',
] as const;

export type NativeRuntimeConnectorId = typeof NATIVE_RUNTIME_CONNECTOR_IDS[number];

const NATIVE_RUNTIME_CONNECTOR_ID_SET = new Set<string>(NATIVE_RUNTIME_CONNECTOR_IDS);

export function isNativeRuntimeConnectorId(value: string): value is NativeRuntimeConnectorId {
  return NATIVE_RUNTIME_CONNECTOR_ID_SET.has(value);
}

export function isNativeConnectorRuntimeEnabled(
  store: ConnectorConnectionStore,
  username: string,
  connectorId: NativeRuntimeConnectorId,
): boolean {
  return store.isRuntimeEnabled(username, connectorId);
}

/**
 * 钉钉、飞书会把授权保存在用户 workspace。暂停时必须覆盖 CLI 配置目录，
 * 不能只省略 token env，否则 CLI 仍可能从持久化配置兜底读取授权。
 */
export function pausedWorkspaceCliEnv(
  connectorId: 'dws' | 'feishu',
  userId: string,
): Record<string, string> {
  const ownerKey = userId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'unknown';
  const root = `/tmp/agent-saas-paused/${ownerKey}`;
  if (connectorId === 'dws') {
    return { DWS_CONFIG_DIR: `${root}/dws/config` };
  }
  return {
    LARKSUITE_CLI_CONFIG_DIR: `${root}/lark/config`,
    LARKSUITE_CLI_DATA_DIR: `${root}/lark/data`,
  };
}

/** 最后应用暂停屏蔽，避免 tenant run env 把连接器凭据或 CLI 目录重新覆盖回来。 */
export function applyNativeConnectorRuntimeState(
  store: ConnectorConnectionStore,
  identity: { userId: string; username: string },
  source: Record<string, string>,
  options: { preserveEnvKeys?: ReadonlySet<string> } = {},
): Record<string, string> {
  const env = { ...source };
  const preserveEnvKeys = options.preserveEnvKeys ?? new Set<string>();
  if (!store.isRuntimeEnabled(identity.username, 'github')) {
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
  }
  if (!store.isRuntimeEnabled(identity.username, 'x')) {
    for (const key of ['AUTH_TOKEN', 'CT0', 'TWITTER_AUTH_TOKEN', 'TWITTER_CT0']) {
      if (!preserveEnvKeys.has(key)) delete env[key];
    }
  }
  if (!store.isRuntimeEnabled(identity.username, 'notion')) delete env.NOTION_API_TOKEN;
  if (!store.isRuntimeEnabled(identity.username, 'google-workspace')) delete env.GOOGLE_WORKSPACE_CLI_TOKEN;
  if (!store.isRuntimeEnabled(identity.username, 'aliyun')) {
    delete env.ALIBABA_CLOUD_ACCESS_KEY_ID;
    delete env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    delete env.ALIBABA_CLOUD_REGION_ID;
  }
  if (!store.isRuntimeEnabled(identity.username, 'dws')) {
    Object.assign(env, pausedWorkspaceCliEnv('dws', identity.userId));
  }
  if (!store.isRuntimeEnabled(identity.username, 'feishu')) {
    delete env.LARKSUITE_CLI_APP_ID;
    delete env.LARKSUITE_CLI_USER_ACCESS_TOKEN;
    Object.assign(env, pausedWorkspaceCliEnv('feishu', identity.userId));
  }
  return env;
}
