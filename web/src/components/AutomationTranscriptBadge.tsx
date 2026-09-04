import { getAutomationTranscriptLabel } from '@/lib/sessionAutomation';

export default function AutomationTranscriptBadge({ message }: { message: unknown }) {
  const label = getAutomationTranscriptLabel(message);
  if (!label) return null;
  return (
    <span className="mb-1.5 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
      {label}
    </span>
  );
}
