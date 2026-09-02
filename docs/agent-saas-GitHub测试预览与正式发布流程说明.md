# agent-saas GitHub 测试、预览与正式发布流程说明

> - 原始现场核对时间：2026-08-30 23:27（北京时间）
> - 原始现场基线：`ZengLeiPro/agent-saas main@241c568dfa10c2e88cc3b480b4d7ae44e17d22a8`
> - 本次代码修订时间：2026-08-31（北京时间）
> - 第八轮返工起点：`PR #366 head@33a478febd38ffd09e93ead7d0e55700741804c3`。
> - 第十七轮返工最终同步基线：`main@88c2d8857159e2c14e5a0a40bceffe02603b4497`；最终实现以 PR #366 当前精确 head 与 Provider inspection 为准，避免在同一提交中写入不可能稳定的自引用 commit hash。
> - 最新实现核对时间：2026-09-01 14:15（北京时间）。
> - 范围：不含 iOS Release；说明 GitHub 从 PR 测试、Staging 预览到正式生产晋级的完整机制。
> - 证据边界：本文把代码保证、GitHub/阿里云现场配置、历史已验证样本和仍需人工操作分开表述；未在本次修订中手动运行 Staging 或 Production。

## 一、先看全貌

```text
开发分支 / PR
      │
      ├─ App CI / Deploy：Build & Check
      └─ ACS CI / Deploy：ACS Impact Gate
                │
        两项必需检查通过
                │
             合入 main
                │
 main push 跑 App CI；ACS 仅在相关路径命中时运行其拓扑
                │
       Deploy Staging RC（手动）
                │
 prepare-evidence：生成/复用不可变发布证据
                │
 build-deploy-verify：构建一次 → 固化 RC/Manifest/制品
   → 部署 Staging → 确定性门禁
                │
        ┌───────┴────────┐
        │                │
Staging Acceptance   可直接继续
（手动、可选 E2E）       │
        └───────┬────────┘
                │
Promote Staging RC to Production（手动）
                │
 ACS → API/Worker → Web → 全组件现场回读
                │
 none：completed；expand：等待独立确定性确认
                │
 Confirm Expand Migration（仅 expand，手动）
                │
       生产 identity 与物理运行态一致
```

这套流程把五件事分开了：

1. **代码能不能合并**：PR CI 决定。
2. **这个 main SHA 有没有可信发布依据**：`Deploy Staging RC` 的 `prepare-evidence` 前置 job 决定。
3. **不可变制品能不能在预览环境正常部署**：Deploy Staging RC 决定。
4. **完整浏览器、Agent 和业务行为是否符合预期**：可选 Staging Acceptance 决定。
5. **是否把这组已经冻结的制品晋级生产**：Promotion 决定。

## 二、GitHub 上六个 Workflow 分别做什么

| Workflow                           | 触发方式                     | 核心职责                                                | 是否改生产                 |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------- | -------------------------- |
| `App CI / Deploy`                  | PR、push main、手动          | App 主门禁；手动时兼容旧生产部署                        | 只有手动 dispatch 会改生产 |
| `ACS CI / Deploy`                  | PR、相关路径 push main、手动 | 判断 ACS 影响，测试 Orchestrator；手动时兼容旧 ACS 部署 | 只有手动 dispatch 会改生产 |
| `Deploy Staging RC`                | 手动                         | 创建不可变 RC、部署预览环境并跑确定性门禁               | 只改 Staging               |
| `Staging Acceptance`               | 手动、可选                   | 浏览器、Agent、ACS、恢复行为的完整 E2E                  | 只操作 Staging             |
| `Promote Staging RC to Production` | 手动                         | 将 RC 的原制品按 digest 晋级生产                        | 会改生产                   |
| `Confirm Expand Migration`         | 手动，仅 expand              | 独立重读生产并收口 migration confirmation               | 不部署；追加 attestation   |

`App CI / Deploy` 和 `ACS CI / Deploy` 的生产 Deploy 入口目前仍保留，作为兼容与应急通道；新版本正常发版应优先走 RC 主链。

## 三、第一阶段：PR 测试与合并门禁

### 3.1 main 当前受到什么保护

GitHub 现场已有两套 active Ruleset，且都没有 bypass actor：

- `main-release-admission`：`main` 必须通过 PR 合入，禁止删除和 non-fast-forward；分支必须基于最新 main。
- 必需检查：`Build & Check`、`ACS Impact Gate`。
- 当前不要求人工批准或 CODEOWNER 批准，但要求 Review 对话全部解决。
- `immutable-rc-tags`：禁止更新或删除 `rc-*` tag。

因此，正常情况下不能绕过 PR 直接把代码塞进 main，也不能事后移动或删除一个 RC tag。

### 3.2 Build & Check 实际检查什么

`App CI / Deploy` 在 PR 上启动 PostgreSQL 16 测试服务，然后执行：

