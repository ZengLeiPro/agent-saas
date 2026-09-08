#!/usr/bin/env python3
"""Temporary, exact-source patch builder; removed before the PR is opened."""
from pathlib import Path
import re


def replace_once(text, old, new):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'Expected one occurrence, got {count}: {old[:120]!r}')
    return text.replace(old, new, 1)


def create(path, text):
    target = Path(path)
    if target.exists():
        raise RuntimeError(f'Refusing to replace existing new file: {path}')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text.lstrip('\n'), encoding='utf-8')


create('shared/src/configWritePolicy.ts', r'''
/** Display contract only. The server mutation service remains the write authority. */
export const PRODUCTION_CONFIG_PUBLISH_REQUIRED = 'PRODUCTION_CONFIG_PUBLISH_REQUIRED' as const;
export const PRODUCTION_CONFIG_PUBLISH_MESSAGE = '生产配置不能直接在线保存，请通过受控配置发布流程变更';
export type ConfigEnvironment = 'staging' | 'production' | 'development' | 'test';
export type ConfigWritePolicy =
  | { environment: ConfigEnvironment; mode: 'online'; canSave: true }
  | {
      environment: 'production';
      mode: 'controlled-publish-required';
      canSave: false;
      reasonCode: typeof PRODUCTION_CONFIG_PUBLISH_REQUIRED;
      message: string;
    };

/** allowProductionMutation is an INTERNAL publisher option, never an HTTP input. */
export function getConfigWritePolicy(
  environment: ConfigEnvironment,
  allowProductionMutation = false,
): ConfigWritePolicy {
  if (environment === 'production' && !allowProductionMutation) {
    return {
      environment,
      mode: 'controlled-publish-required',
      canSave: false,
      reasonCode: PRODUCTION_CONFIG_PUBLISH_REQUIRED,
      message: PRODUCTION_CONFIG_PUBLISH_MESSAGE,
    };
  }
  return { environment, mode: 'online', canSave: true };
}

/** A missing/unknown/inconsistent capability is NOT permission to write. */
export function parseConfigWritePolicy(value: unknown): ConfigWritePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  const environment = policy.environment;
  if (environment !== 'staging' && environment !== 'production'
    && environment !== 'development' && environment !== 'test') return null;
  if (policy.mode === 'online' && policy.canSave === true
    && policy.reasonCode === undefined) {
    return { environment, mode: 'online', canSave: true };
  }
  if (environment === 'production' && policy.mode === 'controlled-publish-required'
    && policy.canSave === false && policy.reasonCode === PRODUCTION_CONFIG_PUBLISH_REQUIRED
    && typeof policy.message === 'string' && policy.message.trim()) {
    return {
      environment,
      mode: 'controlled-publish-required',
      canSave: false,
      reasonCode: PRODUCTION_CONFIG_PUBLISH_REQUIRED,
      message: policy.message,
    };
  }
  return null;
}
''')

create('shared/src/configWritePolicy.test.ts', r'''
import { describe, expect, it } from 'vitest';
import {
  getConfigWritePolicy,
  parseConfigWritePolicy,
  PRODUCTION_CONFIG_PUBLISH_REQUIRED,
} from './configWritePolicy';

describe('config write capability contract', () => {
  it.each(['staging', 'development', 'test'] as const)('%s permits the existing online path', (environment) => {
    expect(getConfigWritePolicy(environment)).toEqual({ environment, mode: 'online', canSave: true });
  });
  it('production defaults to the same fail-closed policy as mutate', () => {
    const policy = getConfigWritePolicy('production');
    expect(policy).toMatchObject({ environment: 'production', canSave: false, reasonCode: PRODUCTION_CONFIG_PUBLISH_REQUIRED });
    expect(parseConfigWritePolicy(policy)).toEqual(policy);
  });
  it('retains the existing INTERNAL controlled-publisher option', () => {
    expect(getConfigWritePolicy('production', true)).toEqual({ environment: 'production', mode: 'online', canSave: true });
  });
  it.each([
    undefined, null, [], {}, true,
    { environment: 'unknown', mode: 'online', canSave: true },
    { environment: 'production', mode: 'online', canSave: 'true' },
    { environment: 'production', mode: 'online', canSave: false },
    { environment: 'production', mode: 'online', canSave: true, reasonCode: PRODUCTION_CONFIG_PUBLISH_REQUIRED },
    { environment: 'production', mode: 'controlled-publish-required', canSave: true },
    { environment: 'production', mode: 'controlled-publish-required', canSave: false },
    { ...getConfigWritePolicy('production'), environment: 'staging' },
    { ...getConfigWritePolicy('production'), message: '' },
    { ...getConfigWritePolicy('production'), message: '  ' },
  ])('does not interpret malformed metadata as write permission: %j', (input) => {
    expect(parseConfigWritePolicy(input)).toBeNull();
  });
  it('round trips a supported online capability', () => {
    const policy = getConfigWritePolicy('staging');
    expect(parseConfigWritePolicy(policy)).toEqual(policy);
  });
});
''')

