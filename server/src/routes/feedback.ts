/**
 * 消息反馈路由（2026-07 唯恩批次）
 *
 * POST /api/feedback                       — 登录用户对专职 Agent 回答点「踩」（owner-only）
 * GET  /api/feedback/session/:sessionId    — 本人在某会话的反馈（刷新后恢复已反馈态）
 *
 * 安全要点：
 * - owner-only：canAccessSession（任何身份只能反馈自己的会话）
 * - 会话必须绑定 orgAgentId，否则 400（个人 Agent 会话不收反馈）
 * - orgAgentId 从会话 meta 取（防客户端伪造归因）
 * - content_hash 由 server 计算 sha256（幂等键），excerpt 截前 500 字
 * - store 未装配（file backend）→ 503，前端隐藏入口
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { canAccessSession } from '../data/sessions/access.js';
import type { MessageFeedbackStore } from '../data/feedback/store.js';
import { readSessionMeta } from '../data/transcripts/meta.js';
import { findTranscriptOrMetaPathBySessionId, isValidSessionId } from '../data/transcripts/index.js';
import { auditLog } from '../data/login-logs/index.js';

/** body 总量上限（16KB）：content 是消息全文，超长直接拒绝防滥用 */
const MAX_FEEDBACK_BODY_BYTES = 16 * 1024;

const postFeedbackSchema = z.object({
  sessionId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  content: z.string().min(1),
  comment: z.string().max(500).optional(),
});

export interface FeedbackRouterDeps {
  messageFeedbackStore?: MessageFeedbackStore;
  /** 测试注入：按 sessionId 定位 transcript（默认全局扫描新 layout） */
  resolveTranscriptPath?: (sessionId: string) => Promise<string | null>;
}

export function createFeedbackRouter(deps: FeedbackRouterDeps): Router {
  const router = Router();
  const resolveTranscriptPath = deps.resolveTranscriptPath ?? findTranscriptOrMetaPathBySessionId;

  function requireStore(res: Response): MessageFeedbackStore | null {
    if (!deps.messageFeedbackStore) {
      res.status(503).json({ error: '反馈功能需要 PG 数据面支持', code: 'FEEDBACK_UNAVAILABLE' });
      return null;
    }
    return deps.messageFeedbackStore;
  }

  async function loadOwnedSessionMeta(req: Request, res: Response, sessionId: string) {
    if (!isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'Invalid session id' });
      return null;
    }
    const transcriptPath = await resolveTranscriptPath(sessionId);
    if (!transcriptPath) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    const meta = await readSessionMeta(transcriptPath);
    if (!meta) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    if (!canAccessSession(req.user, meta)) {
      res.status(403).json({ error: 'Access denied' });
      return null;
    }
    return meta;
  }

  router.post('/', async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const store = requireStore(res);
    if (!store) return;

    const rawSize = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf-8');
    if (rawSize > MAX_FEEDBACK_BODY_BYTES) {
      res.status(413).json({ error: '反馈内容过长' });
      return;
    }
    const parsed = postFeedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
      return;
    }
    const { sessionId, messageId, content, comment } = parsed.data;

    try {
      const meta = await loadOwnedSessionMeta(req, res, sessionId);
      if (!meta) return;
      if (!meta.orgAgentId) {
        res.status(400).json({ error: '仅专职 Agent 会话支持反馈' });
        return;
      }

      const contentHash = createHash('sha256').update(content, 'utf-8').digest('hex');
      const { duplicated } = await store.insert({
        tenantId: meta.tenantId ?? user.tenantId,
        sessionId,
        messageId,
        orgAgentId: meta.orgAgentId,
        userId: user.sub,
        username: user.username,
        ...(comment?.trim() ? { comment: comment.trim() } : {}),
        messageExcerpt: content.slice(0, 500),
        contentHash,
      });
      if (!duplicated) {
        auditLog(req, 'message_feedback_submitted', `${sessionId} (${meta.orgAgentId})`);
      }
      res.json({ ok: true, duplicated, contentHash });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '提交反馈失败' });
    }
  });

  router.get('/session/:sessionId', async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const store = requireStore(res);
    if (!store) return;
    try {
      const meta = await loadOwnedSessionMeta(req, res, req.params.sessionId);
      if (!meta) return;
      const items = await store.listBySessionUser(req.params.sessionId, user.sub);
      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '获取反馈失败' });
    }
  });

  return router;
}
