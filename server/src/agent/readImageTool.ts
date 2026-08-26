import { open, readFile } from 'node:fs/promises';

import type { ToolInvocationResponse } from '../runtime/handProtocol.js';
import { materializeToolImage } from '../runtime/imageAttachments.js';
import type { ModelUserContentPart } from '../runtime/types.js';
import {
  MAX_READ_IMAGE_SOURCE_BYTES,
  WORKSPACE_READ_IMAGE_PAYLOAD_METADATA_KEY,
  detectWorkspaceImageMime,
  workspaceReadImagePreparedContent,
  type WorkspaceReadImagePayload,
} from './workspaceHandTools.js';

export async function tryReadWorkspaceImage(input: {
  fullPath: string;
  relPath: string;
  fileSize: number;
  offset?: number;
  limit?: number;
}): Promise<{ content: string; metadata: Record<string, unknown> } | undefined> {
  const header = await readBufferPrefix(input.fullPath, 32);
  const mimeType = detectWorkspaceImageMime(header);
  if (!mimeType) return undefined;
  if (input.fileSize > MAX_READ_IMAGE_SOURCE_BYTES) {
    throw new Error(`Read: image too large (${input.fileSize}B > ${MAX_READ_IMAGE_SOURCE_BYTES}B)`);
  }
  const data = await readFile(input.fullPath);
  const payload: WorkspaceReadImagePayload = {
    sourcePath: input.relPath,
    fileName: input.relPath.split('/').at(-1) || 'image',
    sizeBytes: data.byteLength,
    dataBase64: data.toString('base64'),
    mimeType,
  };
  return {
    content: workspaceReadImagePreparedContent(payload),
    metadata: {
      path: input.relPath,
      fileBytes: input.fileSize,
      mimeType,
      [WORKSPACE_READ_IMAGE_PAYLOAD_METADATA_KEY]: payload,
    },
  };
}

export async function materializeReadToolImage(
  response: Extract<ToolInvocationResponse, { status: 'success' }>,
  workspaceRoot: string,
): Promise<Array<Extract<ModelUserContentPart, { type: 'image_attachment' }>> | undefined> {
  const payload = response.metadata?.[WORKSPACE_READ_IMAGE_PAYLOAD_METADATA_KEY] as WorkspaceReadImagePayload | undefined;
  if (!payload) return undefined;
  if (
    typeof payload.dataBase64 !== 'string'
    || typeof payload.fileName !== 'string'
    || typeof payload.sizeBytes !== 'number'
  ) {
    throw new Error('Read: hand response contains an invalid image payload');
  }
  const source = Buffer.from(payload.dataBase64, 'base64');
  if (source.byteLength !== payload.sizeBytes) {
    throw new Error('Read: hand response image byte count mismatch');
  }
  return [await materializeToolImage({
    cwd: workspaceRoot,
    source,
    displayName: payload.fileName,
  })];
}

async function readBufferPrefix(fullPath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
