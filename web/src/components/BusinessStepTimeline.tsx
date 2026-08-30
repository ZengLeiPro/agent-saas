import type { ReactNode } from "react";
import type { RenderItem } from "./types";

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
  return result;
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
