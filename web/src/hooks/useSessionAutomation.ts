import { createElement, lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import type { UploadedFile } from '@/components/types';
import type { AutomationControlRequest } from '@/lib/sessionAutomation';
import type { SessionAutomationActions, SessionAutomationViewState } from './SessionAutomationController';

const SessionAutomationController = lazy(() => import('./SessionAutomationController'));

interface UseSessionAutomationOptions {
  sessionId: string | null;
  onSessionCommitted?: (sessionId: string) => void;
  onNotification?: (notification: { key: string; text: string; priority: 'low' | 'medium' | 'high' | 'immediate'; color?: string; timeoutMs?: number }) => void;
}

const initialState: SessionAutomationViewState = {
  snapshot: null,
  timeline: [],
  loading: false,
  commandPending: false,
  controlPending: false,
  error: null,
};

/**
 * Lightweight startup facade. The WS/API automation control plane is mounted through
 * a lazy, renderless controller so normal chat startup does not pay for TASK-338 logic.
 */
export function useSessionAutomation(options: UseSessionAutomationOptions) {
  const [state, setState] = useState<SessionAutomationViewState>(initialState);
  const actionsRef = useRef<SessionAutomationActions | null>(null);
  const waitersRef = useRef<Array<(actions: SessionAutomationActions) => void>>([]);

  const handleReady = useCallback((actions: SessionAutomationActions) => {
    actionsRef.current = actions;
    for (const resolve of waitersRef.current.splice(0)) resolve(actions);
  }, []);

  const waitForActions = useCallback((): Promise<SessionAutomationActions> => {
    if (actionsRef.current) return Promise.resolve(actionsRef.current);
    return new Promise((resolve) => waitersRef.current.push(resolve));
  }, []);

  const refresh = useCallback(async (sessionId?: string | null) => {
    const actions = await waitForActions();
    await actions.refresh(sessionId);
  }, [waitForActions]);

  const submitCommand = useCallback(async (rawCommand: string, attachments: UploadedFile[]) => {
    const actions = await waitForActions();
    return actions.submitCommand(rawCommand, attachments);
  }, [waitForActions]);

  const control = useCallback(async (request: AutomationControlRequest) => {
    const actions = await waitForActions();
    await actions.control(request);
  }, [waitForActions]);

  const controllerNode = useMemo(() => createElement(
    Suspense,
    { fallback: null },
    createElement(SessionAutomationController, {
      ...options,
      onStateChange: setState,
      onReady: handleReady,
    }),
  ), [handleReady, options.onNotification, options.onSessionCommitted, options.sessionId]);

  return {
    ...state,
    refresh,
    submitCommand,
    control,
    controllerNode,
  };
}
