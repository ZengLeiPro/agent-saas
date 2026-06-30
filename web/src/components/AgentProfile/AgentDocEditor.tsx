import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2, Pencil, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownReadonly } from "@/components/MarkdownReadonly";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";

import {
  fetchPersona,
  updatePersona,
  parsePersona,
  fetchAgentMemory,
  updateAgentMemory,
  reportActivity,
} from "@agent/shared";

export type DocEditorKind = "persona" | "memory";

interface DocConfig {
  title: string;
  hint: string;
  placeholder: string;
  maxLength: number;
  viewedEvent: "agent_persona_viewed" | "agent_memory_viewed";
  load: (username: string) => Promise<string>;
  save: (username: string, content: string) => Promise<void>;
}

// 仿照 mobile/app/persona-editor.tsx 的 MODE_CONFIGS：用 kind 区分两种文档，
// load/save 逻辑随 [username, kind] 稳定，避免内联闭包导致重复加载。
const CONFIGS: Record<DocEditorKind, DocConfig> = {
  persona: {
    title: "人格定义",
    hint: "在这里定义你的专属 Agent 的人格和行为风格，新会话生效",
    placeholder: "定义你的 Agent 的性格、说话风格和专业知识...",
    maxLength: 10000,
    viewedEvent: "agent_persona_viewed",
    load: async (username) => parsePersona((await fetchPersona(username)) || "").body,
    save: (username, content) => updatePersona(username, content),
  },
  memory: {
    title: "Agent 记忆",
    hint: "此记忆（MEMORY.md）由 Agent 自行维护更新，请谨慎编辑，新会话生效",
    placeholder: "记忆内容...",
    maxLength: 200000,
    viewedEvent: "agent_memory_viewed",
    load: (username) => fetchAgentMemory(username),
    save: (username, content) => updateAgentMemory(username, content),
  },
};

interface AgentDocEditorProps {
  username: string;
  kind: DocEditorKind;
  /** 不传时不渲染顶部「返回」按钮，用于嵌入设置中心独立 section 的场景。 */
  onBack?: () => void;
  /** 隐藏内部 h2+hint 副标题（用于外层已提供 SettingsPanelHeader 的场景，避免双标题）。 */
  hideInternalHeader?: boolean;
  /** 设置弹窗内使用：由编辑器自己把保存/编辑按钮挂到统一标题区。 */
  headerTitle?: string;
  headerDescription?: ReactNode;
}

export function AgentDocEditor({
  username,
  kind,
  onBack,
  hideInternalHeader,
  headerTitle,
  headerDescription,
}: AgentDocEditorProps) {
  const config = CONFIGS[kind];
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [editing, setEditing] = useState(false);
  const initial = useRef("");

  const dirty = content !== initial.current;

  useEffect(() => {
    reportActivity(config.viewedEvent, { detail: username });
  }, [config.viewedEvent, username]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    config
      .load(username)
      .then((data) => {
        if (cancelled) return;
        setContent(data);
        initial.current = data;
        setEditing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setContent("");
        initial.current = "";
        setEditing(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [config, username]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    setSaveOk(false);
    try {
      await config.save(username, content);
      initial.current = content;
      setSaveMsg("已保存");
      setSaveOk(true);
      setEditing(false);
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveOk(false);
      setSaveMsg(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  }, [config, username, content]);

  const actionControls = (
    <>
      {saveMsg && (
        <span className={cn("text-sm", saveOk ? "text-success" : "text-destructive")}>
          {saveMsg}
        </span>
      )}
      {onBack && headerTitle ? (
        <Button type="button" variant="outline" onClick={onBack} disabled={saving}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          返回
        </Button>
      ) : null}
      {editing ? (
        <Button onClick={handleSave} disabled={loading || saving || !dirty}>
          {saving ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-4 w-4" />
          )}
          保存
        </Button>
      ) : (
        <Button onClick={() => setEditing(true)} disabled={loading}>
          <Pencil className="mr-1.5 h-4 w-4" />
          编辑
        </Button>
      )}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {headerTitle ? (
        <SettingsPanelHeader
          title={headerTitle}
          description={headerDescription ?? config.hint}
          actions={actionControls}
        />
      ) : null}

      {onBack && !headerTitle ? (
        <button
          type="button"
          className="mb-4 flex shrink-0 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
          返回
        </button>
      ) : null}

      {!hideInternalHeader && !headerTitle && (
        <div className="mb-3 shrink-0">
          <h2 className="text-sm font-medium">{config.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{config.hint}</p>
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : editing ? (
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={config.placeholder}
          maxLength={config.maxLength}
          className="min-h-0 flex-1 resize-none font-mono text-sm"
        />
      ) : (
        <MarkdownReadonly content={content} />
      )}

      {!headerTitle && (
        <div className="mt-3 flex shrink-0 items-center gap-3 border-t pt-3">
          {actionControls}
        </div>
      )}
    </div>
  );
}
