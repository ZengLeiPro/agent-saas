import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Clock3, UserCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchPublicWorkflowReplay,
  type WorkflowReplayReference,
  type WorkflowReplayResponse,
} from "@/lib/workflowReplayApi";
import { EntityIcons, StatusIcons } from "@/lib/icons";

const AdminIcon = EntityIcons.admin;
const RunningIcon = StatusIcons.running;
const SuccessIcon = StatusIcons.success;

export function WorkflowReplayPage({ reference }: { reference: WorkflowReplayReference }) {
  const [data, setData] = useState<WorkflowReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPublicWorkflowReplay(reference)
      .then((next) => { if (!cancelled) setData(next); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reference.kind, reference.value]);

  const goBack = useCallback(() => {
    if (window.history.length > 1) window.history.back();
    else window.location.assign("/");
  }, []);

  if (loading && !data) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50"><RunningIcon className="size-6 animate-spin text-brand-600" aria-label="加载工作流回放" /></div>;
  }
  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md rounded-2xl border bg-white p-7 text-center shadow-sm">
          <div className="text-lg font-semibold">回放链接不可用</div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{error ?? "这条工作流回放不存在"}</p>
          <Button className="mt-5" variant="outline" onClick={goBack}>返回</Button>
        </div>
      </div>
    );
  }

  const { workflow, assurance } = data;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="sticky top-0 z-10 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Button variant="ghost" size="sm" className="-ml-2 gap-2" onClick={goBack}><ArrowLeft className="size-4" />返回</Button>
          <Badge variant="secondary" className="gap-1.5"><AdminIcon className="size-3.5" />公开只读回放</Badge>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <section className="rounded-3xl border bg-white p-6 shadow-sm sm:p-9">
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-brand-50 text-brand-700 hover:bg-brand-50">{workflow.type}</Badge>
            <Badge variant="outline">{workflow.environment.data}</Badge>
            <Badge variant="outline">{workflow.environment.label}</Badge>
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight sm:text-4xl">{workflow.title}</h1>
          <div className="mt-5 grid gap-3 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-950 sm:grid-cols-3">
            <div className="flex items-center gap-2"><SuccessIcon className="size-4 text-emerald-600" />动作后重新读取通过</div>
            <div className="flex items-center gap-2"><AdminIcon className="size-4 text-emerald-600" />独立复核通过</div>
            <div className="flex items-center gap-2"><Clock3 className="size-4 text-emerald-600" />{formatTime(assurance.publishedAt)} 发布</div>
          </div>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">{workflow.environment.limitation}</p>
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-2">
          <StatePanel title="处理前" items={workflow.before} tone="before" />
          <StatePanel title="处理后" items={workflow.after} tone="after" />
        </section>

        <section className="mt-6 rounded-3xl border bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-xl font-semibold">业务过程</h2>
          <ol className="mt-6 space-y-0">
            {workflow.timeline.map((event) => (
              <li key={event.sequence} className="relative grid grid-cols-[2rem_1fr] gap-3 pb-6 last:pb-0">
                {event.sequence < workflow.timeline.length ? <span className="absolute bottom-0 left-[0.95rem] top-7 w-px bg-slate-200" /> : null}
                <span className="relative z-[1] flex size-8 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{event.sequence}</span>
                <div className="min-w-0 rounded-xl border bg-slate-50/60 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{event.event}</span>
                    {event.humanReview ? <Badge variant="outline" className="gap-1"><UserCheck className="size-3" />需要人工确认</Badge> : null}
                    {event.followUp ? <Badge variant="outline" className="gap-1"><Clock3 className="size-3" />会继续跟进</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{event.action}</p>
                  <div className="mt-2 flex items-start gap-1.5 text-sm font-medium text-brand-700"><SuccessIcon className="mt-0.5 size-4 shrink-0" /><span>结果：{event.result}</span></div>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-6 rounded-3xl border bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-xl font-semibold">完成证明</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {workflow.evidence.map((evidence, index) => (
              <article key={`${evidence.category}-${index}`} className="rounded-xl border p-4">
                <Badge variant="outline">{evidence.category}</Badge>
                <div className="mt-3 font-medium">{evidence.evidence}</div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{evidence.conclusion}</p>
              </article>
            ))}
          </div>
          <div className="mt-5 grid gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-3">
            <span>{assurance.businessEventCount} 个业务步骤已保存</span>
            <span>{assurance.actionProofCount} 项动作结果已核对</span>
            <span>{assurance.finalObjectCount} 个终态对象已复查</span>
          </div>
        </section>

        <div className="mt-8 flex justify-center">
          <Button onClick={() => window.location.assign("/capabilities/templates")}>查看更多工作流</Button>
        </div>
      </main>
    </div>
  );
}

function StatePanel({
  title,
  items,
  tone,
}: {
  title: string;
  items: Array<{ object: string; status: string }>;
  tone: "before" | "after";
}) {
  return (
    <section className="rounded-3xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4 space-y-3">
        {items.map((item, index) => (
          <div key={`${item.object}-${index}`} className="rounded-xl border p-4">
            <div className="font-medium">{item.object}</div>
            <div className={tone === "after" ? "mt-1 text-sm text-emerald-700" : "mt-1 text-sm text-muted-foreground"}>{item.status}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