path = Path('server/src/config/adminConfigMutationService.ts')
text = path.read_text()
text = replace_once(text, "import { spawn } from 'node:child_process';", "import { getConfigWritePolicy, PRODUCTION_CONFIG_PUBLISH_MESSAGE, PRODUCTION_CONFIG_PUBLISH_REQUIRED, type ConfigWritePolicy } from '@agent/shared/configWritePolicy';\nimport { spawn } from 'node:child_process';")
text = replace_once(text, "  readonly code = 'PRODUCTION_CONFIG_PUBLISH_REQUIRED';", "  readonly code = PRODUCTION_CONFIG_PUBLISH_REQUIRED;\n  readonly writePolicy = getConfigWritePolicy('production');")
text = replace_once(text, "    super('生产配置不能直接在线保存，请通过受控配置发布流程变更');", "    super(PRODUCTION_CONFIG_PUBLISH_MESSAGE);")
text = replace_once(text, '  async mutate(input: MutationInput): Promise<AdminConfigMutationResult> {', '''  /** Authoritative capability for the configured service, not client-supplied environment. */
  getWritePolicy(): ConfigWritePolicy {
    return getConfigWritePolicy(this.options.environment, this.options.allowProductionMutation === true);
  }

  async mutate(input: MutationInput): Promise<AdminConfigMutationResult> {''')
text = replace_once(text, "    if (this.options.environment === 'production' && this.options.allowProductionMutation !== true) {", "    if (!this.getWritePolicy().canSave) {")
path.write_text(text)

path = Path('server/src/config/adminConfigMutationHttp.ts')
text = path.read_text()
text = replace_once(text, '''  if (error instanceof ProductionConfigPublishRequiredError) {
    res.status(409).json({ error: error.message, code: error.code });''', '''  if (error instanceof ProductionConfigPublishRequiredError) {
    res.status(409).json({ error: error.message, code: error.code, writePolicy: error.writePolicy });''')
path.write_text(text)

path = Path('server/src/routes/modelsAdmin.ts')
text = path.read_text()
text = replace_once(text, '  AdminConfigMutationService,\n', '  AdminConfigMutationService,\n  ProductionConfigPublishRequiredError,\n')
text = replace_once(text, '    res.json({\n      revision,\n', '    res.json({\n      revision,\n      writePolicy: configMutationService.getWritePolicy(),\n')
text = replace_once(text, '      res.json({\n        revision: result.revision,\n', '      res.json({\n        revision: result.revision,\n        writePolicy: configMutationService.getWritePolicy(),\n')
text = replace_once(text, '''        error instanceof Error
        && !(error instanceof ConfigConflictError)''', '''        error instanceof Error
        && !(error instanceof ProductionConfigPublishRequiredError)
        && !(error instanceof ConfigConflictError)''')
path.write_text(text)

