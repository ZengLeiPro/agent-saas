import { useCallback, useEffect, useMemo, useRef, useState, useTransition, Suspense, type ReactNode } from "react";
import {
  Brain,
  Building2,
  CircleCheck,
  Clock,
  ExternalLink,
  Lock,
  Loader2,
  LogOut,
  Palette,
  Save,
  Settings2,
  TriangleAlert,
  User,
  X,
} from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentDocEditor } from "@/components/AgentProfile/AgentDocEditor";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";
import { TOKEN_KEY } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { fetchAgentProfile, saveUserPreferences, updateAgentProfile, uploadAgentAvatar } from "@agent/shared";
import type { AgentProfileDetail, SidebarLayoutPref } from "@agent/shared";
import type { SettingsSectionConfig, SettingsSectionGroup, SettingsSectionId } from "@/types/settings";

export const SETTINGS_SECTIONS: SettingsSectionConfig[] = [
  { id: "account", label: "账户", description: "账号资料、安全和登录状态。", group: "account", icon: User },
  { id: "general", label: "通用", description: "界面、语言、声音和基础偏好。", group: "account", icon: Settings2 },
  { id: "personalization", label: "个性化", description: "侧边栏、会话列表和界面偏好。", group: "account", icon: Palette },
  { id: "memory", label: "记忆", description: "查看和编辑 Agent 长期记忆（MEMORY.md）。", group: "features", icon: Brain },
  { id: "cron", label: "定时任务", description: "创建和管理个人自动化任务。", group: "features", icon: Clock },
  { id: "files", label: "文件", description: "浏览个人工作区文件和预览内容。", group: "features", icon: EntityIcons.files },
  { id: "data", label: "回收站", description: "查看已删除会话，必要时进行恢复或彻底清理。", group: "features", icon: EntityIcons.trash },
];

const GROUP_LABELS: Record<SettingsSectionGroup, string> = {
  account: "账户",
  features: "功能",
};

const SETTINGS_NAV_ITEM_SELECTED =
  "relative bg-brand-accent-soft text-foreground font-semibold " +
  "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 " +
  "before:h-5 before:w-[3px] before:rounded-r-full before:bg-brand-accent";
const SETTINGS_NAV_ITEM_UNSELECTED =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground";
const RUN_SHELL_APPROVAL_STORAGE_PREFIX = "agentChat.autoApproveRunShell.";

function canAccess(section: SettingsSectionConfig, isAdmin: boolean, isPlatformAdmin: boolean) {
  if (section.platformAdminOnly) return isPlatformAdmin;
  if (section.adminOnly) return isAdmin;
  return true;
}

function initials(name?: string) {
  return (name || "U").trim().slice(0, 1).toUpperCase();
}

interface DwsConnectionView {
  profileId: string;
  profileName: string | null;
  corpName: string | null;
  dingtalkUserName: string | null;
  status: "pending" | "connected" | "error" | "disconnected";
  authenticated: boolean | null;
  refreshTokenValid: boolean | null;
  refreshExpiresAt: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  message: string;
}

interface DwsAuthSessionView {
  sessionId: string;
  status: "starting" | "awaiting_user" | "connected" | "failed" | "expired";
  authorizationUrl: string | null;
  userCode: string | null;
  expiresAt: string;
  message: string;
}

