import { useEffect } from 'react';
import { useSessionAutomationRuntime } from './useSessionAutomationRuntime';
import type { UploadedFile } from '@/components/types';
import type { AutomationControlRequest, AutomationTimelineEvent, SessionAutomationSnapshot } from '@/lib/sessionAutomation';

export interface SessionAutomationViewState {
  snapshot: SessionAutomationSnapshot | null;
  timeline: AutomationTimelineEvent[];
  loading: boolean;
  commandPending: boolean;
  controlPending: boolean;
  error: string | null;
}

export interface SessionAutomationActions {
  refresh: (sessionId?: string | null) => Promise<void>;
  submitCommand: (rawCommand: string, attachments: UploadedFile[]) => Promise<unknown>;
  control: (request: AutomationControlRequest) => Promise<void>;
}

interface SessionAutomationControllerProps {
  sessionId: string | null;
  onSessionCommitted?: (sessionId: string) => void;
  onNotification?: (notification: { key: string; text: string; priority: 'low' | 'medium' | 'high' | 'immediate'; color?: string; timeoutMs?: number }) => void;
  onStateChange: (state: SessionAutomationViewState) => void;
  onReady: (actions: SessionAutomationActions) => void;
}

export default function SessionAutomationController({ onStateChange, onReady, ...options }: SessionAutomationControllerProps) {
  const automation = useSessionAutomationRuntime(options);

  useEffect(() => {
    onStateChange({
      snapshot: automation.snapshot,
      timeline: automation.timeline,
      loading: automation.loading,
      commandPending: automation.commandPending,
      controlPending: automation.controlPending,
      error: automation.error,
    });
  }, [automation.commandPending, automation.controlPending, automation.error, automation.loading, automation.snapshot, automation.timeline, onStateChange]);

  useEffect(() => {
    onReady({
      refresh: automation.refresh,
      submitCommand: automation.submitCommand,
      control: automation.control,
    });
  }, [automation.control, automation.refresh, automation.submitCommand, onReady]);

  return null;
}
