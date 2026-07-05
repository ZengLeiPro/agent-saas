/**
 * 场景库整页视图
 *
 * 顶部标题 + 横向可滚动的岗位 tab（「全部」+ 按 roles.sort 排序的岗位），
 * 下方为场景卡片流网格。卡片可点开详情（三段式剧本 + 槽位说明），
 * 卡片与详情内均有主 CTA「试一试」：由上层 onTryScenario 新建会话并预填起手 prompt。
 *
 * 本组件在 DesktopLayout 中按「mount-once-visited + hidden」模式挂载（lazy）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildScenarioPrompt } from "@agent/shared";
import type { ScenarioItem } from "@agent/shared";
import { useAuth } from "@/contexts/AuthContext";
import {
  ScenarioCard,
  ScenarioModeBadge,
  ScenarioRequireBadges,
} from "./ScenarioCard";
import { matchRoleIdByPosition, useScenarioLibrary } from "./useScenarioLibrary";
import { RoleKitDetailPage } from "./RoleKitDetailPage";

interface ScenariosPanelProps {
  /** 点「试一试」：入参为已用槽位示例值填充完毕的起手 prompt 与场景本体 */
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  roleDetailId?: string | null;
  onOpenRoleDetail?: (roleId: string) => void;
  onCloseRoleDetail?: () => void;
}

export function ScenariosPanel({
  onTryScenario,
  roleDetailId,
  onOpenRoleDetail,
  onCloseRoleDetail,
}: ScenariosPanelProps) {
  const { library, loading, error, reload } = useScenarioLibrary();
  const { user } = useAuth();
  // 当前选中的岗位 tab；"all" 表示全部
  const [activeRole, setActiveRole] = useState<string>("all");
  const [detail, setDetail] = useState<ScenarioItem | null>(null);

  // 首次加载完成后，优先按用户主动选择的开箱包岗位定位；没有时再按资料岗位匹配。
  // 用户手动切过场景库 tab 后，不再自动覆盖。
  const lastAutoRoleRef = useRef<string | null>(null);
  const userSelectedRoleRef = useRef(false);
  useEffect(() => {
    if (!library || userSelectedRoleRef.current) return;
    const activeRoleId = user?.preferences?.activeRoleId;
    const preferred = activeRoleId && library.roles.some((role) => role.id === activeRoleId)
      ? activeRoleId
      : matchRoleIdByPosition(library.roles, user?.position);
    if (!preferred || lastAutoRoleRef.current === preferred) return;
    lastAutoRoleRef.current = preferred;
    setActiveRole(preferred);
  }, [library, user?.position, user?.preferences?.activeRoleId]);

  const roles = library?.roles ?? [];
  const scenarios = useMemo(() => {
    const all = library?.scenarios ?? [];
    return activeRole === "all" ? all : all.filter((s) => s.role === activeRole);
  }, [library, activeRole]);

  const roleNameById = useMemo(
    () => new Map(roles.map((r) => [r.id, r.name])),
    [roles],
  );
  const roleDetail = useMemo(
    () => roles.find((role) => role.id === roleDetailId) ?? null,
    [roleDetailId, roles],
  );

  const handleTry = (scenario: ScenarioItem) => {
    setDetail(null);
    onTryScenario(buildScenarioPrompt(scenario), scenario);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">加载场景库...</span>
      </div>
    );
  }

  if (error || !library) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="text-sm">{error || "场景库暂时不可用"}</span>
        <Button type="button" variant="outline" size="sm" onClick={reload}>
          重试
        </Button>
      </div>
    );
  }

  if (roleDetail) {
    return (
      <RoleKitDetailPage
        role={roleDetail}
        scenarios={library.scenarios}
        industryHint={user?.preferences?.industryHint}
        onTryScenario={handleTry}
        onBack={onCloseRoleDetail}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6">
      {/* 标题区 */}
      <div className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">场景库</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              每个岗位，一个 AI 同事——挑一个场景，点「试一试」即可开跑，起手话术可再编辑。
            </p>
          </div>
          {activeRole !== "all" && onOpenRoleDetail && (
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenRoleDetail(activeRole)}>
              查看该岗详情
            </Button>
          )}
        </div>
      </div>

      {/* 岗位 tab：横向可滚动 */}
      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {[{ id: "all", name: "全部" }, ...roles].map((role) => (
          <button
            key={role.id}
            type="button"
            onClick={() => {
              userSelectedRoleRef.current = true;
              setActiveRole(role.id);
            }}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors",
              activeRole === role.id
                ? "border-transparent bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {role.name}
          </button>
        ))}
      </div>

      {/* 卡片流网格 */}
      {scenarios.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          该岗位暂无预置场景
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {scenarios.map((scenario) => (
            <ScenarioCard
              key={scenario.id}
              scenario={scenario}
              onTry={handleTry}
              onOpenDetail={setDetail}
            />
          ))}
        </div>
      )}

      {/* 场景详情弹窗：三段式剧本 + 槽位说明 + 主 CTA */}
      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="max-w-lg">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 pr-6">
                  <span>{detail.title}</span>
                  <ScenarioModeBadge mode={detail.mode} />
                </DialogTitle>
                <DialogDescription className="text-left">{detail.pitch}</DialogDescription>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <div className="text-xs text-muted-foreground">
                  岗位：{roleNameById.get(detail.role) ?? detail.role}
                </div>

                {/* 三段式剧本：以「→」切分为步骤 */}
                <div>
                  <div className="mb-2 font-medium">这个场景怎么跑</div>
                  <ol className="space-y-2">
                    {detail.story.split("→").map((step, idx) => (
                      <li key={idx} className="flex gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs text-secondary-foreground">
                          {idx + 1}
                        </span>
                        <span className="text-muted-foreground">{step.trim()}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* 槽位说明：告诉用户预填话术里哪些地方要替换成自己的信息 */}
                {detail.slots.length > 0 && (
                  <div>
                    <div className="mb-2 font-medium">需要你补充的信息</div>
                    <ul className="space-y-1.5">
                      {detail.slots.map((slot) => (
                        <li key={slot.key} className="text-muted-foreground">
                          <span className="text-foreground">{slot.label}</span>
                          <span className="mx-1">·</span>
                          示例：{slot.example}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <ScenarioRequireBadges requires={detail.requires} />
              </div>

              <DialogFooter>
                <Button type="button" onClick={() => handleTry(detail)}>
                  试一试
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
