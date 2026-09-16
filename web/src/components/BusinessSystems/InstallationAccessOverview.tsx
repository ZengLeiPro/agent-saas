import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { governanceAccessApi } from '@agent/shared/lib/governanceApi';
import { installationPath } from '@/lib/kyAppManagementApi';
import { businessStatusLabel } from './presentation';
import { previewResourceAssignment, updateResourceAssignment } from './installationAssignmentApi';
import { ResourceState, useManagementResource } from './ManagementResource';

interface AssignmentRule {
  assigneeType: 'everyone' | 'user' | 'directory_group' | 'agent';
  assigneeId?: string;
  effect: 'allow' | 'deny';
}

interface AssignmentSet {
  version: number;
  assignments: Array<AssignmentRule & { assignmentId?: string; origin?: string }>;
}

interface AssignmentPreview {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  impact?: { addedUserCount?: number; removedUserCount?: number; effectiveUserCount?: number };
}

interface AccessOverview {
  summary: {
    effectiveUserCount: number;
    verifiedUsableUserCount: number;
    effectiveAgentCount: number;
    restrictedAgentCount: number;
    pendingPersonalAuthorizationCount: number;
    ruleCount: number;
  };
  users: Array<{
    userId: string;
    displayName: string;
    username: string;
    authorized: boolean;
    departmentNames: string[];
    accessSources: string[];
    personalAuthorizationStatus: string;
    agentCapabilityStatus: string;
    capabilityCheckedAt: string | null;
  }>;
  agents: Array<{ agentId: string; name: string; source: string; capabilityStatus: string }>;
  nextCursor: string | null;
}

export function buildMemberAccessRules(
  assignments: AssignmentSet['assignments'],
  userId: string,
  authorize: boolean,
): AssignmentRule[] {
  return buildBulkMemberAccessRules(assignments, [userId], authorize);
}

export function buildBulkMemberAccessRules(
  assignments: AssignmentSet['assignments'],
  userIds: string[],
  authorize: boolean,
): AssignmentRule[] {
  const selectedIds = new Set(userIds);
  const rules = assignments
    .filter((rule) => !(rule.assigneeType === 'user' && selectedIds.has(rule.assigneeId ?? '')))
    .map(({ assigneeType, assigneeId, effect }) => ({
      assigneeType,
      ...(assigneeType === 'everyone' ? {} : { assigneeId }),
      effect,
    }));
  for (const userId of selectedIds) {
    rules.push({ assigneeType: 'user', assigneeId: userId, effect: authorize ? 'allow' : 'deny' });
  }
  return rules;
}

