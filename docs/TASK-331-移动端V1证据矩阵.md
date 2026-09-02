# TASK-331 移动端 V1 证据矩阵

> 审计时间：2026-09-02；分支：`task/TASK-331-mobile-v1-roadmap`
> 审计代码基线：当前 `HEAD`（由 verifier 解析）；当前 `origin/main`：`c340bc0e9ba2027b47ac00e01309a095f2f35155`。
> 权威标准：`assets/20260828/TASK-307-移动端V1实施方案.md`，尤其任务清单（原文 276–601 行）、Gate A–F（原文 680–720 行）与外部证据（原文 724–740 行）。
> **结论：代码/契约已有大量通过项，但生产 Gate A–F 均未闭合，整体仍为 NO-GO。**

> Review 返工映射：`31b44427a` 是 M00-01 Router/Gate A 支持提交，`d20fa2ccc` 是 M60-04 发布授权修复，`858c0659e` 是 M30-01 HTTP 后置异步竞态修复，`ed67c1f29` 是 M30-01 Web saved-account 可序列化切换修复。以上均为当前最终重放后的提交；本轮 `4ad679048`/`321f94e25` 修复身份顺序与缓存隔离，`ff537f858`/`6a0ad1cda` 修复 enterprise 凭据矩阵。 第五轮以 `f72a3e0fb` 闭合身份 TOCTOU/failClosed/stale self，以 `d0d3f7567` 保证真实 submit checkout 先于仓库脚本。

## 1. 审计口径

1. 提交从当前仓库 `git log origin/main..HEAD` 及 `origin/main` 的可达历史重建；只使用当前完整 SHA，不使用 rebase 前 SHA。`node scripts/verify-task331-evidence-matrix.mjs` 必须验证 36 个唯一 ID、无旧 `mobile/src/app` 路径，且本文全部 40 位 SHA 可达当前 `HEAD`。
2. 表中“主体”优先标记最终闭合权威定义的提交；早期提交信息中的编号若与权威定义错位，只按实际 diff 语义列为“支持”，不伪造一项一提交。例如早期 `M50-01 unify message timeline RenderModel` 实际支持 M20-05/M40-04，而不是权威 M50-01。
3. M00-01 已在 main：PR #289；主体 `f0c5c5c79b83a275f8884ec1f11fa8b7dec50394`，支持 `2027c25d06abf7379643f44ace76fe83da4459b1`。M00-03 只有人工渠道决策，**没有代码提交**。
4. “通过”仅表示仓库代码/契约自动化通过；“部分”表示代码门禁存在但仍依赖真实环境、制品或人工事实；“blocked”表示该项没有可宣称完成的代码或关键输入。代码状态不等于生产 Gate。
5. 下列定向用例数来自当前树实际执行；`pnpm mobile-contract` 共 **1,699** 项（Shared Vitest 1,303；Mobile Vitest 197；Mobile Node 199），另含 Shared/Mobile typecheck 与离线 Expo 检查。

## 2. 36 项证据矩阵