- 工程 ratchets：大文件行数、环境变量数量、Web 首屏预算等。
- Release/Staging Workflow、migration、reconcile、isolation 等发布契约 Node 测试；这些测试由 `preflight_checks` 直接执行并汇总进 required `Build & Check`，不是仅供本地参考。
- Server typecheck、build、上下文关系基线评测。
- Server、Web、Shared 的 coverage 测试。
- 一组真实 PostgreSQL contract 测试。
- Web API boundary、场景定义 lint、脱敏检查。
- OSS 生产形态 Web build 与首屏预算复核。
- 生成 PR diff coverage 评论。

任何硬门禁失败都不能合并。Coverage artifact 只是补充材料，保留 7 天且上传失败不把 CI 判红；真正的结果仍在 Step Summary 和 PR 评论里。

### 3.3 ACS Impact Gate 实际检查什么

`ACS CI / Deploy` 先按变更路径分类：

- 不影响 ACS：检查直接通过，不做无意义的镜像构建。
- 只改 contract/test fixture：只跑 contract check，不发布镜像。
- 真正影响 ACS：执行 Server/Orchestrator typecheck、Orchestrator 测试和 ACS 运维脚本测试。

PR 阶段的 `ACS Impact Gate` 总会作为必需检查出现：先分类，再按影响范围运行 contract check 或完整 Orchestrator 检查，不部署。main push 并不是“完整重跑同一套 ACS CI”：`acs-sandbox.yml` 有路径过滤，只有命中 ACS 相关路径才启动；命中后再执行 Classify → Contract/Tests → Gate 拓扑。若属于 ACS publish 变更，阿里云 ACR 会为精确 SHA 构建镜像；GitHub 侧后续按 build record 和 digest 解析，不再把 digest 误当普通 tag。

## 四、第二阶段：手动 RC 流程先生成或复用 Release Evidence

PR 合入 main 后，`App CI / Deploy` 会再以 push 事件跑一次。随后人工运行 `Deploy Staging RC`；Workflow 会先在隔离的 `prepare-evidence` job 中锁定 dispatch 的完整 main SHA，等待并验证同 SHA 的必需 CI，再生成或复用 Release Evidence。证据准备成功后，独立的 `build-deploy-verify` job 才能进入 Staging 构建与部署。

`prepare-evidence` 会验证：

- 这个 SHA 恰好对应一个已合入 main 的 GitHub PR。
- App CI 确实成功。
- 若变更影响 ACS，同 SHA 的 ACS Gate/contract check 也必须成功。
- 当前生产 API、Runtime Worker、Web、ACS 的 source SHA 与制品 digest 可现场读回。
- API/Worker 的 active color、systemd unit、MainPID、pidfile、Worker readyfile、release symlink 与真实 target 相互一致。
- 生产现有制品能在阿里云 OSS 的不可变 baseline/record 中按 digest 找到。
- 组件分类和数据库迁移计划可以重新计算且结果一致。

最终证据以完整 SHA 为键写入 `/release-evidence`：同一 SHA 不允许覆盖；写入后再用独立只读身份重新 GET，并比较 canonical JSON。`prepare-evidence` job 本身不构建 RC、不部署 Staging，也不改生产；它成功后同一 Workflow 才进入实际部署 job。

如果它失败，最常见的含义不是“单测失败”，而是当前 main SHA 没有完整发布依据，例如生产 identity 与物理态不一致、ACS 同 SHA 证据缺失、基线制品找不到或该提交不是合法 PR merge。

## 五、第三阶段：部署 Staging RC

### 5.1 如何启动

在 GitHub Actions 手动运行 `Deploy Staging RC`，只能选择 main，输入可选的发版说明。Workflow 会锁定 dispatch 当时的完整 SHA，后续 main 再前进也不会改变本次 RC。

RC ID 自动生成，例如：

```text
rc-20260830-31
```

每次新的 dispatch 生成新的 RC；同一个 run 的 rerun 则恢复并复用原 RC，不重新覆盖 Manifest 或制品。

### 5.2 RC 是怎么被冻结的

Workflow 会：

1. 读取该 SHA 的 Release Evidence 和当前生产基线。
2. 计算 Web、API、Runtime Worker、ACS 哪些组件是 `deploy`，哪些可以 `keep`。
3. 对需要 ACS 的版本等待并解析精确 ACR 镜像 digest。
4. 在 Linux runner 上只构建一次 Server bundle、Web assets 和需要发布的 ACS Orchestrator bundle；`staging-runtime-assets` 由 `artifact-index.json` 单独固化，不属于 Manifest 字段。ACS Orchestrator 仅在分类为受影响时构建，否则复用生产 baseline 制品。
5. 按 SHA-256 将真实大制品不可覆盖地写入阿里云 OSS。
6. 创建 canonical `manifest.json` 与 `artifact-index.json`。
7. 创建不可移动的 annotated `rc-*` tag 和 GitHub Pre-release。
8. 将 Manifest、索引与追加式 attestation 同时记录到 GitHub Release 和 OSS release record。

