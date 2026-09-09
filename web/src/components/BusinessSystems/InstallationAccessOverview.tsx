import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
  const rules = assignments
    .filter((rule) => !(rule.assigneeType === 'user' && rule.assigneeId === userId))
    .map(({ assigneeType, assigneeId, effect }) => ({
      assigneeType,
      ...(assigneeType === 'everyone' ? {} : { assigneeId }),
      effect,
    }));
  rules.push({ assigneeType: 'user', assigneeId: userId, effect: authorize ? 'allow' : 'deny' });
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
  const [pendingUser, setPendingUser] = useState<AccessOverview['users'][number] | null>(null);
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [command, setCommand] = useState<{
    expectedVersion: number;
    assignments: AssignmentRule[];
  } | null>(null);
  const [busyUserId, setBusyUserId] = useState('');
  const [mutationError, setMutationError] = useState('');
  const resource = useManagementResource<AccessOverview>(
    `${installationPath(installationId, '/access-overview')}?${new URLSearchParams({ kind, ...(appliedQuery ? { query: appliedQuery } : {}), ...(cursor ? { cursor } : {}) })}`,
  );

  async function prepareMemberChange(user: AccessOverview['users'][number]) {
    if (busyUserId) return;
    setBusyUserId(user.userId);
    setMutationError('');
    try {
      const baseline = await governanceAccessApi.getAssignment<AssignmentSet>(
        'system_installation',
        installationId,
        tenantId,
      );
      const nextCommand = {
        expectedVersion: baseline.version,
        assignments: buildMemberAccessRules(baseline.assignments, user.userId, !user.authorized),
      };
      const nextPreview = await previewResourceAssignment<AssignmentPreview>(
        'system_installation',
        installationId,
        nextCommand,
        tenantId,
      );
      setCommand(nextCommand);
      setPreview(nextPreview);
      setPendingUser(user);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : '无法预览成员授权变更');
    } finally {
      setBusyUserId('');
    }
  }

  async function commitMemberChange() {
    if (!pendingUser || !preview || !command || busyUserId) return;
    setBusyUserId(pendingUser.userId);
    setMutationError('');
    try {
      await updateResourceAssignment(
        'system_installation',
        installationId,
        { ...command, ...preview },
        tenantId,
      );
      setPendingUser(null);
      setPreview(null);
      setCommand(null);
      resource.reload();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : '成员授权变更失败');
    } finally {
      setBusyUserId('');
    }
  }
  return (
    <section className="space-y-3 rounded border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">成员授权</h3>
          <p className="text-xs text-muted-foreground">
            查看组织成员当前状态，并可逐行授权或取消授权。
          </p>
        </div>
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
            }}
          >
            智能体
          </Button>
        </div>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedQuery(query.trim());
          setCursor('');
          setCursorHistory([]);
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
                      <th>用户</th>
                      <th>所属部门</th>
                      <th>个人授权</th>
                      <th className="text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resource.data.users.map((item) => (
                      <tr className="border-t" key={item.userId}>
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
                            disabled={Boolean(busyUserId)}
                            onClick={() => void prepareMemberChange(item)}
                          >
                            {busyUserId === item.userId
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
        open={Boolean(pendingUser && preview)}
        onOpenChange={(open) => {
          if (!open && !busyUserId) {
            setPendingUser(null);
            setPreview(null);
            setCommand(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingUser?.authorized ? '取消成员授权' : '授权成员'}</DialogTitle>
            <DialogDescription>
              {pendingUser?.authorized
                ? `确认取消“${pendingUser.displayName}”访问该业务系统的权限？`
                : `确认授权“${pendingUser?.displayName ?? ''}”访问该业务系统？`}
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
              disabled={Boolean(busyUserId)}
              onClick={() => setPendingUser(null)}
            >
              取消
            </Button>
            <Button disabled={Boolean(busyUserId)} onClick={() => void commitMemberChange()}>
              {busyUserId ? '提交中…' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
