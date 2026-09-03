export type SandboxSessionDeletionResult = 'not_required' | 'blocked' | 'queued' | 'deleted';

export interface SandboxSessionDeletionHandler {
  sandboxSessionDeletion?: (sessionId: string) => Promise<SandboxSessionDeletionResult>;
}

export async function requireSandboxPhysicalDeletion(
  options: SandboxSessionDeletionHandler,
  sessionId: string,
): Promise<void> {
  if (!options.sandboxSessionDeletion) {
    throw new Error('Sandbox cleanup callback 缺失，拒绝物理删除 Session 数据');
  }
  const result = await options.sandboxSessionDeletion(sessionId);
  if (result === 'deleted' || result === 'not_required') return;
  if (result === 'queued') throw new Error('Sandbox cleanup 仍在排队，拒绝物理删除 Session 数据');
  throw new Error('Sandbox cleanup 被阻塞，拒绝物理删除 Session 数据');
}
