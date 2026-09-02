import type { CardActionViewModel, CardViewModel } from '@agent/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export interface CardViewProps {
  model: CardViewModel;
  onAction?: (action: CardActionViewModel) => void;
  onOptionChange?: (questionId: string, optionId: string) => void;
}

/** Thin Web renderer: semantic state and action availability come exclusively from Shared. */
export function CardView({ model, onAction, onOptionChange }: CardViewProps) {
  const [expanded, setExpanded] = useState(model.accessibility.expanded);
  const expandAction = model.actions.find((action) => action.kind === 'expand');
  const actionLockRef = useRef<string | null>(null);
  const [lockedActionId, setLockedActionId] = useState<string | null>(null);
  useEffect(() => {
    if (model.status === 'failed' || model.status === 'rejected' || model.status === 'expired' || model.status === 'resolved') {
      actionLockRef.current = null;
      setLockedActionId(null);
    }
  }, [model.status]);
  const invokeAction = (action: CardActionViewModel) => {
    if (action.disabled || actionLockRef.current) return;
    actionLockRef.current = action.id;
    setLockedActionId(action.id);
    onAction?.(action);
  };
  return (
    <Card
      className="border-border bg-card text-card-foreground"
      aria-busy={model.accessibility.busy}
      data-card-id={model.id}
      data-card-kind={model.kind}
    >
      <article aria-labelledby={`${model.id}:heading`}>
        <div className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h3 id={`${model.id}:heading`} className="text-sm font-semibold text-foreground">{model.title}</h3>
            {model.subtitle ? <p className="text-xs text-muted-foreground">{model.subtitle}</p> : null}
          </div>
          {expandAction ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={`${model.id}:detail`}
              disabled={expandAction.disabled}
              onClick={() => { setExpanded((value) => !value); onAction?.(expandAction); }}
            >
              {expanded ? '收起' : '展开'}
            </Button>
          ) : null}
        </div>
        <CardContent className="space-y-3 pb-3 pt-0">
          {model.inputSummary ? <p className="text-sm text-muted-foreground">{model.inputSummary}</p> : null}
          {model.outputSummary ? <p className="text-sm text-foreground">{model.outputSummary}</p> : null}
          {expanded && model.detail ? (
            <pre id={`${model.id}:detail`} className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs text-foreground">
              {model.detail.text}
            </pre>
          ) : null}
          {model.questions?.map((question) => (
            <fieldset key={question.id} className="space-y-2" disabled={model.accessibility.disabled}>
              <legend className="text-sm font-medium text-foreground">{question.header || question.label}</legend>
              {question.header && question.label ? <p className="text-sm text-muted-foreground">{question.label}</p> : null}
              <div className="flex flex-wrap gap-2">
                {question.options.map((option) => (
                  <button key={option.id} type="button" aria-label={option.label} disabled={option.disabled} onClick={() => onOptionChange?.(question.id, option.id)} className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50">
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
          {model.actions.some((action) => action.kind !== 'expand' && action.visible) ? (
            <div className="flex flex-wrap gap-2">
              {model.actions.filter((action) => action.kind !== 'expand' && action.visible).map((action) => (
                <Button
                  key={action.id}
                  type="button"
                  size="sm"
                  disabled={action.disabled || lockedActionId !== null}
                  aria-busy={action.busy || lockedActionId === action.id}
                  onClick={() => invokeAction(action)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
          {model.outcome ? (
            <p role="status" aria-live={model.outcome.live} className={model.outcome.status === 'failed' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
              {model.outcome.label}{model.outcome.reason ? `：${model.outcome.reason}` : ''}
            </p>
          ) : null}
        </CardContent>
      </article>
    </Card>
  );
}
