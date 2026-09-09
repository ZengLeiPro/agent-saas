import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import { kyAppPost } from '@/lib/kyAppManagementApi';
import type { OnboardExecution, OnboardResponse } from '@/lib/kyAppManagementTypes';
import type { ConnectionOptions } from '@/lib/kyAppConnectionTypes';
import { useManagementResource, ResourceState } from '../BusinessSystems/ManagementResource';
import { credentialClaimUrl } from '../KyAppCredentialClaim/claimRoute';
import { CreateDeliveryForm } from './CreateDeliveryForm';
import { businessStatusLabel, formatBusinessSystemTime } from '../BusinessSystems/presentation';
const routeId = 'platform.runtime.system-deliveries';
const stepNames: Record<string, string> = {
  existing_organization: '组织与技术联系人',
  assignments: '成员与 Agent 授权',
  tenant_admin: '组织与管理员',
  credit_grant: '初始积分',
  system_version: '系统版本',
  installation_credential: '安装与凭据',
  enable: '验证并启用',
  members: '导入成员',
  skills: '技能检查',
};
export function SystemDeliveryPage({
  executionId,
  systemId,
  embedded = false,
  connectionRevision = 0,
}: {
  executionId?: string | null;
  systemId?: string;
  embedded?: boolean;
  connectionRevision?: number;
}) {
  const [selectedExecution, setSelectedExecution] = useState(() =>
    embedded
      ? (new URLSearchParams(window.location.search).get('execution') ?? undefined)
      : executionId,
  );
  function open(id?: string) {
    if (!embedded) {
      navigateGovernance(governanceRoute(routeId, { entityId: id }));
      return;
    }
    setSelectedExecution(id);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'installations');
    if (id) url.searchParams.set('execution', id);
    else url.searchParams.delete('execution');
    window.history.replaceState(window.history.state, '', url);
  }
  const currentExecution = embedded ? selectedExecution : executionId;
  const [latest, setLatest] = useState<OnboardResponse>();
  function started(result: OnboardResponse) {
    setLatest(result);
    open(result.execution.executionId);
  }
  return currentExecution ? (
    <div className="space-y-4">
      {embedded && (
        <Button variant="outline" onClick={() => open()}>
          返回组织接入
        </Button>
      )}
      <DeliveryExecution
        key={currentExecution}
        executionId={currentExecution}
        expectedSystemId={systemId}
        latest={latest?.execution.executionId === currentExecution ? latest : undefined}
        onResumed={setLatest}
      />
    </div>
  ) : (
    <div className="space-y-6 p-4">
      <CreateDeliveryForm
        key={connectionRevision}
        defaultSystemId={systemId}
        onStarted={started}
        onOpenExecution={open}
      />
      <DeliveryList systemId={systemId} onOpen={open} />
    </div>
  );
}
function DeliveryList({ systemId, onOpen }: { systemId?: string; onOpen: (id: string) => void }) {
  const resource = useManagementResource<{
    executions?: Array<
      Pick<OnboardExecution, 'executionId' | 'tenantId' | 'tenantName' | 'systemId' | 'status'>
    >;
  }>('/deliveries');
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  const executions =
    resource.data.executions?.filter((item) => !systemId || item.systemId === systemId) ?? [];
  return systemId ? (
    <SystemDeliveryList systemId={systemId} executions={executions} onOpen={onOpen} />
  ) : (
    <DeliveryRows executions={executions} onOpen={onOpen} />
  );
}

function SystemDeliveryList({
  systemId,
  executions,
  onOpen,
}: {
  systemId: string;
  executions: Array<
    Pick<OnboardExecution, 'executionId' | 'tenantId' | 'tenantName' | 'systemId' | 'status'>
  >;
  onOpen: (id: string) => void;
}) {
  const options = useManagementResource<ConnectionOptions>(
    `/systems/${encodeURIComponent(systemId)}/connection-options`,
  );
  return <DeliveryRows executions={executions} options={options.data} onOpen={onOpen} />;
}

