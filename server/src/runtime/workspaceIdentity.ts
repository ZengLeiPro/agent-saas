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

export type ParsedWorkspacePrincipal =
  | { kind: 'user'; tenantId: string; principalId: string; userId: string }
  | { kind: 'org_agent'; tenantId: string; principalId: string; agentSegment: string }
  | { kind: 'org_agent_connector'; tenantId: string; principalId: string; connectorSegment: string };

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

export function deriveAgentWorkspaceId(tenantId: string, agentId: string): string {
  if (!TENANT_SLUG_PATTERN.test(tenantId)) throw new Error('Invalid Agent workspace tenant');
  return `ws_${tenantId}__agent_${safeUserIdSegment(agentId)}`;
}

export function deriveAgentConnectorWorkspaceId(
  tenantId: string,
  agentId: string,
  connectorId: string,
): string {
  if (!TENANT_SLUG_PATTERN.test(tenantId)) throw new Error('Invalid Agent connector workspace tenant');
  return `ws_${tenantId}__agent_connector_${safeUserIdSegment(agentId)}_${safeUserIdSegment(connectorId)}`;
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
  if (userId.startsWith("agent_")) return null;
  if (!USER_ID_SEGMENT_PATTERN.test(userId)) return null;
  if (userId.includes("..") || userId.startsWith(".")) return null;
  return { tenantId, userId };
}

export function parseWorkspacePrincipal(workspaceId: string | undefined | null): ParsedWorkspacePrincipal | null {
  const user = parseWorkspaceId(workspaceId);
  if (user) return { kind: 'user', tenantId: user.tenantId, principalId: user.userId, userId: user.userId };
  if (!workspaceId?.startsWith('ws_')) return null;
  const body = workspaceId.slice(3);
  const delimiter = body.indexOf('__');
  if (delimiter <= 0) return null;
  const tenantId = body.slice(0, delimiter);
  const segment = body.slice(delimiter + 2).split('__', 1)[0] ?? '';
  if (!TENANT_SLUG_PATTERN.test(tenantId)) return null;
  if (segment.startsWith('agent_connector_')) {
    const connectorSegment = segment.slice('agent_connector_'.length);
    if (!USER_ID_SEGMENT_PATTERN.test(connectorSegment)) return null;
    return { kind: 'org_agent_connector', tenantId, principalId: connectorSegment, connectorSegment };
  }
  if (!segment.startsWith('agent_')) return null;
  const agentSegment = segment.slice('agent_'.length);
  if (!USER_ID_SEGMENT_PATTERN.test(agentSegment) || agentSegment.includes('..') || agentSegment.startsWith('.')) return null;
  return { kind: 'org_agent', tenantId, principalId: agentSegment, agentSegment };
}
