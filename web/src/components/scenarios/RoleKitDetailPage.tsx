import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, PlayCircle } from "lucide-react";
import {
  sanitizeRole,
  sanitizeScenario,
  type IndustryType,
  type RetentionDay,
  type ScenarioItem,
  type ScenarioRole,
  type SkillCandidate,
  type DataDependencyLevel,
} from "@agent/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  friendlyDataDependency,
  friendlyDataSourceDifficulty,
  friendlySkillLevel,
} from "./friendlyMappings";
import { pickRoleTop3 } from "./EmptyChatRecommendCards";

export interface RoleKitDetailPageProps {
  role: ScenarioRole;
  scenarios: readonly ScenarioItem[];
  industryHint?: IndustryType;
  onTryScenario: (scenario: ScenarioItem) => void;
  onBack?: () => void;
}

const RETENTION_ORDER: Record<RetentionDay, number> = {
  D1: 1,
  D2: 2,
  D3: 3,
  D5: 5,
  D7: 7,
};

function safeRole(role: ScenarioRole): ScenarioRole {
  return sanitizeRole({ ...role }).scenario as ScenarioRole;
}

function safeScenario(scenario: ScenarioItem): ScenarioItem {
  return sanitizeScenario({ ...scenario }).scenario as ScenarioItem;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function isDataDependencyLevel(value: string): value is DataDependencyLevel {
  return value === "zero" || value === "upload" || value === "ding" || value === "internal_system";
}

function aggregateSkillCandidates(scenarios: readonly ScenarioItem[]): SkillCandidate[] {
  const byName = new Map<string, SkillCandidate>();
  for (const scenario of scenarios) {
    for (const candidate of scenario.skillCandidates ?? []) {
      if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
    }
  }
  return [...byName.values()];
}

function welcomeText(role: ScenarioRole, industryHint?: IndustryType): string {
  const message = role.roleWelcomeMessage;
  if (!message) return `${role.name}开箱包已准备好。`;
  if (typeof message === "string") return message;
  if (industryHint === "export" && message.export) return message.export;
  if (message.internal) return message.internal;
  return message.default ?? message.export ?? `${role.name}开箱包已准备好。`;
}

function Section({
  title,
  children,
  defaultOpen = true,
  expandable = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = open ? ChevronDown : ChevronRight;

  return (
    <section className="border-b border-border/70 py-5 last:border-b-0">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 text-left text-sm font-semibold",
          !expandable && "cursor-default",
        )}
        onClick={() => expandable && setOpen((value) => !value)}
        aria-expanded={open}
      >
        {expandable && <Icon className="h-4 w-4 text-muted-foreground" />}
        <span>{title}</span>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </section>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function MiniScenarioCard({
  scenario,
  onTry,
}: {
  scenario: ScenarioItem;
  onTry: (scenario: ScenarioItem) => void;
}) {
  return (
    <Card className="rounded-lg shadow-none">
      <CardContent className="flex h-full flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="line-clamp-2 text-sm font-medium">{scenario.title}</div>
          <Badge variant="secondary" className="shrink-0 font-normal">
            {scenario.mode === "recurring" ? "常驻" : "一次性"}
          </Badge>
        </div>
        <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{scenario.pitch}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-auto h-8 self-start"
          onClick={() => onTry(scenario)}
        >
          <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
          试一试
        </Button>
      </CardContent>
    </Card>
  );
}

export function RoleKitDetailPage({
  role,
  scenarios,
  industryHint,
  onTryScenario,
  onBack,
}: RoleKitDetailPageProps) {
  const safe = useMemo(() => safeRole(role), [role]);
  const roleScenarios = useMemo(
    () => scenarios.filter((scenario) => scenario.role === role.id).map(safeScenario),
    [role.id, scenarios],
  );
  const top3 = useMemo(() => pickRoleTop3(roleScenarios, role.id), [role.id, roleScenarios]);
  const defaultRecurring = useMemo(() => {
    const ids = Array.isArray(safe.defaultRecurringId)
      ? safe.defaultRecurringId
      : safe.defaultRecurringId
        ? [safe.defaultRecurringId]
        : [];
    return roleScenarios.filter((scenario) => ids.includes(scenario.id) || (ids.length === 0 && scenario.mode === "recurring"));
  }, [roleScenarios, safe.defaultRecurringId]);
  const first5 = roleScenarios.slice(0, 5);
  const skillCandidates = useMemo(() => aggregateSkillCandidates(roleScenarios), [roleScenarios]);
  const cannotPromise = useMemo(
    () => uniqueStrings(roleScenarios.flatMap((scenario) => scenario.cannotPromise ?? [])),
    [roleScenarios],
  );
  const day1Steps = useMemo(
    () => roleScenarios.flatMap((scenario) => scenario.day1PathSteps ?? []).slice(0, 6),
    [roleScenarios],
  );
  const retention = useMemo(
    () => [...(safe.retentionPath7Day ?? [])].sort((a, b) => RETENTION_ORDER[a.day] - RETENTION_ORDER[b.day]),
    [safe.retentionPath7Day],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {onBack && (
            <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-2 h-8" onClick={onBack}>
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              返回
            </Button>
          )}
          <h1 className="text-xl font-semibold">{safe.name}开箱包</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            {welcomeText(safe, industryHint)}
          </p>
        </div>
        <Badge variant="outline" className="shrink-0">
          {roleScenarios.length} 个场景
        </Badge>
      </div>

      <div className="rounded-lg border bg-card px-5">
        <Section title="岗位画像与差异化" expandable={false}>
          <p className="text-sm leading-6 text-muted-foreground">
            {welcomeText(safe, industryHint)}
          </p>
        </Section>

        <Section title="该岗位最痛的 5 个问题" expandable={false}>
          {safe.roleTopPains?.length ? (
            <ol className="grid gap-2 sm:grid-cols-2">
              {safe.roleTopPains.slice(0, 5).map((pain, index) => (
                <li key={pain} className="flex gap-2 rounded-md bg-muted/30 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">{index + 1}.</span>
                  <span>{pain}</span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyHint>该岗位暂未配置痛点。</EmptyHint>
          )}
        </Section>

        <Section title="首日 4 小时能干成什么" expandable={false}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {top3.map((scenario) => (
              <MiniScenarioCard key={scenario.id} scenario={scenario} onTry={onTryScenario} />
            ))}
            {defaultRecurring[0] && (
              <MiniScenarioCard scenario={defaultRecurring[0]} onTry={onTryScenario} />
            )}
          </div>
        </Section>

        <Section title="5 条示例起手指令" expandable={false}>
          {first5.length ? (
            <div className="space-y-2">
              {first5.map((scenario) => (
                <button
                  key={scenario.id}
                  type="button"
                  className="block w-full rounded-md border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
                  onClick={() => onTryScenario(scenario)}
                >
                  <span className="block font-medium">{scenario.title}</span>
                  <span className="mt-1 block line-clamp-2 text-muted-foreground">
                    {scenario.promptTemplate}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyHint>该岗位暂无示例起手指令。</EmptyHint>
          )}
        </Section>

        <Section title="需要接入的数据源" defaultOpen={false} expandable>
          {safe.roleP0DataSources?.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {safe.roleP0DataSources.map((source) => (
                <div key={source.name} className="rounded-md border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{source.name}</div>
                    <Badge variant="secondary" className="font-normal">
                      {friendlyDataSourceDifficulty[source.difficulty]}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{source.afterConnected}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{source.customerAction}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyHint>该岗位暂无必接数据源。</EmptyHint>
          )}
        </Section>

        <Section title="值得沉淀成公司规范的能力" defaultOpen={false} expandable>
          {skillCandidates.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {skillCandidates.map((candidate) => (
                <div key={candidate.name} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{candidate.name}</span>
                    <Badge variant="outline">{friendlySkillLevel[candidate.level]}</Badge>
                  </div>
                  <p className="mt-2 text-muted-foreground">{candidate.firstSampleGate}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{candidate.freshnessMechanism}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyHint>该岗位暂无沉淀建议。</EmptyHint>
          )}
        </Section>

        <Section title="陪跑路径：4 小时到 7 天" defaultOpen={false} expandable>
          <div className="space-y-4">
            {day1Steps.length > 0 && (
              <div className="space-y-2">
                {day1Steps.map((step, index) => (
                  <div key={`${step.stage}-${index}`} className="rounded-md bg-muted/30 px-3 py-2 text-sm">
                    <div className="font-medium">{step.stage}</div>
                    <div className="mt-1 text-muted-foreground">
                      {step.userAction} → {step.aiAction} → {step.userSees}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {retention.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {retention.map((item) => (
                  <div key={item.day} className="rounded-md border px-3 py-2 text-sm">
                    <div className="font-medium">{item.day}</div>
                    <div className="mt-1 text-muted-foreground">{item.mainlineAiAction}</div>
                    {!item.sellUpBanned && item.backupCsmAction && (
                      <div className="mt-1 text-xs text-muted-foreground">{item.backupCsmAction}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {day1Steps.length === 0 && retention.length === 0 && (
              <EmptyHint>该岗位暂无陪跑路径。</EmptyHint>
            )}
          </div>
        </Section>

        <Section title="我们不承诺什么" defaultOpen={false} expandable>
          {cannotPromise.length ? (
            <ul className="space-y-2 text-sm text-muted-foreground">
              {cannotPromise.map((item) => (
                <li key={item} className="rounded-md bg-muted/30 px-3 py-2">
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyHint>该岗位暂无额外限制说明。</EmptyHint>
          )}
        </Section>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {uniqueStrings(roleScenarios.map((scenario) => scenario.dataDependencyLevel))
          .filter(isDataDependencyLevel)
          .map((level) => (
          <Badge key={level} variant="secondary" className="font-normal">
            {friendlyDataDependency[level]}
          </Badge>
        ))}
      </div>
    </div>
  );
}
