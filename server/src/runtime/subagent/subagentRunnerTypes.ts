import type { SdkResultModelUsage } from '../../agent/types.js';
import type { ToolCallContext, ToolProvider } from '../../agent/toolRuntime.js';
import type { RuntimeFailureKind, RuntimeRecoveryAction } from '../../types/index.js';
import type { OrgAgentEffectiveExecutionContext } from '../background/orgAgentExecutionContext.js';
import type { ExecutionTransportRegistry } from '../executionTransport.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { RuntimeSessionRecord } from '../sessionCatalog.js';
import type { TenantRemoteHandAuthTokenResolver } from '../tenantRemoteHandResolver.js';
import type { SubagentTypeDefinition } from './agentTypes.js';
import type { SubagentLimiter } from './subagentLimits.js';

export type SubagentStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface SubagentOutcome {
  status: SubagentStatus;
  text: string;
  errorMessage?: string;
  failureKind?: RuntimeFailureKind;
  recoveryAction?: RuntimeRecoveryAction;
  totalTokens: number;
  toolUseCount: number;
  turnCount: number;
  durationMs: number;
  childSessionId: string;
  childRunId: string;
  model: string;
  modelRef?: string;
  effort?: string;
  requestedModelRef?: string;
  requestedEffort?: string;
  modelSource?: string;
  effortSource?: string;
  agentId?: string;
  modelUsage?: Record<string, SdkResultModelUsage>;
}

export interface RunSubagentParams {
  config: RawRuntimeRunDispatchConfig;
  executionTransportRegistry: ExecutionTransportRegistry;
  tenantHandResolver: TenantRemoteHandAuthTokenResolver;
  parentProviders: ToolProvider[];
  parentContext: ToolCallContext;
  agentType: SubagentTypeDefinition;
  profileSourceSession?: RuntimeSessionRecord;
  orgAgentExecutionContext?: OrgAgentEffectiveExecutionContext;
  request: {
    description: string;
    prompt: string;
    model?: string;
    effort?: string;
    mode?: 'foreground' | 'background';
    agentId?: string;
    continuation?: { previousRunId?: string; previousSessionId?: string; sequence?: number };
    includeCompanyInfo: boolean;
  };
  limiter?: SubagentLimiter;
  hardTimeoutMs?: number;
  modelAdapterFactory?: (
    connection: { apiKey?: string; baseUrl?: string },
    providerOptions?: import('../../types/index.js').ModelProviderOptions,
  ) => import('../types.js').ModelAdapter;
  preparedChildIdentity?: { childSessionId: string; childRunId: string };
  continuationChildSessionId?: string;
  acquireChildLaunchAuthority?: (identity: {
    childSessionId: string;
    childRunId: string;
  }) => Promise<void> | void;
  beforeChildSideEffects?: (identity: {
    childSessionId: string;
    childRunId: string;
  }) => Promise<void> | void;
  onChildLaunchError?: (identity: {
    childSessionId: string;
    childRunId: string;
  }) => Promise<void> | void;
  beforeTenantRemoteProvision?: (identity: {
    childSessionId: string;
    childRunId: string;
  }) => Promise<void> | void;
  lifecycleCheckpoint?: (
    checkpoint: 'prepared' | 'session' | 'run' | 'lease' | 'hand' | 'before_active',
  ) => Promise<void> | void;
  onChildRunCreated?: (info: {
    childSessionId: string;
    childRunId: string;
    model: string;
    modelRef?: string;
    effort?: string;
    agentId?: string;
  }) => Promise<void> | void;
  loadDeferredMessages?: (identity: {
    childSessionId: string;
    childRunId: string;
    agentId: string;
    tenantId: string;
  }) => Promise<Array<{ messageId: string; prompt: string }>>;
}
