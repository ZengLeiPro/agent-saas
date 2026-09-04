import { randomUUID } from 'node:crypto';

import type { ExecutionTransport } from '../runtime/executionTransport.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
} from '../data/agentDwsAccounts/index.js';
import type { GovernanceAuditStore } from '../data/governance-audit/types.js';
import type { UserStore } from '../data/users/store.js';
import type { UserIdentity } from '../types/index.js';
import { governancePersonaForUser } from '../governance/subject/platformIdentity.js';
import {
  deriveDwsPrincipalWorkspaceId,
  deriveDwsWorkspaceMountSubPath,
  redactDwsError,
  resolveDwsPrincipalCwd,
  type DwsWorkspacePrincipal,
} from './authFlow.js';
import { DWS_CONNECTOR_SANDBOX_RESOURCES } from './sandboxResources.js';

const LOOKUP_BATCH_SIZE = 30;
const DWS_REQUESTER_LOOKUP_WORKLOAD = { class: 'interactive' } as const;

export interface DwsRequesterDirectoryEntry {
  staffId: string;
  openDingtalkId: string;
  mobile?: string;
}

export type DwsRequesterResolution =
  | { status: 'resolved'; requester: UserIdentity }
  | { status: 'unmapped' | 'ambiguous' | 'self_echo' | 'unavailable'; reason: string };

export class DwsRequesterIdentityResolver {
  constructor(private readonly options: {
    agentCwd: string;
    userStore: Pick<UserStore, 'listAll'> & Partial<Pick<UserStore, 'reload'>>;
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
  }) {}

  async resolve(
    account: AgentDwsAccountRecord,
    senderOpenDingtalkId: string,
    senderName?: string,
  ): Promise<UserIdentity | null> {
    const outcome = await this.resolveOutcome(account, senderOpenDingtalkId, senderName);
    return outcome.status === 'resolved' ? outcome.requester : null;
  }

  async resolveOutcome(
    account: AgentDwsAccountRecord,
    senderOpenDingtalkId: string,
    senderName?: string,
  ): Promise<DwsRequesterResolution> {
    if (account.status !== 'active' || !hasExactAgentDwsProfile(account)) {
      return await this.recordDecision(account, null, 'AGENT_DWS_ACCOUNT_UNAVAILABLE');
    }
    this.options.userStore.reload?.();
    const candidates = this.options.userStore.listAll()
      .filter(user => user.tenantId === account.tenantId && !user.disabled)
      .filter((user, index, users) => users.findIndex(candidate => candidate.id === user.id) === index);
    const staffCandidates = candidates.filter(user => user.dingtalkStaffId);
    const phoneCandidates = candidates.filter(user => user.phone && user.phoneVerifiedAt);
    if (staffCandidates.length === 0 && phoneCandidates.length === 0) {
      return await this.recordDecision(account, null, 'TENANT_DINGTALK_DIRECTORY_EMPTY');
    }

    const byStaffId = new Map<string, typeof candidates>();
    for (const candidate of staffCandidates) {
      const staffId = candidate.dingtalkStaffId!;
      byStaffId.set(staffId, [...(byStaffId.get(staffId) ?? []), candidate]);
    }
    const byVerifiedPhone = new Map<string, typeof candidates>();
    for (const candidate of phoneCandidates) {
      const phone = normalizePhone(candidate.phone!);
      if (phone) byVerifiedPhone.set(phone, [...(byVerifiedPhone.get(phone) ?? []), candidate]);
    }
    const matches: Array<{ user: (typeof candidates)[number]; staffId: string }> = [];
    const observedSenderStaffIds = new Set<string>();
    const collectMatches = (entries: DwsRequesterDirectoryEntry[]) => {
      for (const entry of entries) {
        if (entry.openDingtalkId !== senderOpenDingtalkId) continue;
        observedSenderStaffIds.add(entry.staffId);
        const direct = byStaffId.get(entry.staffId) ?? [];
        const phone = entry.mobile ? normalizePhone(entry.mobile) : undefined;
        const verified = phone ? byVerifiedPhone.get(phone) ?? [] : [];
        for (const user of [...direct, ...verified]) matches.push({ user, staffId: entry.staffId });
      }
    };
    for (let offset = 0; offset < byStaffId.size; offset += LOOKUP_BATCH_SIZE) {
      const staffIds = [...byStaffId.keys()].slice(offset, offset + LOOKUP_BATCH_SIZE);
      collectMatches(await this.lookup(account, { staffIds }));
    }
    // 姓名只用于缩小 DWS 目录查询范围；最终必须同时精确命中事件 openDingTalkId，
    // 并通过已配置 staffId 或平台已验证手机号建立同租户唯一映射。
    if (senderName?.trim()) collectMatches(await this.lookup(account, { query: senderName.trim() }));
    if (account.dingtalkUserId && observedSenderStaffIds.has(account.dingtalkUserId)) {
      return await this.recordDecision(account, null, 'AGENT_DWS_SELF_ECHO');
    }
    const unique = matches.filter((match, index) => matches.findIndex(candidate => (
      candidate.user.id === match.user.id && candidate.staffId === match.staffId
    )) === index);
    const uniqueUsers = [...new Set(unique.map(match => match.user.id))];
    const uniqueStaffIds = [...new Set(unique.map(match => match.staffId))];
    if (uniqueUsers.length !== 1 || uniqueStaffIds.length !== 1 || observedSenderStaffIds.size !== 1) {
      return await this.recordDecision(
        account,
        null,
        unique.length === 0 ? 'REQUESTER_IDENTITY_UNMAPPED' : 'REQUESTER_IDENTITY_AMBIGUOUS',
      );
    }
    const match = unique[0]!;
    const user = match.user;
    return await this.recordDecision(account, {
      id: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId,
      ...(user.realName ? { realName: user.realName } : {}),
      dingtalkStaffId: match.staffId,
      ...(user.permissions ? { permissions: user.permissions } : {}),
    }, 'REQUESTER_IDENTITY_RESOLVED');
  }

