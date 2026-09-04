import { Fragment } from 'react';
import { getSessionAutomationBadge } from '@/lib/sessionAutomation';

export default function SessionAutomationBadge({ session, compact = false, separator = false }: { session: unknown; compact?: boolean; separator?: boolean }) {
  const label = getSessionAutomationBadge(session);
  if (!label) return null;
  const badge = compact ? (
    <span className="max-w-32 shrink-0 truncate rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title={label}>{label}</span>
  ) : (
    <span className="max-w-40 shrink-0 truncate font-medium text-primary" title={label}>{label}</span>
  );
  return <Fragment>{badge}{separator && <span>·</span>}</Fragment>;
}
