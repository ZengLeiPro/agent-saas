import {
  foldPanel,
  isBusinessTodo,
  parseTodos,
  todoItemKey,
  type MessageItem,
  type PanelPulse,
  type SystemPanelSnapshot,
} from "@agent/shared";

type FoldedPanelMessages = {
  snapshot: SystemPanelSnapshot | null;
  pulse: PanelPulse | null;
};

function currentBusinessStepKey(message: MessageItem): string | null | undefined {
  if (message.type !== "tool_use" || message.toolName !== "TodoWrite") return undefined;
  const todos = parseTodos(message.toolInput);
  if (!todos) return todos;
  const businessTodos = todos.filter(isBusinessTodo);
  const current = businessTodos.find((todo) => todo.status === "in_progress")
    ?? [...businessTodos].reverse().find((todo) => todo.status !== "pending");
  return current ? todoItemKey(current) : null;
}

/**
 * 从真实消息流 fold 面板，并把瞬时 delta 绑定到现有业务步骤边界。
 * TodoWrite 只提供边界，不复制面板状态；用户新输入、run 切换、下一业务步骤或空 patch
 * 组都会清除旧 pulse，同一步终态 TodoWrite 与最终短回复则保留本步变化。
 */
export function foldSystemPanelMessages(messages: MessageItem[]): FoldedPanelMessages {
  let snapshot: SystemPanelSnapshot | null = null;
  let pulse: PanelPulse | null = null;
  let currentStep: string | null = null;
  let pulseRunId: string | undefined;

  for (const message of messages) {
    if (message.type === "user") {
      pulse = null;
      pulseRunId = undefined;
      currentStep = null;
      continue;
    }

    const messageRunId = "runId" in message ? message.runId : undefined;
    if (pulse && pulseRunId && messageRunId && messageRunId !== pulseRunId) {
      pulse = null;
      pulseRunId = undefined;
    }

    const nextStep = currentBusinessStepKey(message);
    if (nextStep !== undefined) {
      if (pulse && (nextStep === null || nextStep !== currentStep)) {
        pulse = null;
        pulseRunId = undefined;
      }
      currentStep = nextStep;
    }

    if (message.type !== "tool_use" && message.type !== "tool_result") continue;
    const presentation = message.presentation;
    if (!presentation) continue;
    if (!snapshot && presentation.panelBase) snapshot = presentation.panelBase;
    if (presentation.panel !== undefined) {
      if (snapshot) snapshot = foldPanel(snapshot, presentation.panel);
      const pulses = presentation.panel.filter((patch): patch is PanelPulse => patch.op === "pulse");
      pulse = pulses.at(-1) ?? null;
      pulseRunId = pulse ? messageRunId : undefined;
    }
  }

  return { snapshot, pulse };
}
