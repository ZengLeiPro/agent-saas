#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function renderStagingConfig(source, env = process.env) {
  const config = structuredClone(source);
  const overlay = env.STAGING_CAPABILITY_CONFIG_JSON
    ? JSON.parse(env.STAGING_CAPABILITY_CONFIG_JSON)
    : undefined;
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    throw new Error('STAGING_CAPABILITY_CONFIG_JSON is required and must contain the explicit Staging capability configuration');
  }
  const jwtSecret = required(env, 'STAGING_JWT_SECRET');
  const artifactSignedUrlSecret = required(env, 'STAGING_ARTIFACT_SIGNED_URL_SECRET');
  const databaseUrl = required(env, 'STAGING_DATABASE_URL');
  if (artifactSignedUrlSecret === jwtSecret) {
    throw new Error('STAGING_ARTIFACT_SIGNED_URL_SECRET must be independent from STAGING_JWT_SECRET');
  }

  config.agent = {
    ...(config.agent ?? {}),
    cwd: '/mnt/agent-saas-staging/workspaces',
    sharedDir: '/opt/agent-saas-staging/current/server/workspace-shared',
    userOverrides: {},
  };
  config.server = {
    ...(config.server ?? {}),
    port: 3210,
    corsOrigins: ['https://staging-agent.kaiyan.net'],
    webBaseUrl: 'https://staging-agent.kaiyan.net',
  };
  // 功能配置只能来自 Staging 自己的显式 overlay。不得从 Production/source
  // 复制凭据或通过 renderer 硬编码关闭功能来“实现隔离”。
  for (const key of [
    'models', 'cron', 'dingtalk', 'dingtalkSendMessage', 'webPush', 'alerting',
    'codexSubscription', 'webTools', 'imageGenTools', 'tts', 'stt', 'memory',
    'systemMonitor', 'runtimeEventRetention', 'integrationV3',
    'integrationV3ControlPlane', 'notification', 'notifications',
  ]) {
    delete config[key];
    if (Object.prototype.hasOwnProperty.call(overlay, key)) config[key] = structuredClone(overlay[key]);
  }
  if (!config.models) throw new Error('Staging capability configuration must define models explicitly');
  if (config.cron) {
    config.cron = {
      ...config.cron,
      store: '/mnt/agent-saas-staging/runtime/server/data/cron-jobs.json',
    };
  }
  config.artifact = {
    backend: 'local',
    rootDir: '/mnt/agent-saas-staging/runtime/artifacts',
    signedUrlSecret: artifactSignedUrlSecret,
    readUrlTtlSeconds: 900,
    maxBlobBytes: 100 * 1024 * 1024,
    retentionDays: 90,
    gcIntervalMs: 24 * 60 * 60 * 1000,
  };
  config.auth = {
    ...(config.auth ?? {}),
    enabled: true,
    jwtSecret,
    usersFile: '/mnt/agent-saas-staging/runtime/server/data/users.json',
    selfSignup: { ...(config.auth?.selfSignup ?? {}), enabled: false },
  };
  delete config.auth.selfSignup.dingtalkLeadWebhook;
  delete config.auth.selfSignup.sms;

  config.dispatch = {
    ...(config.dispatch ?? {}),
    enabled: true,
    env: {},
  };
  config.toolControls = { ...(config.toolControls ?? {}), enabled: true };
  config.serverRemote = undefined;
  config.tenantRemoteHands = {
    hands: [
      {
        id: 'agent-saas-staging-acs',
        description: 'Isolated Staging ACS coding runtime',
        baseUrl: 'http://127.0.0.1:3410',
        authTokenRef: 'STAGING_AGENT_SAAS/acs-token',
        invokeTimeoutMs: 600_000,
        rollout: { mode: 'all' },
        networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
      },
    ],
  };
  config.runtimeEventStore = {
    backend: 'pg',
    connectionString: databaseUrl,
    tablePrefix: 'staging_runtime',
    poolMax: 10,
  };
  config.runtimeScheduler = {
    ...(config.runtimeScheduler ?? {}),
    autoWake: true,
    maxConcurrentRuns: 10,
    foregroundReservedRuns: 2,
    maxConfigurableConcurrentRuns: 10,
  };
  config.secretVault = {
    backend: 'encrypted-file',
    filePath: '/mnt/agent-saas-staging/runtime/vault/secrets.enc',
    encryptionKeyEnv: 'STAGING_AGENT_SAAS_VAULT_KEY',
  };
  config.egress = {
    server: {
      enabled: true,
      proxyUrl: 'http://127.0.0.1:3128',
      matchDomains: [],
      bypassDomains: [],
      timeoutMs: 20_000,
      failOpen: false,
    },
    sandbox: { enabled: false, proxyUrl: '', noProxy: [] },
    packageMirrors: {
      enabled: false,
      pipIndexUrl: '',
      pipTrustedHost: '',
      npmRegistry: '',
    },
  };

  return JSON.parse(JSON.stringify(config));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sourcePath, outputPath, capabilityPath] = process.argv.slice(2);
  if (!sourcePath || !outputPath || !capabilityPath) {
    throw new Error('usage: render-config.mjs <source-config.json> <output-config.json> <staging-capabilities.json>');
  }
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const capabilityConfig = await readFile(capabilityPath, 'utf8');
  const rendered = renderStagingConfig(source, {
    ...process.env,
    STAGING_CAPABILITY_CONFIG_JSON: capabilityConfig,
  });
  await writeFile(outputPath, `${JSON.stringify(rendered, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}
