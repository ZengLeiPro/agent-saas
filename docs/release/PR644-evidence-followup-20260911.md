# PR #644：PR636 交接 v1.2 的证据修复与验收附录

记录日期：2026-09-11。目标仓库：`ZengLeiPro/agent-saas`。

本附录保留原 H01–H08、F01–F16、T01–T18 的编号和边界，不覆盖历史审查、迁移审核或已归档证据。资料依据为用户提供的交接 v1.2、固定提交源码、真实 Actions 记录。项目中长期未维护的 Agent / Claude 指令文档未被读取或用作依据。

## 1. 接续身份与本轮范围

- 继续使用 PR **#644**，分支 `fix/pr636-release-evidence-followup-20260911`，不是新建重复 PR。
- 首次提交：`2950caa1504d229c3aa33831d0ccc8879df7e46b`。其 CI `34590604078` 失败在环境变量数量门禁：`deployment/scripts: 50 names > budget 49`，新增名为 `GITHUB_REPOSITORY`。
- 已修复并与 main `fbd324fccfa23bffb5ec42e6e01f2701e6936b78` 合并验证的提交：`1fd082b013a5766db7f36c4a454fddb9d7b9bf4c`。其 CI **`34596794018` / #3766 已完成且 success**。
- main 中 #643 的 iOS 制品校验与 #645 的生产 #48 恢复修复均保留。没有向 main 直接提交、合并本 PR、部署生产或删除历史。
- 本附录及新增集成测试是在上述绿色提交之后追加；最终验收必须以 **PR 当前 head 对应的新 CI** 为准，不能借用 #3766。最终 head/run/attempt 记录在 PR 验证评论中，避免提交自身 SHA 的循环引用。

静态检查入口是 `scripts/pr-preflight-task.sh checks`。它先执行 ratchet，再执行工作区检查、Release 契约及服务端检查。第一次静态检查提前失败，不能当作后面的 Release 契约已经通过。`package.json` 的 `test:release-contracts` 使用 `scripts/release/*.test.mjs`，包含本 PR 的新增测试；没有删除门禁、扩大预算、添加跳过条件或创建临时 workflow。

## 2. H02：producer、实际文件与消费者闭环

`read-migration-postconditions.mjs` 仅在 expand 时输出 `postconditionsDigest`；none 分支不读取数据库配置、不加载 PG 驱动、不构造连接。写文件前重新解析序列化结果，避免发布非法 JSON。全局 `artifact-lib.mjs` 的 `canonicalJson` 未修改。

`migration-postconditions.mjs` 对 none 也验证 schema、release/Manifest/plan 身份、环境、时间、状态和空检查集；expand 保留摘要绑定、只读事务、命名 SQL 和清理约束。

`verify-staging-promotion-evidence.sh` 下载精确 Staging run/attempt 的 artifact 后，调用 `verify-migration-readback.mjs` 解析并校验实际数据库回读文件。归档证据按成功 attempt 的时间窗与 RC 有效期校验，不用实时回读的五分钟窗口误拒历史证据，也不接受其他 run/attempt、仓库、源码或环境。

CI 修复将 repository 作为第六个显式 CLI 参数，由已有可信 shell 调用方传入。校验器不从环境或待验证文件推断信任边界。真实 CLI 回归同时验证：环境里设置错误仓库仍以正确显式参数为准；缺参、错仓库、非法格式、多余参数一律拒绝，且不输出原始敏感内容。

原坏样本 `scripts/release/fixtures/staging-none-readback.invalid.txt` 原字节保留。SHA-256：`1e8d92c99b3b3492be9b50f3ec231c43833bb0fa190f1fe4bb990fcca433a444`。它仍然非法，这是历史证据，不是待格式化文件。

**兼容性边界：** 收紧预检不会修好旧 artifact。带非法 none 证据的旧 RC 会被失败关闭地拒绝，不能手改历史归档或绕过校验。需要新发布时，应正常生成新 RC 并取得新 Staging 证据；本任务没有自动执行这些生产操作。已完成的 #47 不需要再次晋级。

## 3. H04/F16 与 H08：诊断覆盖及真实 shell 集成

旧收集器按 worker 文件名仅取前八份，但上传脚本实际上每个资源生成一份文件；#47 的 226 个资源因而只进入 32 条事件且未标明截断。

