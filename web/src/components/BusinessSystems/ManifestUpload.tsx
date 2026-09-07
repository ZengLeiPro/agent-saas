import { useRef, useState } from 'react';
import { validateManifest, type Manifest } from '@kaiyan/ky-app-contract';
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
  const generation = useRef(0);
  async function read(file?: File) {
    const request = ++generation.current;
    setManifest(undefined);
    setErrors([]);
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
    } catch (error) {
      setErrors([error instanceof Error ? error.message : '登记失败']);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">登记业务系统版本</h3>
      <label className="block text-sm">
        上传 Manifest JSON
        <input
          className="mt-2 block"
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => void read(event.target.files?.[0])}
        />
      </label>
      {errors.length > 0 && (
        <ul role="alert" className="text-sm text-destructive">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
      {manifest && (
        <p className="text-sm">
          {manifest.name} · {manifest.systemId} · {manifest.capabilities.length} 项能力
        </p>
      )}
      <Button disabled={!manifest || busy} onClick={() => void register()}>
        {busy ? '登记中…' : '校验并登记版本'}
      </Button>
    </section>
  );
}