GitHub Release 主要保存 Manifest、索引、attestation 和 operation receipt；真正的 Server/Web/ACS 压缩包主要存放在阿里云 OSS，ACS Sandbox 镜像存放在 ACR。

Manifest 顶层 `releaseSha` 只标识本次 RC commit；物理组件身份以各自的 `components.<name>.sourceSha` 和 artifact digest 为准。受影响组件的 `sourceSha` 等于顶层 SHA，`action=keep` 的组件则保留 Production baseline SHA，因此 API-only、Web-only 或 ACS-only RC 中不同组件 SHA 可以合法不同。Staging 写入及验收 Web、API/Worker、ACS identity 时都必须使用对应组件 `sourceSha`，不得用顶层 RC SHA 冒充 kept component 的物理来源。

### 5.3 Staging 会部署哪些东西

- Web：发布到 `agent-saas-web-staging` OSS，访问 `https://staging-agent.kaiyan.net`。
- API：独立 Staging ECS 上的 `agent-saas-server-staging.service`。
- Runtime Worker：同一台 Staging ECS 上的独立 `agent-saas-runtime-worker-staging.service`。
- ACS Orchestrator：同一台 Staging ECS 上的独立 `agent-saas-acs-orchestrator-staging.service`。
- ACS Sandbox：生产 ACK/ACS 集群里的独立 namespace、ServiceAccount、PVC 和 workspace 根。
- 数据库：与生产共用同一 RDS 实例，但使用独立数据库 `agent_saas_staging` 和独立 role。

API/Worker/ACS 先部署，Web 最后发布。Staging 只使用 Manifest 与 `artifact-index.json` 共同冻结的制品，不在目标 ECS 上重新 install/build。

### 5.4 Deploy Staging RC 的硬门禁

这个 Workflow 现在不跑 Playwright，而是验证七项确定性事实：

- immutable artifacts
- runtime identity
- API readiness
- ACS health
- Web OSS 全量读回
- migration readback 与隔离 fixture
- reverse isolation

隔离 fixture 固定为 `canceled`，只证明数据库迁移后的真实存储和鉴权读回，不冒充业务验收。

Staging 证据作为 GitHub Actions artifact 保留 90 天，同时把 verified attestation 追加进 GitHub Release 和 OSS record。只有这些门禁全部通过，RC 才进入 `verified` 状态，可用于 Promotion。

## 六、Staging 环境是不是完全独立

不是“完全物理隔离”，而是关键运行资源独立、部分基础设施逻辑隔离：

| 项目                                         | 隔离情况                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Staging ECS                                  | 独立实例，与生产 ECS 分开                                                       |
| Web OSS bucket                               | 独立 bucket                                                                     |
| 域名、证书、systemd unit、端口、锁、配置目录 | 全部独立                                                                        |
| 数据库                                       | 同一 RDS 实例，独立 database 与 role                                            |
| NAS                                          | 同一 NAS，独立 `/agent-saas-staging` 子目录，`all_squash` + 单一 `/32` 来源限制 |
| ACS 集群                                     | 同一集群/计算池，独立 namespace、PVC、ServiceAccount、workspace 根              |
| 通知                                         | Staging 强制 disabled，不向真实钉钉、短信、Web Push 发消息                      |
| 凭据/Vault                                   | 独立 namespace 与 Vault 文件                                                    |

每次 Staging 部署都会真实验证它不能读写生产数据库、不能写入 Production OSS bucket、不能访问生产 ACS 入口和生产目录，同时验证 NAS/PVC 的逻辑隔离。Production OSS probe 必须带完整 `observed`，明确证明 `403/AccessDenied`，服务端会从 canonical `observed` 重算每个 probe 的 digest；缺观察、返回 200、错误 code 或伪造 digest 都 fail closed。当前代码**没有证明 Staging OSS 身份不能读取生产 OSS**；因此这里的 OSS 保证只表述为“禁止写入”，不把权限配置推断成未执行的读拒绝证据。

必须保留一个明确边界：具有宿主机特权的身份理论上仍能重新挂载共享 NAS 根目录，所以这里不能宣传“完全隔离”或“物理隔离”。

## 七、第四阶段：可选 Staging Acceptance

`Staging Acceptance` 已从部署链彻底拆出：它默认不运行、不影响 Promotion，也不写入正式发布 attestation。

需要时手动输入当前 RC ID。Workflow 会先确认：

- RC tag、Manifest digest 和 SHA 一致。
- 指定 RC 仍然是 Staging 当前在线版本。
- Web identity 的组件 SHA、`configFingerprint/webDigest` 与 Manifest 的 `components.web.sourceSha`、Manifest digest 和 Web artifact digest 一致。
- API ready 的组件 SHA、`serverDigest/webDigest/ACS Orchestrator/Sandbox digest` 与 Manifest 的 `components.api.sourceSha` 及各组件 artifact digest 一致。
- 每个验收阶段都通过固定 host key 的 SSH 从 Staging ECS 回读 ACS `/health`，把实际 `sourceSha`、Orchestrator/Sandbox digest、namespace 和已 attested identity 绑定到 `components.acs`；部署完成时也执行同一物理 identity 校验。

