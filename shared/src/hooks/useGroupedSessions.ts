import { useMemo } from "react";
import type { ChatSessionIndexItem } from "../types/sidebar";
import type { SessionListEntry } from "../types/sessionGroup";
import type { ApiSessionGroup } from "../lib/groupsApi";

export function useGroupedSessions(
  sessions: ChatSessionIndexItem[],
  searchQuery: string,
  groups: ApiSessionGroup[],
): SessionListEntry[] {
  return useMemo(() => {
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return sessions
        .filter((s) => s.title.toLowerCase().includes(q))
        .map((s): SessionListEntry => ({ type: "session", session: s }));
    }

    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    const consumed = new Set<string>();
    const entries: SessionListEntry[] = [];

    for (const group of groups) {
      const children = group.sessionIds
        .map((sid) => sessionMap.get(sid))
        .filter((s): s is ChatSessionIndexItem => s !== undefined);

      if (children.length === 0) continue;

      children.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const c of children) consumed.add(c.id);

      entries.push({
        type: "group",
        group: {
          groupKey: group.id,
          name: group.name,
          kind: group.kind,
          children,
          latestUpdatedAt: children[0].updatedAt,
          count: children.length,
        },
      });
    }

    for (const s of sessions) {
      if (!consumed.has(s.id)) {
        entries.push({ type: "session", session: s });
      }
    }

    entries.sort((a, b) => {
      const timeA = a.type === "session" ? a.session.updatedAt : a.group.latestUpdatedAt;
      const timeB = b.type === "session" ? b.session.updatedAt : b.group.latestUpdatedAt;
      return timeB - timeA;
    });

    return entries;
  }, [sessions, searchQuery, groups]);
}