create('server/src/__tests__/modelsAdminProductionWritePolicy.test.ts', r'''
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getConfigWritePolicy, type ConfigEnvironment } from '@agent/shared/configWritePolicy';
import { parseAppConfig } from '../app/config.js';
import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createModelsAdminRouter } from '../routes/modelsAdmin.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { baseRawConfig } from './helpers/modelsAdminFixture.js';

async function withServer(
  environment: ConfigEnvironment,
  run: (fixture: {
    url: string;
    before: string;
    configPath: string;
    processCwd: string;
    raw: ReturnType<typeof baseRawConfig>;
    service: AdminConfigMutationService;
    vault: InMemorySecretVault;
    onModelsUpdated: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  authenticated = true,
) {
  const root = mkdtempSync(join(tmpdir(), 'model-write-policy-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd);
  const configPath = join(root, 'config.json');
  const raw = baseRawConfig();
  const before = JSON.stringify(raw, null, 2);
  writeFileSync(configPath, before);
  const vault = new InMemorySecretVault();
  const onModelsUpdated = vi.fn();
  const service = new AdminConfigMutationService({ configPath, processCwd, environment, processRole: 'all' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticated) Object.assign(req, { user: { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID } });
    next();
  });
  app.use('/api/admin/models', createModelsAdminRouter({
    processCwd, config: parseAppConfig(raw), configMutationService: service,
    secretVault: vault, onModelsUpdated,
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    await run({ url: `http://127.0.0.1:${address.port}/api/admin/models`, before, configPath, processCwd, raw, service, vault, onModelsUpdated });
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    rmSync(root, { recursive: true, force: true });
  }
}

describe('models production write policy', () => {
  it('GET advertises the actual service policy without changing config or credentials', async () => {
    await withServer('production', async ({ url, before, configPath, vault, service }) => {
      const put = vi.spyOn(vault, 'putSecret');
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.writePolicy).toEqual(service.getWritePolicy());
      expect(data.writePolicy).toEqual(getConfigWritePolicy('production'));
      expect(response.headers.get('etag')).toBe(`"${data.revision}"`);
      expect(data.models.groups[0].apiKey).toBeUndefined();
      expect(data.memoryIndex.embedding.apiKey).toBeUndefined();
      expect(readFileSync(configPath, 'utf8')).toBe(before);
      expect(put).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])('PUT preserves 409 + stable code, even with invalid candidate=%s', async (invalid) => {
    await withServer('production', async ({ url, before, configPath, raw, vault, onModelsUpdated }) => {
      const put = vi.spyOn(vault, 'putSecret');
      const revoke = vi.spyOn(vault, 'revokeSecret');
      const current = await (await fetch(url)).json();
      const response = await fetch(url, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: invalid ? null : raw.models,
          expectedRevision: current.revision,
          environment: 'development', allowProductionMutation: true,
          writePolicy: { environment: 'development', mode: 'online', canSave: true },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: '生产配置不能直接在线保存，请通过受控配置发布流程变更',
        code: 'PRODUCTION_CONFIG_PUBLISH_REQUIRED',
        writePolicy: getConfigWritePolicy('production'),
      });
      expect(readFileSync(configPath, 'utf8')).toBe(before);
      expect(put).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(onModelsUpdated).not.toHaveBeenCalled();
    });
  });

  it.each(['staging', 'development', 'test'] as const)('%s advertises writable without weakening server authority', async (environment) => {
    await withServer(environment, async ({ url }) => {
      const data = await (await fetch(url)).json();
      expect(data.writePolicy).toEqual(getConfigWritePolicy(environment));
    });
  });

  it('non-production saves still apply and return the policy alongside a new revision', async () => {
    await withServer('test', async ({ url, raw, configPath, onModelsUpdated }) => {
      const current = await (await fetch(url)).json();
      const response = await fetch(url, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: current.revision,
          models: { ...raw.models, allowCrossGroupSwitch: !raw.models.allowCrossGroupSwitch },
        }),
      });
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved.writePolicy).toEqual(getConfigWritePolicy('test'));
      expect(saved.revision).not.toBe(current.revision);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).models.allowCrossGroupSwitch).toBe(!raw.models.allowCrossGroupSwitch);
      expect(onModelsUpdated).toHaveBeenCalledOnce();
    });
  });

  it('unauthenticated requests cannot use the policy endpoint to read model configuration', async () => {
    await withServer('production', async ({ url }) => {
      const response = await fetch(url);
      expect([401, 403]).toContain(response.status);
      const body = await response.json();
      expect(body.models).toBeUndefined();
      expect(body.writePolicy).toBeUndefined();
    }, false);
  });
});
''')

