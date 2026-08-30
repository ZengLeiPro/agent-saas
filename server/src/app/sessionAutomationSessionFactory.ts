import type { Request } from 'express';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { writeSessionMetaIfAbsent } from '../data/transcripts/meta.js';
import { SessionAutomationConflictError, type AutomationIdentity } from '../runtime/sessionAutomationStore.js';
import { resolveUserCwd } from '../workspace/resolver.js';

/** Forward-only new-session saga step; writeSessionMetaIfAbsent makes prepared-command retries idempotent. */
export async function ensureAutomationSession(req: Request, sessionId: string, agentCwd: string): Promise<AutomationIdentity> {
  if (!req.user?.sub || !req.user.tenantId) {
    throw new SessionAutomationConflictError('FORBIDDEN', 'Authentication required');
  }
  const cwd = resolveUserCwd(agentCwd, {
    id: req.user.sub,
    username: req.user.username,
    role: req.user.role,
    tenantId: req.user.tenantId,
  });
  const transcriptPath = getTranscriptPath(cwd, sessionId, {
    tenantId: req.user.tenantId,
    userId: req.user.sub,
  });
  const now = new Date().toISOString();
  await writeSessionMetaIfAbsent(transcriptPath, {
    userId: req.user.sub,
    username: req.user.username,
    userRole: req.user.role,
    tenantId: req.user.tenantId,
    channel: 'web',
    cwd,
    transcriptPath,
    workspaceId: sessionId,
    sandboxProfile: 'daily',
    runtimeStatus: 'idle',
    createdAt: now,
    updatedAt: now,
  });
  return { tenantId: req.user.tenantId, ownerUserId: req.user.sub, sessionId };
}
