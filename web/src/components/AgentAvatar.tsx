import { useState } from "react";
import { cn } from "@/lib/utils";
import { isEmojiAvatar, getAgentAvatarUrl } from "@agent/shared";
import { User } from "lucide-react";

const SIZE_MAP = { sm: 24, md: 40, lg: 64 } as const;

interface AgentAvatarProps {
  avatar?: string;
  username?: string;
  size?: keyof typeof SIZE_MAP | number;
  className?: string;
  version?: number;
}

/** 空值与旧的 "🤖" 哨兵值统一渲染品牌默认头像「开开」 */
const DEFAULT_AVATAR_SENTINEL = "🤖";
const DEFAULT_AVATAR_SRC = "/kaikai-avatar.png";

export function AgentAvatar({ avatar, username, size = "md", className, version }: AgentAvatarProps) {
  const px = typeof size === "number" ? size : SIZE_MAP[size];
  const isEmoji = isEmojiAvatar(avatar);

  if (isEmoji) {
    const isDefault = !avatar || avatar === DEFAULT_AVATAR_SENTINEL;
    if (isDefault) {
      return (
        <img
          src={DEFAULT_AVATAR_SRC}
          alt="开开"
          className={cn("rounded-full object-cover shrink-0", className)}
          style={{ width: px, height: px }}
        />
      );
    }
    return (
      <div
        className={cn("flex items-center justify-center rounded-full bg-muted shrink-0", className)}
        style={{ width: px, height: px, fontSize: px * 0.5 }}
      >
        {avatar}
      </div>
    );
  }

  const url = getAgentAvatarUrl(username || "", avatar, undefined, version);
  return (
    <img
      src={url!}
      alt="Agent"
      className={cn("rounded-full object-cover shrink-0", className)}
      style={{ width: px, height: px }}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// User Avatar
// ---------------------------------------------------------------------------

interface UserAvatarProps {
  userId?: string;
  avatar?: string;
  size?: keyof typeof SIZE_MAP | number;
  className?: string;
  version?: number;
}

export function UserAvatar({ userId, avatar, size = "md", className, version }: UserAvatarProps) {
  const px = typeof size === "number" ? size : SIZE_MAP[size];
  const [errored, setErrored] = useState(false);

  const url = (avatar && userId)
    ? `/api/auth/avatar/${userId}${version ? `?v=${version}` : ''}`
    : null;

  if (!url || errored) {
    return (
      <div
        className={cn("flex items-center justify-center rounded-full bg-muted shrink-0", className)}
        style={{ width: px, height: px }}
      >
        <User style={{ width: px * 0.5, height: px * 0.5 }} className="text-muted-foreground" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt="User"
      className={cn("rounded-full object-cover shrink-0", className)}
      style={{ width: px, height: px }}
      onError={() => setErrored(true)}
    />
  );
}
