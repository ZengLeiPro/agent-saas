import { resolveGithubToken } from '../connectors/github.js';
import type { UserStore } from '../data/users/store.js';
import { GithubRepositoryProvider, type RepositoryProvider } from './repositoryProvider.js';
import type { PgTaskboardStore } from './store.js';

export function configureTaskboardGithubRepositoryProvider(
  store: Pick<PgTaskboardStore, 'setRepositoryProvider'> | undefined,
  userStore: Pick<UserStore, 'findById'> | undefined,
  githubContext: Parameters<typeof resolveGithubToken>[0],
): RepositoryProvider | undefined {
  if (!store) return undefined;
  const provider = new GithubRepositoryProvider({
    resolveToken: async (repository, credentialOwnerId) => {
      const user = userStore?.findById(credentialOwnerId);
      if (!user || user.disabled) return undefined;
      // Legacy/v2 provider path remains connector-backed. Production v3 receives
      // a separate GitHub App-only provider below and never reaches this resolver.
      return resolveGithubToken(githubContext, {
        userId: user.id,
        username: user.username,
        tenantId: user.tenantId,
      });
    },
  });
  store.setRepositoryProvider(provider);
  return provider;
}
