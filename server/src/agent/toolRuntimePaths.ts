import { isAbsolute, relative, resolve } from 'path';

import type { ToolInvocationResponse } from '../runtime/handProtocol.js';
import type { ExecutionTargetKind, ToolDescriptor, WorkspaceRef } from './toolRuntime.js';

export function parseToolInput<TInput>(descriptor: ToolDescriptor<TInput>, input: unknown): TInput {
  return descriptor.schema.parse(descriptor.prepareInput ? descriptor.prepareInput(input) : input) as TInput;
}

export function tryParseToolInput<TInput>(
  descriptor: ToolDescriptor<TInput>,
  input: unknown,
): { ok: true; input: TInput } | { ok: false; error: string } {
  try {
    return { ok: true, input: parseToolInput(descriptor, input) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const fullPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  if (!isInside(cwd, fullPath)) {
    throw new Error(`Access denied: path outside workspace (${inputPath})`);
  }
  return fullPath;
}

export function relativeWorkspacePath(cwd: string, fullPath: string): string {
  const rel = relative(cwd, fullPath);
  return (rel || '.').replace(/\\/g, '/');
}

export function workspaceRelativeInputPath(cwd: string, inputPath: string): string {
  return relativeWorkspacePath(cwd, resolveWorkspacePath(cwd, inputPath));
}

export function memoryPathFromSuccessfulTool(
  toolId: string,
  input: unknown,
  workspace: WorkspaceRef,
  response: Extract<ToolInvocationResponse, { status: 'success' }>,
): string | null {
  if (toolId !== 'Write' && toolId !== 'Edit') return null;
  const metadataPath = typeof response.metadata?.path === 'string'
    ? response.metadata.path
    : undefined;
  const inputPath = input && typeof input === 'object'
    ? (input as { path?: unknown; file_path?: unknown }).path ?? (input as { file_path?: unknown }).file_path
    : undefined;
  const candidate = metadataPath ?? (typeof inputPath === 'string' ? inputPath : undefined);
  if (!candidate) return null;
  const relPath = normalizeWorkspaceRelativePath(workspace.root, candidate);
  return relPath && isMemorySourcePath(relPath) ? relPath : null;
}

export function normalizeWorkspaceRelativePath(workspaceRoot: string, candidate: string): string | null {
  try {
    const fullPath = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(workspaceRoot, candidate);
    if (!isInside(workspaceRoot, fullPath)) return null;
    return relativeWorkspacePath(workspaceRoot, fullPath);
  } catch {
    return null;
  }
}

export function isMemorySourcePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return normalized === 'MEMORY.md'
    || (normalized.startsWith('memory/') && normalized.endsWith('.md'));
}

export function shellCommandMentionsMemoryPath(command: string): boolean {
  return /(^|[\s"'`=;:&|(<])(?:\.\/)?MEMORY\.md($|[\s"'`);:&|>])/.test(command)
    || /(^|[\s"'`=;:&|(<])(?:\.\/)?memory\/[^"'`\s;&|<>]*\.md($|[\s"'`);:&|>])/.test(command)
    || /\/MEMORY\.md($|[\s"'`);:&|>])/.test(command)
    || /\/memory\/[^"'`\s;&|<>]*\.md($|[\s"'`);:&|>])/.test(command);
}

export function isExecutionTargetKind(value: unknown): value is ExecutionTargetKind {
  return value === 'server-local'
    || value === 'server-container'
    || value === 'server-remote'
    || value === 'client';
}
