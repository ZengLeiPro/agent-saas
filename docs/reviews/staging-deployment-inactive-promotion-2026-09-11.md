# Staging Deployment inactive 与生产晋级证据

## 事故与边界

生产运行 `34501244107` / Job `102952344900` 在写入生产前失败。
RC `rc-20260910-113` 的 Deployment `6375802051` 先在
`2026-09-10T16:08:17Z` 成功，后在 `16:10:14Z` 被标记为 inactive。
原门禁只比较最新状态是否为 success，因而在 `16:19:12Z` 拒绝了晋级。
此变更不触发生产发布，不修改历史状态、RC 清单或已有证明，也不恢复之前的部分生产发布。
inactive 的具体写入者尚未确认，本修复不声称已确定其来源。

## 策略

GitHub Deployment 的活跃状态不等同于不可变 RC 的验收资格。
采用历史验收资格策略：在既有 RC 有效期内，允许经过同一精确运行次数验证、仅随后失活的部署。
不要求它继续占用 Staging，不以 inactive 作为撤销信号。
显式撤销应写入 Deployment failure/error 或通过既有 RC 证明拒绝流程执行；
禁止通过把 Deployment 刷回 success 来恢复资格。

安全条件必须同时满足：

- Deployment 的 id、environment、SHA、RC ID、manifestDigest、stagingRunId 必须与证明一致。
- 从已有 `staging:<run>:<attempt>` 和 `deterministic:<run>:<attempt>` 操作键解析验收次数。
  新记录也显式写入 stagingRunAttempt。两种绑定不一致时拒绝，绝不从最新运行次数猜测。
- 查询对应 `/actions/runs/<run>/attempts/<attempt>`；仓库、来源仓库、main 分支、SHA、
  workflow_dispatch 事件、deploy-staging.yml 路径、运行次数和成功完成状态全部匹配。
- 最新运行也必须仍是该次成功验收。出现更新的 attempt，无论成功、失败或正在运行，都拒绝旧证明，
  要求重新生成并验证新的 RC，不能混用旧 attestation 与新 smoke artifact。
- 使用完整分页的状态历史。成功状态必须发生在 verified 之后、同次已完成运行的时间窗口内。
  成功之后只允许 inactive；failure/error、排队、运行中、未知状态或另一次 success 均不复用旧资格。
  verified 后的失败不能被再补一条 success 擦除。
- 新 success 状态带精确 run/attempt 的 log_url；若已有记录提供了链接则必须匹配。
  RC113 等旧记录的空链接不被伪造，而以相同运行次数、证明时间与成功记录交叉绑定。
- core smoke 必须来自该 run 下精确命名的 artifact，验证原有摘要、四项检查、身份及 24 小时时效。
  缺失、过期、跨运行次数、摘要错误均失败关闭，不延长 RC 有效期。
- 下载 smoke 后重新读取 Deployment、分页状态及运行详情，再次检查，缩小并发重跑窗口。
  这不是跨系统事务锁，不声称能阻止复核完成后任意外部写入。

API 未提供“inactive 是否自动产生”的可靠布尔字段。
报告保留原始状态历史并写入 `inactivityOrigin: not-inferred`，不按 creator/description 猜测来源。
允许与否基于上述完整条件及明确的生命周期策略，不是简单允许所有 inactive，
也不是历史中只要出现过任意 success 就放行。

## 实现

`staging-deployment-evidence.mjs` 提供可离线测试的绑定与状态验证，以及结构化诊断。
`verify-staging-promotion-evidence.sh` 只执行有时限的 GitHub GET、精确 artifact 下载和本地校验。
它不创建部署状态，不修改 Release 证明，也不连接生产主机。

生产 workflow 保留原来的 runtime summary、八项确定性门禁、人工批准、
迁移计划、生产基线、互斥锁及 Web 不可变资源校验。批准记录增加验收次数和部署证据摘要/明细。
本次修复不新增表单参数，不修改 normal/repair 的意义。

## 排障证据

生产证据 artifact 新增 `staging-promotion-preflight/`，包含：

- binding.json 与 report.json：RC、绑定次数、成功状态 ID、生命周期状态、时间及判定结果。
- Deployment、完整分页状态、精确 attempt、最新 run 的初次与复核快照。
- 同一 run/attempt 的 core smoke 与下载的 Staging 证据。

早于 approval 的拒绝也会写入 report.json；不会伪造一条 failed_before_change 证明，
将“RC 验收资格”与“某次晋级尝试的失败”分开。
网络查询失败、超时和下载失败保留检查阶段与退出码，不输出凭据或完整命令。
已有 verified 不因这次基础设施查询失败被撤销。

`metadata_verified` 仅表示部署元数据核对通过；只有 smoke 验证和最终复核通过才产生 `passed`。
`passed` 仅表示此处门禁通过，不表示生产发布完成。

## 回归验证

新增测试覆盖 success/inactive、从未成功、成功后失败/重新排队、失败后补成功、
跨 RC/SHA/摘要/仓库/次数、生产环境误绑定、过期 RC、缺失/重复/未知/未来状态、
成功记录位于第二页、分页失败、下载失败、smoke 次数错误、下载期间重跑和早期失败报告。
真实 Bash 编排使用假的 GitHub 可执行程序和真实验证器，不依赖生产凭据；并断言不会进行写 API 调用。

运行 `node --test scripts/release/staging-deployment-evidence.test.mjs` 和
`pnpm test:release-contracts`，随后检查 PR 最新提交的完整 CI。

## 官方语义参考

- [Deployment statuses 与 auto_inactive](https://docs.github.com/en/rest/deployments/statuses)
- [精确 workflow run attempt](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt)

`auto_inactive=false` 控制本次状态更新对其他部署的影响，并非当前 Deployment 永远不被失活的保护开关。
