import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { installationPath, kyAppPost } from '@/lib/kyAppManagementApi';
import type { InstallationManagement } from '@/lib/kyAppManagementTypes';
import { loadMySystems } from '@/lib/mySystemsSource';
import { useManagementResource, ResourceState } from './ManagementResource';
import { InstallationRuntime } from './InstallationRuntime';
import { InstallationAccessOverview } from './InstallationAccessOverview';
import { InstallationActivity } from './InstallationActivity';
import { businessStatusLabel, formatBusinessSystemTime, shortDigest } from './presentation';
import { EntityIcons, StatusIcons } from '@/lib/icons';

const BusinessSystemIcon = EntityIcons.businessSystem;
const AgentIcon = EntityIcons.expert;
const AuthorizationIcon = EntityIcons.admin;
const SuccessIcon = StatusIcons.success;

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
  const [pendingAction, setPendingAction] = useState<'enable' | 'disable' | 'verify-domain' | null>(
    null,
  );
  const [actionResult, setActionResult] = useState('');
  const detail = resource.data;
  async function status() {
    const action = pendingAction;
    if (busy || !action) return;
    setBusy(true);
    setError('');
    setActionResult('');
    try {
      const response = await kyAppPost<{
        result?: { verified?: boolean; detail?: string; hostname?: string; method?: string };
      }>(installationPath(installationId, `/${action}`));
      if (action === 'verify-domain') {
        if (response.result?.verified === false) {
          setError(response.result.detail ?? '域名验证尚未通过，请核对 TXT 记录。');
          return;
        }
        setActionResult(
          response.result?.detail
            ? `业务域名验证通过：${response.result.detail}`
            : '业务域名验证通过。',
        );
      }
      setPendingAction(null);
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
    <section className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <Button variant="ghost" className="-ml-2" onClick={onBack}>
        返回列表
      </Button>
      {error && <p role="alert">{error}</p>}
      {actionResult && (
        <p
          role="status"
          className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
        >
          {actionResult}
        </p>
      )}
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-gradient-to-br from-brand-50/80 via-card to-card p-5 shadow-sm dark:from-brand-950/20 md:p-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
            <BusinessSystemIcon className="h-6 w-6" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold">
              {detail.definition?.name ?? detail.installation.systemId}
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              {readiness?.overallStatus === 'ready' ? (
                <SuccessIcon className="h-4 w-4 text-emerald-600" />
              ) : null}
              {readiness?.overallStatus === 'ready'
                ? '运行正常，可以使用'
                : readiness?.overallStatus === 'degraded'
                  ? '连接异常'
                  : readiness?.overallStatus === 'disabled'
                    ? '已停用'
                    : '需要处理'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['enable', '启用系统', 'enable'],
              ['disable', '停用系统', 'disable'],
              [
                'verify_domain',
                detail.installation.domainVerifiedAt ? '重新验证业务域名' : '验证业务域名',
                'verify-domain',
              ],
            ] as const
          ).map(
            ([permission, label, action]) =>
              actions.includes(permission) && (
                <Button
                  key={permission}
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setActionResult('');
                    setPendingAction(action);
                  }}
                >
                  {label}
                </Button>
              ),
          )}
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab} className="space-y-5">
        <TabsList aria-label="业务系统实例管理" className="grid w-full max-w-sm grid-cols-2">
          <TabsTrigger value="overview">接入概览</TabsTrigger>
          <TabsTrigger value="access">访问授权</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatusCard
              icon={<BusinessSystemIcon className="h-5 w-5" />}
              title="页面访问"
              value={businessStatusLabel(readiness?.pageStatus)}
            />
            <StatusCard
              icon={<AgentIcon className="h-5 w-5" />}
              title="Agent 能力"
              value={businessStatusLabel(readiness?.agentStatus)}
            />
            <StatusCard
              icon={<AuthorizationIcon className="h-5 w-5" />}
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
          <dl className="grid gap-4 rounded-xl border bg-card p-4 text-sm shadow-sm sm:grid-cols-2">
            <div className="rounded-lg bg-muted/40 p-3">
              <dt className="text-muted-foreground">当前版本</dt>
              <dd className="mt-1 font-mono font-medium">
                {shortDigest(detail.installation.registeredDigest)}
              </dd>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <dt className="text-muted-foreground">版本一致</dt>
              <dd className="mt-1 font-medium">
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
          {!actions.includes('edit_assignments') ? (
            <p>当前实例不可编辑访问范围；请先启用实例并确认管理权限。</p>
          ) : null}
          <InstallationAccessOverview
            installationId={installationId}
            tenantId={detail.installation.tenantId}
          />
        </TabsContent>
      </Tabs>
      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{actionTitle(pendingAction)}</DialogTitle>
            <DialogDescription>{actionDescription(pendingAction)}</DialogDescription>
          </DialogHeader>
          {pendingAction === 'verify-domain' ? (
            <p className="text-sm text-muted-foreground">
              平台将实时查询业务域名的 DNS TXT
              记录，并与该安装实例登记的验证令牌比对。验证结果会写入操作记录。
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPendingAction(null)}>
              取消
            </Button>
            <Button
              variant={pendingAction === 'disable' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={() => void status()}
            >
              {busy ? '处理中…' : pendingAction === 'verify-domain' ? '开始验证' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function actionTitle(action: 'enable' | 'disable' | 'verify-domain' | null): string {
  return action === 'enable'
    ? '启用业务系统'
    : action === 'disable'
      ? '停用业务系统'
      : '验证业务域名';
}

function actionDescription(action: 'enable' | 'disable' | 'verify-domain' | null): string {
  return action === 'enable'
    ? '启用后，当前成员授权范围保持不变。'
    : action === 'disable'
      ? '停用后成员暂时不能访问，已有授权范围仍会保留。'
      : '确认重新校验该业务系统的域名归属？';
}

function StatusCard({
  icon,
  title,
  value,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-950/30 dark:text-brand-300">
        {icon}
      </div>
      <div>
        <div className="text-xs text-muted-foreground">{title}</div>
        <div className="mt-0.5 font-semibold">{value}</div>
      </div>
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
