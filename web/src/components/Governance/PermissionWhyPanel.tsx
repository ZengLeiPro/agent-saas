import type {
  AccessLayer,
  EffectiveResourceView,
} from '@agent/shared/types/governance';

import { GovernanceStatusBadge, GovernanceThreeAxisSummary } from './GovernanceStatusBadge';

const LAYERS: AccessLayer[] = [
  'invariant',
  'entitlement',
  'persona',
  'tenant_policy',
  'assignment',
  'long_term_grant',
  'runtime_approval',
];

const layerLabel: Record<AccessLayer, string> = {
  invariant: '系统不变量',
  entitlement: '租户权益',
  persona: '身份角色',
  tenant_policy: '租户策略',
  assignment: '资源分配',
  long_term_grant: '长期授权',
  runtime_approval: '运行时审批',
};

const resultTone = {
  pass: 'positive',
  deny: 'negative',
  condition: 'warning',
  not_applicable: 'neutral',
} as const;

const resultLabel = {
  pass: '通过',
  deny: '拒绝',
  condition: '有条件',
  not_applicable: '不适用',
} as const;

export interface PermissionWhyPanelProps {
  evaluation: EffectiveResourceView;
  className?: string;
}

function formatEvaluatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function PermissionWhyPanel({ evaluation, className = '' }: PermissionWhyPanelProps) {
  const { access, readiness } = evaluation;
  const chainByLayer = new Map(access.chain.map((step) => [step.layer, step]));
  const versions = [
    ['成员关系', access.policySnapshot.membershipVersion],
    ['租户权益', access.policySnapshot.entitlementVersion],
    ['租户策略', access.policySnapshot.tenantPolicyVersion],
    ['资源分配', access.policySnapshot.assignmentVersion],
    ['授权代次', access.policySnapshot.grantGeneration],
  ] as const;

  return (
    <section className={`rounded-lg border border-border bg-card p-5 text-card-foreground ${className}`} aria-labelledby={`permission-why-${access.decisionId}`}>
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">权威治理结论</p>
        <h2 id={`permission-why-${access.decisionId}`} className="mt-1 text-lg font-semibold">
          {evaluation.primaryResult.label}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{access.reason}</p>
        <GovernanceThreeAxisSummary state={evaluation} className="mt-3" />
      </header>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section aria-labelledby={`access-axis-${access.decisionId}`}>
          <h3 id={`access-axis-${access.decisionId}`} className="text-sm font-semibold">Access · 访问判定</h3>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">判定</dt><dd>{access.verdict}</dd>
            <dt className="text-muted-foreground">决定层</dt><dd>{layerLabel[access.decisiveLayer]}</dd>
            <dt className="text-muted-foreground">原因码</dt><dd>{access.reasonCode}</dd>
          </dl>
        </section>

        <section aria-labelledby={`readiness-axis-${access.decisionId}`}>
          <h3 id={`readiness-axis-${access.decisionId}`} className="text-sm font-semibold">Readiness · 执行就绪</h3>
          {readiness ? (
            <div className="mt-2 text-sm">
              <GovernanceStatusBadge label={readiness.ready ? '已就绪' : '未就绪'} tone={readiness.ready ? 'positive' : 'warning'} />
              {readiness.blockers.length ? (
                <ul className="mt-2 space-y-1">
                  {readiness.blockers.map((blocker) => (
                    <li key={`${blocker.code}-${blocker.message}`}>
                      <span className="font-medium">{blocker.code}</span>：{blocker.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : <p className="mt-2 text-sm text-muted-foreground">本次未返回执行预检。</p>}
        </section>
      </div>

      <section className="mt-5" aria-labelledby={`chain-${access.decisionId}`}>
        <h3 id={`chain-${access.decisionId}`} className="text-sm font-semibold">7 层访问链</h3>
        <ol className="mt-2 space-y-2">
          {LAYERS.map((layer, index) => {
            const step = chainByLayer.get(layer);
            return (
              <li key={layer} className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
                <span className="text-muted-foreground" aria-hidden="true">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{layerLabel[layer]}</span>
                    {step ? <GovernanceStatusBadge label={resultLabel[step.result]} tone={resultTone[step.result]} /> : <GovernanceStatusBadge label="权威响应未返回此层" />}
                  </div>
                  {step ? <p className="mt-1 text-muted-foreground">{step.label} · {step.code}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <footer className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
        <p>策略版本：{versions.filter(([, version]) => version !== undefined).map(([label, version]) => `${label} v${version}`).join(' · ')}</p>
        <p className="mt-1">判定时间：<time dateTime={access.evaluatedAt}>{formatEvaluatedAt(access.evaluatedAt)}</time></p>
      </footer>
    </section>
  );
}
