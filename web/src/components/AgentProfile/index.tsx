import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Save, Upload, RotateCcw, ChevronRight, Puzzle, Bot, Brain } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useAuth } from "@/contexts/AuthContext";
import {
  fetchAgentProfile,
  updateAgentProfile,
  uploadAgentAvatar,
  isEmojiAvatar,
  getAgentAvatarUrl,
  reportActivity,
} from "@agent/shared";
import type { AgentProfileDetail } from "@agent/shared";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { SkillSelector } from "@/components/SkillSelector";
import { AgentDocEditor } from "./AgentDocEditor";

export { AllAgentsList } from "./AllAgentsList";

/**
 * 设置中心独立 section：Skills。
 * 复用 SkillSelector，外层套 SettingsPanelHeader 保持与其他 section 标题风格一致；
 * 不传 onBack → SkillSelector 不渲染返回按钮（用户通过左侧菜单切换）。
 */
export function SkillsSection() {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SkillSelector
        headerTitle="Skills"
        headerDescription="为 Agent 选择启用的 Skills，新会话生效。"
      />
    </div>
  );
}

/**
 * 设置中心独立 section：记忆。
 * 复用 AgentDocEditor(kind=memory)；隐藏内部 h2+hint 避免与 SettingsPanelHeader 双标题。
 */
export function MemorySection() {
  const { user } = useAuth();
  if (!user?.username) return null;
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <AgentDocEditor
        username={user.username}
        kind="memory"
        headerTitle="记忆"
        headerDescription="Agent 记忆（MEMORY.md）由 Agent 自行维护更新，请谨慎编辑，新会话生效。"
      />
    </div>
  );
}

interface AgentProfileProps {
  /** 受控：当前编辑的用户名（admin 编辑他人时使用）。不传 = 编辑自己。 */
  editingUsername?: string | null;
  /** 受控：editing 变化回调（点击「返回」时会传 null）。 */
  onEditingChange?: (username: string | null) => void;
}

/**
 * 我的 Agent 编辑器。
 *
 * 设计原则：
 * - 只承载「编辑」一种形态。所有 Agent 列表已拆到 AllAgentsList。
 * - editing（编辑他人）支持受控/非受控两种模式：
 *   - 受控：外部传 editingUsername + onEditingChange，由上层（layout）配合 URL/section 切换
 *   - 非受控：外部都不传，内部 state 兜底（向后兼容）
 */
