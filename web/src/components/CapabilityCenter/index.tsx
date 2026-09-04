import { useCallback, useMemo, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import type { CatalogScenarioPublic, OrgAgentSummary, ScenarioItem } from "@agent/shared";
import { OrgAgentAvatarContent } from "@/components/OrgAgentAvatar";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SkillSelector } from "@/components/SkillSelector";
import { McpManager } from "@/components/McpManager";
import { CapabilityTabsList } from "./CapabilityTabsList";
import { useCapabilityNavigation } from "./navigation";
import { CatalogToolbar, CapabilityLogo, CAPABILITY_EMPTY_SURFACE, CAPABILITY_SURFACE, CAPABILITY_SURFACE_HOVER } from "./CatalogUi";
import { CatalogHeader } from "./CatalogHeader";
import { BuiltInConnectors } from "./BuiltInConnectors";
import { ScenariosPanel } from "@/components/scenarios/ScenariosPanel";

function ManagedCapabilityNotice({ kind }: { kind: "技能" | "连接器" }) {
  return (
    <div className={cn("mx-auto flex max-w-xl flex-col items-center px-6 py-12 text-center", CAPABILITY_EMPTY_SURFACE)}>
      {kind === "技能" ? <EntityIcons.skill className="size-8 text-brand-600" /> : <EntityIcons.connector className="size-8 text-brand-600" />}
      <h3 className="mt-4 text-base font-semibold">{kind} 由组织统一配置</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        当前组织未开放个人通用 Agent。企业专家所需的 {kind} 已由管理员配置，成员无需重复启用。
      </p>
    </div>
  );
}

