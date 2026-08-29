import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { ArtifactKind } from '../runtime/artifactStore.js';
import { openTrustedFile, openTrustedFileForUpdate } from '../security/trustedFile.js';
import { applyWorkspaceEdits, type EditOperation } from './editOperations.js';
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
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  edits?: EditOperation[];
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

const editOperationSchema = z.object({
  old_string: z.string().describe('要查找的文本；精确匹配失败后会尝试安全的空白与 Unicode 标点归一化。'),
  new_string: z.string().describe('替换后的文本。'),
  replace_all: z.boolean().optional().describe('替换该 edit 的全部匹配项。'),
});

const editInputSchema = z.object({
  file_path: z.string().min(1).describe('工作区相对路径，或工作区内的绝对路径。'),
  old_string: z.string().optional().describe('兼容单 edit 调用：要查找的文本。'),
  new_string: z.string().optional().describe('兼容单 edit 调用：替换后的文本。'),
  replace_all: z.boolean().optional().describe('兼容单 edit 调用：替换全部匹配项。'),
  edits: z.array(editOperationSchema).min(1).max(100).optional().describe('一次原子应用的 edit 数组；全部针对原始文件匹配。'),
}).superRefine((input, context) => {
  const hasLegacyField = input.old_string !== undefined || input.new_string !== undefined;
  if (!hasLegacyField && !input.edits) {
    context.addIssue({ code: 'custom', message: 'Edit requires old_string/new_string or a non-empty edits array.' });
  }
  if (hasLegacyField && (input.old_string === undefined || input.new_string === undefined)) {
    context.addIssue({ code: 'custom', message: 'Edit legacy input requires both old_string and new_string.' });
  }
});

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeEditOperation(value: unknown): unknown {
  const parsed = parseJsonString(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  const oldString = record.old_string ?? record.oldText;
  const newString = record.new_string ?? record.newText;
  const replaceAll = record.replace_all ?? record.replaceAll;
  return {
    ...record,
    ...(oldString !== undefined ? { old_string: oldString } : {}),
    ...(newString !== undefined ? { new_string: newString } : {}),
    ...(replaceAll !== undefined ? { replace_all: replaceAll } : {}),
  };
}

export function prepareEditInput(value: unknown): unknown {
  const parsed = parseJsonString(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  const editsValue = parseJsonString(record.edits);
  const edits = editsValue === undefined
    ? undefined
    : (Array.isArray(editsValue) ? editsValue : [editsValue]).map(normalizeEditOperation);
  const filePath = record.file_path ?? record.path;
  const oldString = record.old_string ?? record.oldText;
  const newString = record.new_string ?? record.newText;
  const replaceAll = record.replace_all ?? record.replaceAll;
  return {
    ...record,
    ...(filePath !== undefined ? { file_path: filePath } : {}),
    ...(oldString !== undefined ? { old_string: oldString } : {}),
    ...(newString !== undefined ? { new_string: newString } : {}),
    ...(replaceAll !== undefined ? { replace_all: replaceAll } : {}),
    ...(edits ? { edits } : {}),
  };
}

function collectEditOperations(input: EditInput): EditOperation[] {
  const operations: EditOperation[] = [];
  if (input.old_string !== undefined && input.new_string !== undefined) {
    operations.push({
      old_string: input.old_string,
      new_string: input.new_string,
      ...(input.replace_all !== undefined ? { replace_all: input.replace_all } : {}),
    });
  }
  if (input.edits) operations.push(...input.edits);
  return operations;
}

export const editToolDescriptor: ToolDescriptor<EditInput> = {
  id: 'Edit',
  name: 'Edit',
  displayName: 'Edit',
  description: loadToolDescription('Edit'),
  descriptionInvariants: ['批量', 'CRLF/LF', '10000', 'unified diff', '1MB'],
  schema: editInputSchema,
  prepareInput: prepareEditInput,
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

  let opened: Awaited<ReturnType<typeof openTrustedFileForUpdate>>;
  try {
    opened = await openTrustedFileForUpdate(workspace.root, relPath);
  } catch (err) {
    throw new Error(`Edit: cannot open ${relPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    if (opened.stats.size > MAX_EDIT_FILE_BYTES) {
      throw new Error(`Edit: file too large (${opened.stats.size}B > ${MAX_EDIT_FILE_BYTES}B); use Write to rewrite.`);
    }
    let content: string;
    try {
      content = await opened.handle.readFile('utf-8');
    } catch (err) {
      throw new Error(`Edit: cannot read ${relPath} (${err instanceof Error ? err.message : String(err)})`);
    }
    const applied = applyWorkspaceEdits(content, collectEditOperations(input), relPath);
    const updatedBytes = Buffer.from(applied.updatedContent, 'utf8');
    let written = 0;
    while (written < updatedBytes.length) {
      const result = await opened.handle.write(updatedBytes, written, updatedBytes.length - written, written);
      if (result.bytesWritten <= 0) throw new Error(`Edit: short write while updating ${relPath}.`);
      written += result.bytesWritten;
    }
    await opened.handle.truncate(updatedBytes.length);
    await opened.handle.sync();
    const bytesBefore = Buffer.byteLength(content, 'utf8');
    const bytesAfter = updatedBytes.length;
    return {
      content: `Edited ${relPath} (${applied.replacements} replacement${applied.replacements === 1 ? '' : 's'} across ${applied.editCount} edit${applied.editCount === 1 ? '' : 's'}, ${bytesAfter} bytes).`,
      metadata: {
        path: relPath,
        replacements: applied.replacements,
        occurrences: applied.occurrences,
        editCount: applied.editCount,
        fuzzyMatches: applied.fuzzyMatches,
        bomPreserved: applied.bomPreserved,
        lineEnding: applied.lineEnding === '\r\n' ? 'CRLF' : 'LF',
        bytesBefore,
        bytesAfter,
        diff: applied.diff,
        diffTruncated: applied.diffTruncated,
        firstChangedLine: applied.firstChangedLine,
      },
    };
  } finally {
    await opened.handle.close();
  }
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
  const opened = await openTrustedFile(workspace.root, relPath);
  let data: Buffer;
  try {
    if (opened.stats.size > MAX_ARTIFACT_PAYLOAD_BYTES) {
      throw new Error(`CreateArtifact: file too large (${opened.stats.size}B > ${MAX_ARTIFACT_PAYLOAD_BYTES}B)`);
    }
    data = await opened.handle.readFile();
  } finally {
    await opened.handle.close();
  }
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
