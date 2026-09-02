# TASK-331 移动端 V1 证据矩阵

> 审计时间：2026-09-02；分支：`task/TASK-331-mobile-v1-roadmap`
> 审计代码基线（证据文档提交前）：`f6d8e3f671d2f14a951e7f7e1ebfce80d752609a`；当前 `origin/main`：`4d7313844a3a23d35e07a9d8afe725cd480f940e`。
> 权威标准：`assets/20260828/TASK-307-移动端V1实施方案.md`，尤其任务清单（原文 276–601 行）、Gate A–F（原文 680–720 行）与外部证据（原文 724–740 行）。
> **结论：代码/契约已有大量通过项，但生产 Gate A–F 均未闭合，整体仍为 NO-GO。**

> Review 返工映射：`4a43f77eb` 是 M00-01 Router/Gate A 支持提交，`ec819394b` 是 M60-04 发布授权修复，`d7e45882b` 是 M30-01 HTTP 后置异步竞态修复，`016e4dd42` 是 M30-01 Web saved-account 可序列化切换修复。以上均为当前最终重放后的提交。

## 1. 审计口径

1. 提交从当前仓库 `git log origin/main..HEAD` 及 `origin/main` 的可达历史重建；只使用当前完整 SHA，不使用 rebase 前 SHA。`node scripts/verify-task331-evidence-matrix.mjs` 必须验证 36 个唯一 ID、无旧 `mobile/src/app` 路径，且本文全部 40 位 SHA 可达当前 `HEAD`。
2. 表中“主体”优先标记最终闭合权威定义的提交；早期提交信息中的编号若与权威定义错位，只按实际 diff 语义列为“支持”，不伪造一项一提交。例如早期 `M50-01 unify message timeline RenderModel` 实际支持 M20-05/M40-04，而不是权威 M50-01。
3. M00-01 已在 main：PR #289；主体 `f0c5c5c79b83a275f8884ec1f11fa8b7dec50394`，支持 `2027c25d06abf7379643f44ace76fe83da4459b1`。M00-03 只有人工渠道决策，**没有代码提交**。
4. “通过”仅表示仓库代码/契约自动化通过；“部分”表示代码门禁存在但仍依赖真实环境、制品或人工事实；“blocked”表示该项没有可宣称完成的代码或关键输入。代码状态不等于生产 Gate。
5. 下列定向用例数来自当前树实际执行；`pnpm mobile-contract` 共 **1,689** 项（Shared Vitest 1,299；Mobile Vitest 192；Mobile Node 198），另含 Shared/Mobile typecheck 与离线 Expo 检查。

## 2. 36 项证据矩阵

