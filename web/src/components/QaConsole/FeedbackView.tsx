import { useCallback, useMemo } from 'react';
import { Loader2, RefreshCw, ThumbsUp } from 'lucide-react';
import { AdminSelect } from '@/components/ui/admin-select';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/PlatformAdmin/common';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { OrgAgentRecord } from '@agent/shared';
import { HISTORY_PUSH, HISTORY_PUSH_MERGED, useAdminUrlQuery } from '@/hooks/useAdminUrlQuery';
import { useQaFeedback } from './hooks';
import { QaErrorNotice, QaUnavailableHint, formatQaTime, orgAgentSelectOptions } from './shared';

/** 用户反馈标注视图（offset 分页）：员工点「踩」的回答 + 评论 */
export function FeedbackView({ tenantId, orgAgents }: { tenantId?: string; orgAgents: OrgAgentRecord[] }) {
  // URL 参数契约（客户视图）：`qaFeedback*` 前缀
  const url = useAdminUrlQuery();
  const orgAgentId = url.get('qaFeedbackAgent') ?? '';
  const startDate = url.get('qaFeedbackFrom') ?? '';
  const endDate = url.get('qaFeedbackTo') ?? '';
  const setOrgAgentId = useCallback((value: string) => url.set('qaFeedbackAgent', value || null, HISTORY_PUSH), [url]);
  const setStartDate = useCallback((value: string) => url.set('qaFeedbackFrom', value || null, HISTORY_PUSH_MERGED), [url]);
  const setEndDate = useCallback((value: string) => url.set('qaFeedbackTo', value || null, HISTORY_PUSH_MERGED), [url]);

  // 空态要能分辨「真的没有」和「被筛没了」，后者必须给一条退路
  const hasFilters = Boolean(orgAgentId) || Boolean(startDate) || Boolean(endDate);
  const clearFilters = useCallback(() => {
    url.patch({ qaFeedbackAgent: null, qaFeedbackFrom: null, qaFeedbackTo: null }, HISTORY_PUSH);
  }, [url]);

  const filter = useMemo(() => ({
    tenantId,
    orgAgentId: orgAgentId || undefined,
    from: startDate ? new Date(startDate).toISOString() : undefined,
    to: endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined,
  }), [tenantId, orgAgentId, startDate, endDate]);

  const { items, total, offset, limit, loading, error, availability, refresh, nextPage, prevPage } = useQaFeedback(filter);
  const agentNameById = useMemo(() => new Map(orgAgents.map((agent) => [agent.id, agent.name])), [orgAgents]);

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
        <CardContent className="grid gap-3 md:grid-cols-3">
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
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">反馈列表</CardTitle>
          <div className="text-xs text-muted-foreground">
            {total > 0 ? `${offset + 1}-${Math.min(offset + items.length, total)} / ${total}` : '0 条'}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />加载反馈...
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              compact
              icon={ThumbsUp}
              tone={hasFilters ? 'default' : 'positive'}
              title={hasFilters ? '当前筛选条件下没有反馈' : '期间没有收到负面反馈'}
              description={hasFilters
                ? '换个专家或放宽时间范围再看看。'
                : '成员对回答不满意时点「踩」，反馈会出现在这里。'}
              action={hasFilters ? { label: '清除筛选', onClick: clearFilters } : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>成员</TableHead>
                  <TableHead>企业专家</TableHead>
                  <TableHead>被踩回答（摘要）</TableHead>
                  <TableHead>评论</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatQaTime(item.createdAt)}</TableCell>
                    <TableCell className="text-sm">{item.username || item.userId}</TableCell>
                    <TableCell className="text-sm">
                      {item.orgAgentId ? (agentNameById.get(item.orgAgentId) || item.orgAgentId) : '-'}
                    </TableCell>
                    <TableCell className="max-w-md truncate text-sm" title={item.messageExcerpt}>{item.messageExcerpt}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground" title={item.comment || ''}>{item.comment || '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={prevPage} disabled={loading || offset === 0}>上一页</Button>
        <Button variant="outline" size="sm" onClick={nextPage} disabled={loading || offset + limit >= total}>下一页</Button>
      </div>
    </div>
  );
}
