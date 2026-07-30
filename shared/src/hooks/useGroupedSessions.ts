import { useMemo } from "react";
import type { ChatSessionIndexItem } from "../types/sidebar";
import type { SessionListEntry } from "../types/sessionGroup";
import type { ApiSessionGroup } from "../lib/groupsApi";

function compareSessionActivity(a: ChatSessionIndexItem, b: ChatSessionIndexItem): number {
  if (Boolean(a.isRunning) !== Boolean(b.isRunning)) return a.isRunning ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

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
        .sort(compareSessionActivity)
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

      children.sort(compareSessionActivity);
      for (const c of children) consumed.add(c.id);

      entries.push({
        type: "group",
        group: {
          groupKey: group.id,
          name: group.name,
          kind: group.kind,
          children,
          latestUpdatedAt: Math.max(...children.map((child) => child.updatedAt)),
          count: children.length,
          isRunning: children.some((child) => child.isRunning),
        },
      });
    }

    for (const s of sessions) {
      if (!consumed.has(s.id)) {
        entries.push({ type: "session", session: s });
      }
    }

    entries.sort((a, b) => {
      const runningA = a.type === "session" ? Boolean(a.session.isRunning) : a.group.isRunning;
      const runningB = b.type === "session" ? Boolean(b.session.isRunning) : b.group.isRunning;
      if (runningA !== runningB) return runningA ? -1 : 1;
      const timeA = a.type === "session" ? a.session.updatedAt : a.group.latestUpdatedAt;
      const timeB = b.type === "session" ? b.session.updatedAt : b.group.latestUpdatedAt;
      return timeB - timeA;
    });

    return entries;
  }, [sessions, searchQuery, groups]);
}
