# Workflow 入口收敛（2026-09-10）

## 目标与明确保留项

长期保留五个受审入口；原 App/ACS/RC 四个入口保持不变，另加入独立 iOS 商店发布入口：

| 名称           | 文件                                       | 边界                                                         |
| -------------- | ------------------------------------------ | ------------------------------------------------------------ |
| CI             | `.github/workflows/ci.yml`                 | PR/main 检查、制品；**继续保留原手动 Web-only 兼容生产发布** |
| iOS 构建与发布 | `.github/workflows/mobile-ios-release.yml` | 手动构建签名 IPA、送审及审核通过后自动发布                   |
| 测试环境部署   | `.github/workflows/deploy-staging.yml`     | 手动准备不可变 RC、部署 Staging、确定性门禁                  |
| 测试环境验收   | `.github/workflows/staging-acceptance.yml` | 手动、可选浏览器与 Agent 验收                                |
| 生产环境发布   | `.github/workflows/promote-release.yml`    | 手动晋级 RC；互斥模式审计或修复 Web 冷备                     |

不改变 main Ruleset 的 `Build & Check` / `ACS Impact Gate`、RC 身份、制品命名与证据校验，
不把测试环境部署改为自动，也不把可选验收变成生产必经门禁。保留 CI 的
`web_only_compatibility` 确认参数、main 限制、production Environment、主机锁、范围校验和失败补偿。
这不是开放 Server/API/Worker/ACS 的兼容直发。

## 六个退役入口及替代

`config/github-workflow-inventory.json` 记录本次 GitHub 实际盘点的 ID、路径和名称：

| 退役入口                         | 替代                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| ACS Manual Deploy                | ACS 通过 Staging 不可变 RC → Production Promotion                      |
| ACS remote Python contracts      | CI / ACS Impact Gate 显式执行真实 Python 远程进程测试                  |
| ACS repair evidence              | CI 完整 Orchestrator 回归 + 构建 + 结构化证据；ratchets 复用 preflight |
| Production Web Recovery Repair   | 生产环境发布的 web-recovery-audit / web-recovery-repair                |
| ACS isolated branch authoring    | 无长期替代；主分支已经没有该文件，停用历史注册项                       |
| Prepare unified CI (branch-only) | 无长期替代；主分支已经没有该文件，停用历史注册项                       |

旧文件存在性测试已迁移到真实 CI/RC 调用链；原有底层 rollback、不可变镜像来源、分页、
完整 SHA、digest、发布锁及身份回读的测试继续保留。历史审计材料和拒绝旧证据来源的负向测试
可以保留旧名称，不要求全仓搜索为零。ACS 镜像构建、云端 webhook、共享部署脚本、Secret、
Environment、生产服务和正在进行的其他开发分支不在本次删除范围内。

## 恢复操作的用法

普通 RC 晋级：`operation=promote`（默认）、有效 `release_id`、操作原因；RC 的
`recovery_mode=normal/repair` 语义不变。旧 API 调用不传 operation 时仍按 promote 处理。

冷备审计：`operation=web-recovery-audit`、原因；RC ID 留空，recovery_mode 保持 normal，
不传 planDigest，不勾选确认。审计完成不表示基线一致，必须审阅 JSON 报告。

冷备修复：先审阅上述审计报告，再选 `operation=web-recovery-repair`，填入完整
`expected_plan_digest=sha256:...`，勾选 `confirm_recovery_only` 并填写原因。运行时会重新
读回基线，过期计划必须失败。只修复冷备，不修改 OSS、DNS、API 或 trusted identity。

无生产凭据的 dispatch job 先校验模式及参数，拒绝无效、非 main、混用 RC/冷备参数的调用；
之后 promote 与 web_recovery 两个 job 互斥。两者分别绑定 production Environment，
恢复 job 的 GITHUB_TOKEN 限制为 contents:read，不继承 RC 发布的写权限。

## 合并后的注册项清理

PR 不修改 main，不提前停用仍在 main 使用的旧生产/检查入口。
合并后，通过 `Build & Check` 的 main push CI 执行 `retire_legacy_workflows`：

1. 验证本次源码确实只含允许的五个入口，核对当前 main 仍等于本次 SHA；落后的 main CI 延后给新 CI 处理。
2. 分页读取 GitHub 注册项；保留项必须仍 active；待退役项 ID、路径、名称全部匹配才允许停用。
3. 仅调用六个已知旧项的 disable API，然后逐项读回 disabled_manually。记录缺失/已停用时幂等跳过，未知或改名的身份不擅自修改。
4. 不取消在途运行，不删除 workflow run、artifact、Release、RC tag、旧证据或任何别人的分支。

该 job 只拥有 contents:read 与 actions:write，不读取生产 Secrets、不部署。
清单漂移/API 拒绝/读回失败会明确失败，修复后可重跑；不伪报注册项已清理。
历史已停用条目可能继续在 Actions 的历史筛选中显示；“五个活动入口”不等于抹掉审计历史。
需要物理删除历史 run 时必须另外审查 RC/事故证据引用，不能用批量删除隐藏结果。

## 回归与维护

- `node scripts/release/workflow-inventory.mjs`：文件、名称、重复/缺失和额外入口检查。
- `pnpm test:release-contracts`：包括操作互斥/确认/摘要拒绝、退役 API 幂等及漂移、CI 兼容入口保留和发布安全回归。
- CI 的完整 Orchestrator 测试、Python 原生进程测试、真实 bundle 构建均为硬门禁；证据上传不会覆盖失败结论。
- 新增长期工作流必须显式评审并更新清单，不能无意间重新引入临时修复或 authoring 入口。

PR 通过 CI 仅证明代码与自动化回归通过，不等于已经部署 Staging、发布生产或执行了线上冷备修复。
