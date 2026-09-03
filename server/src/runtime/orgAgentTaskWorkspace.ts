import { createHash } from 'node:crypto';
import { join } from 'node:path';

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,96}$/;

export interface OrgAgentTaskWorkspaceLayout {
  attemptId: string;
  taskWorkspaceId: string;
  taskRoot: string;
  mountSubPath: string;
  sharedReadOnlySubPath: string;
  sandboxScopeId: string;
}

export function deriveOrgAgentTaskWorkspace(input: {
  agentWorkspaceId: string;
  agentRoot: string;
  agentMountSubPath: string;
  taskId: string;
  attemptNo: number;
}): OrgAgentTaskWorkspaceLayout {
  if (!SAFE_SEGMENT.test(input.taskId) || input.taskId.includes('..'))
    throw new Error('ORG_AGENT_TASK_ID_INVALID');
  if (!Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1)
    throw new Error('ORG_AGENT_ATTEMPT_INVALID');
  assertRelativePosix(input.agentMountSubPath);
  const digest = createHash('sha256')
    .update(`${input.taskId}:${input.attemptNo}`)
    .digest('base64url')
    .slice(0, 20);
  const relativeTaskRoot = `work/${input.taskId}/attempt-${input.attemptNo}`;
  return {
    attemptId: `attempt-${createHash('sha256').update(`${input.taskId}:${input.attemptNo}`).digest('hex').slice(0, 32)}`,
    taskWorkspaceId: `${input.agentWorkspaceId}__task_${digest}`,
    taskRoot: join(input.agentRoot, 'work', input.taskId, `attempt-${input.attemptNo}`),
    mountSubPath: `${input.agentMountSubPath}/${relativeTaskRoot}`,
    sharedReadOnlySubPath: input.agentMountSubPath,
    sandboxScopeId: `${input.agentWorkspaceId}__task_${digest}`,
  };
}

function assertRelativePosix(value: string): void {
  const parts = value.split('/');
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('ORG_AGENT_TASK_MOUNT_INVALID');
  }
}
