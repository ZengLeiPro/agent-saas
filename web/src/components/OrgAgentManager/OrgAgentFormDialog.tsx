import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, UserRound, X } from 'lucide-react';
import { agentAvatarUrl, resolveApiAssetUrl } from '@/lib/apiBase';

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
import { useTenantSkillOptions } from './hooks';
import { emptyFormValues, type OrgAgentFormValues, type OrgAgentRecord } from './types';

/**
 * 企业专家创建/编辑表单（组织管理 modal，仿 UserFormDialog 结构）
 *
 * 字段：名称 / emoji 头像 / 限定提示语 / skill 白名单多选（租户可用清单）/
 * 指派（全员 或 成员多选）/ 门禁（开关+范围描述+拒绝话术+严格度两档）/ 启用。
 */
export function OrgAgentFormDialog({
  open,
  tenantId,
  editing,
  onClose,
  onSubmit,
  onUploadAvatar,
}: {
  open: boolean;
  tenantId?: string;
  /** 编辑目标；null = 创建 */
  editing: OrgAgentRecord | null;
  onClose: () => void;
  onSubmit: (values: OrgAgentFormValues) => Promise<void>;
  /** 上传图片头像（仅编辑态可用；上传即时生效） */
  onUploadAvatar?: (id: string, file: File) => Promise<{ avatar: string; avatarVersion: number }>;
}) {
  const [values, setValues] = useState<OrgAgentFormValues>(emptyFormValues());
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setValues((prev) => ({ ...prev, avatarImageUrl: resolveApiAssetUrl(data.avatar), avatar: '' }));
      setPresetsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };
  const { users } = useUsers();
  const { skills, loading: skillsLoading } = useTenantSkillOptions(tenantId);

  const tenantUsers = useMemo(
    () => (tenantId ? users.filter((user) => user.tenantId === tenantId) : users),
    [tenantId, users],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing) {
      const isImageAvatar = !!editing.avatar?.startsWith('org-agent-avatars/');
      setValues({
        name: editing.name,
        avatar: isImageAvatar ? '' : editing.avatar ?? '',
        avatarImageUrl: isImageAvatar
          ? agentAvatarUrl(`org-agent:${editing.id}`, editing.avatar, editing.avatarVersion)
          : null,
        description: editing.description,
        starterPromptsText: editing.starterPrompts.join('\n'),
        instructions: editing.instructions,
        allowedSkills: [...editing.allowedSkills],
        audienceExposure: editing.audience.exposure === 'allow_users' ? 'allow_users' : 'all',
        audienceUsernames: [...editing.audience.usernames],
        guardrailEnabled: editing.guardrail.enabled,
        guardrailScopeDescription: editing.guardrail.scopeDescription,
        guardrailRejectionMessage: editing.guardrail.rejectionMessage,
        guardrailStrictness: editing.guardrail.strictness,
        enabled: editing.enabled,
      });
    } else {
      setValues(emptyFormValues());
    }
  }, [open, editing]);

  const patch = (recipe: Partial<OrgAgentFormValues>) => setValues((prev) => ({ ...prev, ...recipe }));

  const toggleInList = (list: string[], value: string, checked: boolean): string[] =>
    checked ? Array.from(new Set([...list, value])) : list.filter((item) => item !== value);

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
    if (values.guardrailEnabled && !values.guardrailRejectionMessage.trim()) {
      setError('开启门禁时拒绝话术不能为空');
      return;
    }
    setSaving(true);
    try {
      await onSubmit(values);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[min(760px,calc(100vh-64px))] w-[min(640px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>{editing ? '编辑企业专家' : '创建企业专家'}</DialogTitle>
          <DialogDescription>
            配置成员能看到的专家资料，以及内部提示语、固有技能、指派范围与门禁。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
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
                    onClick={() => patch({ avatarImageUrl: null })}
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
                        .then((data) => patch({ avatarImageUrl: resolveApiAssetUrl(data.avatar), avatar: '' }))
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

          <div className="space-y-1.5">
            <Label>指派范围</Label>
            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={values.audienceExposure === 'all'}
                  onChange={() => patch({ audienceExposure: 'all' })}
                />
                全员可用
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={values.audienceExposure === 'allow_users'}
                  onChange={() => patch({ audienceExposure: 'allow_users' })}
                />
                指定成员
              </label>
            </div>
            {values.audienceExposure === 'allow_users' && (
              tenantUsers.length === 0 ? (
                <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">当前组织暂无成员。</div>
              ) : (
                <div className="grid max-h-40 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
                  {tenantUsers.map((user) => (
                    <label key={user.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={values.audienceUsernames.includes(user.username)}
                        onChange={(e) => patch({ audienceUsernames: toggleInList(values.audienceUsernames, user.username, e.target.checked) })}
                      />
                      <span className="truncate">{user.realName || user.username}
                        <span className="ml-1 text-xs text-muted-foreground">{user.username}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )
            )}
          </div>

          <div className="space-y-3 rounded-xl border p-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium">话题门禁</div>
                <div className="text-xs leading-5 text-muted-foreground">提问先经小模型判断是否在职责范围内；范围外直接返回预设话术，不启动对话。</div>
              </div>
              <Switch checked={values.guardrailEnabled} onCheckedChange={(checked) => patch({ guardrailEnabled: checked })} />
            </div>
            {values.guardrailEnabled && (
              <>
                <div className="space-y-1.5">
                  <Label>话题范围描述</Label>
                  <textarea
                    autoComplete="off"
                    className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={values.guardrailScopeDescription}
                    maxLength={2000}
                    onChange={(e) => patch({ guardrailScopeDescription: e.target.value })}
                    placeholder="描述允许讨论的话题范围（喂给门禁小模型）"
                  />
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
                  <Label>严格度</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={values.guardrailStrictness}
                    onChange={(e) => patch({ guardrailStrictness: e.target.value === 'lenient' ? 'lenient' : 'strict' })}
                  >
                    <option value="strict">严格（拿不准 → 拒绝）</option>
                    <option value="lenient">宽松（拿不准 → 放行并打标）</option>
                  </select>
                </div>
              </>
            )}
          </div>

          <div className="flex items-start justify-between gap-4 rounded-xl border p-3">
            <div>
              <div className="text-sm font-medium">启用</div>
              <div className="text-xs leading-5 text-muted-foreground">停用后员工侧入口消失，已有会话保留可读、不可继续发消息。</div>
            </div>
            <Switch checked={values.enabled} onCheckedChange={(checked) => patch({ enabled: checked })} />
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={() => { void handleSubmit(); }} disabled={saving}>
            {saving ? '保存中...' : editing ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
