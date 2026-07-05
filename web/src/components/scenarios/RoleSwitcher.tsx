import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, UserRound } from "lucide-react";
import type { ScenarioRole, UserPreferences } from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useScenarioLibrary } from "./useScenarioLibrary";

interface AvailableRolesResponse {
  availableRoleIds: string[];
  activeRoleId: string | null;
}

interface SwitchRoleResponse {
  activeRoleId: string;
  welcomeMessage: string | null;
  preferences?: UserPreferences;
}

export interface UseRoleSwitcherResult {
  roles: ScenarioRole[];
  availableRoleIds: string[];
  activeRoleId: string | null;
  activeRole: ScenarioRole | null;
  loading: boolean;
  switchingRoleId: string | null;
  switchRole: (roleId: string) => Promise<void>;
  reload: () => void;
}

async function fetchAvailableRoles(): Promise<AvailableRolesResponse> {
  const res = await authFetch("/api/user/available-roles");
  if (!res.ok) throw new Error(`加载岗位失败 (${res.status})`);
  return (await res.json()) as AvailableRolesResponse;
}

export function useRoleSwitcher(): UseRoleSwitcherResult {
  const { library, loading: libraryLoading, reload: reloadLibrary } = useScenarioLibrary();
  const { user, updatePreferences } = useAuth();
  const [availableRoleIds, setAvailableRoleIds] = useState<string[]>([]);
  const [activeRoleId, setActiveRoleId] = useState<string | null>(user?.preferences?.activeRoleId ?? null);
  const [loadingRoles, setLoadingRoles] = useState(true);
  const [switchingRoleId, setSwitchingRoleId] = useState<string | null>(null);

  const roles = library?.roles ?? [];
  const activeRole = useMemo(
    () => roles.find((role) => role.id === activeRoleId) ?? null,
    [activeRoleId, roles],
  );

  const reload = useCallback(() => {
    let cancelled = false;
    setLoadingRoles(true);
    fetchAvailableRoles()
      .then((data) => {
        if (cancelled) return;
        setAvailableRoleIds(data.availableRoleIds);
        setActiveRoleId(data.activeRoleId);
        if (data.activeRoleId) updatePreferences({ activeRoleId: data.activeRoleId });
      })
      .catch(() => {
        if (cancelled) return;
        setAvailableRoleIds([]);
        setActiveRoleId(user?.preferences?.activeRoleId ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoadingRoles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [updatePreferences, user?.preferences?.activeRoleId]);

  useEffect(() => reload(), [reload]);

  const switchRole = useCallback(
    async (roleId: string) => {
      if (roleId === activeRoleId || !availableRoleIds.includes(roleId)) return;
      setSwitchingRoleId(roleId);
      try {
        const res = await authFetch("/api/user/switch-role", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roleId }),
        });
        if (!res.ok) throw new Error(`切换岗位失败 (${res.status})`);
        const data = (await res.json()) as SwitchRoleResponse;
        setActiveRoleId(data.activeRoleId);
        updatePreferences(data.preferences ?? { activeRoleId: data.activeRoleId });
        if (data.welcomeMessage) {
          window.dispatchEvent(
            new CustomEvent("kaiyan:role-switched", {
              detail: { roleId: data.activeRoleId, welcomeMessage: data.welcomeMessage },
            }),
          );
        }
      } finally {
        setSwitchingRoleId(null);
      }
    },
    [activeRoleId, availableRoleIds, updatePreferences],
  );

  return {
    roles,
    availableRoleIds,
    activeRoleId,
    activeRole,
    loading: libraryLoading || loadingRoles,
    switchingRoleId,
    switchRole,
    reload: () => {
      reloadLibrary();
      reload();
    },
  };
}

export interface RoleSwitcherProps {
  onOpenRoleDetail?: (roleId: string) => void;
}

export function RoleSwitcher({ onOpenRoleDetail }: RoleSwitcherProps) {
  const {
    roles,
    availableRoleIds,
    activeRoleId,
    activeRole,
    loading,
    switchingRoleId,
    switchRole,
  } = useRoleSwitcher();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (loading || roles.length === 0) return null;

  const available = roles.filter((role) => availableRoleIds.includes(role.id));
  const unavailable = roles.filter((role) => !availableRoleIds.includes(role.id));
  const label = activeRole?.name ?? available[0]?.name ?? "选择岗位";

  return (
    <div className="relative" ref={rootRef}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-xs"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[120px] truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-72 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">已开通</div>
          {available.map((role) => (
            <button
              key={role.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                activeRoleId === role.id && "font-medium",
              )}
              disabled={switchingRoleId !== null}
              onClick={() => {
                void switchRole(role.id).then(() => setOpen(false));
              }}
            >
              <span className="flex h-4 w-4 items-center justify-center">
                {activeRoleId === role.id && <Check className="h-3.5 w-3.5 text-brand-600" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{role.name}</span>
              {switchingRoleId === role.id && (
                <span className="text-xs text-muted-foreground">切换中</span>
              )}
            </button>
          ))}

          {unavailable.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">未开通</div>
              {unavailable.map((role) => (
                <div
                  key={role.id}
                  className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground"
                >
                  <span className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">{role.name}</span>
                  <span className="text-xs">联系客户成功</span>
                </div>
              ))}
            </>
          )}

          {activeRoleId && onOpenRoleDetail && (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setOpen(false);
                  onOpenRoleDetail(activeRoleId);
                }}
              >
                查看当前岗位详情
                <ChevronDown className="-rotate-90 h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
