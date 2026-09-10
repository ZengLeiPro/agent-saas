# 平台管理配置受控保存验证说明

验证分别记录 `local_pass`、`ci_pass`、`not_run` 和 `production_not_accepted`。根 `pnpm build` 只证明 Web，不作为 Server 工件证据。

最低集合：scope 负向测试；路由版本/确认/DELETE header；production rig 的旧版本、未确认、越 scope、双端回执、重启与回滚；生图、STT、环境池、Codex 真实 selector；多 Secret 失败、committed 响应丢失；Codex GET 只读、complete、新 ref 重授权、排序/删除和自动刷新后的 credentialVersionDigest。

正式命令：`pnpm typecheck`、受影响 `vitest run`、`pnpm build`、Server 发布包验证和 APP/ACS CI。macOS 上依赖 Linux `/proc` 的全量 Server 失败应标为环境限制并交 Linux CI，不能记为通过。