本 PR 改为明确限制目录项、文件数、单文件字节、总字节和输出事件数量，并报告遗漏计数、原因与覆盖状态。文件解析拒绝符号链接、FIFO、超限文件和非法 UTF-8/JSON，不把原始解析内容输出到公共日志。输出预算不足时优先保留非零退出事件，仍明确报告无法保留的数量。

上传 helper 写入原子批次回执和每资源终态。只有批次、资源数、请求阶段和终态一致且覆盖完整，才输出总体分位数；缺失、失败、截断或重复终态不能被解释成完整总体。

新增 `scripts/release/web-asset-diagnostics-integration.test.mjs` 使用真实 Bash 上传池、timeout、gzip、cmp、批次/终态 producer 和真实 collector，只替换远端 I/O：

1. 12 个资源首次上传、第二次 create-only 冲突复用，均完整生成 12 份资源记录和终态；采样总体为 12，不再静默只取八份。
2. 第 13 个资源公共 HEAD 两次超时，前 12 项完成；同一可序列化摘要保留资源名、阶段、attempt 1/2、退出码 124、失败批次和终态；不生成虚假的总体分位数。
3. 两个场景均检查子进程已回收、没有迟到写入，摘要不包含测试凭据。

两项集成测试已在本地 Node 22.16.0 运行通过。用于本地测试的五个生产模块均校验 Git blob 身份，与已推送源码一致。正式工具链仍是仓库固定的 Node 22.23.1 / pnpm 10.18.3，以最终 CI 为准。

这证明本地/CI 的诊断协议，不等同真实 OSS/CDN 故障演练，也不把一个测试摘要称为完整云端 F16 失败验收。

## 4. 原 T01–T18 → 实际断言与剩余范围

下表按行为映射，不按旧测试标题中的 T 编号推断覆盖。每行均保留完整场景尚未验收的边界；自动化通过不等于整行云端风险关闭。路径均相对仓库根目录。

