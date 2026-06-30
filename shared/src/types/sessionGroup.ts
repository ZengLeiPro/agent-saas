import type { ChatSessionIndexItem } from "./sidebar";

/** Session group */
export interface SessionGroup {
  groupKey: string;
  name: string;
  kind: "cron" | "manual";
  children: ChatSessionIndexItem[];
  latestUpdatedAt: number;
  count: number;
}

/** Session list entry: session or group */
export type SessionListEntry =
  | { type: "session"; session: ChatSessionIndexItem }
  | { type: "group"; group: SessionGroup };
