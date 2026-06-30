import type { InteractionResponse } from '../../agent/types.js';
import type { AskUserQuestion } from '../../types/index.js';

export interface PendingInteraction {
  resolve: (response: InteractionResponse) => void;
  reject: (reason: Error) => void;
  type: 'permission_request' | 'ask_user';
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  invocationId?: string;
  /** 创建者的 userId，用于归属校验 */
  userId?: string;
  /** ask_user 专用：存储问题列表 */
  questions?: AskUserQuestion[];
  /** permission_request 专用：存储工具名 */
  toolId?: string;
  toolName?: string;
  displayName?: string;
  toolInput?: Record<string, unknown>;
  /** ExitPlanMode 专用：plan 文件内容 */
  planContent?: string;
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

class InteractionStore {
  private pending = new Map<string, PendingInteraction>();

  create(
    interactionId: string,
    type: PendingInteraction['type'],
    options?: {
      sessionId?: string;
      runId?: string;
      toolCallId?: string;
      invocationId?: string;
      userId?: string;
      questions?: AskUserQuestion[];
      toolId?: string;
      toolName?: string;
      displayName?: string;
      toolInput?: Record<string, unknown>;
      planContent?: string;
    },
  ): Promise<InteractionResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(interactionId)) {
          this.pending.delete(interactionId);
          reject(new Error('Interaction timed out'));
        }
      }, INTERACTION_TIMEOUT_MS);
      timer.unref();

      this.pending.set(interactionId, {
        resolve, reject, type,
        createdAt: Date.now(),
        timer,
        sessionId: options?.sessionId,
        runId: options?.runId,
        toolCallId: options?.toolCallId,
        invocationId: options?.invocationId,
        userId: options?.userId,
        questions: options?.questions,
        toolId: options?.toolId,
        toolName: options?.toolName,
        displayName: options?.displayName,
        toolInput: options?.toolInput,
        planContent: options?.planContent,
      });
    });
  }

  /** 获取指定交互所属的 sessionId（用于归属校验） */
  getSessionId(interactionId: string): string | undefined {
    return this.pending.get(interactionId)?.sessionId;
  }

  /** 获取指定交互的创建者 userId */
  getUserId(interactionId: string): string | undefined {
    return this.pending.get(interactionId)?.userId;
  }

  get(interactionId: string): PendingInteraction | undefined {
    return this.pending.get(interactionId);
  }

  resolve(interactionId: string, response: InteractionResponse): boolean {
    const entry = this.pending.get(interactionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(interactionId);
    entry.resolve(response);
    return true;
  }

  reject(interactionId: string, reason: string): void {
    const entry = this.pending.get(interactionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(interactionId);
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
      this.pending.delete(id);
      entry.reject(new Error(reason));
    }
  }

  /** 原有方法保留，供主动停止等场景使用 */
  rejectAll(ids: Set<string>, reason: string): void {
    for (const id of ids) {
      this.reject(id, reason);
    }
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
