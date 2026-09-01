import { useEffect, useState } from 'react';
import type { EffectiveWorkflowDisplayConfig } from '@agent/shared';
import { useAuth } from '@/contexts/AuthContext';
import { authFetch } from '@/lib/authFetch';

export function useWorkflowDisplayConfig(): {
  config: EffectiveWorkflowDisplayConfig | null;
  loading: boolean;
  error: boolean;
} {
  const { user } = useAuth();
  const [state, setState] = useState<{
    config: EffectiveWorkflowDisplayConfig | null;
    loading: boolean;
    error: boolean;
  }>({ config: null, loading: true, error: false });

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setState({ config: null, loading: false, error: true });
      return () => {
        cancelled = true;
      };
    }
    setState({ config: null, loading: true, error: false });
    authFetch('/api/scenarios/display-config')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<EffectiveWorkflowDisplayConfig>;
      })
      .then((config) => {
        if (!cancelled) setState({ config, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ config: null, loading: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.tenantId]);

  return state;
}