| ID | 用户结果 | 当前 full commit hash（主体/支持） | 关键文件 | 自动化证据命令 + 用例数 | 代码状态 | 外部证据缺口 |
|---|---|---|---|---|---|---|
| M00-01 | 生产只可进入对话/设置，延期入口和深链渲染前 fail closed | 主体 `f0c5c5c79b83a275f8884ec1f11fa8b7dec50394`；支持 `2027c25d06abf7379643f44ace76fe83da4459b1`；任务支持 `31b44427a2bf92fcd5b7c576b74f69acb4ef0192`；main PR #289 | `mobile/src/v1/v1Capabilities.ts:1`；`mobile/src/v1/V1RouteGate.tsx:1` | `pnpm -F mobile exec vitest run src/v1/v1Capabilities.test.ts src/v1/v1RouteGate.runtime.test.tsx src/v1/v1RouteInventory.test.ts src/v1/v1UiNavigationScan.test.ts`：43/43 | 通过 | 真实生产包冷装、UI/深链遍历回执 |
| M00-02 | 发布签名配置不再回退 debug，源码/日志不含签名秘密 | 主体 `a82152ab1ad0a85a77fdac51a5109f79ccd9dd05` | `mobile/plugins/withAndroidSigningConfig.js:26`；`docs/mobile-android-credential-incident-runbook.md:1` | `pnpm -F mobile test:android-signing`：7/7，另完成 source scan 与 Android clean prebuild/Gradle 静态核验 | 部分 | 凭证管理员轮换回执、既有 signer 指纹、旧包→新包真实升级连续性、发布 robot token |
| M00-03 | Android 首发渠道、owner、包名、签名、升级和回滚方式有唯一书面决定 | **无代码提交（0）** | 权威外部决策项；仓库无可替代实现 | 无自动化命令：0 项；不得以 flavor 代码代替决策 | blocked | Store/Enterprise/两者的唯一渠道决策及产品/发布负责人签字 |
| M10-01 | 首装只连接受信 HTTPS/WSS 服务，任意 origin 和示例域被拒绝 | 主体 `7a3ff002de3e3e1e47b0118f23284e9651f8d7c8` | `mobile/src/platform/trustedServiceOrigin.ts:54`；`mobile/src/platform/mobileConfig.ts:38` | `pnpm -F mobile exec vitest run src/platform/trustedServiceOrigin.test.ts src/platform/mobileConfig.test.ts`：22/22 | 通过 | 唯一生产 API/WSS、dev/staging/prod 域清单、真实 TLS/MITM 抓包 |
| M10-02 | Expo SDK 55 依赖矩阵收口且双平台原生生成可解释 | 主体 `7d7e55dba4d8b0e2166cda0e8bf00952e1ce7055` | `mobile/package.json:52`；`pnpm-workspace.yaml:13` | `pnpm mobile-contract`：1,699/1,699；其中 `EXPO_OFFLINE=1 ... expo install --check` 退出 0 | 部分 | 在线检查发现 55.0.31，但受 `minimumReleaseAge: 2880`（48h cooling）未升级；离线结果不得写成在线 0 mismatch；仍需在线检查与双平台真实 clean prebuild 回执 |
| M10-03 | App ID、版本、build number/versionCode 与 Git SHA 可由单一 manifest 反查 | 主体 `7b5b9ff3bc2ec3815f09a3b5a6ec23a90270a8a1` | `mobile/scripts/release-manifest.cjs:42`；`mobile/release-manifest.json:1` | `pnpm -F mobile test:release-manifest`：16/16 | 部分 | Apple/Google/Expo 组织身份、Team/EAS project、现网最高版本与递增链、真实 RC manifest |
| M10-04 | Store AAB 与 Enterprise APK 的权限、更新和签名路径分离 | 主体 `3fea4611de21590e34aab8aec61c2a53140c486c` | `mobile/eas.json:1`；`mobile/src/updates/enterpriseUpdateManifest.ts:20` | `pnpm -F mobile test:m10-04`：30/30（Vitest 11 + Node 19） | 部分 | 渠道决定、真实 Store/Enterprise 签名、AAB/APK 解包、旧正式包覆盖升级和 manifest 验签回执 |
| M10-05 | 冷装不索取非必要权限，媒体权限只在用户动作时请求，拒绝后文字聊天仍可用 | 主体 `21b3195b0c90db61cb1c6a2a576dbca1fc30e952` | `mobile/src/platform/jitMediaPermissions.ts:30`；`docs/mobile-m10-05-privacy-and-store-review.md:1` | `pnpm -F mobile test:m10-05`：16/16（Vitest 5 + Node 11） | 部分 | 真机冷装权限弹窗=0、最低 OS/iPad 口径、Apple Privacy/Google Data Safety/隐私政策与抓包一致性 |
| M20-01 | 文字/图片/文件/系统分享只以 attachmentId 权威提交，重试不丢 ID | 主体 `2a02ba11c3964eb872c6da7632548d2c46bf427d` | `shared/src/lib/chatSubmission.ts:108`；`mobile/src/lib/chatSubmissionAdapter.ts:14` | `pnpm -F @agent/shared exec vitest run src/lib/chatSubmission.test.ts`：7/7 | 通过 | 真实生产上传→materialize 抓包、跨租户伪造与路径泄漏复核 |
| M20-02 | 排队/插话/取消以服务端队列为真源，重试幂等且杀进程不重复执行 | 主体 `32186777aa654dad51a2633c552777a3ee86c00d` | `shared/src/lib/chatQueue.ts:95`；`shared/src/lib/chatQueueWs.ts:28` | `pnpm -F @agent/shared exec vitest run src/lib/chatQueue.test.ts src/lib/chatQueueWs.test.ts`：26/26 | 通过 | 生产 durable queue、多设备、杀进程、ACK 丢失的服务端回执 |
| M20-03 | seq/epoch/overflow、queue/interaction/runtime 可幂等恢复且不形成 sync loop | 主体 `4c8c1961e2e2e84310bedf75304baaf278ca6b9d` | `shared/src/lib/syncRecovery.ts:76`；`shared/src/store/actions/wsHandler.ts:132` | `pnpm -F @agent/shared exec vitest run src/lib/syncRecovery.test.ts`：10/10 | 通过 | 生产 WSS 蓝绿切流、服务重启、旧版本兼容与真实 overflow 回执 |
| M20-04 | A 退出后旧 generation 不可发送或更新 B，缓存按租户/用户分区 | 主体 `3a277ad4d8923d95f6209da24f0d78d72a8ac3e5` | `shared/src/lib/identity.ts:48`；`shared/src/lib/wsClient.ts:207` | `pnpm -F @agent/shared exec vitest run src/lib/identity.test.ts`：6/6 | 通过 | 两个真实生产测试账号、禁用用户、真机 A→B 与磁盘/网络取证 |
| M20-05 | Tool/BusinessStep/presentation 共用安全 RenderModel，非 debug 不含 raw input/result | 主体 `6862c343fb3f8cded2615400a2f6e8cf811378ba`；支持 `e7cf07b9ddfd2aff2a874c266afb650c16b5227c`、`077e8db6495003440b2aa7a8e0d385d2a0c5acd3` | `shared/src/lib/presentationPresenter.ts:214`；`shared/src/lib/renderModel.ts:284` | `pnpm -F @agent/shared exec vitest run src/lib/presentationPresenter.test.ts src/lib/renderModel.test.ts`：45/45 | 通过 | 生产 tenant debug policy、真机 accessibility tree/截图敏感串审计 |
| M20-06 | personal/assigned org Agent 路由明确，禁用/撤权/不可用不静默回退 | 主体 `21179f9d0f85a31335b1943b968bcc3b8c7922bf`；支持 `f508cb49524b416f53c5cdbf1df3a70875ea1614` | `shared/src/lib/agentTarget.ts:96`；`mobile/src/lib/agentTargetRouting.ts:2` | `pnpm -F @agent/shared exec vitest run src/lib/agentTarget.test.ts`：4/4 | 通过 | 生产 org 指派/撤权、personal disabled、删除 Agent 与审计日志回执 |
| M20-07 | 长历史分页稳定，pending interaction 可达且 ACK/重复点击幂等 | 主体 `fdafa35e12fa117f34e82c24d38b4057ae6bd129`；支持 `de0107eec8990667898755deb3700b2889db028f`、`529b48944d9c2c9cbc4116c23f0032949c3ddcbf` | `shared/src/lib/sessionListPager.ts:95`；`shared/src/lib/activeInteraction.ts:74` | `pnpm -F @agent/shared exec vitest run src/lib/sessionListPager.test.ts src/lib/activeInteraction.test.ts`：13/13 | 通过 | 生产万条消息/慢请求/ACK 丢失与真实 pending 冷启动回执 |
| M30-01 | 登录、刷新、失效、退出和换号按原子顺序断连、清状态并重建身份 | 主体 `ca87b81ecb388b00f56f160c390e07bce12294d2`；支持 `8c78600c3bf416abc6af834048783d8936ba597f`、`b68919ceb96b560e04a9f78674dd121b6d472c28`、`858c0659e9b18b468665ed3a1c48e23620ebc620`、`ed67c1f29e9ae37838c0901c5bd970858b6f7134`、`4ad67904801751e0c9de136de7b5dca82f7c9b95`、`321f94e2597f11fe93815c433c4d513a23b30a95`、`f72a3e0fb355c0850fb1ceb78e1257d482c10852`、`9ddce9610dc7ce5a788deb974af10a96b231391c` | `shared/src/lib/authLifecycle.ts:82`；`shared/src/lib/authFetch.ts:23`；`web/src/contexts/savedAccountLifecycle.ts:1` | Auth lifecycle 18/18；authFetch 15/15；Web saved-account 并发 4/4；生产 user-detail 身份隔离 5/5；OAuth handoff 11/11 | 通过 | 生产 OAuth provider/Universal Link/App Link、测试账号、真机 token 失效和 A→B 竞态 |
| M30-02 | cache schema v2 按账号分区，旧键迁移，备份/退出不保留业务明文 | 主体 `ad954747809ceb8ab2a6cc30ce7dc191d58b6523` | `shared/src/lib/cacheSchemaV2.ts:4`；`mobile/src/platform/mobileCacheAdapter.ts:6` | `pnpm -F @agent/shared exec vitest run src/lib/cacheSchemaV2.test.ts`：11/11 | 通过 | iOS/Android 真实 backup/restore、logout 后磁盘扫描、多租户同 sessionId 回执 |
| M30-03 | Agent switcher 只显示可用目标，切换时会话身份明确且不可静默换 Agent | 主体 `4f620b1754c133e56628a28d75338cb94e182d2c` | `shared/src/lib/agentTargetTransition.ts:73`；`mobile/src/lib/agentTargetTransitionParity.test.ts:1` | `pnpm -F @agent/shared exec vitest run src/lib/agentTargetTransition.test.ts`：6/6 | 通过 | 生产 personal/org 组合、撤权历史只读、当前 run 切换策略真机回执 |
| M40-01 | Mobile 发送/排队/插话/停止接入 shared 状态机，不再以本地 outbox 为真源 | 主体 `1f98a26561c3cb9822e5c7a5e0aab692069a2764` | `shared/src/lib/chatClientState.ts:55`；`mobile/src/hooks/useChatAppState.ts:204` | `pnpm -F @agent/shared exec vitest run src/lib/chatClientState.test.ts`：8/8 | 通过 | 生产弱网、后台、杀进程、三条队列和重复 run=0 的端到端回执 |
| M40-02 | 长历史有界分页，运行态/未读跨设备一致且不跳错会话 | 主体 `3620da8b3d83132cef141eb99f28166927515a94`；支持 `d24e739c8f500d21fe4681f94fc9467735b8a56d` | `shared/src/lib/historyPager.ts:129`；`shared/src/lib/sessionRuntime.ts:44` | `pnpm -F @agent/shared exec vitest run src/lib/historyPager.test.ts src/lib/sessionRuntime.test.ts src/lib/sessionUnread.test.ts`：15/15 | 通过 | 真机 1000 会话、500/万条消息、低端 Android OOM/锚点与后台 run 回执 |
| M40-03 | Approval/AskUser 固定在 composer 上方，提交中禁用且 ACK 超时可重试 | 主体 `ee762918e40dfd2530651c7f84d754a0f6890113`；支持 `b3f169da7866e1c94e9cc20f3203b5b4bdaad54d` | `shared/src/lib/activeInteraction.ts:74`；`mobile/app/chat/[sessionId].tsx:551` | `pnpm -F @agent/shared exec vitest run src/lib/activeInteraction.test.ts src/lib/interactionProtocol.test.ts`：13/13 | 通过 | 生产 Approval/AskUser、断线/重复点击、服务端唯一最终决策回执 |
| M40-04 | 工具、错误、runtime、BusinessStep 在移动端安全呈现，未知块有安全降级 | 主体 `bd92294fd1dd7a0669ce89ddd0106ada31b637bc`；支持 `f1507f1b3dec5c998f281d78decc75799c18ed21` | `mobile/src/lib/presentationAdapter.ts:58`；`mobile/src/components/chat/MessageItem.tsx:210` | `pnpm -F mobile exec vitest run src/lib/presentationAdapter.test.ts && pnpm -F @agent/shared exec vitest run src/lib/presentationPresenter.test.ts`：37/37 | 通过 | 非 debug 真机 accessibility tree、真实 receipt/presentation/六状态步骤样本 |
| M40-05 | 离线/鉴权/模型/服务/附件/审批/运行错误均给出唯一可操作恢复动作 | 主体 `be3839b22bda0fe5d93bbc204a57a7e1ad502d21`；支持 `663f05468d535465146c76d9415c4703afde8669` | `shared/src/lib/canonicalError.ts:140`；`mobile/src/services/authConnectionCapabilityAdapter.ts:19` | `pnpm -F @agent/shared exec vitest run src/lib/canonicalError.test.ts`：17/17 | 通过 | 生产 401/403/429/500、模型失效、draining、WSS timeout 与支持文案回执 |
| M50-01 | 文件/图片/相机/Share Intent 统一 attachmentId 契约，失败保留草稿并清临时文件 | 主体 `ed27d7c9315b50c59292507b44cdc9b90306c03f`；支持 `d3e887d636298786a01507e712f4a5d24795a0fa` | `shared/src/lib/incomingShare.ts:161`；`mobile/src/platform/incomingShareCoordinator.ts:52` | `pnpm -F @agent/shared exec vitest run src/lib/incomingShare.test.ts && pnpm -F mobile exec vitest run src/platform/incomingShareCoordinator.test.ts src/lib/attachmentUpload.test.ts`：19/19 | 通过 | 真机 content URI 撤权、低磁盘、并发 10 文件、伪 MIME/损坏媒体与服务端孤儿清理回执 |
| M50-02 | Artifact 以 artifactId 安全取回；主动 HTML/SVG 只下载/分享且警告 | 主体 `f8dfbefd9c63f053a005de1ae02fa9d81a0aead4` | `shared/src/lib/artifactViewModel.ts:103`；`mobile/src/lib/artifactViewAdapter.ts:44` | `pnpm -F @agent/shared exec vitest run src/lib/artifactViewModel.test.ts && pnpm -F mobile exec vitest run src/lib/artifactViewAdapter.test.ts`：18/18 | 通过 | 真实过期签名 URL、跨租户/撤销/超大文件及恶意主动内容网络取证 |
| M50-03 | 旧 workspace HTML preview 在 V1 不可达，目录 token/JS WebView 风险关闭 | 主体 `784998335266a0560b468d1e3d306a3dcd3c585a` | `mobile/src/v1/v1Capabilities.ts:1`；已删除 `mobile/app/chat/html-preview.tsx` | M00-01 四套 V1 路由测试命令：43/43 | 通过 | 真机恶意 HTML/SVG 对 sibling、beacon、form、iframe、scheme、外跳的 0 字节回执 |
| M50-04 | 录音/播放状态可清理，权限拒绝回文字；TTS 不健康时默认降级关闭 | 主体 `16b464dac68a88efe32ab349f76f985932af94d7`；支持 `75bce08031fac66110713a9670f9ae094f8540ae` | `shared/src/lib/voiceRecording.ts:96`；`shared/src/lib/ttsCapability.ts:6`；`mobile/src/services/voiceMediaCachePolicy.ts:18` | `pnpm -F @agent/shared exec vitest run src/lib/voiceRecording.test.ts src/lib/ttsCapability.test.ts`：11/11；Mobile media cache 2/2 | 部分 | **真实 STT/TTS**、麦克风权限拒绝、Range 播放、后台停止、长录音和缓存清理真机回执 |
| M50-05 | 前后台/弱网按预算退避，回前台 attach active stream，旧 pending 不跨版本自动重放 | 主体 `e660e81057fe078ad3fe06a31767f35a3e6c72fe` | `shared/src/lib/appLifecycle.ts:276`；`mobile/src/platform/lifecycleAdapter.ts:35` | `pnpm -F @agent/shared exec vitest run src/lib/appLifecycle.test.ts src/lib/appLifecycleEffects.test.ts src/lib/pendingSubmissionRecovery.test.ts && pnpm -F mobile exec vitest run src/platform/lifecycleAdapter.test.ts`：22/22 | 通过 | 2G/300ms/5% 丢包/切网、后台 3秒至1小时、杀进程、服务重启真机回执 |
| M60-01 | Shared/Mobile P0 契约成为稳定门禁，OAuth 并发不再 timeout | 主体 `1c1fdb526134258b13e0d79345fae465118f7212`；支持 `17407f4457522494b3284af51744bac0ef30a2fc`、`8ed70369790f777507bb14f3992d574c3a9f76a4`、`69e2f5cda66a6bad15d631af53a3e311b0540cef` | `package.json:25`；`mobile/src/contracts/p0ContractManifest.test.ts:13` | `pnpm mobile-contract`：1,699/1,699，Shared/Mobile typecheck 通过，offline Expo 退出 0；OAuth handoff 11/11 | 部分 | required-check 多次连续稳定回执；在线 Expo 0 mismatch；根并行 test 的资源策略需在 CI 证明不再 timeout/137 |
| M60-02 | iOS/Android 四槽原生 E2E 门禁能拒绝模拟器、跨 SHA、重放和缺槽证据 | 主体 `358625a2c933102358843e100774a46062177a53` | `.github/workflows/mobile-native-e2e.yml:1`；`mobile/e2e/maestro/tests/native-e2e.test.mjs:1` | `pnpm -F mobile test:m60-02`：13/13 | 部分 | 当前四槽 pass 数据位于 `tests/fixtures`，只是 mock；缺最低 iOS、最新 iOS、Android 旗舰、低端/小屏四台真机及 provider 回执 |
| M60-03 | clean prebuild 对最终 manifest/entitlement/PrivacyInfo/Gradle 做 fail-closed 静态门禁 | 主体 `c047f39cd345137111da16b4f30f6184b0f2b9a0`；补充 `afe685cbb0da009868038a66800ed2205cca99bc` | `mobile/scripts/native-policy.test.mjs:1`；`docs/mobile-m60-03-native-prebuild-gate.md:1` | `pnpm -F mobile test:m60-03`：14/14 mutation tests | 部分 | clean prebuild/golden 不是签名 release 制品；仍缺真实 IPA/AAB/APK 的 plist/entitlement/manifest/Gradle 与签名核验 |
| M60-04 | 同一已审 SHA 构建、验证、提交，产物绑定版本/hash/签名/SBOM/审批 | 主体 `c123f24d065217c417904d6a655582c33c3bc9b4`；支持 `d20fa2ccc3339847558fd317f45cd08cc86c4295`、`ff537f85813facf128f16826d9f27652cbc122c3`、`6a0ad1cda9aa6e60c5358f5761a34f653453560b`、`d0d3f75675e474bbb93fc8acfb7b558eae20b694` | `.github/workflows/mobile-submit.yml:1`；`mobile/scripts/mobile-release-evidence.test.mjs:1` | `pnpm -F mobile test:m60-04`：29/29 | 部分 | 组织 robot token、保护环境审批、EAS build ID、真实 IPA/AAB/APK、签名指纹、SHA-256、SBOM/provenance、submit 回执 |
| M60-05 | JS/native crash、ANR、启动/网络失败按版本/环境/cohort 可观测且默认 PII scrub | 主体 `15cb444880c14c44072d97896bed62425bf08f97`；补充 `da1a158ff859a5f54470a1ffaafb9855293c001e` | `mobile/src/telemetry/telemetryClient.ts:57`；`docs/mobile-m60-05-observability.md:1`；`server/src/telemetry/mobileTelemetry.ts:1` | `pnpm -F mobile test:m60-05`：9/9；Server route 注册有定向支持测试，但 Server 全量仍在跑 | 部分 | 组织监控平台、owner、dashboard URL、SLO/阈值、真实 JS/native crash/ANR、dSYM/source map/mapping 上传回执 |
| M70-01 | RC 矩阵的设备/网络/账号/Agent/会话/权限/交互/产物逐项留证 | 主体 `3c0b0da23761d0b024e3d9a630c9271acc689d01` | `.github/workflows/mobile-rc-regression.yml:1`；`docs/mobile-m70-01-rc-runbook.md:1` | `pnpm -F mobile test:m70-01`：40/40 contract/workflow tests | 部分 | 真实 RC、四槽真机、生产近似网络/账号/Agent/制品矩阵、P0/P1 清零签字；模拟 receipt 不算回归回执 |
| M70-02 | 冷装/升级/cache v1→v2/token 失效/pending/kill switch/回滚均绑定版本设备制品 digest | 主体 `fdaaa3ece96d72bca06c0e5bd227dbcb5cab7b5a` | `.github/workflows/mobile-upgrade-rehearsal.yml:1`；`docs/mobile-m70-02-upgrade-rollback-runbook.md:1` | `pnpm -F mobile test:m70-02`：18/18 | 部分 | 现网最高版本升级链、真实旧包→RC、Store rollout stop、kill switch、N-1/N API、Enterprise 签名回滚 manifest 与演练回执 |
| M70-03 | 员工→封闭→小比例→扩大→全量逐阶段审批，身份串线/重复执行等直接停止 | 主体 `6f7483f4db5081e68f188d5b72f535e376a4911c` | `.github/workflows/mobile-rollout-gate.yml:1`；`docs/mobile-m70-03-rollout-gate-runbook.md:1` | `pnpm -F mobile test:m70-03`：33/33 | 部分 | 灰度 owner、真实 environments/审批权限、监控 adapter/dashboard/SLO、各阶段 cohort 与签名 stage receipt；test fixture/模拟 receipt 不算灰度回执 |

