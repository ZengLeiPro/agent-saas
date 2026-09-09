# 统一 App / ACS CI

## 入口与兼容边界

`.github/workflows/ci.yml` 的显示名称为 `CI`，是 PR → main 和 push main 的唯一自动 CI 入口。
App 与 ACS 检查仍是独立、可并行查看日志的 job，不合成一个串行大 job。

暂时保留两个 required check 名称：`Build & Check`、`ACS Impact Gate`。
前者现在包含后者的结果；当前 Ruleset 无需修改，历史规则、发布证据字段和制品 workflow 身份不变。
此次不更改 `config/github-main-ruleset.json`，也不修改 GitHub 上的规则或生产环境配置。

本次是自动 CI 合并，不是生产发布流程重写。`ci.yml` 仍保留已有的手动 Web-only 兼容发布；
`acs-sandbox.yml` 改名为 `ACS Manual Deploy`，只保留 `workflow_dispatch` 人工兼容发布。
两者的生产部署 job 正文、production Environment、生产写锁、drain 和回滚逻辑保持原样。
测试环境部署和 Production Promotion 继续独立，不会因 PR/push CI 成功而自动触发生产部署。

## 规划、检查与总门禁

`ci_plan` 同时输出原有 App 计划和 `acs_required`。
PR 通过 `scripts/ci-acs-plan.mjs` 复用 `.github/scripts/acs-classify.sh`，保持原 ACS base/head 比较语义。
`publish` 或 `contract_check` 为 true 时，只运行一次 ACS 专项套件；缺失或无效的规划必须失败。
纯文档/UI PR 可明确不执行 ACS 套件，但 `ACS Impact Gate` 仍会验证计划并报告 `not_required`。
main push 和人工 CI 一律执行完整 ACS 套件，作为同一提交的权威验证。

Server、DWS、生命周期、准入、Staging/Promotion 和运维脚本专项清单均保留。
`Build & Check` 使用 `always()` 汇总所有应运行的门禁；ACS 失败、取消或意外跳过都不能通过。
App 原有受影响测试、分片、覆盖率和真实发布包验证保持不变。
覆盖率报告继续遵循原有非阻断策略，本次不改变该策略。

## 发布证据与制品身份

Staging 仍只信任 `.github/workflows/ci.yml` 的同一 SHA、main push、成功运行。
它不再寻找独立 ACS workflow run，而是分页读取同一 CI run 的 `filter=latest` jobs，
要求 `Build & Check` 与 `ACS Impact Gate` 各有且只有一个成功 job。

`scripts/release/unified-ci-evidence.mjs` 校验 repository、完整 SHA、workflow path/ID、event、branch、
run ID、分页完整性、job 身份与结果，并在收集 jobs 后回读 run，拒绝收集期间发生的新 attempt。
仅重跑失败 job 时允许 GitHub latest 视图保留此前成功的 job，但不能接受未来 attempt、失败、取消或跳过。

现有 `appCi`、`acsImpact` 字段与 `Build & Check` / `ACS Impact Gate` 证据名称保持不变，
新证据的两个 `runId` 指向同一个 CI run。历史不可变 RC/证据不改写；生产者 workflow 仍为 `ci.yml`，
发布包命名、run/attempt 绑定和七天保留策略不变。运行 ACS 测试不意味着必须发布新 ACS 镜像。

## 验证与后续操作

专项回归包含真实 ACS 分类、总门禁 shell 的失败/取消/跳过分支、分页和错误来源拒绝、
CI 重跑证据、已有 ACS workflow 契约，以及 Staging 的新证据消费契约。
新增 `scripts/release/unified-ci*.test.mjs` 自动进入既有 `pnpm test:release-contracts`。

合并并确认 main CI / Staging 正常后，才另行决定是否让 Ruleset 只要求 `Build & Check`，
以及是否进一步独立 Web-only 人工发布入口。不得先删 required check，也不得为清理重复测试而削弱 ACS 专项覆盖。
