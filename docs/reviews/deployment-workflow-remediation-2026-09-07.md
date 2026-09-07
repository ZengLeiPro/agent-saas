# 部署工作流审查问题修复说明

本次修复对应审查报告 D-01～D-05。原报告随 PR #552 交付；#552 修复的是旧、新 Hand 登记冲突和会话环境误展示。本 PR 独立处理部署机制，不包含 #552 的代码，不合并或部署任何 PR。

| 编号 | 修复后的行为                                                                                                                                                      | 故障验证                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| D-01 | 旧进程 PID 必须与 systemd MainPID 一致，发送交接信号后最多等待 15 秒，确认旧进程写出 drain 状态或已正常退出。交接失败返回失败，保留已提交的新版本与旧任务供核查。 | 缺 PID、PID 不同、信号失败、未处理信号均失败；有长任务但已确认 drain 时立即通过，不等待任务跑完。 |
| D-02 | 同一个 run 在 staging_deployed/verified 后重跑，复用历史凭证绑定的 GitHub deployment ID；重新校验 RC、SHA、run 身份，并更新该 deployment 的状态。                 | built 阶段重试可新建；deployed/verified 阶段重试保持绑定；跨 run、跨 RC、晋级后的重部署被拒绝。   |
| D-03 | 每项 expand 必须提供与文件前后版本绑定的只读数据库后置条件，Staging 实际执行，Production 在主机锁内读回两次后才可确认完成。                                       | 真实 PostgreSQL 中缺表、字段类型错误、缺少索引、回填未完成均阻断；多语句和数据写入被数据库拒绝。  |
| D-04 | 部署前、结束时记录实际 API/Worker/Web/ACS 身份；明确显示目标运行版本、原运行版本、混合版本或未知。失败后保留实际状态，禁止业务验收，必须完整重部署恢复。          | 后端先更新、Web 未更新、进程身份无法读取、校验失败均不能验收；回滚命令失败有明确错误及恢复记录。  |
| D-05 | 经真实域名读取不带缓存绕过参数的首页与产物中的所有 JS/CSS，逐字节比较，记录缓存响应头。                                                                           | 本地真实 HTTP 返回旧 HTML、缺 JS、错误 JS 均阻断；目标产物全部一致才通过。                        |

## 迁移作者需要增加的内容

在 `config/release-migration-postconditions.json` 中登记本次 expand 所涉及的文件。每项包含 `path`、`baselineDigest`（新增文件为 null）、`targetDigest`、`checks`。两个 digest 都是对应源码内容的 SHA-256；代码改变后不能沿用旧检查。

每个 check 包含全局唯一 `id`、说明 `description`、数据库配置对象的 `configPath`、查询 `sql` 和参数数组 `params`。`configPath` 如 `runtimeEventStore`，指向具有 `connectionString` 的配置对象。参数值 `$tablePrefix` 由执行环境的实际配置替换，不通过字符串拼接生成 SQL。

例如检查本次增加的整数列：

```json
{
  "id": "example-count-column",
  "description": "检查新增 count 列已经存在且类型为 integer",
  "configPath": "runtimeEventStore",
  "sql": "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($1 || '_example') AND attname='count' AND atttypid='integer'::regtype AND NOT attisdropped) AS ok",
  "params": ["$tablePrefix"]
}
```

每条查询必须且只能返回一行 `ok=true`。执行器使用具名扩展查询和 READ ONLY 事务，设置连接默认只读、15 秒语句超时、5 秒锁等待上限，不启动应用，不自动补执行迁移。不要使用无条件 `SELECT true` 作为真实迁移验证。根据变更内容检查字段定义、约束、索引 `indisvalid/indisready`、迁移记录及回填统计；租户数据变更需要在 SQL 中明确覆盖全部受影响租户，不能只抽查一个租户。

检查集合及其摘要进入 Manifest 和 migration plan digest；证据绑定 RC、Manifest、计划摘要、实际数据库名称与目标摘要。只输出检查状态和数据库身份，不输出业务数据、连接口令或完整进程环境。生产两次读回比较时只忽略采集时间，不能忽略数据库目标或检查结果变化。

当前目录初始为空：本 PR 不引入业务 schema 迁移。后续有 expand 时缺少任何文件的检查会在生成计划时阻断。历史 RC 若包含 expand 却没有这些检查，也会在正式部署前被拒绝，需要重新审核并生成新 RC；历史已完成凭证仍可读取，不修改历史 Manifest。

CI 的历史审核清单检查只核对各历史基线的源码迁移分类，继续阻断未审核、摘要失效和破坏性操作；缺少后置条件会单独报告，计划的 `ok` 仍为 false。它不代表这些历史升级路径已经具备发布条件。真正创建 RC 使用选定的实际生产基线，必须补齐该基线所需的数据库检查，不能用历史清单检查结果替代发布门禁。

## 测试环境失败处理与验收

后端已提交后发生 Web 或隔离校验失败，不自动强行回滚数据库和长任务。最终对账报告上传到 Staging evidence artifact，工作流状态为失败。报告中的 `previous_runtime` 只描述运行组件身份，不宣称数据库和业务数据已经回滚。

业务验收另外检查最近一次实际部署 attempt 必须成功，并匹配要求验收的 RC。依据 deployment **状态产生时间**排序，支持旧 deployment ID 的重试；不根据 deployment 的创建顺序猜当前版本。GitHub deployment 可以累积多个状态，见 [GitHub 官方状态说明](https://docs.github.com/en/rest/deployments/statuses)。证据上传、SSH 授权回收等收尾步骤失败也会进入最终失败状态。

若发生进程恢复失败，主机原有 rollback 目录保留备份和 `recovery-status.json`，结果为 `needs_human`。通过完整重部署和最终核验恢复，不能把未知状态说成“已恢复”。

## 验证范围与上线顺序

回归测试包括实际 shell 函数的受控故障注入、真实本地 PostgreSQL、真实本地 HTTP，以及既有发布契约。没有执行云端 workflow dispatch、生产数据库操作或实际 systemd 进程交接，也未做生产业务验收。

合并后先在测试环境验证正常发布与同 RC 重试，再进行允许范围内的中断恢复演练。正式发布继续使用人工触发和既有生产互斥，不新增自动部署入口。D-01 复用现有进程写出的 drain JSON，因此不要求先单独部署新的进程信号实现。

公网页面字节检查覆盖网络分发路径；不能证明所有用户浏览器里已经安装的 Service Worker 缓存都刷新，也不替代完整浏览器业务验收。
