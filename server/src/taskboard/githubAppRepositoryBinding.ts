import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import type { GithubAppInstallationTokenProvider } from '../app/runtimeContracts.js';

export type GithubAppRepositoryTarget =
  | { repositoryId: number }
  | { repositoryOwner: string; repositoryName: string };

export function githubAppRepositoryTargetFromId(repositoryId: string): GithubAppRepositoryTarget | undefined {
  const numeric = /^github-id:(\d+)$/.exec(repositoryId);
  if (numeric) {
    const repositoryId = Number(numeric[1]);
    return Number.isSafeInteger(repositoryId) && repositoryId > 0 ? { repositoryId } : undefined;
  }
  const canonical = /^github:(?:[^:]+:)?([^/]+)\/([^/]+)$/.exec(repositoryId);
  return canonical ? { repositoryOwner: canonical[1]!, repositoryName: canonical[2]! } : undefined;
}

export function githubAppRepositoryTarget(
  repository: Pick<TaskBoardRepositoryConfig, 'repositoryId' | 'owner' | 'name'>,
): GithubAppRepositoryTarget | undefined {
  const target = githubAppRepositoryTargetFromId(repository.repositoryId);
  if (!target || 'repositoryId' in target) return target;
  if (target.repositoryOwner.toLowerCase() !== repository.owner.toLowerCase()
    || target.repositoryName.toLowerCase() !== repository.name.toLowerCase()) return undefined;
  return { repositoryOwner: repository.owner, repositoryName: repository.name };
}

export async function resolveGithubAppRepositoryToken(
  provider: GithubAppInstallationTokenProvider,
  installationId: number,
  target: GithubAppRepositoryTarget,
) {
  const credential = await provider.getInstallationToken({ ...target, installationId });
  if (!credential || credential.installationId !== installationId || !credential.token
    || !Number.isSafeInteger(credential.repositoryId) || credential.repositoryId <= 0) return undefined;
  if ('repositoryId' in target && credential.repositoryId !== target.repositoryId) return undefined;
  return credential;
}
