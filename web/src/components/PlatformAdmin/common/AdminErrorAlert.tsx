import { classifyLoadError, type FriendlyError } from "../errorText";

export function AdminErrorAlert({ error, title }: { error: unknown; title?: string }) {
  const friendly: FriendlyError = classifyLoadError(error);
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div className="font-medium">{title ?? friendly.summary}</div>
      {friendly.suggestion && <div className="mt-0.5 text-xs text-destructive/80">{friendly.suggestion}</div>}
      {friendly.technicalDetail && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer select-none">技术详情</summary>
          <div className="mt-1 whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-foreground">
            {friendly.technicalDetail}
          </div>
        </details>
      )}
    </div>
  );
}
