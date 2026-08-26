const TASKBOARD_WRITABLE_GIT_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_INSTALLATION_TOKEN',
  'GITHUB_APP_PRIVATE_KEY',
  'SSH_PRIVATE_KEY',
  'GIT_ASKPASS',
  'GH_CONFIG_DIR',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GCM_CREDENTIAL_STORE',
  'GIT_CREDENTIAL_HELPER',
] as const;

export interface TaskboardRuntimeCredentialMetadata {
  taskboardExecution?: boolean;
  /** Set only by an enforcing platform adapter, never by the Agent/request. */
  taskboardRuntimeIsolation?: {
    isolatedHome: boolean;
    credentialsUnmounted: boolean;
    gitCommonDirUnmounted: boolean;
    networkPolicyEnforced: boolean;
    networkPolicyMode: 'none' | 'provider-read-only';
  };
  taskboardPurpose?: string;
  taskboardWorkflowVersion?: number | string;
  taskboardIntegration?: boolean;
  taskboardIntegrationRole?: string;
  taskboardIntegrationTaskId?: string;
}

/**
 * Compatibility classifier for dispatchers whose session naming cannot distinguish
 * ordinary implementation work from historical isolated Review/Merge executions.
 * The current single Integration Agent intentionally keeps standard Git/GitHub credentials.
 */
export function isCredentialIsolatedTaskboardRuntime(
  sessionId: string,
  metadata?: TaskboardRuntimeCredentialMetadata,
): boolean {
  if (
    sessionId.startsWith('taskboard-review-')
    || sessionId.startsWith('taskboard-merge-')
  ) return true;
  if (!metadata?.taskboardExecution) return false;
  const role = (metadata.taskboardIntegrationRole ?? metadata.taskboardPurpose ?? '').toLowerCase();
  const integrationMarked = metadata.taskboardIntegration === true
    || isNonEmpty(metadata.taskboardIntegrationTaskId)
    || metadata.taskboardWorkflowVersion === 3
    || metadata.taskboardWorkflowVersion === '3'
    || metadata.taskboardWorkflowVersion === 'v3';
  return integrationMarked && ['review', 'merge', 'integration_review'].includes(role);
}

export function stripTaskboardWritableGitCredentials(
  sessionId: string,
  env: Record<string, string>,
  metadata?: TaskboardRuntimeCredentialMetadata,
): void {
  if (!isCredentialIsolatedTaskboardRuntime(sessionId, metadata)) return;
  for (const key of TASKBOARD_WRITABLE_GIT_ENV_KEYS) delete env[key];
  // Fail closed for connector/app credential aliases introduced after this policy. This is
  // intentionally limited to isolated Integration runtimes, so ordinary tasks retain access.
  for (const key of Object.keys(env)) {
    if (/^(?:GH|GITHUB)_(?:.*TOKEN|.*PRIVATE_KEY|.*CLIENT_SECRET)$/.test(key)
      || /^SSH_.*(?:PRIVATE_KEY|PASSWORD|PASSPHRASE|TOKEN)$/.test(key)) delete env[key];
  }
  // Remove every inherited command-line git config entry. Merely resetting COUNT can
  // leave attacker-controlled KEY_n/VALUE_n pairs available to nested processes.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  // HOME/config locations are metadata-independent defense in depth. The platform must
  // additionally mount an empty private HOME and enforce the advertised network policy.
  env.HOME = '/nonexistent/taskboard-integration-runtime';
  env.XDG_CONFIG_HOME = '/nonexistent/taskboard-integration-runtime/config';
  env.GH_CONFIG_DIR = '/nonexistent/taskboard-integration-runtime/gh';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.KY_TASKBOARD_NETWORK_POLICY = 'provider-read-only';
  env.KY_TASKBOARD_NETWORK_POLICY_REQUIRED = '1';
  env.GIT_CONFIG_COUNT = '4';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.GIT_CONFIG_KEY_1 = 'remote.origin.pushurl';
  env.GIT_CONFIG_VALUE_1 = 'disabled://taskboard-provider-only';
  env.GIT_CONFIG_KEY_2 = 'core.hooksPath';
  env.GIT_CONFIG_VALUE_2 = '/dev/null';
  env.GIT_CONFIG_KEY_3 = 'protocol.allow';
  env.GIT_CONFIG_VALUE_3 = 'never';
}

export function hasEnforcedIntegrationRuntimeIsolation(metadata?: TaskboardRuntimeCredentialMetadata): boolean {
  const isolation = metadata?.taskboardRuntimeIsolation;
  return isolation?.isolatedHome === true && isolation.credentialsUnmounted === true
    && isolation.gitCommonDirUnmounted === true && isolation.networkPolicyEnforced === true
    && ['none', 'provider-read-only'].includes(isolation.networkPolicyMode);
}

/** Metadata consumed by container/network-policy adapters. This is not itself enforcement. */
export const INTEGRATION_RUNTIME_ISOLATION_REQUIREMENTS = Object.freeze({
  isolatedHome: true, credentialsUnmounted: true, gitCommonDirUnmounted: true,
  networkPolicyEnforced: true, allowedNetworkPolicyModes: ['none', 'provider-read-only'] as const,
});

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
