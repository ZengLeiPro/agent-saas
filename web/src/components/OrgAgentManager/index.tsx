import { useState } from 'react';
import { Bot, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import { OrgAgentAvatarContent } from '@/components/OrgAgentAvatar';
import { cn } from '@/lib/utils';
import { OrgAgentFormDialog } from './OrgAgentFormDialog';
import { useOrgAgentAdmin } from './hooks';
import type { OrgAgentFormValues, OrgAgentRecord } from './types';

function formValuesToPayload(values: OrgAgentFormValues, editing: OrgAgentRecord | null) {
  // avatar 三态：有图片头像 → 不发字段（路径值仅上传接口写入，PATCH 发路径会被 schema 拒）；
  // emoji → 发值；原图片被移除且无 emoji → 发空串显式清除
  const hadImage = !!editing?.avatar?.startsWith('org-agent-avatars/');
  const emoji = values.avatar.trim();
  const avatarPatch = values.avatarImageUrl
    ? {}
    : emoji
      ? { avatar: emoji }
      : hadImage
        ? { avatar: '' }
        : {};
  return {
    name: values.name.trim(),
    ...avatarPatch,
    description: values.description.trim(),
    starterPrompts: values.starterPromptsText
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6),
    instructions: values.instructions,
    allowedSkills: values.allowedSkills,
    audience: {
      exposure: values.audienceExposure,
      usernames: values.audienceExposure === 'allow_users' ? values.audienceUsernames : [],
    },
    guardrail: {
      enabled: values.guardrailEnabled,
      scopeDescription: values.guardrailScopeDescription,
      rejectionMessage: values.guardrailRejectionMessage.trim(),
      strictness: values.guardrailStrictness,
    },
    enabled: values.enabled,
  };
}

function audienceText(agent: OrgAgentRecord): string {
  if (agent.audience.exposure === 'all') return '全员';
  if (agent.audience.exposure === 'allow_users') return `${agent.audience.usernames.length} 人`;
  return `排除 ${agent.audience.usernames.length} 人`;
}

/**
 * 组织管理 modal「企业专家」section（仿 UserManager 结构）
 *
 * 列表（名称/头像/指派/门禁/启用开关/编辑/删除）+ 创建/编辑表单弹窗。
 * DELETE 为硬删（危险操作二次确认）；日常下线引导用启用开关。
 */
export function OrgAgentManager({ tenantId, tenantName }: { tenantId?: string; tenantName?: string }) {
  const { agents, loading, error, refresh, create, update, remove, uploadAvatar } = useOrgAgentAdmin(tenantId);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OrgAgentRecord | null>(null);
  const [deleting, setDeleting] = useState<OrgAgentRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleSubmit = async (values: OrgAgentFormValues) => {
    const payload = formValuesToPayload(values, editing);
    if (editing) {
      await update(editing.id, payload);
    } else {
      await create(payload);
    }
  };

  const handleToggleEnabled = async (agent: OrgAgentRecord, enabled: boolean) => {
    setActionError(null);
    try {
      await update(agent.id, { enabled });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      await remove(deleting.id);
      setDeleting(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="企业专家"
        description={`为 ${tenantName || tenantId || '当前组织'} 定义专岗专家：公开说明 + 固有技能 + 指派成员，可选话题门禁。`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => { void refresh(); }} disabled={loading}>
              <RefreshCw className={cn('mr-2 size-4', loading && 'animate-spin')} />刷新
            </Button>
            <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus className="size-4" />创建企业专家
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        {actionError && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div>}

        <Card>
          <CardContent className="p-0">
            {loading && agents.length === 0 ? (
              <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />加载企业专家...
              </div>
            ) : agents.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
                <Bot className="size-6" />
                <span>还没有企业专家，点击右上角创建。</span>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>指派</TableHead>
                    <TableHead>技能</TableHead>
                    <TableHead>门禁</TableHead>
                    <TableHead>启用</TableHead>
                    <TableHead className="w-24 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => (
                    <TableRow key={agent.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-base">
                            <OrgAgentAvatarContent agent={agent} />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{agent.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{agent.id}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{audienceText(agent)}</TableCell>
                      <TableCell className="text-sm">{agent.allowedSkills.length} 个</TableCell>
                      <TableCell>
                        {agent.guardrail.enabled ? (
                          <Badge className="border-0 bg-success/15 text-success">
                            {agent.guardrail.strictness === 'strict' ? '严格' : '宽松'}
                          </Badge>
                        ) : (
                          <Badge className="border-0 bg-muted text-muted-foreground">关闭</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={agent.enabled}
                          onCheckedChange={(checked) => { void handleToggleEnabled(agent, checked); }}
                          aria-label={`启用 ${agent.name}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            title="编辑"
                            onClick={() => { setEditing(agent); setFormOpen(true); }}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-destructive hover:text-destructive"
                            title="删除"
                            onClick={() => setDeleting(agent)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <OrgAgentFormDialog
        open={formOpen}
        tenantId={tenantId}
        editing={editing}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        onSubmit={handleSubmit}
        onUploadAvatar={uploadAvatar}
      />

      <Dialog open={!!deleting} onOpenChange={(next) => { if (!next) setDeleting(null); }}>
        <DialogContent className="w-[min(420px,calc(100vw-48px))]">
          <DialogHeader>
            <DialogTitle>删除企业专家</DialogTitle>
            <DialogDescription>
              将永久删除「{deleting?.name}」的配置（已有会话记录保留）。若只是暂时下线，建议改用启用开关。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteBusy}>取消</Button>
            <Button variant="destructive" onClick={() => { void handleDelete(); }} disabled={deleteBusy}>
              {deleteBusy ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
