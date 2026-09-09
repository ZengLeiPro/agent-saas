import { useRef, useState } from 'react';
import { FileJson, Upload } from 'lucide-react';
import { validateManifest } from '@kaiyan/ky-app-contract/validation';
import type { Manifest } from '@kaiyan/ky-app-contract/browser';
import { Button } from '@/components/ui/button';
import { kyAppPost } from '@/lib/kyAppManagementApi';
export function ManifestUpload({
  systemId,
  onRegistered,
}: {
  systemId?: string;
  onRegistered: (id: string) => void;
}) {
  const [manifest, setManifest] = useState<Manifest>();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  async function read(file?: File) {
    const request = ++generation.current;
    setManifest(undefined);
    setErrors([]);
    setFileName(file?.name ?? '');
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Manifest 文件不能超过 2 MB');
      const data: unknown = JSON.parse(await file.text());
      if (request !== generation.current) return;
      const result = validateManifest(data);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      const parsed = data as Manifest;
      if (systemId && parsed.systemId !== systemId)
        throw new Error('文件中的系统标识与当前系统不一致');
      setManifest(parsed);
    } catch (error) {
      if (request === generation.current)
        setErrors([error instanceof Error ? error.message : '无法读取文件']);
    }
  }
  async function register() {
    if (!manifest || busy) return;
    setBusy(true);
    setErrors([]);
    try {
      await kyAppPost(`/systems/${encodeURIComponent(manifest.systemId)}/versions`, {
        name: manifest.name,
        manifest,
      });
      onRegistered(manifest.systemId);
      setManifest(undefined);
      setFileName('');
      if (inputRef.current) inputRef.current.value = '';
    } catch (error) {
      setErrors([error instanceof Error ? error.message : '登记失败']);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4">
      <div>
        <h3 className="font-medium">登记新版本</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          选择 Manifest JSON，平台会先完成格式与系统标识校验。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/30 p-4">
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          aria-label="Manifest JSON 文件"
          disabled={busy}
          onChange={(event) => void read(event.target.files?.[0])}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-2 h-4 w-4" />
          选择 Manifest JSON
        </Button>
        <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <FileJson className="h-4 w-4 shrink-0" />
          <span className="truncate">{fileName || '尚未选择文件'}</span>
        </span>
      </div>
      {errors.length > 0 && (
        <ul role="alert" className="text-sm text-destructive">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
      {manifest && (
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          {manifest.name} · {manifest.systemId} · {manifest.capabilities.length} 项能力
        </p>
      )}
      <Button disabled={!manifest || busy} onClick={() => void register()}>
        {busy ? '登记中…' : '校验并登记版本'}
      </Button>
    </section>
  );
}
