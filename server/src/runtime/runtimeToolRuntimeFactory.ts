import {
  PlatformToolRuntime,
  type PlatformToolRuntimeOptions,
  type ToolRuntime,
} from '../agent/toolRuntime.js';
import type { OrgAgentRuntimePolicy } from '../data/orgAgents/runtimePolicy.js';
import { applyAgentRuntimeProfile, type BoundAgentRuntimeProfile } from './agentProfiles.js';
import { applyOrgAgentExecutionMode } from './dispatcherMode.js';
import {
  applyMemoryConsolidationInvocationPolicy,
  applyToolProfile,
  type MemoryWritePolicyVersion,
  type ToolProfileId,
} from './toolProfiles.js';

export interface RuntimeToolRuntimeFactoryOptions {
  platform: PlatformToolRuntimeOptions;
  toolProfile?: ToolProfileId;
  memoryPolicyVersion?: MemoryWritePolicyVersion;
  boundProfile?: BoundAgentRuntimeProfile;
  executionMode?: OrgAgentRuntimePolicy['executionMode'];
  dispatcherCompletion?: boolean;
  replaySourceSessionId?: string;
}

export function createRuntimeToolRuntime(options: RuntimeToolRuntimeFactoryOptions): ToolRuntime {
  const profiled = applyToolProfile(
    new PlatformToolRuntime(options.platform),
    options.toolProfile,
    options.memoryPolicyVersion,
  );
  const agentProfiled = options.boundProfile
    ? applyAgentRuntimeProfile(profiled, options.boundProfile)
    : profiled;
  return applyMemoryConsolidationInvocationPolicy(
    applyOrgAgentExecutionMode(agentProfiled, options.executionMode, options.dispatcherCompletion === true),
    options.replaySourceSessionId,
  );
}
