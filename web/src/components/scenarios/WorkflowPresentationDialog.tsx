import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDollarSign,
  Database,
  FileCheck2,
  Globe2,
  ListChecks,
  Mail,
  MessageSquareText,
  RefreshCcw,
} from "lucide-react";
import type { CatalogScenarioPublic } from "@agent/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { EntityIcons } from "@/lib/icons";

type Presentation = NonNullable<CatalogScenarioPublic["presentation"]>;
type Chapter = Presentation["chapters"][number];
type SurfaceKind = Chapter["surface"]["kind"];
type ItemState = Chapter["surface"]["items"][number]["state"];

const AdminIcon = EntityIcons.admin;

const SURFACE_META: Record<SurfaceKind, { label: string; icon: ComponentType<{ className?: string }> }> = {
  crm_table: { label: "客户关系系统", icon: Database },
  erp_table: { label: "业务系统", icon: FileCheck2 },
  im_thread: { label: "即时沟通", icon: MessageSquareText },
  mail_panel: { label: "邮件与消息", icon: Mail },
  approval_card: { label: "人工确认", icon: AdminIcon },
  browser_panel: { label: "网页与资料", icon: Globe2 },
  task_list: { label: "任务中心", icon: ListChecks },
  finance_ledger: { label: "财务台账", icon: CircleDollarSign },
  summary: { label: "结果汇总", icon: Check },
};

const STATE_CLASS: Record<ItemState, string> = {
  neutral: "border-slate-200 bg-white text-slate-700",
  pending: "border-amber-200 bg-amber-50 text-amber-900",
  active: "border-brand-200 bg-brand-50 text-brand-900",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-orange-200 bg-orange-50 text-orange-900",
};

