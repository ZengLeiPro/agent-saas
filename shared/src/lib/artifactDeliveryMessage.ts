import type { MessageItem } from '../types/message';
import { normalizeToolResultMetadata } from './toolResultMetadata';
import type { MessagesController } from './wsEventProcessorHelpers';

const ARTIFACT_KINDS = new Set(['file', 'screenshot', 'patch', 'log', 'blob']);

function deliveryPayload(resultText: string | undefined): Record<string, unknown> | null {
  if (!resultText || resultText.length > 32_768) return null;
  try {
    const parsed = JSON.parse(resultText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const payload = parsed as Record<string, unknown>;
    return payload.action === 'deliver' ? payload : null;
  } catch {
    return null;
  }
}

export function artifactDeliveryMessage(
  toolName: string | undefined,
  rawMetadata: unknown,
  resultText?: string,
): Extract<MessageItem, { type: 'file_download' }> | null {
  if (toolName !== 'Artifact') return null;
  const metadata = normalizeToolResultMetadata(rawMetadata);
  const payload = deliveryPayload(resultText);
  if (metadata?.artifactAction !== 'deliver' && !payload) return null;
  const artifactId = metadata?.artifactId ?? payload?.artifactId;
  const fileName = metadata?.fileName ?? payload?.fileName;
  const artifactKind = metadata?.artifactKind ?? payload?.kind;
  if (typeof artifactId !== 'string' || typeof fileName !== 'string'
    || typeof artifactKind !== 'string' || !ARTIFACT_KINDS.has(artifactKind)) return null;
  const mimeType = metadata?.mimeType ?? payload?.mimeType;
  const sizeBytes = metadata?.sizeBytes ?? payload?.sizeBytes;
  return {
    id: `artifact-delivery-${artifactId}`,
    type: 'file_download',
    fileName,
    fileType: typeof mimeType === 'string' ? mimeType : '',
    filePath: fileName,
    fileSize: typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0,
    artifactId,
    artifactKind: artifactKind as 'file' | 'screenshot' | 'patch' | 'log' | 'blob',
    ...(typeof mimeType === 'string' ? { mimeType } : {}),
  };
}

/** 旧服务端未投影 artifact_created 时的实时降级路径。 */
export function handleArtifactDeliveryToolResult(
  data: { toolName?: string; result?: string; metadata?: unknown },
  messages: MessagesController,
): boolean {
  const artifact = artifactDeliveryMessage(data.toolName, data.metadata, data.result);
  if (!artifact) return false;
  if (!messages.messagesRef.current.some(item => item.type === 'file_download' && item.artifactId === artifact.artifactId)) {
    messages.addMessage(artifact);
  }
  return true;
}