| 原编号 | 对应 F / 当前测试或验证入口 | 实际断言 / 已有基础 | 仍缺少的原场景证明 |
| --- | --- | --- | --- |
| T01 | F07；`scripts/release/runtime-multiprocess-stream-fixture.test.mjs` | observer 在 resume 前安装，检查 session/resume 参数、回放事件、错误及监听器清理 | 发布前 token、真实 HTTP/WS 连接跨 App 切换和事件游标连续性；本轮未做 |
| T02 | F07；同上；`server/scripts/verify-runtime-multiprocess-e2e.mts` | 连续文本前缀/后缀、同一 run、重复文本/错误终态拒绝；模型必须收到首文本 ACK 才结束 | 真实前端连接和跨版本切换的整条场景；不能把 fixture 等同端到端验收 |
| T03 | F07；`server/scripts/verify-runtime-multiprocess-e2e.mts --scenario worker-handoff` | 交接文档指出的双 Worker/可计数工具基础；CI PostgreSQL job 调用此入口 | 工具完成但响应丢失、重试与远端 invocation 交错；本轮没有新增完整断言 |
| T04 | F05；交接文档的 ACS 预算协调/维护等待基础 | 仅保留既有预算机制的交付事实 | 11/19 分钟真实等待、超预算、UI 取消与网络时序未执行；不以短时替身冒充 |
| T05 | F04；`server/src/runtime/runtimeDrainState.test.ts` | rejected quiesce 后 runtimeQuiesced=false、complete=false、failed；超时后迟到完成不得转成功；错误详情不泄露 | 整条真实部署入口的抛错故障注入仍未执行 |
| T06 | F06；`scripts/release/app-retirement-recovery.test.mjs` | 固定 generation；MainPID 改变、子进程、未知任务等拒绝；acknowledgement 不冒充 durable completion | #47 历史旧任务补证、连续两次真实发布与长期任务清单 |
| T07 | F06/F07；双 Worker 验证入口与退役回归 | 保留交接与身份验证基础，不宣称它覆盖所有取消交错 | cancel/deploy/handoff 同时发生、远端取消确认与 late result 的完整时序未验收 |
| T08 | F07；`server/src/runtime/runtimeDrainState.test.ts` | active stream/upload/invocation 任一非零都不得 complete | 真实慢上传、客户端断线、计数释放和 NAS 延迟证明未执行 |
| T09 | F01/F16；`scripts/release/web-asset-diagnostics-integration.test.mjs` | 末尾第 13 资源 HEAD 不返回，两次有界超时、失败摘要与子进程回收；>8 资源正常/复用完整性 | 测试只运行资源 helper，不证明真实 CDN 或 workflow 可变入口从未提前写入 |
| T10 | F02/F13；`scripts/release/web-shell-transaction.test.mjs` | 恢复所有覆盖的 PWA key/metadata，移除新 key，保留 hash asset，index 最后；403/损坏/错 attempt 拒绝 | SDK 替身不能代替真实 OSS/CDN、冷备和已安装 SW 浏览器回退 |
| T11 | F03/F16；`scripts/release/reconcile-safety-regression.test.mjs` | Web 回滚与已提交 ACS 分开，partial_failed；未知副作用/第三种身份保持 needs_human | 全工作流故障注入及仅凭真实失败 artifact 完整恢复说明 |
| T12 | F09；`scripts/release/reliability-contracts.test.mjs` | 实际 publication shell 先补齐 a/b bundle，再提交 index；既有对象冲突拒绝 | 真实 OSS 中断、生产者身份与旧不完整集合的全链路验收 |
| T13 | F11；`scripts/release/production-lock-lease.test.mjs` | 真实子进程竞争互斥；PID/start-time ownership，突停后 stale owner 拒绝 | 三次 Actions 请求排队、旧 RC 迟到和生产/测试跨入口交错 |
| T14 | F10；`scripts/release/evidence-writer-deploy.test.mjs` | Writer 失败候选恢复、同不可变包重试；锁拒绝先于服务 mutation | 该测试替换 flock/systemctl；不是两次真实升级并发、降级/祖先/schema 验收 |
| T15 | F14；`scripts/release/read-rollback-receipt.test.mjs` | ENOENT=absent，EACCES/EIO=unreadable；错身份=invalid；有效=present | I/O 替身不代表普通 sudo SSH 用户真实权限矩阵 |
| T16 | F15；`scripts/release/production-checkpoint.test.mjs`、`scripts/release/reliability-contracts.test.mjs` | 未 completed、篡改/过期观察拒绝；历史基线不冒充当前健康；checkpoint-only 参数准入 | completed 后真实写入失败和只修尾部的幂等工作流未执行 |
| T17 | F02/F06/F08/F16；production-lock、app-retirement-recovery、Web journal 恢复基础 | 本轮核对了 stale owner/固定 generation；原交接已记录跨 runner 恢复基础 | 云端各提交点 runner/SSH 消失、主机重启和跨组件恢复，不是 CI 全绿即可关闭 |
| T18 | F07/H02；`scripts/release/migration-postconditions.pg.test.mjs`、`scripts/release/migration-readback-serialization.test.mjs` | PG 后置条件/只读保护基础；none/expand 实际文件序列化、身份与摘要消费回归 | expand 后新 App 启动失败、旧二进制兼容扩展 schema 的整条故障场景 |

编号纠偏：`reliability-contracts.test.mjs` 中名为 T09 的 index-last 测试对应原 **T12**；名为 T15 的 checkpoint 参数测试对应原 **T16**。`read-rollback-receipt.test.mjs` 中名为 T14 的测试对应原 **T15**。这些旧标题未被当作验收凭证。

F01–F11、F13–F16 的关联已列于上表。**F12** 的引擎兼容性是独立补充：`reliability-contracts.test.mjs` 接受已支持 Manifest 1/2、拒绝未知版本；它虽然标题写 T12，并不覆盖原 T12 的产物中断场景。正常路径证据与未闭风险仍沿用原交接，不计算“16/16 风险归零”。

## 5. H01–H08 状态与本轮跳过项

