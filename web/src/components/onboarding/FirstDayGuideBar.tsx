import { useEffect, useReducer } from "react";
import { CircleCheck, Circle, CircleDot, Timer, X } from "lucide-react";
import type { ScenarioItem } from "@agent/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type GuideBarState = "aha" | "cron" | "sprint" | "done" | "closed";
export type GuideBarEvent =
  | { type: "EXAMPLE_DEMO_OPENED" }
  | { type: "CRON_CONFIGURED" }
  | { type: "FIRST_DINGTALK_INVOKE" }
  | { type: "USER_CLOSE" }
  | { type: "STAGE_TIMEOUT" };

const STORAGE_KEY = "kaiyan:firstDayGuide:v2";
const DEFAULT_TIMEOUT_MS = 5_400_000;

export function guideReducer(state: GuideBarState, event: GuideBarEvent): GuideBarState {
  switch (state) {
    case "aha":
      switch (event.type) {
        case "EXAMPLE_DEMO_OPENED":
        case "CRON_CONFIGURED":
          return "cron";
        case "FIRST_DINGTALK_INVOKE":
          return "sprint";
        case "USER_CLOSE":
        case "STAGE_TIMEOUT":
          return "closed";
        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
    case "cron":
      switch (event.type) {
        case "EXAMPLE_DEMO_OPENED":
          return "cron";
        case "CRON_CONFIGURED":
        case "FIRST_DINGTALK_INVOKE":
          return "sprint";
        case "USER_CLOSE":
        case "STAGE_TIMEOUT":
          return "closed";
        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
    case "sprint":
      switch (event.type) {
        case "EXAMPLE_DEMO_OPENED":
        case "CRON_CONFIGURED":
          return "sprint";
        case "FIRST_DINGTALK_INVOKE":
          return "done";
        case "USER_CLOSE":
        case "STAGE_TIMEOUT":
          return "closed";
        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
    case "done":
      switch (event.type) {
        case "EXAMPLE_DEMO_OPENED":
        case "CRON_CONFIGURED":
        case "FIRST_DINGTALK_INVOKE":
        case "STAGE_TIMEOUT":
          return "done";
        case "USER_CLOSE":
          return "closed";
        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
    case "closed":
      return "closed";
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

function initialState(): GuideBarState {
  if (typeof window === "undefined") return "aha";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "aha" || stored === "cron" || stored === "sprint" || stored === "done" || stored === "closed") {
    return stored;
  }
  return "aha";
}

function ProgressDot({
  label,
  active,
  done,
}: {
  label: string;
  active: boolean;
  done: boolean;
}) {
  const Icon = done ? CircleCheck : active ? CircleDot : Circle;
  return (
    <span className={cn("inline-flex items-center gap-1.5", active && "font-medium")}>
      <Icon className={cn("size-4", done ? "text-emerald-300" : active ? "text-white" : "text-white/45")} />
      {label}
    </span>
  );
}

export interface FirstDayGuideBarProps {
  activeScenario?: Pick<ScenarioItem, "id" | "day1PathSteps">;
  onOpenCronWizard: () => void;
  onOpenExampleDemo: () => void;
  onSoftExitAcknowledged?: () => void;
  stageTimeoutMs?: number;
}

export function FirstDayGuideBar({
  activeScenario,
  onOpenCronWizard,
  onOpenExampleDemo,
  onSoftExitAcknowledged,
  stageTimeoutMs = DEFAULT_TIMEOUT_MS,
}: FirstDayGuideBarProps) {
  const [state, dispatch] = useReducer(guideReducer, undefined, initialState);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, state);
    if (state === "closed") onSoftExitAcknowledged?.();
  }, [onSoftExitAcknowledged, state]);

  useEffect(() => {
    const onExample = () => dispatch({ type: "EXAMPLE_DEMO_OPENED" });
    const onCron = () => dispatch({ type: "CRON_CONFIGURED" });
    const onInvoke = () => dispatch({ type: "FIRST_DINGTALK_INVOKE" });
    window.addEventListener("kaiyan:example-demo-opened", onExample);
    window.addEventListener("kaiyan:cron-configured", onCron);
    window.addEventListener("kaiyan:first-dingtalk-invoke", onInvoke);
    return () => {
      window.removeEventListener("kaiyan:example-demo-opened", onExample);
      window.removeEventListener("kaiyan:cron-configured", onCron);
      window.removeEventListener("kaiyan:first-dingtalk-invoke", onInvoke);
    };
  }, []);

  useEffect(() => {
    if (state === "closed" || state === "done") return;
    const timer = window.setTimeout(() => dispatch({ type: "STAGE_TIMEOUT" }), stageTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [stageTimeoutMs, state]);

  useEffect(() => {
    if (state !== "done") return;
    const timer = window.setTimeout(() => dispatch({ type: "USER_CLOSE" }), 3_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === "closed") return null;

  const copy = {
    aha: {
      title: activeScenario?.day1PathSteps?.[0]?.userAction ?? "先看一个示例结果",
      cta: "看示例",
      action: onOpenExampleDemo,
    },
    cron: {
      title: "把它设成每天自动跑",
      cta: "配置常驻监测",
      action: onOpenCronWizard,
    },
    sprint: {
      title: "今天再跑 3 个真实任务",
      cta: "打开任务模板",
      action: onOpenExampleDemo,
    },
    done: {
      title: "首日引导已完成",
      cta: "完成",
      action: () => dispatch({ type: "USER_CLOSE" }),
    },
  }[state];

  return (
    <div className="hidden border-t bg-slate-950 px-4 py-2 text-slate-50 md:flex">
      <div className="mx-auto flex min-h-10 w-full max-w-5xl items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Timer className="size-4 shrink-0 text-slate-300" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{copy.title}</div>
            <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-300">
              <ProgressDot label="看见效果" active={state === "aha"} done={state === "cron" || state === "sprint" || state === "done"} />
              <ProgressDot label="设成常驻" active={state === "cron"} done={state === "sprint" || state === "done"} />
              <ProgressDot label="跑真实任务" active={state === "sprint"} done={state === "done"} />
            </div>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 shrink-0"
          onClick={copy.action}
        >
          {copy.cta}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 text-slate-300 hover:bg-white/10 hover:text-white"
          onClick={() => dispatch({ type: "USER_CLOSE" })}
          title="关闭引导"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
