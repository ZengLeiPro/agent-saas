import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAppConfig, parseAppConfig } from '../app/config.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createToolControlsAdminRouter } from '../routes/toolControlsAdmin.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const servers: Array<{ close: () => void }> = [];
const roots: string[] = [];
const minimalConfig = { agent: { cwd: '/tmp/agent' }, server: { port: 3200 } };

async function withApp<T>(
  rawConfig: Record<string, unknown>,
  options: Partial<Parameters<typeof createToolControlsAdminRouter>[0]>,
  run: (context: {
    baseUrl: string;
    configPath: string;
    processCwd: string;
    runtimeConfig: ReturnType<typeof parseAppConfig>;
  }) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'tool-controls-baseline-'));
  roots.push(root);
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
  const runtimeConfig = parseAppConfig(rawConfig);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID,
    };
    next();
  });
  app.use('/api/admin/tool-controls', createToolControlsAdminRouter({
    processCwd,
    config: runtimeConfig,
    ...options,
  }));

  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return run({
    baseUrl: `http://127.0.0.1:${address.port}`,
    configPath,
    processCwd,
    runtimeConfig,
  });
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('tool controls full config baseline', () => {
  it('whole-package save preserves unloaded fields and identity sees complete config', async () => {
    const diskConfig = {
      ...minimalConfig,
      stt: { enabled: false, model: 'disk-only-stt' },
    };
    const staleRuntimeConfig = parseAppConfig(minimalConfig);
    let identityStt: unknown;
    const ensureConfigBaselineApplied = vi.fn(async (expectedText: string) => {
      Object.assign(staleRuntimeConfig, parseAppConfig(JSON.parse(expectedText)));
      return true;
    });
    const onConfigReloaded = vi.fn(async () => {
      identityStt = structuredClone(staleRuntimeConfig.stt);
    });

    await withApp(diskConfig, {
      config: staleRuntimeConfig,
      ensureConfigBaselineApplied,
      onConfigReloaded,
    }, async ({ baseUrl, configPath, processCwd }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: { Read: { enabled: false } } },
          webTools: null,
        }),
      });

      expect(response.status).toBe(200);
      expect(ensureConfigBaselineApplied).toHaveBeenCalledWith(before);
      expect(loadAppConfig(processCwd).stt?.model).toBe('disk-only-stt');
      expect(staleRuntimeConfig.stt?.model).toBe('disk-only-stt');
      expect(identityStt).toEqual(staleRuntimeConfig.stt);
    });
  });

  it('whole-package baseline false has no secret, disk, runtime, or identity side effects', async () => {
    const secretVault = new InMemorySecretVault();
    const putSecret = vi.spyOn(secretVault, 'putSecret');
    const validateToolSettingsConfig = vi.fn();
    const onToolSettingsUpdated = vi.fn();
    const onConfigReloaded = vi.fn();
    const ensureConfigBaselineApplied = vi.fn(async () => false);

    await withApp(minimalConfig, {
      secretVault,
      validateToolSettingsConfig,
      onToolSettingsUpdated,
      onConfigReloaded,
      ensureConfigBaselineApplied,
    }, async ({ baseUrl, configPath, runtimeConfig }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: { WebSearch: { enabled: true } } },
          webTools: {
            enabled: true,
            search: { enabled: true, provider: 'tencent_wsa', apiKey: 'must-not-store' },
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig.webTools).toBeUndefined();
      expect(putSecret).not.toHaveBeenCalled();
      expect(validateToolSettingsConfig).not.toHaveBeenCalled();
      expect(onToolSettingsUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    });
  });

  it('whole-package file change during baseline returns 409 before secret or callbacks', async () => {
    const secretVault = new InMemorySecretVault();
    const putSecret = vi.spyOn(secretVault, 'putSecret');
    const validateToolSettingsConfig = vi.fn();
    const onToolSettingsUpdated = vi.fn();
    const onConfigReloaded = vi.fn();
    let configPathForBaseline = '';
    const ensureConfigBaselineApplied = vi.fn(async () => {
      writeFileSync(
        configPathForBaseline,
        JSON.stringify({ ...minimalConfig, concurrentWinner: true }),
        'utf-8',
      );
      return true;
    });

    await withApp(minimalConfig, {
      secretVault,
      validateToolSettingsConfig,
      onToolSettingsUpdated,
      onConfigReloaded,
      ensureConfigBaselineApplied,
    }, async ({ baseUrl, configPath, runtimeConfig }) => {
      configPathForBaseline = configPath;
      const response = await fetch(`${baseUrl}/api/admin/tool-controls`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolControls: { tools: { WebSearch: { enabled: true } } },
          webTools: {
            enabled: true,
            search: { enabled: true, provider: 'tencent_wsa', apiKey: 'must-not-store' },
          },
        }),
      });

      expect(response.status).toBe(409);
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).concurrentWinner).toBe(true);
      expect(runtimeConfig.webTools).toBeUndefined();
      expect(putSecret).not.toHaveBeenCalled();
      expect(validateToolSettingsConfig).not.toHaveBeenCalled();
      expect(onToolSettingsUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    });
  });

  it('single-tool baseline false rejects before validation, runtime, disk, or identity changes', async () => {
    const validateToolSettingsConfig = vi.fn();
    const onToolSettingsUpdated = vi.fn();
    const onConfigReloaded = vi.fn();
    const ensureConfigBaselineApplied = vi.fn(async () => false);

    await withApp(minimalConfig, {
      validateToolSettingsConfig,
      onToolSettingsUpdated,
      onConfigReloaded,
      ensureConfigBaselineApplied,
    }, async ({ baseUrl, configPath, runtimeConfig }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(response.status).toBe(400);
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
      expect(runtimeConfig.toolControls?.tools?.Read).toBeUndefined();
      expect(validateToolSettingsConfig).not.toHaveBeenCalled();
      expect(onToolSettingsUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    });
  });

  it('single-tool file change during baseline returns 409 without callbacks', async () => {
    const validateToolSettingsConfig = vi.fn();
    const onToolSettingsUpdated = vi.fn();
    const onConfigReloaded = vi.fn();
    let configPathForBaseline = '';
    const ensureConfigBaselineApplied = vi.fn(async () => {
      writeFileSync(
        configPathForBaseline,
        JSON.stringify({ ...minimalConfig, concurrentWinner: true }),
        'utf-8',
      );
      return true;
    });

    await withApp(minimalConfig, {
      validateToolSettingsConfig,
      onToolSettingsUpdated,
      onConfigReloaded,
      ensureConfigBaselineApplied,
    }, async ({ baseUrl, configPath, runtimeConfig }) => {
      configPathForBaseline = configPath;
      const response = await fetch(`${baseUrl}/api/admin/tool-controls/Read`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(response.status).toBe(409);
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).concurrentWinner).toBe(true);
      expect(runtimeConfig.toolControls?.tools?.Read).toBeUndefined();
      expect(validateToolSettingsConfig).not.toHaveBeenCalled();
      expect(onToolSettingsUpdated).not.toHaveBeenCalled();
      expect(onConfigReloaded).not.toHaveBeenCalled();
    });
  });
});
