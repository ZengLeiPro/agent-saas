import { createHash } from 'node:crypto';

import { z } from 'zod';

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
  resolveDwsPrincipalCwd,
  type DwsWorkspacePrincipal,
} from './authFlow.js';
import type { DwsConnectionStore } from './store.js';

const businessInputSchema = z.object({
  args: z.array(z.string().min(1).max(1_000)).min(2).max(80),
  credentialMode: z.enum(['agent', 'requester']).default('agent'),
  confirmed: z.boolean().optional(),
});

type DwsBusinessInput = z.infer<typeof businessInputSchema>;

const ALLOWED_MODULES = new Set([
  'agoal', 'aisearch', 'aitable', 'approval', 'attendance', 'axls', 'bot', 'calendar', 'chat',
  'contact', 'devdoc', 'ding', 'doc', 'drive', 'kb', 'mail', 'minutes', 'oa', 'report', 'sheet',
  'table', 'todo', 'wiki',
]);
const READ_VERBS = new Set([
  'check', 'count', 'current', 'detail', 'fields', 'find', 'get',
  'history', 'info', 'list', 'list-all', 'members', 'query', 'read', 'records', 'search',
  'show', 'stats', 'status', 'summary', 'tree', 'view', 'whoami',
]);
const WRITE_VERBS = new Set([
  'accept', 'add', 'append', 'archive', 'assign', 'bind', 'cancel', 'close', 'comment',
  'complete', 'copy', 'create', 'disable', 'edit', 'enable', 'finish', 'forward',
  'invite', 'join', 'leave', 'like', 'mark', 'move', 'new', 'open', 'patch', 'pause', 'post',
  'publish', 'rename', 'replace', 'reply', 'respond', 'resume', 'save', 'send', 'set', 'share',
  'start', 'submit', 'unarchive', 'unshare', 'update', 'write',
]);
const DESTRUCTIVE_VERBS = new Set([
  'agree', 'approve', 'clear', 'delete', 'dismiss', 'kick', 'pass', 'purge', 'recall',
  'reject', 'remove', 'revoke', 'transfer', 'truncate', 'withdraw',
]);
const FORBIDDEN_VERBS = new Set([
  'auth', 'consume', 'credential', 'download', 'exec', 'export', 'import', 'login', 'logout',
  'pat', 'serve', 'shell', 'token', 'upload', 'watch',
]);
const FORBIDDEN_FLAGS = /^(?:-p|-f|--profile|--format|--token|--access-token|--refresh-token|--config-dir|--keychain-dir|--client-id|--client-secret|--action|--operation|--method|--command|--output|--out|--output-dir|--download-dir|--file|--path|--dir|--directory)(?:=|$)/;

interface ClassifiedCommand {
  module: string;
  commandPath: string;
  risk: 'read' | 'write';
}

