import type { ArtifactService } from './artifactService.js';
import type { ArtifactShareStore } from './artifactShareStore.js';

export interface SessionArtifactLifecycle {
  withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  withRevoked<T>(sessionId: string, ownerUserId: string, operation: () => Promise<T>): Promise<T>;
  revokeShares(sessionId: string, ownerUserId: string): Promise<void>;
  purgeArtifacts(sessionId: string): Promise<void>;
}

export function createSessionArtifactLifecycle(
  shareStore: ArtifactShareStore | undefined,
  artifactService: Pick<ArtifactService, 'deleteArtifactsForSessions'> | undefined,
): SessionArtifactLifecycle | undefined {
  if (!shareStore && !artifactService) return undefined;
  return {
    async withSessionLock(sessionId, operation) {
      return shareStore?.withSessionLock(sessionId, operation) ?? operation();
    },
    async withRevoked(sessionId, ownerUserId, operation) {
      const guarded = async () => {
        await shareStore?.revokeBySession(sessionId, ownerUserId);
        return operation();
      };
      return shareStore?.withSessionLock(sessionId, guarded) ?? guarded();
    },
    async revokeShares(sessionId, ownerUserId) {
      await shareStore?.revokeBySession(sessionId, ownerUserId);
    },
    async purgeArtifacts(sessionId) {
      await artifactService?.deleteArtifactsForSessions([sessionId]);
    },
  };
}
