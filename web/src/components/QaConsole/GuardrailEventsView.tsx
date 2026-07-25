import { useCallback, useMemo } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { AdminSelect, type AdminSelectOption } from '@/components/ui/admin-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { HISTORY_PUSH, HISTORY_PUSH_MERGED, useAdminUrlQuery } from '@/hooks/useAdminUrlQuery';
import { cn } from '@/lib/utils';
import type { OrgAgentRecord } from '@agent/shared';
import { useQaGuardrailEvents } from './hooks';
import { QaUnavailableHint, formatQaTime, orgAgentSelectOptions } from './shared';

const VERDICT_OPTIONS: AdminSelectOption[] = [
  { value: '', label: '全部' },
  { value: 'off_topic', label: '范围外拒绝' },
  { value: 'pass_flagged', label: '放行打标' },
];

/** 门禁拒绝/打标日志视图（offset 分页，仿 AuditEventsPanel 上/下一页）——拒绝记录即需求雷达 */
export function GuardrailEventsView({ tenantId, orgAgents }: { tenantId?: string; orgAgents: OrgAgentRecord[] }) {
  // URL 参数契约（客户视图）：`qaLog*` 前缀，与会话记录视图的 `qa*` 分开，切视图互不干扰
  const url = useAdminUrlQuery();
  const orgAgentId = url.get('qaLogAgent') ?? '';
  const rawResult = url.get('qaLogResult');
  const verdict: '' | 'off_topic' | 'pass_flagged' =
    rawResult === 'off_topic' || rawResult === 'pass_flagged' ? rawResult : '';
  const startDate = url.get('qaLogFrom') ?? '';
  const endDate = url.get('qaLogTo') ?? '';
  const setOrgAgentId = useCallback((value: string) => url.set('qaLogAgent', value || null, HISTORY_PUSH), [url]);
  const setVerdict = useCallback((value: string) => url.set('qaLogResult', value || null, HISTORY_PUSH), [url]);
  const setStartDate = useCallback((value: string) => url.set('qaLogFrom', value || null, HISTORY_PUSH_MERGED), [url]);
  const setEndDate = useCallback((value: string) => url.set('qaLogTo', value || null, HISTORY_PUSH_MERGED), [url]);

  const filter = useMemo(() => ({
    tenantId,
    orgAgentId: orgAgentId || undefined,
    verdict: verdict || undefined,
    from: startDate ? new Date(startDate).toISOString() : undefined,
    to: endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined,
  }), [tenantId, orgAgentId, verdict, startDate, endDate]);

  const { events, total, offset, limit, loading, error, availability, refresh, nextPage, prevPage } = useQaGuardrailEvents(filter);
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
            <Label>判定</Label>
            <AdminSelect
              ariaLabel="判定"
              size="md"
              className="w-full"
              options={VERDICT_OPTIONS}
              value={verdict}
              onValueChange={(value) => setVerdict(value as '' | 'off_topic' | 'pass_flagged')}
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

      {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">门禁记录</CardTitle>
          <div className="text-xs text-muted-foreground">
            {total > 0 ? `${offset + 1}-${Math.min(offset + events.length, total)} / ${total}` : '0 条'}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && events.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />加载门禁记录...
            </div>
          ) : events.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">暂无门禁记录</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>成员</TableHead>
                  <TableHead>企业专家</TableHead>
                  <TableHead>判定</TableHead>
                  <TableHead>提问内容</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatQaTime(event.createdAt)}</TableCell>
                    <TableCell className="text-sm">{event.username || event.userId || '-'}</TableCell>
                    <TableCell className="text-sm">{agentNameById.get(event.orgAgentId) || event.orgAgentId}</TableCell>
                    <TableCell>
                      {event.verdict === 'off_topic' ? (
                        <Badge variant="danger">范围外拒绝</Badge>
                      ) : (
                        <Badge variant="warning">放行打标</Badge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-md truncate text-sm" title={event.messageText}>{event.messageText}</TableCell>
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
