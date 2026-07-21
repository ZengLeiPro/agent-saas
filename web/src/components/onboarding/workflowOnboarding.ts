import type { CatalogScenarioPublic, ScenarioItem } from "@agent/shared";
import {
  abandonWorkflowDemoLaunch,
  startWorkflowDemo,
} from "@/lib/workflowDemoApi";

export type WorkflowOnboardingAction =
  | "chat"
  | "replay"
  | "connector"
  | "diagnosis"
  | "cron"
  | "detail";

export interface WorkflowScheduleProof {
  /** 只能由结构化契约或服务端兼容记录提供，禁止根据标题、徽标或 WATCH 类型猜测。 */
  scheduleCapable: true;
  /** create-cron 兼容接口仍以 legacy 场景为执行载体。 */
  cronScenario: ScenarioItem;
}

export interface WorkflowOnboardingContext {
  scenario: Pick<
    CatalogScenarioPublic,
    "id" | "workflowId" | "title" | "primaryType" | "readiness" | "launch" | "cta" | "demo"
  >;
  schedule?: WorkflowScheduleProof;
  /** 用户真正发送起手指令时才初始化，避免仅浏览目录就留下孤儿 run。 */
  demoLaunch?: {
    catalogScenarioId: string;
    idempotencyKey: string;
  };
}

export interface WorkflowOnboardingStep {
  action: WorkflowOnboardingAction;
  title: string;
  cta: string;
}

export interface WorkflowOnboardingPlan {
  experience: WorkflowOnboardingStep;
  activate: WorkflowOnboardingStep;
  verify: WorkflowOnboardingStep;
  progressLabels: readonly [string, string, string];
}

/** 只有发送动作真实成功后才推进首日引导；预填、点 CTA 或失败都不记作已体验。 */
export async function sendWorkflowExperience(
  sendMessage: (options?: {
    workflowDemo?: { runId: string; eventId: string };
  }) => Promise<void>,
  input: string,
  context: WorkflowOnboardingContext | null,
  eventTarget: Pick<Window, "dispatchEvent"> = window,
): Promise<void> {
  const isSelectedWorkflowStart = context !== null
    && input.trim() === context.scenario.launch.starterMessage.trim();
  const workflowDemo = isSelectedWorkflowStart && context?.demoLaunch
    ? await startWorkflowDemo(
      context.demoLaunch.catalogScenarioId,
      context.demoLaunch.idempotencyKey,
    )
    : undefined;
  try {
    await sendMessage(workflowDemo ? { workflowDemo } : undefined);
  } catch (error) {
    if (workflowDemo) {
      await abandonWorkflowDemoLaunch(workflowDemo.runId).catch(() => undefined);
    }
    throw error;
  }
  if (!context || !isSelectedWorkflowStart) return;
  eventTarget.dispatchEvent(new CustomEvent("kaiyan:workflow-experience-opened", {
    detail: { workflowId: context.scenario.workflowId },
  }));
}

function publishedReplay(
  scenario: WorkflowOnboardingContext["scenario"],
): WorkflowOnboardingStep | null {
  if (
    scenario.demo.evidenceLevel !== "workflow_replay"
    || !scenario.demo.sharePath
  ) {
    return null;
  }
  return {
    action: "replay",
    title: scenario.primaryType === "WATCH"
      ? "先看正常与异常两个巡检周期"
      : scenario.primaryType === "ACT"
        ? "先看系统写入与动作后回读"
        : scenario.primaryType === "LOOP"
          ? "先看等待、恢复与业务终态"
          : "先看示例成果与核验证据",
    cta: "查看真实回放",
  };
}

function detailStep(
  scenario: WorkflowOnboardingContext["scenario"],
): WorkflowOnboardingStep {
  return {
    action: "detail",
    title: scenario.primaryType === "WATCH"
      ? "先看巡检、降噪与复查链路"
      : scenario.primaryType === "ACT"
        ? "先看写入、回执与回读链路"
        : scenario.primaryType === "LOOP"
          ? "先看行动、等待、恢复与终态"
          : "先看成果如何生成并核验",
    cta: "查看工作流",
  };
}