  private async recordDecision(
    account: AgentDwsAccountRecord,
    requester: UserIdentity | null,
    reason: string,
  ): Promise<DwsRequesterResolution> {
    await this.options.auditStore.append({
      correlationId: `dws-requester-decision-${randomUUID()}`,
      actorType: requester ? 'user' : 'service',
      actorUserId: requester?.id ?? `agent-dws:${account.accountId}`,
      actorPersona: requester ? governancePersonaForUser(requester) : 'service',
      actorTenantId: requester?.tenantId ?? account.tenantId,
      action: 'dws.requester.resolve_decision',
      targetType: 'org_agent',
      targetId: account.agentId,
      targetTenantId: account.tenantId,
      purpose: 'record fail-closed DWS requester identity decision',
      reason,
      result: requester ? 'succeeded' : 'failed',
      metadata: { mapped: Boolean(requester) },
    });
    if (requester) return { status: 'resolved', requester };
    if (reason === 'AGENT_DWS_SELF_ECHO') return { status: 'self_echo', reason };
    if (reason === 'REQUESTER_IDENTITY_AMBIGUOUS') return { status: 'ambiguous', reason };
    if (reason === 'REQUESTER_IDENTITY_UNMAPPED') return { status: 'unmapped', reason };
    return { status: 'unavailable', reason };
  }

