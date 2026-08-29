# Admin Runner：随 release 交付的一次性运维脚本

## 1. 问题与方案

migration / backfill / repair / maintenance 类一次性运维脚本（`server/scripts/*.mts`、`server/src/scripts/*.mts`）大多自带 dry-run、幂等与写入门禁，但历史上它们只在源码检出里可运行：

- 生产 release 用 `pnpm --prod deploy` 交付依赖，`tsx` 属于 devDependency，生产环境没有；
- release bundle 主要只交付 `dist/index.js`，脚本源码不随包交付。

结果是脚本"在同一代码库里"，却不满足**使用同一 release、依赖和配置运行**。现在：

- `pnpm -F server build` 在构建 `dist/index.js` 的同时，把受控清单中的运维脚本用 esbuild
  预编译到 `server/dist/admin/<command>.mjs`（`--packages=external`，与 `dist/index.js`
  的外部化策略一致）。运行时直接用该 release 的 prod `node_modules` 解析 `pg` 等依赖，
  不需要 `tsx`，也不需要源码检出。
- `server/dist/admin/manifest.json` 记录每个入口的源文件、sha256 与 size。
- `scripts/release/build-release.mjs` 出包时 fail-closed 校验：manifest 必须存在、命令集
  必须与 `ADMIN_RUNNER_ENTRIES` 受控清单一致、每个入口字节摘要必须与 manifest 一致；
  任一失败直接拒绝出 release。
- 安装侧 `verify-installed-release.mjs` 的 contentDigest 对 `server/` 全目录（含
  `dist/admin`）逐文件取证，Admin Runner 与 `dist/index.js` 一起被密封/校验。

## 2. 命令清单

| command                            | 源脚本                                                | dev 等价命令                                          | 默认模式                                 |
| ---------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| `migrate-events-file-to-pg`        | `server/scripts/migrate-events-file-to-pg.mts`        | `pnpm -C server run migrate:events-file-to-pg`        | dry-run；`--execute` 写入                |
| `migrate-platform-tenant-pantheon` | `server/scripts/migrate-platform-tenant-pantheon.mts` | `pnpm -C server run migrate:platform-tenant-pantheon` | dry-run；`--apply` 写入                  |
| `backfill-runtime-sessions`        | `server/scripts/backfill-runtime-sessions.mts`        | `pnpm -C server run backfill:runtime-sessions`        | dry-run；`--execute` 写入                |
| `repair-runtime-session-statuses`  | `server/scripts/repair-runtime-session-statuses.mts`  | `pnpm -C server run repair:runtime-session-statuses`  | dry-run；`--execute` 幂等修复            |
| `repair-taskboard-workflow`        | `server/scripts/repairTaskboardWorkflow.ts`           | `pnpm -C server run repair:taskboard-workflow`        | dry-run；`--apply` 写入                  |
| `runtime-events-maintenance`       | `server/src/scripts/runtime-events-maintenance.mts`   | `pnpm -C server maintenance:runtime-events`           | 严格只读；写操作需 `--authorization-ref` |
| `context-derived-replay`           | `server/scripts/context-derived-replay.mts`           | `pnpm -C server run context:derived-replay`           | dry-run；`--apply` 写入                  |

参数语义与 dev 命令完全一致，dev 侧文档（如
[`runtime-eventstore-retention-runbook.md`](runtime-eventstore-retention-runbook.md)）继续有效。

## 3. 生产运行方式

与 systemd `agent-saas-server@<color>` 使用相同的代码、依赖、配置与环境变量：

```bash
active="$(tr -d '[:space:]' </etc/agent-saas/active-color)"
release="/opt/agent-saas-app/color/$active/server"

set -a
. /etc/agent-saas/server.env
. "/etc/agent-saas/server-$active.env"
[ -f "/etc/agent-saas/server-$active.release.env" ] && \
  . "/etc/agent-saas/server-$active.release.env"
set +a
export NODE_ENV=production
export AGENT_SAAS_CONFIG_PATH=/etc/agent-saas/config.json

cd "$release"
node dist/admin/<command>.mjs …   # 先 dry-run，再按各脚本门禁显式授权写入
```

要点：

- `AGENT_SAAS_CONFIG_PATH` 与 systemd unit 一致，`loadAppConfig` 类脚本
  （backfill / runtime-events-maintenance）读到的是与线上 server 同一份配置。
- `migrate-platform-tenant-pantheon` 的 `--data-dir/--config-dir/--workspace-shared`
  默认值已适配 release 布局（`<release>/server/data`、`<release>/server/config`、
  `<release>/workspace-shared`），通常无需显式传路径；仍可显式覆盖。
- Node 用系统 `/usr/bin/node`（与 systemd `ExecStart` 同一运行时），版本 >= 22。
- Staging 环境代码在 `/opt/agent-saas-staging/current/server`，working directory 是
  `/mnt/agent-saas-staging/runtime/server`，按同样方式替换路径即可。

## 4. 新增脚本进入 Admin Runner

1. 脚本必须默认 dry-run / 只读，写操作有显式 flag 或审批门禁；
2. 在 `server/scripts/build-admin-runner.mjs` 的 `ADMIN_RUNNER_ENTRIES` 增加条目
   （`build-release` 会强制 release 命令集与该清单一致，漏配会在出包时失败）；
3. 同步更新本文档第 2 节清单。
