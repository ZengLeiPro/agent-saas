import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Pencil, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import { OrgAgentAvatarContent } from '@/components/OrgAgentAvatar';
import { cn } from '@/lib/utils';
import { OrgAgentFormDialog } from './OrgAgentFormDialog';
import {
  useOrgAgentAdmin,
  type GovernanceAssignmentDraft,
  type ManagedOrgAgentDefinition,
  type OrgAgentConfiguration,
} from './hooks';
import {
  assembleScopeDescription,
  type OrgAgentFormValues,
  type OrgAgentRecord,
} from './types';
import { fetchOrgAgentTemplates, FALLBACK_TEMPLATES, type OrgAgentTemplate } from './templates';
import { useAuth } from '@/contexts/AuthContext';

function formValuesToGovernance(values: OrgAgentFormValues): {
  definition: ManagedOrgAgentDefinition;
  enabled: boolean;
  assignments: GovernanceAssignmentDraft[];
} {
  const guardrailEnabled = values.guardrailMode !== 'off';
  const assembledScope = guardrailEnabled
    ? assembleScopeDescription({
        mode: values.guardrailMode,
        description: values.description,
        allowExamples: values.guardrailAllowExamples,
        rejectExamples: values.guardrailRejectExamples,
        strictness: values.guardrailStrictness,
        rawScope: values.guardrailScopeDescription,
      })
    : '';
  const avatar = values.avatarImageUrl ? undefined : values.avatar.trim();
  const definition: ManagedOrgAgentDefinition = {
    schemaVersion: 1,
    name: values.name.trim(),
    ...(avatar !== undefined ? { avatar } : {}),
    description: values.description.trim(),
    starterPrompts: values.starterPromptsText
      .split('\n')
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 6),
    instructions: values.instructions,
    skills: values.allowedSkills.map(id => ({ id })),
    knowledge: [...new Set(values.allowedKnowledgeText.split(/[\n,]/).map(item => item.trim()).filter(Boolean))],
    runtime: values.runtime,
    guardrail: {
      mode: values.guardrailMode,
      enabled: guardrailEnabled,
      scopeDescription: assembledScope,
      rejectionMessage: values.guardrailRejectionMessage.trim(),
      strictness: values.guardrailStrictness,
    },
    source: 'governance',
  };
  const assignments: GovernanceAssignmentDraft[] = values.audienceExposure === 'all'
    ? [{ assigneeType: 'everyone', effect: 'allow', origin: 'direct' }]
    : [
        ...values.audienceUserIds.map(assigneeId => ({
          assigneeType: 'user' as const,
          assigneeId,
          effect: 'allow' as const,
          origin: 'direct' as const,
        })),
        ...values.audienceGroupIds.map(assigneeId => ({
          assigneeType: 'directory_group' as const,
          assigneeId,
          effect: 'allow' as const,
          origin: 'direct' as const,
        })),
      ];
  return { definition, enabled: values.enabled, assignments };
}

function audienceText(agent: OrgAgentRecord): string {
  if (agent.audience.exposure === 'all') return '全员';
  if (agent.audience.exposure === 'allow_users') return `${agent.audience.usernames.length} 人`;
  return `排除 ${agent.audience.usernames.length} 人`;
}

/**
 * 组织管理 modal「企业专家」section
 *
 * 顶部：3 张种子模板卡（报价审核 / 客户情报 / 合同风险），可折叠。
 * 主体：列表 + 单页统一详情；所有保存走治理 Version / Assignment，legacy 仅作运行投影。
 */
