import { createHash } from 'node:crypto';

import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import { governancePersonaForUser } from '../governance/subject/platformIdentity.js';
import type {
  AuthorizedToolCall,
  ExecutionAuditRecorder,
  ExecutionInvocationAudit,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
  ToolRisk,
} from '../agent/toolRuntime.js';
import type { AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { GovernanceAuditStore } from '../data/governance-audit/types.js';
import type { UserStore } from '../data/users/store.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { ExecutionTransport } from '../runtime/executionTransport.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import {
  deriveDwsPrincipalWorkspaceId,
  deriveDwsWorkspaceMountSubPath,
  redactDwsError,
  redactDwsProfilePaths,
  resolveDwsPrincipalCwd,
  type DwsWorkspacePrincipal,
} from './authFlow.js';
import {
  classifyDwsBusinessCommand,
  DWS_ACTIVE_CLI_VERSION,
  DwsCommandPolicyError,
  type ClassifiedDwsCommand,
} from './commandPolicy.js';
import { DWS_CONNECTOR_SANDBOX_RESOURCES } from './sandboxResources.js';
import type { DwsConnectionStore } from './store.js';

const businessInputSchema = z.object({
  args: z.array(z.string().min(1).max(1_000)).min(2).max(80),
  credentialMode: z.enum(['agent', 'requester']).default('agent'),
  confirmed: z.boolean().optional(),
});

type DwsBusinessInput = z.infer<typeof businessInputSchema>;

export const dwsBusinessToolDescriptor: ToolDescriptor<DwsBusinessInput> = {
  id: 'DwsBusiness',
  name: 'DwsBusiness',
  displayName: '钉钉业务操作',
  label: '钉钉业务',
  description: [
    '通过受控 DWS Broker 查询或写入钉钉业务数据。',
    'args 只填写 dws 后面的参数数组，例如 ["calendar","event","list","--today"]；不要填写 dws、--profile、--format 或任何 token。',
    'credentialMode=agent 表示以当前企业专家自身钉钉账号执行，要求 Session 绑定企业专家；requester 表示以当前请求者在能力中心连接的唯一钉钉账号执行，可用于请求者自己的普通 Session 或个人定时任务。',
    'auth 模块只开放只读的 auth status；写操作必须在用户明确要求或确认后传 confirmed=true；delete/remove/recall/revoke/approve/reject 等破坏性或高影响动作本阶段拒绝。',
  ].join('\n'),
  schema: businessInputSchema,
  risk: 'workspace_write',
  approvalMode: 'web',
  resolveCallPolicy: input => {
    try {
      return { risk: classifyDwsBusinessCommand(businessInputSchema.parse(input).args).risk === 'read' ? 'safe' : 'workspace_write' };
    } catch {
      return { risk: 'dangerous', neverAutoApprove: true };
    }
  },
  auditCategory: 'external.dws.business',
  category: 'core',
};

export interface DwsBusinessToolProviderOptions {
  agentCwd: string;
  accountStore: AgentDwsAccountStore;
  assignmentStore?: Pick<PgAssignmentStore, 'listEffectiveResourceIds'>;
  connectionStore?: DwsConnectionStore;
  userStore: UserStore;
  isRequesterRuntimeEnabled?: (username: string) => boolean;
  sessionCatalog: Pick<SessionCatalog, 'get'>;
  auditStore: GovernanceAuditStore;
  resolveServerRemote: (principal: DwsWorkspacePrincipal) => Promise<{
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  }>;
  createTransport?: (remote: {
    baseUrl: string;
    authToken: string;
    invokeTimeoutMs?: number;
  }) => Pick<ExecutionTransport, 'invoke'>;
  logger?: { warn(message: string): void };
}

export class DwsBusinessToolProvider implements ToolProvider {
  constructor(private readonly options: DwsBusinessToolProviderOptions) {}

  list(): ToolDescriptor[] {
    return [dwsBusinessToolDescriptor];
  }

  async invoke<TInput>(
    call: AuthorizedToolCall<TInput>,
    context: ToolCallContext,
  ): Promise<ToolResult | undefined> {
    if (call.toolId !== dwsBusinessToolDescriptor.id) return undefined;
    const identity = context.channelContext.sessionOwner ?? context.channelContext.user;
    const operator = context.channelContext.user ?? identity;
    const workspaceIdentity = operator;
    const session = context.sessionId ? await this.options.sessionCatalog.get(context.sessionId) : null;
    const correlationId = context.invocationId ?? context.toolCallId ?? `${context.runId ?? context.sessionId ?? 'unbound'}:dws`;
    const auditRejection = async (reason: string, metadata?: Record<string, unknown>) => {
      await this.options.auditStore.append({
        correlationId,
        actorType: operator?.id ? 'user' : 'service',
        actorUserId: operator?.id ?? 'dws-business-broker',
        actorPersona: operator?.id ? governancePersonaForUser(operator) : 'service',
        ...(operator?.tenantId ? { actorTenantId: operator.tenantId } : {}),
        action: 'dws.business.rejected',
        targetType: 'org_agent',
        targetId: session?.orgAgentId ?? 'unbound',
        ...(identity?.tenantId ? { targetTenantId: identity.tenantId } : {}),
        purpose: 'persist rejected DWS business broker call',
        reason,
        result: 'failed',
        metadata: {
          sessionBound: Boolean(session?.orgAgentId),
          ...(identity?.id ? { sessionOwnerUserId: identity.id } : {}),
          ...(identity?.tenantId ? { sessionOwnerTenantId: identity.tenantId } : {}),
          ...(operator?.id ? { operatorUserId: operator.id } : {}),
          ...(operator?.tenantId ? { operatorTenantId: operator.tenantId } : {}),
          ...metadata,
        },
      });
    };
    const parsed = businessInputSchema.safeParse(call.input);
    if (!parsed.success) {
      await auditRejection('DWS_BUSINESS_INPUT_INVALID');
      throw new Error('DWS Broker 输入格式无效');
    }
    const input = parsed.data;
    if (!identity?.id || !identity.tenantId || !operator?.id || !operator.tenantId || !context.sessionId) {
      await auditRejection('DWS_BUSINESS_SUBJECT_MISSING');
      throw new Error('DWS Broker 缺少可信请求者或 Session 身份');
    }
    const operatorIsPlatformAdmin = isPlatformAdmin({
      sub: operator.id,
      username: operator.username,
      role: operator.role,
      tenantId: operator.tenantId,
    });
    const operatorCanActForSessionOwner = operator.id === identity.id
      || (operator.role === 'admin' && operator.tenantId === identity.tenantId)
      || operatorIsPlatformAdmin;
    const orgAgentId = session?.orgAgentId;
    // requester 模式（含个人 Cron）只要求 Session/user/workspace 身份一致，按 Session owner
    // 的个人钉钉连接解析凭据；仅 agent 模式才要求 Session 绑定企业专家。
    const requiresOrgAgent = input.credentialMode === 'agent';
    const mismatchFields = [
      ...(!operatorCanActForSessionOwner ? ['operator.sessionOwnerTenantScope'] : []),
      ...(requiresOrgAgent && !orgAgentId ? ['session.orgAgentId'] : []),
      ...(session?.userId !== identity.id ? ['session.userId'] : []),
      ...(session?.tenantId !== identity.tenantId ? ['session.tenantId'] : []),
      ...(context.workspace.userId !== workspaceIdentity?.id ? ['workspace.userId'] : []),
      ...(context.workspace.tenantId && context.workspace.tenantId !== workspaceIdentity?.tenantId
        ? ['workspace.tenantId']
        : []),
    ];
    if (mismatchFields.length > 0) {
      const cronSessionUnbound = input.credentialMode === 'agent'
        && mismatchFields.length === 1
        && mismatchFields[0] === 'session.orgAgentId'
        && session?.channel === 'cron';
      const diagnostic = {
        mismatchFields,
        requesterUserId: identity.id,
        requesterTenantId: identity.tenantId,
        operatorUserId: operator?.id,
        operatorTenantId: operator?.tenantId,
        operatorRole: operator?.role,
        sessionUserId: session?.userId,
        sessionTenantId: session?.tenantId,
        sessionOrgAgentId: session?.orgAgentId,
        workspaceUserId: context.workspace.userId,
        workspaceTenantId: context.workspace.tenantId,
      };
      this.options.logger?.warn(`DWS business subject mismatch ${JSON.stringify(diagnostic)}`);
      await auditRejection('DWS_BUSINESS_SUBJECT_MISMATCH', diagnostic);
      throw new Error(cronSessionUnbound
        ? '此定时任务未绑定企业专家，无法使用 DWS Broker；请在目标企业专家会话中重新创建该定时任务'
        : `DWS Broker 会话绑定已失效（不一致项：${mismatchFields.join('、')}），请重新打开当前会话后重试`);
    }
    let command: ClassifiedDwsCommand;
    try {
      command = classifyDwsBusinessCommand(input.args);
    } catch (error) {
      await auditRejection('DWS_BUSINESS_ACTION_REJECTED', error instanceof DwsCommandPolicyError ? {
        ...(error.commandPath ? { commandPath: error.commandPath } : {}),
        policySource: error.policySource,
        policyCliVersion: DWS_ACTIVE_CLI_VERSION,
      } : undefined);
      throw error;
    }
    if (command.risk === 'write' && input.confirmed !== true) {
      await auditRejection('DWS_BUSINESS_CONFIRMATION_REQUIRED', {
        commandPath: command.commandPath,
        policySource: command.policySource,
        policyCliVersion: DWS_ACTIVE_CLI_VERSION,
      });
      throw new Error('DWS 写操作缺少用户明确确认');
    }

    const account = input.credentialMode === 'agent' && orgAgentId
      ? (await this.options.accountStore.listForTenant(identity.tenantId))
          .find(candidate => candidate.agentId === orgAgentId) ?? null
      : null;
    if (input.credentialMode === 'agent' && (!account || account.status !== 'active' || !account.profileId)) {
      await auditRejection('DWS_BUSINESS_AGENT_ACCOUNT_UNAVAILABLE');
      throw new Error('当前企业专家没有可用的钉钉账号授权');
    }
    const delegation = input.credentialMode === 'agent' && account
      ? await this.resolveAgentCredentialDelegation(
          identity.tenantId,
          identity.id,
          account.accountId,
          input.args,
        ).catch(() => null)
      : null;
    if (input.credentialMode === 'agent' && !delegation) {
      await auditRejection('DWS_BUSINESS_AGENT_DELEGATION_DENIED');
      throw new Error('当前请求者没有此专家钉钉账号的业务动作与资源委托权限');
    }
    const auditBase = {
      correlationId,
      actorType: 'user' as const,
      actorUserId: operator.id,
      actorPersona: governancePersonaForUser(operator),
      actorTenantId: operator.tenantId,
      action: `dws.business.${command.risk}`,
      targetType: orgAgentId ? 'org_agent' : 'user',
      targetId: orgAgentId ?? identity.id,
      targetTenantId: identity.tenantId,
      purpose: 'execute registered DWS business action through credential broker',
      metadata: {
        module: command.module,
        commandPath: command.commandPath,
        policySource: command.policySource,
        policyCliVersion: DWS_ACTIVE_CLI_VERSION,
        credentialMode: input.credentialMode,
        sessionBound: Boolean(orgAgentId),
        sessionOwnerUserId: identity.id,
        sessionOwnerTenantId: identity.tenantId,
        operatorUserId: operator.id,
        operatorTenantId: operator.tenantId,
        operatorRole: operator.role,
        ...(delegation ? {
          delegationResourceId: delegation.resourceId,
          delegationBindingId: delegation.bindingId,
          delegationAssignmentVersion: delegation.assignmentVersion,
        } : {}),
      },
    };
    await this.options.auditStore.append({ ...auditBase, result: 'intent' });

    let profileId: string | undefined;
    try {
      let principalAndProfile;
      if (input.credentialMode === 'requester') {
        principalAndProfile = await this.resolveRequesterPrincipal(identity.tenantId, identity.id);
      } else {
        if (!account?.profileId) throw new Error('当前企业专家没有可用的钉钉账号授权');
        principalAndProfile = {
          principal: {
            id: account.accountId,
            username: account.displayName,
            tenantId: account.tenantId,
            role: 'user' as const,
            principalType: 'agent' as const,
            agentId: account.agentId,
          },
          profileId: account.profileId,
        };
      }
      profileId = principalAndProfile.profileId;
      const result = await this.execute(
        principalAndProfile.principal,
        principalAndProfile.profileId,
        input.args,
        command.risk,
        correlationId,
        context.signal,
        context.executionAudit,
      );
      await this.options.auditStore.append({ ...auditBase, result: 'succeeded' });
      return result;
    } catch (error) {
      const message = profileId
        ? redactDwsError(error).split(profileId).join('[DWS_PROFILE_REDACTED]')
        : redactDwsError(error);
      await this.options.auditStore.append({
        ...auditBase,
        result: 'failed',
        reason: 'DWS_BUSINESS_EXECUTION_FAILED',
      }).catch(() => undefined);
      throw new Error(message);
    }
  }

  private async resolveAgentCredentialDelegation(
    tenantId: string,
    requesterUserId: string,
    accountId: string,
    args: string[],
  ): Promise<{
    resourceId: string;
    bindingId: string;
    assignmentVersion: number;
  } | null> {
    if (!this.options.assignmentStore) return null;
    const requiredResourceId = deriveDwsAgentDelegationResourceId(accountId, args);
    const effective = await this.options.assignmentStore.listEffectiveResourceIds(
      tenantId,
      requesterUserId,
      'dws_delegation',
    );
    return effective.find(entry => entry.resourceId === requiredResourceId) ?? null;
  }

  private async resolveRequesterPrincipal(tenantId: string, userId: string): Promise<{
    principal: DwsWorkspacePrincipal;
    profileId: string;
  }> {
    const user = this.options.userStore.findById(userId);
    if (!user || user.disabled || user.tenantId !== tenantId || !this.options.connectionStore
      || this.options.isRequesterRuntimeEnabled?.(user.username) === false) {
      throw new Error('当前请求者没有可用的钉钉连接');
    }
    const profiles = (await this.options.connectionStore.listForUser(tenantId, userId))
      .filter(profile => profile.connectionStatus === 'connected'
        && profile.authenticated !== false
        && profile.refreshTokenValid !== false);
    if (profiles.length !== 1) {
      throw new Error(profiles.length === 0
        ? '当前请求者没有已连接的钉钉账号'
        : '当前请求者存在多个钉钉账号，请先在个人设置中保留唯一活动账号');
    }
    return {
      principal: {
        id: user.id,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
        principalType: 'user',
      },
      profileId: profiles[0]!.profileId,
    };
  }

  private async execute(
    principal: DwsWorkspacePrincipal,
    profileId: string,
    args: string[],
    risk: ClassifiedDwsCommand['risk'],
    invocationId: string,
    signal?: AbortSignal,
    executionAudit?: ExecutionAuditRecorder,
  ): Promise<ToolResult> {
    const remote = await this.options.resolveServerRemote(principal);
    const transport = this.options.createTransport?.(remote) ?? new HttpTransport({
      baseUrl: remote.baseUrl,
      authToken: remote.authToken,
      invokeTimeoutMs: Math.max(remote.invokeTimeoutMs ?? 0, 130_000),
    });
    const cwd = resolveDwsPrincipalCwd(this.options.agentCwd, principal);
    const mountSubPath = deriveDwsWorkspaceMountSubPath(this.options.agentCwd, cwd);
    if (!mountSubPath) throw new Error('无法解析 DWS connector workspace');
    const workspaceId = deriveDwsPrincipalWorkspaceId(principal);
    const sandboxScopeId = `${workspaceId}__${mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
    const commandArgs = ['dws', ...args, '--profile', profileId, '--format', 'json'];
    if (risk === 'write' && !args.includes('--yes')) commandArgs.push('--yes');
    const response = await transport.invoke({
      toolName: 'Shell',
      input: {
        command: commandArgs.map(shellQuote).join(' '),
        timeoutMs: 120_000,
      },
      context: {
        invocationId,
        signal,
        workspace: {
          id: workspaceId,
          root: cwd,
          userId: principal.id,
          username: principal.username,
          tenantId: principal.tenantId,
          sessionId: `dws-business-${principal.id}`,
          sandboxScopeId,
          mountSubPath,
          executionTarget: 'server-remote',
          sandboxResources: DWS_CONNECTOR_SANDBOX_RESOURCES,
        },
      },
    });
    response.audit?.forEach(record => executionAudit?.record(sanitizeDwsExecutionAudit(record, profileId)));
    if (response.status === 'error') throw new Error(response.error);
    const metadata = sanitizeDwsMetadata(response.metadata);
    return {
      content: sanitizeDwsBusinessOutput(response.content, profileId),
      ...(metadata ? { metadata } : {}),
    };
  }
}

export function createDwsBusinessToolProviders(
  options: Omit<DwsBusinessToolProviderOptions, 'accountStore' | 'connectionStore' | 'userStore' | 'auditStore'> & {
    accountStore?: AgentDwsAccountStore | undefined;
    connectionStore?: DwsConnectionStore | undefined;
    userStore?: UserStore | undefined;
    auditStore?: GovernanceAuditStore | undefined;
    remoteAvailable: boolean;
  },
): ToolProvider[] {
  if (!options.accountStore || !options.userStore || !options.auditStore || !options.remoteAvailable) return [];
  const {
    remoteAvailable: _remoteAvailable,
    accountStore,
    connectionStore,
    userStore,
    auditStore,
    ...providerOptions
  } = options;
  return [new DwsBusinessToolProvider({
    ...providerOptions,
    accountStore,
    ...(connectionStore ? { connectionStore } : {}),
    userStore,
    auditStore,
  })];
}

export function deriveDwsAgentDelegationResourceId(accountId: string, args: string[]): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(accountId)) {
    throw new Error('DWS Agent account id cannot be represented as a delegation resource');
  }
  const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
  return `dws-delegation:${accountId}:${digest}`;
}

function sanitizeDwsBusinessOutput(content: string, profileId: string): string {
  return redactDwsProfilePaths(content
    .split(profileId).join('[DWS_PROFILE_REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|token)["']?)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]'));
}

function sanitizeDwsExecutionAudit(record: ExecutionInvocationAudit, profileId: string): ExecutionInvocationAudit {
  return {
    provider: record.provider,
    operation: record.operation,
    status: record.status,
    ...(record.image ? { image: record.image } : {}),
    ...(record.containerName ? { containerName: record.containerName } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.stdoutBytes !== undefined ? { stdoutBytes: record.stdoutBytes } : {}),
    ...(record.stderrBytes !== undefined ? { stderrBytes: record.stderrBytes } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    ...(record.timedOut !== undefined ? { timedOut: record.timedOut } : {}),
    ...(record.outputExceeded !== undefined ? { outputExceeded: record.outputExceeded } : {}),
    ...(record.aborted !== undefined ? { aborted: record.aborted } : {}),
    ...(record.error ? { error: sanitizeDwsBusinessOutput(record.error, profileId) } : {}),
  };
}

function sanitizeDwsMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const allowed = new Set(['exitCode', 'signal', 'durationMs', 'stdoutBytes', 'stderrBytes', 'timedOut', 'aborted', 'outputExceeded']);
  const entries = Object.entries(metadata).filter(([key, value]) => allowed.has(key)
    && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function resolveDwsBusinessRisk(input: unknown): ToolRisk {
  try {
    return classifyDwsBusinessCommand(businessInputSchema.parse(input).args).risk === 'read' ? 'safe' : 'workspace_write';
  } catch {
    return 'dangerous';
  }
}