path = Path('web/src/components/ModelManager/index.tsx')
text = path.read_text()
start = text.index('type ModelProtocol = ')
end = text.index('type SelectedPanel = ')
types = text[start:end]
constants = 'const DEFAULT_PROTOCOL: ModelProtocol = "chat_completions";\nconst INHERIT_PROTOCOL = "__inherit__";\n'
types = replace_once(types, constants, '')
types = re.sub(r'^type ', 'export type ', types, flags=re.MULTILINE)
types = replace_once(types, '  revision: string; models: EditableModelsConfig;', '  writePolicy?: ConfigWritePolicy;\n  revision: string; models: EditableModelsConfig;')
create('web/src/components/ModelManager/modelConfigTypes.ts', '''import type { ConfigWritePolicy } from "@agent/shared/configWritePolicy";
import type { ModelList } from "@/types/models";
import type { EditableQuotaSource } from "./GroupCredentialsFields";
import type { UtilityModelAdminFields } from "./UtilityModelSettings";

''' + types)
text = text[:start] + '''import type {
  ModelProtocol, ResponsesTransport, McpLoadingMode, ToolSearchProtocol, EditableModel,
  EditableGroup, EditableModelsConfig, EditableMemoryIndexConfig, AdminModelsResponse,
} from "./modelConfigTypes";
import { useModelWritePolicy } from "./useModelWritePolicy";

''' + constants + '\n' + text[end:]
text = replace_once(text, 'import type { ModelList } from "@/types/models";\n', '')
text = replace_once(text, ', type EditableQuotaSource } from "./GroupCredentialsFields";', ' } from "./GroupCredentialsFields";')
text = replace_once(text, ', type UtilityModelAdminFields } from "./UtilityModelSettings";', ' } from "./UtilityModelSettings";')
text = replace_once(text, '  const { platformReadOnly } = useAuth();', '''  const { platformReadOnly: accountReadOnly } = useAuth();
  const { readOnly: platformReadOnly, acceptPolicy, acceptFailure, assertWritable, notice } = useModelWritePolicy(accountReadOnly);''')
text = replace_once(text, '  const refresh = useCallback(async () => {\n    setLoading(true);', '  const refresh = useCallback(async () => {\n    setLoading(true);\n    setSavedAt(null);')
text = text.replace('Partial<AdminModelsResponse> & { error?: string }', 'Partial<AdminModelsResponse> & { error?: string; code?: string }')
anchor = '      setRevision(data.revision); setModels(data.models);'
if text.count(anchor) != 2:
    raise RuntimeError('Expected GET and PUT hydration anchors')
text = text.replace(anchor, '      acceptPolicy(data.writePolicy);\n' + anchor)
text = replace_once(text, '''    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);''', '''    } catch (err) {
      acceptPolicy(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);''')
text = replace_once(text, '  }, [hydrateAdvancedText, titleSettings.applyResponse]);', '  }, [acceptPolicy, hydrateAdvancedText, titleSettings.applyResponse]);')
text = replace_once(text, '''  const save = useCallback(async () => {
    setSaving(true);
    try {''', '''  const save = useCallback(async () => {
    setSaving(true);
    setSavedAt(null);
    try {
      assertWritable();''')
