export interface SessionAutomationFeatureFlags {
  controlEnabled: boolean;
  executionEnabled: boolean;
  fixedLoopEnabled: boolean;
  adaptiveLoopEnabled: boolean;
  goalEnabled: boolean;
  evaluatorEnforced: boolean;
}

export type PartialSessionAutomationFeatureFlags = Partial<SessionAutomationFeatureFlags>;

export interface SessionAutomationFlagSource {
  read(): SessionAutomationFeatureFlags;
}

export interface SessionAutomationExecutionFlagSource extends SessionAutomationFlagSource {
  executionEnabled(): boolean;
}

export const DEFAULT_SESSION_AUTOMATION_FLAGS: SessionAutomationFeatureFlags = {
  controlEnabled: false,
  executionEnabled: false,
  fixedLoopEnabled: false,
  adaptiveLoopEnabled: false,
  goalEnabled: false,
  evaluatorEnforced: false,
};

export function resolveSessionAutomationFlags(
  flags: PartialSessionAutomationFeatureFlags | undefined,
): SessionAutomationFeatureFlags {
  return { ...DEFAULT_SESSION_AUTOMATION_FLAGS, ...flags };
}
