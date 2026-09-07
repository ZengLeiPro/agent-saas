import { InstallationLifecycle } from './InstallationLifecycle';
import { KyAppTenantUsagePanel } from '@/components/KyAppDeliveryPanels';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { installationPath, kyAppPost } from '@/lib/kyAppManagementApi';
import type { InstallationManagement } from '@/lib/kyAppManagementTypes';
import { loadMySystems } from '@/lib/mySystemsSource';
import { useManagementResource, ResourceState } from './ManagementResource';
import { InstallationAssignments } from './InstallationAssignments';
import { InstallationCredentials } from './InstallationCredentials';
import { InstallationRuntime, InstallationReadPanel } from './InstallationRuntime';
export function InstallationDetail({ installationId, tenantId, onBack }: { installationId: string; tenantId?: string; onBack: () => void }) {
  const resource = useManagementResource<InstallationManagement>(installationPath(installationId, '/management'));
  const [tab, setTab] = useState('runtime'); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const detail = resource.data;
  async function status(action: string) {
    if (busy || !window.confirm(action === 'enable' ? '确认启用实例？现有授权范围将保持不变。' : action === 'disable' ? '确认停用实例？现有授权范围将保留。' : '确认校验业务域名归属？')) return;
    setBusy(true); setError('');
    try { const result = await kyAppPost<{ verified?: boolean; detail?: string }>(installationPath(installationId, `/${action}`)); if (action === 'verify-domain' && result.verified === false) setError(result.detail ?? '域名验证尚未通过，请核对 TXT 记录。'); resource.reload(); await loadMySystems({ force: true }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  }
  if (detail && tenantId && detail.installation.tenantId !== tenantId) return <p role="alert">无权查看其他组织的安装实例。</p>;
  const actions = detail?.allowedActions ?? [];
  return <section className="space-y-4 p-4"><Button variant="outline" onClick={onBack}>返回列表</Button>{error && <p role="alert">{error}</p>}
    {!detail ? <ResourceState error={resource.error} retry={resource.reload} /> : <><h2 className="text-lg font-semibold">{detail.definition?.name ?? detail.installation.systemId}</h2><p className="text-sm">{detail.installation.installationId} · 组织 {detail.installation.tenantId} · {detail.installation.status}</p><dl className="grid grid-cols-2 gap-2 text-sm"><dt>业务服务</dt><dd className="break-all">{detail.installation.baseUrl}</dd><dt>技术联系人</dt><dd>{detail.installation.techContactUserId}</dd><dt>域名验证</dt><dd>{detail.installation.domainVerifiedAt ?? '待验证'}</dd></dl>{detail.domainVerification && !detail.installation.domainVerifiedAt && <div className="rounded border p-3 text-xs"><p>请技术联系人配置 DNS TXT：</p><p className="break-all">{detail.domainVerification.recordName}</p><p className="break-all">{detail.domainVerification.recordValue}</p></div>}<p className="text-sm">组织授权范围：{detail.assignmentSummary?.configured ? '已配置' : '待配置'}</p>
      <div className="flex flex-wrap gap-2">{[['enable', '启用实例'], ['disable', '停用实例'], ['verify_domain', '验证域名']].map(([action, label]) => actions.includes(action!) && <Button key={action} variant="outline" disabled={busy} onClick={() => void status(action === 'verify_domain' ? 'verify-domain' : action!)}>{label}</Button>)}</div>
      <div className="flex flex-wrap gap-2" role="tablist">{[['runtime', '运行与诊断'], ['credentials', '凭据'], ['assignments', '访问授权'], ['delivery', '交付'], ['usage', '用量'], ['audit', '审计'], ...(actions.includes('switch_digest') || actions.includes('plan_offboarding') ? [['lifecycle', '版本与离场']] : [])].map(([value, label]) => <Button role="tab" aria-selected={tab === value} key={value} variant={tab === value ? 'default' : 'outline'} onClick={() => setTab(value!)}>{label}</Button>)}</div>
      {tab === 'runtime' && <InstallationRuntime installationId={installationId} canDiagnose={actions.includes('diagnose')} />}
      {tab === 'credentials' && <InstallationCredentials installationId={installationId} canIssue={actions.includes('issue_credential')} />}
      {tab === 'assignments' && (actions.includes('edit_assignments') ? <InstallationAssignments tenantId={detail.installation.tenantId} installationId={installationId} name={detail.definition?.name ?? installationId} /> : <p>当前实例不可编辑访问范围；请先启用实例并确认管理权限。</p>)}
      {tab === 'lifecycle' && <InstallationLifecycle detail={detail} reload={resource.reload} />}
      {tab === 'usage' && <KyAppTenantUsagePanel tenantId={detail.installation.tenantId} installationId={installationId} />}
      {['delivery', 'audit'].includes(tab) && <InstallationReadPanel key={tab} installationId={installationId} suffix={tab} title={tab === 'delivery' ? '交付清单' : tab === 'usage' ? '实例用量' : '操作审计'} />}
    </>}
  </section>;
}
