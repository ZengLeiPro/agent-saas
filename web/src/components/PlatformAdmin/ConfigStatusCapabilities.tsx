import { ArrowRight, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';

import { CAPABILITY_LABELS, CAPABILITY_SOURCES } from './configStatusTargets';
import { formatTime } from './format';
import type {
  CapabilityReadiness,
  CapabilityState,
  CapabilityVerification,
  EffectiveConfigStatus,
} from './types';

const STATE_PRESENTATION: Record<
  CapabilityState,
  { label: string; action: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'muted' }
> = {
  disabled: { label: '已配置未启用', action: '启用', variant: 'muted' },
  incomplete: { label: '缺少配置', action: '配置并启用', variant: 'warning' },
  validating: { label: '验证中', action: '查看进度', variant: 'info' },
  ready: { label: '验证通过待启用', action: '启用', variant: 'info' },
  enabled: { label: '已启用', action: '查看配置', variant: 'success' },
  degraded: { label: '运行异常', action: '检查并修复', variant: 'danger' },
  blocked: { label: '受阻塞', action: '查看阻塞项', variant: 'danger' },
};

/**
 * 验证有效性。`never` 与 `passed` 必须区分：从未探测过的能力不能显示成
 * 「已验证」，否则绕过向导直接改配置的实例看起来一切正常。
 */
const VERIFICATION_TEXT: Record<CapabilityVerification, string | null> = {
  passed: null,
  failed: '验证失败',
  stale: '配置已变更，需重新验证',
  never: '未验证',
};

/** 旧版服务端只返回布尔能力表时的降级视图。 */
function fallbackReadiness(active: boolean): CapabilityReadiness {
  return {
    state: active ? 'enabled' : 'disabled',
    verification: 'never',
    missing: [],
    blockers: [],
    targetRouteId: null,
  };
}

/**
 * 跳到能力自己的业务配置页，并带上能力标识让目标页面直接打开对应向导。
 * 状态页本身不承担任何配置保存职责。
 */
function openCapability(capability: string, targetRouteId: string): void {
  try {
    navigateGovernance(
      governanceRoute(targetRouteId, { search: `?capability=${encodeURIComponent(capability)}` }),
    );
  } catch {
    // 服务端给出的路由在当前前端版本里不存在时，宁可不跳转也不要抛到渲染层。
  }
}

function CapabilityBlockers({ readiness }: { readiness: CapabilityReadiness }) {
  return (
    <ul className="mt-1 space-y-1">
      {readiness.blockers.map((blocker) => (
        <li
          key={`${blocker.code}:${blocker.message}`}
          className="flex items-start gap-1.5 text-xs text-danger-ink"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{blocker.message}</span>
        </li>
      ))}
    </ul>
  );
}

function CapabilityRow({
  capability,
  readiness,
}: {
  capability: string;
  readiness: CapabilityReadiness;
}) {
  const label = CAPABILITY_LABELS[capability] ?? capability;
  const source = CAPABILITY_SOURCES[capability] ?? capability;
  const presentation = STATE_PRESENTATION[readiness.state];
  const verificationText = VERIFICATION_TEXT[readiness.verification];

  return (
    <div className="flex min-h-16 items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>{label}</span>
          <Badge variant={presentation.variant}>{presentation.label}</Badge>
          {verificationText ? <Badge variant="muted">{verificationText}</Badge> : null}
        </div>
        {readiness.blockers.length > 0 ? (
          <CapabilityBlockers readiness={readiness} />
        ) : readiness.missing.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            待补齐：<code className="break-all">{readiness.missing.join('、')}</code>
          </p>
        ) : (
          <code className="mt-1 block truncate text-xs text-muted-foreground">{source}</code>
        )}
        {readiness.lastValidation ? (
          <p className="mt-1 text-xs text-muted-foreground">
            最近验证：{readiness.lastValidation.status === 'passed' ? '通过' : '失败'} ·{' '}
            {formatTime(readiness.lastValidation.validatedAt)}
          </p>
        ) : null}
      </div>
      {readiness.targetRouteId ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${presentation.action} ${label}`}
          onClick={() => openCapability(capability, readiness.targetRouteId!)}
        >
          {presentation.action}
          <ArrowRight className="size-3.5" />
        </Button>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">暂无后台入口</span>
      )}
    </div>
  );
}

export function ConfigStatusCapabilities({
  capabilities,
  capabilityStates,
}: {
  capabilities: EffectiveConfigStatus['capabilities'];
  capabilityStates?: EffectiveConfigStatus['capabilityStates'];
}) {
  const entries = Object.keys(capabilities).map((capability) => ({
    capability,
    readiness: capabilityStates?.[capability] ?? fallbackReadiness(capabilities[capability]),
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">当前实例能力</CardTitle>
        <p className="text-sm text-muted-foreground">
          此处只读展示有效配置与就绪判定；修改请进入对应业务页面，由该能力自己的向导完成校验、探测与启用。
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 lg:grid-cols-2">
          {entries.map(({ capability, readiness }) => (
            <CapabilityRow key={capability} capability={capability} readiness={readiness} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