start = text.index('  const save = useCallback(')
head, tail = text[:start], text[start:]
anchor = '      if (!res.ok || !data.revision || !data.models || !data.titleGenerator || !data.titleSystemPrompt)'
tail = replace_once(tail, anchor, '      if (!res.ok) acceptFailure(data);\n' + anchor)
text = head + tail
text = replace_once(text, '  }, [buildPayload, hydrateAdvancedText, revision, titleSettings.applyResponse]);', '  }, [acceptFailure, acceptPolicy, assertWritable, buildPayload, hydrateAdvancedText, revision, titleSettings.applyResponse]);')
text = replace_once(text, 'disabled={platformReadOnly || saving || !models}', 'disabled={platformReadOnly || loading || saving || !models}')
text = replace_once(text, '      {error && <div', '      {notice && <div role="status" className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">{notice}</div>}\n      {error && <div')
# Navigation remains available. Only editing widgets are disabled; use native fieldsets
# for the many existing form controls, avoiding incomplete per-input allowlists.
start = text.index('          {selectedPanel.type === "general" && (')
head, tail = text[:start], text[start:]
tail = tail.replace('<CardContent', '<fieldset disabled={platformReadOnly || saving} className="m-0 min-w-0 border-0 p-0"><CardContent')
tail = tail.replace('</CardContent>', '</CardContent></fieldset>')
tail = replace_once(tail, '<CodexSubscriptionCard readOnly={platformReadOnly} />', '<CodexSubscriptionCard readOnly={accountReadOnly} />')
text = head + tail
# Drag and keyboard sort handles are actual write controls, unlike panel navigation.
text, count = re.subn(r'^(\s*)draggable\s*$', r'\1draggable={!platformReadOnly && !saving}\n\1disabled={platformReadOnly || saving}', text, flags=re.MULTILINE)
if count != 2:
    raise RuntimeError(f'Expected two drag handles, found {count}')
text = text.replace('if (draggingItem?.type !== "group") return;', 'if (platformReadOnly || saving || draggingItem?.type !== "group") return;')
text = text.replace('if (draggingItem?.type !== "model"', 'if (platformReadOnly || saving || draggingItem?.type !== "model"')
path.write_text(text)

create('web/src/components/ModelManager/useModelWritePolicy.ts', r'''
import { useCallback, useState } from 'react';
import {
  getConfigWritePolicy, parseConfigWritePolicy, PRODUCTION_CONFIG_PUBLISH_REQUIRED,
  type ConfigWritePolicy,
} from '@agent/shared/configWritePolicy';

const UNKNOWN_POLICY = '尚未取得服务端配置写入策略，暂不可修改。请刷新后重试。';
const PRODUCTION_NOTICE = '生产环境：当前部署尚未提供生产配置在线发布能力，模型配置仅可查看。需通过已验证的受控运维流程变更；重复保存或刷新不会解除此限制。';

/** UI capability is read from this endpoint, never inferred from hostname or NODE_ENV. */
export function useModelWritePolicy(accountReadOnly: boolean) {
  const [policy, setPolicy] = useState<ConfigWritePolicy | null>(null);
  const acceptPolicy = useCallback((value: unknown) => { setPolicy(parseConfigWritePolicy(value)); }, []);
  const acceptFailure = useCallback((value: { code?: string }) => {
    if (value.code === PRODUCTION_CONFIG_PUBLISH_REQUIRED) {
      // Preserve the local draft; only withdraw permission after an authoritative denial.
      setPolicy(getConfigWritePolicy('production'));
    }
  }, []);
  const readOnly = accountReadOnly || policy?.canSave !== true;
  const notice = accountReadOnly
    ? '当前账号只有查看权限，不能保存模型配置。'
    : !policy ? UNKNOWN_POLICY
      : !policy.canSave ? PRODUCTION_NOTICE
        : policy.environment === 'production' ? '当前为生产环境；保存仅修改当前环境。'
          : policy.environment === 'staging' ? '当前为测试环境；保存仅修改当前环境。'
            : null;
  const assertWritable = useCallback(() => {
    if (readOnly) throw new Error(notice ?? UNKNOWN_POLICY);
  }, [notice, readOnly]);
  return { readOnly, acceptPolicy, acceptFailure, assertWritable, notice };
}
''')

