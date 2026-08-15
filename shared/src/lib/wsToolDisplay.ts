/**
 * 拥有独立卡片的工具：交互工具走 ask_user / permission_request，Agent 走
 * subagent_start / subagent_end。它们不该再走通用 tool_use / tool_result 通道。
 * 此常量是旧 buffer / 跨版本重连的前端兜底，与后端 displayFilter 保持一致。
 */
const DEDICATED_TOOL_NAMES = new Set<string>([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Agent",
]);

export function isDedicatedToolName(toolName: string | undefined | null): boolean {
  return !!toolName && DEDICATED_TOOL_NAMES.has(toolName);
}

/** Plan mode tool display mapping */
const PLAN_MODE_DISPLAY: Record<string, { name: string; description: string }> = {
  EnterPlanMode: {
    name: "进入规划模式",
    description: "Agent 请求进入规划模式，将在只读模式下探索代码库并设计实现方案。",
  },
  ExitPlanMode: {
    name: "规划方案审批",
    description: "Agent 已完成方案规划，请审阅上方的规划内容后决定是否批准执行。",
  },
};

export function resolvePlanModeDisplay(
  toolName: string,
  fallbackInput: string,
  planContent?: string,
  displayName?: string,
): { name: string; description: string } {
  const mapped = PLAN_MODE_DISPLAY[toolName];
  if (mapped) {
    const description = (toolName === "ExitPlanMode" && planContent) ? planContent : mapped.description;
    return { name: mapped.name, description };
  }
  return { name: displayName || toolName, description: fallbackInput };
}

export function formatPermissionInput(toolInput?: Record<string, unknown>): string {
  if (!toolInput) return "";
  return JSON.stringify(toolInput, null, 2);
}