| ID | 用户结果 | 当前 full commit hash（主体/支持） | 关键文件 | 自动化证据命令 + 用例数 | 代码状态 | 外部证据缺口 |
|---|---|---|---|---|---|---|
| M00-01 | 生产只可进入对话/设置，延期入口和深链渲染前 fail closed | 主体 `f0c5c5c79b83a275f8884ec1f11fa8b7dec50394`；支持 `2027c25d06abf7379643f44ace76fe83da4459b1`；任务支持 `4a43f77eb0e380132dd62897c903976508eced21`；main PR #289 | `mobile/src/v1/v1Capabilities.ts:1`；`mobile/src/v1/V1RouteGate.tsx:1` | `pnpm -F mobile exec vitest run src/v1/v1Capabilities.test.ts src/v1/v1RouteGate.runtime.test.tsx src/v1/v1RouteInventory.test.ts src/v1/v1UiNavigationScan.test.ts`：43/43 | 通过 | 真实生产包冷装、UI/深链遍历回执 |
| M00-02 | 发布签名配置不再回退 debug，源码/日志不含签名秘密 | 主体 `622cd1284598c989114fb478dced4bd516206c3b` | `mobile/plugins/withAndroidSigningConfig.js:26`；`docs/mobile-android-credential-incident-runbook.md:1` | `pnpm -F mobile test:android-signing`：7/7，另完成 source scan 与 Android clean prebuild/Gradle 静态核验 | 部分 | 凭证管理员轮换回执、既有 signer 指纹、旧包→新包真实升级连续性、发布 robot token |
| M00-03 | Android 首发渠道、owner、包名、签名、升级和回滚方式有唯一书面决定 | **无代码提交（0）** | 权威外部决策项；仓库无可替代实现 | 无自动化命令：0 项；不得以 flavor 代码代替决策 | blocked | Store/Enterprise/两者的唯一渠道决策及产品/发布负责人签字 |
| M10-01 | 首装只连接受信 HTTPS/WSS 服务，任意 origin 和示例域被拒绝 | 主体 `fc14e6ba6ebe3b8ca1f0ead0b491ef936cc71da3` | `mobile/src/platform/trustedServiceOrigin.ts:54`；`mobile/src/platform/mobileConfig.ts:38` | `pnpm -F mobile exec vitest run src/platform/trustedServiceOrigin.test.ts src/platform/mobileConfig.test.ts`：22/22 | 通过 | 唯一生产 API/WSS、dev/staging/prod 域清单、真实 TLS/MITM 抓包 |
| M10-02 | Expo SDK 55 依赖矩阵收口且双平台原生生成可解释 | 主体 `97a2d545e9778193e7cb34361174696d49eca29d` | `mobile/package.json:52`；`pnpm-workspace.yaml:13` | `pnpm mobile-contract`：1,689/1,689；其中 `EXPO_OFFLINE=1 ... expo install --check` 退出 0 | 部分 | 在线检查发现 55.0.31，但受 `minimumReleaseAge: 2880`（48h cooling）未升级；离线结果不得写成在线 0 mismatch；仍需在线检查与双平台真实 clean prebuild 回执 |
| M10-03 | App ID、版本、build number/versionCode 与 Git SHA 可由单一 manifest 反查 | 主体 `f49d65c86f84cd4e8f66e8a3659c5f6ffdb6e9ef` | `mobile/scripts/release-manifest.cjs:42`；`mobile/release-manifest.json:1` | `pnpm -F mobile test:release-manifest`：16/16 | 部分 | Apple/Google/Expo 组织身份、Team/EAS project、现网最高版本与递增链、真实 RC manifest |
| M10-04 | Store AAB 与 Enterprise APK 的权限、更新和签名路径分离 | 主体 `99a307aab1d8f4037f6d627133ae0ca1ca35ca44` | `mobile/eas.json:1`；`mobile/src/updates/enterpriseUpdateManifest.ts:20` | `pnpm -F mobile test:m10-04`：30/30（Vitest 11 + Node 19） | 部分 | 渠道决定、真实 Store/Enterprise 签名、AAB/APK 解包、旧正式包覆盖升级和 manifest 验签回执 |
| M10-05 | 冷装不索取非必要权限，媒体权限只在用户动作时请求，拒绝后文字聊天仍可用 | 主体 `0c6ecf50d5439c7d0289d958ada94d5005f48c5e` | `mobile/src/platform/jitMediaPermissions.ts:30`；`docs/mobile-m10-05-privacy-and-store-review.md:1` | `pnpm -F mobile test:m10-05`：16/16（Vitest 5 + Node 11） | 部分 | 真机冷装权限弹窗=0、最低 OS/iPad 口径、Apple Privacy/Google Data Safety/隐私政策与抓包一致性 |
| M20-01 | 文字/图片/文件/系统分享只以 attachmentId 权威提交，重试不丢 ID | 主体 `f7dcf3c81a89c87c1e10ffef1ccfdd3599f7c50e` | `shared/src/lib/chatSubmission.ts:108`；`mobile/src/lib/chatSubmissionAdapter.ts:14` | `pnpm -F @agent/shared exec vitest run src/lib/chatSubmission.test.ts`：7/7 | 通过 | 真实生产上传→materialize 抓包、跨租户伪造与路径泄漏复核 |
| M20-02 | 排队/插话/取消以服务端队列为真源，重试幂等且杀进程不重复执行 | 主体 `fdfdcc0041bd3b0695ce5132c8bf382a439df1c2` | `shared/src/lib/chatQueue.ts:95`；`shared/src/lib/chatQueueWs.ts:28` | `pnpm -F @agent/shared exec vitest run src/lib/chatQueue.test.ts src/lib/chatQueueWs.test.ts`：26/26 | 通过 | 生产 durable queue、多设备、杀进程、ACK 丢失的服务端回执 |
| M20-03 | seq/epoch/overflow、queue/interaction/runtime 可幂等恢复且不形成 sync loop | 主体 `60805e109ed01e2ce808d05151464a20b2914437` | `shared/src/lib/syncRecovery.ts:76`；`shared/src/store/actions/wsHandler.ts:132` | `pnpm -F @agent/shared exec vitest run src/lib/syncRecovery.test.ts`：10/10 | 通过 | 生产 WSS 蓝绿切流、服务重启、旧版本兼容与真实 overflow 回执 |
| M20-04 | A 退出后旧 generation 不可发送或更新 B，缓存按租户/用户分区 | 主体 `281214b733eb5f9aed9e835978a03ece8b9e024a` | `shared/src/lib/identity.ts:48`；`shared/src/lib/wsClient.ts:207` | `pnpm -F @agent/shared exec vitest run src/lib/identity.test.ts`：6/6 | 通过 | 两个真实生产测试账号、禁用用户、真机 A→B 与磁盘/网络取证 |
| M20-05 | Tool/BusinessStep/presentation 共用安全 RenderModel，非 debug 不含 raw input/result | 主体 `91457c32891ad4fd18999499495b1fa614a292f1`；支持 `4b70cbde5cc0abe8c5888fed72e71ae19ad5ff79`、`99eae30351c96eccfc8724d8aeeec4718ac9d7c1` | `shared/src/lib/presentationPresenter.ts:214`；`shared/src/lib/renderModel.ts:284` | `pnpm -F @agent/shared exec vitest run src/lib/presentationPresenter.test.ts src/lib/renderModel.test.ts`：45/45 | 通过 | 生产 tenant debug policy、真机 accessibility tree/截图敏感串审计 |
| M20-06 | personal/assigned org Agent 路由明确，禁用/撤权/不可用不静默回退 | 主体 `ab910990296ad8ae0809e24a8372db0e0e63b9f4`；支持 `cafcde2d4150da460b9d0ca4574229564bf2e972` | `shared/src/lib/agentTarget.ts:96`；`mobile/src/lib/agentTargetRouting.ts:2` | `pnpm -F @agent/shared exec vitest run src/lib/agentTarget.test.ts`：4/4 | 通过 | 生产 org 指派/撤权、personal disabled、删除 Agent 与审计日志回执 |
| M20-07 | 长历史分页稳定，pending interaction 可达且 ACK/重复点击幂等 | 主体 `5a0d7e6032074b436e65b42c8e11c433a135819d`；支持 `15ecfde7e4c745607b674774d14bbd299ddddf20`、`af4e61a5b15d9e2fcf4b066da1e0b5a348913dbb` | `shared/src/lib/sessionListPager.ts:95`；`shared/src/lib/activeInteraction.ts:74` | `pnpm -F @agent/shared exec vitest run src/lib/sessionListPager.test.ts src/lib/activeInteraction.test.ts`：13/13 | 通过 | 生产万条消息/慢请求/ACK 丢失与真实 pending 冷启动回执 |
| M30-01 | 登录、刷新、失效、退出和换号按原子顺序断连、清状态并重建身份 | 主体 `3679009cfa50113fdb1c78cc8af298a11e20c5b2`；支持 `936b1efba4be81f4e042dbba3d894d1856be3b3b`、`e21b0e1920d83fe330d8007ee32416c49e7228b7`、`d7e45882bfc5307aa5275718855fd5c8354a2c6e`、`016e4dd42486f7582a86b324ae00748a9270bd4b` | `shared/src/lib/authLifecycle.ts:82`；`shared/src/lib/authFetch.ts:23`；`web/src/contexts/savedAccountLifecycle.ts:1` | Auth lifecycle 15/15；authFetch 15/15；Web saved-account 并发 2/2；OAuth handoff 11/11 | 通过 | 生产 OAuth provider/Universal Link/App Link、测试账号、真机 token 失效和 A→B 竞态 |
| M30-02 | cache schema v2 按账号分区，旧键迁移，备份/退出不保留业务明文 | 主体 `80d5872d4af4e48708e227307f20660b65070e71` | `shared/src/lib/cacheSchemaV2.ts:4`；`mobile/src/platform/mobileCacheAdapter.ts:6` | `pnpm -F @agent/shared exec vitest run src/lib/cacheSchemaV2.test.ts`：11/11 | 通过 | iOS/Android 真实 backup/restore、logout 后磁盘扫描、多租户同 sessionId 回执 |
| M30-03 | Agent switcher 只显示可用目标，切换时会话身份明确且不可静默换 Agent | 主体 `91cf4b254793aad509d06cec4950e9c10426c5a9` | `shared/src/lib/agentTargetTransition.ts:73`；`mobile/src/lib/agentTargetTransitionParity.test.ts:1` | `pnpm -F @agent/shared exec vitest run src/lib/agentTargetTransition.test.ts`：6/6 | 通过 | 生产 personal/org 组合、撤权历史只读、当前 run 切换策略真机回执 |
| M40-01 | Mobile 发送/排队/插话/停止接入 shared 状态机，不再以本地 outbox 为真源 | 主体 `a1785728f523e2688b355cca8175aa2c9b021ec1` | `shared/src/lib/chatClientState.ts:55`；`mobile/src/hooks/useChatAppState.ts:204` | `pnpm -F @agent/shared exec vitest run src/lib/chatClientState.test.ts`：8/8 | 通过 | 生产弱网、后台、杀进程、三条队列和重复 run=0 的端到端回执 |
| M40-02 | 长历史有界分页，运行态/未读跨设备一致且不跳错会话 | 主体 `2985a7b75c5f75264505f1e651e39e8057fdcb41`；支持 `ef4e07ef8008bb839fcd109e753dd0e823a86398` | `shared/src/lib/historyPager.ts:129`；`shared/src/lib/sessionRuntime.ts:44` | `pnpm -F @agent/shared exec vitest run src/lib/historyPager.test.ts src/lib/sessionRuntime.test.ts src/lib/sessionUnread.test.ts`：15/15 | 通过 | 真机 1000 会话、500/万条消息、低端 Android OOM/锚点与后台 run 回执 |
| M40-03 | Approval/AskUser 固定在 composer 上方，提交中禁用且 ACK 超时可重试 | 主体 `a72cb602abf37c46b5012746682f82ac99cdb3d9`；支持 `fe02d9b6a900de3a4ebcbb757dbc0233a4d7fe0b` | `shared/src/lib/activeInteraction.ts:74`；`mobile/app/chat/[sessionId].tsx:551` | `pnpm -F @agent/shared exec vitest run src/lib/activeInteraction.test.ts src/lib/interactionProtocol.test.ts`：13/13 | 通过 | 生产 Approval/AskUser、断线/重复点击、服务端唯一最终决策回执 |
| M40-04 | 工具、错误、runtime、BusinessStep 在移动端安全呈现，未知块有安全降级 | 主体 `fe6918069e578e274d76b8d1834090585e35a122`；支持 `6c5c8d7fdb5d7a9a8da5004bdc4b3eeede90cbd2` | `mobile/src/lib/presentationAdapter.ts:58`；`mobile/src/components/chat/MessageItem.tsx:210` | `pnpm -F mobile exec vitest run src/lib/presentationAdapter.test.ts && pnpm -F @agent/shared exec vitest run src/lib/presentationPresenter.test.ts`：37/37 | 通过 | 非 debug 真机 accessibility tree、真实 receipt/presentation/六状态步骤样本 |
| M40-05 | 离线/鉴权/模型/服务/附件/审批/运行错误均给出唯一可操作恢复动作 | 主体 `07030302b4f946986056d90c9ba16088a88ef160`；支持 `f5c34abd74ebdc154c1a4c58f79f823b396011b1` | `shared/src/lib/canonicalError.ts:140`；`mobile/src/services/authConnectionCapabilityAdapter.ts:19` | `pnpm -F @agent/shared exec vitest run src/lib/canonicalError.test.ts`：17/17 | 通过 | 生产 401/403/429/500、模型失效、draining、WSS timeout 与支持文案回执 |
| M50-01 | 文件/图片/相机/Share Intent 统一 attachmentId 契约，失败保留草稿并清临时文件 | 主体 `e1dc1a853cc4e43f348aafc80b8ac2e378a9328d`；支持 `206846577c968e1613f7f2b05f85b3c04d061ce6` | `shared/src/lib/incomingShare.ts:161`；`mobile/src/platform/incomingShareCoordinator.ts:52` | `pnpm -F @agent/shared exec vitest run src/lib/incomingShare.test.ts && pnpm -F mobile exec vitest run src/platform/incomingShareCoordinator.test.ts src/lib/attachmentUpload.test.ts`：19/19 | 通过 | 真机 content URI 撤权、低磁盘、并发 10 文件、伪 MIME/损坏媒体与服务端孤儿清理回执 |
| M50-02 | Artifact 以 artifactId 安全取回；主动 HTML/SVG 只下载/分享且警告 | 主体 `e2399dd8ab87cf778199f3cdffff13ea88d7aefa` | `shared/src/lib/artifactViewModel.ts:103`；`mobile/src/lib/artifactViewAdapter.ts:44` | `pnpm -F @agent/shared exec vitest run src/lib/artifactViewModel.test.ts && pnpm -F mobile exec vitest run src/lib/artifactViewAdapter.test.ts`：18/18 | 通过 | 真实过期签名 URL、跨租户/撤销/超大文件及恶意主动内容网络取证 |
| M50-03 | 旧 workspace HTML preview 在 V1 不可达，目录 token/JS WebView 风险关闭 | 主体 `6787db87a009e76619616008f6766006761fc3a7` | `mobile/src/v1/v1Capabilities.ts:1`；已删除 `mobile/app/chat/html-preview.tsx` | M00-01 四套 V1 路由测试命令：43/43 | 通过 | 真机恶意 HTML/SVG 对 sibling、beacon、form、iframe、scheme、外跳的 0 字节回执 |
| M50-04 | 录音/播放状态可清理，权限拒绝回文字；TTS 不健康时默认降级关闭 | 主体 `7ad614e55e32e9ff7865bebbbc5c4073d39bda55`；支持 `87eb9af3257dd686d12759d02e476a9c5c480561` | `shared/src/lib/voiceRecording.ts:96`；`shared/src/lib/ttsCapability.ts:6`；`mobile/src/services/voiceMediaCachePolicy.ts:18` | `pnpm -F @agent/shared exec vitest run src/lib/voiceRecording.test.ts src/lib/ttsCapability.test.ts`：11/11；Mobile media cache 2/2 | 部分 | **真实 STT/TTS**、麦克风权限拒绝、Range 播放、后台停止、长录音和缓存清理真机回执 |
| M50-05 | 前后台/弱网按预算退避，回前台 attach active stream，旧 pending 不跨版本自动重放 | 主体 `4fcd85275684f469becb0257220870a22b923c7b` | `shared/src/lib/appLifecycle.ts:276`；`mobile/src/platform/lifecycleAdapter.ts:35` | `pnpm -F @agent/shared exec vitest run src/lib/appLifecycle.test.ts src/lib/appLifecycleEffects.test.ts src/lib/pendingSubmissionRecovery.test.ts && pnpm -F mobile exec vitest run src/platform/lifecycleAdapter.test.ts`：22/22 | 通过 | 2G/300ms/5% 丢包/切网、后台 3秒至1小时、杀进程、服务重启真机回执 |
| M60-01 | Shared/Mobile P0 契约成为稳定门禁，OAuth 并发不再 timeout | 主体 `450f8322332bedb693ea684a728981804f1cd08f`；支持 `954fd05203c57e511bd68913bf947a7df49b1482`、`d206923eac4e19e7765b64f2221fa1e94f742003`、`f9f67f3f81454b745dfa887be7181b4b2388ed45` | `package.json:25`；`mobile/src/contracts/p0ContractManifest.test.ts:13` | `pnpm mobile-contract`：1,689/1,689，Shared/Mobile typecheck 通过，offline Expo 退出 0；OAuth handoff 11/11 | 部分 | required-check 多次连续稳定回执；在线 Expo 0 mismatch；根并行 test 的资源策略需在 CI 证明不再 timeout/137 |
| M60-02 | iOS/Android 四槽原生 E2E 门禁能拒绝模拟器、跨 SHA、重放和缺槽证据 | 主体 `6d9fa89c704ad9901a02e6e8b2c0e9903fcca1e9` | `.github/workflows/mobile-native-e2e.yml:1`；`mobile/e2e/maestro/tests/native-e2e.test.mjs:1` | `pnpm -F mobile test:m60-02`：13/13 | 部分 | 当前四槽 pass 数据位于 `tests/fixtures`，只是 mock；缺最低 iOS、最新 iOS、Android 旗舰、低端/小屏四台真机及 provider 回执 |
| M60-03 | clean prebuild 对最终 manifest/entitlement/PrivacyInfo/Gradle 做 fail-closed 静态门禁 | 主体 `75bef1968bf80de95f375caabb9340d720cce605`；补充 `42a99418e103a4686abde5e8412e5484619d78f3` | `mobile/scripts/native-policy.test.mjs:1`；`docs/mobile-m60-03-native-prebuild-gate.md:1` | `pnpm -F mobile test:m60-03`：14/14 mutation tests | 部分 | clean prebuild/golden 不是签名 release 制品；仍缺真实 IPA/AAB/APK 的 plist/entitlement/manifest/Gradle 与签名核验 |
| M60-04 | 同一已审 SHA 构建、验证、提交，产物绑定版本/hash/签名/SBOM/审批 | 主体 `602a4e63a26af3f9cfa4553cb35c9c4c08287ecd`；支持 `ec819394b7be8919c46df51546077b9001374ee0` | `.github/workflows/mobile-submit.yml:1`；`mobile/scripts/mobile-release-evidence.test.mjs:1` | `pnpm -F mobile test:m60-04`：28/28 | 部分 | 组织 robot token、保护环境审批、EAS build ID、真实 IPA/AAB/APK、签名指纹、SHA-256、SBOM/provenance、submit 回执 |
| M60-05 | JS/native crash、ANR、启动/网络失败按版本/环境/cohort 可观测且默认 PII scrub | 主体 `b0fe8339524bb55df83bdb36700ad29269ac0077`；补充 `612f917208b3fa43c0fe3078ac70901338052dc2` | `mobile/src/telemetry/telemetryClient.ts:57`；`docs/mobile-m60-05-observability.md:1`；`server/src/telemetry/mobileTelemetry.ts:1` | `pnpm -F mobile test:m60-05`：9/9；Server route 注册有定向支持测试，但 Server 全量仍在跑 | 部分 | 组织监控平台、owner、dashboard URL、SLO/阈值、真实 JS/native crash/ANR、dSYM/source map/mapping 上传回执 |
| M70-01 | RC 矩阵的设备/网络/账号/Agent/会话/权限/交互/产物逐项留证 | 主体 `3f6cdf2b814143c291079e67f3a713e0e44f2063` | `.github/workflows/mobile-rc-regression.yml:1`；`docs/mobile-m70-01-rc-runbook.md:1` | `pnpm -F mobile test:m70-01`：40/40 contract/workflow tests | 部分 | 真实 RC、四槽真机、生产近似网络/账号/Agent/制品矩阵、P0/P1 清零签字；模拟 receipt 不算回归回执 |
| M70-02 | 冷装/升级/cache v1→v2/token 失效/pending/kill switch/回滚均绑定版本设备制品 digest | 主体 `f44556946b4c9e5073da8bd9968596700484a42b` | `.github/workflows/mobile-upgrade-rehearsal.yml:1`；`docs/mobile-m70-02-upgrade-rollback-runbook.md:1` | `pnpm -F mobile test:m70-02`：18/18 | 部分 | 现网最高版本升级链、真实旧包→RC、Store rollout stop、kill switch、N-1/N API、Enterprise 签名回滚 manifest 与演练回执 |
| M70-03 | 员工→封闭→小比例→扩大→全量逐阶段审批，身份串线/重复执行等直接停止 | 主体 `2eb9c289b4dd4819cf79feef27ea2000e4eb2a75` | `.github/workflows/mobile-rollout-gate.yml:1`；`docs/mobile-m70-03-rollout-gate-runbook.md:1` | `pnpm -F mobile test:m70-03`：33/33 | 部分 | 灰度 owner、真实 environments/审批权限、监控 adapter/dashboard/SLO、各阶段 cohort 与签名 stage receipt；test fixture/模拟 receipt 不算灰度回执 |

