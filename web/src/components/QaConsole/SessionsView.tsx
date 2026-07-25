import { useCallback, useMemo, useState } from 'react';
import { Loader2, MessageSquareOff, RefreshCw } from 'lucide-react';
import { AdminSelect, type AdminSelectOption } from '@/components/ui/admin-select';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/PlatformAdmin/common';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useUsers } from '@/components/UserManager/hooks';
import { HISTORY_PUSH, HISTORY_PUSH_MERGED, useAdminUrlQuery } from '@/hooks/useAdminUrlQuery';
import { cn } from '@/lib/utils';
import type { OrgAgentRecord } from '@agent/shared';
import { useQaSessions } from './hooks';
import { SessionDetailDialog } from './SessionDetailDialog';
import { QaCopyableId, QaErrorNotice, QaUnavailableHint, formatQaTime, orgAgentSelectOptions } from './shared';
import { formatRunStatus } from '@/components/PlatformAdmin/displayText';
import type { QaSessionItem } from './types';

/** 专职 Agent 会话列表视图：Agent/成员/时间过滤 + cursor 加载更多 + 行点击开详情 */
export function SessionsView({ tenantId, orgAgents }: { tenantId?: string; orgAgents: OrgAgentRecord[] }) {
  const { users } = useUsers();
  // URL 参数契约（客户视图）：业务可读词，不暴露内部字段名（orgAgentId → qaAgent、userId → qaMember）
  const url = useAdminUrlQuery();
  const orgAgentId = url.get('qaAgent') ?? '';
  const userId = url.get('qaMember') ?? '';
  const startDate = url.get('qaFrom') ?? '';
  const endDate = url.get('qaTo') ?? '';
  const setOrgAgentId = useCallback((value: string) => url.set('qaAgent', value || null, HISTORY_PUSH), [url]);
  const setUserId = useCallback((value: string) => url.set('qaMember', value || null, HISTORY_PUSH), [url]);
  const setStartDate = useCallback((value: string) => url.set('qaFrom', value || null, HISTORY_PUSH_MERGED), [url]);
  const setEndDate = useCallback((value: string) => url.set('qaTo', value || null, HISTORY_PUSH_MERGED), [url]);
  const [detailSession, setDetailSession] = useState<QaSessionItem | null>(null);
  // 空态要能分辨「真的没有」和「被筛没了」，后者必须给一条退路
  const hasFilters = Boolean(orgAgentId) || Boolean(userId) || Boolean(startDate) || Boolean(endDate);
  const clearFilters = useCallback(() => {
    url.patch({ qaAgent: null, qaMember: null, qaFrom: null, qaTo: null }, HISTORY_PUSH);
  }, [url]);


  const tenantUsers = useMemo(
    () => (tenantId ? users.filter((user) => user.tenantId === tenantId) : users),
    [tenantId, users],
  );
  const userOptions = useMemo<AdminSelectOption[]>(() => [
    { value: '', label: '全部' },
    ...tenantUsers.map((user) => ({ value: user.id, label: user.realName || user.username })),
  ], [tenantUsers]);

  const filter = useMemo(() => ({
    tenantId,
    orgAgentId: orgAgentId || undefined,
    userId: userId || undefined,
    from: startDate ? new Date(startDate).toISOString() : undefined,
    to: endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined,
  }), [tenantId, orgAgentId, userId, startDate, endDate]);

  const { items, loading, error, availability, hasMore, loadMore, refresh } = useQaSessions(filter);

  if (availability === 'unavailable') return <QaUnavailableHint />;

  return (
    <div className="w-full space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">筛选条件</CardTitle>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('mr-2 size-3.5', loading && 'animate-spin')} />刷新
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5">
            <Label>企业专家</Label>
            <AdminSelect
              ariaLabel="企业专家"
              size="md"
              className="w-full"
              options={orgAgentSelectOptions(orgAgents)}
              value={orgAgentId}
              onValueChange={setOrgAgentId}
            />
          </div>
          <div className="space-y-1.5">
            <Label>成员</Label>
            <AdminSelect
              ariaLabel="成员"
              size="md"
              className="w-full"
              options={userOptions}
              value={userId}
              onValueChange={setUserId}
            />
          </div>
          <div className="space-y-1.5">
            <Label>开始日期</Label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>结束日期</Label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {error && <QaErrorNotice error={error} onRetry={refresh} />}

      <Card>
        <CardContent className="p-0">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />加载会话...
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              compact
              icon={MessageSquareOff}
              title={hasFilters ? '当前筛选条件下没有会话' : '还没有企业专家会话'}
              description={hasFilters
                ? '换个专家或放宽时间范围再看看。'
                : '成员开始与企业专家对话后，会话会出现在这里。'}
              action={hasFilters ? { label: '清除筛选', onClick: clearFilters } : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>会话</TableHead>
                  <TableHead>成员</TableHead>
                  <TableHead>企业专家</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>最近活跃</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={item.sessionId}
                    className="cursor-pointer"
                    onClick={() => setDetailSession(item)}
                  >
                    <TableCell>
                      <div className="max-w-sm truncate text-sm font-medium">{item.title || '未命名会话'}</div>
                      <QaCopyableId id={item.sessionId} />
                    </TableCell>
                    <TableCell className="text-sm">{item.username || item.userId || '—'}</TableCell>
                    <TableCell className="text-sm">
                      {item.orgAgentAvatar ? `${item.orgAgentAvatar} ` : ''}{item.orgAgentName || item.orgAgentId || '—'}
                    </TableCell>
                    {/* 状态走中文映射：改造前直接显示 running / completed 这类英文原值 */}
                    <TableCell className="text-xs text-muted-foreground">
                      {item.runtimeStatus ? formatRunStatus(item.runtimeStatus) : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatQaTime(item.updatedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? '加载中...' : '加载更多'}
          </Button>
        </div>
      )}

      <SessionDetailDialog session={detailSession} onClose={() => setDetailSession(null)} />
    </div>
  );
}
