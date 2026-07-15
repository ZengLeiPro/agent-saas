import { cn } from "@/lib/utils";
import { agentAvatarUrl } from "@/lib/apiBase";

/**
 * 企业专家头像内容（三态）：
 *   - avatar 为 `org-agent-avatars/` 图片路径 → 渲染上传的图片
 *   - avatar 为用户自选 emoji（非 "🤖" 哨兵值）→ 渲染 emoji 文本
 *   - 空值 / "🤖" → 品牌默认头像「开开」
 *
 * 只输出内容，不带容器：外层容器负责尺寸/圆角/底色，图片态需要外层
 * 配 overflow-hidden（本组件 img 会以 h-full w-full object-cover 撑满）。
 */
export function OrgAgentAvatarContent({
  agent,
  className,
}: {
  agent: { id: string; avatar?: string; avatarVersion?: number };
  className?: string;
}) {
  const { id, avatar, avatarVersion } = agent;
  if (avatar && avatar.startsWith("org-agent-avatars/")) {
    const url = agentAvatarUrl(`org-agent:${id}`, avatar, avatarVersion);
    return <img src={url!} alt="" className={cn("h-full w-full object-cover", className)} />;
  }
  if (avatar && avatar !== "🤖") {
    return <>{avatar}</>;
  }
  return <img src="/kaikai-avatar.png" alt="" className={cn("h-full w-full object-cover", className)} />;
}
