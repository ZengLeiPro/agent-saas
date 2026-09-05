import type { WsEvent } from '../types/ws';

/** 会话列表的最小写接口（两端 `useSession` 都满足）。 */
export interface SessionListMetadataSink {
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionMeta: (
    sessionId: string,
    patch: { preview?: string; updatedAtMs?: number; title?: string },
  ) => void;
  upsertSession?: (session: {
    sessionId: string;
    title?: string;
    preview?: string;
    updatedAtMs: number;
    model?: string;
    username?: string;
  }) => void;
}

/**
 * `sync_ok` 回放的会话元数据事件 → 会话列表（两端 `useChatAppState` 共同实现）：
 * `title_updated` 改标题；`session_updated` 新会话走 upsert（存在时）、否则只 patch preview / 时间 / 标题。
 * 返回是否处理了该事件；`session_deleted` 等平台各有额外清理，不在此处。
 */
export function applyReplayedSessionMetadata(sink: SessionListMetadataSink, e: WsEvent): boolean {
  if (e.type === 'title_updated') {
    sink.updateSessionTitle(e.sessionId, e.title);
    return true;
  }
  if (e.type === 'session_updated') {
    if (e.isNew && sink.upsertSession) {
      sink.upsertSession({
        sessionId: e.sessionId,
        preview: e.preview,
        updatedAtMs: e.updatedAtMs,
        title: e.title,
        model: e.model,
        username: e.username,
      });
    } else {
      sink.updateSessionMeta(e.sessionId, {
        preview: e.preview,
        updatedAtMs: e.updatedAtMs,
        ...(e.title !== undefined ? { title: e.title } : {}),
      });
    }
    return true;
  }
  return false;
}
