import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { resolveGithubToken } from '../connectors/github.js';
import type { UserStore } from '../data/users/store.js';
import type { SecretVault } from '../security/secretVault.js';
import type { IntegrationPushCredential, IntegrationPushGateway } from './integrationPushGateway.js';
import type {
  TaskboardIdentity,
  TaskboardIntegrationPushInput,
  TaskboardIntegrationPushIssueInput,
  TaskboardIntegrationPushService,
} from './types.js';

/** Authentication-aware service boundary for a future route/tool adapter. */
export class ControlledTaskboardIntegrationPushService implements TaskboardIntegrationPushService {
  constructor(private readonly gateway: IntegrationPushGateway) {}

  health() { return this.gateway.health(); }

  issue(identity: TaskboardIdentity, input: TaskboardIntegrationPushIssueInput) {
    return this.gateway.issue({
      tenantId: identity.tenantId,
      requesterUserId: identity.ownerUserId,
      executionId: input.executionId,
      candidateId: input.candidateId,
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    });
  }

  push(identity: TaskboardIdentity, input: TaskboardIntegrationPushInput) {
    return this.gateway.push({
      tenantId: identity.tenantId,
      requesterUserId: identity.ownerUserId,
      executionId: input.executionId,
      candidateId: input.candidateId,
      capabilityToken: input.capabilityToken,
      commitOid: input.commitOid,
    });
  }
}

/** Connector adapter kept on the server side; it returns no runtime env and logs no secret. */
export function createGithubIntegrationPushTokenResolver(deps: {
  connectionStore: ConnectorConnectionStore;
  vault: SecretVault;
  userStore: Pick<UserStore, 'findById'>;
  onError?: (error: Error) => void;
  /** PAT compatibility must be an explicit deployment choice; App mode requires immutable github-id:<id>. */
  mode: 'github_app' | 'restricted_pat';
}) {
  return async (input: { tenantId: string; ownerUserId: string; repositoryId: string }): Promise<IntegrationPushCredential | undefined> => {
    const user = deps.userStore.findById(input.ownerUserId);
    if (!user || user.disabled || user.tenantId !== input.tenantId) return undefined;
    if (deps.mode === 'github_app' && !/^github-id:\d+$/.test(input.repositoryId)) return undefined;
    if (deps.mode === 'restricted_pat' && !/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.repositoryId)) return undefined;
    const token = await resolveGithubToken({
      connectionStore: deps.connectionStore,
      vault: deps.vault,
      ...(deps.onError ? { onError: deps.onError } : {}),
    }, {
      userId: user.id,
      username: user.username,
      tenantId: input.tenantId,
    });
    return token ? { token, mode: deps.mode, repositoryId: input.repositoryId } : undefined;
  };
}
