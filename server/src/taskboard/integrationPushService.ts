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

  pushCandidate(identity: TaskboardIdentity, input: {
    executionId: string;
    workspaceRoot: string;
    commitOid: string;
  }) {
    return this.gateway.pushWorkspaceCommit({
      tenantId: identity.tenantId,
      requesterUserId: identity.ownerUserId,
      executionId: input.executionId,
      workspaceRoot: input.workspaceRoot,
      commitOid: input.commitOid,
    });
  }

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

/** Production v3 write resolver for an installation-scoped GitHub App token. */
export function createPersonalAccessTokenIntegrationPushTokenResolver(deps: {
  resolveToken(input: { tenantId: string; ownerUserId: string }): Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (input: {
    tenantId: string; ownerUserId: string; repositoryId: string; repositoryOwner: string; repositoryName: string;
  }): Promise<IntegrationPushCredential | undefined> => {
    const target = githubAppRepositoryTargetFromId(input.repositoryId);
    if (!target || ('repositoryOwner' in target
      && (target.repositoryOwner.toLowerCase() !== input.repositoryOwner.toLowerCase()
        || target.repositoryName.toLowerCase() !== input.repositoryName.toLowerCase()))) return undefined;
    try {
      const token = await deps.resolveToken(input);
      if (!token) return undefined;
      const path = 'repositoryId' in target
        ? `/repositories/${target.repositoryId}`
        : `/repos/${encodeURIComponent(target.repositoryOwner)}/${encodeURIComponent(target.repositoryName)}`;
      const response = await fetchImpl(`https://api.github.com${path}`, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'agent-saas-integration-v3' },
      });
      const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      const permissions = body?.permissions as Record<string, unknown> | undefined;
      if (!body || response.status !== 200 || !Number.isSafeInteger(body.id) || Number(body.id) <= 0 || permissions?.push !== true) return undefined;
      if ('repositoryId' in target && Number(body.id) !== target.repositoryId) return undefined;
      if (typeof body.full_name !== 'string'
        || body.full_name.toLowerCase() !== `${input.repositoryOwner}/${input.repositoryName}`.toLowerCase()) return undefined;
      return {
        token,
        mode: 'personal_access_token',
        repositoryId: Number(body.id),
        configuredRepositoryId: input.repositoryId,
        configuredRepositoryOwner: input.repositoryOwner,
        configuredRepositoryName: input.repositoryName,
      };
    } catch (error) {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  };
}

export function createGithubAppIntegrationPushTokenResolver(deps: {
  provider: GithubAppInstallationTokenProvider;
  installationId: number;
  onError?: (error: Error) => void;
}) {
  return async (input: {
    tenantId: string; ownerUserId: string; repositoryId: string; repositoryOwner: string; repositoryName: string;
  }): Promise<IntegrationPushCredential | undefined> => {
    const target = githubAppRepositoryTargetFromId(input.repositoryId);
    if (!target || ('repositoryOwner' in target
      && (target.repositoryOwner.toLowerCase() !== input.repositoryOwner.toLowerCase()
        || target.repositoryName.toLowerCase() !== input.repositoryName.toLowerCase()))) return undefined;
    try {
      const credential = await resolveGithubAppRepositoryToken(deps.provider, deps.installationId, target);
      if (!credential) return undefined;
      return {
        token: credential.token,
        mode: 'github_app',
        repositoryId: credential.repositoryId,
        configuredRepositoryId: input.repositoryId,
        configuredRepositoryOwner: input.repositoryOwner,
        configuredRepositoryName: input.repositoryName,
        installationId: credential.installationId,
      };
    } catch (error) {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  };
}
