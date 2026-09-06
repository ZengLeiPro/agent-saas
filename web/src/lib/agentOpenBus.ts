/**
 * §5.4 `agent.open`：定制软件请求「把这件事交给 Agent」。
 *
 * 规范三条硬约束：**壳切 Agent 标签、只预填不自动发送、标注「来自《系统名》」**。
 * 「只预填不自动发送」是安全要求 —— 被嵌套的定制项目如果能直接让 Agent 发消息，
 * 等于拿到了用户身份下的任意提示词注入；预填之后由用户自己按发送，人始终在回路里。
 *
 * 为什么用模块级总线而不是把回调层层传下去：AppHost 挂在 `DesktopLayout` 的
 * 惰性区块里，而输入框的 `setInput` 在 `useChatAppState`（行数棘轮余量为 0，
 * 一行都加不了）。总线把两边解耦，AppHost 只管发布意图，布局层订阅后落地。
 * 与 `lib/billingBadgeBus.ts` 同一模式。
 */
import { AGENT_OPEN_PROMPT_MAX_LENGTH } from '@kaiyan/ky-app-contract/browser';

export interface AgentOpenRequest {
  /** 预填进输入框的纯文本（已含「来自《系统名》」标注、已截断）。 */
  text: string;
  /** 发起的安装实例，供审计与调试。 */
  installationId: string;
}

type Listener = (request: AgentOpenRequest) => void;

let pending: AgentOpenRequest | null = null;
const listeners = new Set<Listener>();

/**
 * 请求预填。已有订阅者则立即送达；订阅者还没挂载（例如首屏就停在定制软件标签）
 * 时先留在 pending，等布局层挂载后 `consumePendingAgentOpen()` 取走。
 */
export function requestAgentOpen(request: AgentOpenRequest): void {
  pending = request;
  for (const listener of listeners) {
    try {
      listener(request);
    } catch {
      /* 单个订阅者出错不影响其它订阅者 */
    }
  }
}

export function consumePendingAgentOpen(): AgentOpenRequest | null {
  const value = pending;
  pending = null;
  return value;
}

export function subscribeAgentOpen(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试与登出时清场。 */
export function resetAgentOpenBus(): void {
  pending = null;
  listeners.clear();
}

/** 控制字符会把预填内容伪装成多条消息或塞进不可见指令，一律压成空格。 */
function toPlainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface AgentOpenPayloadLike {
  prompt?: unknown;
  context?: unknown;
}

/**
 * 把 `agent.open` 的 payload 组装成预填文本。
 *
 * 顺序：标注 → 关联对象 → 摘要 → 子端给的 prompt。子端可控的部分合计截断到
 * §5.4 的 500 字；「来自《系统名》」是壳加的标注，不计入子端配额，也**必须**在最前面 ——
 * 截断只砍尾部，标注才不会被子端用超长 prompt 挤掉。
 */
export function buildAgentOpenPrefill(
  payload: AgentOpenPayloadLike | undefined,
  systemName: string,
): string {
  const parts: string[] = [];
  const context = (payload?.context ?? null) as {
    entity?: { type?: unknown; id?: unknown; label?: unknown };
    summary?: unknown;
  } | null;
  const entity = context?.entity;
  if (entity) {
    const type = toPlainText(entity.type);
    const label = toPlainText(entity.label);
    const id = toPlainText(entity.id);
    const head = [type, label].filter(Boolean).join('：');
    const tail = id ? `（${id}）` : '';
    if (head || tail) parts.push(`${head}${tail}`);
  }
  const summary = toPlainText(context?.summary);
  if (summary) parts.push(summary);
  const prompt = toPlainText(payload?.prompt);
  if (prompt) parts.push(prompt);

  const fromApp = parts.join('\n').slice(0, AGENT_OPEN_PROMPT_MAX_LENGTH);
  const annotation = `来自《${systemName}》`;
  return fromApp ? `${annotation}\n${fromApp}` : annotation;
}
