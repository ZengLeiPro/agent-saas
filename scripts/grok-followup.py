from pathlib import Path
import subprocess

def put(path,text):
    p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))

put('server/src/__tests__/grokProductionPublication.test.ts', r'''
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawRevision, readPublication } from '../../../scripts/release/config-publication.mjs';
import { createProductionPublicationRig } from './helpers/productionPublicationRig.js';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokOAuthClient } from '../runtime/responses/grokOAuthClient.js';
import { grokTokens } from './grokTestFixtures.js';
import type { MutationInput } from '../config/adminConfigMutationService.js';
let rig:Awaited<ReturnType<typeof createProductionPublicationRig>>;
beforeEach(async()=>{rig=await createProductionPublicationRig();});
afterEach(()=>{rig.close();vi.restoreAllMocks();});
function registration(ref:string):MutationInput {
  const current=rawRevision(readFileSync(rig.configPath,'utf8'));
  return {...rig.input(),operation:{id:'grok.complete'},operationId:randomUUID(),changedPaths:['grokSubscription'],expectedRevision:current,productionConfirmation:current,
    buildCandidate:(text)=>{const raw=JSON.parse(text);raw.grokSubscription={enabled:true,credentialRef:ref,credentialRefs:[ref],quotaCooldownMinutes:60};return JSON.stringify(raw,null,2)+'\n';}};
}
async function setup(){
  const oauth=new GrokOAuthClient();const refresh=vi.spyOn(oauth,'refresh').mockImplementation(async old=>({...old,accessToken:'fixture-new-access',refreshToken:'fixture-new-refresh',expiresAt:new Date(Date.now()+3600000).toISOString()}));
  const manager=new GrokCredentialManager({vault:rig.vault,getConfig:()=>rig.nodes[0].config.grokSubscription,oauthClient:oauth,requireRotationCoordinator:true});
  manager.setCredentialRotationTransaction((ref,action)=>rig.publisher.withCredentialRotation(ref,action));
  const candidate=await manager.persistLogin({...grokTokens('production-fixture'),expiresAt:new Date(Date.now()+1000).toISOString()});
  await rig.service.mutate(registration(candidate.credentialRef));return{manager,refresh,ref:candidate.credentialRef};
}
describe('Grok signed dual-consumer publication T20-T22',()=>{
  it('registers without a prior root and advances only credential identity after a protected refresh',async()=>{
    const f=await setup();const disk=readFileSync(rig.configPath,'utf8');const before=readPublication(rig.configPath)!;
    expect(rig.nodes.every(n=>n.config.grokSubscription?.credentialRef===f.ref)).toBe(true);
    const token=await f.manager.getCredentials();expect(token.generation).toBe(2);expect(f.refresh).toHaveBeenCalledOnce();
    const after=readPublication(rig.configPath)!;expect(after.phase).toBe('committed');expect(after.identity.digest).toBe(before.identity.digest);expect(after.identity.credentialVersionDigest).not.toBe(before.identity.credentialVersionDigest);expect(after.sequence).toBeGreaterThan(before.sequence);expect(readFileSync(rig.configPath,'utf8')).toBe(disk);
    expect(rig.nodes.every(n=>n.view.isExecutionAllowed())).toBe(true);expect(JSON.stringify(after)).not.toMatch(/fixture-new-access|fixture-new-refresh|production-fixture@example/);
  });
  it('keeps a consumed refresh fenced when a Worker receipt is missing and recovers without refreshing twice',async()=>{
    const f=await setup();rig.blockedPhases.add('runtime-worker:applying');await expect(f.manager.getCredentials()).rejects.toThrow();expect(f.refresh).toHaveBeenCalledOnce();
    expect(readPublication(rig.configPath)!.phase).toBe('recovery_required');expect(rig.nodes.every(n=>!n.view.isExecutionAllowed())).toBe(true);
    rig.blockedPhases.clear();await rig.publisher.recover();const token=await f.manager.getCredentials();expect(token.generation).toBe(2);expect(f.refresh).toHaveBeenCalledOnce();expect(readPublication(rig.configPath)!.phase).toBe('committed');expect(rig.nodes.every(n=>n.view.isExecutionAllowed())).toBe(true);
  });
  it('rolls back rejected registration without changing the original model or publishing a candidate',async()=>{
    const manager=new GrokCredentialManager({vault:rig.vault,getConfig:()=>rig.nodes[0].config.grokSubscription});const candidate=await manager.persistLogin(grokTokens());rig.blockedPhases.add('runtime-worker:applying');
    await expect(rig.service.mutate(registration(candidate.credentialRef))).rejects.toThrow();expect(readFileSync(rig.configPath,'utf8')).toBe(rig.before);expect(rig.nodes.every(n=>n.config.grokSubscription===undefined)).toBe(true);expect(readPublication(rig.configPath)!.phase).toBe('committed');
    await manager.discardLoginCandidate(candidate.credentialRef);await expect(rig.vault.getSecret(candidate.credentialRef,{actor:'system',userId:'__system__',scopes:['secret:grok_subscription_oauth:read']})).rejects.toThrow();
  });
  it('checks confirmation and operation scope before changing any credential or model configuration',async()=>{
    const candidate=await new GrokCredentialManager({vault:rig.vault,getConfig:()=>undefined}).persistLogin(grokTokens());const request=registration(candidate.credentialRef);const build=vi.fn(request.buildCandidate);
    await expect(rig.service.mutate({...request,productionConfirmation:undefined,buildCandidate:build})).rejects.toThrow();expect(build).not.toHaveBeenCalled();
    await expect(rig.service.mutate({...registration(candidate.credentialRef),buildCandidate:(text)=>{const raw=JSON.parse(text);raw.codexSubscription={enabled:false};return JSON.stringify(raw);}})).rejects.toThrow(/范围|其他配置/);expect(readFileSync(rig.configPath,'utf8')).toBe(rig.before);
  });
});
''')
put('server/src/__tests__/grokModelCatalog.test.ts',r'''
import { describe, expect, it, vi } from 'vitest';
import { GrokModelCatalogService, parseGrokCatalog } from '../runtime/responses/grokModelCatalog.js';
import { grokFixture, jsonResponse } from './grokTestFixtures.js';
describe('Grok subscription directory qualification',()=>{
  it('unions individual account catalogs with eligibility and preserves source metadata',async()=>{
    const f=await grokFixture();let call=0;const fetcher=vi.fn(async()=>jsonResponse({models:++call===1?[{id:'model-a',context_window:128000,supports_reasoning_effort:true,input_modalities:['text']}]:[{id:'model-b',api_backend:'responses',contextWindow:256000}]}));
    const catalog=new GrokModelCatalogService(f.manager,fetcher);const result=await catalog.list();expect(result.models).toEqual([{id:'model-a',eligibleCredentialRefs:[f.refs[0]]},{id:'model-b',eligibleCredentialRefs:[f.refs[1]]}]);expect(result.accounts[0].models[0]).toMatchObject({contextWindow:128000,supportsReasoningEffort:true,source:'subscription_catalog'});expect(result.accounts[1].models[0]).not.toHaveProperty('supportsReasoningEffort');
    expect(fetcher.mock.calls.every(c=>String((c as unknown as [string])[0])==='https://cli-chat-proxy.grok.com/v1/models')).toBe(true);
  });
  it('coalesces requests and retains last known models as stale on outage without inventing eligibility',async()=>{
    const f=await grokFixture(1);let now=0;const fetcher=vi.fn().mockResolvedValueOnce(jsonResponse({data:[{id:'model-a'}]})).mockRejectedValue(new Error('private-provider-error'));
    const catalog=new GrokModelCatalogService(f.manager,fetcher,()=>now);await Promise.all([catalog.forAccount(f.refs[0]),catalog.forAccount(f.refs[0])]);expect(fetcher).toHaveBeenCalledOnce();now=61000;
    const result=await catalog.list();expect(result.accounts[0]).toMatchObject({status:'stale',models:[{id:'model-a'}],error:'catalog_unavailable'});expect(result.models[0].eligibleCredentialRefs).toEqual([]);expect(JSON.stringify(result)).not.toContain('private-provider-error');
    f.config.enabled=false;f.config.credentialRefs=undefined;f.config.credentialRef=undefined;expect((await catalog.list()).models).toEqual([]);
  });
  it('invalidates eligibility after credential generation changes and never guesses missing numeric limits',async()=>{
    const f=await grokFixture(1);const fetcher=vi.fn().mockImplementation(async()=>jsonResponse({data:[{id:'model-a',context_window:'128000',max_output_tokens:Number.MAX_SAFE_INTEGER}]}));const catalog=new GrokModelCatalogService(f.manager,fetcher);
    const first=await catalog.forAccount(f.refs[0]);expect(first.models[0]).not.toHaveProperty('contextWindow');expect(first.models[0]).not.toHaveProperty('maxOutputTokens');await f.state.clear(f.refs[0],2);await catalog.forAccount(f.refs[0]);expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('filters explicitly unsupported backends and rejects malformed IDs or directories',()=>{
    expect(parseGrokCatalog({data:[{id:'image-model',api_backend:'image'},{id:'chat-model',api_backend:'responses'}]}).map(m=>m.id)).toEqual(['chat-model']);
    for(const raw of [{}, {data:[{id:'bad\nmodel'}]},{models:'not-a-list'},Array.from({length:1001},()=>({id:'x'}))])expect(()=>parseGrokCatalog(raw)).toThrow();
  });
});
''')
# Explicit PG contract registration is required by the preflight runner; do not rely only on name-based selection.
p=Path('scripts/pr-preflight-task.sh');s=p.read_text();needle='      src/__tests__/codexCredentialRuntimeState.pg.test.ts \\\n';assert needle in s;s=s.replace(needle,needle+'      src/__tests__/grokCredentialPostgres.test.ts \\\n',1);p.write_text(s)
# Provide a reproducible read-only source-plan verifier; it never opens a production database.
put('scripts/release/grok-migration-evidence.mjs',r'''
import { execFileSync } from 'node:child_process';
import { createMigrationPlan } from './migration-plan.mjs';
const resolve = (ref) => execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const [baseRef, targetRef = 'HEAD'] = process.argv.slice(2);
if (!baseRef || baseRef.startsWith('-') || targetRef.startsWith('-')) throw new Error('usage: node scripts/release/grok-migration-evidence.mjs <baseline-ref> [target-ref]');
const baseline = resolve(baseRef);
const target = resolve(targetRef);
const plan = createMigrationPlan({ baseline, target });
console.log(JSON.stringify({ baseline, target, plan }, null, 2));
if (!plan.ok) process.exitCode = 1;
''')
# Include the migration proof and all source/workspace tests as independent diagnostics.
p=Path('.github/workflows/grok-development-snapshot.yml');s=p.read_text();needle="          commands=[\n";assert needle in s;s=s.replace(needle,needle+"              ('grok-migration','node scripts/release/grok-migration-evidence.mjs origin/main HEAD'),\n",1);needle="              ('web-build','pnpm -F web build'),";assert needle in s;s=s.replace(needle,needle+"\n              ('full-shared','pnpm -F @agent/shared exec vitest run'),\n              ('full-server','pnpm -F server exec vitest run --maxWorkers=2'),\n              ('full-web','NODE_ENV=test pnpm -F web exec vitest run --testTimeout=15000 --maxWorkers=2'),",1);p.write_text(s)
put('docs/grok-subscription.md',r'''
# Grok 订阅：平台全局多账号操作指南

本功能是 agent-saas 自有运行时的原生订阅 transport，不运行 Grok CLI，不导入其他 Agent 平台，也不要求粘贴 token。代码交付与订阅账号上线验收分开。当前没有真实 SuperGrok 账号实调证据；首次启用前必须按[发布与回滚说明](grok-subscription-rollout.md)完成专用测试环境验证。

## 配置位置与边界

在平台管理 → 资源中心 → 模型管理 → 通用设置，Codex 卡片正下方为 **Grok 订阅鉴权**。所有 `grok_subscription` 模型使用同一个平台账号池。账号池不会取消租户模型白名单、组织 Agent 策略、审批或工具权限。普通用户和其他组织的管理员不能操作平台凭据。

当前主分支已统一平台管理员写权限；页面仍尊重传入的只读状态和服务端 `writePolicy`，生产写入另需精确 revision 确认。不要通过关闭前端按钮以外的手段代替服务端授权。

## 授权与模型登记

点击“添加授权账号”，在可信 xAI 页面输入用户码并授权。弹窗被拦截时使用卡片中的授权链接。账户密码及验证码只在 xAI 页面输入，不提供给平台或聊天。`device_code`、access/refresh/id token 只保留在服务端。

外部完成后，状态变为“已授权，尚未登记到平台”。平台通过独立 `complete` 事务登记；生产环境取消确认不会把外部授权冒充成已添加，可在有效期内继续登记。授权会话受管理员 owner、有效期和数量上限约束。部署切换/重启后未完成的内存授权任务需重新开始；当前不承诺跨多个任意 API 实例无缝转移设备码任务。

首次登记自动启用 Grok transport，但**不改变默认模型、租户可见性或现有分组**。在订阅模型目录中查看各账号资格，并显式选择导入到模型草稿，最后点击模型管理的“保存并生效”。订阅目录不是 Console API 模型目录。目录未知/过期保留旧资料但不当作已证实的账号资格。

模型分组或模型级 transport 选择 `Grok 订阅`，协议必须为 `responses`。Grok 请求使用受管订阅凭据和固定订阅 endpoint，分组原有 API Key/Base URL 不会被用作订阅回退。不要填写假 API Key。

## 优先级、冷却和账号生命周期

每次请求优先使用列表中靠前且可用、满足已知模型资格的账号。A 成功则不调用 B/C；下一次仍优先 A。上移/下移保存完整账号集合，新顺序作用于后续请求，不抢占已发送请求。它不是平均轮转，也不按剩余百分比自动重排。

明确套餐耗尽进入冷却，默认 60 分钟，可配置 1–10080 的整数。普通 RPM/TPM 限流、未知 403、HTML challenge、5xx 或网络结果未知不会触发无界换号。全部冷却返回最早可重试时间；永久鉴权失效显示需重授权。账号某模型不具备资格不等于整个账号损坏。

点击账号的“重授权”只能替换相同身份，保留优先级位置；Vault ref 可以变化。重复添加同一身份会被拒绝，应使用重授权。Access token 到期本身不意味着永久断开；共享管理器按需刷新。刷新结果未知时不重复消费旧 refresh token，使用明确的诊断/重授权流程。

删除/断开先从受控配置移除引用，再停用本地凭据。删除最后一个账号自动停用订阅。远端撤销未确认时显示警告，不代表本地仍可使用。候选补偿和重授权旧 ref 清理只做本地撤销，避免误撤销新旧 token 共享的远端 grant。

## 额度和计量

套餐额度页显示独立 `Grok 订阅` 账号。目录、额度采集和模型请求共用凭据刷新协调。余额、周期、百分比缺失时显示未知/未提供，不推算无限额度、零使用或免费。订阅余额、模型真实 token usage、平台内部计费是三种不同数据。

Grok 当前不提供虚假的 WebSocket 接力开关。HTTP/SSE 使用完整可重放历史；不显示未证实的缓存收益。图像和 reasoning effort 只有订阅目录明确确认对应账号能力时才允许；未知能力直接报错，不静默换另一个计费模型。图片理解辅助链和 Chat-Completions-only 门禁不开放 Grok 订阅，前后端保持明确限制。Embedding、语音和生图服务不会因聊天接入自动获得 Grok 能力。

## 故障处置

| 表现 | 处理 |
| --- | --- |
| 已授权待登记 | 在会话有效期内继续平台登记；确认取消不等于完成 |
| 生产操作结果不确定 | 保留 operationId，查询操作结果并刷新，不盲目重复提交 |
| 全部账号冷却 | 查看最早恢复时间；不要靠持续换号规避供应商限流 |
| `refresh_outcome_unknown` | 检查是否已有新 Vault generation 可恢复；否则重授权，不重放旧 token |
| `credential_publication_pending` / recovery_required | 保留签名发布门禁，先恢复双端回执，不手工改签名/配置文件 |
| 目录未知或额度未知 | 重试专用查询，保留管理员模型配置；不推断免费或可访问所有模型 |
| 服务端未支持 | API/Worker 升级完成前不启用；不影响 Codex 原卡片 |
| 远端撤销未确认 | 本地已经移除；由账号负责人在 xAI 侧核查授权，无需传递 token |

协议来源、入口地图及测试见[实施记录](reviews/grok-subscription-implementation.md)和[测试对照](reviews/grok-subscription-validation.md)。
''')
put('docs/grok-subscription-rollout.md',r'''
# Grok 订阅发布与回滚

## 上线前条件

代码 PR 不执行部署。生产全局池要求既有共享 PostgreSQL 和受管持久化 Vault；开发用内存 store 不代表多进程生产一致性。API 与 Runtime Worker 均须升级到识别 Grok config/transport/continuation 的版本，Web 升级后再允许管理员登记。

运行状态新增 `<prefix>_grok_credential_runtime_state` 和 `<prefix>_grok_refresh_journal`，不重命名、不复制、不清空 Codex 表。新表通过受信前缀和 provider 名字生成，长前缀有稳定摘要以满足 PostgreSQL 标识符限制。发布必须走现有 expand 迁移计划、后置条件和观察回执，不把 `CREATE TABLE IF NOT EXISTS` 当作跳过迁移门禁的理由。用 `node scripts/release/grok-migration-evidence.mjs <实际生产基线> <候选SHA>` 生成只读计划；该命令不执行数据库操作。

Grok 正常刷新采用发布 fence → 凭据锁的单一顺序。锁内状态查询复用同一 PG client，避免 `poolMax=1` 自锁。刷新 journal 只保存 ref/generation，不保存 token。上游成功但 Vault 写入回执丢失时，重新读取更高 generation 并推进签名身份；不能重发已经消费的旧 token。双端回执不完整时保持 recovery_required，不伪造健康状态。

Staging 必须用独立账号/Vault/namespace，显式提供 `grokSubscription` overlay。禁止从生产配置复制 refresh token 或旧 Vault 快照。必要认证/推理域名纳入既有显式环境 allowlist，不关闭 TLS 校验，不设置任意域名放行。设备 OAuth 只在固定 API owner 上持续；有负载均衡多 API 时先提供可靠 owner 路由，当前实现不声称跨 API owner 无缝共享设备任务。

## 真实账号验证（尚未执行）

由获授权管理员在隔离环境进行：添加现有符合资格的订阅、确认外部授权与平台登记状态、查询订阅目录、显式配置候选模型、短文本和一次无破坏工具调用、子 Agent/标题/审批恢复、受控刷新、额度读取、排序/重授权/删除/断开。双账号上游行为在有第二个获授权账号后验证；不要求为编码购买账号，不通过耗尽套餐测试故障切换。

网络目的地必须为订阅服务，不能用 API Key 成功来替代订阅验收。记录脱敏字段结构、终态、generation、用量和实际源 SHA，不保存 token、用户码、完整提示词或原始上游 body。OAuth public client/scopes 的适用性、订阅资格及集中商业使用许可由账号/平台负责人确认；开源参考实现不构成远端服务许可。

## 功能回滚（保留新代码）

通过受控配置保存关闭 Grok。停止新请求及后续新工具腿；已经发出的一次请求按既有取消/终态处理，不重放工具。检查默认、标题、压缩、组织 Agent 等引用，只有明确获授权的配置调整才选择替代模型；不要悄悄将显式 Grok 请求换为另一个付费提供方。保留账号/事件以便诊断；需要撤销时走卡片断开流程。

## 代码回滚（旧版不识别 Grok）

仅 `enabled:false` 不够。先在新代码下使所有模型配置和辅助引用恢复旧版可解析集合，停用并移除 Grok 引用，等待相关任务结束。用待回退旧版的 parser 和真实配置/会话样本做隔离验证；含 `xai_grok_subscription` continuation 的历史可能使旧 reader 不兼容。

不能证明旧 reader 能读取时选择修复性前向发布，限制回退到支持新枚举的版本。禁止删除生产事件/会话或删表来让旧版启动。新增表可以保留。遵循既有 release rollback 和签名身份恢复步骤，禁止直接编辑 publication/receipt 欺骗一致性校验。
''')
put('docs/reviews/grok-subscription-implementation.md',r'''
# Grok 订阅实施记录

日期：2026-09-12（Asia/Singapore）。主依据：《agent-saas：Grok 订阅鉴权与 Codex 同机制接入实施方案》2026-09-11 v1.0。

## 对焦与实现取舍

原实施基线 `d59eca1e1cef7e83a1e59634569f80497ca37834`，收尾时同步 `main` 的 `eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b`；最终精确 SHA 以 PR head/CI 为准，不把基线当成最新。根目录和本次相关目录的 tracked `AGENTS.md` 查询未发现文件。Node 22.23.1 / pnpm 10.18.3，冻结 lockfile，未升级依赖。

本地容器不可用时使用独立功能分支的 Ubuntu / PostgreSQL GitHub Actions 完成应用、构建与验证。临时应用脚本和开发 workflow 必须在最终 diff 清理；没有修改生产数据、部署或主分支。独立 `workbench/grok-validation` 仅存脱敏检查报告，报告明确记录实际受测 SHA 和是否干净工作树，不把失败/未提交工作树当成已验证 commit。

共用 `subscriptionCredentialFailover`、`subscriptionCredentialLock`、`subscriptionCredentialRuntimeState`、`subscriptionAccountBinding`、`subscriptionTelemetry` 等小模块；Codex 路径、原表名和错误策略保留兼容包装。Grok 协议、身份解析、错误分类、model catalog、请求归一化独立，不复制 Codex originator、账号 claim 或 WebSocket 假设。

刷新结果不确定使用 ref/generation journal 和 Vault 高代读回。生产 publication fence 在 credential lock 外层；在 PG 锁内复用已借出的连接，真实 `max:1` 双池测试覆盖死锁回归。重授权先新 candidate，再原位置替换；发布前失败和提交不确定区分，补偿不远端撤销共享 grant。

## 协议依据与未确认边界

公开文档：[xAI 企业部署](https://docs.x.ai/build/enterprise)、[OpenClaw xAI provider](https://docs.openclaw.ai/providers/xai)。代码参考锁定 `openclaw/openclaw@c94dbef6c914c3433a1c6678996ffa99674c1ea2` 的 `extensions/xai/xai-oauth.ts`、`provider-catalog.ts`、`usage.ts`。参考协议行为，不引入 OpenClaw 运行时；本项目代码为独立实现。

| 内容 | 实现和证据边界 |
| --- | --- |
| OIDC discovery | 固定 `https://auth.x.ai/.well-known/openid-configuration`，issuer 和 HTTPS host 白名单校验，拒绝重定向和 URL userinfo |
| 设备码 | RFC8628 grant；pending/slow_down/denied/expired；管理员 owner、数量/TTL、单次交换 |
| 身份 | 使用 Bearer 认证的受信 userinfo `sub`，不信任前端 accountId 或未验证 JWT；仅已验证邮箱用于脱敏显示 |
| Public client | 默认公开参考 client，可配置明确获准 client；bundle 保存签发 client，刷新不会跟随之后配置错用 client |
| Responses | `https://cli-chat-proxy.grok.com/v1/responses`；HTTP/SSE、完整历史、自有工具 loop、无 API Key fallback |
| 模型目录 | 订阅 `/v1/models`，按账号读取、并集与资格、短缓存，失败保留 stale 而非删除管理员模型 |
| 额度 | `/v1/billing?format=credits`；camel/snake、数值/周期/余额均验证，缺失不当作零/无限 |
| 状态/能力 | 不启用未验证 WS/服务端接力/cache key；图像/effort 需目录确认；独立图片理解、Chat-only 门禁明确限制 |
| 商业许可/真实账号 | 资格、scopes/client 适用性、上游实调和集中使用许可没有由 CI 证明，需上线验收 |

没有真实账号成功响应样本，不能将模拟 SSE、OAuth 或余额夹具称为真实上游认证。未知 403、普通 429、5xx、HTML challenge 保守报告，不盲目封号或扫池；明确耗尽才进入 quota cooldown。

## 接线地图

| 入口/组件 | 实际接线或限制 |
| --- | --- |
| 主请求 | rawRuntimeRunDispatch → modelAdapterFactory → GrokSubscriptionResponsesTransport，依赖来自 modelSubscriptionRuntime |
| 子 Agent | subagentRunner 使用共享 factoryDependencies；保留 model resolver 和 tenant 权限，不建立第二个池 |
| 组织 dispatcher | 订阅连接不强制 API Key；不改变普通/dispatcher 的角色、委派和工具权限边界 |
| 标题 | createTitleModelAdapterFactory 注入同一管理器/网络服务，独立会话 binding |
| wake/审批/压缩 | 逻辑 model ref 重解析；runtimeModelResolution、事件/continuation provider 类型支持 Grok；正常历史/工具输出保留，跨绑定 opaque reasoning 不回放 |
| 图片理解辅助 | 配置与运行前显式限制 Grok 订阅；不是把 token 填进旧 API Key 客户端 |
| 门禁 | 现有 Chat Completions-only 能力不扩展为假 Responses 支持 |
| 记忆整理 | 既有 raw runtime/factory 语言路径复用，独立 embedding 不变 |
| 配置发布 | Grok 操作注册精确字段；API/Worker sharedConfigRefresher 消费；configIdentity 受管 ref/version；ProductionModelPublisher 轮换/恢复 |
| Web/移动端 | 使用标准模型列表/事件与逻辑引用，未下发全局订阅 token；移动端不新增管理员页面 |

详见[测试覆盖对照](grok-subscription-validation.md)、[操作指南](../grok-subscription.md)和[发布回滚](../grok-subscription-rollout.md)。
''')
put('docs/reviews/grok-subscription-validation.md',r'''
# Grok 订阅测试与证据对照

真实账号验证：**未执行**。CI 使用明确的 fixture 字符串、模拟 xAI HTTP 和隔离 PostgreSQL；没有读取生产凭据、耗尽真实套餐或部署。通过某项机制测试不代表所有渠道已完成真实账号端到端验收。

## 已读回的干净提交证据

`1f645611338a367fa7b8056cb60b8e825b2ea414`：server/web/shared/mobile typecheck 通过；订阅 18 文件 158 测试通过；配置发布/身份 17 文件 187 测试通过；UI 7 文件 91 测试通过；ratchets 通过。
运行：https://github.com/ZengLeiPro/agent-saas/actions/runs/34626946711 。后续新增测试的结果以最终 PR head CI 为准，不能沿用这个旧 SHA 宣称最终通过。

## T01–T36 映射

下列路径在 `server/src/__tests__` 下，另有明确标注的 Web、release 或 quota 测试。共用机制回归与提供方夹具各自保留，不删除旧 Codex 断言。

| 编号 | 自动化依据 | 范围及真实验证边界 |
| --- | --- | --- |
| T01 | grokTransportContracts.test.ts、Codex 原 transport/failover | A 成功停止，下一请求仍按优先级 |
| T02 | grokTransportContracts.test.ts | 明确耗尽冷却、释放、跳过；未耗尽真实套餐 |
| T03 | grokTransportContracts.test.ts、grokAdminContracts.test.ts | 到期参与、排序新请求生效 |
| T04 | grokCredentialLifecycle.test.ts、grokTransportContracts.test.ts、grokAdminContracts.test.ts | auth 状态、后继候选、重授权原位替换 |
| T05 | grokTransportContracts.test.ts、grokOAuthContracts.test.ts | 普通 429/403/5xx/HTML/网络不扫池 |
| T06 | grokTransportContracts.test.ts、公共/Codex failover | 冷却最早时间、混合不可用、无 API fallback |
| T07 | grokTransportContracts.test.ts、codexStreamGuardTransport.test.ts | 401 至多一次，recoveryAttempt/取消边界 |
| T08 | grokCredentialLifecycle.test.ts | 并发调用共用一次 refresh |
| T09 | grokCredentialPostgres.test.ts | 两个独立 PG pools/管理器/Vault 实例、max:1；不冒充两个 OS 进程或真实蓝绿部署 |
| T10 | grokCredentialLifecycle.test.ts、Codex generation fence | 旧代不覆盖新代，同代 auth 优于 quota |
| T11 | grokCredentialPostgres.test.ts、grokCredentialLifecycle.test.ts | detach/refresh 无复活、锁顺序与池借用；真实生产竞态仍需演练 |
| T12 | grokCredentialLifecycle.test.ts、grokProductionPublication.test.ts | 丢失上游/Vault 回执、高代读回、不重复消费旧 refresh |
| T13 | grokOAuthContracts.test.ts | discovery、设备码、可信 userinfo、有效期、public metadata |
| T14 | grokOAuthContracts.test.ts | pending/slow_down/denied/expired 停止条件 |
| T15 | grokOAuthContracts.test.ts、Web GrokSubscriptionCard.test.tsx | 恶意 endpoint、URI、issuer、重定向策略 |
| T16 | grokOAuthContracts.test.ts、grokAdminContracts.test.ts | 重复 poll/complete、TTL/cancel/capacity |
| T17 | grokAdminContracts.test.ts、grokOAuthContracts.test.ts | owner、普通/组织用户、ref/身份限制 |
| T18 | grokSchemaAndCapability.test.ts、grokAdminContracts.test.ts | 首次无 root、disabled 可显示、无账号不能启用 |
| T19 | grokAdminContracts.test.ts | 精确集合、重复/未知/缺项、revision 冲突 |
| T20 | grokProductionPublication.test.ts、productionModelPublication*.test.ts | 受控登记回滚、恢复失败、已提交不误作未提交；外部服务用 mock |
| T21 | grokProductionPublication.test.ts、grokAdminContracts.test.ts | 确认/revision/操作 scope，Grok 不改 Codex |
| T22 | grokProductionPublication.test.ts、sharedConfigRefresher/configIdentity 回归 | 双角色独立内存消费者和签名回执，刷新仅推进 credential digest |
| T23 | grokAdminContracts.test.ts | 删除、最后一个停用、断开、远端未确认 warning |
| T24 | grokSchemaAndCapability.test.ts、environmentSafety/render-config/release 契约 | staging overlay/allowlist、旧配置；无真实部署 |
| T25 | grokResponsesAdapter.test.ts、grokTransportContracts.test.ts、Web form | 统一原生工厂、固定订阅 endpoint、协议不符拒绝 |
| T26 | grokResponsesAdapter.test.ts、已有 Responses parser 回归 | 分片 UTF-8、arguments、canonical output、缺终态不成功 |
| T27 | grokTransportContracts.test.ts、grokResponsesAdapter.test.ts、既有 kernel/approval/billing 回归 | 取消不换号；transport 不执行工具；真实外部工具副作用未发起 |
| T28 | grokTransportContracts.test.ts、runtime continuation/replay 回归 | tenant/session/account binding、移除 opaque、保留工具结果 |
| T29 | factory/主运行/子 Agent/标题/恢复相关 affected CI + 实施接线表 | 共享依赖已接线；真实 Grok 主/子/组织/标题/唤醒/审批多入口端到端留作上线验收 |
| T30 | grokSchemaAndCapability.test.ts、grokTransportContracts.test.ts、既有压缩/记忆辅助回归 | 支持路径用原 runtime；媒体/门禁能力不符显式拒绝 |
| T31 | Web ModelManager/GrokSubscriptionCard.test.tsx、grokAdminContracts.test.ts | 独立卡片与账号 UI/HTTP 生命周期；不含真实浏览器到 xAI 登录 |
| T32 | Web GrokSubscriptionCard.test.tsx、productionSave/writePolicy.test.tsx | 只读/旧后端/弹窗受阻/确认/失败刷新 |
| T33 | grokTransportContracts.test.ts、既有 tenant/model 权限回归 | 绑定隔离与现有租户门禁；没有真人多租户上游并发验收 |
| T34 | grokSubscriptionQuota.test.ts、grokModelCatalog.test.ts、quota 服务回归 | 缺失/畸形/超大数/过期、共享 manager；真实 billing 字段待核验 |
| T35 | codex* 全部定向测试、正式 affected CI | 原 OAuth/WebSocket/排序/identity/旧配置保持 |
| T36 | 类型/ratchets/config governance/release/static/security checks、脱敏断言、最终 head CI | 不使用真实 secrets；CI SHA/attempt 不混用，源码扫描不等于第三方安全认证 |

## 复现命令

工具链取根 package.json，先 `pnpm install --frozen-lockfile`。在隔离 PG 设置 `TEST_DATABASE_URL` 和 `MEMORY_CONSOLIDATION_TEST_PG_URL`。

```bash
pnpm -F server exec vitest run codex grok subscription
pnpm -F server exec vitest run productionModelPublication configIdentity sharedConfigRefresher
pnpm -F web exec vitest run src/components/ModelManager src/components/PlatformAdmin/pages/ProviderQuota
pnpm -F server typecheck
pnpm -F web typecheck
pnpm -F @agent/shared typecheck
pnpm -F mobile typecheck
pnpm check:ratchets
pnpm test:config-governance
pnpm test:release-contracts
pnpm -F server build
pnpm -F web build
node scripts/release/grok-migration-evidence.mjs <实际基线> <候选SHA>
# 完整 PR preflight 包含工作区 coverage、PG、发布和生产 Web 构建
pnpm preflight:pr
```

GitHub PR 正式 CI 按当前主分支的 affected/import 图和 source guards 选择相关测试；main 的全量 coverage 门禁不由本功能降低。诊断 action 还单独运行 shared/server/web 全量测试；只报告实际完成的结果，未执行项不能写成通过。
''')
subprocess.run(['node','scripts/check-max-lines-ratchet.mjs','--prune'],check=True)
print('Added Grok production recovery/catalog verification, explicit PG gate, read-only migration evidence and operator/rollout/test documentation')
