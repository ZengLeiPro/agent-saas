import { useCallback, useState } from 'react';
import { Loader2, RotateCcw, Save } from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { useSettingsDirtyEntry } from '@/components/PersonalSettings/dirtyRegistry';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { saveUserPreferences } from '@agent/shared';

const MAX_PROMPT_LENGTH = 2000;

function PromptEditor(props: {
  id: string;
  label: string;
  description: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={props.id}>{props.label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.disabled || !props.value}
          onClick={() => props.onChange('')}
        >
          <RotateCcw className="size-3.5" />
          恢复默认
        </Button>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{props.description}</p>
      <Textarea
        id={props.id}
        className="min-h-32"
        maxLength={MAX_PROMPT_LENGTH}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <div className="text-right text-xs text-muted-foreground">
        {props.value.length}/{MAX_PROMPT_LENGTH}
      </div>
    </div>
  );
}

export function SessionOrganizationSettings() {
  const { user, updatePreferences } = useAuth();
  const savedTitlePrompt = user?.preferences?.titlePromptAddition ?? '';
  const savedGroupingPrompt = user?.preferences?.sessionGroupingPromptAddition ?? '';
  const savedEnabled = user?.preferences?.sessionOrganizationEnabled === true;
  const [titlePrompt, setTitlePrompt] = useState(savedTitlePrompt);
  const [groupingPrompt, setGroupingPrompt] = useState(savedGroupingPrompt);
  const [enabled, setEnabled] = useState(savedEnabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = enabled !== savedEnabled || titlePrompt !== savedTitlePrompt || groupingPrompt !== savedGroupingPrompt;

  const save = useCallback(async () => {
    const next = {
      sessionOrganizationEnabled: enabled,
      titlePromptAddition: titlePrompt.trim(),
      sessionGroupingPromptAddition: groupingPrompt.trim(),
    };
    setSaving(true);
    setSaved(false);
    try {
      const preferences = await saveUserPreferences(next);
      if (!preferences) throw new Error('保存失败');
      updatePreferences(preferences);
      setEnabled(preferences.sessionOrganizationEnabled === true);
      setTitlePrompt(preferences.titlePromptAddition ?? '');
      setGroupingPrompt(preferences.sessionGroupingPromptAddition ?? '');
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '保存失败');
      throw error;
    } finally {
      setSaving(false);
    }
  }, [enabled, groupingPrompt, titlePrompt, updatePreferences]);

  const discard = useCallback(() => {
    setEnabled(savedEnabled);
    setTitlePrompt(savedTitlePrompt);
    setGroupingPrompt(savedGroupingPrompt);
    setSaved(false);
  }, [savedEnabled, savedGroupingPrompt, savedTitlePrompt]);

  useSettingsDirtyEntry({
    id: 'session-organization',
    label: '会话智能整理',
    dirty,
    save,
    discard,
    draft: { enabled, titlePrompt, groupingPrompt },
  });

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <SettingsPanelHeader
        title="会话智能整理"
        description="设置个人标题风格和智能分组习惯。个人要求会追加在平台规则之后。"
        className="md:pr-0"
        actions={
          <>
            {saved && <span className="text-sm text-success">已保存</span>}
            <Button
              onClick={() => {
                void save().catch(() => undefined);
              }}
              disabled={saving || !dirty}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        <div className="flex items-center justify-between gap-4 rounded-xl border bg-card p-4">
          <div className="min-w-0">
            <Label htmlFor="session-organization-enabled">启用会话智能整理</Label>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              开启后，会话列表显示智能分组入口。默认关闭，整理方案仍需你确认后才会应用。
            </p>
          </div>
          <Switch
            id="session-organization-enabled"
            checked={enabled}
            disabled={saving}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              setSaved(false);
            }}
          />
        </div>
        {enabled ? (
          <>
            <PromptEditor
              id="title-prompt-addition"
              label="我的标题生成要求"
              description="例如：标题优先使用客户名称，并体现本次要处理的事项。留空则完全使用平台默认规则。"
              value={titlePrompt}
              disabled={saving}
              onChange={(value) => {
                setTitlePrompt(value);
                setSaved(false);
              }}
            />
            <PromptEditor
              id="grouping-prompt-addition"
              label="我的智能分组要求"
              description="例如：优先按客户名称分组；没有明确客户时再按销售、采购、财务、研发分类。"
              value={groupingPrompt}
              disabled={saving}
              onChange={(value) => {
                setGroupingPrompt(value);
                setSaved(false);
              }}
            />
            <p className="px-1 text-xs text-muted-foreground">
              请勿在提示语中填写密码、密钥或其他敏感信息。
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