export function WorkflowPresentationDialog({
  scenario,
  open,
  onOpenChange,
  onUseScenario,
}: {
  scenario: CatalogScenarioPublic | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseScenario: (scenario: CatalogScenarioPublic) => void;
}) {
  const [chapterIndex, setChapterIndex] = useState(0);

  useEffect(() => {
    if (open) setChapterIndex(0);
  }, [open, scenario?.id]);

  const presentation = scenario?.presentation;
  const chapter = presentation?.chapters[chapterIndex];
  const isLast = !!presentation && chapterIndex === presentation.chapters.length - 1;
  const useLabel = useMemo(() => {
    if (!scenario) return "继续";
    if (scenario.readiness === "D0_CURRENT") return "用我的资料开始";
    if (scenario.readiness === "D1_CONNECTOR") return "接入我的系统";
    return "评估落地方案";
  }, [scenario]);

  if (!scenario || !presentation || !chapter) return null;

  const goNext = () => {
    if (isLast) setChapterIndex(0);
    else setChapterIndex((value) => Math.min(value + 1, presentation.chapters.length - 1));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(90vh,820px)] w-[calc(100vw-1rem)] max-w-7xl flex-col gap-0 overflow-hidden p-0 sm:w-[calc(100vw-3rem)]">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 sm:px-7">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-brand-50 text-brand-700 hover:bg-brand-50">AI 同事工作现场</Badge>
            <Badge variant="outline">{presentation.dataLabel}</Badge>
            <span className="text-xs font-medium text-muted-foreground">{chapterIndex + 1} / {presentation.chapters.length}</span>
          </div>
          <DialogTitle className="mt-2 text-left text-xl sm:text-2xl">{scenario.title}</DialogTitle>
          <DialogDescription className="text-left">{presentation.limitation}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/70">
          <div className="grid min-h-full lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,1.05fr)]">
            <section className="flex min-w-0 flex-col border-b bg-white p-5 lg:border-b-0 lg:border-r sm:p-7">
              <nav className="flex gap-2 overflow-x-auto pb-2" aria-label="演示步骤">
                {presentation.chapters.map((item, index) => {
                  const active = index === chapterIndex;
                  const completed = index < chapterIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                        active && "border-brand-600 bg-brand-600 text-white",
                        completed && "border-emerald-500 bg-emerald-50 text-emerald-700",
                        !active && !completed && "border-slate-200 bg-white text-slate-500 hover:border-brand-300",
                      )}
                      aria-label={`第 ${index + 1} 步：${item.title}`}
                      aria-current={active ? "step" : undefined}
                      onClick={() => setChapterIndex(index)}
                    >
                      {completed ? <Check className="size-3.5" /> : index + 1}
                    </button>
                  );
                })}
              </nav>

              <div key={chapter.id} className="flex flex-1 flex-col pt-7 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
                <div className="text-xs font-semibold text-brand-600">第 {chapterIndex + 1} 步</div>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{chapter.title}</h2>
                <p className="mt-4 text-sm leading-7 text-slate-600 sm:text-base">{chapter.narration}</p>

                <div className="mt-6 rounded-2xl border border-brand-100 bg-brand-50/70 p-4">
                  <div className="text-xs font-semibold text-brand-700">这一步完成后</div>
                  <p className="mt-1.5 text-sm font-medium leading-6 text-brand-950">{chapter.result}</p>
                </div>
                <div className="mt-3 text-xs font-medium text-brand-700 lg:hidden">继续向下可查看本步的系统变化</div>

                {chapter.interaction.kind === "confirm" ? (
                  <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                    <AdminIcon className="mt-0.5 size-5 shrink-0 text-amber-700" />
                    <div>
                      <div className="font-semibold">这里需要人来决定</div>
                      <p className="mt-1 leading-6">本页只模拟确认动作，不会修改任何真实业务系统。</p>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <SystemSurface chapter={chapter} />
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-white px-5 py-4 sm:px-7">
          <Button
            type="button"
            variant="ghost"
            disabled={chapterIndex === 0}
            onClick={() => setChapterIndex((value) => Math.max(0, value - 1))}
          >
            <ArrowLeft className="size-4" />上一步
          </Button>
          <div className="flex items-center gap-2">
            {isLast ? (
              <>
                <Button type="button" variant="outline" onClick={goNext}>
                  <RefreshCcw className="size-4" />重新演示
                </Button>
                <Button type="button" onClick={() => onUseScenario(scenario)}>{useLabel}</Button>
              </>
            ) : (
              <Button type="button" onClick={goNext}>
                {chapter.interaction.label}<ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function SystemSurface({ chapter }: { chapter: Chapter }) {
  const meta = SURFACE_META[chapter.surface.kind];
  const SurfaceIcon = meta.icon;
  const isConversation = chapter.surface.kind === "im_thread";
  const isMessage = chapter.surface.kind === "mail_panel";
  const isBrowser = chapter.surface.kind === "browser_panel";

  return (
    <aside className="min-w-0 bg-slate-100/80 p-4 sm:p-6" aria-live="polite">
      <div className="mx-auto flex h-full min-h-[360px] max-w-2xl flex-col overflow-hidden rounded-2xl border bg-white shadow-sm">
        {isBrowser ? (
          <div className="flex h-10 items-center gap-2 border-b bg-slate-50 px-4">
            <span className="size-2.5 rounded-full bg-red-300" />
            <span className="size-2.5 rounded-full bg-amber-300" />
            <span className="size-2.5 rounded-full bg-emerald-300" />
            <div className="ml-2 flex-1 rounded-md border bg-white px-3 py-1 text-[11px] text-slate-400">企业工作台 / 演示环境</div>
          </div>
        ) : null}
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
              <SurfaceIcon className="size-4.5" />
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-muted-foreground">{meta.label}</div>
              <h3 className="truncate font-semibold text-slate-950">{chapter.surface.title}</h3>
              {chapter.surface.subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{chapter.surface.subtitle}</p> : null}
            </div>
          </div>
          <Badge variant="outline" className="shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700">演示联动</Badge>
        </div>

        <div className={cn("flex-1 p-5", isConversation ? "space-y-4 bg-slate-50/60" : "space-y-3")}>
          {chapter.surface.items.map((item, index) => {
            if (isConversation) {
              const mine = index % 2 === 0;
              return (
                <div key={`${item.label}-${index}`} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                  <div className={cn(
                    "max-w-[86%] rounded-2xl px-4 py-3 text-sm shadow-sm",
                    mine ? "rounded-br-md bg-brand-600 text-white" : "rounded-bl-md border bg-white text-slate-800",
                    item.changed && !mine && "ring-2 ring-emerald-200",
                  )}>
                    <div className={cn("text-[11px] font-medium", mine ? "text-brand-100" : "text-slate-500")}>{item.label}</div>
                    <div className="mt-1 leading-6">{item.value}</div>
                  </div>
                </div>
              );
            }
            if (isMessage) {
              return (
                <div key={`${item.label}-${index}`} className={cn("grid gap-1 border-b py-3 last:border-b-0 sm:grid-cols-[7rem_1fr]", item.changed && "rounded-lg border border-brand-200 bg-brand-50 px-3")}>
                  <div className="text-xs font-medium text-slate-500">{item.label}</div>
                  <div className="text-sm leading-6 text-slate-900">{item.value}</div>
                </div>
              );
            }
            return (
              <div
                key={`${item.label}-${index}`}
                className={cn(
                  "grid gap-2 rounded-xl border px-4 py-3 transition-all sm:grid-cols-[minmax(7rem,0.42fr)_1fr] sm:items-center",
                  STATE_CLASS[item.state],
                  item.changed && "ring-2 ring-brand-200 ring-offset-1",
                )}
              >
                <div className="text-xs font-semibold opacity-75">{item.label}</div>
                <div className="text-sm font-medium leading-6">{item.value}</div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
