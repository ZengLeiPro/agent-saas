/**
 * Web thin boundary for M20-06. Selection/session reuse policy is authoritative in Shared;
 * this module intentionally contains no Web-specific fallback or personal-target inference.
 */
export {
  resolveNewSessionAgentTarget,
  resolveTargetSessionAction,
  createAgentTargetTransition,
  evaluateAgentTargetTransition,
  reduceAgentTargetTransition,
} from '@agent/shared';
export type {
  AgentTarget,
  AgentTargetCatalog,
  AgentTargetSelection,
  AgentTargetTransitionDecision,
  AgentTargetTransitionEvent,
  AgentTargetTransitionInput,
  AgentTargetTransitionState,
} from '@agent/shared';