export function CapabilityCenter({
  experts,
  personalAgentEnabled,
  onStartExpert,
  onTryScenario,
  onStartWorkflow,
  onRequestDiagnosis,
  onWorkflowSelected,
  onWorkflowReplayOpenChange,
  roleDetailId,
  onOpenRoleDetail,
  onCloseRoleDetail,
  actionsDisabled = false,
}: {
  experts: OrgAgentSummary[];
  personalAgentEnabled: boolean;
  onStartExpert: (expertId: string) => void;
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  onStartWorkflow?: (
    starterMessage: string,
    scenario: CatalogScenarioPublic,
  ) => void;
  onRequestDiagnosis?: (message: string, scenario: CatalogScenarioPublic) => void;
  onWorkflowSelected?: (scenario: CatalogScenarioPublic) => void;
  onWorkflowReplayOpenChange?: (open: boolean) => void;
  roleDetailId?: string | null;
  onOpenRoleDetail?: (roleId: string) => void;
  onCloseRoleDetail?: () => void;
  actionsDisabled?: boolean;
}) {
  const { activeCapabilityTab, handleCapabilityTabChange } = useCapabilityNavigation(personalAgentEnabled);
  const [expertQuery, setExpertQuery] = useState("");
  const [workflowReplayOpen, setWorkflowReplayOpen] = useState(false);
  const handleWorkflowReplayOpenChange = useCallback((open: boolean) => {
    setWorkflowReplayOpen(open);
    onWorkflowReplayOpenChange?.(open);
  }, [onWorkflowReplayOpenChange]);
  const filteredExperts = useMemo(() => {
    const query = expertQuery.trim().toLocaleLowerCase();
    if (!query) return experts;
    return experts.filter((expert) => [expert.name, expert.description, ...expert.starterPrompts]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [expertQuery, experts]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Tabs value={activeCapabilityTab} onValueChange={handleCapabilityTabChange} className="flex min-h-0 flex-1 flex-col">
        {!workflowReplayOpen && (
          <div className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6 md:hidden">
            <CapabilityTabsList
              activeValue={activeCapabilityTab}
              showTemplates={personalAgentEnabled}
            />
          </div>
        )}

        <div className={cn("min-h-0 flex-1 overflow-y-auto md:mt-0", workflowReplayOpen ? "mt-0" : "mt-5")}>
          {/* templates 页签给 h-full：场景回放视图需要确定高度才能铺满并把回放条压在底部；
              列表态内容超高时照常由父级滚动容器承担 */}
          {personalAgentEnabled && (
            <TabsContent value="templates" className="mt-0 h-full">
              <ScenariosPanel
                onTryScenario={onTryScenario}
                onStartWorkflow={onStartWorkflow}
                onRequestDiagnosis={onRequestDiagnosis}
                onWorkflowSelected={onWorkflowSelected}
                onReplayOpenChange={handleWorkflowReplayOpenChange}
                onConnectWorkflow={(workflowId) => {
                  handleCapabilityTabChange("connectors");
                  const params = new URLSearchParams(window.location.search);
                  params.set("returnToWorkflowId", workflowId);
                  window.history.replaceState({}, "", `/capabilities/connectors?${params.toString()}`);
                }}
                roleDetailId={roleDetailId}
                onOpenRoleDetail={onOpenRoleDetail}
                onCloseRoleDetail={onCloseRoleDetail}
              />
            </TabsContent>
          )}

          <TabsContent value="experts" className="mt-0 px-4 pb-4 sm:px-6 sm:pb-6 md:pt-6">
            <CatalogHeader
              title="我的企业专家"
              description="由组织为你配置，可以直接开始对话。"
              actions={
                <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                  {experts.length} 位专家
                </span>
              }
            />
            {experts.length > 0 ? (
              <CatalogToolbar
                query={expertQuery}
                onQueryChange={setExpertQuery}
                searchPlaceholder="搜索专家名称、职责或示例问题"
              />
            ) : null}
            {experts.length === 0 ? (
              <div className={cn("flex flex-col items-center px-6 py-12 text-center text-muted-foreground", CAPABILITY_EMPTY_SURFACE)}>
                <EntityIcons.expert className="size-8" />
                <div className="mt-3 text-sm">当前没有指派给你的企业专家</div>
              </div>
            ) : filteredExperts.length === 0 ? (
              <div className={cn("px-6 py-12 text-center text-sm text-muted-foreground", CAPABILITY_EMPTY_SURFACE)}>
                没有找到匹配的企业专家
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {filteredExperts.map((expert) => (
                  <Card
                    key={expert.id}
                    className={cn("group overflow-hidden border-0 shadow-none", CAPABILITY_SURFACE, CAPABILITY_SURFACE_HOVER)}
                  >
                    <CardContent className="flex h-full flex-col p-5">
                      <div className="flex items-start gap-3">
                        <CapabilityLogo label={expert.name} className="text-2xl">
                          <OrgAgentAvatarContent agent={expert} />
                        </CapabilityLogo>
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{expert.name}</div>
                          <div className="mt-0.5 text-xs font-medium text-brand-600">组织指派</div>
                        </div>
                      </div>
                      <p className="mt-4 line-clamp-3 min-h-[3.75rem] text-sm leading-5 text-muted-foreground">
                        {expert.description || "由组织统一配置的企业专家，在限定职责范围内协助你完成工作。"}
                      </p>
                      <div className="mt-4 flex min-h-7 flex-wrap gap-1.5">
                        {expert.starterPrompts.slice(0, 2).map((prompt) => (
                          <span key={prompt} className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                            {prompt}
                          </span>
                        ))}
                      </div>
                      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
                        <span className="text-xs text-muted-foreground">
                          {expert.skillCount > 0 ? `${expert.skillCount} 个固有技能` : "专属职责范围"}
                        </span>
                        <Button size="sm" disabled={actionsDisabled} onClick={() => onStartExpert(expert.id)}>
                          <MessageSquarePlus className="size-3.5" />开始对话
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="skills" className="mt-0 px-4 pb-4 sm:px-6 sm:pb-6 md:pt-6">
            {personalAgentEnabled ? (
              <SkillSelector
                headerTitle="技能"
                headerDescription="选择通用 Agent 在新会话中可以使用的技能。企业专家的固有技能不受这里控制。"
                embedded
              />
            ) : <ManagedCapabilityNotice kind="技能" />}
          </TabsContent>

          <TabsContent value="connectors" className="mt-0 px-4 pb-4 sm:px-6 sm:pb-6 md:pt-6">
            {personalAgentEnabled ? <McpManager embedded /> : (
              // 内置协同办公连接跟随用户 workspace，企业专家会话同样使用；即使
              // 组织未开放个人通用 Agent，也要保留钉钉与飞书入口。
              <div className="space-y-6">
                <BuiltInConnectors />
                <ManagedCapabilityNotice kind="连接器" />
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