随后安装 Chromium，并执行完整 Playwright/Agent 套件，覆盖：

- 登录、Web entry、API readiness、WebSocket。
- 浏览器消息流与持久化 Worker。
- Agent 在真实 ACS Sandbox 中运行 Read/Write/Shell/Browser。
- 高风险工具批准、取消、超时恢复、后台任务续跑。
- 网络重连、Worker 重启、ACS Orchestrator 重启。
- Sandbox pause/resume、制品持久化、Taskboard fixture、反向隔离。

当前配置为 `workers: 1`、`fullyParallel: false`，也就是完整 E2E 仍然串行。它可能主动重启 Staging Worker/Orchestrator、暂停 Sandbox，因此运行时不要把同一套 Staging 当作多人稳定演示环境。

测试前后会精确重置 fixture；证据 artifact 保留 14 天，失败时保留 screenshot/video，但关闭 trace，避免把 Staging bearer token 持久化进 trace。

## 八、第五阶段：Promotion 到生产

### 8.1 如何启动

手动运行 `Promote Staging RC to Production`，必填：

- `release_id`：已经通过确定性 Staging 门禁的 RC。
- `reason`：这次生产晋级原因和人工判断。

这个 reason 会成为追加式 approval attestation，不只是界面备注。

### 8.2 晋级前检查

Promotion 会同时核对：

- Git tag、GitHub Release、OSS record 中的 Manifest digest 一致。
- RC SHA 仍属于 main。
- RC 未超过 24 小时有效期。
- Staging Deployment 与 Staging Workflow 均成功，七项确定性门禁齐全。
- 当前生产基线没有漂移，rollback target 仍成立。
- 所选 Server/Web/ACS 压缩包及 ACR 镜像 digest 全部匹配 Manifest。
- 数据库迁移只允许 `none` 或 `expand`；`contract` 必须另发版本。

任何一项前置证据不一致都会在修改生产前 fail closed；进入物理写入后的异常按真实 reconcile 状态记录，不宣称所有后置故障都能自动回滚。

### 8.3 真正部署顺序

Promotion 的生产顺序固定为：

1. ACS Orchestrator + 精确 Sandbox image digest。
2. API 蓝绿部署 + Runtime Worker 安全交棒。
3. Web assets，最后切换入口文件。
4. 重新读取所有组件的真实物理运行态。
5. 只有全部收敛后，才原子提交可信 production runtime identity。
6. 再次读回 identity 并与物理运行态逐组件比较；只有 readback step 成功且 `target_match=true` 才允许记录 `completed` 或 `awaiting_expand_confirmation`，否则记为 `needs_human`。

每个组件在动作开始和结束时都写 durable operation receipt。Workflow 会记录 GitHub Production Deployment、最终 attestation，并上传生产前、生产后、生产确认和 reconcile 证据；Actions artifact 保留 90 天。

如果生产本来已经等于目标 Manifest，Workflow 会验证后跳过重启或重复上传。重跑边界按 attestation 尾状态收紧：`failed_before_change` 可重新批准，包括完整闭合的 `approved → promoting → failed_before_change`，但该 `promoting` 必须绑定原 RC/Manifest、migration plan 和生产 before/target digest；悬空 `promoting` 或缺绑定失败证明均拒绝。尚未写生产的 `approved` 可重跑；`awaiting_expand_confirmation` 只能进入独立确认入口，且确认窗口一旦过期即 fail closed，不能由同一次确认自动续期或追加自迁移；此时必须基于当前 main 和当前生产基线重新创建 RC。`needs_human`、`partial_failed`、`rolled_back` 和 `completed` 均不能直接重新 Promotion。`rolled_back` 只能由 ACS/App 部署脚本或 Web 恢复 trap 的真实 rollback 证据与完整生产读回共同证明，不能从 deploy step failure 推断；Web 会先记录 attempted，只有 `release-identity.json` 与 `index.html` 都恢复成功并从 OSS 按字节回读一致后才记录 succeeded，任一恢复或入口核验失败均进入 `needs_human`，不能仅凭 identity 回到 before 就宣称回滚完成。例如 Web 在安装 trap 前读取旧 OSS entry 失败、且现场仍为 before 时，只能记 `failed_before_change`。远端 payload、candidate、backup、rollback 与 readback 临时路径同时绑定 GitHub run ID 和 run attempt，重跑不得复用上一 attempt 的恢复证据。仓库不声称自动恢复 `partial_failed`；这类状态必须先人工核对和另行处置。

### 8.4 数据库变更的特殊处理与静态白名单

