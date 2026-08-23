import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { ArtifactKind } from '../runtime/artifactStore.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type { ToolDescriptor, ToolResult, WorkspaceRef } from './toolRuntime.js';

export const MAX_EDIT_FILE_BYTES = 1_000_000;
export const MAX_ARTIFACT_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_READ_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const WORKSPACE_READ_IMAGE_PAYLOAD_METADATA_KEY = 'readImagePayload';

const EDIT_DENY_PATTERNS: RegExp[] = [
  /(^|\/)\.ky-agent\/settings\.json$/i,
  /(^|\/)\.claude\/settings\.json$/i,
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.git\//i,
];
const ARTIFACT_DENY_PATTERNS: RegExp[] = EDIT_DENY_PATTERNS;

export type EditInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export type CreateArtifactInput = {
  file_path: string;
  kind?: ArtifactKind;
  mime_type?: string;
  metadata?: Record<string, unknown>;
};

export type ArtifactInput = {
  action: 'create' | 'deliver';
  file_path?: string;
  artifact_id?: string;
  kind?: ArtifactKind;
  mime_type?: string;
  metadata?: Record<string, unknown>;
};

export type WorkspaceArtifactPayload = {
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  dataBase64: string;
  kind?: ArtifactKind;
  mimeType?: string;
};

export type WorkspaceReadImagePayload = {
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  dataBase64: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
};

export function detectWorkspaceImageMime(
  bytes: Buffer,
): WorkspaceReadImagePayload['mimeType'] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

type PathGuard = (fullPath: string) => void;

export const editToolDescriptor: ToolDescriptor<EditInput> = {
  id: 'Edit',
  name: 'Edit',
  displayName: 'Edit',
  description: loadToolDescription('Edit'),
  schema: z.object({
    file_path: z.string().min(1).describe('工作区相对路径，或工作区内的绝对路径。'),
    old_string: z.string().describe('要查找的精确文本。'),
    new_string: z.string().describe('替换后的文本。'),
    replace_all: z.boolean().optional().describe('替换所有匹配项，而不是在多处匹配时报错。'),
  }),
  risk: 'workspace_write',
  approvalMode: 'web',
  auditCategory: 'filesystem.edit',
  category: 'workspace',
  label: '精确编辑文件',
};

/**
 * Hand 内部协议名。brain 对模型只公示下方 Artifact；create action 会被翻译成
 * CreateArtifact 发给 hand，避免要求已部署的 remote hand 与 brain 同步升级。
 */
