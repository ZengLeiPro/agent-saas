# PR711 rg stdin / 省略路径无结构变更审核

## 审核范围

- 基线：`88aff8480f0cbe783c2e2728de2140e321c66eda`（本 PR 相对 `origin/main`）。
- `server/src/agent/shellReadOnlyPolicy.ts`：只读 `rg` 白名单。
- `server/src/agent/localShellExecution.ts`：本机/ACS 前台 Shell spawn。

## 结论

两文件均分类为 `no-schema-change`。本批只改变 Agent Shell 如何执行 `rg`：spawn 不再把打开的 pipe 当作 stdin，省略路径的 `rg --no-config -n` 在 argv 上补 `.`。没有新增、修改或删除 SQL、DDL、迁移版本、启动建表、数据库后置条件、数据回填或数据删除。

- `shellReadOnlyPolicy.ts`：`-n` 省略路径与 `--files` 对齐为可证明只读；返回的 argv 强制追加 `.`。不执行 SQL，不改变任何持久化形状。
- `localShellExecution.ts`：`stdio` 的 stdin 从默认 pipe 改为 `ignore`。输出捕获、超时杀进程组、落盘 spill 路径不变。

本批没有 `DROP`、`TRUNCATE`、列改名、类型收窄、约束收紧或历史数据重写；不需要 contract 或 expand 发布。

## 验证证据

- `server/src/agent/shellReadOnlyPolicy.test.ts`：省略路径进入白名单，argv 以 `.` 结尾；子目录 path、`--hidden`、管道等仍拒绝。
- `server/src/agent/localShellExecution.test.ts`：stdin 关闭后命令读到 EOF，不再挂在打开的 pipe 上。
- `server/src/__tests__/toolRuntimeWorkspaceIo.test.ts`：省略路径的 `-n` 仍走 argv 直执。

源码摘要、基线摘要和本文摘要逐条绑定在 `config/release-migration-reviews.json`。任一受审源码或证据发生字节变化都必须重新审核。本文只记录源码与数据库结构判断，不代表生产已经发布。
