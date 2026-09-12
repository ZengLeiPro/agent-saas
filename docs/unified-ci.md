# 统一 App / ACS CI

## 入口与兼容边界

`.github/workflows/ci.yml` 的显示名称为 `CI`，是 PR → main 和 push main 的唯一自动 CI 入口。
App 与 ACS 检查仍是独立、可并行查看日志的 job，不合成一个串行大 job。

暂时保留两个 required check 名称：`Build & Check`、`ACS Impact Gate`。
前者现在包含后者的结果；当前 Ruleset 无需修改，历史规则、发布证据字段和制品 workflow 身份不变。
此次不更改 `config/github-main-ruleset.json`，也不修改 GitHub 上的规则或生产环境配置。

长期入口保留 `CI`、`iOS 构建与发布`、`测试环境部署`、`测试环境验收`、`生产环境发布`。
其中 iOS 是独立商店发布链，不改变 App/ACS/RC 四个核心入口的职责。
按维护者决定，`ci.yml` **继续保留原有手动 Web-only 兼容生产发布**：显式确认、main 限制、
production Environment、生产写锁和失败补偿均不变；PR/push 不自动部署生产。
独立 ACS Manual Deploy 已退役，ACS 发布统一使用 Staging 不可变 RC → Production Promotion。
冷备 Web 的 audit/repair 迁入 `生产环境发布` 的互斥操作模式，不能当作 RC repair 使用。
详细迁移和旧注册项收尾见 [Workflow 收敛说明](workflow-consolidation.md)。

## 规划、检查与总门禁

`ci_plan` 同时输出原有 App 计划和 `acs_required`。
PR 通过 `scripts/ci-acs-plan.mjs` 复用 `.github/scripts/acs-classify.sh`，保持原 ACS base/head 比较语义。
`publish` 或 `contract_check` 为 true 时运行 ACS 专项套件；缺失或无效的规划必须失败。
原 repair evidence 的 `server/**`、`acs-orchestrator/**`、专项证据文档和 Workflow 变更也显式覆盖。
这个扩大只影响测试选择，不改变组件发布分类，不会因任意 Server 改动都生成新 ACS 镜像。
纯文档/UI PR 可明确不执行 ACS 套件，但 `ACS Impact Gate` 仍会验证计划并报告 `not_required`。
main push 和人工 CI 一律执行完整 ACS 套件，作为同一提交的权威验证。

Server、DWS、生命周期、准入、Staging/Promotion 和运维脚本专项清单均保留。
完整 Orchestrator Vitest 套件覆盖原 repair regression/primitives 选集；另外显式执行
`acs-orchestrator/src/remote/test_*.py` 的真实 Python 进程测试和 Orchestrator bundle 构建。
`acs-ci-evidence-<sha>-<run>-<attempt>` 保存实际 checkout SHA、PR head（单独字段）、工具链、
源码/锁文件/构建摘要、JSON 测试结果和日志，成功失败均保留 14 天。PR 使用 CI 的 merge checkout，
不能把该结果误标为只测 head。原 ratchets 已由 preflight 执行，不再重复跑一遍。
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

`Build & Check`、`ACS Impact Gate` 及现有 Ruleset 不变。清单校验同时进入预检与发布契约测试，
新增长期 Workflow 必须显式修改 `config/github-workflow-inventory.json` 并经过评审。
main 的绿色 CI 后自动停用清单中十一个旧注册项；不取消运行、不删除历史 run/artifact、RC 或旧证据。
保留的 CI 手动兼容发布不属于退役范围。