**计数校验：M00=3、M10=5、M20=7、M30=3、M40=5、M50=5、M60=5、M70=3，共 36 项。**

## 3. 当前完整验证事实

| 验证项 | 当前事实 | 解释边界 |
|---|---|---|
| Mobile contract | `pnpm mobile-contract` 当前退出 0：Shared typecheck；Shared 100 files / 1,303 tests；Mobile typecheck；Mobile Vitest 42 files / 197 tests；Mobile Node 199 tests；合计 1,699 tests | 证明 Shared/Mobile 代码与契约当前通过；不证明生产服务、真机、签名、商店或灰度通过 |
| Expo 检查 | `EXPO_OFFLINE=1 pnpm -F mobile exec expo install --check` 退出 0，并明确输出 `Dependency validation is unreliable in offline-mode` | 只能记“offline 检查通过”。在线可见 Expo 55.0.31，但 `pnpm-workspace.yaml:13` 的 2,880 分钟（48h）cooling 令当前未升级；**不能写在线 0 mismatch** |
| Web 全量与 build | 288 files / 2,222 tests 全部通过（3 个互斥批次：96/728、96/810、96/684）；production build 通过 | 保留非阻断 Browserslist 数据旧、部分大 chunk、Radix Description 与 React act warning；未掩盖失败 |
| 六包 typecheck | server、web、shared、mobile、hand-server、acs-orchestrator 均通过 | 类型门禁与测试门禁分别留证，不混写 |
| 初次根并行 test | 曾发生 OAuth timeout 与进程内存 137 | 不能隐去；随后 `17407f4457522494b3284af51744bac0ef30a2fc` 稳定 OAuth 并发，`8ed70369790f777507bb14f3992d574c3a9f76a4` 对齐 rebase 后 runtime fixtures，定向测试已转绿；当前 mobile-contract 亦转绿 |
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

