import type { ChatSessionIndexItem } from "./sidebar";

/** Session group */
export interface SessionGroup {
  groupKey: string;
  name: string;
  kind: "cron" | "manual";
  children: ChatSessionIndexItem[];
  latestUpdatedAt: number;
  count: number;
  /** 任一子会话仍在运行时，文件夹同步展示运行态。 */
  isRunning: boolean;
}

/** Session list entry: session or group */
export type SessionListEntry =
  | { type: "session"; session: ChatSessionIndexItem }
  | { type: "group"; group: SessionGroup };
