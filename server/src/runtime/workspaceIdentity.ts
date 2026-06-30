import { createHash } from "node:crypto";

import { DEFAULT_TENANT_ID, TENANT_SLUG_PATTERN } from "../data/tenants/types.js";

const USER_ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export interface StableWorkspaceUser {
  id?: string;
  tenantId?: string;
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
