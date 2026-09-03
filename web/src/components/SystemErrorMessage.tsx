import { Ban } from 'lucide-react';
import { selectErrorPresentation, selectRenderModel } from '@agent/shared';
import type { MessageItem } from './types';
import { cn } from '@/lib/utils';
import { requestOpenBillingBadge } from '@/lib/billingBadgeBus';

type SystemErrorItem = Extract<MessageItem, { type: 'system-error' }>;

interface SystemErrorMessageProps {
  message: SystemErrorItem;
  isLoading?: boolean;
  rawPresentationMode: boolean;
  onRetry?: (message: MessageItem) => void;
  onSwitchModel?: () => void;
}

export function SystemErrorMessage({
  message,
  isLoading,
  rawPresentationMode,
  onRetry,
  onSwitchModel,
}: SystemErrorMessageProps) {
  const item = selectRenderModel({ messages: [message] }).items[0];
  const presentation = selectErrorPresentation(
    item,
    rawPresentationMode ? { explicitSessionToggle: true } : undefined,
  );
  const recovery = presentation.recoveryAction;
  // Typed recovery actions must never fall through to blind retry.
  const recoveryHandler = recovery?.kind === 'view_billing'
    ? requestOpenBillingBadge
    : recovery?.kind === 'switch_model'
      ? onSwitchModel
      : recovery?.kind === 'retry' && onRetry
        ? () => onRetry(message)
        : undefined;

  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 text-sm shadow-sm',
        presentation.tone === 'danger'
          ? 'border-destructive/25 bg-destructive/5 text-foreground'
          : 'border-border bg-muted/30 text-muted-foreground',
      )}
      role={presentation.tone === 'danger' ? 'alert' : 'status'}
      aria-label={[presentation.title, presentation.statusLabel, presentation.summary, recovery?.label].filter(Boolean).join('，')}
    >
      <div className="flex items-start gap-3">
        <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{presentation.title}</div>
          <div className="mt-1 whitespace-pre-wrap break-words">{presentation.summary ?? presentation.statusLabel}</div>
          {presentation.showRaw && presentation.summary !== message.content && (
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">{message.content}</pre>
          )}
          {!isLoading && recovery && recoveryHandler && (
            <button
              type="button"
              onClick={recoveryHandler}
              className="mt-2 min-h-11 rounded-md px-3 text-xs font-medium ring-1 ring-border transition-colors hover:bg-muted"
              aria-label={`${presentation.title}，${recovery.label}`}
            >
              {recovery.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
