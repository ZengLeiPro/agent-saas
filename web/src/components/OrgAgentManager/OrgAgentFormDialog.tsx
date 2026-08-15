import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, PlayCircle, Plus, UserRound, X } from 'lucide-react';
import { agentAvatarUrl, resolveApiAssetUrl } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';

/** 开开 8 岗位预设头像（web/public/kaikai-presets/，与场景库 8 岗位对齐） */
const AVATAR_PRESETS = [
  { key: 'boss', label: '老板/管理者' },
  { key: 'sales', label: '销售' },
  { key: 'marketing', label: '市场/运营' },
  { key: 'procurement', label: '采购' },
  { key: 'finance', label: '财务' },
  { key: 'hr', label: '人事行政' },
  { key: 'cs', label: '跟单/客服' },
  { key: 'production', label: '项目/生产/交付' },
] as const;
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useUsers } from '@/components/UserManager/hooks';
import { useTenantKnowledgeOptions, useTenantSkillOptions, type OrgAgentConfiguration } from './hooks';
import { OrgAgentAudienceSection } from './OrgAgentAudienceSection';
import { OrgAgentDwsSection } from './OrgAgentDwsSection';
import { OrgAgentRuntimeSection } from './OrgAgentRuntimeSection';
import {
  assembleScopeDescription,
  defaultOrgAgentRuntimePolicy,
  emptyFormValues,
  parseGateSlots,
  type OrgAgentAdminRecord,
  type OrgAgentFormValues,
  type OrgAgentGuardrailMode,
} from './types';

/** 门禁三档语义说明（radio label 旁的副标题） */
const GATE_MODE_META: Array<{ value: OrgAgentGuardrailMode; label: string; hint: string }> = [
  { value: 'off', label: '关闭', hint: '不跑门禁；所有问题都进入主对话。' },
  { value: 'shadow', label: '影子模式', hint: '跑门禁并落库审计，但判定不生效——用于上线前 3-7 天调 scope。' },
  { value: 'enforce', label: '生效', hint: '门禁生效，超范围问题直接返回拒绝话术，不进入主对话。' },
];

interface GateTestResult {
  verdict?: 'in_scope' | 'off_topic' | 'uncertain';
  wouldReject?: boolean;
  latencyMs?: number;
  reason?: string;
  source?: string;
  model?: string;
  error?: string;
}

/**
 * 企业专家创建/编辑表单
 *
 * 门禁段：填空题式（允许问 / 拒绝问 chips + 三档 mode radio + strictness radio + 试测按钮）
 * 保存时把三段填空拼装成 scopeDescription 供后端消费；加载时解析回填。
 */
