import { resolveGithubToken } from '../connectors/github.js';
import type { UserStore } from '../data/users/store.js';
import { GithubRepositoryProvider } from './repositoryProvider.js';
import type { PgTaskboardStore } from './store.js';

export function configureTaskboardGithubRepositoryProvider(
  store: Pick<PgTaskboardStore, 'setRepositoryProvider'> | undefined,
  userStore: Pick<UserStore, 'findById'> | undefined,
  githubContext: Parameters<typeof resolveGithubToken>[0],
): void {
  store?.setRepositoryProvider(new GithubRepositoryProvider({
    resolveToken: async (_repository, credentialOwnerId) => {
      const user = userStore?.findById(credentialOwnerId);
      if (!user || user.disabled) return undefined;
      return resolveGithubToken(githubContext, {
        userId: user.id,
        username: user.username,
        tenantId: user.tenantId,
      });
    },
  }));
}
