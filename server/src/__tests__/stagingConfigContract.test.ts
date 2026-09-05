import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';

const source = { agent: { cwd: '/tmp/staging-config-contract' }, server: { port: 3210 } };

describe('预发配置与实际服务配置协议', () => {
  it('首次生成的预发配置能通过服务校验并声明数据库写入能力', async () => {
    const renderer = await import(
      new URL('../../../scripts/staging/render-config.mjs', import.meta.url).href
    );
    const rendered = renderer.renderStagingConfig(source, {
      STAGING_JWT_SECRET: 'staging-jwt-secret-for-config-contract',
      STAGING_ARTIFACT_SIGNED_URL_SECRET: 'staging-artifact-secret-for-config-contract',
      STAGING_DATABASE_URL: 'postgresql://staging:example@localhost/staging',
      STAGING_CAPABILITY_CONFIG_JSON: JSON.stringify({
        codexSubscription: { enabled: false, websocketEnabled: true },
        models: {
          default: 'codex/test',
          groups: [
            {
              id: 'codex',
              name: '测试',
              protocol: 'responses',
              responses_transport: 'codex_subscription',
              models: [{ id: 'test', name: '测试', value: 'test-model' }],
            },
          ],
        },
      }),
    });
    const parsed = parseAppConfig(rendered);
    expect(parsed.artifact?.readUrlTtlSeconds).toBe(300);
    expect(parsed.runtimeEventStore).toMatchObject({
      backend: 'pg',
      writerCapability: { capability: 'tenant-native-v1' },
    });
  });

  it('部署脚本修正旧的 900 秒配置后能通过实际服务校验', async () => {
    const script = await readFile(
      new URL('../../../scripts/release/deploy-staging-release.sh', import.meta.url),
      'utf8',
    );
    const block = script.match(
      /node - "\$server_config" "\$deployment_attempt_id" <<'NODE'\n([\s\S]+?)\nNODE/u,
    );
    expect(block).not.toBeNull();
    const previous = {
      ...source,
      artifact: { backend: 'local', readUrlTtlSeconds: 900 },
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://staging:example@localhost/staging',
        writerCapability: { capability: 'tenant-native-v1' },
      },
    };
    expect(() => parseAppConfig(previous)).toThrow('artifact.readUrlTtlSeconds');
    let written: unknown;
    const require = createRequire(import.meta.url);
    runInNewContext(block![1], {
      process: { argv: ['node', '-', 'config.json', 'contract-test'] },
      require: (name: string) =>
        name === 'node:fs'
          ? {
              readFileSync: () => JSON.stringify(previous),
              writeFileSync: (_path: string, value: string) => {
                written = JSON.parse(value);
              },
              renameSync: () => {},
            }
          : require(name),
    });
    const parsed = parseAppConfig(written);
    expect(parsed.artifact?.readUrlTtlSeconds).toBe(300);
    expect(parsed.runtimeEventStore).toMatchObject({
      backend: 'pg',
      writerCapability: { capability: 'tenant-native-v1' },
    });
  });
});