- `none`：组件收敛后可以直接完成。
- `expand`：允许部署兼容性扩展；`promoting` attestation 会不可变绑定 `releaseSha`、`migrationPhase`、migration plan digest 与生产 before/target digest。`none` 只允许从 `promoting` 直接完成，`expand` 则禁止任何通用 `completed`，组件物理收敛后只能进入 `awaiting_expand_confirmation`，不能由普通 Promotion 重跑推进。随后手动运行 `确认扩展迁移`，它只接受原 release ID，重新校验 Manifest/release SHA、migration plan digest、原始 promoting attestation 中的生产 before/target digest，独立读取全部生产组件，并重新读取绑定该 RC 的 Production API ready（API ready 只会在启动迁移完成后成立）。最终 append 会再次校验完整 evidence schema、API ready 的 release ID/SHA、`liveObservedAt`、`confirmedAt`、2 小时确认窗口和 5 分钟现场/证据新鲜度；任何上传延迟导致的陈旧证据、重复确认、跨 RC/跨 plan 或现场基线漂移都 fail closed。确认窗口一旦过期即 fail closed；同一次确认不能续期，必须重新创建绑定当前生产基线的新 RC。
- `contract`：Promotion 明确禁止执行，必须等兼容窗口结束后作为独立版本处理。

Migration plan 会从仓库权威入口构建 baseline 与 target 两侧的相对 import/re-export 依赖图：遍历会穿透普通 barrel，并分类权威根、governance 命名 provider、带独立 `release-migration` metadata 的最终 provider，以及从权威入口真实 import 的 binding；所有非 type-only 静态 import/re-export 都进入 runtime execution 图（含具名、default、namespace、`import {} from` / `export {} from`）；其中出现顶层可执行代码、runtime namespace、class 求值副作用或静态 SQL provider 时纳入闭包，纯 type-only edge、普通静态 logger/store 与延迟函数声明不误判。请求的 export 名会跨 `export ... from`、local alias、default export 与普通 barrel 逐层传播到实际声明；实际被调用的 binding 还会反向穿透赋值别名、对象/数组解构、静态成员和 namespace import；作为未知高阶 API 参数直接传入或嵌在对象字面量、数组、spread、条件表达式中的 imported callable 也会保守传播；`wrapper.run()`、嵌套/计算属性成员、destructuring/assignment alias、class field/constructor 这类静态可执行链会继续穿透对象属性、工厂返回、alias 与 re-export 到实际 imported provider；`Reflect.get`、`Reflect.getOwnPropertyDescriptor`、`Object.getOwnPropertyDescriptor`、`Object.getOwnPropertyDescriptors` 及其静态 method/object/destructuring alias 等反射式读取在键可静态解析时保留成员路径；descriptor 的 `value/get/set`、descriptor 容器 alias、对象持有/后赋值的 method alias，以及通过参数返回 singular/plural descriptor 的本地 wrapper（含嵌套 block body 的参数局部 alias 链与返回值局部 alias）会回溯原成员；wrapper factory 自身经过声明、简单赋值、owner/alias 链、数组/对象解构、可证明长度的变量数组 spread（含声明/赋值 array owner alias 与 rest binding）、静态/嵌套对象 spread、class static field、returning function 声明/赋值 alias 或多级静态 factory-return 后再调用也保持同一 descriptor 绑定，经 `call`/`apply`/`bind` 及 `Function.prototype.call.bind` 调用（含静态参数数组）仍保持该绑定。动态 `apply` 参数直接 fail closed，descriptor wrapper 的局部 alias、factory alias/callback、动态 computed 读写（含声明/赋值 owner alias，以及静态可关联的 `Reflect.set`、`Object.assign` 写入）均纳入追踪；`Reflect/Object.defineProperty` 的 property descriptor，以及 `Object.defineProperties` 的 descriptors map 与嵌套 property descriptor，都支持声明、整体赋值、多跳 alias，以及成员赋值、`Reflect.set`、`Object.assign` 等增量 shape；出现多写、动态值或无法唯一解析时按全成员保守 fail closed，数组通过直接成员调用或 `Array.prototype.push/unshift/splice.call/apply` 插入 descriptor factory 时登记为动态成员写入；`apply` 参数数组中的直接、嵌套和可证明长度的 alias spread 会按真实顺序静态展开，动态或歧义 spread 会保守关联整组参数，后续任何索引读取不能静态证明安全即 fail closed，从而把 provider-only diff 纳入差异分析。无法静态证明的 `import()`、`require()` 与 `createRequire`（含 namespace、元素访问和多级 alias）直接 fail closed。命中静态数据中的 DDL/DML 后即把 provider 纳入分类。最终 provider 不依赖文件名、变量后缀或自愿 metadata 才被发现；未自愿标 metadata 也会先进入闭包，再因缺 metadata 而 fail closed。根入口包括 `server/src/data/**/migration(s).ts`、`server/src/data/**/migrate.ts`、`server/src/context/**/migration.ts`、`server/scripts/migrate-*.mts` 和独立 migrations 目录，`v22Migration.ts`、`agentDwsMigrations.ts` 等 governance runner 间接执行的 provider 也在分类闭包内；baseline/target 新接入的 provider 按全量新增分类，断开的 provider 直接阻断，普通 logger/store 不会因被 import 而误判，同时仍读取 rename/delete 状态。`expand` metadata 只能是独立的 `//`、`--` 或 `/* */` 注释，普通字符串和 PostgreSQL `$$...$$`/`$tag$...$tag$`（tag 支持 PostgreSQL Unicode identifier） 正文都不能伪造，未闭合 dollar quote 直接 fail closed；新增 SQL 会先用支持 PostgreSQL `E''`、dollar quote、双引号与嵌套块注释的 lexer 去注释、遮蔽 literal，再按顶层分号逐语句分类；只接受非 CTAS 的 CREATE TABLE/INDEX/SEQUENCE 和单一 ALTER TABLE ADD/VALIDATE；CREATE expression 不只检查函数名：CREATE INDEX 仅接受内建 `btree`/`hash` access method、裸列（可带排序/NULLS）或显式 `pg_catalog.lower(列)`，拒绝 operator、cast、opclass、partial predicate 与自定义 access method；CREATE TABLE 拒绝 DEFAULT、CHECK、EXCLUDE、partition expression 等不可证明表达式。`HASH`、`INCLUDE`、`KEY`、`RANGE` 等只在对应 CREATE 语法位置放行，`numeric(10,2)`、`varchar(255)` 等 type modifier 只接受直接列声明中的纯数字参数，不能借同名函数依赖 `search_path`；schema-qualified 自定义函数、quoted identifier 与其他未限定函数均拒绝；`ALTER TABLE ... ADD CONSTRAINT` 一律 fail closed；`ADD COLUMN` 不再采用“未命中危险关键词即放行”，只接受可证明 nullable 的 PostgreSQL 内建类型（可显式 `pg_catalog` 限定、纯数字 type modifier 或 array）及可选静态 literal `DEFAULT`；无法排除 domain 隐式约束的自定义/搜索路径类型也 fail closed。inline `CHECK/NOT NULL/UNIQUE/PRIMARY KEY/REFERENCES/EXCLUDE`、`serial` 家族、IDENTITY、GENERATED expression，以及 DEFAULT 中的 operator（含一元正负号）、cast、函数或其他复合表达式全部拒绝；未知/未来约束语法、带名/无名 CHECK 与 `NOT VALID` CHECK 同样不能进入通用 expand 白名单。全部 INSERT（包括 `ON CONFLICT DO NOTHING`）、CREATE TABLE AS、未知/尾随第二语句和全部 psql 反斜杠元命令均拒绝；原因是 INSERT 的 VALUES/default 表达式可调用 VOLATILE 函数，无法仅凭冲突策略证明无副作用。对 TS/MTS migration 还会按新增目标行执行 TypeScript AST 校验：任何新增或被新增行触及的可执行调用、控制流与动态表达式都 fail closed；TS/MTS 的 `expand` 只接受静态字符串、数组或对象形式的声明式 SQL 数据，computed member、indirect/Reflect 调用、custom runner、动态参数和模板插值均不允许；静态字符串会先按 AST 解码转义后再分类。复合 ALTER、CALL/CTE 与任何无法静态证明无执行副作用的 CREATE expression 同样拒绝。

