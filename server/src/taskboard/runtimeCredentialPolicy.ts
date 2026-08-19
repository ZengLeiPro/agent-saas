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
  taskboardPurpose?: string;
  taskboardWorkflowVersion?: number | string;
  taskboardIntegration?: boolean;
  taskboardIntegrationRole?: string;
  taskboardIntegrationTaskId?: string;
}

/**
 * Compatibility classifier for dispatchers whose session naming cannot distinguish
 * ordinary implementation work from Integration Work. New dispatchers should set
 * taskboardIntegration=true plus taskboardIntegrationRole=work|review.
 */
export function isCredentialIsolatedTaskboardRuntime(
  sessionId: string,
  metadata?: TaskboardRuntimeCredentialMetadata,
): boolean {
  if (
    sessionId.startsWith('taskboard-review-')
    || sessionId.startsWith('taskboard-merge-')
    || sessionId.startsWith('taskboard-integration-work-')
    || sessionId.startsWith('taskboard-integration-review-')
  ) return true;
  if (!metadata?.taskboardExecution) return false;
  const role = (metadata.taskboardIntegrationRole ?? metadata.taskboardPurpose ?? '').toLowerCase();
  const integrationMarked = metadata.taskboardIntegration === true
    || isNonEmpty(metadata.taskboardIntegrationTaskId)
    || metadata.taskboardWorkflowVersion === 3
    || metadata.taskboardWorkflowVersion === '3'
    || metadata.taskboardWorkflowVersion === 'v3';
  return integrationMarked && ['work', 'review', 'merge', 'integration_work', 'integration_review'].includes(role);
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
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_COUNT = '2';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.GIT_CONFIG_KEY_1 = 'remote.origin.pushurl';
  env.GIT_CONFIG_VALUE_1 = 'disabled://taskboard-provider-only';
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
