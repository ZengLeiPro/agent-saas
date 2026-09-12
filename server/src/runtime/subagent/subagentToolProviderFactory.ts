import type { ToolProvider } from '../../agent/toolRuntime.js';
import type { ExecutionTransportRegistry } from '../executionTransport.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { TenantRemoteHandAuthTokenResolver } from '../tenantRemoteHandResolver.js';
import { AgentToolProvider } from './agentToolProvider.js';
import type { SubagentModelPolicy } from './subagentExecutionOptions.js';

export interface SubagentToolingDeps {
  executionTransportRegistry: ExecutionTransportRegistry;
  tenantHandResolver: TenantRemoteHandAuthTokenResolver;
  agentModePolicy?: 'any' | 'background_only';
  inheritedModelRef?: string;
  workerModel?: SubagentModelPolicy;
}

export async function createSubagentToolProvider(
  config: RawRuntimeRunDispatchConfig,
  deps: SubagentToolingDeps,
  parentProviders: ToolProvider[],
): Promise<AgentToolProvider> {
  const profileModels: Partial<Record<'general' | 'explore', SubagentModelPolicy>> = {};
  if (config.agentRuntimeProfileResolver) {
    const [general, explore] = await Promise.all([
      config.agentRuntimeProfileResolver.resolveForSession({
        existingSession: null,
        bindingKey: 'subagent_general',
      }),
      config.agentRuntimeProfileResolver.resolveForSession({
        existingSession: null,
        bindingKey: 'subagent_explore',
      }),
    ]);
    profileModels.general = general.version.config.model;
    profileModels.explore = explore.version.config.model;
  }
  return new AgentToolProvider({
    config,
    executionTransportRegistry: deps.executionTransportRegistry,
    tenantHandResolver: deps.tenantHandResolver,
    parentProviders,
    modePolicy: deps.agentModePolicy ?? 'any',
    inheritedModelRef: deps.inheritedModelRef,
    workerModel: deps.workerModel,
    profileModels,
  });
}
