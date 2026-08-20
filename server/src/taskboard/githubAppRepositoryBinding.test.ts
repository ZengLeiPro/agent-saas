import { describe, expect, it, vi } from 'vitest';

import { githubAppRepositoryTarget, githubAppRepositoryTargetFromId, resolveGithubAppRepositoryToken } from './githubAppRepositoryBinding.js';

describe('GitHub App repository binding', () => {
  it('accepts numeric and matching legacy canonical repository identities', () => {
    expect(githubAppRepositoryTargetFromId('github-id:123')).toEqual({ repositoryId: 123 });
    expect(githubAppRepositoryTarget({
      repositoryId: 'github:kaiyan:zengleipro/agent-saas', owner: 'ZengLeiPro', name: 'agent-saas',
    })).toEqual({ repositoryOwner: 'ZengLeiPro', repositoryName: 'agent-saas' });
    expect(githubAppRepositoryTarget({
      repositoryId: 'github:kaiyan:other/agent-saas', owner: 'ZengLeiPro', name: 'agent-saas',
    })).toBeUndefined();
  });

  it('requires the installation and numeric repository receipt to match the trusted target', async () => {
    const provider = { getInstallationToken: vi.fn(async () => ({
      token: 'ghs_token', repositoryId: 123, installationId: 456,
    })) };
    await expect(resolveGithubAppRepositoryToken(provider, 456, {
      repositoryOwner: 'ZengLeiPro', repositoryName: 'agent-saas',
    })).resolves.toMatchObject({ repositoryId: 123 });
    await expect(resolveGithubAppRepositoryToken(provider, 456, { repositoryId: 999 })).resolves.toBeUndefined();
  });
});