升级前已经落盘、没有新 migration binding 的旧 `promoting` attestation 仍可按原样 hydrate，供历史审计和读取完整旧链；兼容层不改写记录、不猜测 plan digest，也不允许新的 `promoting` 省略绑定。若旧历史停在无绑定 `promoting`，新代码不能直接把它推进成 `completed`，应重新生成符合当前 schema 的 RC。

## 九、为什么 RC 只有 24 小时可晋级

24 小时限制的是“可晋级资格”，不是 RC 文件的保存时间，也不会自动删除 Staging 或 GitHub Release。

它主要约束三类陈旧风险：

- 人工 approval 和测试结论不能无限期沿用。
- 生产基线、rollback target、配置与依赖可能已经变化。
- main 和 ACR/OSS 的可验证关系不应该长期悬空。

超过 24 小时后，应从当前 main 和当前生产基线重新创建 RC；不能修改旧 Manifest 的 `expiresAt`，也不能移动旧 tag。旧 RC 继续保留作为审计记录，只是不再具有晋级资格。

## 十、是否支持多个 Staging 版本

要分两层理解：

- **不可变 RC 记录可以同时存在多个**：每个都有自己的 tag、GitHub Pre-release、Manifest、OSS 制品和 attestation。
- **在线 Staging 只有一个槽位**：固定 ECS、固定三套 staging unit、固定 Web OSS bucket、固定两个域名；新 RC 部署后会成为唯一在线版本。

