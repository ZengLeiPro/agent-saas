interface RuntimeFailureActionProps {
  recoveryAction?: 'switch_model';
  onRetry?: () => void;
  onSwitchModel?: () => void;
  isLoading?: boolean;
}

const actionClassName = 'shrink-0 rounded-md px-2 py-1 font-medium text-foreground/75 transition-colors hover:bg-foreground/[0.06] hover:text-foreground';

export function RuntimeFailureAction({
  recoveryAction,
  onRetry,
  onSwitchModel,
  isLoading,
}: RuntimeFailureActionProps) {
  if (isLoading) return null;
  if (recoveryAction === 'switch_model' && onSwitchModel) {
    return <button type="button" onClick={onSwitchModel} className={actionClassName}>切换模型</button>;
  }
  if (onRetry) {
    return <button type="button" onClick={onRetry} className={actionClassName}>继续生成</button>;
  }
  return null;
}
