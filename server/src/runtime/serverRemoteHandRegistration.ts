import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { ServerRemoteDispatchConfig } from './rawRuntimeRunDispatchTypes.js';

export function serverRemoteHandRegistrationOptions(
  config: ServerRemoteDispatchConfig | undefined,
  executionTarget: ExecutionTargetKind,
) {
  return {
    endpoint: executionTarget === 'server-remote' ? config?.baseUrl : undefined,
    serverRemoteAuthTokenRef:
      executionTarget === 'server-remote' ? config?.authTokenRef : undefined,
    serverRemoteRecipe: config?.recipe,
  };
}
