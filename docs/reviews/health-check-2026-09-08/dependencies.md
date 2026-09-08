# 依赖与供应链专项体检

> 基线：`a6b6865e`；审计时间：2026-09-08；工具：pnpm 10.18.3。此文件是时间点快照。以后 review 或升级时，应先用当时的锁文件重新审计，不能把这里的修复版本当成永久安全版本。

## 结论

本次实时执行 `pnpm audit --json` 和 `pnpm audit --prod --json`，没有安装、升级或自动修复任何依赖。锁文件扫描命中已知公告；其中移动端 Markdown 解析库有实际业务调用路径，应优先处理。大部分严重告警落在测试、打包、Expo/EAS 工具链，不能把扫描中的 critical 数量直接解释为生产 API 的远程执行漏洞数量。

| 口径              | 依赖数（工具输出） | Critical | High | Moderate | Low | 合计告警计数 | npm advisory 记录 | 独立 GHSA | 涉及包名 |
| ----------------- | -----------------: | -------: | ---: | -------: | --: | -----------: | ----------------: | --------: | -------: |
| 全工作区          |              1,987 |        3 |   73 |       41 |   6 |          123 |               105 |        91 |       38 |
| 全工作区 `--prod` |              1,297 |        1 |   36 |       21 |   4 |           62 |                60 |        57 |       23 |

注意四种单位不同：123/62 是工具 metadata 的告警计数，105/60 是本次 JSON 中不同 npm advisory ID 的记录数，91/57 是唯一 GHSA 数，38/23 是包名数。同一 GHSA 可能按受影响版本分支产生多条 advisory 记录；多个发现路径也不等于多个独立漏洞。`--prod` 是 workspace dependency 分类，**不等于最终 ECS 制品中实际运行的代码集合**：根目录把 Expo/React Native 列为 dependencies，这些包还能传递引入开发工具；Web 构建依赖也不一定打进浏览器 runtime。真实部署风险需要结合最终 SBOM/产物依赖和具体调用继续判断。

原始结果的必要字段已保存到 [依赖证据 JSON](./evidence/dependency-advisories.json)，本文附录列出全部 105 条记录，可按 GHSA 跟踪解决。没有把“同一包有多个公告”拆成多个工程任务。

## DEP-01：移动端内容解析器处在已知受影响版本，且业务会处理非可信文本

**建议 P1；版本与业务可达性已确认；本次没有进行 OOM/恶意输入资源耗尽实验。预计 1～3 人日。**

锁文件的 mobile importer 固定 `marked=18.0.0`、`markdown-it=10.0.0`。`mobile/src/lib/marked.ts:4` 构造实际 Marked 实例，`:6` 在主执行链中同步解析；`mobile/src/components/chat/TextSelectModal.tsx:21` 通过 useMemo 生成可选择文本 HTML。`mobile/src/lib/markdownIt.ts:4` 开启 `typographer: true`，会启用本次公告涉及的排版规则。输入来自会话和文档内容，不能按源码固定字符串看待。

| 组件        | 当前版本                            | 已确认公告与范围                                                       | 处理建议                                                                                  |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| marked      | 18.0.0                              | 18.0.0/18.0.1 存在解析递归与内存耗尽问题，18.0.2 修复该公告            | 先升到经当前审计确认的兼容修复版，验证 CJK 插件和文本选择 HTML                            |
| markdown-it | 10.0.0                              | `<12.3.2` 有资源消耗问题；另一个 smartquotes 复杂度问题要求至少 14.2.0 | 10→14 是跨主版本迁移，不能仅写 override；检查插件、类型、链接策略与原生 Markdown 渲染适配 |
| linkify-it  | 由 markdown-it 引入，实际版本见附录 | match/mailto 扫描复杂度问题；本次公告最新修复范围至少 5.0.2            | 随 parser 一并升级和验证，不强行让旧 markdown-it 使用未保证兼容的新主版本                 |

