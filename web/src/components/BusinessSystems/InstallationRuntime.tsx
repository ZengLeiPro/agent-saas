import { useState } from 'react';
import { Activity, RefreshCw, Stethoscope } from 'lucide-react';
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
    <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
          <Activity className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-medium">服务健康</h3>
          <p className="text-xs text-muted-foreground">检查页面、Agent 服务与版本状态</p>
        </div>
      </div>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : !resource.data.runtime ? (
        <p>尚未收到运行状态报告</p>
      ) : (
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <RuntimeValue
            label="页面服务"
            value={businessStatusLabel(resource.data.runtime.liveStatus)}
          />
          <RuntimeValue
            label="Agent 服务"
            value={businessStatusLabel(resource.data.runtime.readyStatus)}
          />
          <RuntimeValue label="版本一致" value={resource.data.digestConsistent ? '是' : '否'} />
          <RuntimeValue
            label="实际版本"
            value={shortDigest(resource.data.runtime.manifestDigest)}
            mono
          />
        </dl>
      )}
      <div className="flex gap-2">
        {canDiagnose && (
          <Button disabled={busy} onClick={() => void diagnose()}>
            <Stethoscope className="h-4 w-4" />
            {busy ? '诊断中…' : '一键诊断'}
          </Button>
        )}
        <Button variant="outline" onClick={resource.reload}>
          <RefreshCw className="h-4 w-4" />
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

function RuntimeValue({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 font-medium ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
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
