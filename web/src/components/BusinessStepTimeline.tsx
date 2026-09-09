import type { ReactNode } from "react";
import type { RenderItem } from "./types";
import { anchorBusinessStepPlans } from "./anchorBusinessStepPlans";

function mainConversationItems(items: RenderItem[]): RenderItem[] {
  const interactions: RenderItem[] = [];
  for (const item of items) {
    if (
      item.type === "permission_request"
      || item.type === "ask_user"
      || (item.type === "user" && item.status === "queued")
    ) {
      interactions.push(item);
    }
  }
  return interactions;
}

/**
 * 主对话区域只保留每个 Run 的最新计划卡、真实人工门禁与排队中的用户插话。
 * start/terminal/section 数据仍留在完整投影中供详情目录使用，但不再打印第二套步骤正文。
 * 同 Run 插话后，计划卡整体跟随到用户消息下方，原始过程归属与详情选择不变。
 */
export function businessStepMainItems(items: RenderItem[]): RenderItem[] {
  const result: RenderItem[] = [];
  for (const item of items) {
    if (item.type === "business_step") {
      if (item.kind === "plan") result.push(item);
      continue;
    }
    if (item.type === "business_step_section") {
      result.push(...mainConversationItems(item.items));
      continue;
    }
    result.push(item);
  }
  return anchorBusinessStepPlans(items, result);
}

export function BusinessStepTimeline({
  items,
  renderItem,
}: {
  items: RenderItem[];
  renderItem: (item: RenderItem) => ReactNode;
}) {
  return businessStepMainItems(items).map((item) => renderItem(item));
}