**计数校验：M00=3、M10=5、M20=7、M30=3、M40=5、M50=5、M60=5、M70=3，共 36 项。**

## 3. 当前完整验证事实

| 验证项 | 当前事实 | 解释边界 |
|---|---|---|
| Mobile contract | `pnpm mobile-contract` 当前退出 0：Shared typecheck；Shared 100 files / 1,299 tests；Mobile typecheck；Mobile Vitest 41 files / 192 tests；Mobile Node 198 tests；合计 1,689 tests | 证明 Shared/Mobile 代码与契约当前通过；不证明生产服务、真机、签名、商店或灰度通过 |
| Expo 检查 | `EXPO_OFFLINE=1 pnpm -F mobile exec expo install --check` 退出 0，并明确输出 `Dependency validation is unreliable in offline-mode` | 只能记“offline 检查通过”。在线可见 Expo 55.0.31，但 `pnpm-workspace.yaml:13` 的 2,880 分钟（48h）cooling 令当前未升级；**不能写在线 0 mismatch** |
| Web 全量与 build | 288 files / 2,222 tests 全部通过（3 个互斥批次：96/728、96/810、96/684）；production build 通过 | 保留非阻断 Browserslist 数据旧、部分大 chunk、Radix Description 与 React act warning；未掩盖失败 |
| 六包 typecheck | server、web、shared、mobile、hand-server、acs-orchestrator 均通过 | 类型门禁与测试门禁分别留证，不混写 |
| 初次根并行 test | 曾发生 OAuth timeout 与进程内存 137 | 不能隐去；随后 `954fd05203c57e511bd68913bf947a7df49b1482` 稳定 OAuth 并发，`d206923eac4e19e7765b64f2221fa1e94f742003` 对齐 rebase 后 runtime fixtures，定向测试已转绿；当前 mobile-contract 亦转绿 |
| Server 全量 | 655 个测试文件按 5 个互斥批次全覆盖：613 passed、42 skipped；6,026 tests passed、225 skipped、3 todo，0 fail | skipped 主要依赖 PostgreSQL 等外部条件，未伪装成通过；另有一个旧后台任务因持久工作区缺少 `tsc` 在测试前退出，已被后续权威分批结果取代 |
| Hand Server | typecheck 通过；9 files / 61 tests 全部通过 | 不代表真实远程手、云账号或生产网络已验收 |
| ACS Orchestrator | typecheck 与 build 通过；33 files / 290 tests 全部通过 | build 保留 1.6 MB bundle warning；不替代真实集群/网络验收 |
| 非阻断 warning | 本轮见 Undici `EnvHttpProxyAgent is experimental` warning；Web build 有 Browserslist/大 chunk warning；历史曾有 FileHandle GC 与 DEP0137 warning | 均需记录但当前不作为代码失败；若升级为资源泄漏/未来 Node hard error，应单独修复，不可用“非阻断”永久豁免 |

