import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { buildPlatformAdminUrl, pushPlatformAdminUrl, type PlatformAdminSection } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

export type EntityKind = "tenant" | "user" | "session" | "run" | "sandbox";

const ENTITY_SECTION: Record<EntityKind, PlatformAdminSection> = {
  tenant: "tenants",
  user: "users",
  session: "sessions",
  run: "runs",
  sandbox: "sandboxes",
};

function shortId(value: string, len: number) {
  if (value.length <= len * 2 + 1) return value;
  return `${value.slice(0, len)}…${value.slice(-len)}`;
}

export function EntityLink({
  kind,
  id,
  label,
  tenantId,
  className,
  short = 8,
  plain = false,
}: {
  kind: EntityKind;
  id: string | null | undefined;
  label?: string | null;
  tenantId?: string | null;
  className?: string;
  short?: number;
  /** 纯文本模式：不渲染 platform-admin 跳转链接（租户上下文使用），保留复制按钮 */
  plain?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const section = ENTITY_SECTION[kind];
  const href = id ? buildPlatformAdminUrl({ section, entityId: id }) : undefined;
  const text = label || (id ? shortId(id, short) : "—");

  const onNavigate = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!id) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pushPlatformAdminUrl({ section, entityId: id });
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [id, section]);

  const onCopy = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!id) return;
    void navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [id]);

  if (!id) return <span className={cn("text-muted-foreground", className)}>—</span>;

  return (
    <span className={cn("group inline-flex max-w-full items-center gap-1 align-middle", className)} title={tenantId ? `${id} · ${tenantId}` : id}>
      {plain ? (
        <span className={cn("min-w-0 truncate px-1 text-xs", !label && "font-mono")}>{text}</span>
      ) : (
      <a
        href={href}
        onClick={onNavigate}
        className={cn(
          "min-w-0 truncate rounded px-1 text-xs text-primary hover:bg-primary/10 hover:underline",
          !label && "font-mono",
        )}
      >
        {text}
      </a>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={onCopy}
        aria-label={`复制 ${id}`}
      >
        {copied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
      </Button>
    </span>
  );
}