`Deploy Staging RC` 与 `Staging Acceptance` 共享同一个 `staging-runtime` concurrency group，因此部署和验收全局互斥。Acceptance 在开始、fixture reset 与浏览器依赖准备完成后且真正执行 E2E 前、以及结束前共三次校验同一 Manifest 与 Web/API/ACS identity，并把顶层 RC SHA 与组件 `sourceSha` 分开处理：Web/API/ACS runtime SHA 分别绑定 `components.web.sourceSha`、`components.api.sourceSha`、`components.acs.sourceSha`，再将 Manifest digest 与 Web `configFingerprint/webDigest`、API `serverDigest/webDigest/ACS digests` 及 ACS 现场 health digests 逐项绑定；即使同一 RC ID/SHA 下出现错误制品、Manifest 资产漂移，或外部配置绕过 concurrency 导致换版，也会 fail closed。旧 RC 的文件可以继续存在，但无法与新 RC 同时提供独立预览 URL。

## 十一、GitHub 与阿里云分别存了什么

### GitHub

- Actions 日志和 runner 临时目录：由 GitHub 托管，run 完成后 runner 临时盘销毁。
- Coverage artifact：7 天。
- Staging deterministic evidence artifact：90 天。
- Staging Acceptance screenshot/video/summary：14 天。
- Production Promotion evidence artifact：90 天。
- GitHub Pre-release：Manifest、artifact index、追加式 attestation、operation receipts；没有 workflow 内置过期时间。
- `rc-*` tag：Ruleset 禁止更新和删除。
- Actions cache：pnpm/Node 依赖缓存，计入 GitHub Actions cache 配额。

### 阿里云

- Release OSS：Server/Web/ACS Orchestrator 压缩包、晋级必需的 artifact index/canonical record，以及 GitHub 权威日志的 attestation/operation 审计镜像。
- ACR：ACS Sandbox 镜像及其 digest/build record。
- Staging Web OSS：当前在线预览 Web。
- Staging ECS：当前及历史 release 目录、独立 systemd units 和运行状态。
- Evidence Service 持久目录：Release Evidence 与 Staging isolation evidence。
- Staging RDS database、NAS 子目录、ACS namespace/PVC/Sandbox：预览和可选 E2E 的状态与 fixture。
- Production ECS/OSS：正式 API、Worker、ACS 与 Web 的物理运行态和 byte seal。

RC 多次 Promotion 重试会追加新的 attestation 和 operation receipt。GitHub Release 是 **attestation/operation 历史** 的 Promotion 重跑权威日志，OSS 对这两类小日志提供审计镜像；GitHub 已成功而该日志镜像暂时失败时 Workflow 会明确告警但不伪造失败状态，镜像需单独补写。这里不适用于 RC 的 canonical `manifest.json`、`artifact-index.json` 与 release record：它们仍是晋级前必须从 OSS 下载并逐项比对的硬门禁，缺失或读取失败会阻断 Promotion。单个文件通常很小且不会覆盖旧记录；这是审计设计，不应把它当缓存随手删除。真正容易增长的是 OSS 大制品、ACR 镜像、GitHub Actions artifact 和失败 E2E 的视频。

## 十二、旧 App/ACS Deploy 入口怎么理解

`App CI / Deploy` 和 `ACS CI / Deploy` 的手动生产入口属于 compatibility 通道，但能力并不对称：

- App dispatch 只接受 `main`，并且**只允许 Web-only compatibility publish**。运行界面必须显式确认 `web_only_compatibility=true`；部署计划会读取生产 active ECS SHA 到目标 SHA 的累计差异。只要出现 Server/API/Runtime Worker 相关路径，或无法证明差异只影响 Web，就会在任何生产 mutation 前 fail closed，要求改走 RC + Production Promotion。
- App compatibility 不再允许跨 `deploy-ecs` / `deploy-web-oss` 两个 job 发布 Server 与 Web。原因是跨 job 失败无法提供同一事务式补偿；保留旧 trusted identity 并不能让混合物理态变得原子。Web-only 路径会在任何 OSS mutation 前枚举本次可能覆盖的全部可变键：四个入口、`icons/`、`kaikai-presets/`、favicon/avatar 固定键与 Workbox 文件；逐键记录原状态为 present/missing，把 present 内容和对象 headers/metadata 复制到事务前镜像，并与 recovery Web 现场按字节核对。最终现场组件读回、identity 写入或确认读回任一步失败，都会按 manifest 恢复 present 键、删除事务新增的 missing 键，同时恢复 recovery Web 与原 trusted identity；随后逐键核对 OSS/recovery 的内容、对象 metadata 或 404 状态，并以完整 Production 读回证明三者重新一致后失败退出。hash assets 通过独立 helper 先生成最终传输字节，再只创建新键或按字节和 HTTP headers 复用既有键；写入由仓库锁定的 `ali-oss` SDK 读取 runner 上权限收紧的临时凭据文件，使用规范化的 `oss-<region>` endpoint 并发送真实 `x-oss-forbid-overwrite:true` 条件请求，固定 ossutil 2.1.2 仅承担其真实支持的 stat/readback 命令且在安装后探测参数契约，不承担条件写；只有 SDK 返回精确 HTTP 409 `FileAlreadyExists` 才进入复用证明，并发同名创建或既有对象有任何字节/headers 漂移都会在固定键 mutation 前失败，因此不参与覆盖补偿。补偿或证明失败必须人工处置。
- ACS dispatch 只接受 main，并在初始检查和实际部署 mutation 前再次要求 `origin/main` 精确等于 run SHA；ACR record 即使已经进入 `PENDING`/`BUILDING`，main 前进也会让本次旧 dispatch 在生产部署前 fail closed。它独立维护 ACS identity，但仍不提供 RC Promotion 的完整跨组件原子性。
- 两个 compatibility 入口都不创建不可变 RC、不部署 Staging、不产生完整 Promotion receipts 与跨组件收敛证据。
- App、ACS、Promotion 与 expand confirmation 共享 `production-runtime` concurrency group，仓库代码保证生产写操作串行；仍需 GitHub Actions 权限与外部手工变更纪律配合。