| 编号 | 本轮处置 | 关闭边界 |
| --- | --- | --- |
| H01 | 保持 #47 正常发布已核实，不重跑 | 历史完成事实，不代表此刻生产状态 |
| H02 | producer/文件/consumer/CLI 修复已在 #644；初次 CI 阻塞已修复 | 最终 CI 通过后为可审查合并；原关闭标准还要求合并，本任务不擅自合并 |
| H03 | 固定 #47 run `34583412982` / attempt 1；不从当前活动色反推旧 generation | 没有取得主机后续私有任务证据；保持 `draining_or_unverified`，不能推断仍有活跃任务或已结清 |
| H04 | 修复诊断覆盖并增加真实 shell 集成；逐项保留上表范围 | 云端/长任务/真实用户连接故障验收在本环境跳过，不标 passed |
| H05 | 保留策略与执行前置条件明确如下；本轮不清理 | 维护方的保留周期、受保护归档和告警渠道尚未确认；不能自定数值并删除 |
| H06 | 重新只读盘点六个 PR636 workbench 分支，均仍存在 | 依赖/活动运行/证据归档及逐项授权未完成；不删除分支或 Actions 历史 |
| H07 | 新增本独立附录，保留编号、实际断言、环境差异、最终 CI 定位方法 | 原历史文档及摘要绑定材料不改写；尚未验收项明确列出 |
| H08 | 完整批次才输出分位数；新增真实 helper 协议回归 | SDK 复用/共享 deadline/hash 预上传按测量延期，不凭旧 32 事件样本作收益结论 |

H03 后续只读取证固定目录：`/var/lib/agent-saas-release-recovery/retirements/34583412982-1/`。需要校验原 targetDigest、进程 generation、任务清单完整性、run/owner/lease、invocation 与取消送达。若旧二进制无法提供完整清单，保留明确证明缺口。禁止强停、删 lease、改终态或重放未知工具。

H05 的后续顺序：只读盘点 web/retirements 两类持久目录和 systemd 观察单元；由维护方确定保留时间/归档位置；带摘要读回验证归档；生成 dry-run 清单；逐项授权后才执行清理并回读。pending、needs_human、未知状态、checkpoint/当前发布/未结清任务引用一律保留。还需证明磁盘/观察超时告警抵达值班渠道。**本 PR 没有把清理器实现或运维上线虚报为完成，也没有将本机持久盘当作异地灾备。**

H06 于本轮通过 GitHub matching-refs 重新查询的分支（没有删除）：

| 分支后缀（前缀 `workbench/pr636-`） | 查询到的 head |
| --- | --- |
| baseline-candidate-34554349550 | `1f824d3b8221013ec1ef4a08533ac88b40f053d0` |
| baseline-repair-20260911 | `d29a4a23e6edea01cb1aaaf191769f2677f01278` |
| candidate-34548844419 | `87c1eb5645529c47938fed9278994c7e513cfc0c` |
| ci-repair-20260911 | `2d0d27cc8fdd79a01565695437a8cfe4be9fb4da` |
| final-34550933566 | `336caa49efc05bf2812816478785f1cf71621c5b` |
| recovery-20260911 | `c268fd401b8f8769feea3fbc3140e3c2f2b31d67` |

此表是 2026-09-11 的只读快照，不是未来可直接执行的删除清单。三个临时 workflow 的 Actions 历史是否已归档/仍注册，仍需单独核对；正式五个入口不应删除。本轮没有新增临时 workflow 或临时分支。

## 6. 可复验命令与最终交付判定

```sh
# 不需要生产凭据；依赖齐备的固定源码 checkout 中执行。
node --test scripts/release/evidence-file.test.mjs \
  scripts/release/migration-readback-serialization.test.mjs \
  scripts/release/staging-deployment-evidence.test.mjs \
  scripts/release/web-asset-diagnostics.test.mjs \
  scripts/release/web-asset-diagnostics-integration.test.mjs

# 正式 CI 固定工具链与锁文件；不得因本地缺依赖改低门禁。
bash scripts/pr-preflight-task.sh checks
# TEST_DATABASE_URL 必须是独立测试数据库，禁止使用生产配置。
bash scripts/pr-preflight-task.sh postgres
```

交付时记录 PR 最终 head、CI run/attempt、总体结论、静态检查及其他实际执行 job 的结果。ACS Impact Gate 的计划性 no-op 不称作执行了全部 ACS 测试；部署 job 的 skipped 不称作已发布。源码和 CI 修复完成与 H03/H04/H05/H06 的真实环境工作分开记账；本环境缺依赖的验证和未获授权的生产/删除操作按用户允许跳过，但不得借此宣布全任务风险归零。
