import { randomUUID } from 'node:crypto';

import type { GovernanceAuditStore } from '../data/governance-audit/index.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { ArtifactShareService } from '../runtime/artifactShareService.js';
import {
  InMemoryArtifactShareStore,
  PgArtifactShareStore,
  type ArtifactShareStore,
} from '../runtime/artifactShareStore.js';
import type { ArtifactService } from '../runtime/artifactService.js';
export type { ArtifactShareService, ArtifactShareStore };

export async function initializeArtifactShareStore(pg?: {
  pool: ConstructorParameters<typeof PgArtifactShareStore>[0]['pool'];
  connectionString: string;
  tablePrefix?: string;
}): Promise<ArtifactShareStore> {
  if (!pg) return new InMemoryArtifactShareStore();
  const store = new PgArtifactShareStore(pg);
  await store.init();
  return store;
}

export function initializeArtifactShareService(
  store: ArtifactShareStore,
  artifactService: ArtifactService,
  signingSecret: string | undefined,
  warn: (message: string) => void,
): ArtifactShareService | undefined {
  if (signingSecret && signingSecret.length >= 16) {
    return new ArtifactShareService({ store, artifactService, signingSecret });
  }
  warn('Artifact sharing disabled: persistent artifact.signedUrlSecret or auth.jwtSecret is required');
  return undefined;
}

export function artifactContentAudit(
  store: GovernanceAuditStore | undefined,
): ((input: { tenantId: string; subjectUserId: string; sessionId: string; scope: 'session_export' }) => Promise<void>) | undefined {
  if (!store) return undefined;
  return async input => {
    await store.append({
      correlationId: `artifact-read:${input.sessionId}:${randomUUID()}`,
      actorType: 'user',
      actorUserId: input.subjectUserId,
      actorPersona: 'platform_admin',
      actorTenantId: DEFAULT_TENANT_ID,
      action: 'session.content.session_export',
      targetType: 'session_artifact',
      targetId: input.sessionId,
      targetTenantId: input.tenantId,
      purpose: 'incident content export',
      result: 'succeeded',
      metadata: { scope: input.scope },
    });
  };
}
