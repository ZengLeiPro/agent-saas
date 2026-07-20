import { useMemo, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import type { OrgAgentSummary, ScenarioItem } from "@agent/shared";
import { OrgAgentAvatarContent } from "@/components/OrgAgentAvatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SkillSelector } from "@/components/SkillSelector";
import { McpManager } from "@/components/McpManager";
import { CapabilityTabsList } from "./CapabilityTabsList";
import { useCapabilityNavigation } from "./navigation";
import { CatalogToolbar, CapabilityLogo } from "./CatalogUi";
import { BuiltInConnectors } from "./BuiltInConnectors";
import { ScenariosPanel } from "@/components/scenarios/ScenariosPanel";

function ManagedCapabilityNotice({ kind }: { kind: "技能" | "连接器" }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-dashed bg-muted/20 px-6 py-12 text-center">
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
  roleDetailId,
  onOpenRoleDetail,
  onCloseRoleDetail,
  actionsDisabled = false,
}: {
  experts: OrgAgentSummary[];
  personalAgentEnabled: boolean;
  onStartExpert: (expertId: string) => void;
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  roleDetailId?: string | null;
  onOpenRoleDetail?: (roleId: string) => void;
  onCloseRoleDetail?: () => void;
  actionsDisabled?: boolean;
}) {
  const { activeCapabilityTab, handleCapabilityTabChange } = useCapabilityNavigation(personalAgentEnabled);
  const [expertQuery, setExpertQuery] = useState("");
  const filteredExperts = useMemo(() => {
    const query = expertQuery.trim().toLocaleLowerCase();
    if (!query) return experts;
    return experts.filter((expert) => [expert.name, expert.description, ...expert.starterPrompts]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [expertQuery, experts]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Tabs value={activeCapabilityTab} onValueChange={handleCapabilityTabChange} className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6 md:hidden">
          <CapabilityTabsList showTemplates={personalAgentEnabled} />
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto md:mt-0">
          {personalAgentEnabled && (
            <TabsContent value="templates" className="mt-0">
              <ScenariosPanel
                onTryScenario={onTryScenario}
                roleDetailId={roleDetailId}
                onOpenRoleDetail={onOpenRoleDetail}
                onCloseRoleDetail={onCloseRoleDetail}
              />
            </TabsContent>
          )}

          <TabsContent value="experts" className="mt-0 px-4 pb-4 sm:px-6 sm:pb-6 md:pt-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">我的企业专家</h2>
                <p className="mt-1 text-sm text-muted-foreground">由组织为你配置，可以直接开始对话。</p>
              </div>
              <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                {experts.length} 位专家
              </span>
            </div>
            {experts.length > 0 ? (
              <CatalogToolbar
                query={expertQuery}
                onQueryChange={setExpertQuery}
                searchPlaceholder="搜索专家名称、职责或示例问题"
              />
            ) : null}
            {experts.length === 0 ? (
              <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center text-muted-foreground">
                <EntityIcons.expert className="size-8" />
                <div className="mt-3 text-sm">当前没有指派给你的企业专家</div>
              </div>
            ) : filteredExperts.length === 0 ? (
              <div className="rounded-2xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
                没有找到匹配的企业专家
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {filteredExperts.map((expert) => (
                  <Card key={expert.id} className="group overflow-hidden border-border/70 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-lg">
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
                      <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4">
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
