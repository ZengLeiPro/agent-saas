import type { CatalogScenarioPublic, WorkflowLibraryPublicV3 } from "@agent/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { friendlyPrimaryType, friendlyReadiness } from "./friendlyMappings";
import {
  workflowById,
  workflowCta,
  workflowIsolatedDemoFor,
  workflowRoleViewFor,
  workflowSkinFor,
  type BusinessModelFilterValue,
  type MaturityFilterValue,
  type VerticalFilterValue,
  type WorkflowPrimaryAction,
} from "./workflowUi";

export function ScenarioDetailDialog({
  scenario,
  library,
  vertical,
  businessModel,
  maturity,
  skinId,
  roleViewId,
  roleId,
  open,
  onOpenChange,
  onPrimaryAction,
}: {
  scenario: CatalogScenarioPublic | null;
  library: WorkflowLibraryPublicV3;
  vertical: VerticalFilterValue;
  businessModel: BusinessModelFilterValue;
  maturity: MaturityFilterValue;
  skinId?: string | null;
  roleViewId?: string | null;
  roleId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrimaryAction: (action: WorkflowPrimaryAction, scenario: CatalogScenarioPublic) => void;
}) {
  if (!scenario) return null;
  const workflow = workflowById(library, scenario);
  const cta = workflowCta(scenario);
  const capabilities = workflow?.capabilities.filter((capability) => capability.required) ?? [];
  const roleNames = scenario.roleIds.map((roleId) => (
    library.roles.find((role) => role.id === roleId)?.name ?? roleId
  ));
  const skin = workflowSkinFor(library, scenario, skinId, { vertical, businessModel, maturity });
  const maturityProfile = skin?.maturityProfiles.find((profile) => profile.level === maturity)
    ?? (skinId ? skin?.maturityProfiles.find((profile) => profile.level === "已有单体系统") : null);
  const effectiveReadiness = maturityProfile?.readiness ?? skin?.readiness ?? scenario.readiness;
  const effectiveCta = effectiveReadiness === "D2_PROJECT"
    ? { action: "diagnosis" as const, label: "预约落地诊断", secondaryLabel: "查看行业演示" }
    : effectiveReadiness === "D1_CONNECTOR"
      ? { action: "connector" as const, label: "接入我的系统", secondaryLabel: "查看工作流" }
      : cta;
  const roleView = workflowRoleViewFor(library, scenario, roleViewId, roleId);
  const isolatedDemo = workflowIsolatedDemoFor(library, scenario);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-wrap gap-1.5 pr-8">
            <Badge variant="secondary">{friendlyPrimaryType[scenario.primaryType]}</Badge>
            <Badge variant="outline">{friendlyReadiness[effectiveReadiness]}</Badge>
          </div>
          <DialogTitle className="pt-2 text-left">{scenario.title}</DialogTitle>
          <DialogDescription className="text-left leading-6">{scenario.value}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <section>
            <h3 className="font-medium">替谁解决什么</h3>
            <p className="mt-1.5 leading-6 text-muted-foreground">涉及岗位：{roleNames.join("、")}</p>
            {workflow ? <p className="mt-1 leading-6 text-muted-foreground">不处理的损失：{workflow.summary.lossIfIgnored}</p> : null}
          </section>

          <section>
            <h3 className="font-medium">业务事件</h3>
            <p className="mt-1.5 leading-6 text-muted-foreground">{scenario.detail.event}</p>
          </section>

          <section>
            <h3 className="font-medium">读取来源</h3>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
              {scenario.detail.reads.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>

          <section>
            <h3 className="font-medium">判断与不确定项</h3>
            <p className="mt-1.5 leading-6 text-muted-foreground">{scenario.detail.decides}</p>
            {workflow ? <p className="mt-1 leading-6 text-muted-foreground">{workflow.summary.uncertainty}</p> : null}
          </section>

          <section>
            <h3 className="font-medium">实际动作</h3>
            <ol className="mt-2 space-y-2">
              {scenario.detail.acts.map((item, index) => (
                <li key={item} className="flex gap-2 text-muted-foreground">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs text-secondary-foreground">
                    {index + 1}
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2">
            <div>
              <h3 className="font-medium">人审与权限</h3>
              <p className="mt-1.5 leading-6 text-muted-foreground">{scenario.detail.approval}</p>
            </div>
            <div>
              <h3 className="font-medium">等待、升级与复查</h3>
              <p className="mt-1.5 leading-6 text-muted-foreground">{scenario.detail.followUp}</p>
            </div>
          </section>

          <section>
            <h3 className="font-medium">系统前后状态</h3>
            <p className="mt-1.5 leading-6 text-muted-foreground">{scenario.detail.beforeAfter}</p>
          </section>

          <section>
            <h3 className="font-medium">完成证明与价值</h3>
            <p className="mt-1.5 leading-6 text-muted-foreground">{scenario.detail.valueProof}</p>
            {workflow ? <p className="mt-1 leading-6 text-muted-foreground">{workflow.summary.proof}</p> : null}
          </section>

          {skin ? (
            <section className="rounded-lg border p-4">
              <h3 className="font-medium">行业业务版本 · {skin.title}</h3>
              <div className="mt-2 space-y-2 leading-6 text-muted-foreground">
                <p>适用：{[...skin.industryVerticals, ...skin.businessModels].join("、")}</p>
                <div>
                  <div className="text-foreground">业务对象</div>
                  <ul className="list-disc pl-5">
                    {skin.objectLabels.map((item) => <li key={item.key}>{item.label}</li>)}
                  </ul>
                </div>
                <div>
                  <div className="text-foreground">行业规则</div>
                  <ul className="list-disc pl-5">
                    {skin.rules.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
                <div>
                  <div className="text-foreground">系统与证据</div>
                  <p>系统：{skin.systems.join("、")}</p>
                  <p>必须核对：{skin.evidenceRequired.join("、")}</p>
                </div>
                <div>
                  <div className="text-foreground">会执行并回读</div>
                  <ul className="space-y-2">
                    {skin.operations.map((item, index) => (
                      <li key={`${item.target}-${index}`} className="rounded-md bg-muted/40 p-2.5">
                        <div>{item.target}：{item.operation}</div>
                        <div>人审：{item.approval}</div>
                        <div>回读：{item.readback}</div>
                        <div>成功：{item.successState}</div>
                        <div>失败/补偿：{item.failureState}；{item.compensation}</div>
                      </li>
                    ))}
                  </ul>
                </div>
                <p>主责任人：{skin.ownership.primaryOwner}</p>
                <p>协作角色：{skin.ownership.collaborators.join("、")}</p>
                <p>强人审：{skin.ownership.strongApprovalRoles.join("、")}；{skin.ownership.approvalReason}</p>
                <p>业务终态：{skin.terminal.successState}</p>
                <p>终态复查：{skin.terminal.readback}</p>
                <p>价值指标：{skin.metrics.join("、")}</p>
                <p>证据状态：{skin.evidenceStatus}</p>
                {maturityProfile ? <p>{maturityProfile.level}：{maturityProfile.deliveryPath}</p> : null}
                <p>
                  接入成熟度：{friendlyReadiness[effectiveReadiness]}
                  {effectiveReadiness !== scenario.readiness
                    ? `（通用工作流为${friendlyReadiness[scenario.readiness]}，此行业组合按实际接入边界调整）`
                    : "（与通用工作流一致）"}
                </p>
              </div>
            </section>
          ) : null}

          {roleView ? (
            <section className="rounded-lg border p-4">
              <h3 className="font-medium">岗位视图 · {roleView.title}</h3>
              <div className="mt-2 space-y-2 leading-6 text-muted-foreground">
                <div>
                  <div className="text-foreground">岗位责任</div>
                  <ul className="list-disc pl-5">
                    {roleView.responsibilities.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
                <p>可见阶段：{roleView.visibleStages.join("、")}</p>
                <div>
                  <div className="text-foreground">可执行动作</div>
                  {roleView.actions.length > 0 ? (
                    <ul className="list-disc pl-5">
                      {roleView.actions.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  ) : <p>该岗位以查看、确认和协作为主。</p>}
                </div>
                <p>审批边界：{roleView.approvalSummary}</p>
              </div>
            </section>
          ) : null}

          <section className="rounded-lg border p-4">
            <h3 className="font-medium">现在怎么用</h3>
            <p className="mt-1.5 text-muted-foreground">成熟度：{friendlyReadiness[effectiveReadiness]}</p>
            {capabilities.length > 0 ? (
              <p className="mt-1 text-muted-foreground">需要：{capabilities.map((item) => item.label).join("、")}</p>
            ) : null}
            {scenario.demo.evidenceLevel === "workflow_replay" && scenario.demo.sharePath ? (
              <p className="mt-1 text-muted-foreground">已提供通过证据契约的只读状态回放。</p>
            ) : (
              <p className="mt-1 text-muted-foreground">当前展示工作流与接入边界，不把设计说明冒充真实运行结果。</p>
            )}
            {isolatedDemo ? (
              <p className="mt-1 text-muted-foreground">可在专用隔离演示系统中运行并回读状态；演示结果不代表已接入你的业务系统。</p>
            ) : null}
          </section>
        </div>

        <DialogFooter className="gap-2">
          {isolatedDemo ? (
            <Button type="button" variant="outline" onClick={() => onPrimaryAction("isolated-demo", scenario)}>
              运行隔离演示
            </Button>
          ) : null}
          {scenario.demo.evidenceLevel === "workflow_replay" && scenario.demo.sharePath ? (
            <Button type="button" variant="outline" onClick={() => onPrimaryAction("replay", scenario)}>
              查看已验收回放
            </Button>
          ) : null}
          {effectiveCta.secondaryLabel ? (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          ) : null}
          {effectiveCta.action !== "replay" ? (
            <Button type="button" onClick={() => onPrimaryAction(effectiveCta.action, scenario)}>
              {effectiveCta.label}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
