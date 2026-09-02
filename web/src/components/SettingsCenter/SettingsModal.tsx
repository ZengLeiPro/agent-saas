import { apiUrl, resolveApiAssetUrl } from "../../lib/apiBase";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, Suspense, type ReactNode } from "react";
import {
  ChevronLeft,
  Lock,
  Loader2,
  LogOut,
  Save,
  Settings2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHeader, SettingsPanelHeaderStickyProvider } from "@/components/SettingsCenter/SettingsPanelHeader";
import { BrowserNotificationSettings } from "@/components/SettingsCenter/BrowserNotificationSettings";
import { AppearanceLayoutPreferences } from "@/components/SettingsCenter/AppearanceLayoutPreferences";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  ConnectionsSection,
  FilesStorageSection,
  MyAgentSection,
  MyPermissionsSection,
} from "@/components/PersonalSettings/V2Sections";
import {
  restoreSettingsDraft,
  useSettingsDirtyEntry,
  type SettingsDirtyController,
} from "@/components/PersonalSettings/dirtyRegistry";
import { PersonaEditDialog } from "@/components/AgentProfile/PersonaEditDialog";
import { EmbeddedSettingsFrame } from "@/components/SettingsCenter/EmbeddedSettingsFrame";
import { TrashView } from "@/components/chat/TrashView";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { TOKEN_KEY } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { normalizeSettingsSection } from "@/lib/urlSync";
import { fetchAgentProfile, saveUserPreferences, updateAgentProfile, uploadAgentAvatar } from "@agent/shared";
import type { AgentProfileDetail, ModelList, SidebarLayoutPref } from "@agent/shared";
import type { CanonicalSettingsSectionId, SettingsSectionId } from "@/types/settings";
import { SETTINGS_GROUP_LABELS, SETTINGS_SECTIONS } from "@/components/SettingsCenter/settingsConfig";
import {
  ManagementSettingsGroups,
  type ManagementSettingsGroup,
} from "@/components/SettingsCenter/ManagementSettingsGroups";

export { SETTINGS_SECTIONS } from "@/components/SettingsCenter/settingsConfig";
const SETTINGS_NAV_ITEM_SELECTED =
  "bg-brand-accent-soft text-foreground font-semibold";
const SETTINGS_NAV_ITEM_UNSELECTED =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground";
const RUN_SHELL_APPROVAL_STORAGE_PREFIX = "agentChat.autoApproveRunShell.";

function initials(name?: string) {
  return (name || "U").trim().slice(0, 1).toUpperCase();
}

function PlaceholderSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader title={title} description={description} actions={actions} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          {children ?? <p className="text-sm text-muted-foreground">此模块已收敛到设置弹窗中，后续配置将在这里完成。</p>}
        </div>
      </div>
    </div>
  );
}

function SettingsSectionFallback() {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      加载中...
    </div>
  );
}

function clearRunShellApprovalStorage() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(RUN_SHELL_APPROVAL_STORAGE_PREFIX)) {
      localStorage.removeItem(key);
    }
  }
}

