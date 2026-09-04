/**
 * V3 客户目录卡。与 ScenarioCard 拆开：ScenarioCard 随聊天主视图打包，
 * 目录卡独有的目标图标集与动作图标只应跟随 lazy 加载的场景库整页出现。
 */
import type { CSSProperties } from 'react';
import { ArrowRight, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CAPABILITY_SURFACE_HOVER } from '@/components/CapabilityCenter/CatalogUi';
import type { CatalogScenarioPublic } from '@agent/shared';
import { OUTCOME_ICON } from './outcomeIcons';
import type { OutcomeFilterValue, WorkflowPrimaryAction } from './workflowUi';

export interface WorkflowScenarioCardProps {
  scenario: CatalogScenarioPublic;
  /** 岗位 id → 展示名；缺失时回退到 id */
  roleLabels?: Record<string, string>;
  onOpenDetail: (scenario: CatalogScenarioPublic) => void;
  onPrimaryAction: (action: WorkflowPrimaryAction, scenario: CatalogScenarioPublic) => void;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** 岗位行最多直接列出的数量，超出部分折成「+N」 */
const ROLE_PREVIEW_COUNT = 3;

/**
 * V3 客户目录卡（09-04 曾磊定稿）：标题是主角，其余只有一行岗位和一行页脚。
 * 结构 = 标题行（左：名称，右：目标图标 + 目标词）→ 岗位 → hairline 页脚（触发时机 | 演示 / 试试）。
 * 目标放在标题对侧而不是眉题或前缀：首行与末行左右各有锚点，卡片重心不会全压在左侧。
 * 两个动作同级同形，只用色相区分：演示=品牌暖橙，试试=品牌蓝；卡内不出现第三种颜色。
 * 不消费 prompt、tool 或旧 demoShareToken。
 */
export function WorkflowScenarioCard({
  scenario,
  roleLabels,
  onOpenDetail,
  onPrimaryAction,
  className,
  style,
}: WorkflowScenarioCardProps) {
  const goal = scenario.goalTags[0];
  const GoalIcon = goal ? OUTCOME_ICON[goal as Exclude<OutcomeFilterValue, 'all'>] : undefined;
  const roleNames = scenario.roleIds.map((id) => roleLabels?.[id] ?? id);
  const hiddenRoleCount = roleNames.length - ROLE_PREVIEW_COUNT;
  return (
    <article
      style={style}
      // 整卡可点，与技能、连接器、专家目录的卡片保持同一套交互模型
      role="button"
      tabIndex={0}
      aria-label={`查看 ${scenario.title} 详情`}
      onClick={() => onOpenDetail(scenario)}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenDetail(scenario);
        }
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col rounded-2xl p-4 text-left text-card-foreground',
        // G7「磨砂玻璃」（09-04 曾磊定稿）：顶部 brand-50 雾从 0% 融到 55% 的白、brand-100 描边、
        // 顶缘 1px 白高光。不复用 CAPABILITY_SURFACE 的灰描边，其余 hover 抬起/加深描边与其他目录卡一致。
        'bg-gradient-to-b from-brand-50/80 via-white via-55% to-white ring-1 ring-brand-100',
        'shadow-[inset_0_1px_0_#fff,0_1px_2px_rgba(0,0,0,0.03)]',
        'dark:from-brand-900/30 dark:via-card dark:to-card dark:ring-brand-800 dark:shadow-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2',
        CAPABILITY_SURFACE_HOVER,
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="truncate text-base font-semibold leading-snug tracking-tight transition-colors group-hover:text-brand-700">
          {scenario.title}
        </h3>
        {goal ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-brand-700">
            {GoalIcon ? <GoalIcon className="size-3.5" aria-hidden="true" /> : null}
            {goal}
          </span>
        ) : null}
      </div>
      <div className="mb-3.5 mt-2 truncate text-xs text-muted-foreground">
        {roleNames.slice(0, ROLE_PREVIEW_COUNT).join(' · ')}
        {hiddenRoleCount > 0 ? (
          <span className="text-muted-foreground/60"> +{hiddenRoleCount}</span>
        ) : null}
      </div>
      <div
        className="mt-auto flex items-center gap-1.5 border-t border-foreground/[0.06] pt-3"
        data-workflow-actions
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 rounded bg-foreground/[0.05] px-1.5 py-px text-2xs text-muted-foreground/70">
            触发
          </span>
          <span className="truncate">{scenario.triggerBadge}</span>
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-full bg-brand-accent-soft px-3 text-xs font-medium text-brand-accent-ink hover:bg-brand-accent/25 hover:text-brand-accent-ink"
          onClick={(event) => {
            event.stopPropagation();
            onPrimaryAction('presentation', scenario);
          }}
        >
          <Play className="size-3.5 fill-current" aria-hidden="true" />
          演示
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-full bg-brand-50 px-3 text-xs font-medium text-brand-700 hover:bg-brand-600 hover:text-white"
          onClick={(event) => {
            event.stopPropagation();
            onPrimaryAction('chat', scenario);
          }}
        >
          试试
          <ArrowRight
            className="size-3 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Button>
      </div>
    </article>
  );
}
