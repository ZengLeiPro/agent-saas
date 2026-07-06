import { createHash } from "node:crypto";

import { DEFAULT_TENANT_ID, TENANT_SLUG_PATTERN } from "../data/tenants/types.js";

const USER_ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export interface StableWorkspaceUser {
  id?: string;
  tenantId?: string;
}

export interface ParsedWorkspaceId {
  tenantId: string;
  userId: string;
}

export function deriveStableWorkspaceId(
  user: StableWorkspaceUser | undefined,
  fallbackWorkspaceId: string,
): string {
  if (!user?.id) return fallbackWorkspaceId;
  const tenantId = user.tenantId && TENANT_SLUG_PATTERN.test(user.tenantId)
    ? user.tenantId
    : DEFAULT_TENANT_ID;
  return `ws_${tenantId}__${safeUserIdSegment(user.id)}`;
}

function safeUserIdSegment(userId: string): string {
  if (
    USER_ID_SEGMENT_PATTERN.test(userId)
    && !userId.includes("..")
    && !userId.startsWith(".")
  ) {
    return userId;
  }
  const digest = createHash("sha256").update(userId).digest("base64url").slice(0, 16);
  return `h${digest}`;
}

export function parseWorkspaceId(workspaceId: string | undefined | null): ParsedWorkspaceId | null {
  if (!workspaceId?.startsWith("ws_")) return null;
  const body = workspaceId.slice(3);
  const delimiter = body.indexOf("__");
  if (delimiter <= 0) return null;

  const tenantId = body.slice(0, delimiter);
  const rest = body.slice(delimiter + 2);
  const mountDelimiter = rest.indexOf("__");
  const userId = mountDelimiter >= 0 ? rest.slice(0, mountDelimiter) : rest;

  if (!TENANT_SLUG_PATTERN.test(tenantId)) return null;
  if (!USER_ID_SEGMENT_PATTERN.test(userId)) return null;
  if (userId.includes("..") || userId.startsWith(".")) return null;
  return { tenantId, userId };
}
