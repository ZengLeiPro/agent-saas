/** M20-06 tenant-scoped Agent target catalog; legacy presentations are never selectable. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adaptAgentTargetCatalogResponse } from '@agent/shared';
import type {
  AgentTargetCatalog,
  AgentTargetUnavailableReason,
  OrgAgentSummary,
} from '@agent/shared';
import { useAuth } from '@/contexts/AuthContext';
import { authFetch } from '@/lib/authFetch';
import { registerRefresh, unregisterRefresh } from '@/lib/refreshBus';

export function useOrgAgents() {
  const { user } = useAuth();
  const ownerKey = user ? `${user.tenantId}:${user.id}` : 'anonymous';
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const [catalog, setCatalog] = useState<AgentTargetCatalog<OrgAgentSummary> | null>(null);
  const [compatibilityReason, setCompatibilityReason] = useState<AgentTargetUnavailableReason | null>(null);
  const [legacyAgents, setLegacyAgents] = useState<OrgAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const requestOwnerKey = ownerKey;
    try {
      if (!user) return;
      const res = await authFetch('/api/org-agents/mine');
      if (!res.ok) throw new Error('target_catalog_unavailable');
      const adapted = adaptAgentTargetCatalogResponse<OrgAgentSummary>(await res.json(), user.tenantId);
      if (ownerKeyRef.current !== requestOwnerKey) return;
      if (adapted.kind === 'catalog') {
        setCatalog(adapted.catalog);
        setLegacyAgents([]);
        setCompatibilityReason(null);
      } else {
        setCatalog(null);
        setLegacyAgents(adapted.kind === 'legacy-unproven' ? adapted.presentations : []);
        setCompatibilityReason(adapted.reason);
      }
    } catch {
      if (ownerKeyRef.current !== requestOwnerKey) return;
      setCatalog(null);
      setLegacyAgents([]);
      setCompatibilityReason({
        code: 'target_catalog_unavailable',
        message: 'Agent 目录加载失败，暂时无法新建或继续发送，请稍后重试。',
        contactAdmin: true,
      });
    } finally {
      if (ownerKeyRef.current === requestOwnerKey) setLoading(false);
    }
  }, [ownerKey, user]);

  useEffect(() => {
    setCatalog(null);
    setLegacyAgents([]);
    setCompatibilityReason(null);
    setLoading(true);
    void refresh();
  }, [ownerKey, refresh]);

  useEffect(() => {
    registerRefresh('org-agents-mine', refresh);
    return () => unregisterRefresh('org-agents-mine');
  }, [refresh]);

  const agents = useMemo(() => catalog
    ? catalog.orgAgents
      .filter(option => option.availability.status === 'available' && option.presentation)
      .map(option => option.presentation!)
    : [], [catalog]);

  return { agents, legacyAgents, catalog, compatibilityReason, loading, refresh };
}
