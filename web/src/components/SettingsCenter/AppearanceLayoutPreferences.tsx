import type { SidebarLayoutPref } from "@agent/shared";
import { FontSizeToggle } from "@/components/FontSizeToggle";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface AppearanceLayoutPreferencesProps {
  chatFontLarge: boolean;
  onChatFontSizeChange: (large: boolean) => void;
  sidebarLayout: SidebarLayoutPref;
  onSidebarLayoutChange?: (layout: SidebarLayoutPref) => void;
  showSessionListAvatar: boolean;
  onShowSessionListAvatarChange: (value: boolean) => void;
  avatarSaving?: boolean;
}

export function AppearanceLayoutPreferences({
  chatFontLarge,
  onChatFontSizeChange,
  sidebarLayout,
  onSidebarLayoutChange,
  showSessionListAvatar,
  onShowSessionListAvatarChange,
  avatarSaving,
}: AppearanceLayoutPreferencesProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">会话字体大小</div>
          <div className="mt-1 text-sm text-muted-foreground">调整会话消息正文的显示字号。</div>
        </div>
        <FontSizeToggle isLarge={chatFontLarge} onChange={onChatFontSizeChange} />
      </div>

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
            const active = sidebarLayout === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors",
                  active ? "border-primary bg-primary/5 text-foreground" : "border-border hover:bg-muted/60",
                )}
                onClick={() => onSidebarLayoutChange?.(item.id)}
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

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">会话列表显示头像</div>
          <div className="mt-1 text-sm text-muted-foreground">开启后会话列表显示 Agent 头像；关闭时使用更紧凑的单行样式。</div>
        </div>
        <Switch
          checked={showSessionListAvatar}
          disabled={avatarSaving}
          onCheckedChange={onShowSessionListAvatarChange}
          aria-label="会话列表显示头像"
        />
      </div>
    </div>
  );
}
