import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { installationPath, kyAppPost, KyAppManagementError } from '@/lib/kyAppManagementApi';
import { useManagementResource, ResourceState } from './ManagementResource';
import { businessStatusLabel, formatBusinessSystemTime, shortDigest } from './presentation';
interface DiagnosticReport {
  passed: boolean;
  checkedAt: string;
  checks: Array<{ id: string; label: string; status: string; detail: string }>;
}
export function InstallationRuntime({
  installationId,
  canDiagnose,
  compact = false,
}: {
  installationId: string;
  canDiagnose: boolean;
  compact?: boolean;
}) {
  const resource = useManagementResource<{
    runtime: {
      liveStatus: string;
      readyStatus: string;
      manifestDigest: string | null;
      lastError: string | null;
    } | null;
    digestConsistent: boolean;
  }>(installationPath(installationId, '/runtime'));
  const [report, setReport] = useState<DiagnosticReport>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function diagnose() {
    setBusy(true);
    setError('');
    try {
      setReport(
        (
          await kyAppPost<{ report: DiagnosticReport }>(
            installationPath(installationId, '/diagnose'),
          )
        ).report,
      );
      resource.reload();
    } catch (reason) {
      if (reason instanceof KyAppManagementError && reason.diagnosticReport)
        setReport(reason.diagnosticReport as DiagnosticReport);
      else setError(reason instanceof Error ? reason.message : '诊断失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3">
      <h3 className="font-medium">服务检查</h3>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : !resource.data.runtime ? (
        <p>尚未收到运行状态报告</p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>页面服务</dt>
          <dd>{businessStatusLabel(resource.data.runtime.liveStatus)}</dd>
          <dt>Agent 服务</dt>
          <dd>{businessStatusLabel(resource.data.runtime.readyStatus)}</dd>
          <dt>版本一致</dt>
          <dd>{resource.data.digestConsistent ? '是' : '否'}</dd>
          <dt>实际版本</dt>
          <dd>{shortDigest(resource.data.runtime.manifestDigest)}</dd>
        </dl>
      )}
      <div className="flex gap-2">
        {canDiagnose && (
          <Button disabled={busy} onClick={() => void diagnose()}>
            {busy ? '诊断中…' : '一键诊断'}
          </Button>
        )}
        <Button variant="outline" onClick={resource.reload}>
          刷新运行状态
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {report && (
        <div>
          <p>
            {report.passed ? '诊断通过' : '诊断未通过'} ·{' '}
            {formatBusinessSystemTime(report.checkedAt)}
          </p>
          <ul>
            {report.checks.map((check) => (
              <li className="border-b py-2 text-sm" key={check.id}>
                <strong>{check.label}</strong> · {businessStatusLabel(check.status)}
                <p>{check.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!compact && (
        <InstallationReadPanel
          installationId={installationId}
          suffix="signals"
          title="最近 24 小时异常信号"
        />
      )}
    </section>
  );
}
export function InstallationReadPanel({
  installationId,
  suffix,
  title,
}: {
  installationId: string;
  suffix: string;
  title: string;
}) {
  const resource = useManagementResource<Record<string, unknown>>(
    installationPath(installationId, `/${suffix}`),
  );
  return (
    <section className="space-y-2 rounded border p-3">
      <h3 className="font-medium">{title}</h3>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(resource.data, null, 2)}
        </pre>
      )}
    </section>
  );
}