## 4. Gate A–F 逐项判定

判定格式为“代码/契约；生产 Gate”。即使代码通过，只要缺生产域、渠道、账号、签名、隐私、真机、制品、监控或灰度事实，生产项仍为 **blocked**。

### Gate A：范围

1. **生产包只有对话/设置两个 Tab**：代码/契约通过（M00-01，43/43）；生产 Gate **blocked**（无真实生产包冷装截图/路由回执）。
2. **Spike、Files、Cron、Memory、Connections、Admin 从 UI 与深链均不可达**：代码/契约通过；生产 Gate **blocked**（无签名包 UI+URL/Universal Link/App Link 遍历）。
3. **无“正在开发中”假按钮**：代码扫描通过；生产 Gate **blocked**（无真实生产 bundle/真机菜单验收）。

**Gate A：blocked。**

### Gate B：身份与契约

1. **A→退出→B 零串号、零缓存泄漏、零旧 WS 更新**：identity/auth/cache 契约通过；生产 Gate **blocked**（无两真实账号真机、磁盘和网络取证）。
2. **attachmentId 权威提交通过**：Shared/Mobile 契约通过；生产 Gate **blocked**（无生产上传/materialize 抓包）。
3. **durable queue/steer/cancel 杀进程可恢复**：reducer/adapter 契约通过；生产 Gate **blocked**（无生产队列与杀进程回执）。
4. **seq+epoch+overflow 与 queue/interaction/runtime 完整恢复**：sync 契约通过；生产 Gate **blocked**（无生产 WSS 重启/蓝绿/overflow 回执）。
5. **personal disabled、org Agent 指派/撤销/不可用均闭环**：target 契约通过；生产 Gate **blocked**（无真实组织策略、指派/撤权审计）。

