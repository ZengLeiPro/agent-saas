import { useEffect, useReducer } from "react";
import { CircleCheck, Circle, CircleDot, Timer, X } from "lucide-react";
import type { ScenarioItem } from "@agent/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildWorkflowOnboardingPlan,
  type WorkflowOnboardingContext,
  type WorkflowOnboardingStep,
} from "./workflowOnboarding";

export type GuideBarState = "aha" | "cron" | "sprint" | "done" | "closed";
export type GuideBarEvent =
  | { type: "EXAMPLE_DEMO_OPENED" }
  | { type: "CRON_CONFIGURED" }
  | { type: "FIRST_DINGTALK_INVOKE" }
  | { type: "USER_CLOSE" }
  | { type: "STAGE_TIMEOUT" };

export const FIRST_DAY_GUIDE_STORAGE_KEY = "kaiyan:firstDayGuide:v3";
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
  const stored = window.localStorage.getItem(FIRST_DAY_GUIDE_STORAGE_KEY);
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
  activeScenario?: Pick<ScenarioItem, "id" | "day1PathSteps"> & Partial<Pick<ScenarioItem, "mode">>;
  activeWorkflow?: WorkflowOnboardingContext;
  onOpenCronWizard: () => void;
  onOpenExampleDemo: () => void;
  onStartWorkflow?: (starterMessage: string, context: WorkflowOnboardingContext) => void;
  onOpenWorkflowReplay?: (sharePath: string, context: WorkflowOnboardingContext) => void;
  onConnectWorkflow?: (context: WorkflowOnboardingContext) => void;
  onRequestDiagnosis?: (context: WorkflowOnboardingContext) => void;
  onViewWorkflow?: (context: WorkflowOnboardingContext) => void;
  onOpenWorkflowCron?: (context: WorkflowOnboardingContext) => void;
  onSoftExitAcknowledged?: () => void;
  stageTimeoutMs?: number;
  showOnMobile?: boolean;
}

