import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('production API nginx CORS', () => {
  it('keeps gateway errors readable without allowing unknown origins', async () => {
    const configPath = new URL('../../../daemon-packaging/nginx/agent-api-kaiyan.conf.example', import.meta.url);
    const config = await readFile(configPath, 'utf8');

    expect(config).toContain('map $http_origin $agent_api_cors_origin');
    expect(config).toContain('"https://agent.kaiyan.net" $http_origin;');
    expect(config).toContain('proxy_hide_header Access-Control-Allow-Origin;');
    expect(config).toContain('proxy_hide_header Access-Control-Expose-Headers;');
    expect(config).toContain('add_header Access-Control-Allow-Origin $agent_api_cors_origin always;');
    expect(config).toContain('add_header Access-Control-Expose-Headers X-Refresh-Token always;');
    expect(config).toContain('add_header Vary Origin always;');
  });
});