function d0LaunchStep(
  scenario: WorkflowOnboardingContext["scenario"],
): WorkflowOnboardingStep {
  if (scenario.launch.startMode === "chat") {
    return {
      action: "chat",
      title: scenario.primaryType === "CREATE"
        ? "用示例数据产出并核验一份成果"
        : "用示例数据启动这条工作流",
      cta: scenario.cta.primary,
    };
  }
  if (scenario.launch.startMode === "replay") {
    return publishedReplay(scenario) ?? detailStep(scenario);
  }
  // D0 与 connector/diagnosis 组合代表数据契约不一致，保守退回详情，不扩大承诺。
  return detailStep(scenario);
}

export function isWorkflowCronEligible(
  context: WorkflowOnboardingContext,
): boolean {
  return context.scenario.primaryType === "WATCH"
    && context.scenario.readiness === "D0_CURRENT"
    && context.schedule?.scheduleCapable === true
    && context.schedule.cronScenario.mode === "recurring";
}

/**
 * 把 V3 目录项转成首日引导计划。成熟度优先于 launch：D1/D2 不会被包装成当前即用；
 * Cron 只接受显式证明，ACT/LOOP 无论传入什么 schedule 数据都不会推荐定时。
 */
export function buildWorkflowOnboardingPlan(
  context: WorkflowOnboardingContext,
): WorkflowOnboardingPlan {
  const { scenario } = context;
  const replay = publishedReplay(scenario);
  const detail = detailStep(scenario);

  if (scenario.readiness === "D2_PROJECT") {
    return {
      experience: replay ?? detail,
      activate: {
        action: "diagnosis",
        title: "确认现场系统、权限和项目集成边界",
        cta: "预约落地诊断",
      },
      verify: {
        action: "diagnosis",
        title: "形成可验收的集成与上线方案",
        cta: "继续落地诊断",
      },
      progressLabels: ["看行业演示", "落地诊断", "确认验收边界"],
    };
  }

  if (scenario.readiness === "D1_CONNECTOR") {
    return {
      experience: replay ?? detail,
      activate: {
        action: "connector",
        title: "接入账号并确认最小权限范围",
        cta: "接入我的系统",
      },
      verify: {
        action: "connector",
        title: "接好后用一个业务对象完成首次核验",
        cta: "检查连接器",
      },
      progressLabels: ["看清工作流", "接好系统", "完成首次核验"],
    };
  }

  const experience = d0LaunchStep(scenario);
  if (isWorkflowCronEligible(context)) {
    return {
      experience,
      activate: {
        action: "cron",
        title: "把这条持续巡检设成定时运行",
        cta: "配置常驻监测",
      },
      verify: {
        action: "detail",
        title: "查看下一周期复查与异常升级",
        cta: "查看工作流",
      },
      progressLabels: ["体验巡检", "设成常驻", "核验下一周期"],
    };
  }

  return {
    experience,
    activate: scenario.launch.startMode === "chat"
      ? {
          action: "chat",
          title: scenario.primaryType === "CREATE"
            ? "换一个真实对象产出并核验成果"
            : "换一个隔离业务对象继续试跑",
          cta: "开始真实任务",
        }
      : replay ?? detail,
    verify: {
      action: "detail",
      title: scenario.primaryType === "CREATE"
        ? "核对成果是否满足业务验收标准"
        : "核对系统终态和完成证据",
      cta: "查看完成证明",
    },
    progressLabels: [
      scenario.primaryType === "CREATE" ? "看见成果" : "体验工作流",
      scenario.primaryType === "CREATE" ? "跑真实任务" : "执行一次",
      "核验终态",
    ],
  };
}