  private async lookup(
    account: AgentDwsAccountRecord,
    request: { staffIds: string[] } | { query: string },
  ): Promise<DwsRequesterDirectoryEntry[]> {
    const principal: DwsWorkspacePrincipal = {
      id: account.accountId,
      username: account.displayName,
      tenantId: account.tenantId,
      role: 'user',
      principalType: 'agent',
      agentId: account.agentId,
    };
    const correlationId = `dws-requester-lookup-${randomUUID()}`;
    const candidateCount = 'staffIds' in request ? request.staffIds.length : 1;
    const commandArgs = 'staffIds' in request
      ? ['contact', 'user', 'get', '--ids', request.staffIds.join(',')]
      : ['contact', 'user', 'search', '--query', request.query];
    const auditBase = {
      correlationId,
      actorType: 'service' as const,
      actorUserId: `agent-dws:${account.accountId}`,
      actorPersona: 'service' as const,
      actorTenantId: account.tenantId,
      action: 'dws.requester.resolve',
      targetType: 'org_agent',
      targetId: account.agentId,
      targetTenantId: account.tenantId,
      purpose: 'resolve DWS sender identity from authoritative contact directory',
      metadata: { candidateCount },
    };
    await this.options.auditStore.append({ ...auditBase, result: 'intent' });
    try {
      const remote = await this.options.resolveServerRemote(principal);
      const transport = this.options.createTransport?.(remote) ?? new HttpTransport({
        baseUrl: remote.baseUrl,
        authToken: remote.authToken,
        invokeTimeoutMs: Math.max(remote.invokeTimeoutMs ?? 0, 70_000),
      });
      const cwd = resolveDwsPrincipalCwd(this.options.agentCwd, principal);
      const mountSubPath = deriveDwsWorkspaceMountSubPath(this.options.agentCwd, cwd);
      if (!mountSubPath) throw new Error('无法解析 DWS requester lookup workspace');
      const workspaceId = deriveDwsPrincipalWorkspaceId(principal);
      const response = await transport.invoke({
        toolName: 'Shell',
        input: {
          command: [
            'dws', ...commandArgs, '--profile', account.profileId!, '--format', 'json',
          ].map(shellQuote).join(' '),
          timeoutMs: 60_000,
        },
        context: {
          invocationId: correlationId,
          workspace: {
            id: workspaceId,
            root: cwd,
            userId: principal.id,
            username: principal.username,
            tenantId: principal.tenantId,
            sessionId: `dws-requester-lookup-${account.accountId}`,
            sandboxScopeId: `${workspaceId}__${mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}`,
            mountSubPath,
            executionTarget: 'server-remote',
            sandboxResources: DWS_CONNECTOR_SANDBOX_RESOURCES,
            workload: DWS_REQUESTER_LOOKUP_WORKLOAD,
          },
        },
      });
      if (response.status === 'error') throw new Error(response.error);
      const entries = parseDwsRequesterDirectoryEntries(response.content);
      await this.options.auditStore.append({
        ...auditBase,
        result: 'succeeded',
        metadata: { candidateCount, directoryEntryCount: entries.length },
      });
      return entries;
    } catch (error) {
      await this.options.auditStore.append({
        ...auditBase,
        result: 'failed',
        reason: 'DWS_REQUESTER_DIRECTORY_LOOKUP_FAILED',
      }).catch(() => undefined);
      throw new Error(redactDwsError(error).split(account.profileId!).join('[DWS_PROFILE_REDACTED]'));
    }
  }
}

export function parseDwsRequesterDirectoryEntries(content: string): DwsRequesterDirectoryEntry[] {
  const stdoutMarker = '[stdout]\n';
  const stdoutStart = content.indexOf(stdoutMarker);
  const raw = stdoutStart >= 0
    ? content.slice(stdoutStart + stdoutMarker.length).split('\n[stderr]\n', 1)[0]!.trim()
    : content.trim();
  const jsonStart = Math.min(...[raw.indexOf('{'), raw.indexOf('[')].filter(index => index >= 0));
  const objectEnd = raw.lastIndexOf('}');
  const arrayEnd = raw.lastIndexOf(']');
  const jsonEnd = Math.max(objectEnd, arrayEnd);
  if (!Number.isFinite(jsonStart) || jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error('DWS contact lookup 未返回 JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch {
    throw new Error('DWS contact lookup JSON 格式无效');
  }
  // DWS 响应可能在父子节点重复投影同一联系人，优先保留带手机号的完整记录。
  const entries: DwsRequesterDirectoryEntry[] = [];
  walk(parsed, value => {
    const staffId = stringField(value.staffId)
      ?? stringField(value.staff_id)
      ?? stringField(value.userId)
      ?? stringField(value.user_id);
    const openDingtalkId = stringField(value.openDingTalkId)
      ?? stringField(value.openDingtalkId)
      ?? stringField(value.open_dingtalk_id);
    const mobile = stringField(value.mobile)
      ?? stringField(value.mobileNumber)
      ?? stringField(value.mobile_number)
      ?? stringField(value.phone);
    if (staffId && openDingtalkId) entries.push({
      staffId,
      openDingtalkId,
      ...(mobile ? { mobile } : {}),
    });
  });
  const unique = new Map<string, DwsRequesterDirectoryEntry>();
  for (const entry of entries) {
    const key = `${entry.staffId}\u0000${entry.openDingtalkId}`;
    const existing = unique.get(key);
    if (!existing || (!existing.mobile && entry.mobile)) unique.set(key, entry);
  }
  return [...unique.values()];
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach(item => walk(item, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  visit(record);
  Object.values(record).forEach(item => walk(item, visit));
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text && text.length <= 200 ? text : undefined;
}

function normalizePhone(value: string): string | undefined {
  const compact = value.trim().replace(/[\s-]/g, '');
  const digits = compact.startsWith('+86')
    ? compact.slice(3)
    : compact.startsWith('86') && compact.length === 13
      ? compact.slice(2)
      : compact;
  return /^1\d{10}$/.test(digits) ? digits : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
