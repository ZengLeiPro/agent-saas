import { useEffect, useRef, useState, type FormEvent } from "react";
import { TASKBOARD_DEFAULT_PROMPT, TASKBOARD_STAGE_DEFAULT_PROMPTS } from "@agent/shared";
import type {
  ModelList,
  TaskBoard,
  TaskBoardCreateInput,
  TaskBoardPatchInput,
  TaskBoardVisibility,
} from "@agent/shared";
import type { TaskBoardCiPolicyDiscovery, TaskBoardExecutionPurpose, TaskBoardIntegrationPolicy, TaskBoardIntegrationTriggerMode, TaskBoardStageModels, TaskBoardStagePrompts } from "@agent/shared/types/taskboard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BoardMembers } from "./BoardMembers";
import { fetchBoardCiPolicyDiscovery } from "./api";
import { boardAllows } from "./constants";
import { ModelSelect } from "./ModelSelect";

type BoardDraftField = "name" | "description" | "prompt" | "model" | "stageModels" | "stagePrompts" | "visibility" | "repository" | "integrationPolicy";

/** 看板可配置的各执行阶段，用于阶段默认模型选择。 */
const STAGE_MODEL_FIELDS: Array<{ purpose: TaskBoardExecutionPurpose; title: string; hint: string }> = [
  { purpose: "work", title: "实施（work）", hint: "实施 Agent 处理可交付任务时使用的默认模型" },
  { purpose: "review", title: "复核（review）", hint: "复核 Agent 审查工作结果时使用的默认模型" },
  { purpose: "merge", title: "集成（merge）", hint: "集成 Agent 合并交付时使用的默认模型" },
];

function numberInRange(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function formatCiRequiredChecks(policy: TaskBoardIntegrationPolicy): string {
  return (policy.ciPolicy?.requiredChecks ?? [])
    .map((check) => check.appId === undefined ? check.name : `${check.name} | ${check.appId}`)
    .join("\n");
}

function parseCiRequiredChecks(value: string): TaskBoardIntegrationPolicy["ciPolicy"] {
  const checks = value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [rawName, rawAppId, ...extra] = line.split("|").map((part) => part.trim());
    if (!rawName || extra.length > 0) throw new Error("每行填写检查名称，或“检查名称 | GitHub App ID”");
    if (!rawAppId) return { name: rawName };
    const appId = Number(rawAppId);
    if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error("GitHub App ID 必须是正整数");
    return { name: rawName, appId };
  });
  const identities = new Set<string>();
  for (const check of checks) {
    const identity = `${check.name}\u0000${check.appId ?? "*"}`;
    if (identities.has(identity)) throw new Error(`重复的 CI 检查：${check.name}`);
    identities.add(identity);
  }
  return checks.length ? { requiredChecks: checks } : undefined;
}

function ciCheckSelected(value: string, name: string, appId?: number): boolean {
  try {
    return (parseCiRequiredChecks(value)?.requiredChecks ?? [])
      .some((check) => check.name === name && check.appId === appId);
  } catch { return false; }
}

function defaultPolicy(): TaskBoardIntegrationPolicy {
  return {
    schemaVersion: 1,
    enabled: true,
    revision: "server",
    workflowVersion: 3,
    trigger: { mode: "manual", allowedRoles: ["maintainer", "owner"] },
    batch: { maxTasks: 10, selection: "priority_then_ready_at" },
    execution: {
      mergeMethod: "squash",
      continueIndependentSources: true,
      autoResolveConflicts: true,
      maxAutomaticRemediationRounds: 2,
      maxTransientRetries: 3,
      requireGreenChecks: true,
      deleteRemoteBranch: false,
      deploy: false,
    },
  };
}

interface BoardDialogProps {
  open: boolean;
  active?: boolean;
  board?: TaskBoard;
  modelList?: ModelList | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: TaskBoardCreateInput) => Promise<void>;
  onUpdate: (id: string, input: TaskBoardPatchInput) => Promise<void>;
}