export function OrgAgentManager({ tenantId, tenantName }: { tenantId?: string; tenantName?: string }) {
  const { isPlatformAdmin } = useAuth();
  // 治理资源明确区分 platform_admin 与 org_admin；平台管理员只能查看，不能代客户组织写配置。
  const canEdit = !isPlatformAdmin;
  const {
    agents,
    loading,
    error,
    refresh,
    loadConfiguration,
    saveConfiguration,
    updateStatus,
    uploadAvatar,
  } = useOrgAgentAdmin(tenantId);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OrgAgentRecord | null>(null);
  const [configuration, setConfiguration] = useState<OrgAgentConfiguration | null>(null);
  const [configurationLoading, setConfigurationLoading] = useState(false);
  const detailRequestRef = useRef(0);
  const [initialValues, setInitialValues] = useState<OrgAgentFormValues | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<OrgAgentTemplate[]>(FALLBACK_TEMPLATES);
  const [templatesCollapsed, setTemplatesCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchOrgAgentTemplates().then((list) => {
      if (!cancelled) setTemplates(list);
    });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (values: OrgAgentFormValues) => {
    if (editing && !configuration) throw new Error('企业专家治理配置尚未加载完成');
    await saveConfiguration({
      configuration: editing ? configuration : null,
      ...formValuesToGovernance(values),
    });
  };

  const handleToggleEnabled = async (agent: OrgAgentRecord, enabled: boolean) => {
    setActionError(null);
    try {
      await updateStatus(agent.id, enabled);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const closeForm = () => {
    detailRequestRef.current += 1;
    setFormOpen(false);
    setEditing(null);
    setConfiguration(null);
    setConfigurationLoading(false);
    setInitialValues(null);
  };

  const openBlankForm = () => {
    setEditing(null);
    setConfiguration(null);
    setConfigurationLoading(false);
    setInitialValues(null);
    setFormOpen(true);
  };

  const openTemplateForm = (template: OrgAgentTemplate) => {
    setEditing(null);
    setConfiguration(null);
    setConfigurationLoading(false);
    setInitialValues(template.values);
    setFormOpen(true);
  };

  const openEditForm = (agent: OrgAgentRecord) => {
    const requestId = ++detailRequestRef.current;
    setActionError(null);
    setEditing(agent);
    setConfiguration(null);
    setConfigurationLoading(true);
    setInitialValues(null);
    setFormOpen(true);
    void loadConfiguration(agent.id)
      .then(next => {
        if (detailRequestRef.current !== requestId) return;
        setConfiguration(next);
      })
      .catch(err => {
        if (detailRequestRef.current !== requestId) return;
        setActionError(err instanceof Error ? err.message : String(err));
        setFormOpen(false);
        setEditing(null);
      })
      .finally(() => {
        if (detailRequestRef.current === requestId) setConfigurationLoading(false);
      });
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="企业专家"
        description={`为 ${tenantName || tenantId || '当前组织'} 管理专岗 Agent；打开详情即可配置身份、能力、运行策略、访问范围与钉钉账号。`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => { void refresh(); }} disabled={loading}>
              <RefreshCw className={cn('mr-2 size-4', loading && 'animate-spin')} />刷新
            </Button>
            <Button onClick={openBlankForm} disabled={!canEdit}>
              <Plus className="size-4" />创建企业专家
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        {actionError && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div>}

        {/* ---------------- 3 张种子模板卡 ---------------- */}
        {templates.length > 0 && (
          <section aria-label="从模板创建" className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="size-4 text-brand-500" />
                从模板创建
                <span className="text-xs font-normal text-muted-foreground">
                  一键预填名称/职责/门禁配置，管理员确认后创建。
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setTemplatesCollapsed((prev) => !prev)}
              >
                {templatesCollapsed ? '展开' : '收起'}
              </Button>
            </div>
            {!templatesCollapsed && (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => (
                  <TemplateCard
                    key={template.key}
                    template={template}
                    onUse={() => openTemplateForm(template)}
                    disabled={!canEdit}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        <Card>
          <CardContent className="p-0">
            {loading && agents.length === 0 ? (
              <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />加载企业专家...
              </div>
            ) : agents.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
                <Bot className="size-6" />
                <span>还没有企业专家，可从上方模板一键创建，或点击右上角新建。</span>
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
                          <button
                            type="button"
                            className="min-w-0 text-left hover:text-brand-600 disabled:cursor-default disabled:hover:text-inherit"
                            disabled={!canEdit}
                            onClick={() => openEditForm(agent)}
                          >
                            <span className="block truncate text-sm font-medium">{agent.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">{agent.id}</span>
                          </button>
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
                          disabled={!canEdit}
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
                            disabled={!canEdit}
                            onClick={() => openEditForm(agent)}
                          >
                            <Pencil className="size-3.5" />
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
        configuration={configuration}
        configurationLoading={configurationLoading}
        initialValues={initialValues}
        onClose={closeForm}
        onSubmit={handleSubmit}
        onUploadAvatar={uploadAvatar}
      />

    </div>
  );
}

function TemplateCard({
  template,
  onUse,
  disabled = false,
}: {
  template: OrgAgentTemplate;
  onUse: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col justify-between gap-2 rounded-lg border bg-card p-3 shadow-sm transition hover:border-brand-300">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-lg leading-none" aria-hidden>{template.icon || template.avatar}</span>
          <span className="text-sm font-medium">{template.name}</span>
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
      </div>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={onUse} disabled={disabled}>
          使用此模板
        </Button>
      </div>
    </div>
  );
}
