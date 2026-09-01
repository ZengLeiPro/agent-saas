import { parseConfigIdentitySummary } from '@agent/shared';
import { Fingerprint } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { formatTime } from '../format';
import type { OverviewConfigIdentity } from '../types';

/**
 * 「配置身份」区块（TASK-318，平台分析 -> 平台概览）。
 *
 * 只读：只展示 Release expected 与 Runtime observed 的四态判定与安全摘要
 * （digest 短摘要、schema version、观察/变化时间）；不提供修改配置、
 * 接受漂移、发布/回滚或查看 raw config / secret ref 的入口。
 * null/unknown 一律显式渲染为状态，绝不显示成「一致」。
 */

const STATUS_LABEL: Record<OverviewConfigIdentity['status'], string> = {
  consistent: '一致',
  drifted: '漂移',
  unverifiable: '不可验证',
  not_collected: '未采集',
};

const STATUS_TONE: Record<OverviewConfigIdentity['status'], string> = {
  consistent: 'bg-success/10 text-success-ink',
  drifted: 'bg-destructive/10 text-destructive',
  unverifiable: 'bg-warning/10 text-warning-ink',
  not_collected: 'bg-muted text-muted-foreground',
};

const REASON_HINT: Record<NonNullable<OverviewConfigIdentity['reason']>, string> = {
  expected_not_bound: 'Release 期望配置身份未绑定：本次运行未携带发布期计算的 expected identity。',
  secret_ref_version_unresolved: '受管凭据的 SecretVault 版本不可解析，无法完成一致性判定。',
  schema_version_unsupported: '配置身份 schema 版本不受当前页面支持，需要升级后再判断。',
};

function shortDigest(digest: string | null | undefined): string {
  if (!digest) return '—';
  return digest.length > 19 ? `${digest.slice(0, 19)}…` : digest;
}

function StatusBadge({ status }: { status: OverviewConfigIdentity['status'] }) {
  return (
    <span
      data-testid="config-identity-status"
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        STATUS_TONE[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function Field({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs tabular-nums" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

export function ConfigIdentityCard({
  identity,
  className,
}: {
  identity: OverviewConfigIdentity | null | undefined;
  className?: string;
}) {
  // 客户端同样执行 wire 校验：旧 schema / 缺字段 / 未知状态不能被渲染成正常值。
  const safeIdentity = parseConfigIdentitySummary(identity);
  // 后端未接入 / 接口失败时 identity 为空：显式「未采集」，不渲染成正常一致。
  const status: OverviewConfigIdentity['status'] = safeIdentity?.status ?? 'not_collected';
  const reason = safeIdentity?.reason;
  return (
    <Card density="compact" className={className} data-testid="config-identity-card">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="size-4" />
          配置身份
        </CardTitle>
        <StatusBadge status={status} />
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div className="text-xs text-muted-foreground">
          Release 期望配置与 Runtime 实际配置的一致性（只读，不含任何敏感值）。
        </div>
        {reason && (
          <div
            data-testid="config-identity-reason"
            className="rounded-md bg-warning/10 p-2 text-xs text-warning-ink"
          >
            {REASON_HINT[reason]}
          </div>
        )}
        <div data-testid="config-identity-fields" className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          <Field
            label="Release ID"
            value={safeIdentity?.releaseId ?? '—'}
            testId="config-identity-release-id"
          />
          <Field
            label="Schema 版本"
            value={
              (safeIdentity?.observed?.schemaVersion ?? safeIdentity?.expected?.schemaVersion)
                ? String(
                    safeIdentity.observed?.schemaVersion ?? safeIdentity.expected?.schemaVersion,
                  )
                : '—'
            }
            testId="config-identity-schema-version"
          />
          <Field
            label="期望摘要"
            value={shortDigest(safeIdentity?.expected?.digest)}
            testId="config-identity-expected"
          />
          <Field
            label="实际摘要"
            value={shortDigest(safeIdentity?.observed?.digest)}
            testId="config-identity-observed"
          />
          <Field
            label="最近观察"
            value={safeIdentity?.lastObservedAt ? formatTime(safeIdentity.lastObservedAt) : '—'}
            testId="config-identity-last-observed"
          />
          <Field
            label="最近变化"
            value={safeIdentity?.lastChangedAt ? formatTime(safeIdentity.lastChangedAt) : '—'}
            testId="config-identity-last-changed"
          />
        </div>
        {status === 'drifted' && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            实际生效配置与本次 Release
            绑定的期望配置不一致；常见原因是配置热更新或凭据轮换。请核对配置变更记录后再决定是否重新发布。
          </div>
        )}
      </CardContent>
    </Card>
  );
}