export function OrgAgentFormDialog({
  open,
  tenantId,
  editing,
  configuration,
  configurationLoading = false,
  initialValues,
  onClose,
  onSubmit,
  onUploadAvatar,
}: {
  open: boolean;
  tenantId?: string;
  /** 编辑目标；null = 创建 */
  editing: OrgAgentAdminRecord | null;
  /** 治理真源配置；编辑时必须加载后再允许保存。 */
  configuration?: OrgAgentConfiguration | null;
  configurationLoading?: boolean;
  /** 从模板创建时传入的预填值；优先级低于 editing */
  initialValues?: OrgAgentFormValues | null;
  onClose: () => void;
  onSubmit: (values: OrgAgentFormValues) => Promise<void>;
  /** 上传图片头像（专用媒体接口，上传即时生效） */
  onUploadAvatar?: (id: string, file: File) => Promise<{ avatar: string; avatarPath?: string; avatarVersion: number }>;
}) {
  const [values, setValues] = useState<OrgAgentFormValues>(emptyFormValues());
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newAllowExample, setNewAllowExample] = useState('');
  const [newRejectExample, setNewRejectExample] = useState('');
  const [gateTestOpen, setGateTestOpen] = useState(false);
  const [gateTestMessage, setGateTestMessage] = useState('');
  const [gateTestRunning, setGateTestRunning] = useState(false);
  const [gateTestResult, setGateTestResult] = useState<GateTestResult | null>(null);
  const [directoryGroups, setDirectoryGroups] = useState<Array<{ groupId: string; displayName: string }>>([]);
  const [directoryGroupsError, setDirectoryGroupsError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formInitializationKeyRef = useRef('');
  const submitGenerationRef = useRef(0);

  /** 选预设 = 拉取静态图转 File 走上传链路（复用图片头像存储，零额外后端逻辑） */
  const applyPreset = async (key: string) => {
    if (!editing || !onUploadAvatar) return;
    setUploading(true);
    setError(null);
    try {
      const res = await fetch(`/kaikai-presets/${key}.jpg`);
      if (!res.ok) throw new Error('预设图片加载失败');
      const blob = await res.blob();
      const file = new File([blob], `${key}.jpg`, { type: 'image/jpeg' });
      const data = await onUploadAvatar(editing.id, file);
      setValues((prev) => ({
        ...prev,
        avatarImageUrl: resolveApiAssetUrl(data.avatar),
        avatar: '',
        avatarStoredPath: data.avatarPath ?? prev.avatarStoredPath,
      }));
      setPresetsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };
  const { users } = useUsers();
  const { skills, loading: skillsLoading } = useTenantSkillOptions(tenantId);
  const { knowledge, loading: knowledgeLoading } = useTenantKnowledgeOptions(tenantId);

  const tenantUsers = useMemo(
    () => (tenantId ? users.filter((user) => user.tenantId === tenantId) : users),
    [tenantId, users],
  );

  useEffect(() => {
    submitGenerationRef.current += 1;
    setSaving(false);
  }, [open, tenantId, editing?.id, initialValues]);

  useEffect(() => {
    if (!open || !tenantId) {
      setDirectoryGroups([]);
      setDirectoryGroupsError('');
      return;
    }
    let cancelled = false;
    setDirectoryGroupsError('');
    void authFetch(`/api/governance/access/directory-groups?tenantId=${encodeURIComponent(tenantId)}`)
      .then(async response => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error || '读取目录组失败');
        }
        return response.json() as Promise<{ groups?: Array<{ groupId: string; displayName: string; status?: string }> }>;
      })
      .then(data => {
        if (cancelled) return;
        setDirectoryGroups((data.groups ?? []).filter(group => group.status !== 'disabled'));
      })
      .catch(error => {
        if (!cancelled) setDirectoryGroupsError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [open, tenantId]);

  useEffect(() => {
    if (!open) {
      formInitializationKeyRef.current = '';
      return;
    }
    if (editing && configurationLoading) return;
    const initializationKey = editing
      ? `${tenantId ?? ''}:${editing.id}:${configuration?.resource.revision ?? 'legacy'}`
      : initialValues ? `${tenantId ?? ''}:template:${initialValues.name}` : `${tenantId ?? ''}:blank`;
    if (formInitializationKeyRef.current === initializationKey) return;
    formInitializationKeyRef.current = initializationKey;
    setError(null);
    setNewAllowExample('');
    setNewRejectExample('');
    setGateTestOpen(false);
    setGateTestResult(null);
    setGateTestMessage('');
    if (editing) {
      const definition = configuration?.version?.definition;
      const avatarStoredPath = definition?.avatar ?? editing.avatar ?? '';
      const isImageAvatar = avatarStoredPath.startsWith('org-agent-avatars/');
      const guardrail = definition?.guardrail ?? editing.guardrail;
      // 解析 scopeDescription 里的结构化标记（若无标记则视为遗留 raw prompt 兜底）
      const parsed = parseGateSlots(guardrail.scopeDescription || '');
      const derivedMode: OrgAgentGuardrailMode = parsed.slots?.mode
        ?? guardrail.mode
        ?? (guardrail.enabled ? 'enforce' : 'off');
      const assignments = configuration?.assignment.assignments ?? [];
      const hasEveryone = assignments.some(item => item.assigneeType === 'everyone' && item.effect === 'allow');
      const governedExposure = hasEveryone
        ? assignments.some(item => item.assigneeType !== 'everyone' && item.effect === 'deny')
          ? 'deny_users'
          : 'all'
        : 'allow_users';
      const audienceExposure = assignments.length > 0 ? governedExposure : editing.audience.exposure;
      const selectedEffect = audienceExposure === 'deny_users' ? 'deny' : 'allow';
      const assignedUserIds = assignments
        .filter(item => item.assigneeType === 'user' && item.effect === selectedEffect && item.assigneeId)
        .map(item => item.assigneeId!);
      const fallbackUserIds = tenantUsers
        .filter(user => editing.audience.usernames.includes(user.username))
        .map(user => user.id);
      const assignedGroupIds = assignments
        .filter(item => item.assigneeType === 'directory_group' && item.effect === selectedEffect && item.assigneeId)
        .map(item => item.assigneeId!);
      setValues({
        name: definition?.name ?? editing.name,
        avatar: isImageAvatar ? '' : avatarStoredPath,
        avatarImageUrl: isImageAvatar
          ? agentAvatarUrl(`org-agent:${editing.id}`, avatarStoredPath, editing.avatarVersion)
          : null,
        avatarStoredPath,
        description: definition?.description ?? editing.description,
        starterPromptsText: (definition?.starterPrompts ?? editing.starterPrompts).join('\n'),
        instructions: definition?.instructions ?? editing.instructions,
        allowedSkills: definition?.skills.map(skill => skill.id) ?? [...editing.allowedSkills],
        allowedKnowledgeText: (definition?.knowledge ?? editing.allowedKnowledge ?? []).join('\n'),
        audienceExposure,
        audienceUserIds: assignedUserIds.length > 0 ? assignedUserIds : fallbackUserIds,
        audienceGroupIds: assignedGroupIds.length > 0
          ? assignedGroupIds
          : [...(editing.audience.departmentIds ?? [])],
        runtime: structuredClone(definition?.runtime ?? editing.runtime ?? defaultOrgAgentRuntimePolicy()),
        guardrailMode: derivedMode,
        guardrailAllowExamples: parsed.slots?.allowExamples ?? [],
        guardrailRejectExamples: parsed.slots?.rejectExamples ?? [],
        guardrailScopeDescription: parsed.rawScope,
        guardrailRejectionMessage: guardrail.rejectionMessage,
        guardrailStrictness: guardrail.strictness,
        enabled: configuration ? configuration.resource.status === 'enabled' : editing.enabled,
      });
    } else if (initialValues) {
      setValues(structuredClone(initialValues));
    } else {
      setValues(emptyFormValues());
    }
  }, [open, tenantId, editing, configuration, configurationLoading, initialValues, tenantUsers]);

  const patch = (recipe: Partial<OrgAgentFormValues>) => setValues((prev) => ({ ...prev, ...recipe }));

  const toggleInList = (list: string[], value: string, checked: boolean): string[] =>
    checked ? Array.from(new Set([...list, value])) : list.filter((item) => item !== value);

  const addAllowExample = () => {
    const trimmed = newAllowExample.trim();
    if (!trimmed) return;
    if (values.guardrailAllowExamples.includes(trimmed)) {
      setNewAllowExample('');
      return;
    }
    if (values.guardrailAllowExamples.length >= 10) {
      setError('允许问示例最多 10 条');
      return;
    }
    patch({ guardrailAllowExamples: [...values.guardrailAllowExamples, trimmed] });
    setNewAllowExample('');
  };

  const removeAllowExample = (item: string) => {
    patch({ guardrailAllowExamples: values.guardrailAllowExamples.filter((e) => e !== item) });
  };

  const addRejectExample = () => {
    const trimmed = newRejectExample.trim();
    if (!trimmed) return;
    if (values.guardrailRejectExamples.includes(trimmed)) {
      setNewRejectExample('');
      return;
    }
    if (values.guardrailRejectExamples.length >= 10) {
      setError('拒绝问示例最多 10 条');
      return;
    }
    patch({ guardrailRejectExamples: [...values.guardrailRejectExamples, trimmed] });
    setNewRejectExample('');
  };

  const removeRejectExample = (item: string) => {
    patch({ guardrailRejectExamples: values.guardrailRejectExamples.filter((e) => e !== item) });
  };

  const buildAssembledScope = (): string =>
    assembleScopeDescription({
      mode: values.guardrailMode,
      description: values.description,
      allowExamples: values.guardrailAllowExamples,
      rejectExamples: values.guardrailRejectExamples,
      strictness: values.guardrailStrictness,
      rawScope: values.guardrailScopeDescription,
    });

  const runGateTest = async () => {
    const message = gateTestMessage.trim();
    if (!message) {
      setGateTestResult({ error: '请输入测试问题' });
      return;
    }
    setGateTestRunning(true);
    setGateTestResult(null);
    try {
      // 编辑模式走 /:id/gate-preview（B2 已实现）；新建模式无 id，用 dry-run 端点。
      // 端点未上线时 fallback：本地判断 keyword 命中给 verdict，标记 source=local。
      const path = editing
        ? `/api/org-agents/${encodeURIComponent(editing.id)}/gate-preview`
        : '/api/org-agents/gate-preview';
      const res = await authFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testMessage: message,
          overrideScopeDescription: buildAssembledScope(),
          overrideStrictness: values.guardrailStrictness,
        }),
      });
      if (!res.ok) {
        // 后端还没接线时给出本地占位提示（不是硬失败）
        if (res.status === 404) {
          setGateTestResult({
            error: '后端 gate-preview 端点尚未部署（B2 计划内），本地无法预判。',
          });
        } else {
          const data = await res.json().catch(() => ({}));
          setGateTestResult({ error: (data as { error?: string }).error || `请求失败：${res.status}` });
        }
        return;
      }
      const data = (await res.json()) as GateTestResult;
      setGateTestResult(data);
    } catch (err) {
      setGateTestResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setGateTestRunning(false);
    }
  };

  const handleSubmit = async () => {
    if (!values.name.trim()) {
      setError('名称不能为空');
      return;
    }
    const starterPrompts = values.starterPromptsText.split('\n').map((item) => item.trim()).filter(Boolean);
    if (starterPrompts.length > 6) {
      setError('示例问题最多 6 条');
      return;
    }
    const overlongPromptIndex = starterPrompts.findIndex((item) => item.length > 200);
    if (overlongPromptIndex >= 0) {
      setError(`第 ${overlongPromptIndex + 1} 条示例问题不能超过 200 个字符`);
      return;
    }
    if (new Set(starterPrompts).size !== starterPrompts.length) {
      setError('示例问题不能重复');
      return;
    }
    if (values.guardrailMode !== 'off' && !values.guardrailRejectionMessage.trim()) {
      setError('开启门禁时拒绝话术不能为空');
      return;
    }
    if (assembleScopeDescription({
      mode: values.guardrailMode,
      description: values.guardrailScopeDescription,
      allowExamples: values.guardrailAllowExamples,
      rejectExamples: values.guardrailRejectExamples,
      strictness: values.guardrailStrictness,
    }).length > 2000) {
      setError('职责边界与允许/拒绝示例合计不能超过 2000 个字符');
      return;
    }
    const knowledgeIds = values.allowedKnowledgeText.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
    if (new Set(knowledgeIds).size > 20 || knowledgeIds.some(item => item.length > 200)) {
      setError('知识资源最多 20 个，单个 ID 不能超过 200 个字符');
      return;
    }
    if (values.audienceExposure !== 'all'
      && values.audienceUserIds.length === 0
      && values.audienceGroupIds.length === 0) {
      setError('指定访问范围时，至少选择一个成员或部门');
      return;
    }
    if (values.runtime.execution.allowedTargets?.length === 0) {
      setError('限制执行环境时，至少选择一个执行目标');
      return;
    }
    const submitGeneration = ++submitGenerationRef.current;
    setSaving(true);
    try {
      await onSubmit(values);
      if (submitGeneration === submitGenerationRef.current) onClose();
    } catch (err) {
      if (submitGeneration === submitGenerationRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (submitGeneration === submitGenerationRef.current) setSaving(false);
    }
  };

  const selectedKnowledgeIds = values.allowedKnowledgeText
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);
  const knownKnowledgeIds = new Set(knowledge.map(item => item.id));
  const unavailableKnowledgeIds = selectedKnowledgeIds.filter(id => !knownKnowledgeIds.has(id));

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[min(860px,calc(100vh-40px))] w-[min(960px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>{editing ? `配置「${editing.name}」` : '创建企业专家'}</DialogTitle>
          <DialogDescription>
            在一个详情页配置身份、职责、能力、运行策略、访问范围、钉钉账号与话题门禁。
          </DialogDescription>
        </DialogHeader>

        <div
          className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4 ${configurationLoading ? 'pointer-events-none opacity-60' : ''}`}
          aria-busy={configurationLoading}
        >
          {configurationLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />加载治理配置...
            </div>
          ) : null}
          {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

          <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input
                value={values.name}
                maxLength={30}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="如：产品选型助手"
              />
            </div>
            <div className="space-y-1.5">
              <Label>头像</Label>
              {values.avatarImageUrl ? (
                <div className="flex items-center gap-1.5">
                  <img src={values.avatarImageUrl} alt="" className="size-9 shrink-0 rounded-full object-cover" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    title="移除图片头像（保存后生效）"
                    onClick={() => patch({ avatarImageUrl: null, avatarStoredPath: '' })}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ) : (
                <Input
                  value={values.avatar}
                  maxLength={16}
                  onChange={(e) => patch({ avatar: e.target.value })}
                  placeholder="emoji，留空用开开"
                />
              )}
              {editing && onUploadAvatar && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      setUploading(true);
                      setError(null);
                      onUploadAvatar(editing.id, file)
                        .then((data) => patch({
                          avatarImageUrl: resolveApiAssetUrl(data.avatar),
                          avatar: '',
                          avatarStoredPath: data.avatarPath ?? values.avatarStoredPath,
                        }))
                        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                        .finally(() => setUploading(false));
                    }}
                  />
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline disabled:opacity-50"
                      disabled={uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploading ? <Loader2 className="size-3 animate-spin" /> : <ImagePlus className="size-3" />}
                      {uploading ? '上传中...' : '上传图片'}
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline disabled:opacity-50"
                      disabled={uploading}
                      onClick={() => setPresetsOpen((prev) => !prev)}
                    >
                      <UserRound className="size-3" />岗位预设
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {editing && onUploadAvatar && presetsOpen && (
            <div className="grid grid-cols-4 gap-2 rounded-md border p-3 sm:grid-cols-8">
              {AVATAR_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className="group flex flex-col items-center gap-1 disabled:opacity-50"
                  disabled={uploading}
                  title={preset.label}
                  onClick={() => { void applyPreset(preset.key); }}
                >
                  <img
                    src={`/kaikai-presets/${preset.key}.jpg`}
                    alt={preset.label}
                    className="size-10 rounded-full object-cover ring-1 ring-border transition group-hover:ring-2 group-hover:ring-brand-400"
                  />
                  <span className="w-full truncate text-center text-[10px] text-muted-foreground">{preset.label}</span>
                </button>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>公开说明</Label>
            <textarea
              autoComplete="off"
              className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={values.description}
              maxLength={500}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="用一两句话告诉成员：这位专家能解决什么问题"
            />
          </div>

          <div className="space-y-1.5">
            <Label>示例问题</Label>
            <p className="text-xs text-muted-foreground">每行一条，最多 6 条；成员点击后只会预填输入框。</p>
            <textarea
              autoComplete="off"
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={values.starterPromptsText}
              onChange={(e) => patch({ starterPromptsText: e.target.value })}
              placeholder={'帮我推荐适合的产品型号\n对比这两个型号的参数'}
            />
          </div>

          <div className="space-y-1.5">
            <Label>内部提示语</Label>
            <textarea
              autoComplete="off"
              className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={values.instructions}
              maxLength={8000}
              onChange={(e) => patch({ instructions: e.target.value })}
              placeholder="定义这个 Agent 的岗位职责、回答风格与知识来源要求"
            />
          </div>

          <div className="space-y-1.5">
            <Label>固有技能</Label>
            <p className="text-xs text-muted-foreground">勾选后成为这位企业专家的固有能力；成员无需在个人设置中再次启用。</p>
            {skillsLoading ? (
              <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />加载组织技能清单...
              </div>
            ) : skills.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">当前组织暂无可用技能。</div>
            ) : (
              <div className="grid max-h-40 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
                {skills.map((skill) => (
                  <label key={skill.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={values.allowedSkills.includes(skill.id)}
                      onChange={(e) => patch({ allowedSkills: toggleInList(values.allowedSkills, skill.id, e.target.checked) })}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{skill.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{skill.id}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5 rounded-xl border p-4">
            <Label>知识资源</Label>
            <p className="text-xs text-muted-foreground">
              选择组织自有知识技能，保存后固化到 Agent 版本并注入运行时。
            </p>
            {knowledgeLoading ? (
              <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />加载组织知识资源...
              </div>
            ) : knowledge.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">当前组织暂无可用知识资源。</div>
            ) : (
              <div className="grid max-h-40 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
                {knowledge.map(item => (
                  <label key={item.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selectedKnowledgeIds.includes(item.id)}
                      onChange={event => patch({
                        allowedKnowledgeText: toggleInList(selectedKnowledgeIds, item.id, event.target.checked).join('\n'),
                      })}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.id}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {unavailableKnowledgeIds.length > 0 && (
              <p className="text-xs text-amber-700">
                {unavailableKnowledgeIds.length} 个既有知识绑定当前不可用；本次保存会原样保留。
              </p>
            )}
          </div>

          <OrgAgentRuntimeSection
            value={values.runtime}
            onChange={runtime => patch({ runtime })}
          />

          <OrgAgentAudienceSection
            values={values}
            tenantUsers={tenantUsers}
            directoryGroups={directoryGroups}
            directoryGroupsError={directoryGroupsError}
            onChange={patch}
          />

          {/* ---------------- 门禁配置：填空题式（allow/reject chips + mode + strictness + 试测） ---------------- */}
          <div className="space-y-3 rounded-xl border p-3">
            <div className="space-y-1">
              <div className="text-sm font-medium">话题门禁</div>
              <div className="text-xs leading-5 text-muted-foreground">
                不用写 prompt，只需告诉门禁"允许问什么 / 拒绝问什么"——保存时前端自动拼装成结构化 prompt 交给后端。
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>门禁模式</Label>
              <div role="radiogroup" aria-label="门禁模式" className="space-y-1">
                {GATE_MODE_META.map((mode) => (
                  <label
                    key={mode.value}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40"
                  >
                    <input
                      type="radio"
                      className="mt-1"
                      name="guardrail-mode"
                      value={mode.value}
                      checked={values.guardrailMode === mode.value}
                      onChange={() => patch({ guardrailMode: mode.value })}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{mode.label}</span>
                      <span className="block text-xs text-muted-foreground">{mode.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {values.guardrailMode !== 'off' && (
              <>
                <div className="space-y-1.5">
                  <Label>允许问的问题类型</Label>
                  <p className="text-xs text-muted-foreground">举 3-5 个例子，越具体越好。回车或点"添加"入列表。</p>
                  {values.guardrailAllowExamples.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {values.guardrailAllowExamples.map((item) => (
                        <Badge
                          key={item}
                          className="max-w-full items-center gap-1 border-0 bg-success/15 text-success"
                        >
                          <span className="truncate">{item}</span>
                          <button
                            type="button"
                            aria-label={`删除允许项 ${item}`}
                            className="inline-flex size-4 items-center justify-center rounded-full hover:bg-success/25"
                            onClick={() => removeAllowExample(item)}
                          >
                            <X className="size-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={newAllowExample}
                      onChange={(e) => setNewAllowExample(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addAllowExample();
                        }
                      }}
                      placeholder="如：帮我审这份报价单"
                      maxLength={200}
                      aria-label="新增允许问示例"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addAllowExample}>
                      <Plus className="mr-1 size-3" />添加
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>拒绝问的问题类型</Label>
                  <p className="text-xs text-muted-foreground">举 3-5 个例子，帮助门禁识别越界问题。</p>
                  {values.guardrailRejectExamples.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {values.guardrailRejectExamples.map((item) => (
                        <Badge
                          key={item}
                          className="max-w-full items-center gap-1 border-0 bg-destructive/15 text-destructive"
                        >
                          <span className="truncate">{item}</span>
                          <button
                            type="button"
                            aria-label={`删除拒绝项 ${item}`}
                            className="inline-flex size-4 items-center justify-center rounded-full hover:bg-destructive/25"
                            onClick={() => removeRejectExample(item)}
                          >
                            <X className="size-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={newRejectExample}
                      onChange={(e) => setNewRejectExample(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addRejectExample();
                        }
                      }}
                      placeholder="如：帮我写周报"
                      maxLength={200}
                      aria-label="新增拒绝问示例"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addRejectExample}>
                      <Plus className="mr-1 size-3" />添加
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>拿不准时倾向</Label>
                  <div role="radiogroup" aria-label="拿不准时倾向" className="space-y-1">
                    <label className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                      <input
                        type="radio"
                        className="mt-1"
                        name="guardrail-strictness"
                        value="strict"
                        checked={values.guardrailStrictness === 'strict'}
                        onChange={() => patch({ guardrailStrictness: 'strict' })}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">严格（拿不准 → 拒绝）</span>
                        <span className="block text-xs text-muted-foreground">推荐用于报价、合同、法务等严肃业务。</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                      <input
                        type="radio"
                        className="mt-1"
                        name="guardrail-strictness"
                        value="lenient"
                        checked={values.guardrailStrictness === 'lenient'}
                        onChange={() => patch({ guardrailStrictness: 'lenient' })}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">宽松（拿不准 → 放行并打标）</span>
                        <span className="block text-xs text-muted-foreground">推荐用于查询、情报类边界模糊场景。</span>
                      </span>
                    </label>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>拒绝话术</Label>
                  <Input
                    value={values.guardrailRejectionMessage}
                    maxLength={500}
                    onChange={(e) => patch({ guardrailRejectionMessage: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>补充说明（可选）</Label>
                  <textarea
                    autoComplete="off"
                    className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={values.guardrailScopeDescription}
                    maxLength={2000}
                    onChange={(e) => patch({ guardrailScopeDescription: e.target.value })}
                    placeholder="想额外交代门禁的话（不必填）；填空题已覆盖大部分场景。"
                  />
                </div>

                <div className="flex items-center justify-between rounded-md border border-dashed bg-muted/30 px-3 py-2">
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-xs font-medium">试测门禁</div>
                    <div className="text-xs text-muted-foreground">
                      输入 1 条测试问题，立即看门禁怎么判（判定 / 置信度 / 延迟）。
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setGateTestOpen((prev) => !prev);
                      setGateTestResult(null);
                    }}
                  >
                    <PlayCircle className="mr-1 size-3.5" />
                    {gateTestOpen ? '收起' : '试测门禁'}
                  </Button>
                </div>

                {gateTestOpen && (
                  <div className="space-y-2 rounded-md border bg-background p-3">
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={gateTestMessage}
                        onChange={(e) => setGateTestMessage(e.target.value)}
                        placeholder="如：帮我审这份报价单"
                        maxLength={2000}
                        aria-label="试测问题"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void runGateTest();
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => { void runGateTest(); }}
                        disabled={gateTestRunning || !gateTestMessage.trim()}
                      >
                        {gateTestRunning ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                        {gateTestRunning ? '试测中...' : '试测'}
                      </Button>
                    </div>
                    {gateTestResult && (
                      <GateTestResultView result={gateTestResult} />
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {editing && tenantId ? (
            <OrgAgentDwsSection tenantId={tenantId} agentId={editing.id} agentName={values.name || editing.name} />
          ) : (
            <div className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
              创建并保存企业专家后，可在同一详情页绑定钉钉成员账号。
            </div>
          )}

          <div className="flex items-start justify-between gap-4 rounded-xl border p-3">
            <div>
              <div className="text-sm font-medium">启用</div>
              <div className="text-xs leading-5 text-muted-foreground">停用后员工侧入口消失，已有会话保留可读、不可继续发消息。</div>
            </div>
            <Switch checked={values.enabled} onCheckedChange={(checked) => patch({ enabled: checked })} />
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>取消</Button>
          <Button type="button" onClick={() => { void handleSubmit(); }} disabled={saving || configurationLoading}>
            {saving ? '保存中...' : editing ? '保存全部配置' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GateTestResultView({ result }: { result: GateTestResult }) {
  if (result.error) {
    return <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{result.error}</div>;
  }
  const verdict = result.verdict;
  const label =
    verdict === 'in_scope' ? '通过（in_scope）'
    : verdict === 'off_topic' ? '拒答（off_topic）'
    : verdict === 'uncertain' ? '边界（uncertain）'
    : '未知';
  const color =
    verdict === 'in_scope' ? 'text-success'
    : verdict === 'off_topic' ? 'text-destructive'
    : 'text-amber-600';
  return (
    <div className="space-y-1 text-xs">
      <div className={`font-medium ${color}`}>{label}</div>
      {typeof result.wouldReject === 'boolean' && (
        <div className="text-muted-foreground">
          实际动作：{result.wouldReject ? '返回拒绝话术' : '进入主对话'}
        </div>
      )}
      {typeof result.latencyMs === 'number' && (
        <div className="text-muted-foreground">延迟：{result.latencyMs} ms</div>
      )}
      {result.model && <div className="text-muted-foreground">模型：{result.model}</div>}
      {result.reason && (
        <div className="rounded bg-muted/40 px-2 py-1 text-muted-foreground">{result.reason}</div>
      )}
    </div>
  );
}