function DeliveryRows({
  executions,
  options,
  onOpen,
}: {
  executions: Array<
    Pick<OnboardExecution, 'executionId' | 'tenantId' | 'tenantName' | 'systemId' | 'status'>
  >;
  options?: ConnectionOptions;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="space-y-3">
      <h3 className="font-medium">组织接入记录</h3>
      {!executions.length && <p>暂无组织接入记录</p>}
      {executions.map((execution) => {
        const organization = options?.organizations.find((item) => item.id === execution.tenantId);
        const status = organization?.connection?.ready ? 'completed' : execution.status;
        return (
          <div
            key={execution.executionId}
            className="flex items-center justify-between rounded-xl border bg-card p-4 shadow-sm"
          >
            <span>
              组织 {organization?.name ?? execution.tenantName ?? execution.tenantId} ·{' '}
              {businessStatusLabel(status)}
            </span>
            <Button variant="outline" onClick={() => onOpen(execution.executionId)}>
              查看进度
            </Button>
          </div>
        );
      })}
    </section>
  );
}
function DeliveryExecution({
  executionId,
  latest,
  onResumed,
  expectedSystemId,
}: {
  executionId: string;
  expectedSystemId?: string;
  latest?: OnboardResponse;
  onResumed: (result: OnboardResponse) => void;
}) {
  const resource = useManagementResource<{ execution: OnboardExecution }>(
    `/onboard/${encodeURIComponent(executionId)}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const execution = resource.data?.execution;
  useEffect(() => {
    if (execution?.status !== 'running') return;
    const timer = window.setTimeout(resource.reload, 3000);
    return () => window.clearTimeout(timer);
  }, [execution, resource.reload]);
  async function resume() {
    if (!execution || busy) return;
    setBusy(true);
    setError('');
    try {
      onResumed(
        await kyAppPost<OnboardResponse>(
          execution.request?.mode === 'existing'
            ? `/onboard-existing/${encodeURIComponent(execution.executionId)}/resume`
            : '/onboard',
          execution.request?.mode === 'existing' ? {} : execution.request,
        ),
      );
      resource.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '继续交付失败');
      resource.reload();
    } finally {
      setBusy(false);
    }
  }
  const claim = latest?.claim;
  const ticket = claim?.path.split('/').at(-1);
  const visibleSteps = execution?.steps.filter(
    (step) => !['smoke', 'delivery_checklist'].includes(step.id),
  );
  const coreCompleted = Boolean(
    visibleSteps?.length && visibleSteps.every((step) => step.status === 'completed'),
  );
  const displayedStatus = coreCompleted ? 'completed' : execution?.status;
  if (execution && expectedSystemId && execution.systemId !== expectedSystemId)
    return <p role="alert">该接入记录不属于当前业务系统，请返回组织接入重新选择。</p>;
  return (
    <section className="space-y-4 p-4">
      <h2 className="text-lg font-semibold">组织接入进度</h2>
      {error && <p role="alert">{error}</p>}
      {!execution ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <>
          <p>
            组织 <OrganizationName systemId={expectedSystemId} tenantId={execution.tenantId} /> ·{' '}
            {businessStatusLabel(displayedStatus)}
          </p>
          <ol className="space-y-2">
            {visibleSteps?.map((step) => (
              <li className="rounded border p-3" key={step.id}>
                <strong>{stepNames[step.id] ?? '接入步骤'}</strong> ·{' '}
                {businessStatusLabel(step.status)}
                {(step.code || step.detail) && (
                  <details className="mt-2">
                    <summary>高级信息</summary>
                    {step.code && <p>问题代码：{step.code}</p>}
                    <pre className="whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(step.detail ?? {}, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
          {execution.status === 'waiting_external' && !coreCompleted && (
            <p>{connectionWaitingMessage(execution.lastErrorCode)}</p>
          )}
          {claim && ticket && (
            <div className="rounded border p-3">
              <p>
                平台管理员可直接领取，也可将链接交给技术联系人。过期时间：
                {formatBusinessSystemTime(claim.ticketExpiresAt)}
              </p>
              <input
                aria-label="凭据领取链接"
                readOnly
                value={credentialClaimUrl(execution.installationId, ticket)}
                className="w-full rounded border bg-background p-2 text-xs"
              />
              <p className="text-xs">刷新后不保留此链接；如遗失，请到实例运营页重新签发。</p>
              <Button asChild variant="outline">
                <a
                  href={credentialClaimUrl(execution.installationId, ticket)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  领取凭据
                </a>
              </Button>
            </div>
          )}
          {['waiting_external', 'failed'].includes(execution.status) && !coreCompleted && (
            <Button disabled={busy} onClick={() => void resume()}>
              {busy ? '继续交付中…' : '继续交付'}
            </Button>
          )}
          {execution.request?.mode === 'existing' && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  navigateGovernance(
                    governanceRoute('organization.agents.business-systems', {
                      orgId: execution.tenantId,
                      entityId: execution.installationId,
                    }),
                  )
                }
              >
                打开实例与授权
              </Button>
              {execution.lastErrorCode === 'diagnostic_configuration_required' && (
                <Button
                  variant="outline"
                  onClick={() =>
                    navigateGovernance(
                      governanceRoute('platform.resource-center.business-systems', {
                        entityId: execution.systemId,
                        search: '?tab=connection-settings',
                      }),
                    )
                  }
                >
                  配置接入诊断
                </Button>
              )}
            </div>
          )}
          {(execution.status === 'completed' || coreCompleted) && (
            <div className="space-y-3">
              <p>基础交付完成，请在组织业务系统中核对并配置成员与 Agent 授权范围。</p>
              <Button
                onClick={() =>
                  navigateGovernance(
                    governanceRoute('organization.agents.business-systems', {
                      orgId: execution.tenantId,
                      entityId: execution.installationId,
                    }),
                  )
                }
              >
                进入组织授权
              </Button>
            </div>
          )}
          <Button variant="outline" onClick={resource.reload}>
            刷新进度
          </Button>
        </>
      )}
    </section>
  );
}

function OrganizationName({ systemId, tenantId }: { systemId?: string; tenantId: string }) {
  return systemId ? (
    <ResolvedOrganizationName systemId={systemId} tenantId={tenantId} />
  ) : (
    <>{tenantId}</>
  );
}

function ResolvedOrganizationName({ systemId, tenantId }: { systemId: string; tenantId: string }) {
  const resource = useManagementResource<ConnectionOptions>(
    `/systems/${encodeURIComponent(systemId)}/connection-options`,
  );
  return <>{resource.data?.organizations.find((item) => item.id === tenantId)?.name ?? tenantId}</>;
}

function connectionWaitingMessage(code: string | null) {
  const messages: Record<string, string> = {
    credential_claim_required: '待领取凭据：平台管理员或技术联系人可登录领取并装配凭据。',
    credential_ack_required: '待服务确认：请装配凭据，启动业务服务并完成确认。',
    domain_verification_required: '待域名验证：请按处理信息配置 DNS TXT，完成后继续。',
    ready_required: '待服务就绪：请部署本次接入版本，服务就绪后继续。',
    assignment_required: '待授权成员：请打开实例与授权，选择可使用的成员及 Agent，完成后继续。',
    diagnostic_configuration_required:
      '待配置接入诊断：请在系统接入配置中选择只读能力和参数，保存后继续。',
    organization_admin_required: '所选组织暂无有效管理员，请先完善组织成员管理。',
    diagnostic_failed: '接入诊断未通过，请查看处理信息，修复后继续。',
  };
  return messages[code ?? ''] ?? '等待完成外部处理。完成后可继续原接入请求。';
}

/** 旧交付链接继续可用，统一进入所属业务系统的组织接入页。 */
export function LegacySystemDeliveryPage({
  executionId,
  systemId,
}: {
  executionId?: string | null;
  systemId?: string;
}) {
  const resource = useManagementResource<{ execution?: OnboardExecution }>(
    executionId ? `/onboard/${encodeURIComponent(executionId)}` : '/systems',
  );
  useEffect(() => {
    if (!resource.data) return;
    const targetSystem = resource.data.execution?.systemId ?? systemId;
    navigateGovernance(
      governanceRoute('platform.resource-center.business-systems', {
        ...(targetSystem ? { entityId: targetSystem } : {}),
        search: `?${new URLSearchParams({ tab: 'installations', ...(executionId ? { execution: executionId } : {}) })}`,
      }),
    );
  }, [resource.data, executionId, systemId]);
  return <ResourceState error={resource.error} retry={resource.reload} />;
}
