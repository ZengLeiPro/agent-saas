import type { ArtifactService } from '../runtime/artifactService.js';
import type { ArtifactRecord } from '../runtime/artifactStore.js';
import type { ToolCallContext, ToolResult } from './toolRuntime.js';
import type { ArtifactInput, CreateArtifactInput } from './workspaceHandTools.js';

export type PreparedArtifactInvocation =
  | { action: 'create'; transportInput: CreateArtifactInput }
  | { action: 'deliver'; result: ToolResult };

export async function prepareArtifactInvocation(
  input: ArtifactInput,
  artifactService: ArtifactService,
  context: ToolCallContext,
): Promise<PreparedArtifactInvocation> {
  if (input.action === 'create') {
    if (!input.file_path) throw new Error('Artifact(create): file_path is required.');
    return {
      action: 'create',
      transportInput: {
        file_path: input.file_path,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.mime_type ? { mime_type: input.mime_type } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    };
  }
  if (!input.artifact_id) throw new Error('Artifact(deliver): artifact_id is required.');
  const sessionId = context.sessionId ?? context.workspace.sessionId;
  if (!sessionId) throw new Error('Artifact(deliver): sessionId is required.');

  // 知道 artifactId 不等于可交付：必须属于当前会话；用户下载还会再过 owner/tenant ACL。
  const candidate = await artifactService.getForUser(input.artifact_id);
  if (candidate.sessionId !== sessionId) {
    throw new Error('Artifact(deliver): artifact does not belong to the current session.');
  }
  // 先持久 pin 再返回 tool_result；崩溃窗口最多留下随会话删除清理的 pin，不会产生坏卡。
  const artifact = await artifactService.markDelivered(input.artifact_id);
  const fileName = typeof artifact.metadata?.fileName === 'string'
    ? artifact.metadata.fileName
    : `${artifact.artifactId}.bin`;
  const deliveryId = `artifact_delivery:${sessionId}:${artifact.artifactId}`;
  const payload = {
    action: 'deliver' as const,
    deliveryId,
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    fileName,
    ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    userVisible: true,
  };
  return {
    action: 'deliver',
    result: {
      content: JSON.stringify(payload, null, 2),
      metadata: {
        artifactAction: 'deliver',
        deliveryId,
        artifactId: artifact.artifactId,
        artifactKind: artifact.kind,
        fileName,
        ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
        ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
        ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      },
    },
  };
}

export function createdArtifactToolResult(artifact: ArtifactRecord): ToolResult {
  const fileName = typeof artifact.metadata?.fileName === 'string' ? artifact.metadata.fileName : undefined;
  const sourcePath = typeof artifact.metadata?.sourcePath === 'string' ? artifact.metadata.sourcePath : undefined;
  return {
    content: JSON.stringify({
      action: 'create',
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      ...(fileName ? { fileName } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      mimeType: artifact.mimeType,
      userVisible: false,
      deliveryInstruction: `Use Artifact(action="deliver", artifact_id="${artifact.artifactId}") to show this artifact to the user.`,
    }, null, 2),
    metadata: {
      artifactAction: 'create',
      artifactId: artifact.artifactId,
      artifactKind: artifact.kind,
      ...(fileName ? { fileName } : {}),
      ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    },
  };
}
