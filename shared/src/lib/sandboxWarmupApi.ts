import { authFetch } from './authFetch';

/**
 * 会话沙箱预热（对齐 `web/src/lib/sessionsApi.ts` 的 `warmupSessionSandbox`）。
 *
 * 语义：用户在某会话里首次敲出有效文本时打一次 `POST /api/sessions/:id/warmup`，
 * 让沙箱在真正发送前先起来。调用方负责「每会话只打一次」的去重与吞错。
 */
export async function warmupSessionSandbox(sessionId: string): Promise<void> {
  const response = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/warmup`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`Sandbox warmup failed: HTTP ${response.status}`);
}