最重要的混用风险是：如果先创建了 RC，随后又用 compatibility 通道改变生产基线，旧 RC 的 rollback target 会漂移，Promotion 应当被阻断。此时正确动作是重新生成 Evidence 和 RC，不是强行绕过门禁。任何 Server/API/Worker 变更都直接走正式 RC 流程，不要把 Web-only 入口当成“少一步的 Promotion”。

## 十三、推荐的日常发版操作顺序

1. 所有代码通过 PR，不直推 main。
2. 等 `Build & Check`、`ACS Impact Gate` 都绿再合并。
3. 合并后等 main push CI 通过。
4. 手动运行 `Deploy Staging RC`，写清发版说明；先等待其 `prepare-evidence` job 成功，再进入构建部署。
5. 打开 `https://staging-agent.kaiyan.net` 做必要的人工目检。
6. 高风险版本、重要交互改动或专门测试窗口，再手动跑 `Staging Acceptance`；普通确定性版本不必每次死磕完整 E2E。
7. 在 RC 创建后 24 小时内运行 Promotion，填写明确原因。
8. 最终核对 Production Deployment、completed attestation、API ready、ACS health、runtime identity 与 active physical topology。

## 十四、我认为最需要注意的事项

1. **不要把“CI 绿”写成“已上线”**：PR/push 只测试；Staging 和 Production 都要显式 dispatch。
2. **Release Evidence 是正式链必需环节**：它由 `Deploy Staging RC` 的前置 job 生成或复用，不是重复测试，而是把 main、CI、生产基线和不可变制品绑定起来。
3. **完整 E2E 不再阻塞发版是正确选择**：它仍有价值，但当前单 worker 串行、包含重启和恢复测试，天然比确定性部署门禁更慢、更易波动。
4. **只有一个在线 Staging**：跑 Acceptance 或部署新 RC 前，应先确认没有人正在演示或测试旧版本。
5. **Staging 不是完全物理隔离**：共用 RDS 实例、NAS 和 ACS 集群；任何新增连接器、通知或数据访问能力，都必须继续扩展反向拒绝证据。
6. **失败或取消后检查临时 SSH 白名单是否撤销**：Workflow 有 `always()` 清理，但外部 API 故障或任务被强制终止时仍应现场复核安全组 `/32` 规则。
7. **不要反复新建同 SHA 的 RC**：rerun 原 run 会安全复用原 RC；重新 dispatch 会制造另一个永久 tag/Release/OSS record。
8. **24 小时到期就重建，不延长旧 RC**：这能避免拿陈旧审批和旧生产基线继续晋级。
9. **旧 compatibility Deploy 只用于明确场景**：App 入口仅允许已证明的 Web-only 目标，并用逐键事务 manifest 补偿全部可覆盖 Web 固定键，同时禁止覆盖 hash assets；Server/API/Worker 一律走 RC Promotion。任一 compatibility 发布改变生产后，尚未晋级的旧 RC 应视为需要重做。
10. **为大制品建立显式保留策略**：GitHub 小型审计文件可以长期保留；OSS bundle、ACR image、失败 E2E 视频应按“最近版本 + 已晋级版本 + 回滚窗口”制定清理规则，任何批量删除仍需先列清单确认。

## 十五、历史已验证样本与本次验证边界

以下是 2026-08-30 原始核对时的历史现场样本，不是本次代码修订重新执行的发布：

RC31 已实际跑通当时的主链：

- Staging RC：run `33311367445`，success。
- Promotion：run `33317838540`，success。
- 后置 Release Evidence：run `33318219901`，success。
- 当前生产：`rc-20260830-31`，API/Worker/ACS/Web identity 与物理运行态一致。
- Staging Acceptance：本轮未运行，符合“可选、不阻塞”的新规则。

该样本证明 2026-08-30 版本曾用真实 RC、Staging 和 Production 跑通。P0–P2 修订后的共享 Staging 互斥、独立 expand confirmation 和 Web-only compatibility 收窄，本次仅执行仓库静态测试、状态机测试、typecheck/build；仍需后续按审批窗口做一次 Staging/Production 现场复测，不能把旧样本升格为新实现的现场证明。
