import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { buildPlatformAdminUrl, pushPlatformAdminUrl, type PlatformAdminSection } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

export type EntityKind = "tenant" | "user" | "session" | "run" | "sandbox" | "workspace";

const ENTITY_SECTION: Record<EntityKind, PlatformAdminSection> = {
  tenant: "tenants",
  user: "users",
  session: "sessions",
  run: "runs",
  sandbox: "sandboxes",
  // 文件目录（workspace）没有独立 section，落到执行环境列表并预置筛选
  workspace: "sandboxes",
};

/**
 * 没有独立详情页、只能以「列表 + 预置筛选」下钻的实体：值是筛选参数名。
 * `workspace` → `sandboxes?workspaceId=…`（`SandboxesPage` 已支持该筛选）。
 */
const ENTITY_SEARCH_PARAM: Partial<Record<EntityKind, string>> = {
  workspace: "workspaceId",
};

function entityTarget(kind: EntityKind, id: string) {
  const section = ENTITY_SECTION[kind];
  const param = ENTITY_SEARCH_PARAM[kind];
  return param ? { section, search: { [param]: id } } : { section, entityId: id };
}

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
  const href = id ? buildPlatformAdminUrl(entityTarget(kind, id)) : undefined;
  const text = label || (id ? shortId(id, short) : "—");

  const onNavigate = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!id) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pushPlatformAdminUrl(entityTarget(kind, id));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [id, kind]);

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
        // group-focus-within 覆盖「链接被键盘聚焦」，focus-visible 覆盖「复制按钮自己被聚焦」。
        // 改造前只有 group-hover，键盘用户永远拿不到复制按钮。
        className="size-5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={onCopy}
        aria-label={`复制 ${id}`}
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </Button>
    </span>
  );
}
