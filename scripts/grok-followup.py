from pathlib import Path
import subprocess

def put(path, text):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text.lstrip('\n'))

# Integrate reviewed upstream work without rewriting either branch's history.
subprocess.run(['git', '-c', 'user.name=OpenAI', '-c', 'user.email=noreply@openai.com', 'merge', '--no-commit', '--no-ff', 'origin/main'], check=True)
p=Path('server/src/__tests__/grokSchemaAndCapability.test.ts');s=p.read_text();s=s.replace("const base = { agent: { cwd: '/tmp/grok-fixture' } };", "const base = { agent: { cwd: '/tmp/grok-fixture' }, server: { port: 3200 } };");p.write_text(s)
p=Path('server/src/runtime/modelAdapterFactory.ts');s=p.read_text();needle="): ModelAdapter {\n";assert needle in s;s=s.replace(needle,needle+"  if ((modelProviderOptions?.responsesTransport === 'grok_subscription' || modelProviderOptions?.responsesTransport === 'codex_subscription') && modelProviderOptions.protocol !== 'responses') {\n    throw new Error('Subscription transport requires Responses protocol; API Key fallback is forbidden');\n  }\n",1);p.write_text(s)
# Preserve the existing public adapter export while shrinking the grandfathered module.
p=Path('server/src/runtime/responsesApiAdapter.ts');s=p.read_text();a=s.index('/**\n * 上游拒绝 previous_response_id');b=s.index('/** 单个 input item',a);helper=s[a:b];put('server/src/runtime/responses/continuationErrors.ts',helper);s=s[:a]+s[b:];s="import { isPreviousResponseNotFound } from './responses/continuationErrors.js';\nexport { isPreviousResponseNotFound } from './responses/continuationErrors.js';\n"+s;p.write_text(s)
p=Path('web/src/components/ModelManager/useGrokSubscription.ts');s=p.read_text();s=s.replace("if ([404, 501].includes(response.status)) {\n", "if ([404, 501].includes(response.status)) {\n        acceptMetadata({});\n",1);needle="if (mounted.current) setError(cause instanceof Error ? cause.message : 'Grok 状态读取失败');";assert needle in s;s=s.replace(needle,"if (mounted.current) { acceptMetadata({}); setError(cause instanceof Error ? cause.message : 'Grok 状态读取失败'); }",1);s=s.replace('  }, [applyState]);\n  useEffect', '  }, [acceptMetadata, applyState]);\n  useEffect',1);p.write_text(s)
put('server/src/__tests__/grokOAuthContracts.test.ts', r'''
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokOAuthClient } from '../runtime/responses/grokOAuthClient.js';
import { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';
import { GROK_DISCOVERY_ENDPOINT, GROK_OAUTH_ISSUER, GROK_DEVICE_GRANT, GrokProtocolError, trustedGrokOAuthUrl, positiveSeconds } from '../runtime/responses/grokProtocol.js';
import { grokTokens, jsonResponse } from './grokTestFixtures.js';
const discovery = { issuer: GROK_OAUTH_ISSUER, device_authorization_endpoint: 'https://auth.x.ai/device', token_endpoint: 'https://auth.x.ai/token', userinfo_endpoint: 'https://auth.x.ai/userinfo', revocation_endpoint: 'https://auth.x.ai/revoke' };
afterEach(() => vi.restoreAllMocks());
describe('Grok trusted OAuth contracts T13-T17', () => {
  it('discovers once, sends RFC8628 form fields, and trusts authenticated userinfo rather than JWT claims', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === GROK_DISCOVERY_ENDPOINT) return jsonResponse(discovery);
      if (String(url).endsWith('/device')) return jsonResponse({ device_code: 'private-device', user_code: 'FIXTURE-CODE', verification_uri: 'https://auth.x.ai/activate', interval: 5, expires_in: 600 });
      if (String(url).endsWith('/token')) return jsonResponse({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'untrusted.jwt.fixture', token_type: 'Bearer', expires_in: 3600 });
      if (String(url).endsWith('/userinfo')) { expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-access'); return jsonResponse({ sub: 'trusted-account', email: 'a@example.invalid', email_verified: true }); }
      throw new Error('unexpected fixture URL');
    });
    const client = new GrokOAuthClient(fetcher as typeof fetch, () => 1000);
    const device = await client.start('registered-test-client');
    const token = await client.poll(device);
    expect(token).toMatchObject({ accountId: 'trusted-account', clientId: 'registered-test-client', expiresAt: new Date(3_601_000).toISOString() });
    const tokenCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/token'))!;
    expect(Object.fromEntries(new URLSearchParams(String(tokenCall[1]?.body)))).toEqual({ grant_type: GROK_DEVICE_GRANT, device_code: 'private-device', client_id: 'registered-test-client' });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === GROK_DISCOVERY_ENDPOINT)).toHaveLength(1);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it.each(['http://auth.x.ai/token','https://auth.x.ai.evil.invalid/token','https://127.0.0.1/token','https://secret@auth.x.ai/token','https://auth.x.ai:444/token','https://auth.x.ai/token#secret'])('rejects untrusted discovery URL %s', async (url) => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ...discovery, token_endpoint: url }));
    await expect(new GrokOAuthClient(fetcher).discover()).rejects.toThrow('untrusted_oauth_endpoint');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a wrong issuer and unsafe verification links', async () => {
    await expect(new GrokOAuthClient(vi.fn().mockResolvedValue(jsonResponse({ ...discovery, issuer: 'https://evil.invalid' }))).discover()).rejects.toThrow('invalid_issuer');
    expect(() => trustedGrokOAuthUrl('javascript:alert(1)', true)).toThrow();
    expect(() => trustedGrokOAuthUrl('https://x.ai.evil.invalid', true)).toThrow();
  });
  it.each([null, '3600', -1, 0, 0.5, Number.MAX_SAFE_INTEGER, Infinity])('rejects malformed expires_in %s', (value) => { expect(() => positiveSeconds(value)).toThrow('invalid_expiration'); });
  it('refresh uses the original client and rejects changed identity or unknown network outcomes', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === GROK_DISCOVERY_ENDPOINT) return jsonResponse(discovery);
      if (String(url).endsWith('/token')) { expect(new URLSearchParams(String(init?.body)).get('client_id')).toBe('fixture-client'); return jsonResponse({ access_token: 'fixture-new', refresh_token: 'fixture-rotated', expires_in: 3600 }); }
      return jsonResponse({ sub: 'different-identity' });
    });
    await expect(new GrokOAuthClient(fetcher as typeof fetch).refresh(grokTokens())).rejects.toMatchObject({ code: 'identity_changed', outcomeUnknown: true });
    await expect(new GrokOAuthClient(vi.fn().mockRejectedValue(new Error('fixture-secret'))).discover()).rejects.toMatchObject({ code: 'network_outcome_unknown', outcomeUnknown: true });
  });
  it('enforces pending/slow_down deadlines and single exchange without publishing configuration', async () => {
    let now = 0; const client = new GrokOAuthClient();
    vi.spyOn(client,'start').mockResolvedValue({ deviceCode:'private-device',userCode:'FIXTURE',verificationUri:'https://auth.x.ai/activate',expiresAt:600_000,intervalMs:5000,clientId:'fixture' });
    const poll = vi.spyOn(client,'poll').mockRejectedValueOnce(new GrokProtocolError('authorization_pending',400)).mockRejectedValueOnce(new GrokProtocolError('slow_down',400)).mockResolvedValue(grokTokens());
    const service = new GrokDeviceAuthService(client,{now:()=>now});
    const session = await service.start('admin-a');
    expect(JSON.stringify(session)).not.toContain('private-device');
    await expect(service.poll(session.sessionId,'admin-a')).resolves.toMatchObject({status:'pending'});expect(poll).not.toHaveBeenCalled();
    now=5000;await service.poll(session.sessionId,'admin-a');now=10000;
    expect(await service.poll(session.sessionId,'admin-a')).toMatchObject({status:'pending',intervalMs:10000});
    now=15000;await service.poll(session.sessionId,'admin-a');expect(poll).toHaveBeenCalledTimes(2);
    now=20000;const results=await Promise.all([service.poll(session.sessionId,'admin-a'),service.poll(session.sessionId,'admin-a')]);
    expect(poll).toHaveBeenCalledTimes(3);expect(results.every(r=>r.status==='authorized_pending_publication')).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/accessToken|refreshToken|deviceCode|fixture-access/);
    expect(()=>service.authorizedResult(session.sessionId,'admin-b')).toThrow('authorization_not_found');
    service.complete(session.sessionId,'admin-a');expect(service.status(session.sessionId,'admin-a').status).toBe('applied');
    expect(()=>service.authorizedResult(session.sessionId,'admin-a')).toThrow('authorization_not_ready');
  });
  it.each([['access_denied','denied'],['expired_token','expired'],['upstream_error','error']])('stops polling after %s',async(code,status)=>{
    let now=0;const client=new GrokOAuthClient();vi.spyOn(client,'start').mockResolvedValue({deviceCode:'private',userCode:'TEST',verificationUri:'https://auth.x.ai',expiresAt:100000,intervalMs:1000,clientId:'test'});
    const poll=vi.spyOn(client,'poll').mockRejectedValue(new GrokProtocolError(code,403));const service=new GrokDeviceAuthService(client,{now:()=>now});const s=await service.start('a');now=1000;
    expect(await service.poll(s.sessionId,'a')).toMatchObject({status});now=10000;await service.poll(s.sessionId,'a');expect(poll).toHaveBeenCalledOnce();
  });
  it('caps sessions, expires secrets and refuses a cancelled in-flight exchange',async()=>{
    let now=0;let release!:(value:ReturnType<typeof grokTokens>)=>void;const client=new GrokOAuthClient();
    vi.spyOn(client,'start').mockResolvedValue({deviceCode:'private',userCode:'TEST',verificationUri:'https://auth.x.ai',expiresAt:100000,intervalMs:1000,clientId:'test'});
    vi.spyOn(client,'poll').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));const service=new GrokDeviceAuthService(client,{now:()=>now,maxSessions:1});const s=await service.start('a');await expect(service.start('b')).rejects.toThrow('authorization_capacity');
    now=1000;const pending=service.poll(s.sessionId,'a');const rejected=expect(pending).rejects.toThrow('authorization_not_found');service.cancel(s.sessionId,'a');release(grokTokens());await rejected;
    const second=await service.start('b');now=100001;expect(service.status(second.sessionId,'b').status).toBe('expired');expect(()=>service.authorizedResult(second.sessionId,'b')).toThrow();
  });
});
''')
put('server/src/__tests__/grokTransportContracts.test.ts',r'''
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokSubscriptionResponsesTransport } from '../runtime/responses/grokSubscriptionResponsesTransport.js';
import { GrokModelCatalogService } from '../runtime/responses/grokModelCatalog.js';
import { GROK_RESPONSES_ENDPOINT } from '../runtime/responses/grokProtocol.js';
import { normalizeGrokRequest } from '../runtime/responses/grokRequestNormalization.js';
import { createModelAdapterForProtocol } from '../runtime/modelAdapterFactory.js';
import { grokFixture, jsonResponse } from './grokTestFixtures.js';
const context={runId:'grok-run',sessionId:'grok-session',tenantId:'tenant-a',model:'fixture-model',cwd:'/tmp/grok',channelContext:{channel:'web' as const}};
const request={serializedBody:JSON.stringify({model:'fixture-model',input:[{role:'user',content:'hello'}],tools:[],stream:true}),clientRequestId:'fixture-request',context};
afterEach(()=>vi.restoreAllMocks());
describe('Grok ordered subscription transport T01-T07, T25, T27-T28, T33',()=>{
  it('uses A on every request until order changes and never consumes B on success',async()=>{
    const f=await grokFixture(3);const fetcher=vi.fn(async()=>new Response('fixture'));const transport=new GrokSubscriptionResponsesTransport(f.manager,fetcher);
    await transport.execute(request);await transport.execute(request);expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(c=>new Headers((c as unknown as [unknown,RequestInit])[1]?.headers).get('Authorization')==='Bearer fixture-access-fixture-0')).toBe(true);
    f.config.credentialRefs=[f.refs[1],f.refs[0],f.refs[2]];f.config.credentialRef=f.refs[1];await transport.execute(request);
    const call=fetcher.mock.calls.at(-1) as unknown as [string,RequestInit];expect(call[0]).toBe(GROK_RESPONSES_ENDPOINT);expect(new Headers(call[1].headers).get('authorization')).toBe('Bearer fixture-access-fixture-1');
  });
  it('cools explicit exhausted credits, releases the rejected response and skips it next time',async()=>{
    const f=await grokFixture();const rejected=jsonResponse({error:{message:'You have used all available credits'}},402);
    const fetcher=vi.fn().mockResolvedValueOnce(rejected).mockImplementation(async()=>new Response('ok'));const transport=new GrokSubscriptionResponsesTransport(f.manager,fetcher);
    await transport.execute(request);expect(fetcher).toHaveBeenCalledTimes(2);expect(rejected.bodyUsed).toBe(true);
    expect(await f.manager.getRuntimeState(f.refs[0])).toMatchObject({availability:'quota_cooldown'});await transport.execute(request);expect(fetcher).toHaveBeenCalledTimes(3);
    await f.state.markQuotaCooldown(f.refs[0],new Date(Date.now()-100).toISOString(),'quota',1);await transport.execute(request);expect(new Headers(fetcher.mock.calls.at(-1)![1].headers).get('authorization')).toBe('Bearer fixture-access-fixture-0');
  });
  it.each([429,403,500])('does not walk the pool or alter account health for ordinary HTTP %s',async(status)=>{
    const f=await grokFixture();const fetcher=vi.fn().mockResolvedValue(jsonResponse({error:{message:'Too many requests; fixture-secret-token'}},status));const result=await new GrokSubscriptionResponsesTransport(f.manager,fetcher).execute(request);
    expect(result.response.status).toBe(status);expect(fetcher).toHaveBeenCalledOnce();expect(await f.manager.getRuntimeState(f.refs[0])).toBeUndefined();expect(await result.response.text()).not.toContain('fixture-secret-token');
  });
  it('keeps HTML challenges and network failures bounded and does not use another billing provider',async()=>{
    const f=await grokFixture();const fetcher=vi.fn().mockResolvedValue(new Response('<html>private challenge</html>',{status:403,headers:{'content-type':'text/html'}}));
    expect((await new GrokSubscriptionResponsesTransport(f.manager,fetcher).execute(request)).response.status).toBe(403);expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockReset().mockRejectedValue(new Error('fixture network'));await expect(new GrokSubscriptionResponsesTransport(f.manager,fetcher).execute(request)).rejects.toThrow('fixture network');expect(fetcher).toHaveBeenCalledOnce();
  });
  it('refreshes at most once on 401; recovery attempts do not refresh or rotate',async()=>{
    const f=await grokFixture(1);const refresh=vi.spyOn(f.oauth,'refresh').mockImplementation(async old=>({...old,accessToken:'fixture-new'}));
    const fetcher=vi.fn().mockResolvedValueOnce(jsonResponse({},401)).mockResolvedValueOnce(new Response('ok'));
    const transport=new GrokSubscriptionResponsesTransport(f.manager,fetcher);const result=await transport.execute(request);expect(result.authRetryCount).toBe(1);expect(refresh).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset().mockResolvedValue(jsonResponse({},401));await transport.execute({...request,recoveryAttempt:true});expect(fetcher).toHaveBeenCalledOnce();expect(refresh).toHaveBeenCalledOnce();
  });
  it('skips unavailable accounts and reports earliest cooldown when no candidates remain',async()=>{
    const f=await grokFixture();await f.manager.markAuthUnavailable(f.refs[0],'invalid_grant',1);const until=await f.manager.markQuotaCooldown(f.refs[1],'quota',1);const fetcher=vi.fn();
    const result=await new GrokSubscriptionResponsesTransport(f.manager,fetcher).execute(request);expect(result.response.status).toBe(429);expect(await result.response.json()).toMatchObject({error:{code:'grok_accounts_cooling_down',retryAt:until}});expect(fetcher).not.toHaveBeenCalled();
  });
  it('never starts after cancellation and stops before failover when cancelled during rejection',async()=>{
    const f=await grokFixture();const controller=new AbortController();controller.abort();const fetcher=vi.fn();await expect(new GrokSubscriptionResponsesTransport(f.manager,fetcher).execute({...request,signal:controller.signal})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
    const live=new AbortController();fetcher.mockImplementation(async()=>{live.abort();return jsonResponse({error:{message:'used all available credits'}},402);});await expect(new GrokSubscriptionResponsesTransport(f.manager,fetcher).execute({...request,signal:live.signal})).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
  });
  it('skips a proven model-ineligible account without marking it as broken',async()=>{
    const f=await grokFixture();const catalog=new GrokModelCatalogService(f.manager,vi.fn());vi.spyOn(catalog,'forAccount').mockImplementation(async(ref)=>({credentialRef:ref,status:'fresh',models:ref===f.refs[0]?[]:[{id:'fixture-model'}],collectedAt:new Date().toISOString()} as Awaited<ReturnType<GrokModelCatalogService['forAccount']>>));
    const fetcher=vi.fn().mockResolvedValue(new Response('ok'));await new GrokSubscriptionResponsesTransport(f.manager,fetcher,catalog).execute(request);expect(fetcher).toHaveBeenCalledOnce();expect(new Headers(fetcher.mock.calls[0][1].headers).get('authorization')).toBe('Bearer fixture-access-fixture-1');expect(await f.manager.getRuntimeState(f.refs[0])).toBeUndefined();
  });
  it('isolates tenant/session/account bindings and drops only opaque state on mismatch',async()=>{
    const f=await grokFixture();const fetcher=vi.fn().mockImplementation(async()=>new Response('ok'));const transport=new GrokSubscriptionResponsesTransport(f.manager,fetcher);
    const a=await transport.getContinuationBindingForRequest({context,model:'fixture-model'});const b=await transport.getContinuationBindingForRequest({context:{...context,tenantId:'tenant-b'},model:'fixture-model'});const c=await transport.getContinuationBindingForRequest({context:{...context,sessionId:'second'},model:'fixture-model'});expect(a).not.toEqual(b);expect(a).not.toEqual(c);
    f.config.credentialRefs=[f.refs[1],f.refs[0]];f.config.credentialRef=f.refs[1];
    const history=[{type:'reasoning',encrypted_content:'private-opaque'},{type:'function_call',call_id:'done-tool',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'done-tool',output:'already executed'}];
    await transport.execute({...request,expectedContinuationBinding:a,serializedBody:JSON.stringify({model:'fixture-model',input:history,previous_response_id:'old-response'})});const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.input).toEqual(history.slice(1));expect(body).not.toHaveProperty('previous_response_id');
  });
  it('rejects protocol mismatches and unverified media instead of silently using an API Key',()=>{
    expect(()=>createModelAdapterForProtocol({apiKey:'must-not-use',baseUrl:'https://api.x.ai/v1'},{responsesTransport:'grok_subscription',protocol:'chat_completions'})).toThrow('fallback is forbidden');
    expect(()=>normalizeGrokRequest({model:'test',input:[{role:'user',content:[{type:'input_image',image_url:'fixture'}]}]},true)).toThrow('image_capability_unverified');
    expect(()=>normalizeGrokRequest({model:'test',input:[],reasoning:{effort:'high'}},true)).toThrow('reasoning_effort_capability_unverified');
  });
});
''')
put('server/src/__tests__/grokResponsesAdapter.test.ts',r'''
import { describe, expect, it, vi } from 'vitest';
import { createModelAdapterForProtocol } from '../runtime/modelAdapterFactory.js';
import type { ModelEvent } from '../runtime/types.js';
import { grokFixture } from './grokTestFixtures.js';
const context={runId:'grok-run',sessionId:'grok-session',tenantId:'tenant-a',model:'fixture-model',cwd:'/tmp/grok',channelContext:{channel:'web' as const}};
const sse=(type:string,value:Record<string,unknown>)=>`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
function stream(text:string){const bytes=new TextEncoder().encode(text);return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});}
async function collect(source:AsyncIterable<ModelEvent>){const events:ModelEvent[]=[];for await(const event of source)events.push(event);return events;}
describe('Grok native Responses adapter T25-T29',()=>{
  it('parses fragmented UTF-8 and canonical function calls through the platform adapter and accounts usage once',async()=>{
    const f=await grokFixture(1);const tool={type:'function_call',id:'item-f',call_id:'call-f',name:'Read',arguments:'{"path":"你好.txt"}'};
    const fetcher=vi.fn().mockResolvedValue(stream(sse('response.output_item.added',{output_index:0,item:{...tool,arguments:''}})+sse('response.function_call_arguments.delta',{item_id:'item-f',output_index:0,delta:'{"path":'})+sse('response.function_call_arguments.delta',{item_id:'item-f',output_index:0,delta:'"你好.txt"}'})+sse('response.output_item.done',{output_index:0,item:tool})+sse('response.completed',{response:{id:'response-fixture',model:'fixture-model',status:'completed',output:[tool],usage:{input_tokens:21,output_tokens:9}}})));
    const adapter=createModelAdapterForProtocol({apiKey:'do-not-use',baseUrl:'https://api.x.ai/v1'},{protocol:'responses',responsesTransport:'grok_subscription'},{grokCredentialManager:f.manager,grokFetch:fetcher});
    const events=await collect(adapter.stream({model:'fixture-model',messages:[{role:'system',content:'平台工具由平台执行'},{role:'user',content:'读取文件'}],tools:[{id:'Read',name:'Read',description:'Read file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}]},context));
    expect(events.filter(e=>e.type==='completed')).toHaveLength(1);expect(events.find(e=>e.type==='completed')).toMatchObject({finishReason:'tool_calls',usage:{inputTokens:21,outputTokens:9},responseChained:false});
    expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][0]).toBe('https://cli-chat-proxy.grok.com/v1/responses');expect(new Headers(fetcher.mock.calls[0][1].headers).get('authorization')).not.toContain('do-not-use');
    expect(JSON.stringify(events)).toContain('你好.txt');expect(JSON.stringify(events)).not.toMatch(/fixture-access|fixture-refresh/);
  });
  it('does not declare success on missing terminal or a failure terminal and does not invisibly walk accounts',async()=>{
    for(const wire of [sse('response.output_text.delta',{delta:'partial'}),sse('response.failed',{response:{id:'failed',status:'failed',error:{code:'server_error',message:'fixture failure'}}})]){
      const f=await grokFixture();const fetcher=vi.fn().mockImplementation(async()=>stream(wire));const adapter=createModelAdapterForProtocol({},{protocol:'responses',responsesTransport:'grok_subscription',preStreamRetryDelaysMs:[]},{grokCredentialManager:f.manager,grokFetch:fetcher});
      let events:ModelEvent[]=[];try{events=await collect(adapter.stream({model:'fixture-model',messages:[{role:'user',content:'hello'}],tools:[]},context));}catch{ /* throws are also explicit failures */ }
      expect(events.some(e=>e.type==='completed' && e.terminalStatus==='completed')).toBe(false);expect(fetcher.mock.calls.every(c=>new Headers(c[1].headers).get('authorization')==='Bearer fixture-access-fixture-0')).toBe(true);
    }
  });
});
''')
put('server/src/__tests__/grokAdminContracts.test.ts',r'''
import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAppConfig } from '../app/config.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokOAuthClient } from '../runtime/responses/grokOAuthClient.js';
import { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';
import { createGrokSubscriptionAdminRouter } from '../routes/grokSubscriptionAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { grokTokens } from './grokTestFixtures.js';
const cleanups:Array<()=>void>=[];
beforeEach(()=>{vi.stubEnv('NODE_ENV','development');vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT','1');});
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'grok-admin-'));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));const processCwd=join(root,'server');mkdirSync(processCwd);const path=join(root,'config.json');
  const raw={agent:{cwd:'/tmp/grok-admin'},server:{port:3200}};writeFileSync(path,JSON.stringify(raw));const config=parseAppConfig(raw);const vault=new InMemorySecretVault();const client=new GrokOAuthClient();let now=0;let account='account-a';
  vi.spyOn(client,'start').mockResolvedValue({deviceCode:'fixture-private-device',userCode:'FIXTURE-CODE',verificationUri:'https://auth.x.ai/activate',expiresAt:3_600_000,intervalMs:1000,clientId:'fixture-client'});vi.spyOn(client,'poll').mockImplementation(async()=>grokTokens(account));vi.spyOn(client,'revoke').mockResolvedValue(false);
  const manager=new GrokCredentialManager({vault,getConfig:()=>config.grokSubscription,oauthClient:client});const auth=new GrokDeviceAuthService(client,{now:()=>now});
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={sub:String(req.headers['x-owner']??'admin-a'),username:'fixture',role:req.headers['x-user']==='ordinary'?'user':'admin',tenantId:req.headers['x-user']==='org'?'other-tenant':DEFAULT_TENANT_ID};next();});app.use('/grok',createGrokSubscriptionAdminRouter({processCwd,config,credentialManager:manager,deviceAuthService:auth}));
  const server:Server=app.listen(0);cleanups.push(()=>server.close());await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture bind');const base=`http://127.0.0.1:${address.port}/grok`;
  const call=async(route='',method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(base+route,{method,headers:{'content-type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const mutate=async(route:string,method:string,body:Record<string,unknown>={})=>{const state=await(await call()).json();return call(route,method,{...body,expectedRevision:state.revision,operationId:randomUUID()});};
  const authorize=async(id:string,replace?:string)=>{account=id;const start=await call('/device/start','POST',replace?{credentialRef:replace}:{});expect(start.status).toBe(201);const session=await start.json();now+=1000;const poll=await call(`/device/${session.sessionId}/poll`,'POST',{});expect(await poll.json()).toMatchObject({status:'authorized_pending_publication'});return session.sessionId as string;};
  return{call,mutate,authorize,path,config,manager,vault,client,auth};
}
describe('Grok admin transactions T16-T23',()=>{
  it('starts without a Grok root, separates external authorization from registration, and never persists tokens',async()=>{
    const f=await fixture();expect((await(await f.call()).json()).config.enabled).toBe(false);expect((await f.mutate('','PUT',{enabled:true})).status).toBe(409);
    const session=await f.authorize('account-a');expect(f.config.grokSubscription).toBeUndefined();expect(readFileSync(f.path,'utf8')).not.toContain('grokSubscription');
    const response=await f.mutate(`/device/${session}/complete`,'POST');expect(response.status).toBe(200);const state=await response.json();expect(state.status).toBe('applied');expect(state.credentials).toHaveLength(1);expect(state.config.enabled).toBe(true);
    const again=await f.mutate(`/device/${session}/complete`,'POST');expect(again.status).toBe(200);expect((await again.json()).credentials).toHaveLength(1);
    expect(readFileSync(f.path,'utf8')).not.toMatch(/accessToken|refreshToken|fixture-access|fixture-refresh|fixture-private-device/);expect(JSON.stringify(state)).not.toMatch(/fixture-access|fixture-refresh|account-a@example/);
  });
  it('orders the exact set, replaces in place, rejects duplicate identities and warns on unconfirmed remote revoke',async()=>{
    const f=await fixture();for(const account of ['account-a','account-b']){const s=await f.authorize(account);expect((await f.mutate(`/device/${s}/complete`,'POST')).status).toBe(200);}
    const refs=f.manager.getCredentialRefs();for(const order of [[refs[0]],[refs[0],refs[0]],[refs[0],'unknown-ref']])expect((await f.mutate('/credentials/order','PUT',{credentialRefs:order})).status).toBe(409);
    expect((await f.mutate('/credentials/order','PUT',{credentialRefs:[refs[1],refs[0]]})).status).toBe(200);expect(f.manager.getCredentialRefs()).toEqual([refs[1],refs[0]]);
    const duplicate=await f.authorize('account-a');expect((await f.mutate(`/device/${duplicate}/complete`,'POST')).status).toBe(409);
    const reauth=await f.authorize('account-b',refs[1]);expect((await f.mutate(`/device/${reauth}/complete`,'POST')).status).toBe(200);const next=f.manager.getCredentialRefs();expect(next[0]).not.toBe(refs[1]);expect(next[1]).toBe(refs[0]);expect(f.client.revoke).not.toHaveBeenCalled();
    const removal=await f.mutate(`/credentials/${next[0]}`,'DELETE');expect(removal.status).toBe(200);expect((await removal.json()).warning).toContain('远端撤销未确认');
    expect((await f.mutate(`/credentials/${next[1]}`,'DELETE')).status).toBe(200);expect(f.manager.getCredentialRefs()).toEqual([]);expect(f.config.grokSubscription?.enabled).toBe(false);
  });
  it('blocks ordinary/org admins, cross-owner sessions, unknown fields and stale revisions',async()=>{
    const f=await fixture();for(const actor of ['ordinary','org'])expect((await f.call('','GET',undefined,{'x-user':actor})).status).toBe(403);
    const session=await f.authorize('account-a');expect((await f.call(`/device/${session}/complete`,'POST',{}, {'x-owner':'admin-b'})).status).toBe(404);
    const before=readFileSync(f.path,'utf8');expect((await f.mutate('','PUT',{codexSubscription:{enabled:true}})).status).toBe(400);expect(readFileSync(f.path,'utf8')).toBe(before);
    expect((await f.call('','PUT',{enabled:false,expectedRevision:'stale',operationId:randomUUID()})).status).toBe(409);
    expect((await f.mutate(`/device/${session}/complete`,'POST')).status).toBe(200);expect((await f.mutate('','DELETE')).status).toBe(200);expect(f.manager.getCredentialRefs()).toEqual([]);
  });
});
''')
put('web/src/components/ModelManager/GrokSubscriptionCard.test.tsx',r'''
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '@/lib/authFetch';
import { GrokSubscriptionCard } from './GrokSubscriptionCard';
import { safeGrokVerificationUri } from './grokSubscriptionClient';
vi.mock('@/lib/authFetch',()=>({authFetch:vi.fn()}));
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const state={revision:'revision-grok',writePolicy:{environment:'development',mode:'online',canSave:true},config:{enabled:true,quotaCooldownMinutes:60,endpoint:'https://cli-chat-proxy.grok.com/v1/responses',oauthClientId:'registered-client'},credentials:[{id:'grok-a',priority:1,configured:true,connected:true,email:'a***@example.invalid',availability:'available'},{id:'grok-b',priority:2,configured:true,connected:true,email:'b***@example.invalid',availability:'available'}]};
beforeEach(()=>{vi.mocked(authFetch).mockReset();vi.mocked(authFetch).mockResolvedValue(json(state));});afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('Grok subscription management UI T31-T32',()=>{
  it('saves exact-revision settings and orders the shared pool through Grok-only endpoints',async()=>{
    vi.mocked(authFetch).mockImplementation(async(path,init)=>{if(String(path).endsWith('/credentials/order')){const body=JSON.parse(String(init?.body));return json({...state,credentials:body.credentialRefs.map((id:string)=>state.credentials.find(c=>c.id===id))});}return json(state);});
    const user=userEvent.setup();render(<GrokSubscriptionCard readOnly={false}/>);await screen.findByText('a***@example.invalid');
    expect(screen.queryByText('启用 WebSocket 会话接力')).toBeNull();await user.click(screen.getByRole('button',{name:'保存设置'}));
    const save=vi.mocked(authFetch).mock.calls.find(c=>c[1]?.method==='PUT')!;expect(save[0]).toBe('/api/admin/grok-subscription');expect(JSON.parse(String(save[1]?.body))).toMatchObject({expectedRevision:'revision-grok',operationId:expect.any(String),quotaCooldownMinutes:60});
    await waitFor(()=>expect((screen.getAllByRole('button',{name:'上移'})[1] as HTMLButtonElement).disabled).toBe(false));await user.click(screen.getAllByRole('button',{name:'上移'})[1]);
    await waitFor(()=>expect(vi.mocked(authFetch).mock.calls.some(c=>String(c[0]).endsWith('/credentials/order'))).toBe(true));expect(vi.mocked(authFetch).mock.calls.every(c=>String(c[0]).includes('/grok-subscription'))).toBe(true);
  });
  it('keeps account read-only and an unsupported backend non-writable',async()=>{
    const view=render(<GrokSubscriptionCard readOnly={true}/>);await screen.findByText('a***@example.invalid');expect((screen.getByRole('button',{name:'添加授权账号'}) as HTMLButtonElement).disabled).toBe(true);view.unmount();
    vi.mocked(authFetch).mockResolvedValue(json({},404));render(<GrokSubscriptionCard readOnly={false}/>);await screen.findByText('服务端未支持');expect((screen.getByRole('button',{name:'保存设置'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('withdraws write permission after a failed refresh without erasing the visible accounts',async()=>{
    const user=userEvent.setup();render(<GrokSubscriptionCard readOnly={false}/>);await screen.findByText('a***@example.invalid');vi.mocked(authFetch).mockResolvedValueOnce(json({error:'读取失败'},503));await user.click(screen.getByRole('button',{name:'刷新 Grok 订阅状态'}));await screen.findByText('读取失败');
    expect(screen.getByText('a***@example.invalid')).toBeTruthy();expect((screen.getByRole('button',{name:'保存设置'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows a safe fallback authorization link when the popup is blocked and permits cancellation',async()=>{
    vi.spyOn(window,'open').mockReturnValue(null);vi.mocked(authFetch).mockImplementation(async(path,init)=>{if(String(path).endsWith('/device/start'))return json({sessionId:'session-fixture',status:'pending',userCode:'TEST-CODE',verificationUri:'https://auth.x.ai/activate',intervalSeconds:300,expiresAt:new Date(Date.now()+600000).toISOString()},201);if(init?.method==='DELETE')return json({status:'cancelled'});return json(state);});
    const user=userEvent.setup();render(<GrokSubscriptionCard readOnly={false}/>);await screen.findByText('a***@example.invalid');await user.click(screen.getByRole('button',{name:'添加授权账号'}));await screen.findByText('TEST-CODE');expect(screen.getByRole('link',{name:'打开 xAI 授权页面'}).getAttribute('href')).toBe('https://auth.x.ai/activate');await user.click(screen.getByRole('button',{name:'取消本次授权'}));await waitFor(()=>expect(screen.queryByText('TEST-CODE')).toBeNull());
    expect(safeGrokVerificationUri('javascript:alert(1)')).toBeUndefined();expect(safeGrokVerificationUri('https://auth.x.ai.evil.invalid')).toBeUndefined();
  });
});
''')
# Only ratchet downward after extracting helpers; never increase a grandfathered threshold.
subprocess.run(['node','scripts/check-max-lines-ratchet.mjs','--prune'],check=True)
print('Completed OAuth/transport/adapter/admin/UI contract tests, fail-closed client state and latest-main integration')
