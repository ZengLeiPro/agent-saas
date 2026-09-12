import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinTools } from '../agent/builtinTools.js';
import { generateTitle } from '../agent/titleGenerator.js';
import { createTitleModelAdapterFactory } from '../app/titleGeneratorConfigs.js';
import { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import { GrokModelCatalogService } from '../runtime/responses/grokModelCatalog.js';
import { createModelAdapterForProtocol } from '../runtime/modelAdapterFactory.js';
import { createRuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import { SUBAGENT_TYPES } from '../runtime/subagent/agentTypes.js';
import { SubagentLimiter } from '../runtime/subagent/subagentLimits.js';
import { runSubagent } from '../runtime/subagent/subagentRunner.js';
import type { ModelProviderOptions } from '../types/index.js';
import { makeFixture, runnerDeps } from './helpers/subagentTestFixture.js';
import { grokFixture, jsonResponse } from './grokTestFixtures.js';
const cleanupDirs = new Set<string>();
afterEach(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  cleanupDirs.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const providerOptions: ModelProviderOptions = {
  protocol: 'responses',
  responsesTransport: 'grok_subscription',
};
const event = (type: string, payload: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
function textResponse(text: string) {
  const message = {
    id: 'fixture-message',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
  const wire =
    event('response.output_text.delta', {
      item_id: 'fixture-message',
      output_index: 0,
      content_index: 0,
      delta: text,
    }) +
    event('response.completed', {
      response: {
        id: 'fixture-response',
        model: 'fixture-model',
        status: 'completed',
        output: [message],
        usage: { input_tokens: 7, output_tokens: 5 },
      },
    });
  return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
}
describe('Grok actual subagent and title entrypoints T29/T33', () => {
  it('runs the real child Agent loop without an API Key, then uses the same ordered account service for title generation', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.invalid/do-not-use');
    const grok = await grokFixture();
    const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
      String(url).endsWith('/models')
        ? jsonResponse({ data: [{ id: 'fixture-model' }] })
        : textResponse('流程核验'),
    );
    const dependencies = {
      grokCredentialManager: grok.manager,
      grokFetch: fetcher as typeof fetch,
      grokModelCatalog: new GrokModelCatalogService(grok.manager, fetcher as typeof fetch),
    };
    const resolve = vi.fn(() => ({ model: 'fixture-model', connection: {}, providerOptions }));
    const fixture = await makeFixture({ cleanupDirs, modelResolver: resolve });
    const factory = vi.fn(
      (connection: { apiKey?: string; baseUrl?: string }, options?: ModelProviderOptions) =>
        createModelAdapterForProtocol(connection, options, dependencies),
    );
    const outcome = await runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [createBuiltinTools()],
      agentType: SUBAGENT_TYPES.general,
      request: {
        description: '原生订阅子任务',
        prompt: '只回复流程核验',
        includeCompanyInfo: false,
        model: 'grok/fixture-model',
      },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: factory,
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.text).toContain('流程核验');
    expect(resolve).toHaveBeenCalledWith('grok/fixture-model', fixture.tenantId);
    expect(factory).toHaveBeenCalledOnce();
    expect(fixture.usageRecords).toHaveLength(1);
    expect(fixture.usageRecords[0]).toMatchObject({ channel: 'subagent' });
    expect(await fixture.parentEventStore.list(fixture.tenantId, fixture.parentSessionId)).toEqual(
      [],
    );
    const childStore = fixture.config.eventStoreFactory!(
      createRuntimeSessionRecord({
        sessionId: outcome.childSessionId,
        channel: 'web',
        cwd: fixture.tmp,
      }),
    );
    const childEvents = await childStore.list(fixture.tenantId, outcome.childSessionId);
    expect(childEvents.some((e) => e.type === 'run_finished' && e.subtype === 'success')).toBe(
      true,
    );
    expect(JSON.stringify(childEvents)).not.toMatch(/fixture-access|fixture-refresh/);
    grok.config.credentialRefs = [grok.refs[1], grok.refs[0]];
    grok.config.credentialRef = grok.refs[1];
    const titleFactory = createTitleModelAdapterFactory(
      new CodexCredentialManager({ vault: grok.vault, getConfig: () => undefined }),
      fetcher as typeof fetch,
      dependencies,
    );
    const onUsage = vi.fn();
    const beforeModelCall = vi.fn();
    const title = await generateTitle(
      '核验流程',
      '流程已完成',
      {
        model: 'fixture-model',
        modelRef: 'grok/fixture-model',
        connection: {},
        protocol: 'responses',
        responsesTransport: 'grok_subscription',
      },
      undefined,
      undefined,
      {
        modelAdapterFactory: titleFactory,
        runtimeContext: {
          sessionId: fixture.parentSessionId,
          tenantId: fixture.tenantId,
          cwd: fixture.tmp,
        },
        onUsage,
        beforeModelCall,
      },
    );
    expect(title).toBe('流程核验');
    expect(onUsage).toHaveBeenCalledOnce();
    expect(beforeModelCall).toHaveBeenCalledOnce();
    const requests = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/responses'));
    expect(requests).toHaveLength(2);
    expect(requests.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual([
      'Bearer fixture-access-fixture-0',
      'Bearer fixture-access-fixture-1',
    ]);
    for (const [url, init] of requests) {
      expect(url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('previous_response_id');
    }
  });
  it('retains explicit tenant model permission denial before any subscription request or child side effect', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fixture = await makeFixture({ cleanupDirs, modelResolver: () => null });
    const factory = vi.fn();
    await expect(
      runSubagent({
        ...runnerDeps(fixture),
        parentProviders: [createBuiltinTools()],
        agentType: SUBAGENT_TYPES.general,
        request: {
          description: '禁止越权',
          prompt: '不应执行',
          includeCompanyInfo: false,
          model: 'grok/not-allowed',
        },
        limiter: new SubagentLimiter(),
        modelAdapterFactory: factory,
      }),
    ).rejects.toThrow(/白名单/);
    expect(factory).not.toHaveBeenCalled();
    expect(fixture.usageRecords).toHaveLength(0);
    expect(await fixture.parentEventStore.list(fixture.tenantId, fixture.parentSessionId)).toEqual(
      [],
    );
  });
});
