import type { MessageItem } from "@/components/types";

export function hasSuccessfulFinalOutput(messages: readonly MessageItem[]): boolean {
  return messages.some((message) => message.type === "text" && message.finalOutput === true);
}
