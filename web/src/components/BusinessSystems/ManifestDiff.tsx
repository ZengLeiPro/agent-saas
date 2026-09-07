import type { Manifest } from '@kaiyan/ky-app-contract/browser';

function flatten(value: unknown, path = '$'): Map<string, string> {
  if (value && typeof value === 'object' && Object.keys(value).length) {
    return new Map(
      Object.entries(value).flatMap(([key, item]) => [...flatten(item, `${path}.${key}`)]),
    );
  }
  return new Map([[path, JSON.stringify(value) ?? '未设置']]);
}

/** 展示原始字段差异；发布与复核结论始终由服务端决定。 */
export function ManifestDiff({ before, after }: { before?: Manifest; after: Manifest }) {
  const previous = flatten(before ?? {});
  const current = flatten(after);
  const changes = [...new Set([...previous.keys(), ...current.keys()])].filter(
    (key) => previous.get(key) !== current.get(key),
  );
  return (
    <details className="rounded border p-3">
      <summary className="cursor-pointer text-sm">
        与当前发布版本的字段差异（{changes.length} 项）
      </summary>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              <th>字段</th>
              <th>当前发布值</th>
              <th>此版本值</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((key) => (
              <tr key={key} className="border-t align-top">
                <td className="break-all p-2">{key}</td>
                <td className="max-w-64 break-all p-2">{previous.get(key) ?? '未设置'}</td>
                <td className="max-w-64 break-all p-2">{current.get(key) ?? '未设置'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!changes.length && <p>无字段变化</p>}
      </div>
    </details>
  );
}