export function FirstDayGuideBar({
  activeScenario,
  activeWorkflow,
  onOpenCronWizard,
  onOpenExampleDemo,
  onStartWorkflow,
  onOpenWorkflowReplay,
  onConnectWorkflow,
  onRequestDiagnosis,
  onViewWorkflow,
  onOpenWorkflowCron,
  onSoftExitAcknowledged,
  stageTimeoutMs = DEFAULT_TIMEOUT_MS,
  showOnMobile = false,
}: FirstDayGuideBarProps) {
  const [state, dispatch] = useReducer(guideReducer, undefined, initialState);

  useEffect(() => {
    window.localStorage.setItem(FIRST_DAY_GUIDE_STORAGE_KEY, state);
    if (state === "closed") onSoftExitAcknowledged?.();
  }, [onSoftExitAcknowledged, state]);

  useEffect(() => {
    const onExample = () => dispatch({ type: "EXAMPLE_DEMO_OPENED" });
    const onCron = () => dispatch({ type: "CRON_CONFIGURED" });
    const onInvoke = () => dispatch({ type: "FIRST_DINGTALK_INVOKE" });
    window.addEventListener("kaiyan:example-demo-opened", onExample);
    window.addEventListener("kaiyan:cron-configured", onCron);
    window.addEventListener("kaiyan:first-dingtalk-invoke", onInvoke);
    window.addEventListener("kaiyan:workflow-experience-opened", onExample);
    window.addEventListener("kaiyan:workflow-activation-completed", onCron);
    window.addEventListener("kaiyan:workflow-terminal-verified", onInvoke);
    return () => {
      window.removeEventListener("kaiyan:example-demo-opened", onExample);
      window.removeEventListener("kaiyan:cron-configured", onCron);
      window.removeEventListener("kaiyan:first-dingtalk-invoke", onInvoke);
      window.removeEventListener("kaiyan:workflow-experience-opened", onExample);
      window.removeEventListener("kaiyan:workflow-activation-completed", onCron);
      window.removeEventListener("kaiyan:workflow-terminal-verified", onInvoke);
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

  // 没有显式 Cron 打开能力时移除 schedule proof，避免 CTA 显示“配置常驻”却只能跳目录。
  const workflowContext = activeWorkflow && !onOpenWorkflowCron && activeWorkflow.schedule
    ? (({ schedule: _schedule, ...rest }) => rest)(activeWorkflow)
    : activeWorkflow;
  const workflowPlan = workflowContext
    ? buildWorkflowOnboardingPlan(workflowContext)
    : null;

  const openWorkflowDetail = () => {
    if (workflowContext && onViewWorkflow) onViewWorkflow(workflowContext);
    else onOpenExampleDemo();
  };
  const runWorkflowStep = (step: WorkflowOnboardingStep) => {
    if (!workflowContext) return;
    switch (step.action) {
      case "chat":
        if (onStartWorkflow) onStartWorkflow(workflowContext.scenario.launch.starterMessage, workflowContext);
        else openWorkflowDetail();
        return;
      case "replay": {
        const sharePath = workflowContext.scenario.demo.sharePath;
        if (sharePath && onOpenWorkflowReplay) onOpenWorkflowReplay(sharePath, workflowContext);
        else openWorkflowDetail();
        return;
      }
      case "connector":
        if (onConnectWorkflow) onConnectWorkflow(workflowContext);
        else openWorkflowDetail();
        return;
      case "diagnosis":
        if (onRequestDiagnosis) onRequestDiagnosis(workflowContext);
        else openWorkflowDetail();
        return;
      case "cron":
        if (onOpenWorkflowCron) onOpenWorkflowCron(workflowContext);
        else openWorkflowDetail();
        return;
      case "detail":
        openWorkflowDetail();
        return;
      default: {
        const unreachable: never = step.action;
        return unreachable;
      }
    }
  };

  const legacyCanCron = activeScenario?.mode !== "oneshot";
  const legacyCopy = {
    aha: {
      title: activeScenario?.day1PathSteps?.[0]?.userAction ?? "先看一个示例结果",
      cta: "看示例",
      action: onOpenExampleDemo,
    },
    cron: {
      title: legacyCanCron ? "把它设成每天自动跑" : "换一个真实对象继续试跑",
      cta: legacyCanCron ? "配置常驻监测" : "打开任务模板",
      action: legacyCanCron ? onOpenCronWizard : onOpenExampleDemo,
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
  const workflowCopy = workflowPlan
    ? state === "done"
      ? {
          title: "首日引导已完成",
          cta: "完成",
          action: () => dispatch({ type: "USER_CLOSE" }),
        }
      : (() => {
          const step = state === "aha"
            ? workflowPlan.experience
            : state === "cron"
              ? workflowPlan.activate
              : workflowPlan.verify;
          return {
            title: step.title,
            cta: step.cta,
            action: () => runWorkflowStep(step),
          };
        })()
    : null;
  const copy = workflowCopy ?? legacyCopy;
  const progressLabels = workflowPlan?.progressLabels
    ?? (legacyCanCron
      ? (["看见效果", "设成常驻", "跑真实任务"] as const)
      : (["看见效果", "跑真实任务", "继续使用"] as const));

  return (
    <div className={cn(
      "border-t bg-slate-950 px-4 py-2 text-slate-50",
      showOnMobile ? "flex" : "hidden md:flex",
    )}>
      <div className="mx-auto flex min-h-10 w-full max-w-5xl items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Timer className="size-4 shrink-0 text-slate-300" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{copy.title}</div>
            <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-300">
              <ProgressDot label={progressLabels[0]} active={state === "aha"} done={state === "cron" || state === "sprint" || state === "done"} />
              <ProgressDot label={progressLabels[1]} active={state === "cron"} done={state === "sprint" || state === "done"} />
              <ProgressDot label={progressLabels[2]} active={state === "sprint"} done={state === "done"} />
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
