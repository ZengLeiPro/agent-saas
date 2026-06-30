import { authFetch } from "./authFetch";
import type { ApiSessionListItem } from "../types/session";

export interface ApiSessionGroup {
  id: string;
  userId: string;
  name: string;
  kind: "manual" | "cron";
  cronJobId?: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export async function fetchGroups(): Promise<ApiSessionGroup[]> {
  const res = await authFetch(`/api/groups`);
  if (!res.ok) return [];
  const data = (await res.json()) as { groups?: ApiSessionGroup[] };
  return data.groups ?? [];
}

export async function createGroup(
  name: string,
  sessionIds?: string[],
): Promise<ApiSessionGroup | null> {
  const res = await authFetch("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      ...(sessionIds?.length ? { sessionIds } : {}),
    }),
  });
  if (!res.ok) return null;
  return (await res.json()) as ApiSessionGroup;
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
  });
  return res.ok;
}

export async function updateGroup(
  groupId: string,
  patch: { name?: string },
): Promise<ApiSessionGroup | null> {
  const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  return (await res.json()) as ApiSessionGroup;
}

export async function addSessionsToGroup(
  groupId: string,
  sessionIds: string[],
): Promise<ApiSessionGroup | null> {
  const res = await authFetch(
    `/api/groups/${encodeURIComponent(groupId)}/sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds }),
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { group?: ApiSessionGroup };
  return data.group ?? null;
}

export async function removeSessionsFromGroup(
  groupId: string,
  sessionIds: string[],
): Promise<ApiSessionGroup | null> {
  const res = await authFetch(
    `/api/groups/${encodeURIComponent(groupId)}/sessions`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds }),
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { group?: ApiSessionGroup };
  return data.group ?? null;
}

export async function fetchGroupSessions(
  groupId: string,
): Promise<ApiSessionListItem[]> {
  const res = await authFetch(
    `/api/groups/${encodeURIComponent(groupId)}/sessions`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { sessions?: ApiSessionListItem[] };
  return data.sessions ?? [];
}

// ── Group sorting preference ────────────────────────────────

export type GroupSortingMode = "recent" | "custom";

export interface GroupSortingPref {
  mode: GroupSortingMode;
  order: string[];
}

export async function fetchGroupSorting(): Promise<GroupSortingPref> {
  const res = await authFetch("/api/groups-sorting");
  if (!res.ok) return { mode: "recent", order: [] };
  return (await res.json()) as GroupSortingPref;
}

export async function saveGroupSorting(
  pref: GroupSortingPref,
): Promise<GroupSortingPref | null> {
  const res = await authFetch("/api/groups-sorting", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pref),
  });
  if (!res.ok) return null;
  return (await res.json()) as GroupSortingPref;
}