**Gate B：blocked。**

### Gate C：呈现与交互

1. **非 debug 不显示 raw tool input/result**：RenderModel 契约通过；生产 Gate **blocked**（无真实 tenant policy 与 accessibility tree 取证）。
2. **`system-error`、runtime status、presentation、receipt、BusinessStep 正确**：投影/adapter 契约通过；生产 Gate **blocked**（无真实生产消息样本与真机渲染回执）。
3. **Approval/AskUser 始终可达、ACK 幂等可重试**：交互契约通过；生产 Gate **blocked**（无生产服务最终决策回执）。
4. **长历史分页有界且可到第一条**：pager/runtime 契约通过；生产 Gate **blocked**（无真机万条历史、低端机内存与锚点回执）。

**Gate C：blocked。**

### Gate D：安全与隐私

1. **生产 token 只发往 allowlist HTTPS/WSS**：origin/authFetch/wsClient 契约通过；生产 Gate **blocked**（生产 API/WSS 域未提供，无真实 TLS/MITM 抓包）。
2. **旧 HTML workspace preview 在 V1 不可用；恶意主动内容外带 0 字节**：路由与 viewer 代码通过；生产 Gate **blocked**（只有 fixture/模拟攻击，无签名包真实网络取证）。
3. **冷装无非必要权限；定位默认关闭**：源码/plugin/static policy 通过；生产 Gate **blocked**（无四槽真机冷装权限回执）。
4. **备份/restore/logout 后无不应保留的 token、消息、文件**：cache/backup 契约通过；生产 Gate **blocked**（无真实设备 backup/restore 与磁盘扫描）。
5. **隐私政策、Apple Privacy、Google Data Safety 与抓包事实一致**：仓库门禁保持外部事实 pending；生产 Gate **blocked**（三份正式声明及抓包均缺）。

**Gate D：blocked。**

### Gate E：原生与发布

1. **Expo 依赖检查全绿**：离线命令退出 0但明确不可靠，代码/契约仅部分；生产 Gate **blocked**（55.0.31 仍在 48h cooling，缺在线 0 mismatch 与双平台真实 prebuild）。
2. **Android release 非 debug signer**：fail-closed plugin/static gate 通过；生产 Gate **blocked**（无真实 release signer 指纹和旧包升级连续性）。
3. **Store flavor AAB 无 sideload 权限/自更新；Enterprise flavor 包体和 manifest 验签**：flavor/manifest 契约通过；生产 Gate **blocked**（渠道未决，且无真实 AAB/APK）。
4. **iOS entitlements、App Group、Keychain 与 provisioning 真实产物一致**：静态 policy 存在；生产 Gate **blocked**（无真实 IPA/provisioning/Team ID）。
5. **IPA/AAB/APK 均绑定唯一 SHA、版本、hash、签名、SBOM和审批**：workflow/schema 契约通过；生产 Gate **blocked**（三类制品及审批链均缺）。

**Gate E：blocked。**

### Gate F：质量与运行

1. **shared/mobile typecheck/test 连续稳定全绿**：当前 mobile-contract 1,689/1,689；但历史根并行 OAuth timeout/137，连续稳定性及 required-check 仍仅部分；生产 Gate **blocked**。
2. **iOS/Android 原生 E2E 全绿**：证据 validator 13/13；生产 Gate **blocked**（四槽数据是 `tests/fixtures` mock，不是真机）。
3. **冷装、升级、迁移、kill switch、回滚已演练**：contract/workflow 18/18；生产 Gate **blocked**（无真实现网旧包、设备、制品 digest、kill switch/回滚回执）。
4. **crash/ANR/登录/WS/ACK/附件 dashboard 可用**：telemetry 契约 9/9；生产 Gate **blocked**（监控平台、owner、dashboard、SLO 和真实 crash/ANR 均缺）。
5. **P0/P1 缺陷清零**：仓库没有经负责人签字的 RC 缺陷清单；生产 Gate **blocked**。