function DwsConnectionsSection() {
  const { user } = useAuth();
  const [connections, setConnections] = useState<DwsConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authSession, setAuthSession] = useState<DwsAuthSessionView | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authServiceAvailable, setAuthServiceAvailable] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const authorizationPopupRef = useRef<Window | null>(null);
  const openedAuthorizationUrlRef = useRef<string | null>(null);
  const completedSessionRef = useRef<string | null>(null);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/dws/connections");
      const data = await response.json().catch(() => ({})) as { connections?: DwsConnectionView[]; error?: string };
      if (!response.ok) throw new Error(data.error || "钉钉连接状态读取失败");
      setConnections(data.connections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "钉钉连接状态读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAuthSession = useCallback(async () => {
    const response = await authFetch("/api/dws/auth/session");
    const data = await response.json().catch(() => ({})) as { session?: DwsAuthSessionView | null; error?: string };
    if (response.status === 503) setAuthServiceAvailable(false);
    if (!response.ok) throw new Error(data.error || "钉钉授权状态读取失败");
    setAuthServiceAvailable(true);
    setAuthSession(data.session ?? null);
    return data.session ?? null;
  }, []);

  const openAuthorizationPage = useCallback((url: string) => {
    const existing = authorizationPopupRef.current;
    const popup = existing && !existing.closed ? existing : window.open("", "_blank");
    if (!popup) {
      setPopupBlocked(true);
      return;
    }
    popup.opener = null;
    popup.location.href = url;
    authorizationPopupRef.current = popup;
    openedAuthorizationUrlRef.current = url;
    setPopupBlocked(false);
  }, []);

  const startConnection = useCallback(async () => {
    if (authServiceAvailable === false) return;
    setConnecting(true);
    setAuthError(null);
    setPopupBlocked(false);
    openedAuthorizationUrlRef.current = null;

    const popup = window.open("", "_blank");
    if (popup) {
      popup.opener = null;
      popup.document.title = "正在连接钉钉";
      popup.document.body.textContent = "正在打开钉钉官方授权页面…";
      authorizationPopupRef.current = popup;
    } else {
      authorizationPopupRef.current = null;
      setPopupBlocked(true);
    }

    try {
      const response = await authFetch("/api/dws/auth/session", { method: "POST" });
      const data = await response.json().catch(() => ({})) as { session?: DwsAuthSessionView; error?: string };
      if (response.status === 503) setAuthServiceAvailable(false);
      if (!response.ok || !data.session) throw new Error(data.error || "钉钉授权启动失败，请稍后重试");
      setAuthServiceAvailable(true);
      setAuthSession(data.session);
      if (data.session.authorizationUrl) openAuthorizationPage(data.session.authorizationUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "钉钉授权启动失败，请稍后重试";
      setAuthError(message);
      if (popup && !popup.closed) popup.close();
    } finally {
      setConnecting(false);
    }
  }, [authServiceAvailable, openAuthorizationPage]);

  useEffect(() => {
    setAuthSession(null);
    setAuthError(null);
    void Promise.all([
      loadConnections(),
      loadAuthSession().catch((err) => setAuthError(err instanceof Error ? err.message : "钉钉授权状态读取失败")),
    ]);
  }, [loadAuthSession, loadConnections, user?.id]);

  useEffect(() => {
    if (authSession?.status !== "starting" && authSession?.status !== "awaiting_user") return;
    const timer = window.setInterval(() => {
      void loadAuthSession().catch((err) => setAuthError(err instanceof Error ? err.message : "钉钉授权状态读取失败"));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [authSession?.status, loadAuthSession]);

  useEffect(() => {
    const url = authSession?.authorizationUrl;
    if (authSession?.status === "awaiting_user" && url) {
      const popup = authorizationPopupRef.current;
      if (!popup || popup.closed) setPopupBlocked(true);
      else if (openedAuthorizationUrlRef.current !== url) openAuthorizationPage(url);
    }
    if (authSession?.status === "connected" && completedSessionRef.current !== authSession.sessionId) {
      completedSessionRef.current = authSession.sessionId;
      void loadConnections();
    }
  }, [authSession, loadConnections, openAuthorizationPage]);

  const authInProgress = authSession?.status === "starting" || authSession?.status === "awaiting_user";
  const authServiceUnavailable = authServiceAvailable === false;
  const needsReconnect = connections.some((connection) => connection.status === "disconnected");
  const connectLabel = authServiceUnavailable
    ? "服务暂不可用"
    : authInProgress || connecting
      ? "等待授权"
      : needsReconnect
        ? "重新连接"
        : connections.length > 0
          ? "连接其他组织"
          : "连接钉钉";

  return (
    <section className="space-y-3 rounded-2xl border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
            <Building2 className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">钉钉连接</div>
            <div className="text-sm text-muted-foreground">连接一次后，开开会自动维持登录，无需定期重新授权。</div>
          </div>
        </div>
        <Button
          className="shrink-0"
          size="sm"
          onClick={() => void startConnection()}
          disabled={authServiceUnavailable || authInProgress || connecting}
        >
          {(authInProgress || connecting) ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {connectLabel}
        </Button>
      </div>

      {authError ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{authError}</span>
        </div>
      ) : null}

      {authSession?.status === "starting" ? (
        <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-3 text-sm text-blue-800">
          <Loader2 className="h-4 w-4 animate-spin" />正在生成钉钉官方授权页面
        </div>
      ) : authSession?.status === "awaiting_user" ? (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-900">
          <div className="font-medium">请在钉钉页面选择组织并同意授权</div>
          <div className="mt-1 text-xs text-blue-800">授权码：{authSession.userCode || "正在读取"}</div>
          {(popupBlocked || !authorizationPopupRef.current) && authSession.authorizationUrl ? (
            <Button className="mt-3" size="sm" variant="outline" onClick={() => openAuthorizationPage(authSession.authorizationUrl!)}>
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />打开钉钉授权页面
            </Button>
          ) : null}
        </div>
      ) : authSession?.status === "connected" ? (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
          <CircleCheck className="h-4 w-4" />钉钉连接成功，开开现在可以直接使用钉钉能力
        </div>
      ) : authSession?.status === "failed" || authSession?.status === "expired" ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{authSession.message}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />正在读取连接状态
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}，不影响已经保存的钉钉授权。</span>
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-xl bg-muted/50 px-3 py-3 text-sm">
          <div className="font-medium">尚未连接钉钉</div>
          <div className="mt-1 text-muted-foreground">点击“连接钉钉”，在钉钉官方页面确认一次即可。</div>
        </div>
      ) : (
        <div className="space-y-2">
          {connections.map((connection) => {
            const connected = connection.status === "connected";
            const pending = connection.status === "pending";
            return (
              <div key={connection.profileId} className="flex items-start justify-between gap-4 rounded-xl border px-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{connection.corpName || connection.profileName || "钉钉组织"}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {connection.dingtalkUserName ? `${connection.dingtalkUserName} · ` : ""}{connection.message}
                  </div>
                  {connection.lastCheckedAt ? (
                    <div className="mt-1 text-[11px] text-muted-foreground">最近检查：{formatDwsConnectionTime(connection.lastCheckedAt)}</div>
                  ) : null}
                </div>
                <div className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
                  connected && "bg-emerald-50 text-emerald-700",
                  pending && "bg-blue-50 text-blue-700",
                  connection.status === "error" && "bg-amber-50 text-amber-800",
                  connection.status === "disconnected" && "bg-red-50 text-red-700",
                )}>
                  {connected ? <CircleCheck className="h-3.5 w-3.5" /> : pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TriangleAlert className="h-3.5 w-3.5" />}
                  {connected ? "已连接" : pending ? "检测中" : connection.status === "error" ? "重试中" : "需重连"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatDwsConnectionTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}


function SidebarLayoutPreference({
  value,
  onChange,
}: {
  value: SidebarLayoutPref;
  onChange?: (layout: SidebarLayoutPref) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium text-foreground">桌面侧边栏样式</div>
        <div className="mt-1 text-sm text-muted-foreground">选择桌面 Web 端的会话导航布局，移动端不受影响。</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          { id: "double" as const, title: "双栏侧边栏", desc: "保留当前样式：左侧分组，右侧会话列表。" },
          { id: "single" as const, title: "单栏会话列表", desc: "在新建会话下方按最新时间混排会话与分组。" },
        ].map((item) => {
          const active = value === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={cn(
                "rounded-xl border p-3 text-left transition-colors",
                active ? "border-primary bg-primary/5 text-foreground" : "border-border hover:bg-muted/60",
              )}
              onClick={() => onChange?.(item.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{item.title}</span>
                {active && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">当前</span>}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SessionListAvatarPreference({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">会话列表显示头像</div>
        <div className="mt-1 text-sm text-muted-foreground">开启后会话列表显示 Agent 头像；关闭时使用更紧凑的单行样式。</div>
      </div>
      <Switch
        checked={value}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label="会话列表显示头像"
      />
    </div>
  );
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
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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

function GeneralSection() {
  // 授权模式对所有用户开放（2026-07-02 起），每个用户自行切换。
  const { user, updatePreferences } = useAuth();
  const authorizationModeEnabled = user?.preferences?.authorizationModeEnabled === true;
  const [draftAuthorizationMode, setDraftAuthorizationMode] = useState(authorizationModeEnabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraftAuthorizationMode(authorizationModeEnabled);
    setSaved(false);
  }, [authorizationModeEnabled]);

  const handleSave = useCallback(async () => {
    const next = { authorizationModeEnabled: draftAuthorizationMode };
    setSaving(true);
    setSaved(false);
    updatePreferences(next);
    if (!draftAuthorizationMode) clearRunShellApprovalStorage();
    try {
      const savedPreferences = await saveUserPreferences(next);
      if (!savedPreferences) throw new Error("保存失败");
      updatePreferences(savedPreferences);
      if (savedPreferences.authorizationModeEnabled !== true) clearRunShellApprovalStorage();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      updatePreferences({ authorizationModeEnabled });
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [authorizationModeEnabled, draftAuthorizationMode, updatePreferences]);

  return (
    <PlaceholderSection
      title="通用"
      description="管理界面显示、语言、声音与常用交互偏好。"
      actions={(
        <>
          {saved && <span className="text-sm text-success">已保存</span>}
          <Button onClick={() => { void handleSave(); }} disabled={saving || draftAuthorizationMode === authorizationModeEnabled}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            保存
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">授权模式</div>
            <div className="mt-1 text-sm leading-6 text-muted-foreground">
              开启后所有会话默认自动批准工具授权，输入框不再显示授权开关；需要你回答的问题仍会暂停等待。
            </div>
          </div>
          <Switch
            checked={draftAuthorizationMode}
            disabled={saving}
            onCheckedChange={(checked) => {
              setDraftAuthorizationMode(checked);
              setSaved(false);
            }}
            aria-label="授权模式"
          />
        </div>
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
  // 人格定义 进入后接管整个账户面板（类似 settings/memory 那样的全屏 layout）
  const [personaEditing, setPersonaEditing] = useState(false);

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

  if (personaEditing && user?.username) {
    return (
      <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
        <AgentDocEditor
          username={user.username}
          kind="persona"
          headerTitle="人格定义"
          headerDescription="定义你的 Agent 的人格和行为风格，新会话生效。"
          onBack={() => setPersonaEditing(false)}
        />
      </div>
    );
  }

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
                  className="flex h-20 w-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-brand-600 text-2xl font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => user?.avatar && setAvatarPreviewOpen(true)}
                  aria-label="预览头像大图"
                >
                  {user?.avatar ? <img src={user.avatar} alt="用户头像" className="h-full w-full object-cover" /> : initials(displayName)}
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
          {showAgentSettings && <AgentAccountSection onOpenPersona={() => setPersonaEditing(true)} />}
          <DwsConnectionsSection />
          <section className="space-y-3 rounded-2xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold">修改密码</div>
              <div className="text-sm text-muted-foreground">定期更新密码，提升账号安全性。</div>
            </div>
            <Button variant="outline" onClick={onChangePassword}><Lock className="mr-2 h-4 w-4" />修改</Button>
          </div>
          <div className="flex items-center justify-between gap-4 border-t pt-3">
            <div>
              <div className="text-sm font-semibold text-destructive">退出登录</div>
              <div className="text-sm text-muted-foreground">退出当前设备上的登录状态。</div>
            </div>
            <Button variant="destructive" onClick={logout}><LogOut className="mr-2 h-4 w-4" />退出</Button>
          </div>
          </section>
        </div>
      </div>
      <Dialog open={avatarPreviewOpen} onOpenChange={setAvatarPreviewOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] border-none bg-transparent p-0 shadow-none sm:max-w-xl">
          <DialogTitle className="sr-only">头像大图预览</DialogTitle>
          {user?.avatar ? <img src={user.avatar} alt="用户头像大图" className="max-h-[80vh] w-full rounded-2xl object-contain shadow-2xl" /> : null}
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
                    <Loader2 className="h-4 w-4 animate-spin" />
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
              {savingPhone ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {draftPhone.trim() === "" ? "清除手机号" : "完成验证"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface AgentAccountSectionProps {
  /** 点击「人格定义 → 编辑」时通知上层接管整个面板渲染 persona 编辑器。 */
  onOpenPersona: () => void;
}

function AgentAccountSection({ onOpenPersona }: AgentAccountSectionProps) {
  const { user } = useAuth();
  const username = user?.username;
  const [profile, setProfile] = useState<AgentProfileDetail | null>(null);
  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [loading, setLoading] = useState(false);
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false);
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
        <Loader2 className="h-5 w-5 animate-spin" />
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
              <Button size="sm" variant="outline" className="min-w-20 justify-self-end" onClick={onOpenPersona}>编辑</Button>
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
              {savingField ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface SettingsModalProps {
  open: boolean;
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onClose: () => void;
  renderMemory?: () => ReactNode;
  renderCron?: () => ReactNode;
  renderFiles?: () => ReactNode;
  renderTrash?: () => ReactNode;
  sidebarLayout?: SidebarLayoutPref;
  onSidebarLayoutChange?: (layout: SidebarLayoutPref) => void;
  /** false 时隐藏只服务个人通用 Agent 的设置；管理员调用方应传 true。 */
  personalAgentEnabled?: boolean;
}

export function SettingsModal({
  open,
  section,
  onSectionChange,
  onClose,
  renderMemory,
  renderCron,
  renderFiles,
  renderTrash,
  sidebarLayout = "double",
  onSidebarLayoutChange,
  personalAgentEnabled = true,
}: SettingsModalProps) {
  const { user, isAdmin, isPlatformAdmin, updateAvatar, updatePreferences } = useAuth();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [draftSidebarLayout, setDraftSidebarLayout] = useState<SidebarLayoutPref>(sidebarLayout);
  const showSessionListAvatar = user?.preferences?.showSessionListAvatar === true;
  const [draftShowSessionListAvatar, setDraftShowSessionListAvatar] = useState(showSessionListAvatar);
  const [personalizationSaving, setPersonalizationSaving] = useState(false);
  const [personalizationSaved, setPersonalizationSaved] = useState(false);
  const [, startSectionTransition] = useTransition();

  const handleSectionChange = useCallback((id: SettingsSectionId) => {
    startSectionTransition(() => onSectionChange(id));
  }, [onSectionChange]);

  const visibleSections = useMemo(
    () => SETTINGS_SECTIONS.filter((item) => {
      if (!canAccess(item, isAdmin, isPlatformAdmin)) return false;
      if (personalAgentEnabled) return true;
      return item.id !== "memory";
    }),
    [isAdmin, isPlatformAdmin, personalAgentEnabled],
  );

  useEffect(() => {
    if (open) {
      setDraftSidebarLayout(sidebarLayout);
      setDraftShowSessionListAvatar(showSessionListAvatar);
      setPersonalizationSaved(false);
    }
  }, [open, sidebarLayout, showSessionListAvatar]);

  useEffect(() => {
    if (!open) return;
    if (!visibleSections.some(item => item.id === section)) {
      onSectionChange("account");
    }
  }, [open, section, visibleSections, onSectionChange]);

  // mount-once-visited：访问过的 section 保留在 DOM 中，避免切换时 panel
  // unmount/mount + 重新拉数据导致的"刷新"闪烁。modal 关闭时整体 unmount，
  // visited 跟着重置。
  const [visited, setVisited] = useState<Set<SettingsSectionId>>(() => new Set([section]));
  useEffect(() => {
    if (!open) return;
    setVisited(prev => (prev.has(section) ? prev : new Set(prev).add(section)));
  }, [open, section]);

  const personalizationDirty =
    draftSidebarLayout !== sidebarLayout ||
    draftShowSessionListAvatar !== showSessionListAvatar;

  const handleSavePersonalization = useCallback(async () => {
    setPersonalizationSaving(true);
    setPersonalizationSaved(false);
    try {
      if (draftSidebarLayout !== sidebarLayout) {
        onSidebarLayoutChange?.(draftSidebarLayout);
      }
      if (draftShowSessionListAvatar !== showSessionListAvatar) {
        const next = { showSessionListAvatar: draftShowSessionListAvatar };
        updatePreferences(next);
        const saved = await saveUserPreferences(next);
        if (!saved) {
          updatePreferences({ showSessionListAvatar });
          throw new Error("保存失败");
        }
        updatePreferences(saved);
      }
      setPersonalizationSaved(true);
      window.setTimeout(() => setPersonalizationSaved(false), 2000);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setPersonalizationSaving(false);
    }
  }, [draftSidebarLayout, sidebarLayout, onSidebarLayoutChange, draftShowSessionListAvatar, showSessionListAvatar, updatePreferences]);

  const handleAvatarUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("avatar", file);
    setAvatarUploading(true);
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch("/api/auth/avatar", {
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
  const grouped = (["account", "features"] as const).map(group => ({
    group,
    items: visibleSections.filter(item => item.group === group),
  })).filter(group => group.items.length > 0);

  // mount-once-visited：每个 section 用 hidden 切换可见性，访问过就留在 DOM。
  // 避免「切到 cron→useCronJobs 拉数据→渲染→切回→再次重置→再拉数据」式闪烁。
  // visited.has(id) 守门，未访问过的 section 不预先 mount，避免一打开 modal 就
  // 把所有 panel 的数据请求一齐发出。
  const sectionsToRender: { id: SettingsSectionId; node: ReactNode }[] = [
    {
      id: "account",
      node: <AccountSection avatarInputRef={avatarInputRef} avatarUploading={avatarUploading} onAvatarUpload={handleAvatarUpload} onChangePassword={() => setShowPasswordDialog(true)} showAgentSettings={personalAgentEnabled} />,
    },
    {
      id: "general",
      node: <GeneralSection />,
    },
    {
      id: "personalization",
      node: (
        <PlaceholderSection
          title="个性化"
          description="配置侧边栏、会话列表和其他界面偏好。"
          actions={(
            <>
              {personalizationSaved && <span className="text-sm text-success">已保存</span>}
              <Button onClick={() => { void handleSavePersonalization(); }} disabled={personalizationSaving || !personalizationDirty}>
                {personalizationSaving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                保存
              </Button>
            </>
          )}
        >
          <div className="space-y-6">
            <SidebarLayoutPreference value={draftSidebarLayout} onChange={(next) => { setDraftSidebarLayout(next); setPersonalizationSaved(false); }} />
            <SessionListAvatarPreference value={draftShowSessionListAvatar} disabled={personalizationSaving} onChange={(next) => { setDraftShowSessionListAvatar(next); setPersonalizationSaved(false); }} />
          </div>
        </PlaceholderSection>
      ),
    },
    { id: "memory", node: renderMemory?.() ?? null },
    { id: "cron", node: renderCron?.() ?? null },
    { id: "files", node: renderFiles?.() ?? null },
    {
      id: "data",
      node: <PlaceholderSection title="回收站" description="查看已删除会话，必要时进行恢复或彻底清理。">{renderTrash?.()}</PlaceholderSection>,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="设置" onClick={onClose}>
      <div className="flex h-[min(920px,calc(100vh-96px))] w-[min(1184px,calc(100vw-64px))] overflow-hidden rounded-3xl border bg-background shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <aside className="flex w-40 shrink-0 flex-col border-r bg-muted/20 p-3">
          <div className="mb-4 flex items-center gap-2.5 px-1">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-600 text-sm font-semibold text-white">
              {user?.avatar ? <img src={user.avatar} alt="" className="h-full w-full object-cover" /> : initials(user?.realName || user?.username)}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{user?.realName || user?.username || "未登录"}</div>
              <div className="truncate text-xs text-muted-foreground">个人</div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {grouped.map(group => (
              <div key={group.group} className="mb-4">
                <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">{GROUP_LABELS[group.group]}</div>
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
                        onClick={() => handleSectionChange(item.id)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t pt-3">
            <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <Settings2 className="h-4 w-4" />
              获取帮助
            </button>
          </div>
        </aside>
        <main className="relative flex min-w-0 flex-1 flex-col">
          <button type="button" className="absolute right-5 top-5 z-30 rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} aria-label="关闭设置">
            <X className="h-5 w-5" />
          </button>
          <div className="min-h-0 flex-1 overflow-hidden p-8 pb-4 pt-5">
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
