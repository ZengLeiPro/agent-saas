import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  cronWizardSubmitSchema,
  type CronWizardResponse,
  type CronWizardSubmit,
  type ScenarioItem,
  type SignalAdaptation,
} from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { friendlyPushChannel, friendlyPushTarget } from "@/components/scenarios/friendlyMappings";

export interface CronCreationWizardProps {
  open: boolean;
  scenario: ScenarioItem | null;
  onOpenChange: (open: boolean) => void;
  onCreated?: (response: CronWizardResponse) => void;
}

type Step = 1 | 2 | 3;
type PushSlotForm = CronWizardSubmit["pushSlot"];

const DEFAULT_SIGNAL: SignalAdaptation = {
  dailyEmptyStreakToWeekly: 3,
  userNoOpenStreakToPause: 5,
  emptyContentFallback: "当天没有明显变化时，改为整理本周相关动态摘要。",
};

function splitTargets(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeTargets(existing: string[], raw: string): string[] {
  return [...new Set([...existing, ...splitTargets(raw)])].slice(0, 10);
}

function initialPushSlot(scenario: ScenarioItem | null): PushSlotForm {
  if (scenario?.pushSlot?.humanReviewRequired) {
    return {
      humanReviewRequired: true,
      target: "manager",
      channel: "ding_work_notification",
    };
  }
  if (scenario?.pushSlot) {
    return {
      humanReviewRequired: false,
      target: scenario.pushSlot.target,
      channel: scenario.pushSlot.channel,
    };
  }
  return {
    humanReviewRequired: false,
    target: "self",
    channel: "ding_work_notification",
  };
}

async function submitCron(body: CronWizardSubmit): Promise<CronWizardResponse> {
  const res = await authFetch("/api/scenarios/create-cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`创建失败 (${res.status})`);
  return (await res.json()) as CronWizardResponse;
}

export function CronCreationWizard({
  open,
  scenario,
  onOpenChange,
  onCreated,
}: CronCreationWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [targetInput, setTargetInput] = useState("");
  const [monitorTargets, setMonitorTargets] = useState<string[]>([]);
  const [signalAdaptation, setSignalAdaptation] = useState<SignalAdaptation>(DEFAULT_SIGNAL);
  const [pushSlot, setPushSlot] = useState<PushSlotForm>(() => initialPushSlot(scenario));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const forceHumanReview = scenario?.pushSlot?.humanReviewRequired === true;
  const title = scenario?.title ?? "常驻监测";

  const body = useMemo<CronWizardSubmit | null>(() => {
    if (!scenario) return null;
    return {
      scenarioId: scenario.id,
      monitorTargets,
      signalAdaptation,
      pushSlot,
    };
  }, [monitorTargets, pushSlot, scenario, signalAdaptation]);

  const commitTargetInput = () => {
    if (!targetInput.trim()) return;
    setMonitorTargets((prev) => mergeTargets(prev, targetInput));
    setTargetInput("");
  };

  const reset = () => {
    setStep(1);
    setTargetInput("");
    setMonitorTargets([]);
    setSignalAdaptation(DEFAULT_SIGNAL);
    setPushSlot(initialPushSlot(scenario));
    setError(null);
    setSubmitting(false);
  };

  useEffect(() => {
    reset();
  }, [scenario?.id]);

  const validateCurrentStep = (): boolean => {
    setError(null);
    if (step === 1) {
      const targets = targetInput.trim() ? mergeTargets(monitorTargets, targetInput) : monitorTargets;
      const parsed = cronWizardSubmitSchema.shape.monitorTargets.safeParse(targets);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "请至少填写 1 个监测对象");
        return false;
      }
      setMonitorTargets(targets);
      setTargetInput("");
      return true;
    }
    if (step === 2) {
      const parsed = cronWizardSubmitSchema.shape.signalAdaptation.safeParse(signalAdaptation);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "请检查信噪比设置");
        return false;
      }
      return true;
    }
    if (!body) return false;
    const parsed = cronWizardSubmitSchema.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请检查推送落点");
      return false;
    }
    return true;
  };

  const handleNext = () => {
    if (!validateCurrentStep()) return;
    setStep((value) => (value === 1 ? 2 : 3));
  };

  const handleSubmit = async () => {
    if (!body || !validateCurrentStep()) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await submitCron(body);
      window.dispatchEvent(new CustomEvent("kaiyan:cron-configured", { detail: response }));
      onCreated?.(response);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>配置常驻监测</DialogTitle>
          <DialogDescription className="text-left">
            {title} · 分 3 步确认监测对象、变化条件和推送落点。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          {[1, 2, 3].map((item) => (
            <div
              key={item}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                item <= step ? "bg-brand-600" : "bg-muted",
              )}
            />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-3">
            <Label htmlFor="monitor-target">监测对象</Label>
            <Input
              id="monitor-target"
              value={targetInput}
              placeholder="输入客户、竞品、供应商或关键词，回车加入"
              onChange={(event) => setTargetInput(event.target.value)}
              onBlur={commitTargetInput}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === ",") {
                  event.preventDefault();
                  commitTargetInput();
                }
              }}
            />
            <div className="flex flex-wrap gap-2">
              {monitorTargets.map((target) => (
                <button
                  key={target}
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-1 text-xs"
                  onClick={() => setMonitorTargets((prev) => prev.filter((item) => item !== target))}
                >
                  {target}
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <SliderRow
              label="连续几天没变化后改为周报"
              value={signalAdaptation.dailyEmptyStreakToWeekly}
              min={1}
              max={14}
              onChange={(value) => setSignalAdaptation((prev) => ({ ...prev, dailyEmptyStreakToWeekly: value }))}
            />
            <SliderRow
              label="连续几天未打开后暂停"
              value={signalAdaptation.userNoOpenStreakToPause}
              min={1}
              max={30}
              onChange={(value) => setSignalAdaptation((prev) => ({ ...prev, userNoOpenStreakToPause: value }))}
            />
            <div className="space-y-2">
              <Label htmlFor="empty-fallback">没有明显变化时怎么发</Label>
              <Textarea
                id="empty-fallback"
                value={signalAdaptation.emptyContentFallback}
                onChange={(event) => setSignalAdaptation((prev) => ({ ...prev, emptyContentFallback: event.target.value }))}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSignalAdaptation(DEFAULT_SIGNAL)}
            >
              用推荐值
            </Button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            {forceHumanReview && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                该场景涉及对外发送，必须先发给主管确认。
              </div>
            )}
            <RadioOption
              label={friendlyPushTarget.self}
              description={friendlyPushChannel.ding_work_notification}
              disabled={forceHumanReview}
              checked={!pushSlot.humanReviewRequired && pushSlot.target === "self"}
              onSelect={() => setPushSlot({ humanReviewRequired: false, target: "self", channel: "ding_work_notification" })}
            />
            <RadioOption
              label={friendlyPushTarget.group}
              description={friendlyPushChannel.ding_group}
              disabled={forceHumanReview}
              checked={!pushSlot.humanReviewRequired && pushSlot.target === "group"}
              onSelect={() => setPushSlot({ humanReviewRequired: false, target: "group", channel: "ding_group" })}
            />
            <RadioOption
              label={friendlyPushTarget.manager}
              description={friendlyPushChannel.ding_work_notification}
              checked={pushSlot.humanReviewRequired || pushSlot.target === "manager"}
              onSelect={() => setPushSlot({ humanReviewRequired: true, target: "manager", channel: "ding_work_notification" })}
            />
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              随时可关，出差/休假可暂停/换公司，决定权在您手里。
            </div>
          </div>
        )}

        {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => (step === 1 ? onOpenChange(false) : setStep((value) => (value === 3 ? 2 : 1)))}>
            {step === 1 ? "取消" : "上一步"}
          </Button>
          {step < 3 ? (
            <Button type="button" onClick={handleNext}>下一步</Button>
          ) : (
            <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? "创建中..." : "创建监测"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>{label}</Label>
        <span className="text-sm text-muted-foreground">{value} 天</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        className="w-full"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function RadioOption({
  label,
  description,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
        checked ? "border-brand-400 bg-brand-50" : "hover:bg-muted/50",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onClick={onSelect}
    >
      <span className={cn("h-3.5 w-3.5 rounded-full border", checked && "border-brand-600 bg-brand-600")} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
