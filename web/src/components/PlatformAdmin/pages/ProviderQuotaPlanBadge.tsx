import type { ProviderQuotaSnapshot } from '@agent/shared';
import { Badge } from '@/components/ui/badge';

// 浅底深字沿用管理后台徽章的层级；供应商使用固定色，Claude 保留套餐色。
const PALETTES = {
  blue: 'bg-blue-50 text-blue-800 dark:bg-blue-400/10 dark:text-blue-200',
  violet: 'bg-violet-50 text-violet-800 dark:bg-violet-400/10 dark:text-violet-200',
  clay: 'bg-orange-50 text-orange-800 dark:bg-orange-400/10 dark:text-orange-200',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200',
  teal: 'bg-teal-50 text-teal-800 dark:bg-teal-400/10 dark:text-teal-200',
};
type Palette = keyof typeof PALETTES;
const PLAN_PALETTES: Record<
  ProviderQuotaSnapshot['sourceKind'],
  { fallback: Palette; plans: Record<string, Palette> }
> = {
  codex_subscription: { fallback: 'blue', plans: {} },
  claude_subscription: {
    fallback: 'clay',
    plans: { max: 'amber', team: 'blue', enterprise: 'violet' },
  },
  volcengine_ark_plan: { fallback: 'violet', plans: {} },
  zhipu_coding_plan: { fallback: 'teal', plans: {} },
};

export function ProviderQuotaPlanBadge({
  sourceKind,
  planType,
  children,
}: {
  sourceKind: ProviderQuotaSnapshot['sourceKind'];
  planType?: string;
  children: React.ReactNode;
}) {
  const palette = PLAN_PALETTES[sourceKind];
  const type = planType?.trim().toLowerCase() ?? '';
  const tone = palette.plans[type] ?? palette.fallback;
  return (
    <Badge
      variant="outline"
      className={`max-w-full border-transparent px-2 py-0.5 font-medium ${PALETTES[tone]}`}
    >
      {children}
    </Badge>
  );
}
