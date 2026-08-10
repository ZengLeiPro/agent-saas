import type { AccessState, ThreeAxisState } from '@agent/shared/types/governance';

import { cn } from '@/lib/utils';

export type GovernanceStatusTone = 'positive' | 'warning' | 'negative' | 'neutral';

const toneClass: Record<GovernanceStatusTone, string> = {
  positive: 'border-success/30 bg-success-subtle text-success-ink',
  warning: 'border-warning/30 bg-warning-subtle text-warning-ink',
  negative: 'border-danger/30 bg-danger-subtle text-danger-ink',
  neutral: 'border-border bg-muted text-muted-foreground',
};

export interface GovernanceStatusBadgeProps {
  label: string;
  tone?: GovernanceStatusTone;
  className?: string;
}

export function GovernanceStatusBadge({
  label,
  tone = 'neutral',
  className,
}: GovernanceStatusBadgeProps) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', toneClass[tone], className)}>
      {label}
    </span>
  );
}

const accessTone: Record<AccessState, GovernanceStatusTone> = {
  allowed: 'positive',
  denied: 'negative',
  needs_assignment: 'warning',
  needs_user_authorization: 'warning',
  runtime_approval_required: 'warning',
};

export interface GovernanceThreeAxisSummaryProps {
  state: ThreeAxisState;
  className?: string;
}

/** Displays each server-owned axis independently; it does not calculate an aggregate permission. */
export function GovernanceThreeAxisSummary({ state, className }: GovernanceThreeAxisSummaryProps) {
  const readinessLabel = state.readiness
    ? (state.readiness.ready ? '就绪' : '未就绪')
    : '未判定';
  const readinessTone: GovernanceStatusTone = state.readiness
    ? (state.readiness.ready ? 'positive' : 'warning')
    : 'neutral';

  return (
    <div className={cn('flex flex-wrap gap-2', className)} aria-label="生命周期、访问与执行就绪状态">
      <GovernanceStatusBadge
        label={`生命周期：${state.lifecycle.state}`}
        tone={state.lifecycle.blocksNewUse ? 'negative' : 'neutral'}
      />
      <GovernanceStatusBadge
        label={`访问：${state.access.accessState}`}
        tone={accessTone[state.access.accessState]}
      />
      <GovernanceStatusBadge label={`执行：${readinessLabel}`} tone={readinessTone} />
    </div>
  );
}