path = Path('web/src/components/ModelManager/index.test.tsx')
text = path.read_text()
text = replace_once(text, 'import { ModelManager } from "./index";', 'import { ModelManager } from "./index";\nimport { getConfigWritePolicy } from "@agent/shared/configWritePolicy";')
text = replace_once(text, '''function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {''', '''function jsonResponse(body: unknown): Response {
  const responseBody = body && typeof body === "object" && "models" in body
    ? { writePolicy: getConfigWritePolicy("test"), ...body } : body;
  return new Response(JSON.stringify(responseBody), {''')
path.write_text(text)

create('web/src/components/ModelManager/writePolicy.test.tsx', r'''
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigWritePolicy, type ConfigWritePolicy } from '@agent/shared/configWritePolicy';
import { authFetch } from '@/lib/authFetch';
import { ModelManager } from './index';

const auth = vi.hoisted(() => ({ platformReadOnly: false }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));
vi.mock('@/lib/refreshBus', () => ({ refreshAll: vi.fn(async () => undefined) }));
vi.mock('./CodexSubscriptionCard', () => ({
  CodexSubscriptionCard: ({ readOnly }: { readOnly: boolean }) => <button disabled={readOnly}>独立订阅授权</button>,
}));

const models = {
  default: 'main/gpt', allowCrossGroupSwitch: true,
  groups: [{ id: 'main', name: '主分组', models: [
    { id: 'gpt', name: 'GPT', value: 'gpt-5' },
    { id: 'mini', name: 'Mini', value: 'mini' },
  ] }],
};
let policy: ConfigWritePolicy | undefined;
let denySave: boolean;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function view() {
  return {
    revision: 'rev-1', models, memoryIndex: null, writePolicy: policy,
    titleGenerator: { model: 'main/gpt', fallbackModels: [] },
    titleSystemPrompt: { content: '标题', defaultContent: '标题', overridden: false },
    publicModelList: models,
  };
}
function putCalls() {
  return vi.mocked(authFetch).mock.calls.filter(([path, init]) => path === '/api/admin/models' && init?.method === 'PUT');
}

beforeEach(() => {
  auth.platformReadOnly = false;
  policy = getConfigWritePolicy('production');
  denySave = false;
  vi.mocked(authFetch).mockReset();
  vi.mocked(authFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') {
      if (denySave) return json({ error: '生产配置不能直接在线保存，请通过受控配置发布流程变更', code: 'PRODUCTION_CONFIG_PUBLISH_REQUIRED' }, 409);
      const payload = JSON.parse(String(init.body));
      return json({ ...view(), models: payload.models, revision: 'rev-2' });
    }
    return json(view());
  });
});

describe('ModelManager write capability', () => {
  it('shows the production restriction BEFORE editing and keeps navigation usable', async () => {
    const user = userEvent.setup();
    render(<ModelManager />);
    expect(await screen.findByText(/当前部署尚未提供生产配置在线发布能力/)).toBeTruthy();
    const save = screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(putCalls()).toHaveLength(0);
    expect((screen.getByRole('button', { name: '新增模型分组' }) as HTMLButtonElement).disabled).toBe(true);
    // Subscription authorization is a separate API, not part of model-config saving.
    expect((screen.getByRole('button', { name: '独立订阅授权' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: /GPT gpt-5/ }));
    expect(screen.getByDisplayValue('gpt-5').matches(':disabled')).toBe(true);
    const sort = screen.getByRole('button', { name: '调整模型 GPT 的顺序' }) as HTMLButtonElement;
    expect(sort.disabled).toBe(true);
    expect(sort.draggable).toBe(false);
    await user.click(screen.getByRole('button', { name: '主分组' }));
    expect(screen.getByDisplayValue('主分组').matches(':disabled')).toBe(true);
    expect(putCalls()).toHaveLength(0);
  });

  it('does not assume a legacy or unknown backend permits writes', async () => {
    policy = undefined;
    render(<ModelManager />);
    expect(await screen.findByText(/尚未取得服务端配置写入策略/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(true);
    expect(putCalls()).toHaveLength(0);
  });

  it('keeps the existing staging save path', async () => {
    policy = getConfigWritePolicy('staging');
    const user = userEvent.setup();
    render(<ModelManager />);
    expect(await screen.findByText(/当前为测试环境/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(putCalls()).toHaveLength(1);
    expect(JSON.parse(String(putCalls()[0]?.[1]?.body)).expectedRevision).toBe('rev-1');
  });

  it('an account read-only restriction wins over writable server policy', async () => {
    auth.platformReadOnly = true;
    policy = getConfigWritePolicy('staging');
    render(<ModelManager />);
    expect(await screen.findByText(/当前账号只有查看权限/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '独立订阅授权' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a typed production denial withdraws permission without erasing the unsaved draft', async () => {
    policy = getConfigWritePolicy('staging');
    denySave = true;
    const user = userEvent.setup();
    render(<ModelManager />);
    await screen.findByText(/当前为测试环境/);
    await user.click(screen.getByRole('button', { name: /GPT gpt-5/ }));
    fireEvent.change(screen.getByDisplayValue('gpt-5'), { target: { value: 'unsaved-model-value' } });
    await user.click(screen.getByRole('button', { name: '保存并生效' }));
    expect(await screen.findByText(/当前部署尚未提供生产配置在线发布能力/)).toBeTruthy();
    expect(screen.getByDisplayValue('unsaved-model-value')).toBeTruthy();
    expect(screen.queryByText('已保存')).toBeNull();
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(true);
    expect(putCalls()).toHaveLength(1);
  });

  it('a failed refresh withdraws a previously writable capability', async () => {
    policy = getConfigWritePolicy('staging');
    const user = userEvent.setup();
    render(<ModelManager />);
    await screen.findByText(/当前为测试环境/);
    vi.mocked(authFetch).mockResolvedValueOnce(json({ error: '读取失败' }, 503));
    await user.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(screen.getByText(/尚未取得服务端配置写入策略/)).toBeTruthy();
    });
    expect((screen.getByRole('button', { name: '保存并生效' }) as HTMLButtonElement).disabled).toBe(true);
    expect(putCalls()).toHaveLength(0);
  });
});
''')

