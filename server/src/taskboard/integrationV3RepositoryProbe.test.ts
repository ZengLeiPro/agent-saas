import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { PgTaskboardStore } from './store.js';

const repository: TaskBoardRepositoryConfig = {
  provider: 'github',
  repositoryId: 'github-id:123',
  owner: 'acme',
  name: 'widget',
  baseBranch: 'main',
  allowForkPullRequest: false,
};
const input = { tenantId: 'tenant-1', ownerUserId: 'owner-1', repository };

function store() {
  return new PgTaskboardStore({ pool: {} as never, tablePrefix: 'probe_test' });
}

describe('PgTaskboardStore integration v3 repository probe', () => {
  it('fails closed when production runtime has not injected a repository probe', async () => {
    await expect(store().probeIntegrationV3Repository(input)).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_V3_CREDENTIAL_UNAVAILABLE',
    });
  });

  it('passes the inseparable tenant, owner and full repository identity to the injected probe', async () => {
    const probe = vi.fn(async () => true);
    const subject = store();
    subject.setIntegrationV3RepositoryProbe(probe);

    await expect(subject.probeIntegrationV3Repository(input)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledWith(input);
  });

  it('fails closed when the injected read/push permission probe denies access', async () => {
    const subject = store();
    subject.setIntegrationV3RepositoryProbe(async () => false);

    await expect(subject.probeIntegrationV3Repository(input)).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_V3_CREDENTIAL_UNAVAILABLE',
    });
  });
});
