import type { ArtifactKind } from '../../runtime/artifactStore.js';

const ARTIFACT_KINDS = new Set<ArtifactKind>(['file', 'screenshot', 'patch', 'log', 'blob']);
const MAX_FALLBACK_CONTENT_LENGTH = 32_768;

export interface ArtifactCreatedWebEvent {
  type: 'artifact_created';
  artifactId: string;
  fileName: string;
  kind: ArtifactKind;
  sizeBytes?: number;
  mimeType?: string;
  sha256?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseDeliveryPayload(content: string | undefined): Record<string, unknown> | undefined {
  if (!content || content.length > MAX_FALLBACK_CONTENT_LENGTH) return undefined;
  try {
    const parsed = record(JSON.parse(content));
    return parsed?.action === 'deliver' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Artifact(deliver) 的 durable tool_result metadata 是交付事实源。实时直推、跨进程
 * relay 与 reconnect replay 全部走这一个投影，避免一条链显示卡片、另一条链丢失。
 * 旧执行链未透传 metadata 时，兼容读取同一 tool_result 的受限 JSON payload。
 */
export function projectArtifactDelivery(
  toolName: string | undefined,
  metadata: Record<string, unknown> | undefined,
  content?: string,
): ArtifactCreatedWebEvent | null {
  if (toolName !== 'Artifact') return null;
  const payload = parseDeliveryPayload(content);
  if (metadata?.artifactAction !== 'deliver' && !payload) return null;

  const artifactId = nonEmptyString(metadata?.artifactId) ?? nonEmptyString(payload?.artifactId);
  const fileName = nonEmptyString(metadata?.fileName) ?? nonEmptyString(payload?.fileName);
  const kind = metadata?.artifactKind ?? payload?.kind;
  if (!artifactId || !fileName || typeof kind !== 'string' || !ARTIFACT_KINDS.has(kind as ArtifactKind)) {
    return null;
  }

  const sizeBytes = metadata?.sizeBytes ?? payload?.sizeBytes;
  const mimeType = nonEmptyString(metadata?.mimeType) ?? nonEmptyString(payload?.mimeType);
  const sha256 = nonEmptyString(metadata?.sha256) ?? nonEmptyString(payload?.sha256);
  return {
    type: 'artifact_created',
    artifactId,
    fileName,
    kind: kind as ArtifactKind,
    ...(typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes >= 0
      ? { sizeBytes }
      : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
}
