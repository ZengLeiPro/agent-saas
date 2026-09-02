import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function repoFile(path: string): string {
  const root = process.cwd().endsWith('/server') ? resolve(process.cwd(), '..') : process.cwd();
  return readFileSync(resolve(root, path), 'utf8');
}

describe('WebSocket credential transport boundary', () => {
  it('has zero JWT query construction hits in shared/web/mobile WS sources', () => {
    const sources = [
      'shared/src/lib/wsClient.ts',
      'web/src/platform/webConfig.ts',
      'mobile/src/platform/mobileConfig.ts',
    ].map(repoFile).join('\n');

    expect(sources.match(/\/ws\?token|searchParams\.set\(['"]token|[?&]token=/g) ?? []).toHaveLength(0);
    expect(sources).toContain("action: 'auth'");
  });

  it('uses a query-free nginx access log format and redacts preview bearer paths', () => {
    const nginx = repoFile('daemon-packaging/nginx/agent-api-kaiyan.conf.example');
    const format = nginx.match(/log_format agent_api_safe[\s\S]*?;/)?.[0] ?? '';

    expect(format).toContain('$agent_api_log_uri');
    expect(nginx).toMatch(/map \$uri \$agent_api_log_uri[\s\S]*~\^\/preview[\s\S]*\/preview\/\[REDACTED\]/);
    expect(format).not.toMatch(/\$request(?!_method)|\$request_uri|\$args|\$query_string|\$http_referer/);
    expect(nginx).toContain('access.log agent_api_safe');
    expect(format).toContain('"-"');
  });
});
