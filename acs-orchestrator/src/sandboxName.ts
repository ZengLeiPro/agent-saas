import { createHash } from 'node:crypto';

const MAX_K8S_NAME_LENGTH = 63;

export function validateWorkspaceId(workspaceId: string): string {
  const id = workspaceId.trim();
  if (!id) throw new Error('workspaceId 不能为空');
  if (id.includes('/') || id.includes('\\') || id.includes('..') || id.startsWith('.')) {
    throw new Error(`workspaceId 非法: ${workspaceId}`);
  }
  return id;
}

export function validateSessionId(sessionId: string): string {
  const id = sessionId.trim();
  if (!id) throw new Error('sessionId 不能为空');
  if (id.includes('/') || id.includes('\\') || id.includes('..') || id.startsWith('.')) {
    throw new Error(`sessionId 非法: ${sessionId}`);
  }
  return id;
}

export function sandboxNameFor(input: { workspaceId: string; sessionId: string }): string {
  const workspaceId = validateWorkspaceId(input.workspaceId);
  const sessionId = validateSessionId(input.sessionId);
  const hash = createHash('sha256').update(`${workspaceId}:${sessionId}`).digest('hex').slice(0, 16);
  const prefix = slugify(sessionId).slice(0, 36) || 'session';
  const name = `as-${prefix}-${hash}`;
  return name.length <= MAX_K8S_NAME_LENGTH ? name : `as-${hash}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}
