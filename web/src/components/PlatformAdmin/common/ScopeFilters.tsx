import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, RotateCw, Search } from "lucide-react";

import { useTenants } from "@/components/TenantManager/hooks";
import { AdminSelect, type AdminSelectOption } from "@/components/ui/admin-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { UserInfo } from "@/components/UserManager/types";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
import { classifyLoadError } from "../errorText";

/** 一次拉取的上限。到达上限时必须显式告知已截断，并让用户用关键词继续找。 */
const USER_PAGE_SIZE = 50;

export function ScopeFilters({
  tenantId,
  userId,
  onChange,
  className,
}: {
  tenantId: string;
  userId?: string;
  onChange: (values: { tenantId?: string | null; userId?: string | null }) => void;
  className?: string;
}) {
  const { tenants } = useTenants();

  const tenantSelectOptions = useMemo<AdminSelectOption[]>(() => [
    { value: "", label: "全部组织" },
    ...tenants.map((tenant) => ({ value: tenant.id, label: tenant.name })),
  ], [tenants]);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <AdminSelect
        ariaLabel="按组织筛选"
        className="min-w-36"
        options={tenantSelectOptions}
        value={tenantId}
        onValueChange={(value) => onChange({ tenantId: value || null, userId: null })}
      />
      {userId !== undefined && (
        <UserPicker
          tenantId={tenantId}
          userId={userId}
          onChange={(value) => onChange({ userId: value })}
        />
      )}
    </div>
  );
}

/**
 * 用户筛选器。改造前是一个裸的 `AdminSelect`，有两处静默失败：
 * 1. 硬 `limit: 100` —— 超过 100 人的组织，第 101 个人**在 UI 上不存在**，
 *    而界面上没有任何迹象表明列表被截断了。
 * 2. `.catch(() => setUsers([]))` —— 接口挂了会显示成「这个组织没有用户」。
 *
 * 改法：Popover + 服务端搜索（`GET /admin/users` 已支持 `q`，见 `api.ts`）。
 * 加载中 / 出错 / 已截断三种状态各有明确文案，出错时给「重试」而不是假装为空。
 */
function UserPicker({
  tenantId,
  userId,
  onChange,
}: {
  tenantId: string;
  userId: string;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadToken, setReloadToken] = useState(0);
  /** 已选用户的展示名：列表里找不到时（被搜索词过滤掉）回退用它，避免闪回裸 ID */
  const selectedLabelRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void platformAdminApi.users({ tenantId, q: debouncedKeyword || undefined, limit: USER_PAGE_SIZE })
      .then((data) => {
        if (cancelled) return;
        setUsers(data.items);
        // 截断判定：后端给了 nextCursor 就是还有；没给但刚好取满一页也按截断处理
        setTruncated(Boolean(data.nextCursor) || data.items.length >= USER_PAGE_SIZE);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 关键：不再 setUsers([])。「空列表」和「拉取失败」必须可分辨。
        setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedKeyword, reloadToken, tenantId]);

  const userLabel = useCallback(
    (user: UserInfo) => (user.realName ? `${user.realName}（${user.username}）` : user.username),
    [],
  );

  const selected = users.find((user) => user.id === userId);
  if (selected) selectedLabelRef.current = userLabel(selected);
  const triggerText = userId
    ? (selected ? userLabel(selected) : selectedLabelRef.current ?? userId)
    : "全部用户";

  const pick = useCallback((value: string | null) => {
    onChange(value);
    setOpen(false);
  }, [onChange]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="按用户筛选"
          className={cn(
            "flex h-8 min-w-44 max-w-64 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-xs",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            !userId && "text-muted-foreground",
          )}
        >
          <span className="truncate">{triggerText}</span>
          {loading && !open
            ? <Loader2 className="size-3.5 shrink-0 animate-spin opacity-60" />
            : <ChevronDown className="size-3.5 shrink-0 opacity-60" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="relative border-b p-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索用户名 / 姓名 / 用户 ID"
            className="h-8 pl-7 text-xs"
            aria-label="搜索用户"
          />
        </div>

        {error != null ? (
          <div className="space-y-1.5 p-3 text-xs">
            <div className="font-medium text-destructive">{classifyLoadError(error).summary}</div>
            <div className="text-muted-foreground">用户列表没能取到，这不代表该组织没有用户。</div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              <RotateCw className="mr-1 size-3" />
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-label="用户列表">
              <UserOption label="全部用户" selected={!userId} onSelect={() => pick(null)} />
              {users.map((user) => (
                <UserOption
                  key={user.id}
                  label={userLabel(user)}
                  selected={user.id === userId}
                  onSelect={() => pick(user.id)}
                />
              ))}
              {loading && (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  正在加载用户…
                </div>
              )}
              {!loading && users.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {debouncedKeyword ? "没有匹配的用户，换个关键词试试" : "该组织下暂无用户"}
                </div>
              )}
            </div>
            {truncated && !loading && (
              // 口径标注：绝不静默截断
              <div className="border-t px-2 py-1.5 text-2xs text-muted-foreground">
                仅显示前 {USER_PAGE_SIZE} 位，输入关键词可搜索全部用户
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function UserOption({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        selected && "font-medium",
      )}
    >
      <Check className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
      <span className="truncate">{label}</span>
    </button>
  );
}
