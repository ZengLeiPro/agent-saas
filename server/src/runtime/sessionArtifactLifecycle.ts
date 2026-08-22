import type { ArtifactService } from './artifactService.js';
import type { ArtifactShareStore } from './artifactShareStore.js';

export interface SessionArtifactLifecycle {
  revoke(sessionId: string, ownerUserId: string): Promise<void>;
  purge(sessionId: string, ownerUserId: string): Promise<void>;
}

export function createSessionArtifactLifecycle(
  shareStore: ArtifactShareStore | undefined,
  artifactService: Pick<ArtifactService, 'deleteArtifactsForSessions'> | undefined,
): SessionArtifactLifecycle | undefined {
  if (!shareStore && !artifactService) return undefined;
  return {
    async revoke(sessionId, ownerUserId) {
      await shareStore?.revokeBySession(sessionId, ownerUserId);
    },
    async purge(sessionId, ownerUserId) {
      await shareStore?.revokeBySession(sessionId, ownerUserId);
      await artifactService?.deleteArtifactsForSessions([sessionId]);
    },
  };
}
