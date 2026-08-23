import type { ArtifactKind } from '../../runtime/artifactStore.js';

const ARTIFACT_KINDS = new Set<ArtifactKind>(['file', 'screenshot', 'patch', 'log', 'blob']);

export interface ArtifactCreatedWebEvent {
  type: 'artifact_created';
  artifactId: string;
  fileName: string;
  kind: ArtifactKind;
  sizeBytes?: number;
  mimeType?: string;
  sha256?: string;
}

/**
 * Artifact(deliver) 的 durable tool_result metadata 是交付事实源。实时直推、跨进程
 * relay 与 reconnect replay 全部走这一个投影，避免一条链显示卡片、另一条链丢失。
 */
export function projectArtifactDelivery(
  toolName: string | undefined,
  metadata: Record<string, unknown> | undefined,
): ArtifactCreatedWebEvent | null {
  if (toolName !== 'Artifact' || metadata?.artifactAction !== 'deliver') return null;
  const artifactId = typeof metadata.artifactId === 'string' ? metadata.artifactId : '';
  const fileName = typeof metadata.fileName === 'string' ? metadata.fileName : '';
  const kind = metadata.artifactKind;
  if (!artifactId || !fileName || typeof kind !== 'string' || !ARTIFACT_KINDS.has(kind as ArtifactKind)) {
    return null;
  }
  return {
    type: 'artifact_created',
    artifactId,
    fileName,
    kind: kind as ArtifactKind,
    ...(typeof metadata.sizeBytes === 'number' && Number.isFinite(metadata.sizeBytes)
      ? { sizeBytes: metadata.sizeBytes }
      : {}),
    ...(typeof metadata.mimeType === 'string' ? { mimeType: metadata.mimeType } : {}),
    ...(typeof metadata.sha256 === 'string' ? { sha256: metadata.sha256 } : {}),
  };
}
