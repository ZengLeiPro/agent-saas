import { normalizeToolSegment, toolName } from '@kaiyan/ky-app-contract';

import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type { PgDirectoryGroupStore } from '../../data/directoryGroups/store.js';
import type { PgMembershipStore } from '../../data/memberships/store.js';
import { normalizeOrgAgentRuntimePolicy } from '../../data/orgAgents/runtimePolicy.js';
import type { OrgAgentStore } from '../../data/orgAgents/store.js';
import type { UserStore } from '../../data/users/store.js';
import type { UserCapabilityObservationReader } from '../gateway/capabilityObservationStore.js';
import type { KyAppAssignmentAccess } from './assignmentAccess.js';

export interface InstallationAccessOverviewOptions {
  users: Pick<UserStore, 'listAll'>;
  memberships: Pick<PgMembershipStore, 'listMemberships'>;
  assignments: Pick<KyAppAssignmentAccess, 'listEffectiveSubjectsForInstallation'>;
  assignmentSets: Pick<PgAssignmentStore, 'getAssignmentSet'>;
  observations?: Pick<UserCapabilityObservationReader, 'listForInstallation'>;
  groups?: Pick<PgDirectoryGroupStore, 'listGroups'>;
  agents?: Pick<OrgAgentStore, 'listByTenant'>;
}

type CapabilityStatus = 'ready' | 'unverified' | 'degraded' | 'waiting_personal_authorization';

export class InstallationAccessOverviewService {
  constructor(private readonly options: InstallationAccessOverviewOptions) {}