export function GeneralSection() {
  // 授权模式对所有用户开放（2026-07-02 起）；TASK-256：缺失字段默认开启（!== false），与服务端 ?? true 一致。
  const { user, updatePreferences } = useAuth();
  const authorizationModeEnabled = user ? user.preferences?.authorizationModeEnabled !== false : false;
  const preferredDefaultModel = user?.preferences?.defaultModel;
  const recoveredDraft = useRef(restoreSettingsDraft<{
    defaultModel?: string;
  }>("chat-model"));
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [draftAuthorizationMode, setDraftAuthorizationMode] = useState(authorizationModeEnabled);
  const [draftDefaultModel, setDraftDefaultModel] = useState(recoveredDraft.current?.defaultModel ?? preferredDefaultModel ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/models")
      .then(async (response) => {
        if (!response.ok) throw new Error("加载可选模型失败");
        return response.json() as Promise<ModelList>;
      })
      .then((data) => {
        if (cancelled) return;
        setModelList(data);
      })
      .catch(() => {
        if (!cancelled) setModelList(null);
      });
    return () => { cancelled = true; };
  }, [preferredDefaultModel]);

  useEffect(() => {
    setDraftAuthorizationMode(authorizationModeEnabled);
    if (recoveredDraft.current && modelList) {
      setDraftDefaultModel(recoveredDraft.current.defaultModel ?? modelList.default);
      recoveredDraft.current = null;
    } else if (!recoveredDraft.current) {
      setDraftDefaultModel(modelList?.default ?? "");
    }
    setSaved(false);
  }, [authorizationModeEnabled, modelList]);

  const currentDefaultModel = modelList?.default ?? "";
  const hasChanges = draftAuthorizationMode !== authorizationModeEnabled
    || (!!draftDefaultModel && draftDefaultModel !== currentDefaultModel);

  const handleSave = useCallback(async () => {
    const next = {
      authorizationModeEnabled: draftAuthorizationMode,
      ...(draftDefaultModel ? { defaultModel: draftDefaultModel } : {}),
    };
    setSaving(true);
    setSaved(false);
    updatePreferences(next);
    if (!draftAuthorizationMode) clearRunShellApprovalStorage();
    try {
      const savedPreferences = await saveUserPreferences(next);
      if (!savedPreferences) throw new Error("保存失败");
      updatePreferences(savedPreferences);
      if (savedPreferences.authorizationModeEnabled !== true) clearRunShellApprovalStorage();
      if (savedPreferences.defaultModel) {
        window.dispatchEvent(new CustomEvent("agent:default-model-changed", {
          detail: { model: savedPreferences.defaultModel },
        }));
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      updatePreferences({
        authorizationModeEnabled,
        defaultModel: preferredDefaultModel,
      });
      setDraftDefaultModel(modelList?.default ?? "");
      window.alert(error instanceof Error ? error.message : "保存失败");
      throw error;
    } finally {
      setSaving(false);
    }
  }, [authorizationModeEnabled, draftAuthorizationMode, draftDefaultModel, modelList?.default, preferredDefaultModel, updatePreferences]);

  const discardDraft = useCallback(() => {
    setDraftAuthorizationMode(authorizationModeEnabled);
    setDraftDefaultModel(modelList?.default ?? "");
    setSaved(false);
  }, [authorizationModeEnabled, modelList?.default]);

  useSettingsDirtyEntry({
    id: "chat-model",
    label: "对话与模型",
    dirty: hasChanges,
    save: handleSave,
    discard: discardDraft,
    draft: {
      defaultModel: draftDefaultModel,
    },
  });

  return (
    <PlaceholderSection
      title="对话与模型"
      description="管理新会话默认模型与对话中的展示偏好。"
      actions={(
        <>
          {saved && <span className="text-sm text-success">已保存</span>}
          <Button onClick={() => { void handleSave().catch(() => undefined); }} disabled={saving || !hasChanges}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">新建会话默认模型</div>
            <div className="mt-1 text-sm leading-6 text-muted-foreground">
              仅可选择当前组织允许你使用的模型；已存在会话仍保留各自的模型设置。
            </div>
          </div>
          <Select value={draftDefaultModel} onValueChange={(value) => { setDraftDefaultModel(value); setSaved(false); }} disabled={saving || !modelList}>
            <SelectTrigger className="w-[260px] max-w-full" aria-label="新建会话默认模型">
              <SelectValue placeholder={modelList ? "请选择模型" : "加载中..."} />
            </SelectTrigger>
            <SelectContent>
              {modelList?.groups.flatMap((group) => group.models.map((model) => {
                const ref = `${group.id}/${model.id}`;
                return (
                  <SelectItem key={ref} value={ref}>
                    {modelList.showGroupNames ? `${group.name} / ${model.name}` : model.name}
                  </SelectItem>
                );
              }))}
            </SelectContent>
          </Select>
        </div>
        <BrowserNotificationSettings />
      </div>
    </PlaceholderSection>
  );
}

interface AccountSectionProps {
  onAvatarUpload: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  avatarInputRef: React.RefObject<HTMLInputElement>;
  avatarUploading: boolean;
  onChangePassword: () => void;
  showAgentSettings: boolean;
}

function AccountSection({ onAvatarUpload, avatarInputRef, avatarUploading, onChangePassword, showAgentSettings }: AccountSectionProps) {
  const { user, logout, updatePhone } = useAuth();
  const displayName = user?.realName || user?.username || "未登录";
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false);
  const [copiedUserId, setCopiedUserId] = useState(false);
  const [phone, setPhone] = useState(user?.phone?.trim() || "");
  const [phoneVerifiedAt, setPhoneVerifiedAt] = useState(user?.phoneVerifiedAt);
  const [draftPhone, setDraftPhone] = useState(phone);
  const [phoneCode, setPhoneCode] = useState("");
  const [sendingPhoneCode, setSendingPhoneCode] = useState(false);
  const [phoneCountdown, setPhoneCountdown] = useState(0);
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const phoneTimerRef = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => {
    const nextPhone = user?.phone?.trim() || "";
    setPhone(nextPhone);
    setDraftPhone(nextPhone);
    setPhoneVerifiedAt(user?.phoneVerifiedAt);
  }, [user?.phone, user?.phoneVerifiedAt]);

  useEffect(() => () => clearInterval(phoneTimerRef.current), []);

  const startPhoneCountdown = useCallback(() => {
    clearInterval(phoneTimerRef.current);
    setPhoneCountdown(60);
    phoneTimerRef.current = setInterval(() => {
      setPhoneCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(phoneTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const openPhoneDialog = useCallback(() => {
    setDraftPhone(phone);
    setPhoneCode("");
    setPhoneError(null);
    setPhoneDialogOpen(true);
  }, [phone]);

  const sendPhoneCode = useCallback(async () => {
    const trimmed = draftPhone.trim();
    if (!/^1[3-9]\d{9}$/.test(trimmed)) {
      setPhoneError("请输入有效的 11 位手机号");
      return;
    }
    setSendingPhoneCode(true);
    setPhoneError(null);
    try {
      const res = await authFetch("/api/auth/me/phone/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "验证码发送失败");
      }
      startPhoneCountdown();
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : "验证码发送失败");
    } finally {
      setSendingPhoneCode(false);
    }
  }, [draftPhone, startPhoneCountdown]);

  const savePhone = useCallback(async () => {
    const trimmed = draftPhone.trim();
    // 前端预检验：空 = 清除；非空必须 11 位以 1[3-9] 开头（与后端 zod 一致）
    if (trimmed !== "" && !/^1[3-9]\d{9}$/.test(trimmed)) {
      setPhoneError("请输入有效的 11 位手机号");
      return;
    }
    if (trimmed !== "" && !/^\d{6}$/.test(phoneCode)) {
      setPhoneError("请输入 6 位验证码");
      return;
    }
    setSavingPhone(true);
    setPhoneError(null);
    try {
      if (trimmed === "") {
        const res = await authFetch("/api/auth/me/phone", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: "" }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error((data as { error?: string }).error || "保存失败");
        }
        setPhone("");
        setPhoneVerifiedAt(undefined);
        updatePhone(undefined, undefined);
      } else {
        const res = await authFetch("/api/auth/me/phone/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: trimmed, code: phoneCode }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error((data as { error?: string }).error || "验证失败");
        }
        const data = (await res.json()) as { phone: string | null; phoneVerifiedAt: string | null };
        const next = data.phone ?? "";
        const verifiedAt = data.phoneVerifiedAt ?? undefined;
        setPhone(next);
        setPhoneVerifiedAt(verifiedAt);
        updatePhone(next || undefined, verifiedAt);
      }
      clearInterval(phoneTimerRef.current);
      setPhoneCountdown(0);
      setPhoneCode("");
      setPhoneDialogOpen(false);
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : "验证失败");
    } finally {
      setSavingPhone(false);
    }
  }, [draftPhone, phoneCode, updatePhone]);

  const userId = user?.id || user?.username || "未知";
  const copyUserId = useCallback(async () => {
    await navigator.clipboard.writeText(userId);
    setCopiedUserId(true);
    window.setTimeout(() => setCopiedUserId(false), 1400);
  }, [userId]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader title="账户" description="管理你的账户资料、安全凭据和登录状态。" />
      <div className="min-h-0 flex-1 overflow-auto">
        <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void onAvatarUpload(event); }} />
        <div className="space-y-6">
          <section className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-center lg:gap-6">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  className="flex size-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-brand-600 text-2xl font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => user?.avatar && setAvatarPreviewOpen(true)}
                  aria-label="预览头像大图"
                >
                  {user?.avatar ? <img src={resolveApiAssetUrl(user.avatar)} alt="用户头像" className="h-full w-full object-cover" /> : initials(displayName)}
                </button>
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold">{displayName}</div>
                  <div className="truncate text-sm text-muted-foreground">@{user?.username || "anonymous"}</div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-8 px-3"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarUploading}
                  >
                    {avatarUploading ? "上传中" : "更改头像"}
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-2.5">
                <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:items-center">
                  <div className="text-sm font-medium">全名</div>
                  <div className="truncate text-sm text-muted-foreground">{displayName || "暂无"}</div>
                  <Button size="sm" variant="outline" className="min-w-20 justify-self-end" disabled>更改</Button>
                </div>
                <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:items-center">
                  <div className="text-sm font-medium">手机号</div>
                  <div className="truncate text-sm text-muted-foreground">
                    {phone ? `${phone} · ${phoneVerifiedAt ? "已验证" : "未验证"}` : "暂无"}
                  </div>
                  <Button size="sm" variant="outline" className="min-w-20 justify-self-end" onClick={openPhoneDialog}>更改</Button>
                </div>
                <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:items-center">
                  <div className="text-sm font-medium">用户 ID</div>
                  <div className="truncate text-sm text-muted-foreground">{userId}</div>
                  <Button size="sm" variant="outline" className="min-w-20 justify-self-end" onClick={() => { void copyUserId(); }}>{copiedUserId ? "已复制" : "复制"}</Button>
                </div>
              </div>
            </div>
          </section>
          {showAgentSettings && <AgentAccountSection />}
          <section className="space-y-3 rounded-2xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold">修改密码</div>
              <div className="text-sm text-muted-foreground">定期更新密码，提升账号安全性。</div>
            </div>
            <Button variant="outline" onClick={onChangePassword}><Lock className="size-4" />修改</Button>
          </div>
          <div className="flex items-center justify-between gap-4 border-t pt-3">
            <div>
              <div className="text-sm font-semibold text-destructive">退出登录</div>
              <div className="text-sm text-muted-foreground">退出当前设备上的登录状态。</div>
            </div>
            <Button variant="destructive" onClick={logout}><LogOut className="size-4" />退出</Button>
          </div>
          </section>
        </div>
      </div>
      <Dialog open={avatarPreviewOpen} onOpenChange={setAvatarPreviewOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] border-none bg-transparent p-0 shadow-none sm:max-w-xl">
          <DialogTitle className="sr-only">头像大图预览</DialogTitle>
          {user?.avatar ? <img src={resolveApiAssetUrl(user.avatar)} alt="用户头像大图" className="max-h-[80vh] w-full rounded-2xl object-contain shadow-2xl" /> : null}
        </DialogContent>
      </Dialog>
      <Dialog open={phoneDialogOpen} onOpenChange={(open) => { if (!open && !savingPhone) setPhoneDialogOpen(false); }}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>更改手机号</DialogTitle>
            <DialogDescription>手机号验证后可用于验证码登录；留空可清除手机号。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              inputMode="tel"
              placeholder="请输入手机号"
              value={draftPhone}
              maxLength={11}
              onChange={(event) => {
                setDraftPhone(event.target.value.replace(/\D/g, ""));
                setPhoneCode("");
                if (phoneError) setPhoneError(null);
              }}
              autoFocus
            />
            {draftPhone.trim() !== "" && (
              <div className="flex gap-2">
                <Input
                  inputMode="numeric"
                  placeholder="验证码"
                  value={phoneCode}
                  maxLength={6}
                  onChange={(event) => {
                    setPhoneCode(event.target.value.replace(/\D/g, ""));
                    if (phoneError) setPhoneError(null);
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") { void savePhone(); } }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-28 shrink-0"
                  onClick={() => { void sendPhoneCode(); }}
                  disabled={sendingPhoneCode || phoneCountdown > 0 || savingPhone}
                >
                  {sendingPhoneCode ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : phoneCountdown > 0 ? (
                    `${phoneCountdown}s`
                  ) : (
                    "获取验证码"
                  )}
                </Button>
              </div>
            )}
          </div>
          {phoneError && <div className="text-sm text-destructive">{phoneError}</div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPhoneDialogOpen(false)} disabled={savingPhone}>取消</Button>
            <Button onClick={() => { void savePhone(); }} disabled={savingPhone}>
              {savingPhone ? <Loader2 className="size-4 animate-spin" /> : null}
              {draftPhone.trim() === "" ? "清除手机号" : "完成验证"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgentAccountSection() {
  const { user } = useAuth();
  const username = user?.username;
  const [profile, setProfile] = useState<AgentProfileDetail | null>(null);
  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [loading, setLoading] = useState(false);
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false);
  const [personaDialogOpen, setPersonaDialogOpen] = useState(false);
  // Agent 名称/签名 改为弹窗编辑模式，与用户卡的「手机号 → 弹窗」交互一致
  const [editingField, setEditingField] = useState<"name" | "signature" | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [savingField, setSavingField] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadProfile = useCallback(async () => {
    if (!username) return;
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
  }, [username]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const handleAvatarUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !username) return;
    try {
      await uploadAgentAvatar(username, file);
      await loadProfile();
    } catch (error) {
      alert(error instanceof Error ? error.message : "头像上传失败");
    } finally {
      event.target.value = "";
    }
  }, [loadProfile, username]);

  const openEditDialog = useCallback((field: "name" | "signature") => {
    setDraftValue(field === "name" ? name : signature);
    setEditingField(field);
  }, [name, signature]);

  const closeEditDialog = useCallback(() => {
    setEditingField(null);
  }, []);

  const saveEditDialog = useCallback(async () => {
    if (!username || !editingField) return;
    const trimmed = draftValue;
    setSavingField(true);
    try {
      await updateAgentProfile(username, { [editingField]: trimmed });
      if (editingField === "name") setName(trimmed);
      else setSignature(trimmed);
      setEditingField(null);
    } catch (error) {
      alert(`保存失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setSavingField(false);
    }
  }, [draftValue, editingField, username]);

  if (!username) return null;

  if (loading) {
    return (
      <div className="flex h-24 items-center justify-center rounded-2xl border bg-card text-muted-foreground shadow-sm">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const editingTitle = editingField === "name" ? "更改 Agent 名称" : "更改签名";
  const editingPlaceholder = editingField === "name" ? "给你的 Agent 取个名字" : "写一句签名...";
  const editingMaxLength = editingField === "name" ? 50 : 100;

  return (
    <>
      <section className="rounded-2xl border bg-card p-4 shadow-sm">
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-center lg:gap-6">
          <div className="flex items-center gap-4">
            <button
              type="button"
              className="shrink-0 rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-100"
              onClick={() => profile?.avatar && setAvatarPreviewOpen(true)}
              disabled={!profile?.avatar}
              aria-label="预览 Agent 头像大图"
            >
              <AgentAvatar avatar={profile?.avatar} username={username} size={80} version={profile?.avatarVersion} />
            </button>
            <div className="min-w-0">
              <div className="truncate text-base font-semibold">{name || profile?.name || username}</div>
              <Button size="sm" variant="outline" className="mt-2 h-8 px-3" onClick={() => fileInputRef.current?.click()}>
                更改头像
              </Button>
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleAvatarUpload} />
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:items-center">
              <div className="text-sm font-medium">Agent 名称</div>
              <div className="truncate text-sm text-muted-foreground">{name || "暂无"}</div>
              <Button size="sm" variant="outline" className="min-w-20 justify-self-end" onClick={() => openEditDialog("name")}>更改</Button>
            </div>
            <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:items-center">
              <div className="text-sm font-medium">签名</div>
              <div className="truncate text-sm text-muted-foreground">{signature || "暂无"}</div>
              <Button size="sm" variant="outline" className="min-w-20 justify-self-end" onClick={() => openEditDialog("signature")}>更改</Button>
            </div>
            <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:items-center">
              <div className="text-sm font-medium">人格定义</div>
              <div className="truncate text-sm text-muted-foreground">定义 Agent 的人格和行为风格</div>
              <Button size="sm" variant="outline" className="min-w-20 justify-self-end" onClick={() => setPersonaDialogOpen(true)}>编辑</Button>
            </div>
          </div>
        </div>
      </section>
      <Dialog open={avatarPreviewOpen} onOpenChange={setAvatarPreviewOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] border-none bg-transparent p-0 shadow-none sm:max-w-md">
          <DialogTitle className="sr-only">Agent 头像大图预览</DialogTitle>
          <div className="flex items-center justify-center p-4">
            <AgentAvatar avatar={profile?.avatar} username={username} size={320} version={profile?.avatarVersion} className="shadow-2xl" />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={editingField !== null} onOpenChange={(open) => { if (!open) closeEditDialog(); }}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingTitle}</DialogTitle>
          </DialogHeader>
          <Input
            placeholder={editingPlaceholder}
            value={draftValue}
            maxLength={editingMaxLength}
            onChange={(event) => setDraftValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { void saveEditDialog(); } }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={closeEditDialog} disabled={savingField}>取消</Button>
            <Button onClick={() => { void saveEditDialog(); }} disabled={savingField}>
              {savingField ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PersonaEditDialog username={username} open={personaDialogOpen} onOpenChange={setPersonaDialogOpen} />
    </>
  );
}

export interface SettingsModalProps {
  open: boolean;
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onClose: () => void;
  renderMemory?: () => ReactNode;
  renderFiles?: () => ReactNode;
  renderTrash?: () => ReactNode;
  sidebarLayout?: SidebarLayoutPref;
  onSidebarLayoutChange?: (layout: SidebarLayoutPref) => void;
  chatFontLarge?: boolean;
  onChatFontSizeChange?: (large: boolean) => void;
  /** false 时隐藏只服务个人通用 Agent 的设置；管理员调用方应传 true。 */
  personalAgentEnabled?: boolean;
  onNavigationControllerChange?: (controller: SettingsDirtyController | null) => void;
  /** 移动端统一设置菜单中的组织/平台管理入口；桌面统一侧栏不传。 */
  managementGroups?: readonly ManagementSettingsGroup[];
}

export function SettingsModalInner({
  open,
  section: sectionInput,
  onSectionChange,
  onClose,
  renderMemory,
  renderFiles,
  renderTrash,
  sidebarLayout = "double",
  onSidebarLayoutChange,
  chatFontLarge = false,
  onChatFontSizeChange,
  personalAgentEnabled = true,
  onNavigationControllerChange,
  managementGroups = [],
  dirtyController, embedded = false,
}: SettingsModalProps & { dirtyController: SettingsDirtyController; embedded?: boolean }) {
  const section = normalizeSettingsSection(sectionInput);
  const { user, updateAvatar, updatePreferences } = useAuth();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const showSessionListAvatar = user?.preferences?.showSessionListAvatar === true;
  const [personalizationSaving, setPersonalizationSaving] = useState(false);
  const [personalizationSaved, setPersonalizationSaved] = useState(false);
  const [, startSectionTransition] = useTransition();

  useEffect(() => {
    onNavigationControllerChange?.(dirtyController); return () => onNavigationControllerChange?.(null);
  }, [dirtyController, onNavigationControllerChange]);

  const handleSectionChange = useCallback((id: CanonicalSettingsSectionId) => {
    if (id === section) return;
    dirtyController.requestNavigation(() => {
      startSectionTransition(() => onSectionChange(id));
    });
  }, [dirtyController, onSectionChange, section]);

  const handleClose = useCallback(() => {
    dirtyController.requestNavigation(onClose);
  }, [dirtyController, onClose]);

  // 移动端（<md）两级导航：菜单页 ⇄ 内容页。桌面不受影响（max-md 类不生效）。
  const [mobileView, setMobileView] = useState<"menu" | "content">("menu");
  useEffect(() => {
    if (open) setMobileView("menu");
  }, [open]);

  const visibleSections = useMemo(
    () => SETTINGS_SECTIONS.filter((item) => personalAgentEnabled || item.id !== "my-agent"),
    [personalAgentEnabled],
  );

  useEffect(() => {
    if (!open) return;
    if (!visibleSections.some(item => item.id === section)) {
      onSectionChange("account-security");
    }
  }, [open, section, visibleSections, onSectionChange]);

  // mount-once-visited：访问过的 section 保留在 DOM 中，避免切换时 panel
  // unmount/mount + 重新拉数据导致的"刷新"闪烁。modal 关闭时整体 unmount，
  // visited 跟着重置。
  const [visited, setVisited] = useState<Set<CanonicalSettingsSectionId>>(() => new Set([section]));
  useEffect(() => {
    if (!open) return;
    setVisited(prev => (prev.has(section) ? prev : new Set(prev).add(section)));
  }, [open, section]);

  const handleShowSessionListAvatarChange = useCallback(async (nextValue: boolean) => {
    setPersonalizationSaving(true);
    setPersonalizationSaved(false);
    updatePreferences({ showSessionListAvatar: nextValue });
    try {
      const saved = await saveUserPreferences({ showSessionListAvatar: nextValue });
      if (!saved) throw new Error("保存失败");
      updatePreferences(saved);
      setPersonalizationSaved(true);
      window.setTimeout(() => setPersonalizationSaved(false), 2000);
    } catch (error) {
      updatePreferences({ showSessionListAvatar });
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setPersonalizationSaving(false);
    }
  }, [showSessionListAvatar, updatePreferences]);

  const handleAvatarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("avatar", file);
    setAvatarUploading(true);
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch(apiUrl("/api/auth/avatar"), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert((data as { error?: string }).error || "上传失败");
        return;
      }
      const data = await res.json();
      updateAvatar(data.avatar, data.avatarVersion);
    } catch {
      alert("上传失败");
    } finally {
      setAvatarUploading(false);
      e.target.value = "";
    }
  }, [updateAvatar]);

  if (!open) return null;

  const activeConfig = visibleSections.find(item => item.id === section) ?? visibleSections[0] ?? SETTINGS_SECTIONS[0];
  const grouped = (["personal", "preferences", "access", "data"] as const).map(group => ({
    group,
    items: visibleSections.filter(item => item.group === group),
  })).filter(group => group.items.length > 0);

  // mount-once-visited：每个 section 用 hidden 切换可见性，访问过就留在 DOM。
  // 避免「切换面板→拉数据→渲染→切回→再次重置→再拉数据」式闪烁。
  // visited.has(id) 守门，未访问过的 section 不预先 mount，避免一打开 modal 就
  // 把所有 panel 的数据请求一齐发出。
  const sectionsToRender: { id: CanonicalSettingsSectionId; node: ReactNode }[] = [
    {
      id: "account-security",
      node: <AccountSection avatarInputRef={avatarInputRef} avatarUploading={avatarUploading} onAvatarUpload={handleAvatarUpload} onChangePassword={() => setShowPasswordDialog(true)} showAgentSettings={false} />,
    },
    {
      id: "my-agent",
      node: (
        <MyAgentSection
          renderMemory={renderMemory}
          renderProfile={() => <AgentAccountSection />}
        />
      ),
    },
    { id: "chat-model", node: <GeneralSection /> },
    {
      id: "appearance-layout",
      node: (
        <PlaceholderSection
          title="外观与布局"
          description="配置侧边栏、会话列表和其他界面偏好。"
          actions={<span className="text-sm text-muted-foreground">{personalizationSaving ? "保存中…" : personalizationSaved ? "已保存" : "更改即时保存"}</span>}
        >
          <AppearanceLayoutPreferences
            chatFontLarge={chatFontLarge}
            onChatFontSizeChange={(next) => { onChatFontSizeChange?.(next); setPersonalizationSaved(true); }}
            sidebarLayout={sidebarLayout}
            onSidebarLayoutChange={(next) => { onSidebarLayoutChange?.(next); setPersonalizationSaved(true); }}
            showSessionListAvatar={showSessionListAvatar}
            avatarSaving={personalizationSaving}
            onShowSessionListAvatarChange={(next) => { void handleShowSessionListAvatarChange(next); }}
          />
        </PlaceholderSection>
      ),
    },
    { id: "my-permissions", node: <MyPermissionsSection /> },
    { id: "connections", node: <ConnectionsSection /> },
    { id: "files-storage", node: <FilesStorageSection renderFiles={renderFiles} /> },
    {
      id: "trash",
      node: renderTrash?.() ?? <TrashView onClose={handleClose} showHeader={false} />,
    },
  ];

  const content = (
    <>
      {sectionsToRender.map(({ id, node }) => {
        if (!visited.has(id)) return null;
        const isActive = id === activeConfig.id;
        return (
          <div key={id} className={cn("h-full min-h-0", !isActive && "hidden")} aria-hidden={!isActive}>
            <Suspense fallback={<SettingsSectionFallback />}>
              {node}
            </Suspense>
          </div>
        );
      })}
    </>
  );

  if (embedded) return <EmbeddedSettingsFrame content={content} showPasswordDialog={showPasswordDialog} onShowPasswordDialogChange={setShowPasswordDialog} avatarUploading={avatarUploading} />;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm md:p-8" role="dialog" aria-modal="true" aria-label="设置" onClick={handleClose}>
      <div className="flex h-full w-full overflow-hidden bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl md:h-[min(920px,calc(100vh-96px))] md:w-[min(1184px,calc(100vw-64px))] md:rounded-3xl md:border md:pb-0 md:pt-0" onClick={(event) => event.stopPropagation()}>
        <aside className={cn("flex w-full shrink-0 flex-col bg-muted/20 p-3 md:w-40 md:border-r", mobileView === "content" && "max-md:hidden")}>
          <div className="mb-4 flex items-center gap-2.5 px-1">
            <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-600 text-sm font-semibold text-white">
              {user?.avatar ? <img src={resolveApiAssetUrl(user.avatar)} alt="" className="h-full w-full object-cover" /> : initials(user?.realName || user?.username)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{user?.realName || user?.username || "未登录"}</div>
              <div className="truncate text-xs text-muted-foreground">个人</div>
            </div>
            <button type="button" className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden" onClick={handleClose} aria-label="关闭设置">
              <X className="size-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {grouped.map(group => (
              <div key={group.group} className="mb-4">
                <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">{SETTINGS_GROUP_LABELS[group.group]}</div>
                <div className="space-y-1">
                  {group.items.map(item => {
                    const Icon = item.icon;
                    const active = item.id === activeConfig.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                          active ? SETTINGS_NAV_ITEM_SELECTED : SETTINGS_NAV_ITEM_UNSELECTED,
                        )}
                        onClick={() => { handleSectionChange(item.id); setMobileView("content"); }}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <ManagementSettingsGroups
              groups={managementGroups}
              onSelect={(navigation) => dirtyController.requestNavigation(navigation)}
            />
          </div>
          <div className="border-t pt-3">
            <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <Settings2 className="size-4" />
              获取帮助
            </button>
          </div>
        </aside>
        <main className={cn("relative flex min-w-0 flex-1 flex-col", mobileView === "menu" && "max-md:hidden")}>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-2 md:hidden">
            <div className="flex min-w-0 items-center gap-1">
              <button type="button" className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setMobileView("menu")} aria-label="返回设置菜单">
                <ChevronLeft className="size-5" />
              </button>
              <span className="truncate text-sm font-semibold">{activeConfig.label}</span>
            </div>
            <button type="button" className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={handleClose} aria-label="关闭设置">
              <X className="size-5" />
            </button>
          </div>
          <button type="button" className="absolute right-5 top-5 z-30 rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground max-md:hidden" onClick={handleClose} aria-label="关闭设置">
            <X className="size-5" />
          </button>
          <div className="min-h-0 flex-1 overflow-hidden p-4 pb-2 pt-3 md:p-8 md:pb-4 md:pt-5">
            <SettingsPanelHeaderStickyProvider>
              {content}
            </SettingsPanelHeaderStickyProvider>
          </div>
        </main>
      </div>
      <div
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ChangePasswordDialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog} />
      </div>
      <div className="sr-only" aria-live="polite">{avatarUploading ? "头像上传中" : ""}</div>
    </div>
  );
}
