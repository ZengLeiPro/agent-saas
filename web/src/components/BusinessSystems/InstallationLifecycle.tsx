import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { installationPath, kyAppPost, kyAppRequest } from '@/lib/kyAppManagementApi';
import type { InstallationManagement } from '@/lib/kyAppManagementTypes';
import { useManagementResource, ResourceState } from './ManagementResource';
export function InstallationLifecycle({
  detail,
  reload,
}: {
  detail: InstallationManagement;
  reload: () => void;
}) {
  const id = detail.installation.installationId;
  const resource = useManagementResource<{
    runtime: { manifestDigest: string | null; readyStatus: string } | null;
  }>(installationPath(id, '/runtime'));
  const delivery = useManagementResource<{
    delivery: { offboardingStatus: string; offboardingPlan?: { reason?: string } } | null;
  }>(installationPath(id, '/delivery'));
  const [target, setTarget] = useState(detail.upgrade?.publishedDigest ?? '');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [externalDone, setExternalDone] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const actions = detail.allowedActions ?? [];
  useEffect(() => {
    if (
      !actions.includes('switch_digest') ||
      (resource.data?.runtime?.manifestDigest === target &&
        resource.data.runtime.readyStatus === 'ok')
    )
      return;
    const timer = window.setTimeout(resource.reload, 10000);
    return () => window.clearTimeout(timer);
  }, [actions, resource, target]);
  async function mutate(path: string, body: unknown, method = 'POST') {
    setBusy(true);
    setError('');
    try {
      await kyAppRequest(path, { method, body: JSON.stringify(body) });
      delivery.reload();
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
      delivery.reload();
    } finally {
      setBusy(false);
    }
  }
  async function switchVersion() {
    if (!window.confirm('确认外部业务系统已部署目标版本，并切换平台登记版本？')) return;
    setBusy(true);
    setError('');
    try {
      await kyAppPost(installationPath(id, '/registered-digest'), {
        digest: target,
        expectedRegisteredDigest: detail.installation.registeredDigest,
      });
      reload();
      resource.reload();
      try {
        await kyAppPost(installationPath(id, '/diagnose'));
      } catch {
        setError('登记版本已切换，请在运行与诊断页查看切换后的诊断结果。');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '切换失败');
      resource.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {actions.includes('switch_digest') && (
        <div className="space-y-3 rounded border p-4">
          <h3 className="font-medium">版本升级 / 回滚</h3>
          <p className="text-sm">
            请先由技术联系人部署目标已发布版本，待实例就绪并上报相同 digest
            后再切换。回滚也需先部署旧版本。
          </p>
          <p className="break-all text-xs">
            当前：{detail.installation.registeredDigest ?? '未登记'}
          </p>
          <label className="block text-sm">
            目标已发布 digest
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value.trim())}
              className="mt-1 block w-full rounded border bg-background p-2 text-xs"
            />
          </label>
          {!resource.data ? (
            <ResourceState error={resource.error} retry={resource.reload} />
          ) : (
            <p className="break-all text-xs">
              运行上报：{resource.data.runtime?.manifestDigest ?? '无'} ·{' '}
              {resource.data.runtime?.readyStatus ?? '未知'}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={resource.reload}>
              检查部署状态
            </Button>
            <Button
              disabled={
                busy ||
                !/^[a-f0-9]{64}$/.test(target) ||
                resource.data?.runtime?.readyStatus !== 'ok' ||
                resource.data.runtime.manifestDigest !== target ||
                target === detail.installation.registeredDigest
              }
              onClick={() => void switchVersion()}
            >
              切换登记版本
            </Button>
          </div>
        </div>
      )}
      {actions.includes('plan_offboarding') && (
        <div className="space-y-3 rounded border p-4">
          <h3 className="font-medium">平台离场</h3>
          <p className="text-sm">
            平台离场将停用实例、吊销服务凭据并保留审计。外部系统的数据导出、删除和部署清理需由责任人自行完成。
          </p>
          {!delivery.data ? (
            <ResourceState error={delivery.error} retry={delivery.reload} />
          ) : (
            <p>计划状态：{delivery.data.delivery?.offboardingStatus ?? '尚无交付记录'}</p>
          )}
          <label className="block text-sm">
            离场原因
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 block w-full rounded border bg-background p-2"
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || !reason.trim()}
            onClick={() => {
              if (window.confirm('确认保存离场计划？'))
                void mutate(
                  installationPath(id, '/offboarding'),
                  {
                    status: 'planned',
                    plan: {
                      reason: reason.trim(),
                      disableInstallation: true,
                      revokeCredentials: true,
                      externalActions: [],
                    },
                  },
                  'PUT',
                );
            }}
          >
            保存离场计划
          </Button>
          {actions.includes('execute_offboarding') &&
            delivery.data?.delivery?.offboardingStatus === 'planned' && (
              <>
                <label className="block text-sm">
                  <input
                    type="checkbox"
                    checked={exportDone}
                    onChange={(event) => setExportDone(event.target.checked)}
                  />{' '}
                  已完成必要数据导出
                </label>
                <label className="block text-sm">
                  <input
                    type="checkbox"
                    checked={externalDone}
                    onChange={(event) => setExternalDone(event.target.checked)}
                  />{' '}
                  已完成外部系统责任项
                </label>
                <label className="block text-sm">
                  输入安装实例 ID 二次确认
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    className="mt-1 block w-full rounded border bg-background p-2"
                  />
                </label>
                <Button
                  variant="destructive"
                  disabled={busy || confirmation !== id || !externalDone || !exportDone}
                  onClick={() =>
                    void mutate(installationPath(id, '/offboarding/execute-platform'), {
                      confirmInstallationId: confirmation,
                      exportCompleted: true,
                      externalActionsCompleted: true,
                    })
                  }
                >
                  执行平台离场
                </Button>
              </>
            )}
        </div>
      )}
    </section>
  );
}
