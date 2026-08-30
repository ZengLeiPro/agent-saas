import type { Request } from 'express';
import { getTranscriptPath } from '../data/transcripts/store.js';
import { deleteSessionMetaIfMatches, readSessionMeta, writeSessionMetaIfAbsent } from '../data/transcripts/meta.js';
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
  const sessionMetaCreated = await writeSessionMetaIfAbsent(transcriptPath, {
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
  const meta=await readSessionMeta(transcriptPath);
  const incompatible=!meta||meta.tenantId!==req.user.tenantId||meta.userId!==req.user.sub||meta.cwd!==cwd
    ||meta.workspaceId!==sessionId||meta.transcriptPath!==transcriptPath||meta.orgAgentId!==undefined
    ||meta.profileId!==undefined||meta.profileKey!==undefined||meta.profileVersionId!==undefined;
  if(incompatible)throw new SessionAutomationConflictError('SESSION_META_CONFLICT','existing session metadata conflicts with automation creation intent');
  return { tenantId: req.user.tenantId, ownerUserId: req.user.sub, sessionId, sessionMetaCreated };
}

/** Delete only the exact orphan meta created by this command intent. */
export async function compensateAutomationSession(req: Request, sessionId: string, agentCwd: string): Promise<boolean> {
  if (!req.user?.sub || !req.user.tenantId) return false;
  const cwd = resolveUserCwd(agentCwd, { id:req.user.sub,username:req.user.username,role:req.user.role,tenantId:req.user.tenantId });
  const transcriptPath = getTranscriptPath(cwd,sessionId,{tenantId:req.user.tenantId,userId:req.user.sub});
  return deleteSessionMetaIfMatches(transcriptPath, meta =>
    meta.tenantId===req.user!.tenantId && meta.userId===req.user!.sub && meta.username===req.user!.username
    && meta.userRole===req.user!.role && meta.channel==='web' && meta.cwd===cwd
    && meta.transcriptPath===transcriptPath && meta.workspaceId===sessionId
    && meta.sandboxProfile==='daily' && meta.orgAgentId===undefined && meta.profileId===undefined
    && meta.profileKey===undefined && meta.profileVersionId===undefined
  );
}
