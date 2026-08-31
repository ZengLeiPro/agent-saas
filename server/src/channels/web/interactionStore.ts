import type { WebSocket } from 'ws';
import type { InteractionResponse } from '../../agent/types.js';
import type { AskUserQuestion } from '../../types/index.js';

export interface PendingInteraction {
  resolve: (response: InteractionResponse) => void;
  reject: (reason: Error) => void;
  type: 'permission_request' | 'ask_user';
  createdAt: number;
  /** Monotonic summary version for session-list projection. */
  version: number;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  invocationId?: string;
  /** 创建者的 userId，或免认证匿名交互绑定的原始连接。 */
  userId?: string;
  boundWebSocket?: WebSocket;
  /** 企业专家会话在交互恢复时重新鉴权；缺省表示个人 Agent。 */
  orgAgentId?: string;
  /** ask_user 专用：存储问题列表 */
  questions?: AskUserQuestion[];
  /** permission_request 专用：存储工具名 */
  toolId?: string;
  toolName?: string;
  displayName?: string;
  toolInput?: Record<string, unknown>;
  /** ExitPlanMode 专用：plan 文件内容 */
  planContent?: string;
  onExpired?: (entry: PendingInteraction) => void;
}

/** SSE 断开后允许存活的交互类型（等待用户重连回答） */
const PLAN_MODE_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode']);
const PERSISTED_PLATFORM_APPROVAL_TOOL_IDS = new Set(['Write', 'Edit', 'Shell']);

function shouldSurviveDisconnect(entry: PendingInteraction): boolean {
  if (entry.type === 'ask_user') return true;
  if (entry.type === 'permission_request' && PLAN_MODE_TOOLS.has(entry.toolName || '')) return true;
  if (entry.type === 'permission_request' && PERSISTED_PLATFORM_APPROVAL_TOOL_IDS.has(entry.toolId || '')) return true;
  return false;
}

const INTERACTION_TIMEOUT_MS = 30 * 60 * 1000;

export interface CompletedInteractionResponse {
  sessionId: string;
  interactionId: string;
  requestId: string;
  response: InteractionResponse;
  completedAt: number;
}

class InteractionStore {
  private pending = new Map<string, PendingInteraction>();
  private pendingBySession = new Map<string, string[]>();
  private version = Date.now();
  private completed = new Map<string, CompletedInteractionResponse>();

  private addToSessionIndex(sessionId: string | undefined, interactionId: string): void {
    if (!sessionId) return;
    const ids = this.pendingBySession.get(sessionId) ?? [];
    this.pendingBySession.set(sessionId, [interactionId, ...ids.filter((id) => id !== interactionId)]);
  }

  private removeFromSessionIndex(sessionId: string | undefined, interactionId: string): void {
    if (!sessionId) return;
    const ids = (this.pendingBySession.get(sessionId) ?? []).filter((id) => id !== interactionId);
    if (ids.length) this.pendingBySession.set(sessionId, ids);
    else this.pendingBySession.delete(sessionId);
  }

  private take(interactionId: string): PendingInteraction | undefined {
    const entry = this.pending.get(interactionId);
    if (!entry) return undefined;
    this.pending.delete(interactionId);
    this.removeFromSessionIndex(entry.sessionId, interactionId);
    return entry;
  }

  private completedKey(sessionId: string, interactionId: string): string { return `${sessionId}\u0000${interactionId}`; }

  getCompleted(sessionId: string, interactionId: string): CompletedInteractionResponse | undefined {
    const key = this.completedKey(sessionId, interactionId);
    const value = this.completed.get(key);
    if (value && Date.now() - value.completedAt > INTERACTION_TIMEOUT_MS) { this.completed.delete(key); return undefined; }
    return value;
  }

  recordCompleted(sessionId: string, interactionId: string, requestId: string, response: InteractionResponse): void {
    this.completed.set(this.completedKey(sessionId, interactionId), { sessionId, interactionId, requestId, response, completedAt: Date.now() });
  }

  classifyCompleted(sessionId: string, interactionId: string, response: InteractionResponse): 'missing' | 'duplicate' | 'conflict' {
    const completed = this.getCompleted(sessionId, interactionId);
    if (!completed) return 'missing';
    return JSON.stringify(completed.response) === JSON.stringify(response) ? 'duplicate' : 'conflict';
  }

