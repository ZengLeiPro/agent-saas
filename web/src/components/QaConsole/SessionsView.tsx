import { useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useUsers } from '@/components/UserManager/hooks';
import { cn } from '@/lib/utils';
import type { OrgAgentRecord } from '@agent/shared';
import { useQaSessions } from './hooks';
import { SessionDetailDialog } from './SessionDetailDialog';
import { QaUnavailableHint, formatQaTime } from './shared';
import type { QaSessionItem } from './types';

/** 专职 Agent 会话列表视图：Agent/成员/时间过滤 + cursor 加载更多 + 行点击开详情 */
export function SessionsView({ tenantId, orgAgents }: { tenantId?: string; orgAgents: OrgAgentRecord[] }) {
  const { users } = useUsers();
  const [orgAgentId, setOrgAgentId] = useState('');
  const [userId, setUserId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [detailSession, setDetailSession] = useState<QaSessionItem | null>(null);

  const tenantUsers = useMemo(
    () => (tenantId ? users.filter((user) => user.tenantId === tenantId) : users),
    [tenantId, users],
  );

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
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} />刷新
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1.5">
            <Label>专职 Agent</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={orgAgentId} onChange={(e) => setOrgAgentId(e.target.value)}>
              <option value="">全部</option>
              {orgAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>成员</Label>
            <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">全部</option>
              {tenantUsers.map((user) => (
                <option key={user.id} value={user.id}>{user.realName || user.username}</option>
              ))}
            </select>
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

      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <Card>
        <CardContent className="p-0">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />加载会话...
            </div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">暂无专职 Agent 会话</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>会话</TableHead>
                  <TableHead>成员</TableHead>
                  <TableHead>专职 Agent</TableHead>
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
                      <div className="text-xs text-muted-foreground">{item.sessionId.slice(0, 8)}</div>
                    </TableCell>
                    <TableCell className="text-sm">{item.username || item.userId || '-'}</TableCell>
                    <TableCell className="text-sm">
                      {item.orgAgentAvatar ? `${item.orgAgentAvatar} ` : ''}{item.orgAgentName || item.orgAgentId || '-'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{item.runtimeStatus || '-'}</TableCell>
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