export function AgentProfile({ editingUsername, onEditingChange }: AgentProfileProps = {}) {
  const { user } = useAuth();
  const [internalEditing, setInternalEditing] = useState<string | null>(null);
  const isControlled = editingUsername !== undefined;
  const editing = isControlled ? editingUsername : internalEditing;
  const setEditing = useCallback((username: string | null) => {
    if (isControlled) {
      onEditingChange?.(username);
    } else {
      setInternalEditing(username);
    }
  }, [isControlled, onEditingChange]);

  const [profile, setProfile] = useState<AgentProfileDetail | null>(null);
  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState(false);
  const [subView, setSubView] = useState<"skills" | "persona" | "memory" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const targetUsername = editing || user?.username;

  // 加载单个 profile
  const loadProfile = useCallback(async (username: string) => {
    setLoading(true);
    try {
      const profileData = await fetchAgentProfile(username);
      setProfile(profileData);
      setName(profileData.name || "");
      setSignature(profileData.signature || "");
    } catch {
      setProfile(null);
      setName("");
      setSignature("");
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次进入上报
  useEffect(() => {
    reportActivity("agent_profile_viewed", { detail: "我的 Agent" });
  }, []);

  // 加载当前编辑目标的 profile
  useEffect(() => {
    if (!targetUsername) return;
    loadProfile(targetUsername);
  }, [targetUsername, loadProfile]);

  // 保存
  const handleSave = useCallback(async () => {
    if (!targetUsername) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await updateAgentProfile(targetUsername, { name, signature });
      setSaveMsg("已保存");
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveMsg(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  }, [targetUsername, name, signature]);

  // 头像上传
  const handleAvatarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !targetUsername) return;
    try {
      await uploadAgentAvatar(targetUsername, file);
      await loadProfile(targetUsername);
    } catch (err) {
      alert(err instanceof Error ? err.message : "头像上传失败");
    }
    e.target.value = "";
  }, [targetUsername, loadProfile]);

  // 重置头像
  const handleResetAvatar = useCallback(async () => {
    if (!targetUsername) return;
    try {
      await updateAgentProfile(targetUsername, { avatar: "🤖" });
      await loadProfile(targetUsername);
    } catch {
      alert("重置失败");
    }
  }, [targetUsername, loadProfile]);

  if (!user) return null;

  // =================== 子视图：Skills / 人格定义 / 记忆 ===================
  if (subView) {
    return (
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
        {subView === "skills" ? (
          <SkillSelector
            targetUsername={editing || undefined}
            onBack={() => setSubView(null)}
          />
        ) : (
          targetUsername && (
            <AgentDocEditor
              username={targetUsername}
              kind={subView}
              onBack={() => setSubView(null)}
            />
          )
        )}
      </div>
    );
  }

  // =================== 编辑视图 ===================
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
      {/* 顶部导航：editing 模式显示「返回所有 Agent」；非 editing 显示标准 header */}
      {editing ? (
        <div className="mb-4 flex shrink-0 items-center gap-3">
          <button
            type="button"
            className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setEditing(null)}
          >
            <ArrowLeft className="h-4 w-4" />
            返回所有 Agent
          </button>
        </div>
      ) : (
        <SettingsPanelHeader
          title="我的 Agent"
          description="维护 Agent 名称、签名、Persona、记忆和启用的 Skill。"
        />
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6 pb-4">
          {/* 头像区域 */}
          <div className="flex shrink-0 flex-col items-center gap-3">
            {!isEmojiAvatar(profile?.avatar) ? (
              <div
                className="cursor-pointer transition-opacity hover:opacity-80"
                onClick={() => setAvatarPreview(true)}
              >
                <AgentAvatar avatar={profile?.avatar} username={targetUsername} size="lg" version={profile?.avatarVersion} />
              </div>
            ) : (
              <AgentAvatar avatar={profile?.avatar} username={targetUsername} size="lg" version={profile?.avatarVersion} />
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                上传头像
              </Button>
              {profile?.avatar && profile.avatar.startsWith("agent-avatars/") && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResetAvatar}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  重置
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={handleAvatarUpload}
            />
          </div>

          {/* 名称 */}
          <div className="shrink-0 space-y-2">
            <label className="text-sm font-medium">Agent 名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="给你的 Agent 取个名字"
              maxLength={50}
            />
          </div>

          {/* 签名 */}
          <div className="shrink-0 space-y-2">
            <div className="flex items-baseline gap-2">
              <label className="text-sm font-medium">签名</label>
              <span className="text-xs text-muted-foreground">仅用于向其他用户展示，不注入提示语</span>
            </div>
            <Input
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="写一句签名..."
              maxLength={100}
            />
          </div>

          {/* 入口：Skills / 人格定义 / 记忆 */}
          <div className="shrink-0 space-y-2">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50"
              onClick={() => setSubView("skills")}
            >
              <div className="flex items-center gap-2">
                <Puzzle className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Skills</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50"
              onClick={() => setSubView("persona")}
            >
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">人格定义</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50"
              onClick={() => setSubView("memory")}
            >
              <div className="flex items-center gap-2">
                <Brain className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Agent 记忆</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {/* 保存按钮 */}
          <div className="flex shrink-0 items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-4 w-4" />
              )}
              保存
            </Button>
            {saveMsg && (
              <span className={cn(
                "text-sm",
                saveMsg.startsWith("已") ? "text-success" : "text-destructive"
              )}>
                {saveMsg}
              </span>
            )}
          </div>
        </div>
      )}
      {/* 头像预览 lightbox */}
      {avatarPreview && !isEmojiAvatar(profile?.avatar) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setAvatarPreview(false)}
        >
          <img
            src={getAgentAvatarUrl(targetUsername || "", profile?.avatar, undefined, profile?.avatarVersion)!}
            alt="Avatar"
            className="max-h-[80vh] max-w-[80vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