  create(
    interactionId: string,
    type: PendingInteraction['type'],
    options?: {
      sessionId?: string;
      runId?: string;
      toolCallId?: string;
      invocationId?: string;
      userId?: string;
      boundWebSocket?: WebSocket;
      orgAgentId?: string;
      questions?: AskUserQuestion[];
      toolId?: string;
      toolName?: string;
      displayName?: string;
      toolInput?: Record<string, unknown>;
      planContent?: string;
      onExpired?: (entry: PendingInteraction) => void;
    },
  ): Promise<InteractionResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const expired = this.take(interactionId);
        if (expired) {
          expired.onExpired?.(expired);
          reject(new Error('Interaction timed out'));
        }
      }, INTERACTION_TIMEOUT_MS);
      timer.unref();

      this.pending.set(interactionId, {
        resolve, reject, type,
        createdAt: Date.now(),
        version: ++this.version,
        timer,
        sessionId: options?.sessionId,
        runId: options?.runId,
        toolCallId: options?.toolCallId,
        invocationId: options?.invocationId,
        userId: options?.userId,
        boundWebSocket: options?.boundWebSocket,
        orgAgentId: options?.orgAgentId,
        questions: options?.questions,
        toolId: options?.toolId,
        toolName: options?.toolName,
        displayName: options?.displayName,
        toolInput: options?.toolInput,
        planContent: options?.planContent,
        onExpired: options?.onExpired,
      });
      this.addToSessionIndex(options?.sessionId, interactionId);
    });
  }

  /** 获取指定交互所属的 sessionId（用于归属校验） */
  getSessionId(interactionId: string): string | undefined {
    return this.pending.get(interactionId)?.sessionId;
  }

  get(interactionId: string): PendingInteraction | undefined {
    return this.pending.get(interactionId);
  }

  resolve(interactionId: string, response: InteractionResponse): boolean {
    const entry = this.take(interactionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.resolve(response);
    return true;
  }

  /** 终止并移除交互，避免遗留 Promise 永久占用旧执行协程。 */
  discard(interactionId: string, reason: string): boolean {
    const entry = this.take(interactionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    return true;
  }

  reject(interactionId: string, reason: string): void {
    const entry = this.take(interactionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }

  /**
   * SSE 断开时调用：拒绝普通 permission_request，
   * 但保留 ask_user 和 plan mode 的 permission_request（等待用户重连）
   */
  rejectOnDisconnect(ids: Set<string>, reason: string): void {
    for (const id of ids) {
      const entry = this.pending.get(id);
      if (!entry) continue;
      if (shouldSurviveDisconnect(entry)) continue;
      clearTimeout(entry.timer);
      this.take(id);
      entry.reject(new Error(reason));
    }
  }

  /** 原有方法保留，供主动停止等场景使用 */
  rejectAll(ids: Set<string>, reason: string): void {
    for (const id of ids) {
      this.reject(id, reason);
    }
  }

  /** O(1) by-session lookup; newest pending interaction is the stable list summary. */
  getActiveInteraction(sessionId: string): { interactionId: string; type: PendingInteraction['type']; version: number; createdAt: number } | undefined {
    const interactionId = this.pendingBySession.get(sessionId)?.[0];
    if (!interactionId) return undefined;
    const entry = this.pending.get(interactionId);
    return entry ? { interactionId, type: entry.type, version: entry.version, createdAt: entry.createdAt } : undefined;
  }

  /**
   * 获取指定会话所有 pending 的可重连交互
   */
  getPendingInteractions(sessionId: string): Array<{
    interactionId: string;
    type: 'ask_user' | 'permission_request';
    runId?: string;
    toolCallId?: string;
    invocationId?: string;
    questions?: AskUserQuestion[];
    toolId?: string;
    toolName?: string;
    displayName?: string;
    toolInput?: Record<string, unknown>;
    planContent?: string;
  }> {
    const result: Array<{
      interactionId: string;
      type: 'ask_user' | 'permission_request';
      runId?: string;
      toolCallId?: string;
      invocationId?: string;
      questions?: AskUserQuestion[];
      toolId?: string;
      toolName?: string;
      displayName?: string;
      toolInput?: Record<string, unknown>;
      planContent?: string;
    }> = [];
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      if (!shouldSurviveDisconnect(entry)) continue;
      result.push({
        interactionId: id,
        type: entry.type,
        runId: entry.runId,
        toolCallId: entry.toolCallId,
        invocationId: entry.invocationId,
        questions: entry.questions,
        toolId: entry.toolId,
        toolName: entry.toolName,
        displayName: entry.displayName,
        toolInput: entry.toolInput,
        planContent: entry.planContent,
      });
    }
    return result;
  }
}

export const interactionStore = new InteractionStore();
