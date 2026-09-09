import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { installationPath, kyAppPost } from '@/lib/kyAppManagementApi';
import type { InstallationManagement } from '@/lib/kyAppManagementTypes';
import { loadMySystems } from '@/lib/mySystemsSource';
import { useManagementResource, ResourceState } from './ManagementResource';
import { InstallationAssignments } from './InstallationAssignments';
import { InstallationCredentials } from './InstallationCredentials';
import { InstallationRuntime, InstallationReadPanel } from './InstallationRuntime';
import { InstallationLifecycle } from './InstallationLifecycle';
import { InstallationAccessOverview } from './InstallationAccessOverview';
import { InstallationActivity } from './InstallationActivity';
import { businessStatusLabel, formatBusinessSystemTime, shortDigest } from './presentation';

export function InstallationDetail({
  installationId,
  tenantId,
  onBack,
}: {
  installationId: string;
  tenantId?: string;
  onBack: () => void;
}) {
  const resource = useManagementResource<InstallationManagement>(
    installationPath(installationId, '/management'),
  );
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const detail = resource.data;
  async function status(action: string) {
    const prompt =
      action === 'enable'
        ? '确认启用实例？现有授权范围将保持不变。'
        : action === 'disable'
          ? '确认停用实例？现有授权范围将保留。'
          : '确认校验业务域名归属？';
    if (busy || !window.confirm(prompt)) return;
    setBusy(true);
    setError('');
    try {
      const result = await kyAppPost<{ verified?: boolean; detail?: string }>(
        installationPath(installationId, `/${action}`),
      );
      if (action === 'verify-domain' && result.verified === false)
        setError(result.detail ?? '域名验证尚未通过，请核对 TXT 记录。');
      resource.reload();
      await loadMySystems({ force: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  if (detail && tenantId && detail.installation.tenantId !== tenantId)
    return <p role="alert">无权查看其他组织的安装实例。</p>;
  if (!detail)
    return (
      <section className="p-4">
        <Button variant="outline" onClick={onBack}>
          返回列表
        </Button>
        <ResourceState error={resource.error} retry={resource.reload} />
      </section>
    );
  const actions = detail.allowedActions ?? [];
  const readiness = detail.readiness;
  return (
    <section className="space-y-4 p-4">
      <Button variant="outline" onClick={onBack}>
        返回列表
      </Button>
      {error && <p role="alert">{error}</p>}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {detail.definition?.name ?? detail.installation.systemId}
          </h2>
          <p className="text-sm text-muted-foreground">
            {readiness?.overallStatus === 'ready'
              ? '可以使用'
              : readiness?.overallStatus === 'degraded'
                ? '连接异常'
                : readiness?.overallStatus === 'disabled'
                  ? '已停用'
                  : '需要处理'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            ['enable', '启用系统'],
            ['disable', '停用系统'],
            ['verify_domain', '验证业务域名'],
          ].map(
            ([action, label]) =>
              actions.includes(action) && (
                <Button
                  key={action}
                  variant="outline"
                  disabled={busy}
                  onClick={() => void status(action === 'verify_domain' ? 'verify-domain' : action)}
                >
                  {label}
                </Button>
              ),
          )}
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="业务系统实例管理">
          <TabsTrigger value="overview">接入概览</TabsTrigger>
          <TabsTrigger value="access">访问授权</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatusCard title="页面访问" value={businessStatusLabel(readiness?.pageStatus)} />
            <StatusCard title="Agent 能力" value={businessStatusLabel(readiness?.agentStatus)} />
            <StatusCard
              title="个人授权"
              value={businessStatusLabel(readiness?.personalAuthorizationMode)}
            />
          </div>
          {readiness?.overallStatus !== 'ready' && (
            <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:bg-amber-950/20">
              <strong>下一步：{readiness?.nextAction ?? '检查接入状态'}</strong>
              <p className="mt-1 text-muted-foreground">
                当前由 {ownerLabel(readiness?.ownerRole)} 处理。最近检查：
                {formatBusinessSystemTime(readiness?.lastCheckedAt)}
              </p>
            </div>
          )}
          <dl className="grid gap-2 rounded border p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">当前版本</dt>
              <dd>{shortDigest(detail.installation.registeredDigest)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">版本一致</dt>
              <dd>
                {detail.upgrade?.currentDigest &&
                detail.upgrade.currentDigest === detail.upgrade.publishedDigest
                  ? '是'
                  : '否'}
              </dd>
            </div>
          </dl>
          <InstallationRuntime
            installationId={installationId}
            canDiagnose={actions.includes('diagnose')}
            compact
          />
          <InstallationActivity installationId={installationId} />
        </TabsContent>
        <TabsContent value="access" className="space-y-4">
          {actions.includes('edit_assignments') ? (
            <InstallationAssignments
              tenantId={detail.installation.tenantId}
              installationId={installationId}
              name={detail.definition?.name ?? installationId}
            />
          ) : (
            <p>当前实例不可编辑访问范围；请先启用实例并确认管理权限。</p>
          )}
          <InstallationAccessOverview installationId={installationId} />
        </TabsContent>
      </Tabs>
      <details className="rounded border p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
          高级操作 <ChevronDown className="h-4 w-4" />
        </summary>
        <div className="mt-4 space-y-4">
          <InstallationCredentials
            installationId={installationId}
            canIssue={actions.includes('issue_credential')}
          />
          {(actions.includes('switch_digest') || actions.includes('plan_offboarding')) && (
            <InstallationLifecycle detail={detail} reload={resource.reload} />
          )}
          <InstallationReadPanel installationId={installationId} suffix="audit" title="操作记录" />
          <details>
            <summary className="cursor-pointer text-sm">高级信息</summary>
            <dl className="mt-2 grid gap-2 text-xs">
              <dt>安装实例</dt>
              <dd className="break-all">{detail.installation.installationId}</dd>
              <dt>业务服务地址</dt>
              <dd className="break-all">{detail.installation.baseUrl}</dd>
              <dt>技术联系人</dt>
              <dd>{detail.installation.techContactUserId}</dd>
              <dt>完整登记版本</dt>
              <dd className="break-all">{detail.installation.registeredDigest ?? '暂无'}</dd>
            </dl>
          </details>
        </div>
      </details>
    </section>
  );
}

function StatusCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded border p-4">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}

function ownerLabel(value: string | null | undefined): string {
  return value === 'platform_admin'
    ? '平台管理员'
    : value === 'organization_admin'
      ? '组织管理员'
      : value === 'technical_contact'
        ? '技术联系人'
        : value === 'member'
          ? '当前成员'
          : '相关负责人';
}