相关原始公告：[Marked 维护者公告](https://github.com/markedjs/marked/security/advisories/GHSA-6v9c-7cg6-27q7)、[markdown-it 资源消耗公告](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-6vfc-qv3f-vr6c)、[markdown-it smartquotes 公告](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-6v5v-wf23-fmfq)。

小输入也可能触发 parser 缺陷，所以仅加“最大消息 200 KB”无法替代版本修复；同步解析也不能靠一个外层 Promise.race 获得真实 CPU 截止时间。升级后可加长度/嵌套/结构复杂度预算、受控错误回退和性能基线，防御尚未知的异常内容。

验收应包括：中文标点和中英文混排、列表和任务框、代码块、表格、链接、文本选择/复制、普通异常字符和深层结构；文本应正确转义，不能为适配新 parser 顺手开启原始 HTML。解析鲁棒性测试在有 CPU/内存预算的独立测试进程中运行；正常消息与长文档都要经过原生实际渲染链。UI 不崩溃、解析失败有可恢复提示、文件和消息内容不串换。

## DEP-02：测试、开发和发布工具链存在严重已知告警，但需要按具体功能判定风险

**建议 P2；若团队把测试 UI/开发服务暴露给不可信网络，提升处理优先级。版本命中已确认，可利用功能未在生产验证。预计分两批 2～4 人日。**

### 三条 critical 应怎样理解

- **Vitest 4.0.18**：维护者说明风险与暴露 UI/API 或 Windows UI/Browser Mode 有关，修复版本为 4.1.0/3.2.5 对应分支。当前 CI 用 `vitest run`，本次没有发现已暴露的 Vitest UI 服务。因此这是必须治理的工具链版本，不是已证明的生产端点漏洞。[Vitest 维护者公告](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
- **shell-quote 1.8.3**：本次全量审计通过 concurrently 命中，prod 分类还可通过 react-devtools-core 命中。相关严重问题要求攻击者控制被当作 operator 的对象等特定输入；仓库 dev 脚本主要是固定命令字符串，未证明这一可利用条件成立。对应 critical 的修复范围是至少 1.8.4，但同时存在 parse 复杂度公告，当前计划应合并评估至少 1.9.0。[shell-quote 公告](https://github.com/shell-quote/shell-quote/security/advisories/GHSA-w7jw-789q-3m8p)
- **tar 7.5.7，经 EAS CLI 18.1.0 引入**：多个公告涉及解析、链接、路径与资源预算；critical 公告修复于 7.5.19，但同一锁定版本还有后续公告，单升到 7.5.19 不会关闭全组，本次表中最高修复下界为 7.5.21。应用处理压缩包的工具链应升级并保留资源预算。[node-tar 维护者公告](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw)

### 其他工具链与构建依赖

Web 直接 Vite 为 5.4.21，Vitest 又带入另一条 Vite 依赖；不同版本分支分别命中公告。PostCSS 8.5.6、Rollup、serialize-javascript、Babel、EAS 的 node-forge/tar/glob/minimatch 等也在清单内。不要只升级一条 root 版本后假定所有 workspace 的传递依赖都已修复。

建议将变更拆成：

1. 测试栈：Vitest、覆盖率插件、Vite 测试依赖一致升级；重跑分片、blob merge、Node/DOM 环境与模拟计时器回归。
2. Web 构建栈：选择插件兼容的 Vite/React plugin/PWA/Workbox/Rollup/PostCSS 组合。重新验证真实 OSS 构建、公网静态包契约、SW 升级、路由恢复和首屏预算。
3. Expo/EAS 栈：优先通过兼容当前 Expo SDK 的上游版本解决工具链依赖；保留 Expo 的版本校验和最终 prebuild/export 检查。不要为了 audit 清零随意改 React Native/Expo 的精确兼容版本。

工作区 `pnpm-workspace.yaml` 已有 2,880 分钟最小发布时间和有限的构建脚本白名单；根 packageManager 和 CI 下载 pnpm 的 SHA-256 已固定。这些是已有的供应链防护，不能因发现漏洞就一并关闭。最小发布时间只能降低新发布包的风险，无法修复已经长期锁定的已知受影响版本。

## DEP-03：服务端传递依赖与精确 override 需要持续复核

**建议 P2；对于真实外部输入可触发的服务路径按 P1 处理。版本命中已确认，完整业务可利用性仍需专项核对。预计 1～3 人日。**

| 路径                                            | 当前证据                                                               | 风险解释和下一步                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| server → ali-oss → urllib 2.44.0                | 锁文件及安装依赖命中 GHSA-hq3h-g68c-hp78，修复范围至少 2.44.1          | 跨 origin redirect 可保留携带凭据的请求头；核对 OSS endpoint、重定向策略和实际 SDK 行为，优先兼容升级，不能把“只请求 OSS”当成不用修依赖的理由 |
| server → Express / MCP SDK → qs                 | qs 命中 stringify、数组限制及 isBuffer 相关公告                        | 逐个核对 query/body parser 实际选项；受影响代码在依赖中，不等于所有路由都满足特殊输入条件。升级后回归查询解析、请求限制和第三方代理           |
| server → 阿里云 SDK → socks → ip-address        | 地址解释类公告                                                         | 这不是本仓 WebFetch 自己使用的 `ipaddr.js`。不能把包名相似当成 WebFetch 已被证明绕过；核对代理链用途和网络边界                                |
| KY App contract → ajv → fast-uri 3.1.3          | root override 固定至 3.1.3，仍有较新公告                               | 修复下界在本次清单中到 3.1.6；若只用于 schema URI 解析，影响与拿该结果建立网络连接不同。升级时验证 schema 引用解析、失败拒绝与 contract 兼容  |
| KY App CLI → hono 4.12.30 / node-server 1.19.14 | 版本命中；包含 CORS/SSR memo/语言中间件以及 Windows 静态路径等不同条件 | 查实际 mock shell/CLI 服务启用的中间件，不将未使用的 memo 直接写成跨用户泄漏。至少更新到本次各公告修复范围并跑 CLI/SDK 契约                   |

urllib 的跨 origin 行为可对照 [维护者公告](https://github.com/node-modules/urllib/security/advisories/GHSA-hq3h-g68c-hp78)。其他版本范围和完整 GHSA 链接见附录。

根 `package.json` 中已经有 axios、form-data、hono、qs 等精确版本 override。这说明团队做过安全响应，但它们是静态快照：某个旧 advisory 修复版可能后来又出现新公告；`name@exact-version` 规则也不会自动匹配将来的其他传递版本。建议每条 override 记录原因、适用 parent、引入时间、移除条件和验证项，并在上游修复后移除过时约束，避免长期积累成难解释的依赖分叉。

## 建议建立的治理流程

已有 pnpm 冻结锁文件安装、包发布年龄约束、有限 install-script allowlist 和工具校验应继续使用。缺口是：当前工作流/根 scripts 没有一个将本次依赖告警自动分配责任、记录接受期限并做回归的审计闭环。

建议设置固定频率的只读 audit 任务，按 runtime/browser/native/build/dev 分组；新出现的高危先判断调用可达性，不把所有 historical 告警一次性升级成永远红的 CI。对已接受风险登记 GHSA、包版本、理由、负责人与到期日。优先让新增直接业务运行时 critical/high 阻断，而让有条件工具链告警产生必须处理的任务。以后再按基线逐步收紧。

每次更新的最小交付物应是：更新前后 lock diff、已关闭和仍存在的 advisory、最终制品/SBOM 中实际版本、对应工作区测试/构建结果和可能改变的运行要求。对 Docker/操作系统/Python/浏览器二进制另做产物扫描；本次 npm audit 没覆盖这些层，不能输出“整套供应链安全”的结论。

后续执行时可使用以下只读入口重新确认；更新命令应在独立分支根据当时版本制定，不在此给一个批量 `--latest` 指令：

```sh
export PATH=/Users/admin/.nvm/versions/node/v22.23.1/bin:$PATH
pnpm audit --json
pnpm audit --prod --json
pnpm why marked
pnpm why urllib
pnpm -F mobile exec expo install --check
```

## 全部审计记录附录

下表来自本次 audit 的 105 条 npm advisory 记录，对应 91 个唯一 GHSA；保留每条 ID，避免把不同受影响版本分支合并丢失。版本为本次 finding；“修复范围”仅是该条公告的范围，升级某个包时需要满足该包全部相关公告并确认兼容性。路径为工具返回的发现路径，不能代替最终产物可达性分析。“prod 分类”按同一个 npm advisory ID 是否出现在 prod 原始结果判断，不按 GHSA 粗粒度推断其他版本分支。未逐条进行攻击复现。

| # / npm ID    | 包名 / GHSA                                                                                                         | 级别     | 本次版本            | 公告修复范围 | prod 分类 | 示例发现路径                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | -------- | ------------------- | ------------ | --------- | ---------------------------------------------------------------------------------------------------------- |
| 1 / 1120422   | shell-quote · [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p)                              | critical | 1.8.3               | >=1.8.4      | 是        | .>concurrently>shell-quote                                                                                 |
| 2 / 1123940   | tar · [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw)                                      | critical | 7.5.7               | >=7.5.19     | 否        | mobile>eas-cli>tar                                                                                         |
| 3 / 1139529   | vitest · [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp)                                   | critical | 4.0.18              | >=4.1.0      | 否        | acs-orchestrator>vitest                                                                                    |
| 4 / 1120258   | @babel/plugin-transform-modules-systemjs · [GHSA-fv7c-fp4j-7gwp](https://github.com/advisories/GHSA-fv7c-fp4j-7gwp) | high     | 7.29.0              | >=7.29.4     | 否        | web>vite-plugin-pwa>workbox-build>@babel/preset-env>@babel/plugin-transform-modules-systemjs               |
| 5 / 1117894   | @xmldom/xmldom · [GHSA-2v35-w6hq-6mfw](https://github.com/advisories/GHSA-2v35-w6hq-6mfw)                           | high     | 0.8.11, 0.7.13      | >=0.8.13     | 是        | .>expo>@expo/cli>@expo/plist>@xmldom/xmldom                                                                |
| 6 / 1117897   | @xmldom/xmldom · [GHSA-f6ww-3ggp-fr8h](https://github.com/advisories/GHSA-f6ww-3ggp-fr8h)                           | high     | 0.8.11, 0.7.13      | >=0.8.13     | 是        | .>expo>@expo/cli>@expo/plist>@xmldom/xmldom                                                                |
| 7 / 1117903   | @xmldom/xmldom · [GHSA-j759-j44w-7fr8](https://github.com/advisories/GHSA-j759-j44w-7fr8)                           | high     | 0.8.11, 0.7.13      | >=0.8.13     | 是        | .>expo>@expo/cli>@expo/plist>@xmldom/xmldom                                                                |
| 8 / 1117097   | @xmldom/xmldom · [GHSA-wh4c-j3r5-mjhp](https://github.com/advisories/GHSA-wh4c-j3r5-mjhp)                           | high     | 0.8.11, 0.7.13      | >=0.8.12     | 是        | .>expo>@expo/cli>@expo/plist>@xmldom/xmldom                                                                |
| 9 / 1117900   | @xmldom/xmldom · [GHSA-x6wf-f3px-wcqx](https://github.com/advisories/GHSA-x6wf-f3px-wcqx)                           | high     | 0.8.11, 0.7.13      | >=0.8.13     | 是        | .>expo>@expo/cli>@expo/plist>@xmldom/xmldom                                                                |
| 10 / 1123896  | brace-expansion · [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp)                          | high     | 2.0.2               | >=2.1.2      | 否        | mobile>eas-cli>@expo/config>glob>minimatch>brace-expansion                                                 |
| 11 / 1123897  | brace-expansion · [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp)                          | high     | 1.1.12              | >=1.1.16     | 是        | .>expo>@expo/cli>@react-native/dev-middleware>chromium-edge-launcher>rimraf>glob>minimatch>brace-expansion |
| 12 / 1123898  | brace-expansion · [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp)                          | high     | 5.0.2               | >=5.0.7      | 否        | .>typescript-eslint>@typescript-eslint/typescript-estree>minimatch>brace-expansion                         |
| 13 / 1130588  | brace-expansion · [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)                          | high     | 1.1.12              | >=1.1.17     | 是        | .>expo>@expo/cli>@react-native/dev-middleware>chromium-edge-launcher>rimraf>glob>minimatch>brace-expansion |
| 14 / 1130589  | brace-expansion · [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)                          | high     | 2.0.2               | >=2.1.3      | 否        | mobile>eas-cli>@expo/config>glob>minimatch>brace-expansion                                                 |
| 15 / 1130591  | brace-expansion · [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)                          | high     | 5.0.2               | >=5.0.8      | 否        | .>typescript-eslint>@typescript-eslint/typescript-estree>minimatch>brace-expansion                         |
| 16 / 1130734  | brace-expansion · [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895)                          | high     | 5.0.2               | >=5.0.9      | 否        | .>typescript-eslint>@typescript-eslint/typescript-estree>minimatch>brace-expansion                         |
| 17 / 1130736  | brace-expansion · [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895)                          | high     | 2.0.2               | >=2.1.4      | 否        | mobile>eas-cli>@expo/config>glob>minimatch>brace-expansion                                                 |
| 18 / 1130737  | brace-expansion · [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895)                          | high     | 1.1.12              | >=1.1.18     | 是        | .>expo>@expo/cli>@react-native/dev-middleware>chromium-edge-launcher>rimraf>glob>minimatch>brace-expansion |
| 19 / 1153172  | browserslist · [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g)                             | high     | 4.28.1              | >=4.28.7     | 是        | .>eslint-plugin-react-hooks>@babel/core>@babel/helper-compilation-targets>browserslist                     |
| 20 / 1153171  | browserslist · [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx)                             | high     | 4.28.1              | >=4.28.7     | 是        | .>eslint-plugin-react-hooks>@babel/core>@babel/helper-compilation-targets>browserslist                     |
| 21 / 1158521  | fast-uri · [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8)                                 | high     | 3.1.3               | >=3.1.6      | 是        | packages__ky-app-contract>ajv>fast-uri                                                                     |
| 22 / 1130720  | fast-uri · [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7)                                 | high     | 3.1.3               | >=3.1.5      | 是        | packages__ky-app-contract>ajv>fast-uri                                                                     |
| 23 / 1158524  | fast-uri · [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc)                                 | high     | 3.1.3               | >=3.1.6      | 是        | packages__ky-app-contract>ajv>fast-uri                                                                     |
| 24 / 1158527  | fast-uri · [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf)                                 | high     | 3.1.3               | >=3.1.6      | 是        | packages__ky-app-contract>ajv>fast-uri                                                                     |
| 25 / 1158530  | fast-uri · [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp)                                 | high     | 3.1.3               | >=3.1.6      | 是        | packages__ky-app-contract>ajv>fast-uri                                                                     |
| 26 / 1124064  | fast-uri · [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx)                                 | high     | 3.1.3               | >=3.1.4      | 是        | packages__ky-app-contract>ajv>fast-uri                                                                     |
| 27 / 1109842  | glob · [GHSA-5j98-mcp5-4vw2](https://github.com/advisories/GHSA-5j98-mcp5-4vw2)                                     | high     | 10.4.5              | >=10.5.0     | 否        | mobile>eas-cli>@expo/config>glob                                                                           |
| 28 / 1130722  | ip-address · [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr)                               | high     | 10.2.0              | >=10.3.1     | 是        | server>@alicloud/sts20150401>@darabonba/typescript>socks-proxy-agent>socks>ip-address                      |
| 29 / 1123911  | js-yaml · [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m)                                  | high     | 4.1.1               | >=4.3.0      | 是        | .>expo>@expo/cli>@expo/xcpretty>js-yaml                                                                    |
| 30 / 1123912  | js-yaml · [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m)                                  | high     | 3.14.2              | >=3.15.0     | 是        | .>react-native>babel-jest>babel-plugin-istanbul>@istanbuljs/load-nyc-config>js-yaml                        |
| 31 / 1138114  | js-yaml · [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj)                                  | high     | 3.14.2              | >=3.15.1     | 是        | .>react-native>babel-jest>babel-plugin-istanbul>@istanbuljs/load-nyc-config>js-yaml                        |
| 32 / 1138115  | js-yaml · [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj)                                  | high     | 4.1.1               | >=4.3.1      | 是        | .>expo>@expo/cli>@expo/xcpretty>js-yaml                                                                    |
| 33 / 1121797  | linkify-it · [GHSA-22p9-wv53-3rq4](https://github.com/advisories/GHSA-22p9-wv53-3rq4)                               | high     | 2.2.0               | >=5.0.1      | 是        | mobile>markdown-it>linkify-it                                                                              |
| 34 / 1124012  | linkify-it · [GHSA-v245-v573-v5vm](https://github.com/advisories/GHSA-v245-v573-v5vm)                               | high     | 2.2.0               | >=5.0.2      | 是        | mobile>markdown-it>linkify-it                                                                              |
| 35 / 1117275  | marked · [GHSA-6v9c-7cg6-27q7](https://github.com/advisories/GHSA-6v9c-7cg6-27q7)                                   | high     | 18.0.0              | >=18.0.2     | 是        | mobile>marked                                                                                              |
| 36 / 1113548  | minimatch · [GHSA-23c5-xmqv-rm74](https://github.com/advisories/GHSA-23c5-xmqv-rm74)                                | high     | 5.1.2               | >=5.1.8      | 否        | mobile>eas-cli>minimatch                                                                                   |
| 37 / 1113461  | minimatch · [GHSA-3ppc-4f35-3m26](https://github.com/advisories/GHSA-3ppc-4f35-3m26)                                | high     | 5.1.2               | >=5.1.7      | 否        | mobile>eas-cli>minimatch                                                                                   |
| 38 / 1113540  | minimatch · [GHSA-7r86-cg39-jmmj](https://github.com/advisories/GHSA-7r86-cg39-jmmj)                                | high     | 5.1.2               | >=5.1.8      | 否        | mobile>eas-cli>minimatch                                                                                   |
| 39 / 1138811  | nanoid · [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv)                                   | high     | 3.3.11, 3.3.8       | >=3.3.16     | 是        | .>expo>@expo/cli>expo-router>nanoid                                                                        |
| 40 / 1139427  | nanoid · [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8)                                   | high     | 3.3.11, 3.3.8       | >=3.3.18     | 是        | .>expo>@expo/cli>expo-router>nanoid                                                                        |
| 41 / 1153189  | nanoid · [GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w)                                   | high     | 3.3.11, 3.3.8       | >=3.3.12     | 是        | .>expo>@expo/cli>expo-router>nanoid                                                                        |
| 42 / 1115545  | node-forge · [GHSA-2328-f5f3-gj25](https://github.com/advisories/GHSA-2328-f5f3-gj25)                               | high     | 1.3.3, 1.3.1        | >=1.4.0      | 是        | .>expo>@expo/cli>node-forge                                                                                |
| 43 / 1110996  | node-forge · [GHSA-554w-wpv2-vw27](https://github.com/advisories/GHSA-554w-wpv2-vw27)                               | high     | 1.3.1               | >=1.3.2      | 否        | mobile>eas-cli>node-forge                                                                                  |
| 44 / 1110998  | node-forge · [GHSA-5gfm-wpxj-wjgq](https://github.com/advisories/GHSA-5gfm-wpxj-wjgq)                               | high     | 1.3.1               | >=1.3.2      | 否        | mobile>eas-cli>node-forge                                                                                  |
| 45 / 1115548  | node-forge · [GHSA-5m6q-g25r-mvwx](https://github.com/advisories/GHSA-5m6q-g25r-mvwx)                               | high     | 1.3.3, 1.3.1        | >=1.4.0      | 是        | .>expo>@expo/cli>node-forge                                                                                |
| 46 / 1115612  | node-forge · [GHSA-ppp5-5v6c-4jwp](https://github.com/advisories/GHSA-ppp5-5v6c-4jwp)                               | high     | 1.3.3, 1.3.1        | >=1.4.0      | 是        | .>expo>@expo/cli>node-forge                                                                                |
| 47 / 1115546  | node-forge · [GHSA-q67f-28xg-22rw](https://github.com/advisories/GHSA-q67f-28xg-22rw)                               | high     | 1.3.3, 1.3.1        | >=1.4.0      | 是        | .>expo>@expo/cli>node-forge                                                                                |
| 48 / 1124252  | postcss · [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q)                                  | high     | 8.5.6               | >=8.5.12     | 是        | web>postcss                                                                                                |
| 49 / 1139510  | postcss · [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849)                                  | high     | 8.5.6               | >=8.5.18     | 是        | web>postcss                                                                                                |
| 50 / 1113515  | rollup · [GHSA-mw96-cpmx-2vgc](https://github.com/advisories/GHSA-mw96-cpmx-2vgc)                                   | high     | 4.57.1              | >=4.59.0     | 否        | acs-orchestrator>vitest>vite>rollup                                                                        |
| 51 / 1113686  | serialize-javascript · [GHSA-5c6j-r48x-rmvq](https://github.com/advisories/GHSA-5c6j-r48x-rmvq)                     | high     | 6.0.2               | >=7.0.3      | 否        | web>vite-plugin-pwa>workbox-build>@rollup/plugin-terser>serialize-javascript                               |
| 52 / 1123944  | shell-quote · [GHSA-395f-4hp3-45gv](https://github.com/advisories/GHSA-395f-4hp3-45gv)                              | high     | 1.8.3               | >=1.9.0      | 是        | .>concurrently>shell-quote                                                                                 |
| 53 / 1113375  | tar · [GHSA-83g3-92jg-28cx](https://github.com/advisories/GHSA-83g3-92jg-28cx)                                      | high     | 7.5.7               | >=7.5.8      | 否        | mobile>eas-cli>tar                                                                                         |
| 54 / 1123941  | tar · [GHSA-8x88-c5mf-7j5w](https://github.com/advisories/GHSA-8x88-c5mf-7j5w)                                      | high     | 7.5.7               | >=7.5.18     | 否        | mobile>eas-cli>tar                                                                                         |
| 55 / 1114302  | tar · [GHSA-9ppj-qmqm-q256](https://github.com/advisories/GHSA-9ppj-qmqm-q256)                                      | high     | 7.5.7               | >=7.5.11     | 否        | mobile>eas-cli>tar                                                                                         |
| 56 / 1114200  | tar · [GHSA-qffp-2rhf-9h96](https://github.com/advisories/GHSA-qffp-2rhf-9h96)                                      | high     | 7.5.7               | >=7.5.10     | 否        | mobile>eas-cli>tar                                                                                         |
| 57 / 1145647  | tar · [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m)                                      | high     | 7.5.7               | >=7.5.21     | 否        | mobile>eas-cli>tar                                                                                         |
| 58 / 1120654  | tmp · [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65)                                      | high     | 0.2.5               | >=0.2.6      | 否        | .>patch-package>tmp                                                                                        |
| 59 / 1145994  | urllib · [GHSA-hq3h-g68c-hp78](https://github.com/advisories/GHSA-hq3h-g68c-hp78)                                   | high     | 2.44.0              | >=2.44.1     | 是        | server>ali-oss>urllib                                                                                      |
| 60 / 1123525  | vite · [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff)                                     | high     | 5.4.21              | >=6.4.3      | 否        | web>vite                                                                                                   |
| 61 / 1123526  | vite · [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff)                                     | high     | 7.3.1               | >=7.3.5      | 否        | acs-orchestrator>vitest>vite                                                                               |
| 62 / 1116235  | vite · [GHSA-p9ff-h696-f583](https://github.com/advisories/GHSA-p9ff-h696-f583)                                     | high     | 7.3.1               | >=7.3.2      | 否        | acs-orchestrator>vitest>vite                                                                               |
| 63 / 1116232  | vite · [GHSA-v2wj-q39q-566r](https://github.com/advisories/GHSA-v2wj-q39q-566r)                                     | high     | 7.3.1               | >=7.3.2      | 否        | acs-orchestrator>vitest>vite                                                                               |
| 64 / 1123260  | ws · [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p)                                       | high     | 7.5.10              | >=7.5.11     | 是        | .>expo>@expo/cli>@react-native/dev-middleware>ws                                                           |
| 65 / 1139322  | @hono/node-server · [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9)                        | moderate | 1.19.14             | >=1.19.15    | 是        | packages__ky-app-cli>@hono/node-server                                                                     |
| 66 / 1158518  | @xmldom/xmldom · [GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6)                           | moderate | 0.8.11, 0.7.13      | >=0.8.15     | 是        | .>expo>@expo/cli>@expo/plist>@xmldom/xmldom                                                                |
| 67 / 1113715  | ajv · [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6)                                      | moderate | 8.11.0              | >=8.18.0     | 否        | mobile>eas-cli>ajv                                                                                         |
| 68 / 1115540  | brace-expansion · [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v)                          | moderate | 1.1.12              | >=1.1.13     | 是        | .>expo>@expo/cli>@react-native/dev-middleware>chromium-edge-launcher>rimraf>glob>minimatch>brace-expansion |
| 69 / 1115541  | brace-expansion · [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v)                          | moderate | 2.0.2               | >=2.0.3      | 否        | mobile>eas-cli>@expo/config>glob>minimatch>brace-expansion                                                 |
| 70 / 1115543  | brace-expansion · [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v)                          | moderate | 5.0.2               | >=5.0.5      | 否        | .>typescript-eslint>@typescript-eslint/typescript-estree>minimatch>brace-expansion                         |
| 71 / 1120311  | brace-expansion · [GHSA-jxxr-4gwj-5jf2](https://github.com/advisories/GHSA-jxxr-4gwj-5jf2)                          | moderate | 5.0.2               | >=5.0.6      | 否        | .>typescript-eslint>@typescript-eslint/typescript-estree>minimatch>brace-expansion                         |
| 72 / 1147955  | decode-uri-component · [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)                     | moderate | 0.2.2               | >=0.5.0      | 是        | .>expo>@expo/cli>expo-router>query-string>decode-uri-component                                             |
| 73 / 1102341  | esbuild · [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)                                  | moderate | 0.21.5              | >=0.25.0     | 否        | web>vite>esbuild                                                                                           |
| 74 / 1138773  | hono · [GHSA-54fx-42gc-7vw4](https://github.com/advisories/GHSA-54fx-42gc-7vw4)                                     | moderate | 4.12.30             | >=4.12.34    | 是        | packages__ky-app-cli>hono                                                                                  |
| 75 / 1130733  | hono · [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239)                                     | moderate | 4.12.30             | >=4.12.34    | 是        | packages__ky-app-cli>hono                                                                                  |
| 76 / 1138771  | hono · [GHSA-f23p-vx2j-j53r](https://github.com/advisories/GHSA-f23p-vx2j-j53r)                                     | moderate | 4.12.30             | >=4.12.34    | 是        | packages__ky-app-cli>hono                                                                                  |
| 77 / 1130724  | ip-address · [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg)                               | moderate | 10.2.0              | >=10.2.1     | 是        | server>@alicloud/sts20150401>@darabonba/typescript>socks-proxy-agent>socks>ip-address                      |
| 78 / 1130723  | ip-address · [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh)                               | moderate | 10.2.0              | >=10.2.2     | 是        | server>@alicloud/sts20150401>@darabonba/typescript>socks-proxy-agent>socks>ip-address                      |
| 79 / 1120656  | joi · [GHSA-q7cg-457f-vx79](https://github.com/advisories/GHSA-q7cg-457f-vx79)                                      | moderate | 17.11.0             | >=17.13.4    | 否        | mobile>eas-cli>joi                                                                                         |
| 80 / 1121859  | js-yaml · [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68)                                  | moderate | 3.14.2              | >=3.15.0     | 是        | .>react-native>babel-jest>babel-plugin-istanbul>@istanbuljs/load-nyc-config>js-yaml                        |
| 81 / 1121860  | js-yaml · [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68)                                  | moderate | 4.1.1               | >=4.2.0      | 是        | .>expo>@expo/cli>@expo/xcpretty>js-yaml                                                                    |
| 82 / 1120820  | markdown-it · [GHSA-6v5v-wf23-fmfq](https://github.com/advisories/GHSA-6v5v-wf23-fmfq)                              | moderate | 10.0.0              | >=14.2.0     | 是        | mobile>markdown-it                                                                                         |
| 83 / 1092663  | markdown-it · [GHSA-6vfc-qv3f-vr6c](https://github.com/advisories/GHSA-6vfc-qv3f-vr6c)                              | moderate | 10.0.0              | >=12.3.2     | 是        | mobile>markdown-it                                                                                         |
| 84 / 1111068  | node-forge · [GHSA-65ch-62r8-g69g](https://github.com/advisories/GHSA-65ch-62r8-g69g)                               | moderate | 1.3.1               | >=1.3.2      | 否        | mobile>eas-cli>node-forge                                                                                  |
| 85 / 1130709  | postcss · [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp)                                  | moderate | 8.5.6               | >=8.5.23     | 是        | web>postcss                                                                                                |
| 86 / 1117015  | postcss · [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93)                                  | moderate | 8.5.6               | >=8.5.10     | 是        | web>postcss                                                                                                |
| 87 / 1158507  | qs · [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)                                       | moderate | 6.15.1, 6.15.3      | >=6.16.0     | 是        | server>@stryker-mutator/core>typed-rest-client>qs                                                          |
| 88 / 1119502  | qs · [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26)                                       | moderate | 6.15.1              | >=6.15.2     | 是        | server>@stryker-mutator/core>typed-rest-client>qs                                                          |
| 89 / 1158506  | qs · [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)                                       | moderate | 6.15.1, 6.15.3      | >=6.16.0     | 是        | server>@stryker-mutator/core>typed-rest-client>qs                                                          |
| 90 / 1119440  | serialize-javascript · [GHSA-qj8w-gfj5-8c6v](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v)                     | moderate | 6.0.2               | >=7.0.5      | 否        | web>vite-plugin-pwa>workbox-build>@rollup/plugin-terser>serialize-javascript                               |
| 91 / 1123942  | tar · [GHSA-gvwx-54wh-qm9j](https://github.com/advisories/GHSA-gvwx-54wh-qm9j)                                      | moderate | 7.5.7               | >=7.5.17     | 否        | mobile>eas-cli>tar                                                                                         |
| 92 / 1120782  | tar · [GHSA-vmf3-w455-68vh](https://github.com/advisories/GHSA-vmf3-w455-68vh)                                      | moderate | 7.5.7               | >=7.5.16     | 否        | mobile>eas-cli>tar                                                                                         |
| 93 / 1123939  | tar · [GHSA-w8wr-v893-vjvp](https://github.com/advisories/GHSA-w8wr-v893-vjvp)                                      | moderate | 7.5.7               | >=7.5.18     | 否        | mobile>eas-cli>tar                                                                                         |
| 94 / 1121318  | ts-deepmerge · [GHSA-87mf-gv2c-c62c](https://github.com/advisories/GHSA-87mf-gv2c-c62c)                             | moderate | 6.2.0               | >=8.0.0      | 否        | mobile>eas-cli>ts-deepmerge                                                                                |
| 95 / 1119441  | uuid · [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)                                     | moderate | 7.0.3, 8.3.2, 9.0.1 | >=11.1.1     | 是        | mobile>eas-cli>@expo/config-plugins>xcode>uuid                                                             |
| 96 / 1116229  | vite · [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9)                                     | moderate | 5.4.21              | >=6.4.2      | 否        | web>vite                                                                                                   |
| 97 / 1116230  | vite · [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9)                                     | moderate | 7.3.1               | >=7.3.2      | 否        | acs-orchestrator>vitest>vite                                                                               |
| 98 / 1120784  | vite · [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3)                                     | moderate | 5.4.21              | >=6.4.3      | 否        | web>vite                                                                                                   |
| 99 / 1120785  | vite · [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3)                                     | moderate | 7.3.1               | >=7.3.5      | 否        | acs-orchestrator>vitest>vite                                                                               |
| 100 / 1115556 | yaml · [GHSA-48c2-rrv3-qjmp](https://github.com/advisories/GHSA-48c2-rrv3-qjmp)                                     | moderate | 2.6.0               | >=2.8.3      | 否        | mobile>eas-cli>yaml                                                                                        |
| 101 / 1123528 | @babel/core · [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8)                              | low      | 7.29.0, 7.28.6      | >=7.29.6     | 是        | .>eslint-plugin-react-hooks>@babel/core                                                                    |
| 102 / 1123976 | body-parser · [GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6)                              | low      | 2.2.2               | >=2.3.0      | 是        | server>@modelcontextprotocol/sdk>express>body-parser                                                       |
| 103 / 1112706 | diff · [GHSA-73rr-hh4g-fpgx](https://github.com/advisories/GHSA-73rr-hh4g-fpgx)                                     | low      | 7.0.0               | >=8.0.3      | 否        | mobile>eas-cli>diff                                                                                        |
| 104 / 1138772 | hono · [GHSA-79qm-7rj5-m7r9](https://github.com/advisories/GHSA-79qm-7rj5-m7r9)                                     | low      | 4.12.30             | >=4.12.34    | 是        | packages__ky-app-cli>hono                                                                                  |
| 105 / 1153170 | postcss-selector-parser · [GHSA-w9m9-85wc-3x92](https://github.com/advisories/GHSA-w9m9-85wc-3x92)                  | low      | 6.1.2               | >=6.1.3      | 是        | web>tailwindcss>postcss-selector-parser                                                                    |