export const artifactCreateToolDescriptor: ToolDescriptor<CreateArtifactInput> = {
  id: 'CreateArtifact',
  name: 'CreateArtifact',
  displayName: 'Create Artifact (internal)',
  description: loadToolDescription('CreateArtifact'),
  schema: z.object({
    file_path: z.string().min(1).describe('工作区相对路径，或工作区内的绝对路径。'),
    kind: z.enum(['file', 'screenshot', 'patch', 'log', 'blob']).optional(),
    mime_type: z.string().optional().describe('可选 MIME 类型，如 text/plain 或 image/png。'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'artifact.create',
  category: 'workspace',
  label: '创建 Artifact（内部）',
};

export const artifactToolDescriptor: ToolDescriptor<ArtifactInput> = {
  id: 'Artifact',
  name: 'Artifact',
  displayName: 'Artifact',
  description: loadToolDescription('Artifact'),
  schema: z.object({
    action: z.enum(['create', 'deliver']),
    file_path: z.string().min(1).optional().describe('create 必填：工作区内文件路径。'),
    artifact_id: z.string().min(1).optional().describe('deliver 必填：create 返回的 artifactId。'),
    kind: z.enum(['file', 'screenshot', 'patch', 'log', 'blob']).optional(),
    mime_type: z.string().optional().describe('create 可选：MIME 类型，如 text/plain 或 image/png。'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'artifact.manage',
  category: 'workspace',
  label: '创建与交付 Artifact',
};

export async function runWorkspaceEdit(
  input: EditInput,
  workspace: WorkspaceRef,
  guard?: PathGuard,
): Promise<ToolResult & { metadata?: Record<string, unknown> }> {
  const fullPath = resolveInsideWorkspace(workspace.root, input.file_path);
  guard?.(fullPath);
  const relPath = relativeWorkspacePath(workspace.root, fullPath);
  assertNotDenied(relPath, EDIT_DENY_PATTERNS, (path) =>
    `Edit: path "${path}" is in the deny list (sensitive config / credentials). Ask the admin via console if a change is genuinely required.`);

  let st;
  try {
    st = await stat(fullPath);
  } catch (err) {
    throw new Error(`Edit: cannot stat ${relPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (st.size > MAX_EDIT_FILE_BYTES) {
    throw new Error(`Edit: file too large (${st.size}B > ${MAX_EDIT_FILE_BYTES}B); use Write to rewrite.`);
  }
  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch (err) {
    throw new Error(`Edit: cannot read ${relPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (input.old_string === input.new_string) {
    throw new Error('Edit: old_string equals new_string; no-op.');
  }
  if (input.old_string === '') {
    throw new Error('Edit: empty old_string not allowed; use Write for new files.');
  }

  const parts = content.split(input.old_string);
  const occurrences = parts.length - 1;
  if (occurrences === 0) {
    throw new Error('Edit: old_string not found.');
  }
  if (!input.replace_all && occurrences > 1) {
    throw new Error(`Edit: old_string matched ${occurrences} times; supply more surrounding context or set replace_all=true.`);
  }
  const updated = parts.join(input.new_string);
  const replacements = input.replace_all ? occurrences : 1;

  await writeFile(fullPath, updated, 'utf-8');
  return {
    content: `Edited ${relPath} (${replacements} replacement${replacements === 1 ? '' : 's'}, ${updated.length} bytes).`,
    // 摘要要说清「实际替换了几处」——replace_all 时 1 处与 37 处在审计上完全不同
    metadata: {
      path: relPath,
      replacements,
      occurrences,
      bytesBefore: content.length,
      bytesAfter: updated.length,
    },
  };
}

export async function createWorkspaceArtifactPayload(
  input: CreateArtifactInput,
  workspace: WorkspaceRef,
  guard?: PathGuard,
): Promise<WorkspaceArtifactPayload> {
  const fullPath = resolveInsideWorkspace(workspace.root, input.file_path);
  guard?.(fullPath);
  const relPath = relativeWorkspacePath(workspace.root, fullPath);
  assertNotDenied(relPath, ARTIFACT_DENY_PATTERNS, (path) => `CreateArtifact: refused sensitive path ${path}`);
  const lst = await lstat(fullPath);
  if (lst.isSymbolicLink()) {
    throw new Error(`CreateArtifact: refused symlink ${relPath}`);
  }
  const st = await stat(fullPath);
  if (!st.isFile()) {
    throw new Error('CreateArtifact: source must be a file');
  }
  if (st.size > MAX_ARTIFACT_PAYLOAD_BYTES) {
    throw new Error(`CreateArtifact: file too large (${st.size}B > ${MAX_ARTIFACT_PAYLOAD_BYTES}B)`);
  }
  const data = await readFile(fullPath);
  return {
    sourcePath: normalizePath(relPath),
    fileName: basename(fullPath),
    sizeBytes: data.byteLength,
    dataBase64: data.toString('base64'),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.mime_type ? { mimeType: input.mime_type } : {}),
  };
}

export function workspaceArtifactPreparedContent(payload: WorkspaceArtifactPayload): string {
  return JSON.stringify({
    sourcePath: payload.sourcePath,
    fileName: payload.fileName,
    sizeBytes: payload.sizeBytes,
  }, null, 2);
}

export function workspaceReadImagePreparedContent(payload: WorkspaceReadImagePayload): string {
  return `Read image ${payload.sourcePath} (${payload.mimeType}, ${payload.sizeBytes} bytes). The image is attached as visual input.`;
}

function resolveInsideWorkspace(cwd: string, inputPath: string): string {
  const fullPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const rel = relative(cwd, fullPath);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) {
    return fullPath;
  }
  throw new Error(`Access denied: path outside workspace (${inputPath})`);
}

function relativeWorkspacePath(cwd: string, fullPath: string): string {
  return relative(cwd, fullPath) || '.';
}

function normalizePath(p: string): string {
  return p.split(sep).join('/');
}

function assertNotDenied(relPath: string, patterns: RegExp[], message: (path: string) => string): void {
  const normalized = normalizePath(relPath);
  for (const re of patterns) {
    if (re.test('/' + normalized)) {
      throw new Error(message(relPath));
    }
  }
}

// Tiny exported marker for tests that need a stable payload shape without parsing transcript content.
export const WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY = 'artifactPayload';