export function InstallationAccessOverview({
  installationId,
  tenantId,
}: {
  installationId: string;
  tenantId: string;
}) {
  const [kind, setKind] = useState<'user' | 'agent'>('user');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [pendingChange, setPendingChange] = useState<{
    users: AccessOverview['users'];
    authorize: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [command, setCommand] = useState<{
    expectedVersion: number;
    assignments: AssignmentRule[];
  } | null>(null);
  const [busyKey, setBusyKey] = useState('');
  const [mutationError, setMutationError] = useState('');
  const resource = useManagementResource<AccessOverview>(
    `${installationPath(installationId, '/access-overview')}?${new URLSearchParams({ kind, ...(appliedQuery ? { query: appliedQuery } : {}), ...(cursor ? { cursor } : {}) })}`,
  );

  async function prepareMemberChange(users: AccessOverview['users'], authorize: boolean) {
    if (busyKey || users.length === 0) return;
    const operationKey = users.length === 1 ? users[0].userId : 'bulk';
    setBusyKey(operationKey);
    setMutationError('');
    try {
      const baseline = await governanceAccessApi.getAssignment<AssignmentSet>(
        'system_installation',
        installationId,
        tenantId,
      );
      const nextCommand = {
        expectedVersion: baseline.version,
        assignments: buildBulkMemberAccessRules(
          baseline.assignments,
          users.map((user) => user.userId),
          authorize,
        ),
      };
      const nextPreview = await previewResourceAssignment<AssignmentPreview>(
        'system_installation',
        installationId,
        nextCommand,
        tenantId,
      );
      setCommand(nextCommand);
      setPreview(nextPreview);
      setPendingChange({ users, authorize });
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : '无法预览成员授权变更');
    } finally {
      setBusyKey('');
    }
  }

  async function commitMemberChange() {
    if (!pendingChange || !preview || !command || busyKey) return;
    setBusyKey(pendingChange.users.length === 1 ? pendingChange.users[0].userId : 'bulk');
    setMutationError('');
    try {
      await updateResourceAssignment(
        'system_installation',
        installationId,
        { ...command, ...preview },
        tenantId,
      );
      setPendingChange(null);
      setPreview(null);
      setCommand(null);
      setSelectedUserIds(new Set());
      resource.reload();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : '成员授权变更失败');
    } finally {
      setBusyKey('');
    }
  }
  const selectableUsers = resource.data?.users.filter((user) => !user.authorized) ?? [];
  const selectedUsers = selectableUsers.filter((user) => selectedUserIds.has(user.userId));
  const allSelectableSelected =
    selectableUsers.length > 0 && selectedUsers.length === selectableUsers.length;
  const someSelectableSelected = selectedUsers.length > 0 && !allSelectableSelected;
  return (
    <section className="space-y-3 rounded border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">成员授权</h3>
          <p className="text-xs text-muted-foreground">
            查看组织成员当前状态，并可逐行或批量授权。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {kind === 'user' ? (
            <Button
              type="button"
              size="sm"
              disabled={selectedUsers.length === 0 || Boolean(busyKey)}
              onClick={() => void prepareMemberChange(selectedUsers, true)}
            >
              {busyKey === 'bulk'
                ? '处理中…'
                : `批量授权${selectedUsers.length ? `（${selectedUsers.length}）` : ''}`}
            </Button>
          ) : null}
          <div className="flex gap-2" role="tablist" aria-label="授权对象">
            <Button
              size="sm"
              role="tab"
              aria-selected={kind === 'user'}
              variant={kind === 'user' ? 'default' : 'outline'}
              onClick={() => {
                setKind('user');
                setCursor('');
                setCursorHistory([]);
                setSelectedUserIds(new Set());
              }}
            >
              成员
            </Button>
            <Button
              size="sm"
              role="tab"
              aria-selected={kind === 'agent'}
              variant={kind === 'agent' ? 'default' : 'outline'}
              onClick={() => {
                setKind('agent');
                setCursor('');
                setCursorHistory([]);
                setSelectedUserIds(new Set());
              }}
            >
              智能体
            </Button>
          </div>
        </div>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedQuery(query.trim());
          setCursor('');
          setCursorHistory([]);
          setSelectedUserIds(new Set());
        }}
      >
        <Input
          aria-label="搜索授权对象"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索姓名或账号"
        />
        <Button type="submit" variant="outline">
          搜索
        </Button>
      </form>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            已授权成员 {resource.data.summary.effectiveUserCount} 人 · 已授权智能体{' '}
            {resource.data.summary.effectiveAgentCount} 个 · 已验证可调用成员{' '}
            {resource.data.summary.verifiedUsableUserCount} 人
          </p>
          {kind === 'user' ? (
            resource.data.users.length === 0 ? (
              <p>尚未授权任何成员或 Agent</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th className="w-10">
                        <Checkbox
                          aria-label="选择本页未授权成员"
                          checked={someSelectableSelected ? 'indeterminate' : allSelectableSelected}
                          disabled={selectableUsers.length === 0 || Boolean(busyKey)}
                          onCheckedChange={(checked) =>
                            setSelectedUserIds(
                              checked === true
                                ? new Set(selectableUsers.map((user) => user.userId))
                                : new Set(),
                            )
                          }
                        />
                      </th>
                      <th>用户</th>
                      <th>所属部门</th>
                      <th>个人授权</th>
                      <th className="text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resource.data.users.map((item) => (
                      <tr className="border-t" key={item.userId}>
                        <td>
                          <Checkbox
                            aria-label={`选择${item.displayName}`}
                            checked={selectedUserIds.has(item.userId)}
                            disabled={item.authorized || Boolean(busyKey)}
                            onCheckedChange={(checked) => {
                              const next = new Set(selectedUserIds);
                              if (checked === true) next.add(item.userId);
                              else next.delete(item.userId);
                              setSelectedUserIds(next);
                            }}
                          />
                        </td>
                        <td className="py-2">
                          {item.displayName}
                          <div className="text-xs text-muted-foreground">{item.username}</div>
                        </td>
                        <td>{item.departmentNames.join('、') || '未分组'}</td>
                        <td>
                          {item.authorized
                            ? businessStatusLabel(item.personalAuthorizationStatus)
                            : '—'}
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant={item.authorized ? 'outline' : 'default'}
                            disabled={Boolean(busyKey)}
                            onClick={() => void prepareMemberChange([item], !item.authorized)}
                          >
                            {busyKey === item.userId
                              ? '处理中…'
                              : item.authorized
                                ? '取消授权'
                                : '授权'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : resource.data.agents.length === 0 ? (
            <p>尚未授权任何成员或 Agent</p>
          ) : (
            <ul className="divide-y">
              {resource.data.agents.map((item) => (
                <li className="flex items-center justify-between py-2 text-sm" key={item.agentId}>
                  <span>{item.name}</span>
                  <span>
                    {businessStatusLabel(item.source)} ·{' '}
                    {businessStatusLabel(item.capabilityStatus)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={cursorHistory.length === 0}
              onClick={() => {
                const history = [...cursorHistory];
                setCursor(history.pop() ?? '');
                setCursorHistory(history);
                setSelectedUserIds(new Set());
              }}
            >
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!resource.data.nextCursor}
              onClick={() => {
                if (!resource.data?.nextCursor) return;
                setCursorHistory((history) => [...history, cursor]);
                setCursor(resource.data.nextCursor);
                setSelectedUserIds(new Set());
              }}
            >
              下一页
            </Button>
          </div>
          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
        </>
      )}
      <Dialog
        open={Boolean(pendingChange && preview)}
        onOpenChange={(open) => {
          if (!open && !busyKey) {
            setPendingChange(null);
            setPreview(null);
            setCommand(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingChange?.authorize
                ? pendingChange.users.length > 1
                  ? '批量授权成员'
                  : '授权成员'
                : '取消成员授权'}
            </DialogTitle>
            <DialogDescription>
              {pendingChange?.users.length && pendingChange.users.length > 1
                ? `确认授权选中的 ${pendingChange.users.length} 名成员访问该业务系统？`
                : pendingChange?.authorize
                  ? `确认授权“${pendingChange.users[0]?.displayName ?? ''}”访问该业务系统？`
                  : `确认取消“${pendingChange?.users[0]?.displayName ?? ''}”访问该业务系统的权限？`}
            </DialogDescription>
          </DialogHeader>
          {preview?.impact ? (
            <p className="text-sm text-muted-foreground">
              变更后预计授权 {preview.impact.effectiveUserCount ?? 0} 人，新增{' '}
              {preview.impact.addedUserCount ?? 0} 人，移除 {preview.impact.removedUserCount ?? 0}{' '}
              人。
            </p>
          ) : null}
          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={Boolean(busyKey)}
              onClick={() => setPendingChange(null)}
            >
              取消
            </Button>
            <Button disabled={Boolean(busyKey)} onClick={() => void commitMemberChange()}>
              {busyKey ? '提交中…' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
