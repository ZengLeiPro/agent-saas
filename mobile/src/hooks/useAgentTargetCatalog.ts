import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentTarget,
  AgentTargetCatalog,
  AgentTargetUnavailableReason,
  OrgAgentSummary,
} from '@agent/shared';
import { adaptAgentTargetCatalogResponse, authFetch } from '@agent/shared';

export interface AgentTargetCatalogUser {
  id: string;
  tenantId: string;
}

/**
 * Agent 目录（`/api/org-agents/mine`）与挂起的新会话 Agent 目标
 * （从 useChatAppStateCore 按域拆出，逻辑原样）。
 */
export function useAgentTargetCatalog(user: AgentTargetCatalogUser | null | undefined) {
  const [agentTargetCatalog, setAgentTargetCatalog] =
    useState<AgentTargetCatalog<OrgAgentSummary> | null>(null);
  const [agentTargetCatalogReason, setAgentTargetCatalogReason] =
    useState<AgentTargetUnavailableReason | null>(null);
  const [agentTargetCatalogLoading, setAgentTargetCatalogLoading] = useState(true);
  const agentTargetCatalogOwnerKey = user ? `${user.tenantId}:${user.id}` : 'anonymous';
  const agentTargetCatalogOwnerKeyRef = useRef(agentTargetCatalogOwnerKey);
  agentTargetCatalogOwnerKeyRef.current = agentTargetCatalogOwnerKey;
  const [pendingAgentTarget, setPendingAgentTargetState] = useState<AgentTarget | null>(null);
  const pendingAgentTargetRef = useRef<AgentTarget | null>(null);
  const setPendingAgentTarget = useCallback((target: AgentTarget | null) => {
    pendingAgentTargetRef.current = target;
    setPendingAgentTargetState(target);
  }, []);

  const refreshAgentTargetCatalog = useCallback(async () => {
    const requestOwnerKey = agentTargetCatalogOwnerKey;
    if (!user) {
      setAgentTargetCatalog(null);
      setAgentTargetCatalogReason(null);
      setAgentTargetCatalogLoading(false);
      return;
    }
    setAgentTargetCatalogLoading(true);
    try {
      const response = await authFetch('/api/org-agents/mine');
      if (!response.ok) throw new Error('target_catalog_unavailable');
      const adapted = adaptAgentTargetCatalogResponse<OrgAgentSummary>(
        await response.json(),
        user.tenantId,
      );
      if (agentTargetCatalogOwnerKeyRef.current !== requestOwnerKey) return;
      if (adapted.kind === 'catalog') {
        setAgentTargetCatalog(adapted.catalog);
        setAgentTargetCatalogReason(null);
      } else {
        setAgentTargetCatalog(null);
        setAgentTargetCatalogReason(adapted.reason);
      }
    } catch {
      if (agentTargetCatalogOwnerKeyRef.current !== requestOwnerKey) return;
      setAgentTargetCatalog(null);
      setAgentTargetCatalogReason({
        code: 'target_catalog_unavailable',
        message: 'Agent 目录加载失败，暂时无法发送。',
        contactAdmin: true,
      });
    } finally {
      if (agentTargetCatalogOwnerKeyRef.current === requestOwnerKey)
        setAgentTargetCatalogLoading(false);
    }
  }, [agentTargetCatalogOwnerKey, user]);

  useEffect(() => {
    setPendingAgentTarget(null);
    void refreshAgentTargetCatalog();
  }, [refreshAgentTargetCatalog, setPendingAgentTarget]);

  return {
    agentTargetCatalog,
    agentTargetCatalogReason,
    agentTargetCatalogLoading,
    refreshAgentTargetCatalog,
    pendingAgentTarget,
    pendingAgentTargetRef,
    setPendingAgentTarget,
  };
}