create('docs/plans/production-model-config-online-save.md', r'''
# 生产模型配置在线保存：分阶段修复与未完成边界

日期：2026-09-08。状态：第一阶段代码修复；生产在线发布事务尚未实现，不能据此宣称生产保存已经恢复。

## 产品目标不变

管理员在当前环境的模型管理页保存，只修改该环境。生产需明确环境、二次确认、并发控制、审计、恢复与跨进程生效确认；不增加 Draft、审批平台，也不要求把 Staging 配置同步到 Production。遵循 `staging-production-config-parity.md` 的产品决策。

## 本阶段实际实现

- 配置服务公开与 `mutate` 使用同一判断的 `getWritePolicy()`；GET 和成功 PUT 返回能力元数据。环境来自服务端 Runtime 装配，客户端的 environment、allowProductionMutation 和 writePolicy 均不是授权输入。
- 生产限制稳定返回 HTTP 409、`PRODUCTION_CONFIG_PUBLISH_REQUIRED` 和写入策略，不再被模型路由的中文关键词匹配降格为 HTTP 400。
- 模型页加载时展示限制；缺少或未知策略也不推断为可写。保留面板导航，禁用配置编辑、增删、复制、拖拽、键盘排序和保存。
- 后端在编辑过程中拒绝写入时，前端撤销写权限但保留未保存草稿，不显示“已保存”。刷新失败也撤销旧可写能力。
- 独立订阅授权入口仍遵循自身权限和后端接口，不被模型配置的只读状态意外关闭。
- 提取纯类型以遵守已有文件行数棘轮，不抬高既有门槛，不新增依赖。

**本阶段没有删除生产门禁，没有向普通 Runtime 管理接口注入 `allowProductionMutation: true`，没有变更 ConfigIdentity 计算、Release identity 或部署脚本。它修复错误契约与误导性交互，但没有恢复生产在线保存。**

## 为什么不能只放开写入

`configIdentityRuntime.ts` 的 expected identity 在装配时绑定发布值。后台写盘后，API / Worker 只重算 observed identity；这不等于更新可信 expected identity。与此同时，`scripts/release/read-live-production-components.mjs` 还验证当前私有快照与 `runtime-identity.json`。只在 API 进程更新 expected、将 observed 无条件接受为 expected，或只添加可写旁路文件，都不构成完整生产发布。

## 后续完整实现需要关闭的契约

### 1. 独立且可信的配置版本权威

将代码制品身份和可在线调整的业务配置版本明确分层。保留不可变的发布基线；每次授权配置事务产生与环境、release、旧版本、目标摘要绑定的配置 revision。权威记录必须能由 API、Worker、部署与回滚工具共同验证。仅由业务进程任意可写的 JSON 不能单独成为可信权威；不得启动时自动接受磁盘漂移。凭据保持 SecretVault 引用，不输出明文。

### 2. 配置事务的阶段与故障语义

建议明确 `prepared -> applying -> applied` 和恢复失败状态。写入前在现有部署共用锁中核对 expectedRevision 与当前基线；完成整份配置及全部辅助模型引用校验、SecretVault 处理和备份，再提交候选。所有异步边界均要处理并发改写、进程崩溃和发布竞争，不能在未胜出的候选上发布 consistent。

API 与 Worker 都要读回目标 revision、目标摘要、当前进程身份及生效时间，且覆盖实际使用的模型解析器、标题/门禁链、定价和 memory.index 派生运行态。不得把“文件已写”“收到事件”或旧的 consistent 快照当作生效证据。未完成读回不能返回普通成功。

### 3. 回滚与凭据生命周期

应用失败时协调恢复配置、全部执行侧派生状态、可信配置版本和观察面。恢复无法证明成功则 fail closed 并保留诊断。旧 Secret 只能在所有相关运行进程不再使用且回滚策略允许时清理；结果不确定不能立即撤销仍可能被执行侧使用的凭据。崩溃恢复不能把半完成事务解释为已成功。

### 4. 发布与重启兼容

同时更新 `configIdentityAssembly.ts`、运行时摘要/Worker readiness、`read-production-state.mjs`、`read-live-production-components.mjs`、生产 deploy / rollback 的基线选择与验证契约。重启、重复发布、发布中断恢复、蓝绿切换和回滚都必须使用同一权威版本，不得把合法在线修改误判成漂移，也不能因此放过未经授权的文件变更。

### 5. 页面与回归验收

受控事务可用后，服务端才公开生产可写能力。原页面显示生产环境和明确确认，仍不新增审批平台。至少覆盖：真实生产模式成功保存、并发 409、无效引用、权限不足、凭据失败、API/Worker 分别失败或超时、读回滞后、提交后维护失败、崩溃/重启、合法修改后发布、回滚、非授权磁盘漂移、双环境隔离及已有测试环境行为。

## 本 PR 的验证边界

新增共享策略、模型 HTTP 路由和页面交互回归，并运行现有模型与配置治理定向测试。执行结果以 PR 的 GitHub Actions 和检查记录为准；本文不是测试通过证明。未连接或修改生产服务器、配置文件、SecretVault、运行时环境或部署资源，也不把单元测试替代真实生产事务验收。
''')

# Keep the line ratchet conservative: only shrink this existing entry.
path = Path('config/max-lines-baseline.txt')
text = path.read_text()
model_lines = len(Path('web/src/components/ModelManager/index.tsx').read_text().splitlines())
if model_lines > 1362:
    raise RuntimeError(f'ModelManager grew past the existing ratchet: {model_lines}')
text = replace_once(text, 'web/src/components/ModelManager/index.tsx\t1362\tproduction', f'web/src/components/ModelManager/index.tsx\t{model_lines}\tproduction')
path.write_text(text)
print(f'Applied exact patch. ModelManager physical lines: {model_lines}. Production mutation guard retained.')
