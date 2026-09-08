import type { UserStore } from '../../data/users/store.js';
import type { PgMembershipStore } from '../../data/memberships/store.js';
import type { PgDirectoryGroupStore } from '../../data/directoryGroups/store.js';
import type { OrgAgentStore } from '../../data/orgAgents/store.js';
import type { KyAppAssignmentAccess } from './assignmentAccess.js';
import type { PgAssignmentStore } from '../../data/assignments/store.js';

export interface InstallationAccessOverviewOptions {
  users: Pick<UserStore, 'listAll'>;
  memberships: Pick<PgMembershipStore, 'listMemberships'>;
  assignments: Pick<KyAppAssignmentAccess, 'listEffectiveResourceIds'>;
  assignmentSets: Pick<PgAssignmentStore, 'getAssignmentSet'>;
  groups?: Pick<PgDirectoryGroupStore, 'listGroups' | 'listGroupIdsForUser'>;
  agents?: Pick<OrgAgentStore, 'listByTenant'>;
}

export class InstallationAccessOverviewService {
  constructor(private readonly options: InstallationAccessOverviewOptions) {}

  async read(input: {
    tenantId: string;
    installationId: string;
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
    const effectiveUsers = (
      await Promise.all(
        users.map(async (user) => {
          const effective = await this.options.assignments.listEffectiveResourceIds(
            input.tenantId,
            user.id,
            'system_installation',
          );
          const match = effective.find((item) => item.resourceId === input.installationId);
          if (!match) return null;
          const groupIds =
            (await this.options.groups?.listGroupIdsForUser(input.tenantId, user.id)) ?? [];
          const groupNames = groupRecords
            .filter((group) => groupIds.includes(group.groupId))
            .map((group) => group.displayName);
          const sources = [
            ...new Set(
              match.bindings
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
          return {
            userId: user.id,
            displayName: user.realName ?? user.username,
            username: user.username,
            departmentNames: groupNames,
            accessSources: sources,
            personalAuthorizationStatus: 'not_required',
            agentCapabilityStatus: 'ready',
          };
        }),
      )
    )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.userId.localeCompare(b.userId));

    const effectiveAgents = (
      await Promise.all(
        (this.options.agents?.listByTenant(input.tenantId) ?? [])
          .filter((agent) => agent.enabled)
          .map(async (agent) => {
            const effective = await this.options.assignments.listEffectiveResourceIds(
              input.tenantId,
              '__agent_subject__',
              'system_installation',
              agent.id,
            );
            const match = effective.find((item) => item.resourceId === input.installationId);
            if (!match) return null;
            return {
              agentId: agent.id,
              name: agent.name,
              source: match.bindings.some((item) => item.assigneeType === 'agent')
                ? 'direct'
                : 'policy',
              capabilityStatus: 'ready',
            } as const;
          }),
      )
    )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.agentId.localeCompare(b.agentId));

    const query = input.query?.trim().toLocaleLowerCase('zh-CN') ?? '';
    const filteredUsers = query
      ? effectiveUsers.filter((item) =>
          `${item.displayName}\n${item.username}`.toLocaleLowerCase('zh-CN').includes(query),
        )
      : effectiveUsers;
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
        effectiveAgentCount: effectiveAgents.length,
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

function decodeCursor(cursor: string): string {
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { id?: unknown };
  if (typeof value.id !== 'string') throw new Error('invalid cursor');
  return value.id;
}