**Gate F：blocked。**

### 总 Gate 结论

| Gate | 代码/契约 | 生产 Gate |
|---|---|---|
| A 范围 | 通过 | blocked |
| B 身份与契约 | 通过 | blocked |
| C 呈现与交互 | 通过 | blocked |
| D 安全与隐私 | 部分（正式声明/真实取证不属于仓库代码） | blocked |
| E 原生与发布 | 部分 | blocked |
| F 质量与运行 | 部分 | blocked |

**整体：NO-GO。任何 mock、test fixture、clean prebuild、模拟 receipt 都不能替代 release/生产证据。**

## 5. 外部证据总表

| 外部证据 | 必填内容 | 关联 ID / Gate | 当前状态 |
|---|---|---|---|
| 生产 API / WSS | 唯一生产 HTTPS API、WSS，以及 dev/staging/prod 完整域清单、证书与 allowlist owner | M10-01；D1 | blocked |
| Android 渠道决策 | Store、Enterprise 或两者唯一值；首发/升级/回滚方式和批准人 | M00-03、M10-04；E3 | blocked |
| 组织账号 / Team / EAS / signing | Apple/Google/Expo 组织账号、Team ID、EAS project、证书、Android signer 指纹、robot token owner | M00-02、M10-03/04、M60-04；E2/E4/E5 | blocked |
| 现网最高版本升级链 | iOS/Android 最高线上/内测版本、bundle/package、build/versionCode、签名及 N-1→RC 连续性 | M10-03/04、M70-02；E/F | blocked |
| 最低 OS / iPad | 最低 iOS、最新 iOS、Android 范围；是否正式支持 iPad | M10-05、M60-02、M70-01 | blocked |
| 测试账号 / 禁用策略 | 普通 A/B、管理员、禁用用户、密码/SMS 能力开关、审核账号托管方式 | M20-04/06、M30-01、M70-01；B/F | blocked |
| 隐私正式声明 | 隐私政策、保留/删除、位置/音频/文件口径、Apple Privacy、Google Data Safety | M10-05；D5 | blocked |
| 商店身份 | 商店名称、图标、bundle/package 是否沿用 `com.agentsaas.mobile` | M10-03、M60-04；E | blocked |
| 监控 owner / dashboard / SLO | 平台、负责人、值班、dashboard URL、crash-free/ANR/登录/WS/ACK/附件/OAuth 指标及阈值 | M60-05、M70-03；F4 | blocked |
| 灰度 owner / environments | 灰度负责人、暂停权限、事故值班；dogfood/closed/small/expanded/full 保护环境与审批人 | M70-03；F | blocked |
| 四槽真机 | 最低 iOS、最新 iOS、Android 旗舰、Android 低端/小屏的设备 ID、OS、provider、日志/录屏/截图 | M60-02、M70-01；F2 | blocked |
| IPA / AAB / APK | 同一 reviewed SHA 的真实三类包、EAS/build ID、版本、SHA-256、签名、SBOM/provenance、审批 | M10-04、M60-03/04；E3–E5 | blocked |
| 真实 STT / TTS | 生产语音服务、健康契约、权限拒绝、空转写、Range 播放、后台停止、PII/保留策略回执 | M50-04；C/D/F | blocked |
| RC 回执 | 全矩阵 case、P0/P1 清零、重复 run/串号/错误 Agent=0，绑定版本/设备/时间/制品 digest | M70-01；F5 | blocked |
| 升级 / 回滚回执 | 冷装、覆盖升级、cache v1→v2、旧 pending、token 失效、kill switch、N-1/N、Enterprise manifest | M70-02；F3 | blocked |
| 灰度回执 | 每阶段 cohort、审批、指标窗口、stage receipt、暂停/恢复/事故记录 | M70-03；F4/F5 | blocked |
| 真实安全取证 | MITM、恶意 HTML/SVG 外带 0 字节、backup/restore/logout 磁盘扫描、accessibility tree 无敏感串 | M10-01/05、M20-05、M30-02、M50-02/03；C/D | blocked |

## 6. 证据边界与警告

- `mobile/e2e/maestro/tests/fixtures/four-slot-pass/**` 名称和位置已经明确它是 deterministic mock；它只能验证 schema/validator fail-closed，不能证明四槽真机通过。
- `mobile/telemetry/provider-contract.test-fixture.json:1` 与 `mobile/rollout/fixtures/rollout-policy.test-fixture.json:1` 是 test fixture，不是生产 provider/dashboard/灰度策略。
- clean prebuild 证明 config plugin 最终生成树可被静态检查；它不具备真实 provisioning、release signer、制品 digest、商店身份或升级连续性。
- 模拟/自签 receipt 只能验证 receipt contract；没有真实 provider、设备、制品、protected environment 和 owner 审批时，不是 RC/升级/灰度/release 证据。
- mock API、内存 store、合成 WS 事件和恶意 fixture 可证明代码分支，但不能代替生产 API/WSS、durable queue、真实账号/租户隔离和主动内容网络取证。
- 当前非阻断 warning：Undici experimental；Web Browserslist/大 chunk；历史 FileHandle GC/DEP0137。Reviewer 应确认它们没有掩盖超时、资源泄漏或未来 Node 行为变化。

## 7. 当前任务提交账本

本账本覆盖审计基线 `4d7313844a3a23d35e07a9d8afe725cd480f940e..f6d8e3f671d2f14a951e7f7e1ebfce80d752609a` 的全部 **77** 个代码/支持提交；本证据文档自身的后续提交不反向写入自身。消息未含规范 ID 的测试、CI、rebase 与文档修复标记为“支持/门禁”，其权威 ID 归属仍以第 2 节矩阵的实际 diff 语义为准。

