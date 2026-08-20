import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';

export interface IntegrationV3RepositoryProbeInput {
  tenantId: string;
  ownerUserId: string;
  repository: TaskBoardRepositoryConfig;
}

export type IntegrationV3RepositoryProbe = (input: IntegrationV3RepositoryProbeInput) => Promise<boolean>;

export async function runIntegrationV3RepositoryProbe(
  probe: IntegrationV3RepositoryProbe | undefined,
  input: IntegrationV3RepositoryProbeInput,
): Promise<void> {
  try {
    if (!probe || !await probe(input)) throw new Error('repository access denied');
  } catch {
    throw new TaskboardValidationError('Workflow v3 repository credential probe failed', 'TASKBOARD_INTEGRATION_V3_CREDENTIAL_UNAVAILABLE');
  }
}
