import type { ChatSessionIndexItem } from '@/types/sidebar';
import { sourceDisplayText } from '@/types/sidebar';

export function MobileSessionMetadata({
  session,
  isAdmin,
}: {
  session: ChatSessionIndexItem;
  isAdmin: boolean;
}) {
  const agentLabel = !session.agentTarget
    ? '绑定不可验证'
    : session.agentTarget.kind === 'org-agent'
      ? session.orgAgentName || '企业专家'
      : null;

  return (
    <div className="mt-1 text-xs text-muted-foreground/60">
      <span>{sourceDisplayText(session.source)}</span>
      {agentLabel && <span> · {agentLabel}</span>}
      {isAdmin && session.owner && (
        <span> - {session.owner.realName || session.owner.username}</span>
      )}
    </div>
  );
}
