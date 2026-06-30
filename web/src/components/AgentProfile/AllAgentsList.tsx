import { useEffect, useState } from "react";
import {
  fetchAllAgentProfiles,
  isEmojiAvatar,
  getAgentAvatarUrl,
  reportActivity,
} from "@agent/shared";
import type { AgentProfile as AgentProfileType } from "@agent/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

interface AllAgentsListProps {
  /** admin 点击列表项时触发，由上层负责切到「我的 Agent」section 并定位到该用户 */
  onEditUser?: (username: string) => void;
}

/**
 * 所有 Agent 列表（独立视图）。
 *
 * 与 AgentProfile（编辑器）完全解耦：
 * - 自己拉取 profiles 列表
 * - 自带 SettingsPanelHeader
 * - admin 点击列表项 → 通过 onEditUser 回调上抛，由上层负责切换 section/URL
 */
export function AllAgentsList({ onEditUser }: AllAgentsListProps = {}) {
  const { user, isAdmin } = useAuth();
  const [profiles, setProfiles] = useState<AgentProfileType[]>([]);
  const [listAvatarPreview, setListAvatarPreview] = useState<AgentProfileType | null>(null);

  useEffect(() => {
    fetchAllAgentProfiles().then(setProfiles).catch(() => {});
    reportActivity("agent_profile_viewed", { detail: "所有 Agent" });
  }, []);

  if (!user) return null;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="所有 Agent"
        description="浏览所有用户的 Agent 资料。"
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid gap-3 sm:grid-cols-2">
        {profiles.map((p) => {
          const avatarEl = !isEmojiAvatar(p.avatar) ? (
            <div
              className="shrink-0 cursor-pointer transition-opacity hover:opacity-80"
              onClick={(e) => { e.stopPropagation(); setListAvatarPreview(p); }}
            >
              <AgentAvatar avatar={p.avatar} username={p.username} size="md" version={p.avatarVersion} />
            </div>
          ) : (
            <AgentAvatar avatar={p.avatar} username={p.username} size="md" version={p.avatarVersion} />
          );

          const clickable = isAdmin && !!onEditUser;

          return (
            <div
              key={p.username}
              className={cn(
                "flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors",
                clickable && "cursor-pointer hover:bg-muted/50",
              )}
              onClick={clickable ? () => onEditUser!(p.username) : undefined}
            >
              {avatarEl}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{p.realName || p.username} 的 Agent</span>
                </div>
                {p.signature && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground/60">
                    {p.signature}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        </div>
      </div>
      {/* 列表头像预览 lightbox */}
      {listAvatarPreview && !isEmojiAvatar(listAvatarPreview.avatar) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setListAvatarPreview(null)}
        >
          <img
            src={getAgentAvatarUrl(listAvatarPreview.username, listAvatarPreview.avatar, undefined, listAvatarPreview.avatarVersion)!}
            alt="Avatar"
            className="max-h-[80vh] max-w-[80vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