export const dwsBusinessToolDescriptor: ToolDescriptor<DwsBusinessInput> = {
  id: 'DwsBusiness',
  name: 'DwsBusiness',
  displayName: '钉钉业务操作',
  label: '钉钉业务',
  description: [
    '通过当前企业专家绑定的受控 DWS Broker 查询或写入钉钉业务数据。',
    'args 只填写 dws 后面的参数数组，例如 ["calendar","event","list","--today"]；不要填写 dws、--profile、--format 或任何 token。',
    'credentialMode=agent 表示以专家自身钉钉账号执行；requester 表示以当前请求者已连接的唯一钉钉账号执行。',
    '写操作必须在用户明确要求或确认后传 confirmed=true；delete/remove/recall/revoke/approve/reject 等破坏性或高影响动作本阶段拒绝。',
  ].join('\n'),
  schema: businessInputSchema,
  risk: 'workspace_write',
  approvalMode: 'web',
  resolveCallPolicy: input => {
    try {
      return { risk: classifyCommand(businessInputSchema.parse(input).args).risk === 'read' ? 'safe' : 'workspace_write' };
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
    const workspaceIdentity = context.channelContext.user ?? identity;
    const session = context.sessionId ? await this.options.sessionCatalog.get(context.sessionId) : null;
    const correlationId = context.invocationId ?? context.toolCallId ?? `${context.runId ?? context.sessionId ?? 'unbound'}:dws`;
    const auditRejection = async (reason: string, metadata?: Record<string, unknown>) => {
      await this.options.auditStore.append({
        correlationId,
        actorType: identity?.id ? 'user' : 'service',
        actorUserId: identity?.id ?? 'dws-business-broker',
        actorPersona: identity?.id ? (identity.role === 'admin' ? 'org_admin' : 'member') : 'service',
        ...(identity?.tenantId ? { actorTenantId: identity.tenantId } : {}),
        action: 'dws.business.rejected',
        targetType: 'org_agent',
        targetId: session?.orgAgentId ?? 'unbound',
        ...(identity?.tenantId ? { targetTenantId: identity.tenantId } : {}),
        purpose: 'persist rejected DWS business broker call',
        reason,
        result: 'failed',
        metadata: { sessionBound: Boolean(session?.orgAgentId), ...metadata },
      });
    };
    const parsed = businessInputSchema.safeParse(call.input);
    if (!parsed.success) {
      await auditRejection('DWS_BUSINESS_INPUT_INVALID');
      throw new Error('DWS Broker 输入格式无效');
    }
    const input = parsed.data;
    if (!identity?.id || !identity.tenantId || !context.sessionId) {
      await auditRejection('DWS_BUSINESS_SUBJECT_MISSING');
      throw new Error('DWS Broker 缺少可信请求者或 Session 身份');
    }
    const mismatchFields = [
      ...(!session?.orgAgentId ? ['session.orgAgentId'] : []),
      ...(session?.userId !== identity.id ? ['session.userId'] : []),
      ...(session?.tenantId !== identity.tenantId ? ['session.tenantId'] : []),
      ...(context.workspace.userId !== workspaceIdentity?.id ? ['workspace.userId'] : []),
      ...(context.workspace.tenantId && context.workspace.tenantId !== workspaceIdentity?.tenantId
        ? ['workspace.tenantId']
        : []),
    ];
    if (mismatchFields.length > 0) {
      const diagnostic = {
        mismatchFields,
        requesterUserId: identity.id,
        requesterTenantId: identity.tenantId,
        sessionUserId: session?.userId,
        sessionTenantId: session?.tenantId,
        sessionOrgAgentId: session?.orgAgentId,
        workspaceUserId: context.workspace.userId,
        workspaceTenantId: context.workspace.tenantId,
      };
      this.options.logger?.warn(`DWS business subject mismatch ${JSON.stringify(diagnostic)}`);
      await auditRejection('DWS_BUSINESS_SUBJECT_MISMATCH', diagnostic);
      throw new Error(`DWS Broker 会话绑定已失效（不一致项：${mismatchFields.join('、')}），请重新打开当前会话后重试`);
    }
    if (!session?.orgAgentId) throw new Error('DWS Broker 会话绑定已失效，请重新打开当前会话后重试');
    let command: ClassifiedCommand;
    try {
      command = classifyCommand(input.args);
    } catch (error) {
      await auditRejection('DWS_BUSINESS_ACTION_REJECTED');
      throw error;
    }
    if (command.risk === 'write' && input.confirmed !== true) {
      await auditRejection('DWS_BUSINESS_CONFIRMATION_REQUIRED');
      throw new Error('DWS 写操作缺少用户明确确认');
    }

    const account = (await this.options.accountStore.listForTenant(identity.tenantId))
      .find(candidate => candidate.agentId === session.orgAgentId) ?? null;
    if (!account || account.status !== 'active' || !account.profileId) {
      await auditRejection('DWS_BUSINESS_AGENT_ACCOUNT_UNAVAILABLE');
      throw new Error('当前企业专家没有可用的钉钉账号授权');
    }
    const delegation = input.credentialMode === 'agent'
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
      actorUserId: identity.id,
      actorPersona: identity.role === 'admin' ? 'org_admin' as const : 'member' as const,
      actorTenantId: identity.tenantId,
      action: `dws.business.${command.risk}`,
      targetType: 'org_agent',
      targetId: session.orgAgentId,
      targetTenantId: identity.tenantId,
      purpose: 'execute registered DWS business action through credential broker',
      metadata: {
        module: command.module,
        commandPath: command.commandPath,
        credentialMode: input.credentialMode,
        sessionBound: true,
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
      const principalAndProfile = input.credentialMode === 'requester'
        ? await this.resolveRequesterPrincipal(identity.tenantId, identity.id)
        : {
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
    risk: ClassifiedCommand['risk'],
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

function isForbiddenDwsFlag(arg: string): boolean {
  if (FORBIDDEN_FLAGS.test(arg)) return true;
  if (!arg.startsWith('-')) return false;
  const name = arg.split('=', 1)[0]!.toLowerCase();
  if (/(?:^|-)(?:file|path|attachment|media|image)(?:-|$)/.test(name)
    && !/(?:^|-)(?:file|attachment|media|image)-ids?$/.test(name)) return true;
  return /(?:^|-)(?:local|source-file|contents-file|template-file)(?:-|$)/.test(name);
}

function classifyCommand(args: string[]): ClassifiedCommand {
  for (const arg of args) {
    if (/[\u0000-\u001F\u007F]/.test(arg) || isForbiddenDwsFlag(arg)) {
      throw new Error('DWS 命令包含受限参数');
    }
  }
  const module = args[0]!.toLowerCase();
  if (!ALLOWED_MODULES.has(module)) throw new Error('DWS 模块未登记或不允许由 Broker 执行');
  const firstFlagIndex = args.findIndex(token => token.startsWith('-'));
  const commandPath = args.slice(0, firstFlagIndex < 0 ? args.length : firstFlagIndex);
  const pathTokens = commandPath.flatMap(token => token.toLowerCase().split('-').filter(Boolean));
  const normalizedAction = commandPath.at(-1)!.toLowerCase().replace(/^\+/, '');
  const actionTokens = [normalizedAction, ...normalizedAction.split('-')].filter(Boolean);
  const flagNameTokens = args.filter(token => token.startsWith('-'))
    .flatMap(token => token.split('=', 1)[0]!.toLowerCase().split('-').filter(Boolean));
  if ([...pathTokens, ...flagNameTokens].some(token => DESTRUCTIVE_VERBS.has(token))) {
    throw new Error('DWS 破坏性或高影响动作本阶段未开放');
  }
  if (pathTokens.some(token => FORBIDDEN_VERBS.has(token))) {
    throw new Error('DWS 命令超出业务 Broker 边界');
  }
  const normalizedCommandPath = commandPath.map(token => token.toLowerCase()).join('.');
  if (actionTokens.some(token => WRITE_VERBS.has(token))) {
    return { module, commandPath: normalizedCommandPath, risk: 'write' };
  }
  if (actionTokens.some(token => READ_VERBS.has(token))) {
    return { module, commandPath: normalizedCommandPath, risk: 'read' };
  }
  throw new Error('DWS 动作未登记风险等级，已拒绝执行');
}

export function deriveDwsAgentDelegationResourceId(accountId: string, args: string[]): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(accountId)) {
    throw new Error('DWS Agent account id cannot be represented as a delegation resource');
  }
  const digest = createHash('sha256').update(JSON.stringify(args)).digest('hex');
  return `dws-delegation:${accountId}:${digest}`;
}

function sanitizeDwsBusinessOutput(content: string, profileId: string): string {
  return content
    .split(profileId).join('[DWS_PROFILE_REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|token)["']?)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/(?:\/[^\s"']+)*\/\.dws\/(?:config|keys)(?:\/[^\s"']*)?/gi, '[DWS_PROFILE_PATH_REDACTED]');
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
    return classifyCommand(businessInputSchema.parse(input).args).risk === 'read' ? 'safe' : 'workspace_write';
  } catch {
    return 'dangerous';
  }
}