1. **shared/mobile typecheck/test 连续稳定全绿**：当前 mobile-contract 1,699/1,699；但历史根并行 OAuth timeout/137，连续稳定性及 required-check 仍仅部分；生产 Gate **blocked**。
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

本账本覆盖审计基线 `c340bc0e9ba2027b47ac00e01309a095f2f35155..HEAD` 的全部 **90** 个提交。末行使用符号 `HEAD` 表示包含本文件与 verifier 的自引用证据提交，由 verifier 实时解析并要求该提交只修改这两个证据文件；任何后续提交若不刷新本账本都会失败。

| 序号 | 当前 full SHA / 符号 | 声明 ID / 类型 | Commit subject |
|---:|---|---|---|
| 1 | `a82152ab1ad0a85a77fdac51a5109f79ccd9dd05` | M00-02 | fix(mobile): M00-02 fail closed Android release signing |
| 2 | `7a3ff002de3e3e1e47b0118f23284e9651f8d7c8` | M10-01 | feat(mobile): M10-01 enforce trusted service origins |
| 3 | `7d7e55dba4d8b0e2166cda0e8bf00952e1ce7055` | M10-02 | fix(mobile): M10-02 align Expo SDK 55 matrix |
| 4 | `7b5b9ff3bc2ec3815f09a3b5a6ec23a90270a8a1` | M10-03 | feat(mobile): M10-03 unify app identity and versions |
| 5 | `3fea4611de21590e34aab8aec61c2a53140c486c` | M10-04 | feat(mobile): M10-04 split Android distributions |
| 6 | `21b3195b0c90db61cb1c6a2a576dbca1fc30e952` | M10-05 | feat(mobile): M10-05 minimize permissions and privacy |
| 7 | `2a02ba11c3964eb872c6da7632548d2c46bf427d` | M20-01 | feat(chat): M20-01 canonicalize attachment submissions |
| 8 | `32186777aa654dad51a2633c552777a3ee86c00d` | M20-02 | feat(chat): M20-02 add server-authoritative queue snapshots |
| 9 | `4c8c1961e2e2e84310bedf75304baaf278ca6b9d` | M20-03 | feat(sync): M20-03 recover WS epochs and overflow |
| 10 | `3a277ad4d8923d95f6209da24f0d78d72a8ac3e5` | M20-04 | feat(auth): M20-04 enforce identity boundaries |
| 11 | `de0107eec8990667898755deb3700b2889db028f` | M20-05 | feat: M20-05 pending interaction outcome protocol |
| 12 | `077e8db6495003440b2aa7a8e0d385d2a0c5acd3` | M20-06 | feat: M20-06 canonical activity message projection |
| 13 | `529b48944d9c2c9cbc4116c23f0032949c3ddcbf` | M20-07 | feat: M20-07 canonical session metadata reducer |
| 14 | `8c78600c3bf416abc6af834048783d8936ba597f` | M30-01 | feat(auth): M30-01 bridge native OAuth callbacks |
| 15 | `b68919ceb96b560e04a9f78674dd121b6d472c28` | M30-02 | feat(mobile): implement M30-02 biometric local unlock |
| 16 | `663f05468d535465146c76d9415c4703afde8669` | M30-03 | feat(M30-03): add auditable auth connection degraded mode |
| 17 | `1f98a26561c3cb9822e5c7a5e0aab692069a2764` | M40-01 | feat(M40-01): migrate web and mobile chat hooks |
| 18 | `d24e739c8f500d21fe4681f94fc9467735b8a56d` | M40-02 | feat(runtime): M40-02 define stuck and orphan semantics |
| 19 | `e7cf07b9ddfd2aff2a874c266afb650c16b5227c` | M50-01 | feat: M50-01 unify message timeline RenderModel |
| 20 | `b3f169da7866e1c94e9cc20f3203b5b4bdaad54d` | M50-02 | feat: implement M50-02 tool and approval cards |
| 21 | `d3e887d636298786a01507e712f4a5d24795a0fa` | M50-03 | feat: implement M50-03 attachment upload and rendering |
| 22 | `75bce08031fac66110713a9670f9ae094f8540ae` | M50-04 | feat: implement M50-04 voice recording and STT pipeline |
| 23 | `6862c343fb3f8cded2615400a2f6e8cf811378ba` | M20-05 | feat: M20-05 connect shared presentation presenter to RenderModel |
| 24 | `21179f9d0f85a31335b1943b968bcc3b8c7922bf` | M20-06 | feat: M20-06 bind tenant-scoped agent targets across clients |
| 25 | `fdafa35e12fa117f34e82c24d38b4057ae6bd129` | M20-07 | feat: M20-07 add stable session list pager |
| 26 | `ca87b81ecb388b00f56f160c390e07bce12294d2` | M30-01 | feat: M30-01 atomic auth lifecycle |
| 27 | `ad954747809ceb8ab2a6cc30ce7dc191d58b6523` | M30-02 | feat: M30-02 unify cache schema and restore boundaries |
| 28 | `4f620b1754c133e56628a28d75338cb94e182d2c` | M30-03 | feat: M30-03 add authoritative agent switching |
| 29 | `3620da8b3d83132cef141eb99f28166927515a94` | M40-02 | feat: implement authoritative M40-02 history runtime unread |
| 30 | `ee762918e40dfd2530651c7f84d754a0f6890113` | M40-03 | feat: add M40-03 fixed interaction zone |
| 31 | `bd92294fd1dd7a0669ce89ddd0106ada31b637bc` | M40-04 | feat: complete M40-04 safe presentation rendering |
| 32 | `be3839b22bda0fe5d93bbc204a57a7e1ad502d21` | M40-05 | feat: implement M40-05 canonical error recovery |
| 33 | `f508cb49524b416f53c5cdbf1df3a70875ea1614` | M20-06 | fix: M20-06 bind anonymous legacy personal targets |
| 34 | `ed27d7c9315b50c59292507b44cdc9b90306c03f` | M50-01 | feat: implement M50-01 attachment share intents |
| 35 | `f8dfbefd9c63f053a005de1ae02fa9d81a0aead4` | M50-02 | feat: implement M50-02 secure artifact viewer |
| 36 | `784998335266a0560b468d1e3d306a3dcd3c585a` | M50-03 | feat: M50-03 close legacy workspace HTML preview |
| 37 | `16b464dac68a88efe32ab349f76f985932af94d7` | M50-04 | fix: M50-04 close voice playback and TTS safety gaps |
| 38 | `e660e81057fe078ad3fe06a31767f35a3e6c72fe` | M50-05 | feat: implement M50-05 lifecycle recovery state machine |
| 39 | `1c1fdb526134258b13e0d79345fae465118f7212` | M60-01 | test(mobile): establish M60-01 contract baseline |
| 40 | `358625a2c933102358843e100774a46062177a53` | M60-02 | test(mobile): add M60-02 native E2E evidence gate |
| 41 | `c047f39cd345137111da16b4f30f6184b0f2b9a0` | M60-03 | feat(mobile): enforce M60-03 native prebuild gate |
| 42 | `afe685cbb0da009868038a66800ed2205cca99bc` | M60-03 | fix(mobile): declare M60-03 config plugin dependency |
| 43 | `c123f24d065217c417904d6a655582c33c3bc9b4` | M60-04 | feat(mobile): implement M60-04 release evidence workflows |
| 44 | `15cb444880c14c44072d97896bed62425bf08f97` | M60-05 | feat(mobile): implement M60-05 observability contracts |
| 45 | `3c0b0da23761d0b024e3d9a630c9271acc689d01` | M70-01 | test(mobile): add M70-01 RC regression gate |
| 46 | `fdaaa3ece96d72bca06c0e5bd227dbcb5cab7b5a` | M70-02 | feat(mobile): add M70-02 upgrade rollback rehearsal |
| 47 | `6f7483f4db5081e68f188d5b72f535e376a4911c` | M70-03 | feat(mobile): add M70-03 staged rollout gate |
| 48 | `f1507f1b3dec5c998f281d78decc75799c18ed21` | 支持/门禁 | fix(web): resolve TASK-331 rebase presentation conflict |
| 49 | `17407f4457522494b3284af51744bac0ef30a2fc` | M60-01 | test(mobile): stabilize M60-01 OAuth concurrency gate |
| 50 | `8ed70369790f777507bb14f3992d574c3a9f76a4` | 支持/门禁 | test: align rebased main runtime fixtures |
| 51 | `da1a158ff859a5f54470a1ffaafb9855293c001e` | M60-05 | test(server): cover M60-05 route registration |
| 52 | `07834e41b1b6209359d0456d0888ca92cbc9ac40` | 支持/门禁 | test(server): align fail-closed runtime fixtures |
| 53 | `3e37f2544b092d1520f2cdf9998c451a6ce1345f` | 支持/门禁 | test(server): isolate artifact runtime environment |
| 54 | `ba68cddf8891fad6b78f495584e6165855264269` | 支持/门禁 | test(server): attest admin router test environments |
| 55 | `76948eeaea15caea0fe71a5f7603fe7d6c01c8cf` | 支持/门禁 | test(server): align governance migration ledger v35 |
| 56 | `2a2ffc52bdb4c93fff5509b0efd619847dd4d92d` | 支持/门禁 | test(server): keep run preflight V5 fixture current |
| 57 | `f5e327da12b9c05cd10b30b61dd2478602a49c2f` | 支持/门禁 | test(server): attest system prompt admin environment |
| 58 | `5b725cf0dfd0e96a11d0ae667cbc797e0dd4b9c9` | 支持/门禁 | test(server): align mobile protocol fixtures |
| 59 | `3c1388334d6a849c945adf3c0473aaf6003ea2f7` | 支持/门禁 | test(server): attest tool controls admin environment |
| 60 | `87e97128ef9059e010901d5344a72a194553489e` | 支持/门禁 | test(server): remove artificial bulk projection delay |
| 61 | `2b48e05231b3d225c31fe0e8e36465439d1794ca` | 支持/门禁 | test(server): attest remote hands admin environment |
| 62 | `09e2d2933a995b88d04077ff319af507577f0738` | 支持/门禁 | test(web): align mobile runtime presentation fixtures |
| 63 | `7dc2e671bcd7b6112d92b06b74a03c3e133f44df` | 支持/门禁 | test(web): hydrate authoritative interaction fixtures |
| 64 | `f517c081ab7999a17102c88441f580f4486f1b98` | Docs | docs(TASK-331): record mobile v1 evidence matrix |
| 65 | `85c7e1dc5566006a2ca039e544e48b508d5914c7` | 支持/门禁 | fix(ci): isolate native fixtures and route health probes |
| 66 | `cef21be98007ecace2c65ea4afc50fafaf93cfb2` | 支持/门禁 | refactor: extract mobile v1 responsibilities for ratchets |
| 67 | `f4605713323703293aab0a9122b42bd50f507ce2` | 支持/门禁 | fix(ci): align v35 and reasoned resource budgets |
| 68 | `97c853859f41eca9522b8bd00867bbd1b9fe3102` | 支持/门禁 | fix(server): use shared root exports in production bundle |
| 69 | `31b44427a2bf92fcd5b7c576b74f69acb4ef0192` | 支持/门禁 | fix(mobile): enforce real Router root and Gate A |
| 70 | `d20fa2ccc3339847558fd317f45cd08cc86c4295` | M60-04 | fix(mobile): make M60-04 source authorization achievable |
| 71 | `2bae5377eaa0b5308bba291d1eb218310df091f3` | 支持/门禁 | fix(shared): fence stale auth refresh responses |
| 72 | `858c0659e9b18b468665ed3a1c48e23620ebc620` | M30-01 | fix(shared): M30-01 serialize auth response side effects |
| 73 | `3ca01a4b9d6ae28be4721a809e0d34c1943521b8` | M00-01 | docs(mobile): M00-01 align remediation evidence |
| 74 | `ed67c1f29e9ae37838c0901c5bd970858b6f7134` | M30-01 | fix(web): M30-01 serialize saved account switching |
| 75 | `7a60d2a76fc94ad70c5b05ae78ffa89b6f038f32` | M00-01 | docs(mobile): M00-01 rebuild rebased evidence matrix |
| 76 | `69e2f5cda66a6bad15d631af53a3e311b0540cef` | M60-01 | fix(ci): M60-01 preserve coverage scope contract |
| 77 | `3bcba88f78155c27b87bbaa8cfdfbed4f7ea0608` | M00-01 | docs(mobile): M00-01 align final rebased evidence |
| 78 | `90704f6e47b284853deeee3b75eaa4445e800fbb` | M00-01 | docs(mobile): M00-01 refresh final-base evidence |
| 79 | `00604484e3d70564b4b3c256c0823594077fa865` | M00-01 | docs(mobile): M00-01 refresh authorized push evidence |
| 80 | `4ad67904801751e0c9de136de7b5dca82f7c9b95` | M30-01 | fix(auth): M30-01 preserve ordered identity intents |
| 81 | `321f94e2597f11fe93815c433c4d513a23b30a95` | M30-01 | fix(mobile): M30-01 isolate production user detail |
| 82 | `ff537f85813facf128f16826d9f27652cbc122c3` | M60-04 | fix(mobile): M60-04 isolate submit credentials by profile |
| 83 | `6a0ad1cda9aa6e60c5358f5761a34f653453560b` | M60-04 | fix(mobile): M60-04 invoke profile credential gate |
| 84 | `8db082e9863ddcabc439764acbf7e3192b7ef970` | M00-01 | docs(mobile): M00-01 bind evidence to current head |
| 85 | `30ddd0e57fd8fcb773009c1947e64786aa43bda7` | M00-01 | docs(mobile): M00-01 bind evidence verifier to head |
| 86 | `f72a3e0fb355c0850fb1ceb78e1257d482c10852` | M30-01 | fix(auth): M30-01 close stale identity windows |
| 87 | `d0d3f75675e474bbb93fc8acfb7b558eae20b694` | M60-04 | fix(mobile): M60-04 checkout before submit policy |
| 88 | `abbe8b7d68783cbd452567ffc786ee3d2a172ac0` | M00-01 | docs(mobile): M00-01 refresh evidence after identity fixes |
| 89 | `9ddce9610dc7ce5a788deb974af10a96b231391c` | M30-01 | test(mobile): M30-01 cover stale self response generation |
| 90 | `HEAD` | M00-01 | docs(mobile): M00-01 bind final stale-response evidence |

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
