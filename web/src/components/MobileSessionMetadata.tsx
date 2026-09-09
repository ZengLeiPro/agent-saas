import type { ChatSessionIndexItem } from '@/types/sidebar';
import { sourceDisplayText } from '@/types/sidebar';
import { sessionAgentTargetPresentation } from '@/lib/sessionAgentTargetIdentity';

export function MobileSessionMetadata({
  session,
  isAdmin,
}: {
  session: ChatSessionIndexItem;
  isAdmin: boolean;
}) {
  const identity = sessionAgentTargetPresentation(session);
  const agentLabel = session.agentTarget?.kind === 'personal' && !identity.unavailableReason
    ? null
    : identity.label;

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
