import { Router, type Request, type Response } from 'express';

import { ContextRecallScopeDriftError } from '../context/retrieval/index.js';
import type {
  ContextRecallHit,
  ContextRecallScopeResolver,
  ContextRecallService,
} from '../context/retrieval/index.js';
import { isValidSessionId } from '../data/transcripts/index.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';

export interface ContextCitationsRouterOptions {
  sessionCatalog?: Pick<SessionCatalog, 'get'>;
  recall?: ContextRecallService;
  scopes?: ContextRecallScopeResolver;
  logger?: { warn?: (message: string) => void };
}

/**
 * Owner-only Context evidence lookup for chat citation cards.
 * The opaque hit id is routing data only; every click resolves the current session pin and ACL again.
 */
export function createContextCitationsRouter(options: ContextCitationsRouterOptions): Router {
  const router = Router();

  router.get('/sessions/:sessionId/context-citations/:contextId', async (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required', code: 'CONTEXT_CITATION_UNAUTHENTICATED' });
      return;
    }
    if (!options.sessionCatalog || !options.recall || !options.scopes) {
      res.status(503).json({ error: 'Context 引用服务暂不可用', code: 'CONTEXT_CITATION_UNAVAILABLE' });
      return;
    }

    const sessionId = req.params.sessionId?.trim() ?? '';
    const contextId = req.params.contextId?.trim() ?? '';
    if (!isValidSessionId(sessionId) || !contextId || contextId.length > 512) {
      notFound(res);
      return;
    }

    try {
      const session = await options.sessionCatalog.get(sessionId);
      // 管理员也不能越过会话 owner；统一 404，避免枚举其他用户会话。
      if (!session || session.userId !== req.user.sub || session.tenantId !== req.user.tenantId) {
        notFound(res);
        return;
      }
      const subject = {
        tenantId: req.user.tenantId,
        userId: req.user.sub,
        sessionId,
        ...(session.orgAgentId ? { orgAgentId: session.orgAgentId } : {}),
      };
      const scope = await options.scopes.resolve(subject, { operation: 'get', recallId: contextId });
      if (scope.collections.length === 0) {
        notFound(res);
        return;
      }
      const result = await options.recall.get({ subject, id: contextId, scope });
      const hit = result.hit;
      if (!hit || !scope.collections.some(item => (
        item.collectionId === hit.collectionId && item.assignmentVersion === hit.assignmentVersion
      ))) {
        notFound(res);
        return;
      }
      const reasons = [...new Set([
        ...(scope.degradationReasons ?? []),
        ...(result.degradationReasons ?? []),
      ])];
      res.json({
        citation: publicCitation(hit),
        degraded: scope.degraded === true || result.degraded,
        degradationReasons: reasons,
      });
    } catch (error) {
      if (error instanceof ContextRecallScopeDriftError) {
        if (error.code === 'CONTEXT_RECALL_ASSIGNMENT_PIN_DRIFT') {
          res.status(409).json({
            error: '当前授权与会话快照已发生变化，请新建会话后重试',
            code: 'CONTEXT_CITATION_ASSIGNMENT_DRIFT',
          });
          return;
        }
        notFound(res);
        return;
      }
      options.logger?.warn?.(
        `Context citation lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(503).json({ error: 'Context 引用服务暂不可用', code: 'CONTEXT_CITATION_UNAVAILABLE' });
    }
  });

  return router;
}

function publicCitation(hit: ContextRecallHit): Record<string, unknown> {
  return {
    id: hit.id,
    kind: hit.kind,
    recordKind: hit.recordKind,
    ...(hit.entityType ? { entityType: hit.entityType } : {}),
    content: hit.content,
    source: {
      sourceId: hit.source.sourceId,
      kind: hit.source.kind,
      ...(hit.source.displayName ? { displayName: hit.source.displayName } : {}),
      ...(safeHttpUrl(hit.source.url) ? { url: hit.source.url } : {}),
    },
    time: hit.time,
    freshness: hit.freshness,
    derived: hit.derived,
    evidence: hit.evidence.map(item => ({
      evidenceId: item.evidenceId,
      kind: item.kind,
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
      ...(item.author ? { author: item.author } : {}),
      ...(safeHttpUrl(item.url) ? { url: item.url } : {}),
      ...(item.occurredAt ? { occurredAt: item.occurredAt } : {}),
    })),
  };
}

function safeHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function notFound(res: Response): void {
  res.status(404).json({ error: '引用不存在或当前无权查看', code: 'CONTEXT_CITATION_NOT_FOUND' });
}