  async read(input: {
    tenantId: string;
    installationId: string;
    systemId: string;
    registeredDigest: string | null;
    capabilityIds: string[];
    kind: 'user' | 'agent';
    query?: string;
    cursor?: string;
    limit: number;
  }) {
    const [memberships, groupRecords, assignmentSet] = await Promise.all([
      this.options.memberships.listMemberships(input.tenantId),
      this.options.groups?.listGroups(input.tenantId) ?? Promise.resolve([]),
      this.options.assignmentSets.getAssignmentSet(
        input.tenantId,
        'system_installation',
        input.installationId,
      ),
    ]);
    const activeUserIds = new Set(
      memberships.filter((item) => item.status === 'active').map((item) => item.userId),
    );
    const users = this.options.users
      .listAll()
      .filter(
        (item) => item.tenantId === input.tenantId && !item.disabled && activeUserIds.has(item.id),
      );
    const agents = (this.options.agents?.listByTenant(input.tenantId) ?? []).filter(
      (agent) => agent.enabled,
    );
    const [effectiveSubjects, observations] = await Promise.all([
      this.options.assignments.listEffectiveSubjectsForInstallation({
        tenantId: input.tenantId,
        installationId: input.installationId,
        userIds: users.map((item) => item.id),
        agentIds: agents.map((item) => item.id),
      }),
      input.registeredDigest
        ? (this.options.observations?.listForInstallation(
            input.tenantId,
            input.installationId,
            input.registeredDigest,
          ) ?? Promise.resolve([]))
        : Promise.resolve([]),
    ]);
    const effectiveBySubject = new Map(
      effectiveSubjects.map((item) => [`${item.subjectType}:${item.subjectId}`, item] as const),
    );
    const observationByUser = new Map(observations.map((item) => [item.userId, item] as const));
    const groupNames = new Map(
      groupRecords.map((item) => [item.groupId, item.displayName] as const),
    );

    const organizationUsers = users
      .map((user) => {
        const effective = effectiveBySubject.get(`user:${user.id}`);
        const observation = observationByUser.get(user.id);
        const observed =
          observation && input.registeredDigest === observation.registeredDigest
            ? observation
            : null;
        const capabilityStatus: CapabilityStatus =
          observed?.status === 'ready' && observed.enabledCapabilityCount > 0
            ? 'ready'
            : observed?.status === 'unavailable'
              ? 'degraded'
              : observed?.status === 'not_projected'
                ? 'waiting_personal_authorization'
                : 'unverified';
        const sources = [
          ...new Set(
            (effective?.bindings ?? [])
              .filter((binding) => binding.effect === 'allow')
              .map((binding) =>
                binding.assigneeType === 'user'
                  ? 'direct'
                  : binding.assigneeType === 'directory_group'
                    ? 'directory_group'
                    : 'everyone',
              ),
          ),
        ];
        const departmentNames = [
          ...new Set(
            (effective?.bindings ?? [])
              .filter((binding) => binding.assigneeType === 'directory_group')
              .map((binding) => groupNames.get(binding.assigneeId ?? ''))
              .filter((name): name is string => Boolean(name)),
          ),
        ];
        return {
          userId: user.id,
          displayName: user.realName ?? user.username,
          username: user.username,
          authorized: Boolean(effective),
          departmentNames,
          accessSources: sources,
          // 当前 KY App 接入模型不要求成员逐人完成 OAuth；这里展示访问前置条件，
          // 能力是否实际调用成功由观测字段单独维护，不再误报成“个人授权待处理”。
          personalAuthorizationStatus: effective ? 'not_required' : 'not_applicable',
          agentCapabilityStatus: capabilityStatus,
          capabilityCheckedAt: observed?.checkedAt ?? null,
        };
      })
      .sort((a, b) => a.userId.localeCompare(b.userId));

    const effectiveUsers = organizationUsers.filter((item) => item.authorized);

    const effectiveAgents = agents
      .map((agent) => {
        const effective = effectiveBySubject.get(`agent:${agent.id}`);
        if (!effective) return null;
        const capabilityStatus = agentAllowsAnyCapability(
          agent.runtime,
          input.systemId,
          input.capabilityIds,
        )
          ? 'waiting_user_authorization'
          : 'restricted';
        return {
          agentId: agent.id,
          name: agent.name,
          source: effective.bindings.some((item) => item.assigneeType === 'agent')
            ? 'direct'
            : 'policy',
          capabilityStatus,
        } as const;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.agentId.localeCompare(b.agentId));

    const query = input.query?.trim().toLocaleLowerCase('zh-CN') ?? '';
    const filteredUsers = query
      ? organizationUsers.filter((item) =>
          `${item.displayName}\n${item.username}`.toLocaleLowerCase('zh-CN').includes(query),
        )
      : organizationUsers;
    const filteredAgents = query
      ? effectiveAgents.filter((item) => item.name.toLocaleLowerCase('zh-CN').includes(query))
      : effectiveAgents;
    const all = input.kind === 'agent' ? filteredAgents : filteredUsers;
    const after = input.cursor ? decodeCursor(input.cursor) : '';
    const cursorKey = (item: (typeof all)[number]) =>
      'userId' in item ? item.userId : item.agentId;
    const page = all.filter((item) => cursorKey(item) > after).slice(0, input.limit + 1);
    const rows = page.slice(0, input.limit);
    return {
      summary: {
        effectiveUserCount: effectiveUsers.length,
        verifiedUsableUserCount: effectiveUsers.filter(
          (item) => item.agentCapabilityStatus === 'ready',
        ).length,
        effectiveAgentCount: effectiveAgents.length,
        restrictedAgentCount: effectiveAgents.filter(
          (item) => item.capabilityStatus === 'restricted',
        ).length,
        pendingPersonalAuthorizationCount: 0,
        ruleCount: assignmentSet?.assignments.length ?? 0,
      },
      users: input.kind === 'user' ? rows : [],
      agents: input.kind === 'agent' ? rows : [],
      nextCursor:
        page.length > input.limit && rows.length
          ? Buffer.from(JSON.stringify({ id: cursorKey(rows.at(-1)!) })).toString('base64url')
          : null,
    };
  }
}

function agentAllowsAnyCapability(
  runtime: unknown,
  systemId: string,
  capabilityIds: string[],
): boolean {
  const policy = normalizeOrgAgentRuntimePolicy(runtime);
  const systemSegment = normalizeToolSegment(systemId);
  if (policy.apps.systemAllowlist && !policy.apps.systemAllowlist.includes(systemSegment))
    return false;
  if (policy.apps.denySystems.includes(systemSegment)) return false;
  return capabilityIds.some((capabilityId) => {
    const capabilitySegment = normalizeToolSegment(capabilityId);
    const name = toolName(systemId, capabilityId);
    if (
      policy.apps.capabilityAllowlist &&
      !policy.apps.capabilityAllowlist.includes(capabilitySegment) &&
      !policy.apps.capabilityAllowlist.includes(name)
    )
      return false;
    if (
      policy.apps.denyCapabilities.includes(capabilitySegment) ||
      policy.apps.denyCapabilities.includes(name)
    )
      return false;
    if (policy.tools.allowlist && !policy.tools.allowlist.includes(name)) return false;
    return !policy.tools.denylist.includes(name);
  });
}

function decodeCursor(cursor: string): string {
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { id?: unknown };
  if (typeof value.id !== 'string') throw new Error('invalid cursor');
  return value.id;
}
