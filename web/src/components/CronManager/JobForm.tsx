import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { ModelList } from "@/types/models";
import type {
  CronJob,
  CronJobCreate,
  CronPayload,
  CronSchedule,
  DingtalkSessionSummary,
  NotifyConfig,
} from "./types";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

const MODEL_DEFAULT_VALUE = "__default__";

interface JobFormProps {
  mode?: "create" | "edit";
  initialJob?: CronJob;
  dingtalkSessions?: DingtalkSessionSummary[];
  modelList?: ModelList | null;
  onSubmit: (job: CronJobCreate) => Promise<void>;
  onSubmittingChange?: (submitting: boolean) => void;
}

function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export function JobForm({
  mode = "create",
  initialJob,
  dingtalkSessions,
  modelList,
  onSubmit,
  onSubmittingChange,
}: JobFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [scheduleKind, setScheduleKind] = useState<"every" | "cron" | "at">(
    () => initialJob?.schedule.kind ?? "every",
  );
  const [everyMinutes, setEveryMinutes] = useState("60");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [cronTz, setCronTz] = useState("Asia/Shanghai");
  const [atTime, setAtTime] = useState("");
  const [payloadKind, setPayloadKind] = useState<CronPayload["kind"]>("agentTurn");
  const [message, setMessage] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("1800");
  const [model, setModel] = useState(MODEL_DEFAULT_VALUE);
  const [ctxSystemPrompt, setCtxSystemPrompt] = useState(true);
  const [ctxPersona, setCtxPersona] = useState(true);
  const [ctxMemory, setCtxMemory] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [notifyChannel, setNotifyChannel] = useState<NotifyConfig["channel"]>("web");
  const [dingtalkMode, setDingtalkMode] = useState<"session" | "user" | "chat">("session");
  const [dingtalkConversationId, setDingtalkConversationId] = useState("");
  const [dingtalkUserId, setDingtalkUserId] = useState("");
  const [dingtalkChatId, setDingtalkChatId] = useState("");
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(true);
  const [notifyOnError, setNotifyOnError] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dingtalkWebhookCandidates = useMemo(
    () => (dingtalkSessions || []).filter((s) => s.hasWebhook),
    [dingtalkSessions]
  );

  useEffect(() => {
    if (!initialJob) {
      setName("");
      setDescription("");
      setEnabled(true);
      setScheduleKind("every");
      setEveryMinutes("60");
      setCronExpr("0 9 * * *");
      setCronTz("Asia/Shanghai");
      setAtTime("");
      setPayloadKind("agentTurn");
      setMessage("");
      setMaxTurns("");
      setTimeoutSeconds("1800");
      setModel(MODEL_DEFAULT_VALUE);
      setCtxSystemPrompt(true);
      setCtxPersona(true);
      setCtxMemory(true);
      setNotifyEnabled(false);
      setNotifyChannel("web");
      setDingtalkMode("session");
      setDingtalkConversationId("");
      setDingtalkUserId("");
      setDingtalkChatId("");
      setNotifyOnSuccess(true);
      setNotifyOnError(true);
      setSubmitting(false);
      setError(null);
      return;
    }

    setName(initialJob.name || "");
    setDescription(initialJob.description || "");
    setEnabled(!!initialJob.enabled);

    switch (initialJob.schedule.kind) {
      case "every": {
        const mins = Math.max(1, Math.round(initialJob.schedule.everyMs / 60000));
        setScheduleKind("every");
        setEveryMinutes(String(mins));
        setCronExpr("0 9 * * *");
        setCronTz("Asia/Shanghai");
        setAtTime("");
        break;
      }
      case "cron": {
        setScheduleKind("cron");
        setCronExpr(initialJob.schedule.expr || "");
        setCronTz(initialJob.schedule.tz || "");
        setEveryMinutes("60");
        setAtTime("");
        break;
      }
      case "at": {
        setScheduleKind("at");
        setAtTime(toDatetimeLocalValue(initialJob.schedule.atMs));
        setEveryMinutes("60");
        setCronExpr("0 9 * * *");
        setCronTz("Asia/Shanghai");
        break;
      }
    }

    if (initialJob.payload.kind === "agentTurn") {
      setPayloadKind("agentTurn");
      setMessage(initialJob.payload.message || "");
      setModel(initialJob.payload.model || MODEL_DEFAULT_VALUE);
      setMaxTurns(
        typeof initialJob.payload.maxTurns === "number"
          ? String(initialJob.payload.maxTurns)
          : ""
      );
      setTimeoutSeconds(
        typeof initialJob.payload.timeoutSeconds === "number"
          ? String(initialJob.payload.timeoutSeconds)
          : ""
      );
      const ctx = initialJob.payload.context;
      setCtxSystemPrompt(ctx?.systemPrompt ?? true);
      setCtxPersona(ctx?.persona ?? true);
      setCtxMemory(ctx?.memory ?? true);
    } else {
      setPayloadKind("systemEvent");
      setMessage(initialJob.payload.text || "");
      setMaxTurns("");
      setTimeoutSeconds("");
    }

    const notify = initialJob.notify;
    setNotifyEnabled(!!notify?.enabled);
    setNotifyChannel(notify?.channel ?? "web");
    setNotifyOnSuccess(notify?.onSuccess ?? true);
    setNotifyOnError(notify?.onError ?? true);

    const dingtalk = notify?.dingtalk;
    setDingtalkMode((dingtalk?.mode as any) ?? "session");
    setDingtalkConversationId(dingtalk?.conversationId ?? "");
    const userId = dingtalk?.userId;
    setDingtalkUserId(
      Array.isArray(userId) ? userId.map(String).join(",") : userId ?? ""
    );
    setDingtalkChatId(dingtalk?.chatId ?? "");

    setSubmitting(false);
    setError(null);
  }, [initialJob?.id]);

  useEffect(() => {
    onSubmittingChange?.(submitting);
  }, [submitting, onSubmittingChange]);

  useEffect(() => {
    const needsDingtalk =
      notifyEnabled && (notifyChannel === "dingtalk" || notifyChannel === "both");
    if (!needsDingtalk) return;
    if (dingtalkMode !== "session") return;
    if (dingtalkConversationId.trim()) return;
    if (dingtalkWebhookCandidates.length === 0) return;
    setDingtalkConversationId(dingtalkWebhookCandidates[0].conversationId);
  }, [
    notifyEnabled,
    notifyChannel,
    dingtalkConversationId,
    dingtalkMode,
    dingtalkWebhookCandidates,
  ]);

  useEffect(() => {
    const needsDingtalk =
      notifyEnabled && (notifyChannel === "dingtalk" || notifyChannel === "both");
    if (!needsDingtalk) return;
    if (dingtalkMode !== "user") return;
    if (dingtalkUserId.trim()) return;
    const candidate = (dingtalkSessions || []).find((s) => s.senderId?.trim());
    if (candidate?.senderId) setDingtalkUserId(candidate.senderId);
  }, [notifyEnabled, notifyChannel, dingtalkMode, dingtalkUserId, dingtalkSessions]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    let schedule: CronSchedule;
    switch (scheduleKind) {
      case "every":
        schedule = { kind: "every", everyMs: Math.max(1, parseInt(everyMinutes) || 1) * 60000 };
        break;
      case "cron":
        schedule = { kind: "cron", expr: cronExpr, tz: cronTz || undefined };
        break;
      case "at": {
        const atMs = new Date(atTime).getTime();
        if (Number.isNaN(atMs)) {
          setError("请选择有效的执行时间");
          return;
        }
        schedule = { kind: "at", atMs };
        break;
      }
    }

    const parsedMaxTurns = maxTurns.trim() ? parseInt(maxTurns, 10) : undefined;
    const parsedTimeoutSeconds = timeoutSeconds.trim()
      ? parseInt(timeoutSeconds, 10)
      : undefined;

    let payload: CronPayload;
    if (payloadKind === "systemEvent") {
      payload = { kind: "systemEvent", text: message.trim() };
    } else {
      // 仅在有开关被关闭时才传 context，全部为 true 时省略
      const hasContextOverride = !ctxSystemPrompt || !ctxPersona || !ctxMemory;
      const context = hasContextOverride
        ? {
            ...(!ctxSystemPrompt ? { systemPrompt: false as const } : {}),
            ...(!ctxPersona ? { persona: false as const } : {}),
            ...(!ctxMemory ? { memory: false as const } : {}),
          }
        : undefined;
      payload = {
        kind: "agentTurn",
        message: message.trim(),
        ...(model !== MODEL_DEFAULT_VALUE ? { model } : {}),
        ...(Number.isFinite(parsedMaxTurns) ? { maxTurns: parsedMaxTurns } : {}),
        ...(Number.isFinite(parsedTimeoutSeconds)
          ? { timeoutSeconds: parsedTimeoutSeconds }
          : {}),
        ...(context ? { context } : {}),
      };
    }

    const needsDingtalk =
      notifyEnabled && (notifyChannel === "dingtalk" || notifyChannel === "both");
    if (needsDingtalk) {
      if (dingtalkMode === "session" && !dingtalkConversationId.trim()) {
        setError("请选择钉钉会话（conversationId），用于 sessionWebhook 通知（90分钟有效）");
        return;
      }
      if (dingtalkMode === "user" && !dingtalkUserId.trim()) {
        setError("请填写钉钉 userId，用于主动私聊发送通知");
        return;
      }
      if (dingtalkMode === "chat" && !dingtalkChatId.trim()) {
        setError("请填写钉钉 chatId（openConversationId），用于主动群聊发送通知");
        return;
      }
    }

    const dingtalk = {
      mode: dingtalkMode,
      ...(dingtalkMode === "session"
        ? { conversationId: dingtalkConversationId.trim() }
        : {}),
      ...(dingtalkMode === "user" ? { userId: dingtalkUserId.trim() } : {}),
      ...(dingtalkMode === "chat" ? { chatId: dingtalkChatId.trim() } : {}),
    };

    const notify =
      notifyEnabled || (mode === "edit" && initialJob?.notify)
        ? {
            enabled: notifyEnabled,
            channel: notifyChannel,
            onSuccess: notifyOnSuccess,
            onError: notifyOnError,
            ...(notifyChannel === "dingtalk" || notifyChannel === "both"
              ? { dingtalk }
              : {}),
          }
        : undefined;

    const job: CronJobCreate = {
      name: name.trim(),
      description: description.trim(),
      enabled,
      schedule,
      payload,
      notify,
    };

    setSubmitting(true);
    try {
      await onSubmit(job);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form id="cron-job-form" onSubmit={handleSubmit} className="space-y-5">
      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="job-name">任务名称 *</Label>
        <Input
          id="job-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如: 每日报告"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="job-desc">描述</Label>
        <Input
          id="job-desc"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="任务描述（可选）"
        />
      </div>

      <div className="flex items-center space-x-2">
        <Checkbox
          id="job-enabled"
          checked={enabled}
          onCheckedChange={(v) => setEnabled(!!v)}
        />
        <Label htmlFor="job-enabled">启用任务</Label>
      </div>

      <Separator />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="job-schedule-kind">调度类型</Label>
          <Select
            value={scheduleKind}
            onValueChange={(v) => setScheduleKind(v as "every" | "cron" | "at")}
          >
            <SelectTrigger id="job-schedule-kind">
              <SelectValue placeholder="选择调度类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="every">间隔执行</SelectItem>
              <SelectItem value="cron">Cron 表达式</SelectItem>
              <SelectItem value="at">一次性执行</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {scheduleKind === "every" ? (
          <div className="space-y-2">
            <Label htmlFor="job-every">执行间隔（分钟）</Label>
            <Input
              id="job-every"
              type="number"
              value={everyMinutes}
              onChange={(e) => setEveryMinutes(e.target.value)}
              min={1}
              required
            />
          </div>
        ) : null}

        {scheduleKind === "cron" ? (
          <div className="space-y-2">
            <Label htmlFor="job-cron">Cron 表达式（5 字段）</Label>
            <Input
              id="job-cron"
              type="text"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="分 时 日 月 周"
              required
            />
            <p className="text-xs text-muted-foreground">
              例如: 0 9 * * * 表示每天 9:00
            </p>
          </div>
        ) : null}

        {scheduleKind === "at" ? (
          <div className="space-y-2">
            <Label htmlFor="job-at">执行时间</Label>
            <Input
              id="job-at"
              type="datetime-local"
              value={atTime}
              onChange={(e) => setAtTime(e.target.value)}
              required
            />
          </div>
        ) : null}
      </div>

      {scheduleKind === "cron" ? (
        <div className="space-y-2">
          <Label htmlFor="job-tz">时区</Label>
          <Input
            id="job-tz"
            type="text"
            value={cronTz}
            onChange={(e) => setCronTz(e.target.value)}
            placeholder="Asia/Shanghai"
          />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {payloadKind === "agentTurn" && modelList && modelList.groups.length > 0 ? (
          <div className="space-y-2">
            <Label>模型（可选）</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue placeholder="使用默认模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MODEL_DEFAULT_VALUE}>使用默认模型</SelectItem>
                {modelList.showGroupNames ? (
                  modelList.groups.map((group) => (
                    <SelectGroup key={group.id}>
                      <SelectLabel>{group.name}</SelectLabel>
                      {group.models.map((m) => (
                        <SelectItem key={`${group.id}/${m.id}`} value={`${group.id}/${m.id}`}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))
                ) : (
                  modelList.groups.flatMap((group) => group.models.map((m) => (
                    <SelectItem key={`${group.id}/${m.id}`} value={`${group.id}/${m.id}`}>
                      {m.name}
                    </SelectItem>
                  )))
                )}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label>任务类型</Label>
          <Select value={payloadKind} onValueChange={(v) => setPayloadKind(v as any)}>
            <SelectTrigger>
              <SelectValue placeholder="选择任务类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agentTurn">Agent 执行</SelectItem>
              <SelectItem value="systemEvent">系统事件</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="job-message">
          {payloadKind === "systemEvent" ? "事件内容 *" : "Agent 提示词 *"}
        </Label>
        <Textarea
          id="job-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={payloadKind === "systemEvent" ? "要记录/通知的事件文本" : "发送给 Agent 的消息"}
          className="min-h-[66vh] resize-y"
          required
        />
      </div>

      {payloadKind === "agentTurn" ? (
        <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="job-max-turns">最大轮次（可选）</Label>
          <Input
            id="job-max-turns"
            type="number"
            value={maxTurns}
            onChange={(e) => setMaxTurns(e.target.value)}
            min={1}
            placeholder="留空使用默认值"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="job-timeout">超时（秒）</Label>
          <Input
            id="job-timeout"
            type="number"
            value={timeoutSeconds}
            onChange={(e) => setTimeoutSeconds(e.target.value)}
            min={0}
            placeholder="0 表示不设置超时"
          />
          <p className="text-xs text-muted-foreground">
            0 表示不设置超时；留空使用服务端默认值。
          </p>
        </div>
        </div>
      ) : null}

      {payloadKind === "agentTurn" ? (
        <div className="space-y-3">
          <Label className="text-sm font-medium">上下文注入</Label>
          <div className="space-y-2 rounded-md border bg-muted/20 px-4 py-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="ctx-system-prompt"
                checked={ctxSystemPrompt}
                onCheckedChange={(v) => setCtxSystemPrompt(!!v)}
              />
              <Label htmlFor="ctx-system-prompt" className="font-normal">系统提示语（含 SOUL 规范）</Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="ctx-persona"
                checked={ctxPersona}
                onCheckedChange={(v) => setCtxPersona(!!v)}
              />
              <Label htmlFor="ctx-persona" className="font-normal">Agent 人格 (PERSONA)</Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="ctx-memory"
                checked={ctxMemory}
                onCheckedChange={(v) => setCtxMemory(!!v)}
              />
              <Label htmlFor="ctx-memory" className="font-normal">长期记忆 (MEMORY.md)</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              关闭不需要的上下文可减少 token 消耗。全部关闭后 Agent 仅使用基础能力执行任务。
            </p>
          </div>
        </div>
      ) : null}

      <Separator />

      <div className="flex items-center space-x-2">
        <Checkbox
          id="job-notify-enabled"
          checked={notifyEnabled}
          onCheckedChange={(v) => setNotifyEnabled(!!v)}
        />
        <Label htmlFor="job-notify-enabled">启用通知</Label>
      </div>

      {notifyEnabled ? (
        <div className="space-y-4 rounded-md border bg-muted/20 p-4">
          <div className="space-y-2">
            <Label>通知渠道</Label>
            <Select
              value={notifyChannel}
              onValueChange={(v) => setNotifyChannel(v as NotifyConfig["channel"])}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择通知渠道" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="web">Web</SelectItem>
                <SelectItem value="dingtalk">钉钉</SelectItem>
                <SelectItem value="both">两者</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {notifyChannel === "dingtalk" || notifyChannel === "both" ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>钉钉发送方式</Label>
                <Select
                  value={dingtalkMode}
                  onValueChange={(v) => setDingtalkMode(v as "session" | "user" | "chat")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择发送方式" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="session">sessionWebhook（90分钟有效）</SelectItem>
                    <SelectItem value="user">主动私聊（userId）</SelectItem>
                    <SelectItem value="chat">主动群聊（chatId）</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  建议定时任务使用“主动发送”（user/chat），避免 sessionWebhook 过期导致通知失败。
                </p>
              </div>

              {dingtalkMode === "session" ? (
                <div className="space-y-2">
                  <Label>会话（conversationId） *</Label>
                  {dingtalkWebhookCandidates.length > 0 ? (
                    <Select
                      value={dingtalkConversationId}
                      onValueChange={(v) => setDingtalkConversationId(v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="选择一个已建立的钉钉会话" />
                      </SelectTrigger>
                      <SelectContent>
                        {dingtalkWebhookCandidates.map((s) => (
                          <SelectItem key={s.conversationId} value={s.conversationId}>
                            {s.senderNick}（{s.conversationType === "1" ? "私聊" : "群聊"}）
                            {s.lastUpdatedAt ? ` · ${s.lastUpdatedAt}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={dingtalkConversationId}
                      onChange={(e) => setDingtalkConversationId(e.target.value)}
                      placeholder="手动填写 conversationId（建议先在钉钉里给机器人发条消息生成会话）"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    该方式依赖 sessionWebhook（90分钟有效），更适合“刚刚在钉钉里交互过”的短期通知。
                  </p>
                </div>
              ) : null}

              {dingtalkMode === "user" ? (
                <div className="space-y-2">
                  <Label>userId（私聊接收人） *</Label>
                  <Input
                    value={dingtalkUserId}
                    onChange={(e) => setDingtalkUserId(e.target.value)}
                    placeholder="例如：user123456"
                  />
                  <p className="text-xs text-muted-foreground">
                    主动私聊发送不依赖 sessionWebhook；userId 通常可从会话列表的 senderId 获得。
                  </p>
                </div>
              ) : null}

              {dingtalkMode === "chat" ? (
                <div className="space-y-2">
                  <Label>chatId（openConversationId） *</Label>
                  <Input
                    value={dingtalkChatId}
                    onChange={(e) => setDingtalkChatId(e.target.value)}
                    placeholder="例如：cidxxxxxxxx=="
                  />
                  <p className="text-xs text-muted-foreground">
                    主动群聊发送不依赖 sessionWebhook；chatId 通常就是该群的 conversationId（以 cid... 开头）。
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="notify-success"
                checked={notifyOnSuccess}
                onCheckedChange={(v) => setNotifyOnSuccess(!!v)}
              />
              <Label htmlFor="notify-success">成功时通知</Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="notify-error"
                checked={notifyOnError}
                onCheckedChange={(v) => setNotifyOnError(!!v)}
              />
              <Label htmlFor="notify-error">失败时通知</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Web 通知目前仅用于调试输出（服务端控制台）。钉钉通知需要选择目标会话（conversationId）。
            </p>
          </div>
        </div>
      ) : null}

    </form>
  );
}
