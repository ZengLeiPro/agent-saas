import type { SessionArtifactLifecycle } from '../runtime/sessionArtifactLifecycle.js';
export type { SessionArtifactLifecycle };

export interface PermanentSessionDeletionOptions {
  sessionId: string;
  ownerUserId: string;
  hasTranscript: boolean;
  artifactLifecycle?: SessionArtifactLifecycle;
  isStillDeleted(): Promise<boolean>;
  deleteTranscriptPreservingMeta(): Promise<boolean>;
  deleteMetaAndSidecar(): Promise<boolean>;
}

/**
 * 先只删 transcript、保留回收站 meta 作为可重试 tombstone；Artifact 清理成功后
 * 再删 meta/sidecar。任一步失败都能通过同一 permanent endpoint 安全重试。
 */
export async function permanentlyDeleteSession(options: PermanentSessionDeletionOptions): Promise<boolean> {
  const remove = async () => {
    if (!await options.isStillDeleted()) return false;
    await options.artifactLifecycle?.revokeShares(options.sessionId, options.ownerUserId);
    if (options.hasTranscript && !await options.deleteTranscriptPreservingMeta()) return false;
    await options.artifactLifecycle?.purgeArtifacts(options.sessionId);
    return options.deleteMetaAndSidecar();
  };
  return options.artifactLifecycle
    ? options.artifactLifecycle.withSessionLock(options.sessionId, remove)
    : remove();
}
