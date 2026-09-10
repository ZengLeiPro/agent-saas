# 平台管理配置受控保存验证说明

验证分别记录 `local_pass`、`ci_pass`、`not_run` 和 `production_not_accepted`。根 `pnpm build` 只证明 Web，不作为 Server 工件证据。

最低集合：scope 负向测试；路由版本/确认/DELETE header；production rig 的旧版本、未确认、越 scope、双端回执、重启与回滚；生图、STT、环境池、Codex 真实 selector；多 Secret 失败、committed 响应丢失；Codex GET 只读、complete、新 ref 重授权、排序/删除和自动刷新后的 credentialVersionDigest。

正式命令：`pnpm typecheck`、受影响 `vitest run`、`pnpm build`、Server 发布包验证和 APP/ACS CI。macOS 上依赖 Linux `/proc` 的全量 Server 失败应标为环境限制并交 Linux CI，不能记为通过。

本地执行记录（2026-09-10）：server/shared/web typecheck 为 `local_pass`；shared 全量 1880 tests 为 `local_pass`；平台配置相关 Server 路由、consumer、operation journal 和 Codex 并发定向集合为 `local_pass`；Web 八个配置界面及不确定结果查询定向集合为 `local_pass`；`pnpm --filter server build` 与 `pnpm --filter web build` 均为 `local_pass`。`productionModelPublication.test.ts` 在 macOS 因仓库 Linux 身份实现读取 `/proc/<pid>/stat` 而 21 个用例均未进入场景体，记为 `not_run_environment`，必须由 Linux CI 复核，不能记为产品失败或通过。CI 和 release checks 在最后提交后更新；生产部署与业务验收始终为 `production_not_accepted`。

`TEST_DATABASE_URL=postgres://postgres:***@127.0.0.1:5432/agent_saas_test pnpm preflight:pr` 已执行：ratchet 41 tests、max-lines/env-var 门禁及前置 package checks 通过；随后 release-contract 全量集合在 macOS 出现 69 项平台环境失败（主要为缺少 Linux `flock`、`/proc`、`/dev/full` 权限及 `/usr/bin/cp`/`ln` 路径差异），因此整体记录为 `not_run_environment`，并未继续伪报后续 coverage/postgres/web 分片通过。最终 Linux CI 必须以最后 head 重跑完整门禁。