export function BoardDialog({
  open,
  active = true,
  board,
  modelList = null,
  onOpenChange,
  onCreate,
  onUpdate,
}: BoardDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState(TASKBOARD_DEFAULT_PROMPT);
  const [stagePrompts, setStagePrompts] = useState<TaskBoardStagePrompts>({ ...TASKBOARD_STAGE_DEFAULT_PROMPTS });
  const [model, setModel] = useState<string | null>(null);
  const [stageModels, setStageModels] = useState<TaskBoardStageModels>({});
  const [visibility, setVisibility] = useState<TaskBoardVisibility>("personal");
  const [repositoryEnabled, setRepositoryEnabled] = useState(false);
  const [repositoryId, setRepositoryId] = useState("");
  const [repositoryOwner, setRepositoryOwner] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [policyEnabled, setPolicyEnabled] = useState(true);
  const [triggerMode, setTriggerMode] = useState<TaskBoardIntegrationTriggerMode>("manual");
  const [cron, setCron] = useState("0 2 * * *");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [debounceMs, setDebounceMs] = useState("300000");
  const [manualMaintainer, setManualMaintainer] = useState(true);
  const [maxTasks, setMaxTasks] = useState("10");
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [maxRemediationRounds, setMaxRemediationRounds] = useState("2");
  const [maxTransientRetries, setMaxTransientRetries] = useState("3");
  const [ciRequiredChecks, setCiRequiredChecks] = useState("");
  const [ciDiscovery, setCiDiscovery] = useState<TaskBoardCiPolicyDiscovery | null>(null);
  const [ciDiscoveryLoading, setCiDiscoveryLoading] = useState(false);
  const [ciDiscoveryError, setCiDiscoveryError] = useState<string | null>(null);
  const [ciPolicySaved, setCiPolicySaved] = useState(false);
  const [repositoryCiPolicyReset, setRepositoryCiPolicyReset] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyFieldsRef = useRef<Set<BoardDraftField>>(new Set());
  const boardIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) return;
    const boardId = board?.id ?? null;
    const switchedBoard = boardIdRef.current !== boardId;
    if (opening || switchedBoard) {
      boardIdRef.current = boardId;
      dirtyFieldsRef.current.clear();
      setName(board?.name ?? "");
      setDescription(board?.description ?? "");
      setPrompt(board?.prompt ?? TASKBOARD_DEFAULT_PROMPT);
      setStagePrompts({ ...TASKBOARD_STAGE_DEFAULT_PROMPTS, ...(board?.stagePrompts ?? {}) });
      setModel(board?.model ?? null);
      setStageModels({ ...(board?.stageModels ?? {}) });
      setVisibility(board?.visibility ?? "personal");
      const repository = board?.repository;
      setRepositoryEnabled(Boolean(repository));
      setRepositoryId(repository?.repositoryId ?? "");
      setRepositoryOwner(repository?.owner ?? "");
      setRepositoryName(repository?.name ?? "");
      setBaseBranch(repository?.baseBranch ?? "main");
      const policy = board?.integrationPolicy ?? defaultPolicy();
      setPolicyEnabled(policy.enabled);
      setTriggerMode(policy.trigger.mode);
      setCron(policy.trigger.mode === "scheduled" ? policy.trigger.cron : "0 2 * * *");
      setTimezone(policy.trigger.mode === "scheduled" ? policy.trigger.timezone : "Asia/Shanghai");
      setDebounceMs(String(policy.trigger.mode === "on_ready" ? policy.trigger.debounceMs : 300_000));
      setManualMaintainer(policy.trigger.mode !== "manual" || policy.trigger.allowedRoles.includes("maintainer"));
      setMaxTasks(String(policy.batch.maxTasks));
      setMergeMethod(policy.execution.mergeMethod);
      setMaxRemediationRounds(String(policy.execution.maxAutomaticRemediationRounds));
      setMaxTransientRetries(String(policy.execution.maxTransientRetries));
      setCiRequiredChecks(formatCiRequiredChecks(policy));
      setCiPolicySaved(false);
      setRepositoryCiPolicyReset(false);
      setError(null);
      return;
    }
    if (!board) return;
    if (!dirtyFieldsRef.current.has("name")) setName(board.name);
    if (!dirtyFieldsRef.current.has("description")) setDescription(board.description ?? "");
    if (!dirtyFieldsRef.current.has("prompt")) setPrompt(board.prompt);
    if (!dirtyFieldsRef.current.has("stagePrompts")) {
      setStagePrompts({ ...TASKBOARD_STAGE_DEFAULT_PROMPTS, ...(board.stagePrompts ?? {}) });
    }
    if (!dirtyFieldsRef.current.has("model")) setModel(board.model ?? null);
    if (!dirtyFieldsRef.current.has("stageModels")) setStageModels({ ...(board.stageModels ?? {}) });
    if (!dirtyFieldsRef.current.has("visibility")) setVisibility(board.visibility);
    if (!dirtyFieldsRef.current.has("repository")) {
      setRepositoryEnabled(Boolean(board.repository));
      setRepositoryId(board.repository?.repositoryId ?? "");
      setRepositoryOwner(board.repository?.owner ?? "");
      setRepositoryName(board.repository?.name ?? "");
      setBaseBranch(board.repository?.baseBranch ?? "main");
    }
    if (!dirtyFieldsRef.current.has("integrationPolicy")) {
      const policy = board.integrationPolicy ?? defaultPolicy();
      setPolicyEnabled(policy.enabled);
      setTriggerMode(policy.trigger.mode);
      setCron(policy.trigger.mode === "scheduled" ? policy.trigger.cron : "0 2 * * *");
      setTimezone(policy.trigger.mode === "scheduled" ? policy.trigger.timezone : "Asia/Shanghai");
      setDebounceMs(String(policy.trigger.mode === "on_ready" ? policy.trigger.debounceMs : 300_000));
      setManualMaintainer(policy.trigger.mode !== "manual" || policy.trigger.allowedRoles.includes("maintainer"));
      setMaxTasks(String(policy.batch.maxTasks));
      setMergeMethod(policy.execution.mergeMethod);
      setMaxRemediationRounds(String(policy.execution.maxAutomaticRemediationRounds));
      setMaxTransientRetries(String(policy.execution.maxTransientRetries));
      setCiRequiredChecks(formatCiRequiredChecks(policy));
    }
  }, [board, open]);

  useEffect(() => {
    if (!open || !board?.repository) {
      setCiDiscovery(null);
      setCiDiscoveryError(null);
      setCiDiscoveryLoading(false);
      return;
    }
    let active = true;
    setCiDiscovery(null);
    setCiDiscoveryLoading(true);
    setCiDiscoveryError(null);
    void fetchBoardCiPolicyDiscovery(board.id).then((result) => {
      if (active) setCiDiscovery(result);
    }).catch((caught) => {
      if (active) setCiDiscoveryError(caught instanceof Error ? caught.message : "读取 CI 门禁信息失败");
    }).finally(() => {
      if (active) setCiDiscoveryLoading(false);
    });
    return () => { active = false; };
  }, [board?.id, board?.repository, open]);

  const canEditSettings = !board || boardAllows(board, "board.update");
  const canEditPolicy = !board || boardAllows(board, "board.policy.update");
  const canManageMembers = Boolean(board && boardAllows(board, "board.members.manage"));
  const visibleCiDiscovery = repositoryCiPolicyReset ? null : ciDiscovery;

  const changeRepositoryId = (next: string) => {
    dirtyFieldsRef.current.add("repository");
    const originalRepositoryId = board?.repository?.repositoryId;
    if (originalRepositoryId && next.trim() !== originalRepositoryId) {
      dirtyFieldsRef.current.add("integrationPolicy");
      setCiRequiredChecks("");
      setCiPolicySaved(false);
      setRepositoryCiPolicyReset(true);
    } else if (originalRepositoryId) {
      setCiRequiredChecks(formatCiRequiredChecks(board.integrationPolicy ?? defaultPolicy()));
      setRepositoryCiPolicyReset(false);
    }
    setRepositoryId(next);
  };

  const setObservedCheckSelected = (name: string, appId: number | undefined, selected: boolean) => {
    dirtyFieldsRef.current.add("integrationPolicy");
    setCiPolicySaved(false);
    let current: NonNullable<TaskBoardIntegrationPolicy["ciPolicy"]>["requiredChecks"];
    try { current = parseCiRequiredChecks(ciRequiredChecks)?.requiredChecks ?? []; }
    catch (caught) { setError(caught instanceof Error ? caught.message : "CI fallback 配置无效"); return; }
    const identity = (check: { name: string; appId?: number }) => `${check.name}\u0000${check.appId ?? "*"}`;
    const target = identity({ name, ...(appId !== undefined ? { appId } : {}) });
    const next = selected
      ? [...current.filter((check) => identity(check) !== target), { name, ...(appId !== undefined ? { appId } : {}) }]
      : current.filter((check) => identity(check) !== target);
    setCiRequiredChecks(next.map((check) => check.appId === undefined ? check.name : `${check.name} | ${check.appId}`).join("\n"));
  };

  const setStageModel = (purpose: TaskBoardExecutionPurpose, next: string | null) => {
    dirtyFieldsRef.current.add("stageModels");
    setStageModels((prev) => {
      const updated = { ...prev };
      if (next) updated[purpose] = next;
      else delete updated[purpose];
      return updated;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError("请输入看板名称");
      return;
    }
    if (repositoryEnabled && (!repositoryId.trim() || !repositoryOwner.trim() || !repositoryName.trim() || !baseBranch.trim())) {
      setError("请完整填写 GitHub 仓库标识、所有者、仓库名和基础分支");
      return;
    }
    if (repositoryEnabled && triggerMode === "scheduled" && (!cron.trim() || !timezone.trim())) {
      setError("定时集成需要 cron 表达式和时区");
      return;
    }
    if (board && dirtyFieldsRef.current.size === 0) {
      onOpenChange(false);
      return;
    }
    const repository = repositoryEnabled ? {
      provider: "github" as const,
      repositoryId: repositoryId.trim(),
      owner: repositoryOwner.trim(),
      name: repositoryName.trim(),
      baseBranch: baseBranch.trim(),
      allowForkPullRequest: false as const,
    } : undefined;
    const previousPolicy = board?.integrationPolicy ?? defaultPolicy();
    const normalizedStageModels = Object.fromEntries(
      STAGE_MODEL_FIELDS.flatMap(({ purpose }) => {
        const value = stageModels[purpose];
        if (typeof value !== "string") return [];
        const trimmed = value.trim();
        return trimmed ? [[purpose, trimmed] as const] : [];
      }),
    ) as TaskBoardStageModels;
    // 只提交与系统默认模板不同的阶段（未覆盖阶段保持空白 → 执行时跟随系统固定模板更新）。
    const normalizedStagePrompts = Object.fromEntries(
      (Object.keys(TASKBOARD_STAGE_DEFAULT_PROMPTS) as TaskBoardExecutionPurpose[]).flatMap((purpose) => {
        const value = stagePrompts[purpose];
        if (typeof value !== "string") return [];
        const trimmed = value.trim();
        if (!trimmed || trimmed === TASKBOARD_STAGE_DEFAULT_PROMPTS[purpose]) return [];
        return [[purpose, trimmed] as const];
      }),
    ) as TaskBoardStagePrompts;
    let ciPolicy: TaskBoardIntegrationPolicy["ciPolicy"];
    try {
      ciPolicy = parseCiRequiredChecks(ciRequiredChecks);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "CI fallback 配置无效");
      return;
    }
    const integrationPolicy: TaskBoardIntegrationPolicy = {
      schemaVersion: 1,
      enabled: repositoryEnabled && policyEnabled,
      revision: previousPolicy.revision || "server",
      workflowVersion: 3,
      ...(ciPolicy ? { ciPolicy } : {}),
      trigger: triggerMode === "scheduled"
        ? { mode: "scheduled", cron: cron.trim(), timezone: timezone.trim() }
        : triggerMode === "on_ready"
          ? { mode: "on_ready", debounceMs: numberInRange(debounceMs, 300_000, 0, 86_400_000) }
          : { mode: "manual", allowedRoles: manualMaintainer ? ["maintainer", "owner"] : ["owner"] },
      batch: {
        maxTasks: numberInRange(maxTasks, 10, 1, 100),
        selection: "priority_then_ready_at",
      },
      execution: {
        mergeMethod,
        continueIndependentSources: true,
        autoResolveConflicts: true,
        maxAutomaticRemediationRounds: numberInRange(maxRemediationRounds, 2, 0, 20),
        maxTransientRetries: numberInRange(maxTransientRetries, 3, 0, 20),
        requireGreenChecks: true,
        deleteRemoteBranch: false,
        deploy: false,
      },
    };
    const shouldEchoCiPolicy = Boolean(board && (
      dirtyFieldsRef.current.has("integrationPolicy") || dirtyFieldsRef.current.has("repository")
    ));
    setSubmitting(true);
    setError(null);
    try {
      if (board) {
        const input: TaskBoardPatchInput = { expectedVersion: board.version };
        if (dirtyFieldsRef.current.has("name")) input.name = normalizedName;
        if (dirtyFieldsRef.current.has("description")) input.description = description.trim();
        if (dirtyFieldsRef.current.has("prompt")) input.prompt = prompt.trim();
        if (dirtyFieldsRef.current.has("stagePrompts")) input.stagePrompts = normalizedStagePrompts;
        if (dirtyFieldsRef.current.has("model")) input.model = model;
        if (dirtyFieldsRef.current.has("stageModels")) input.stageModels = normalizedStageModels;
        if (dirtyFieldsRef.current.has("visibility")) input.visibility = visibility;
        if (dirtyFieldsRef.current.has("repository")) input.repository = repository ?? null;
        if (dirtyFieldsRef.current.has("integrationPolicy") || dirtyFieldsRef.current.has("repository")) {
          input.integrationPolicy = repository ? integrationPolicy : null;
        }
        await onUpdate(board.id, input);
        if (shouldEchoCiPolicy) {
          dirtyFieldsRef.current.clear();
          if (repository) {
            try {
              const finalPolicy = await fetchBoardCiPolicyDiscovery(board.id);
              setCiDiscovery(finalPolicy);
              setCiRequiredChecks(finalPolicy.boardRequiredChecks
                .map((check) => check.appId === undefined ? check.name : `${check.name} | ${check.appId}`).join("\n"));
              setCiDiscoveryError(null);
              setRepositoryCiPolicyReset(false);
              setCiPolicySaved(true);
            } catch (caught) {
              const reason = caught instanceof Error ? caught.message : "读取保存后的 CI 门禁策略失败";
              setCiDiscoveryError(`保存成功，但未能回读最终 CI 策略：${reason}`);
              setCiPolicySaved(false);
            }
          } else {
            setCiDiscovery(null);
            setCiDiscoveryError(null);
            setRepositoryCiPolicyReset(false);
            setCiPolicySaved(true);
          }
          return;
        }
      } else {
        await onCreate({
          name: normalizedName,
          ...(description.trim() ? { description: description.trim() } : {}),
          prompt: prompt.trim(),
          ...(Object.keys(normalizedStagePrompts).length ? { stagePrompts: normalizedStagePrompts } : {}),
          ...(model ? { model } : {}),
          ...(Object.keys(normalizedStageModels).length ? { stageModels: normalizedStageModels } : {}),
          visibility,
          ...(repository ? { repository, integrationPolicy } : {}),
        });
      }
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存看板失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={active && open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && submitting) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{board ? "编辑看板" : "创建看板"}</DialogTitle>
          <DialogDescription>
            {board ? "修改看板、GitHub 集成策略与成员角色。" : "创建看板，并按需配置 GitHub 集成策略。"}
          </DialogDescription>
        </DialogHeader>
        <form id="taskboard-board-form" className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="taskboard-board-name">名称</Label>
            <Input
              id="taskboard-board-name"
              value={name}
              onChange={(event) => {
                dirtyFieldsRef.current.add("name");
                setName(event.target.value);
              }}
              placeholder="例如：产品研发"
              disabled={submitting || !canEditSettings}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="taskboard-board-description">说明</Label>
            <Textarea
              id="taskboard-board-description"
              value={description}
              onChange={(event) => {
                dirtyFieldsRef.current.add("description");
                setDescription(event.target.value);
              }}
              placeholder="这个看板用于管理什么？"
              rows={4}
              disabled={submitting || !canEditSettings}
            />
          </div>
          <div className="space-y-2">
            <Label>可见范围</Label>
            <Select
              value={visibility}
              onValueChange={(value) => {
                dirtyFieldsRef.current.add("visibility");
                setVisibility(value as TaskBoardVisibility);
              }}
              disabled={submitting || !canEditSettings}
            >
              <SelectTrigger aria-label="看板可见范围">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">个人</SelectItem>
                <SelectItem value="organization">组织</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {visibility === "organization"
                ? "组织内所有成员都能查看并管理此看板中的任务；Agent 仍继承看板创建者的上下文。"
                : "仅自己可查看和管理此看板。"}
            </p>
          </div>
          <section aria-label="GitHub 与集成策略" className="space-y-4 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="taskboard-repository-enabled"
                checked={repositoryEnabled}
                onCheckedChange={(checked) => {
                  dirtyFieldsRef.current.add("repository");
                  dirtyFieldsRef.current.add("integrationPolicy");
                  setRepositoryEnabled(checked === true);
                }}
                disabled={submitting || !canEditPolicy}
              />
              <Label htmlFor="taskboard-repository-enabled">关联 GitHub 仓库</Label>
            </div>
            {repositoryEnabled ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="taskboard-repository-id">Repository ID</Label>
                    <Input id="taskboard-repository-id" value={repositoryId} onChange={(event) => changeRepositoryId(event.target.value)} placeholder="GitHub App 仓库标识" disabled={submitting || !canEditPolicy} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="taskboard-base-branch">基础分支</Label>
                    <Input id="taskboard-base-branch" value={baseBranch} onChange={(event) => { dirtyFieldsRef.current.add("repository"); setBaseBranch(event.target.value); }} placeholder="main" disabled={submitting || !canEditPolicy} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="taskboard-repository-owner">仓库所有者</Label>
                    <Input id="taskboard-repository-owner" value={repositoryOwner} onChange={(event) => { dirtyFieldsRef.current.add("repository"); setRepositoryOwner(event.target.value); }} placeholder="octo-org" disabled={submitting || !canEditPolicy} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="taskboard-repository-name">仓库名</Label>
                    <Input id="taskboard-repository-name" value={repositoryName} onChange={(event) => { dirtyFieldsRef.current.add("repository"); setRepositoryName(event.target.value); }} placeholder="product" disabled={submitting || !canEditPolicy} />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="taskboard-policy-enabled"
                    checked={policyEnabled}
                    onCheckedChange={(checked) => { dirtyFieldsRef.current.add("integrationPolicy"); setPolicyEnabled(checked === true); }}
                    disabled={submitting || !canEditPolicy}
                  />
                  <Label htmlFor="taskboard-policy-enabled">启用集成策略</Label>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>触发模式</Label>
                    <Select value={triggerMode} onValueChange={(value) => { dirtyFieldsRef.current.add("integrationPolicy"); setTriggerMode(value as TaskBoardIntegrationTriggerMode); }} disabled={submitting || !canEditPolicy}>
                      <SelectTrigger aria-label="集成触发模式"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="scheduled">定时触发</SelectItem>
                        <SelectItem value="on_ready">就绪触发</SelectItem>
                        <SelectItem value="manual">人工触发</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="taskboard-max-tasks">每批最多任务</Label>
                    <Input id="taskboard-max-tasks" type="number" min={1} max={100} value={maxTasks} onChange={(event) => { dirtyFieldsRef.current.add("integrationPolicy"); setMaxTasks(event.target.value); }} disabled={submitting || !canEditPolicy} />
                  </div>
                </div>
                {triggerMode === "scheduled" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2"><Label htmlFor="taskboard-policy-cron">Cron</Label><Input id="taskboard-policy-cron" value={cron} onChange={(event) => { dirtyFieldsRef.current.add("integrationPolicy"); setCron(event.target.value); }} disabled={submitting || !canEditPolicy} /></div>
                    <div className="space-y-2"><Label htmlFor="taskboard-policy-timezone">时区</Label><Input id="taskboard-policy-timezone" value={timezone} onChange={(event) => { dirtyFieldsRef.current.add("integrationPolicy"); setTimezone(event.target.value); }} disabled={submitting || !canEditPolicy} /></div>
                  </div>
                ) : triggerMode === "on_ready" ? (
                  <div className="space-y-2"><Label htmlFor="taskboard-policy-debounce">就绪防抖（毫秒）</Label><Input id="taskboard-policy-debounce" type="number" min={0} max={86400000} value={debounceMs} onChange={(event) => { dirtyFieldsRef.current.add("integrationPolicy"); setDebounceMs(event.target.value); }} disabled={submitting || !canEditPolicy} /></div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Checkbox id="taskboard-manual-maintainer" checked={manualMaintainer} onCheckedChange={(checked) => { dirtyFieldsRef.current.add("integrationPolicy"); setManualMaintainer(checked === true); }} disabled={submitting || !canEditPolicy} />
                    <Label htmlFor="taskboard-manual-maintainer" className="font-normal">允许维护者创建人工批次（所有者始终允许）</Label>
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label>合并方式</Label>
                    <Select value={mergeMethod} onValueChange={(value) => { dirtyFieldsRef.current.add("integrationPolicy"); setMergeMethod(value as typeof mergeMethod); }} disabled={submitting || !canEditPolicy}>
                      <SelectTrigger aria-label="集成合并方式"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="merge">Merge</SelectItem><SelectItem value="squash">Squash</SelectItem><SelectItem value="rebase">Rebase</SelectItem></SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2"><Label htmlFor="taskboard-remediation-rounds">自动修复轮数</Label><Input id="taskboard-remediation-rounds" type="number" min={0} max={20} value={maxRemediationRounds} onChange={(event) => { dirtyFieldsRef.current.add("integrationPolicy"); setMaxRemediationRounds(event.target.value); }} disabled={submitting || !canEditPolicy} /></div>
                  <div className="space-y-2"><Label htmlFor="taskboard-transient-retries">瞬时重试次数</Label><Input id="taskboard-transient-retries" type="number" min={0} max={20} value={maxTransientRetries} onChange={(event) => { dirtyFieldsRef.current.add("integrationPolicy"); setMaxTransientRetries(event.target.value); }} disabled={submitting || !canEditPolicy} /></div>
                </div>
                <div className="space-y-3 rounded-md border p-3" aria-label="CI 门禁策略">
                  <div>
                    <p className="text-sm font-medium">CI 门禁策略</p>
                    {repositoryCiPolicyReset ? <p className="text-xs text-amber-700 dark:text-amber-300">Repository ID 已变更；旧仓库 fallback 已清空。保存后可基于新仓库 observed checks 重新确认。</p> : null}
                    {ciPolicySaved && !dirtyFieldsRef.current.has("integrationPolicy") && !dirtyFieldsRef.current.has("repository")
                      ? <p className="text-xs text-emerald-700 dark:text-emerald-400">已保存，并按服务端最终策略回显。</p> : null}
                    {ciDiscoveryLoading && !repositoryCiPolicyReset ? <p className="text-xs text-muted-foreground">正在读取 GitHub 门禁与近期检查…</p> : null}
                    {ciDiscoveryError ? <p className="text-xs text-destructive">{ciDiscoveryError}</p> : null}
                    {visibleCiDiscovery ? (
                      <p className="text-xs text-muted-foreground">
                        当前生效来源：{visibleCiDiscovery.effectiveSource === "github" ? "GitHub required checks" : visibleCiDiscovery.effectiveSource === "board" ? "看板 fallback" : visibleCiDiscovery.effectiveSource === "unconfigured" ? "未配置（fail-closed）" : "Provider 不可判定"}
                        {visibleCiDiscovery.providerPullRequestId ? ` · 最近 PR #${visibleCiDiscovery.providerPullRequestId}` : " · 暂无可发现的 PR 检查"}
                      </p>
                    ) : null}
                  </div>
                  {visibleCiDiscovery ? (
                    <div className="space-y-1 text-xs">
                      <p className="font-medium">GitHub required checks</p>
                      {visibleCiDiscovery.githubRequiredChecks.length
                        ? visibleCiDiscovery.githubRequiredChecks.map((check) => <p key={`${check.name}-${check.appId ?? "any"}`}>{check.name}{check.appId ? ` · App ${check.appId}` : ""}</p>)
                        : <p className="text-muted-foreground">GitHub 未声明 required checks。</p>}
                    </div>
                  ) : null}
                  {visibleCiDiscovery?.observedChecks.length ? (
                    <div className="space-y-2">
                      <p className="text-xs font-medium">近期 PR observed checks（仅供选择，不会自动升级）</p>
                      {visibleCiDiscovery.observedChecks.map((check) => (
                        <label className="flex items-start gap-2 text-xs" key={`${check.name}-${check.appId ?? "any"}`}>
                          <Checkbox
                            aria-label={`选择 observed check ${check.name}`}
                            checked={ciCheckSelected(ciRequiredChecks, check.name, check.appId)}
                            onCheckedChange={(checked) => setObservedCheckSelected(check.name, check.appId, checked === true)}
                            disabled={submitting || !canEditPolicy}
                          />
                          <span>{check.name} · {check.status}{check.appName ? ` · ${check.appName}` : check.appId ? ` · App ${check.appId}` : ""}</span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <Label htmlFor="taskboard-ci-fallback">看板 fallback required contexts</Label>
                    <Textarea
                      id="taskboard-ci-fallback"
                      value={ciRequiredChecks}
                      onChange={(event) => { dirtyFieldsRef.current.add("integrationPolicy"); setCiPolicySaved(false); setCiRequiredChecks(event.target.value); }}
                      placeholder={"也可手工添加；每行：检查名称，或 检查名称 | GitHub App ID"}
                      rows={3}
                      disabled={submitting || !canEditPolicy}
                    />
                    <p className="text-xs text-muted-foreground">仅在 GitHub required checks 明确为空时生效；observed checks 必须由有权限用户显式勾选或填写。</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">固定要求绿色检查；独立来源可继续，冲突自动修复；不自动部署或删除远端分支。</p>
              </>
            ) : <p className="text-xs text-muted-foreground">未关联仓库时不会创建或执行集成批次。</p>}
          </section>
          <div className="space-y-2">
            <Label htmlFor="taskboard-board-prompt">看板提示语</Label>
            <Textarea
              id="taskboard-board-prompt"
              value={prompt}
              onChange={(event) => {
                dirtyFieldsRef.current.add("prompt");
                setPrompt(event.target.value);
              }}
              placeholder="每个任务交给 Agent 执行时都会附带这段提示语"
              rows={8}
              disabled={submitting || !canEditSettings}
            />
            <p className="text-xs text-muted-foreground">
              每次执行此看板中的任务时，都会传递当前提示语。
            </p>
          </div>
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">各阶段执行提示语</h3>
              <p className="text-xs text-muted-foreground">
                分别为实施（work）、复核（review）、集成（merge）阶段配置交给 Agent 的执行提示语；
                未填写的阶段使用系统默认模板。
              </p>
            </div>
            {([
              ["work", "实施（work）", "实施 Agent 处理可交付任务时的执行提示语"],
              ["review", "复核（review）", "复核 Agent 审查工作结果时的执行提示语"],
              ["merge", "集成（merge）", "集成 Agent 合并交付时的执行提示语"],
            ] as const).map(([purpose, title, hint]) => (
              <div className="space-y-2" key={purpose}>
                <Label htmlFor={`taskboard-stage-${purpose}`}>{title}</Label>
                <Textarea
                  id={`taskboard-stage-${purpose}`}
                  value={stagePrompts[purpose] ?? ""}
                  onChange={(event) => {
                    dirtyFieldsRef.current.add("stagePrompts");
                    setStagePrompts((prev) => ({ ...prev, [purpose]: event.target.value }));
                  }}
                  placeholder="留空则使用系统默认模板"
                  rows={6}
                  disabled={submitting || !canEditSettings}
                />
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}
          </section>
          <div className="space-y-2">
            <Label>运行模型</Label>
            <ModelSelect
              modelList={modelList}
              value={model}
              onChange={(next) => {
                dirtyFieldsRef.current.add("model");
                setModel(next);
              }}
              inheritLabel="继承组织默认模型"
              ariaLabel="看板运行模型"
              disabled={submitting || !canEditSettings}
            />
            <p className="text-xs text-muted-foreground">
              看板中任务的默认执行模型；任务也可以单独指定模型。
            </p>
          </div>
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">各阶段默认模型</h3>
              <p className="text-xs text-muted-foreground">
                分别为实施（work）、复核（review）、集成（merge）阶段指定默认模型；未指定的阶段继承看板运行模型。
              </p>
            </div>
            {STAGE_MODEL_FIELDS.map(({ purpose, title, hint }) => (
              <div className="space-y-2" key={purpose}>
                <Label htmlFor={`taskboard-stage-model-${purpose}`}>{title}</Label>
                <ModelSelect
                  modelList={modelList}
                  value={stageModels[purpose] ?? null}
                  onChange={(next) => setStageModel(purpose, next)}
                  inheritLabel="继承看板默认模型"
                  ariaLabel={`${title}默认模型`}
                  disabled={submitting || !canEditSettings}
                />
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}
          </section>
          {board?.visibility === "organization" ? <BoardMembers board={board} canManage={canManageMembers} /> : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="taskboard-board-form" disabled={submitting}>
            {submitting ? "保存中..." : board ? "保存" : "创建看板"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
