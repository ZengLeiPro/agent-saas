import type { GithubAppInstallationTokenProvider } from '../app/runtimeContracts.js';
import type { IntegrationPushCredential, IntegrationPushGateway } from './integrationPushGateway.js';
import { githubAppRepositoryTargetFromId, resolveGithubAppRepositoryToken } from './githubAppRepositoryBinding.js';
import type {
  TaskboardIdentity,
  TaskboardIntegrationPushInput,
  TaskboardIntegrationPushIssueInput,
  TaskboardIntegrationPushService,
} from './types.js';

/** Authentication-aware service boundary for a route/tool adapter. */
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

/** Production v3 write resolver. No connector token or PAT fallback exists here. */
export function createGithubAppIntegrationPushTokenResolver(deps: {
  provider: GithubAppInstallationTokenProvider;
  installationId: number;
  onError?: (error: Error) => void;
}) {
  return async (input: { tenantId: string; ownerUserId: string; repositoryId: string }): Promise<IntegrationPushCredential | undefined> => {
    const target = githubAppRepositoryTargetFromId(input.repositoryId);
    if (!target) return undefined;
    try {
      const credential = await resolveGithubAppRepositoryToken(deps.provider, deps.installationId, target);
      if (!credential) return undefined;
      return {
        token: credential.token,
        mode: 'github_app',
        repositoryId: credential.repositoryId,
        installationId: credential.installationId,
      };
    } catch (error) {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  };
}