| 序号 | 当前 full SHA | 声明 ID / 类型 | Commit subject |
|---:|---|---|---|
| 1 | `622cd1284598c989114fb478dced4bd516206c3b` | M00-02 | fix(mobile): M00-02 fail closed Android release signing |
| 2 | `fc14e6ba6ebe3b8ca1f0ead0b491ef936cc71da3` | M10-01 | feat(mobile): M10-01 enforce trusted service origins |
| 3 | `97a2d545e9778193e7cb34361174696d49eca29d` | M10-02 | fix(mobile): M10-02 align Expo SDK 55 matrix |
| 4 | `f49d65c86f84cd4e8f66e8a3659c5f6ffdb6e9ef` | M10-03 | feat(mobile): M10-03 unify app identity and versions |
| 5 | `99a307aab1d8f4037f6d627133ae0ca1ca35ca44` | M10-04 | feat(mobile): M10-04 split Android distributions |
| 6 | `0c6ecf50d5439c7d0289d958ada94d5005f48c5e` | M10-05 | feat(mobile): M10-05 minimize permissions and privacy |
| 7 | `f7dcf3c81a89c87c1e10ffef1ccfdd3599f7c50e` | M20-01 | feat(chat): M20-01 canonicalize attachment submissions |
| 8 | `fdfdcc0041bd3b0695ce5132c8bf382a439df1c2` | M20-02 | feat(chat): M20-02 add server-authoritative queue snapshots |
| 9 | `60805e109ed01e2ce808d05151464a20b2914437` | M20-03 | feat(sync): M20-03 recover WS epochs and overflow |
| 10 | `281214b733eb5f9aed9e835978a03ece8b9e024a` | M20-04 | feat(auth): M20-04 enforce identity boundaries |
| 11 | `15ecfde7e4c745607b674774d14bbd299ddddf20` | M20-05 | feat: M20-05 pending interaction outcome protocol |
| 12 | `99eae30351c96eccfc8724d8aeeec4718ac9d7c1` | M20-06 | feat: M20-06 canonical activity message projection |
| 13 | `af4e61a5b15d9e2fcf4b066da1e0b5a348913dbb` | M20-07 | feat: M20-07 canonical session metadata reducer |
| 14 | `936b1efba4be81f4e042dbba3d894d1856be3b3b` | M30-01 | feat(auth): M30-01 bridge native OAuth callbacks |
| 15 | `e21b0e1920d83fe330d8007ee32416c49e7228b7` | M30-02 | feat(mobile): implement M30-02 biometric local unlock |
| 16 | `f5c34abd74ebdc154c1a4c58f79f823b396011b1` | M30-03 | feat(M30-03): add auditable auth connection degraded mode |
| 17 | `a1785728f523e2688b355cca8175aa2c9b021ec1` | M40-01 | feat(M40-01): migrate web and mobile chat hooks |
| 18 | `ef4e07ef8008bb839fcd109e753dd0e823a86398` | M40-02 | feat(runtime): M40-02 define stuck and orphan semantics |
| 19 | `4b70cbde5cc0abe8c5888fed72e71ae19ad5ff79` | M50-01 | feat: M50-01 unify message timeline RenderModel |
| 20 | `fe02d9b6a900de3a4ebcbb757dbc0233a4d7fe0b` | M50-02 | feat: implement M50-02 tool and approval cards |
| 21 | `206846577c968e1613f7f2b05f85b3c04d061ce6` | M50-03 | feat: implement M50-03 attachment upload and rendering |
| 22 | `87eb9af3257dd686d12759d02e476a9c5c480561` | M50-04 | feat: implement M50-04 voice recording and STT pipeline |
| 23 | `91457c32891ad4fd18999499495b1fa614a292f1` | M20-05 | feat: M20-05 connect shared presentation presenter to RenderModel |
| 24 | `ab910990296ad8ae0809e24a8372db0e0e63b9f4` | M20-06 | feat: M20-06 bind tenant-scoped agent targets across clients |
| 25 | `5a0d7e6032074b436e65b42c8e11c433a135819d` | M20-07 | feat: M20-07 add stable session list pager |
| 26 | `3679009cfa50113fdb1c78cc8af298a11e20c5b2` | M30-01 | feat: M30-01 atomic auth lifecycle |
| 27 | `80d5872d4af4e48708e227307f20660b65070e71` | M30-02 | feat: M30-02 unify cache schema and restore boundaries |
| 28 | `91cf4b254793aad509d06cec4950e9c10426c5a9` | M30-03 | feat: M30-03 add authoritative agent switching |
| 29 | `2985a7b75c5f75264505f1e651e39e8057fdcb41` | M40-02 | feat: implement authoritative M40-02 history runtime unread |
| 30 | `a72cb602abf37c46b5012746682f82ac99cdb3d9` | M40-03 | feat: add M40-03 fixed interaction zone |
| 31 | `fe6918069e578e274d76b8d1834090585e35a122` | M40-04 | feat: complete M40-04 safe presentation rendering |
| 32 | `07030302b4f946986056d90c9ba16088a88ef160` | M40-05 | feat: implement M40-05 canonical error recovery |
| 33 | `cafcde2d4150da460b9d0ca4574229564bf2e972` | M20-06 | fix: M20-06 bind anonymous legacy personal targets |
| 34 | `e1dc1a853cc4e43f348aafc80b8ac2e378a9328d` | M50-01 | feat: implement M50-01 attachment share intents |
| 35 | `e2399dd8ab87cf778199f3cdffff13ea88d7aefa` | M50-02 | feat: implement M50-02 secure artifact viewer |
| 36 | `6787db87a009e76619616008f6766006761fc3a7` | M50-03 | feat: M50-03 close legacy workspace HTML preview |
| 37 | `7ad614e55e32e9ff7865bebbbc5c4073d39bda55` | M50-04 | fix: M50-04 close voice playback and TTS safety gaps |
| 38 | `4fcd85275684f469becb0257220870a22b923c7b` | M50-05 | feat: implement M50-05 lifecycle recovery state machine |
| 39 | `450f8322332bedb693ea684a728981804f1cd08f` | M60-01 | test(mobile): establish M60-01 contract baseline |
| 40 | `6d9fa89c704ad9901a02e6e8b2c0e9903fcca1e9` | M60-02 | test(mobile): add M60-02 native E2E evidence gate |
| 41 | `75bef1968bf80de95f375caabb9340d720cce605` | M60-03 | feat(mobile): enforce M60-03 native prebuild gate |
| 42 | `42a99418e103a4686abde5e8412e5484619d78f3` | M60-03 | fix(mobile): declare M60-03 config plugin dependency |
| 43 | `602a4e63a26af3f9cfa4553cb35c9c4c08287ecd` | M60-04 | feat(mobile): implement M60-04 release evidence workflows |
| 44 | `b0fe8339524bb55df83bdb36700ad29269ac0077` | M60-05 | feat(mobile): implement M60-05 observability contracts |
| 45 | `3f6cdf2b814143c291079e67f3a713e0e44f2063` | M70-01 | test(mobile): add M70-01 RC regression gate |
| 46 | `f44556946b4c9e5073da8bd9968596700484a42b` | M70-02 | feat(mobile): add M70-02 upgrade rollback rehearsal |
| 47 | `2eb9c289b4dd4819cf79feef27ea2000e4eb2a75` | M70-03 | feat(mobile): add M70-03 staged rollout gate |
| 48 | `6c5c8d7fdb5d7a9a8da5004bdc4b3eeede90cbd2` | 支持/门禁 | fix(web): resolve TASK-331 rebase presentation conflict |
| 49 | `954fd05203c57e511bd68913bf947a7df49b1482` | M60-01 | test(mobile): stabilize M60-01 OAuth concurrency gate |
| 50 | `d206923eac4e19e7765b64f2221fa1e94f742003` | 支持/门禁 | test: align rebased main runtime fixtures |
| 51 | `612f917208b3fa43c0fe3078ac70901338052dc2` | M60-05 | test(server): cover M60-05 route registration |
| 52 | `22bd5e0d5de01fb44fb2eef7e8e6bf4e3a39fe65` | 支持/门禁 | test(server): align fail-closed runtime fixtures |
| 53 | `5baee99b96b245ef130c453af4f39f1503a9fc67` | 支持/门禁 | test(server): isolate artifact runtime environment |
| 54 | `7a3bde4619fd88ecef67b5d7dbd52d06d24484d4` | 支持/门禁 | test(server): attest admin router test environments |
| 55 | `322402d081c41639a7b71467564b7554016ec4d9` | 支持/门禁 | test(server): align governance migration ledger v35 |
| 56 | `a601829b7e3655f334c30a35359b81ee4c21f648` | 支持/门禁 | test(server): keep run preflight V5 fixture current |
| 57 | `350f170c25d8b0f04fe836509d57f767fe42ee92` | 支持/门禁 | test(server): attest system prompt admin environment |
| 58 | `fac19a4473858a62943f5512bdfa811e5aaba45b` | 支持/门禁 | test(server): align mobile protocol fixtures |
| 59 | `3b1b2acb28fe7de6486c2b30dfc935924ef5161c` | 支持/门禁 | test(server): attest tool controls admin environment |
| 60 | `5bcaf5a9df0c71fe03a6562851f0b4d0c2a68c7c` | 支持/门禁 | test(server): remove artificial bulk projection delay |
| 61 | `f4e47c15d5e8cc9268fc9651e6ead035ecb917d0` | 支持/门禁 | test(server): attest remote hands admin environment |
| 62 | `08ce82de5e96d8ce9481c1bcb5b7eb3bbc79f0b5` | 支持/门禁 | test(web): align mobile runtime presentation fixtures |
| 63 | `500121b7c3a80d7ad03f2354da31b742d2a62568` | 支持/门禁 | test(web): hydrate authoritative interaction fixtures |
| 64 | `6ff745ead92d1b78a4d54b286740452af4ef0db8` | Docs | docs(TASK-331): record mobile v1 evidence matrix |
| 65 | `372fe7b0d2f3250d831b8f93dc29069b30fe66b5` | 支持/门禁 | fix(ci): isolate native fixtures and route health probes |
| 66 | `28d6c6184565c04780262b461eabf17d73a986be` | 支持/门禁 | refactor: extract mobile v1 responsibilities for ratchets |
| 67 | `b9ce22284b58a5ba9f2fe7d905f01dcac55b0e68` | 支持/门禁 | fix(ci): align v35 and reasoned resource budgets |
| 68 | `20159c9276cf80982cf66a209ee70ef61915a5f3` | 支持/门禁 | fix(server): use shared root exports in production bundle |
| 69 | `4a43f77eb0e380132dd62897c903976508eced21` | 支持/门禁 | fix(mobile): enforce real Router root and Gate A |
| 70 | `ec819394b7be8919c46df51546077b9001374ee0` | M60-04 | fix(mobile): make M60-04 source authorization achievable |
| 71 | `f68d18a53b0282f3bb23fe10a88ae9a29be38d1d` | 支持/门禁 | fix(shared): fence stale auth refresh responses |
| 72 | `d7e45882bfc5307aa5275718855fd5c8354a2c6e` | M30-01 | fix(shared): M30-01 serialize auth response side effects |
| 73 | `47192bcd2aa75859d9d1714d2985f2c3a36161f6` | M00-01 | docs(mobile): M00-01 align remediation evidence |
| 74 | `016e4dd42486f7582a86b324ae00748a9270bd4b` | M30-01 | fix(web): M30-01 serialize saved account switching |
| 75 | `353f8d09c372906f60c6bc0403d9e1eb15ba9a41` | M00-01 | docs(mobile): M00-01 rebuild rebased evidence matrix |
| 76 | `f9f67f3f81454b745dfa887be7181b4b2388ed45` | M60-01 | fix(ci): M60-01 preserve coverage scope contract |
| 77 | `f6d8e3f671d2f14a951e7f7e1ebfce80d752609a` | M00-01 | docs(mobile): M00-01 align final rebased evidence |

