/**
 * Web thin boundary for M20-06. Selection/session reuse policy is authoritative in Shared;
 * this module intentionally contains no Web-specific fallback or personal-target inference.
 */
export {
  resolveNewSessionAgentTarget,
  resolveTargetSessionAction,
} from '@agent/shared';
export type {
  AgentTarget,
  AgentTargetCatalog,
  AgentTargetSelection,
} from '@agent/shared';
