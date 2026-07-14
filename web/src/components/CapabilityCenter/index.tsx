import { Bot, MessageSquarePlus, Plug, Puzzle } from "lucide-react";
import type { OrgAgentSummary } from "@agent/shared";
import { OrgAgentAvatarContent } from "@/components/OrgAgentAvatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SkillSelector } from "@/components/SkillSelector";
import { McpManager } from "@/components/McpManager";
import { CapabilityTabsList } from "./CapabilityTabsList";
import { useCapabilityNavigation } from "./navigation";

function ManagedCapabilityNotice({ kind }: { kind: "技能" | "连接器" }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-dashed bg-muted/20 px-6 py-12 text-center">
      {kind === "技能" ? <Puzzle className="h-8 w-8 text-brand-600" /> : <Plug className="h-8 w-8 text-brand-600" />}
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
  actionsDisabled = false,
}: {
  experts: OrgAgentSummary[];
  personalAgentEnabled: boolean;
  onStartExpert: (expertId: string) => void;
  actionsDisabled?: boolean;
}) {
  const { activeCapabilityTab, handleCapabilityTabChange } = useCapabilityNavigation();

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col p-4 sm:p-6">
      <Tabs value={activeCapabilityTab} onValueChange={handleCapabilityTabChange} className="flex min-h-0 flex-1 flex-col">
        <CapabilityTabsList className="shrink-0 md:hidden" />

        <div className="mt-5 min-h-0 flex-1 overflow-auto md:mt-0">
          <TabsContent value="experts" className="mt-0">
            <div className="mb-5">
              <h2 className="text-xl font-semibold">企业专家</h2>
              <p className="mt-1 text-sm text-muted-foreground">由组织配置职责、知识与固有能力，成员可以使用但不能修改。</p>
            </div>
            {experts.length === 0 ? (
              <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center text-muted-foreground">
                <Bot className="h-8 w-8" />
                <div className="mt-3 text-sm">当前没有指派给你的企业专家</div>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {experts.map((expert) => (
                  <Card key={expert.id} className="overflow-hidden transition-shadow hover:shadow-md">
                    <CardContent className="flex h-full flex-col p-5">
                      <div className="flex items-start gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-50 text-2xl dark:bg-brand-900/35" aria-hidden="true">
                          <OrgAgentAvatarContent agent={expert} />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{expert.name}</div>
                          <div className="mt-0.5 text-xs font-medium text-brand-600">企业提供</div>
                        </div>
                      </div>
                      <p className="mt-4 line-clamp-3 min-h-[3.75rem] text-sm leading-5 text-muted-foreground">
                        {expert.description || "由组织统一配置的企业专家，在限定职责范围内协助你完成工作。"}
                      </p>
                      <div className="mt-3 text-xs text-muted-foreground">
                        {expert.skillCount > 0 ? `${expert.skillCount} 个固有技能` : "专属职责与回答范围"}
                      </div>
                      <Button className="mt-5 w-full" disabled={actionsDisabled} onClick={() => onStartExpert(expert.id)}>
                        <MessageSquarePlus className="mr-2 h-4 w-4" />开始对话
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="skills" className="mt-0 h-full">
            {personalAgentEnabled ? (
              <SkillSelector
                headerTitle="我的通用 Agent 技能"
                headerDescription="选择通用 Agent 在新会话中可以使用的技能。企业专家的固有技能不受这里控制。"
              />
            ) : <ManagedCapabilityNotice kind="技能" />}
          </TabsContent>

          <TabsContent value="connectors" className="mt-0 h-full">
            {personalAgentEnabled ? <McpManager /> : <ManagedCapabilityNotice kind="连接器" />}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