## 8. 后续 Reviewer 检查重点

1. 先核对本文件审计代码基线、`git rev-parse origin/main` 与 PR 当前 head；逐一 `git cat-file -e <sha>^{commit}`，禁止替换为 rebase 前 SHA。
2. M00-01 必须保留 main 上 PR #289、`f0c5...` 主体与 `2027...` 支持；M00-03 必须维持“无代码提交 / blocked”，直到负责人给出书面渠道事实。
3. 对早期错位编号继续按 diff 语义审查，不得把 `63696...`、`dd3ab...`、`9a922...`、`19c9...` 机械映射为权威同号任务。
4. 复核 Server 五个互斥批次的真实退出码与汇总：655 个文件全覆盖、6,026 passed、0 fail；不得把依赖外部 PostgreSQL 的 skipped 写成通过。
5. Expo 需要 cooling 结束后的**在线** `expo install --check`；离线退出 0 仍不得标在线 0 mismatch。
6. Gate Reviewer 应逐项索要本文件第 5 节的真实外部对象（域名、账号、设备、制品、dashboard、审批/回执），并校验 SHA、时间、签名、digest 与环境交叉一致。
7. 对 IPA/AAB/APK 做独立下载和解包核验；对 signer/provisioning/entitlement、Store/Enterprise 权限、自更新能力和 SBOM/provenance 不采信仅由构建脚本自报的数据。
8. 四槽 E2E、RC、升级和灰度必须使用真实 provider/真机/保护环境回执；路径中含 `fixtures`、`test-fixture`、`mock` 或本地模拟签名的证据一律不得升级为生产通过。
9. 只有 Gate A–F 的每个生产项都由真实证据闭合，且 P0/P1 清零，才可把整体从 **NO-GO** 改为 GO。
