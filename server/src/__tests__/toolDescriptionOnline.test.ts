import express from 'express';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAppConfig } from '../app/config.js';
import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import { createToolControlsAdminRouter } from '../routes/toolControlsAdmin.js';
import { createToolDescriptionRuntimeRefresh } from '../app/toolDescriptionRuntimeRefresh.js';
import {
  mergeToolDescriptionOverrides,
  ToolDescriptionConflictError,
  type ToolDescriptionSnapshot,
  type ToolDescriptionStore,
} from '../data/toolDescriptionStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tool-description-online-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const processCwd = join(root, 'server');
  await mkdir(processCwd);
  const configPath = join(root, 'config.json');
  const config = parseAppConfig({
    agent: { cwd: root },
    server: { port: 3200 },
    toolControls: {
      tools: {
        Shell: { enabled: false, descriptionOverride: { mode: 'append', text: 'legacy override' } },
      },
    },
  });
  const before = JSON.stringify(config);
  await writeFile(configPath, before);
  let snapshot: ToolDescriptionSnapshot = { revision: '0', overrides: {} };
  const store: ToolDescriptionStore = {
    get: vi.fn(async () => structuredClone(snapshot)),
    update: vi.fn(async (id, override, expected) => {
      if (snapshot.revision !== expected) throw new ToolDescriptionConflictError();
      snapshot = {
        revision: String(Number(snapshot.revision) + 1),
        overrides: { ...snapshot.overrides, [id]: override },
      };
      return structuredClone(snapshot);
    }),
  };
  const service = new AdminConfigMutationService({
    processCwd,
    configPath,
    environment: 'production',
    processRole: 'ws-only',
  });
  const mutate = vi.spyOn(service, 'mutate');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
    next();
  });
  app.use(
    '/tools',
    createToolControlsAdminRouter({
      processCwd,
      config,
      configMutationService: service,
      toolDescriptionStore: store,
      requireRevision: true,
    }),
  );
  const server = app.listen(0);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const base = `http://127.0.0.1:${address.port}/tools`;
  const get = async () => (await fetch(base)).json();
  const put = async (body: unknown, tool = 'Shell') =>
    fetch(`${base}/${tool}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { config, configPath, before, store, mutate, get, put };
}

describe('production online tool descriptions', () => {
  it('saves and clears legacy overrides without changing release identity or enabled state; workers read next run', async () => {
    const f = await fixture();
    const initial = await f.get();
    const saved = await f.put({
      expectedRevision: initial.revision,
      expectedDescriptionRevision: initial.descriptionRevision,
      descriptionOverride: { mode: 'append', text: 'new guidance' },
    });
    expect(saved.status).toBe(200);
    const result = await saved.json();
    expect(result.revision).toBe(initial.revision);
    expect(result.descriptionRevision).not.toBe(initial.descriptionRevision);
    expect(result.tools.find((tool: { id: string }) => tool.id === 'Shell')).toMatchObject({
      enabled: false,
      effectiveDescription: expect.stringContaining('new guidance'),
    });
    const target = { toolControls: f.config.toolControls };
    const refresh = createToolDescriptionRuntimeRefresh({
      store: f.store,
      config: f.config,
      target,
      refreshConfig: () => true,
    });
    expect(await refresh()).toBe(true);
    expect(target.toolControls?.tools?.Shell.descriptionOverride?.text).toBe('new guidance');
    expect(f.config.toolControls?.tools?.Shell.descriptionOverride?.text).toBe('legacy override');
    const cleared = await f.put({
      expectedRevision: result.revision,
      expectedDescriptionRevision: result.descriptionRevision,
      descriptionOverride: null,
    });
    expect(cleared.status).toBe(200);
    const visible = (await f.get()).tools.find((tool: { id: string }) => tool.id === 'Shell');
    expect(visible.descriptionOverride).toBeUndefined();
    expect(visible.effectiveDescription).toBe(visible.description);
    expect(await refresh()).toBe(true);
    expect(target.toolControls?.tools?.Shell).toEqual({ enabled: false });
    expect(
      mergeToolDescriptionOverrides(f.config.toolControls, (await f.store.get()).overrides)?.tools
        ?.Shell,
    ).toEqual({ enabled: false });
    expect(await readFile(f.configPath, 'utf8')).toBe(f.before);
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it('rejects missing/stale dynamic revisions and mixed settings writes', async () => {
    const f = await fixture();
    const initial = await f.get();
    const payload = {
      expectedRevision: initial.revision,
      expectedDescriptionRevision: initial.descriptionRevision,
      descriptionOverride: { mode: 'append', text: 'first' },
    };
    expect((await f.put({ descriptionOverride: null })).status).toBe(409);
    expect((await f.put({ ...payload, enabled: true })).status).toBe(400);
    expect((await f.put(payload)).status).toBe(200);
    const stale = await f.put({ ...payload, descriptionOverride: null });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'TOOL_DESCRIPTION_CONFLICT' });
    expect(f.store.update).toHaveBeenCalledTimes(1);
  });

  it('retains description schema/invariant checks and production settings gate', async () => {
    const f = await fixture();
    const initial = await f.get();
    const payload = {
      expectedRevision: initial.revision,
      expectedDescriptionRevision: initial.descriptionRevision,
    };
    for (const descriptionOverride of [
      { mode: 'invalid', text: 'x' },
      { mode: 'append', text: 'x'.repeat(4001) },
      { mode: 'replace', text: 'lost runtime constraints' },
    ]) {
      expect((await f.put({ ...payload, descriptionOverride }, 'Read')).status).toBe(400);
    }
    expect(f.store.update).not.toHaveBeenCalled();
    const enabled = await f.put({ expectedRevision: initial.revision, enabled: true });
    expect(enabled.status).toBe(409);
    expect(await enabled.json()).toMatchObject({ code: 'PRODUCTION_CONFIG_PUBLISH_REQUIRED' });
    expect(await readFile(f.configPath, 'utf8')).toBe(f.before);
  });

  it('does not admit a run after config or description refresh fails', async () => {
    const f = await fixture();
    const target = { toolControls: f.config.toolControls };
    const refreshConfig = vi.fn(() => false);
    const refresh = createToolDescriptionRuntimeRefresh({
      store: f.store,
      config: f.config,
      target,
      refreshConfig,
    });
    expect(await refresh()).toBe(false);
    expect(f.store.get).not.toHaveBeenCalled();
    refreshConfig.mockReturnValue(true);
    vi.mocked(f.store.get).mockRejectedValue(new Error('database unavailable'));
    expect(await refresh()).toBe(false);
    expect(target.toolControls).toBe(f.config.toolControls);
  });
});
