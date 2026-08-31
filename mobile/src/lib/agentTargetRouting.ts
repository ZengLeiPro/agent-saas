/** Mobile transport/UI boundary for M30-03. Shared owns every transition and confirmation rule. */
export {
  createAgentTargetTransition,
  evaluateAgentTargetTransition,
  reduceAgentTargetTransition,
  resolveNewSessionAgentTarget,
  resolveTargetSessionAction,
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
