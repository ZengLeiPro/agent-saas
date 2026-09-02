import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { authFetch } from '@/lib/authFetch';
import { cn } from '@/lib/utils';

export interface MemberBudgetAuditEntry {
  id: string;
  userId: string;
  beforeLimitCredits: number | null;
  afterLimitCredits: number | null;
  beforeEnforcementMode?: 'notify' | 'stop_new_runs';
  afterEnforcementMode?: 'notify' | 'stop_new_runs';
  beforePerRunLimitCredits: number | null;
  afterPerRunLimitCredits: number | null;
  beforeActive: boolean;
  afterActive: boolean;
  note: string;
  actorUsername: string;
  createdAt: string;
}

interface MemberLabel {
  userId: string;
  username: string;
  realName?: string;
}

function formatCredits(value: number | null): string {
  if (value === null) return '未设置';
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(2)} 万`;
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatMode(value?: string): string {
  if (value === 'stop_new_runs') return '超额停后续动作';
  if (value === 'notify') return '仅提醒';
  return '—';
}

export function MemberBudgetAuditCard({
  tenantId,
  members,
  refreshToken,
}: {
  tenantId: string;
  members: MemberLabel[];
  refreshToken: unknown;
}) {
  const [entries, setEntries] = useState<MemberBudgetAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const response = await authFetch(
        `/api/admin/billing/member-budget-audit?tenantId=${encodeURIComponent(tenantId)}&limit=100`,
      );
      const data = (await response.json().catch(() => ({}))) as {
        entries?: MemberBudgetAuditEntry[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || '加载预算变更历史失败');
      setEntries(data.entries ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);
  useEffect(() => {
    setEntries([]);
    setError(null);
    void load();
  }, [load, refreshToken]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">员工预算变更历史</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              来自专用预算审计权威接口，保留变更前后值、操作人和原因。
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => {
              void load();
            }}
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            刷新记录
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <div role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {entries.length ? (
          <Table className="min-w-[900px]" containerClassName="max-h-[360px] rounded-lg border">
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>员工</TableHead>
                <TableHead>月度预算</TableHead>
                <TableHead>单 Run 上限</TableHead>
                <TableHead>执行方式</TableHead>
                <TableHead>操作人/原因</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const member = members.find((item) => item.userId === entry.userId);
                return (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(entry.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div>{member?.realName || member?.username || entry.userId}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {entry.userId}
                      </div>
                    </TableCell>
                    <TableCell>
                      {formatCredits(entry.beforeLimitCredits)} →{' '}
                      {formatCredits(entry.afterLimitCredits)}
                    </TableCell>
                    <TableCell>
                      {formatCredits(entry.beforePerRunLimitCredits)} →{' '}
                      {formatCredits(entry.afterPerRunLimitCredits)}
                    </TableCell>
                    <TableCell>
                      {formatMode(entry.beforeEnforcementMode)} →{' '}
                      {formatMode(entry.afterEnforcementMode)}
                    </TableCell>
                    <TableCell>
                      <div>{entry.actorUsername}</div>
                      <div
                        className="max-w-64 truncate text-xs text-muted-foreground"
                        title={entry.note}
                      >
                        {entry.note || '—'}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : !loading && !error ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            暂无预算变更记录。
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
