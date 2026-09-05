# Admin Runner：随 release 交付、经治理 launcher 执行的一次性运维脚本

## 1. 问题与方案

migration / backfill / repair / maintenance 类一次性运维脚本（`server/scripts/*.mts`、`server/src/scripts/*.mts`）大多自带 dry-run、幂等与写入门禁，但历史上它们只在源码检出里可运行：

- 生产 release 用 `pnpm --prod deploy` 交付依赖，`tsx` 属于 devDependency，生产环境没有；
- release bundle 主要只交付 `dist/index.js`，脚本源码不随包交付。

结果是脚本"在同一代码库里"，却不满足**使用同一 release、依赖和配置运行**。现在：

- `pnpm -F server build` 在构建 `dist/index.js` 的同时，把受控清单中的运维脚本用 esbuild
  预编译到 `server/dist/admin/<command>.mjs`（`--packages=external`，与 `dist/index.js`
  的外部化策略一致）。运行时直接用该 release 的 prod `node_modules` 解析 `pg` 等依赖，
  不需要 `tsx`，也不需要源码检出。
- `server/dist/admin/manifest.json`（schemaVersion 2）记录每个入口的源文件、sha256、size、
  **治理 metadata**（风险等级、默认模式、写意图 flag、升级 flag、授权要求、重入语义、配置需求、
  受支持环境），以及与主 Server 相同的 Runtime dependency contract digest；Runtime guard、
  governance bootstrap 与 launcher 也各自记录 sha256 与 size。
- **`server/dist/admin/launcher.mjs` 是唯一受支持的执行入口**。每个命令入口的 banner 同时导入
  Runtime dependency guard 与 governance bootstrap；bootstrap 拒绝未经 launcher 启动的直接执行，
  并提示改用 launcher。这是防误用而非防对抗——有 root 的操作者可以伪造环境，但文档化路径之外
  "顺手直跑入口文件"会被明确拒绝。
- `scripts/release/build-release.mjs` 出包时 fail-closed 校验：manifest 存在且为 schemaVersion 2、
  命令集与 `server/scripts/admin-runner-entries.mjs` 受控清单一致、每个命令的治理 metadata 与清单
  逐字节一致、每个入口 / guard / bootstrap / launcher 的内容与字节摘要一致、命令入口同时导入
  guard 与 bootstrap、launcher 只导入 guard；任一失败直接拒绝出 release。
- 安装侧 `verify-installed-release.mjs` 的 contentDigest 对 `server/` 全目录（含
  `dist/admin`）逐文件取证，Admin Runner 与 `dist/index.js` 一起被密封/校验。

## 2. 命令清单

唯一真相源是 `server/scripts/admin-runner-entries.mjs`；下表由测试从清单生成并比对，手改无效。
「授权单号」列：`launcher 持有` 表示 `--authorization-ref` 只由 launcher 记录进回执、不透传给脚本；
`脚本原生接受` 表示 launcher 会把同一个 `--authorization-ref <ref>` 追加到脚本参数。
「必填 flag」列：launcher 会在脚本参数里核对（精确名或 `--flag=value`），缺失按 `invalid_arguments` 拒绝；
`repair-taskboard-workflow` 要求 `--output=<release 外路径>`，因为脚本默认把审计 JSON/MD 写到相对 cwd，
而 launcher 的 cwd 是密封的 release 目录。
**「配置需求（声明）」列只是脚本依赖的说明，不是 launcher 已完成的预检**：launcher 目前只执行
Release/Config Identity 门禁；PG 连接、transcripts 根目录、release 布局是否满足由各脚本自己检查，
回执不证明这些需求已满足。

<!-- admin-runner-commands:start -->

| command                            | 风险     | 默认模式  | 写意图 flag                                               | 升级 flag                           | 必填 flag  | 授权单号      | 重入语义   | 配置需求（声明）                            | 环境                                   |
| ---------------------------------- | -------- | --------- | --------------------------------------------------------- | ----------------------------------- | ---------- | ------------- | ---------- | ------------------------------------------- | -------------------------------------- |
| `migrate-events-file-to-pg`        | high     | dry_run   | `--execute`(high)                                         | `--force`(critical, 需 `--execute`) | —          | launcher 持有 | resumable  | pg_connection, transcripts_root             | production, staging, development, test |
| `migrate-platform-tenant-pantheon` | high     | dry_run   | `--apply`(high)                                           | —                                   | —          | launcher 持有 | one_shot   | release_layout                              | production, staging, development, test |
| `backfill-runtime-sessions`        | medium   | dry_run   | `--execute`(medium)                                       | —                                   | —          | launcher 持有 | resumable  | app_config, pg_connection, transcripts_root | production, staging, development, test |
| `repair-runtime-session-statuses`  | medium   | dry_run   | `--execute`(medium)                                       | —                                   | —          | launcher 持有 | idempotent | app_config, pg_connection, transcripts_root | production, staging, development, test |
| `repair-taskboard-workflow`        | high     | dry_run   | `--apply`(high)                                           | —                                   | `--output` | launcher 持有 | idempotent | pg_connection                               | production, staging, development, test |
| `runtime-events-maintenance`       | critical | read_only | `--execute-retention`(critical)<br>`--execute-drop`(high) | —                                   | —          | 脚本原生接受  | idempotent | app_config, pg_connection                   | production, staging, development, test |
| `context-derived-replay`           | medium   | dry_run   | `--apply`(medium)                                         | —                                   | —          | launcher 持有 | idempotent | app_config, pg_connection                   | production, staging, development, test |

<!-- admin-runner-commands:end -->

脚本自身的参数语义与 dev 命令（`pnpm -C server run migrate:events-file-to-pg` 等）完全一致，dev 侧文档（如
[`runtime-eventstore-retention-runbook.md`](runtime-eventstore-retention-runbook.md)）继续有效。
**各脚本原有的更严格门禁不被 launcher 替代**：retention 的 `--legal-delete-through` 与 7 天观测窗口、
`context-derived-replay` 的 `--confirm-tenant`/`--expected-cursor`、`repair-runtime-session-statuses`
的规范 transcript 根目录限制等，仍由脚本自己在 launcher 之后再判一次。

## 3. 生产运行方式

与 systemd `agent-saas-server@<color>` 使用相同的代码、依赖、配置与环境变量：

```bash
active="$(tr -d '[:space:]' </etc/agent-saas/active-color)"
release="/opt/agent-saas-app/color/$active/server"

set -a
. /etc/agent-saas/server.env
. "/etc/agent-saas/server-$active.env"
. "/etc/agent-saas/server-$active.release.env"     # AGENT_SAAS_ENVIRONMENT / RELEASE_* / CONFIG_IDENTITY_*
set +a
export NODE_ENV=production
export AGENT_SAAS_CONFIG_PATH=/etc/agent-saas/config.json
export AGENT_SAAS_ADMIN_RECEIPT_DIR=/var/lib/agent-saas/admin-receipts   # 必须在 release 树之外

cd "$release"
# 只读 / dry-run：不需要授权单号
/usr/bin/node dist/admin/launcher.mjs <command> \
  --runtime-data-dir /mnt/agent-saas/server-data -- [脚本参数]
# 写操作：必须给 launcher 传 --authorization-ref，并按脚本要求传其写 flag
/usr/bin/node dist/admin/launcher.mjs <command> \
  --authorization-ref CHG-2026-0001 \
  --runtime-data-dir /mnt/agent-saas/server-data -- --execute [脚本参数]
```

要点：

- launcher 位置固定为 `dist/admin/launcher.mjs`；`node dist/admin/<command>.mjs` 直跑会被 bootstrap
  拒绝（exit 3）。脚本参数必须放在显式 `--` 之后。
- `--runtime-data-dir` 与 `--env-file` 只用于让 launcher 以与部署脚本相同的实参调用
  `dist/config-identity-cli.js` 计算 observed Config Identity（systemd `BindPaths` 场景下
  `<cwd>/data` 对应持久主机目录）；生产应与 `deploy-production-release.sh` 一致传
  `--runtime-data-dir /mnt/agent-saas/server-data`。
- 漏 source `server-$active.release.env` 会让 `AGENT_SAAS_ENVIRONMENT` 缺失，launcher 按
  `environment_unidentified` 拒绝；这是有意的，不要用 `AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT` 绕开。
- launcher 本身也先经过 Runtime dependency guard（精确 Node 版本 / 架构 / 平台），与 systemd
  `ExecStartPre` 同一门禁。
- `AGENT_SAAS_CONFIG_PATH` 与 systemd unit 一致，`loadAppConfig` 类脚本
  （backfill / runtime-events-maintenance）读到的是与线上 server 同一份配置。
- `migrate-platform-tenant-pantheon` 的 `--data-dir/--config-dir/--workspace-shared`
  默认值已适配 release 布局（`<release>/server/data`、`<release>/server/config`、
  `<release>/workspace-shared`），通常无需显式传路径；仍可显式覆盖。
- Staging 环境代码在 `/opt/agent-saas-staging/current/server`，working directory 是
  `/mnt/agent-saas-staging/runtime/server`，按同样方式替换路径即可；回执目录另设
  `/var/lib/agent-saas-staging/admin-receipts`。

## 4. launcher 预检顺序

任一失败 → `rejected` 回执 + exit 3；不会启动脚本。

1. `AGENT_SAAS_ADMIN_RECEIPT_DIR` 已设置，按 launcher 当前目录绝对化后**不在 release 目录之内**——否则
   没有任何回执能力或会破坏密封树，直接拒绝（此时无回执，只有 stderr）。绝对化后的目录同时注入子进程，
   bootstrap 与 launcher 看到同一 marker 位置。
2. `manifest.json` 合法（schemaVersion 2、字段完整、枚举合法）；launcher 自身、guard、bootstrap 的
   sha256/size 与 manifest 一致。
3. 命令在 manifest 中；入口文件 sha256/size 与 manifest 一致。
4. 写意图识别：出现任一声明的写 flag（**精确匹配**，与 7 个脚本的 `argv.includes('--flag')` 一致；
   `--execute=false` 对脚本和 launcher 都不是写 flag）才是 `write`，否则就是命令自身的默认模式
   （`read_only`/`dry_run`），遗漏参数不可能进入写模式。升级 flag 必须伴随其要求的写 flag；
   `--authorization-ref` 只能给 launcher；`write` 必须有 `--authorization-ref <单号>`
   （字母数字与 `. _ # -`，≤64 字符，不含 `/` `:`，避免 URL/连接串/路径伪装成单号进入回执）。
5. 环境：复用 `readRuntimeIdentity`（`AGENT_SAAS_ENVIRONMENT` 必须显式为 staging/production；
   development 需 `NODE_ENV=development` + `AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT=1`；
   test 按 `NODE_ENV=test`），且环境在命令 `supportedEnvironments` 内。
6. Release identity：release 目录 `runtime-dependencies.json` 必须存在、合法、`contractDigest` 等于
   manifest 的 `dependencyContractDigest`，且 `sourceSha` 等于 `AGENT_SAAS_RELEASE_SHA`。
   production/staging 必须绑定；development/test 允许 `AGENT_SAAS_RELEASE_SHA` 缺失（回执标 `not_bound`），
   但任何不一致一律拒绝。`AGENT_SAAS_RELEASE_ID`/`AGENT_SAAS_SERVER_DIGEST` 只记录，不在 launcher 内重算
   安装内容摘要（那由 `verify-installed-release` 在发布链路保证）。
7. Config Identity：expected 取 release env；observed 由同一 release 的 `dist/config-identity-cli.js`
   子进程计算（launcher 不复制算法）；四态判定与 [`config-identity.md`](config-identity.md) 一致，
   再按 §6 矩阵放行/拒绝。

通过后 launcher 先写 `started` 回执，再以子进程执行入口（保留脚本自身的退出码与门禁），
最后原子覆盖为终态回执。信号语义：预检期收到 `SIGINT`/`SIGTERM` → 在下一个检查点写 `cancelled`
回执（**优先于**任何门禁的拒绝结论；正在进行的 `config-identity-cli` 观察本身不会被中断，最长等它
60 秒超时）；运行期 → 转发给子进程；收尾期 → 忽略，直到回执落盘后才释放 handler。
所有拒绝文案都是固定句式，不回显操作者输入的原文（未知选项名、命令名、错误对象的原生消息等）。

## 5. 执行回执

- 位置：`$AGENT_SAAS_ADMIN_RECEIPT_DIR/<environment>/<YYYYMMDD>/<invocationId>.json`，`0600`，
  临时文件 + `rename` 原子写入。回执目录必须在 release 树之外——release `server/` 全目录被安装校验密封。
- `schemaVersion: 1`，字段：`invocationId`、`command`/`entry`/`entryDigest`/`launcherDigest`、
  `environment`、`release{status,reason?,releaseId?,releaseSha?,serverDigest?,dependencyContractDigest?,dependencyDigest?}`、
  `configIdentity{status,reason?,expectedDigest?,observedDigest?,schemaVersion?,gate}`、
  `mode`/`defaultMode`/`riskLevel`/`writeIntents`/`escalationFlags`、
  `argsSummary{declaredFlags,otherFlagCount,positionalCount,inlineValueCount}`（**真 allowlist：只记录
  manifest 声明过的写/升级 flag 名，其余参数一律只计数，值与未声明的名字永不落盘**）、
  `targetOverrides[]`（出现的目标覆盖信号名：`--connection-string`/`--root`/`--data-dir`/`--config-dir`/
  `--workspace-shared`/`--table-prefix`/`--cwd` 与 `env:DATABASE_URL`/`env:AGENT_TRANSCRIPTS_ROOT`，只记名不记值；
  提醒复核者“配置身份一致 ≠ 实际操作目标一致”）、
  `authorizationRef`/`authorizationForwarded`、`actor{source:'process_env',user?,sudoUser?,trusted:false}`、
  `startedAt`/`finishedAt`、`result`、`exitCode?`、`signal?`、`errorCategory?`、`errorDetail?`。
- `result`：`started`（预检通过、执行中）→ `succeeded`（exit 0）/ `failed`（非零码或 spawn 失败）/
  `cancelled`（信号）；预检失败为 `rejected`。
- `errorCategory` 只来自 launcher 能确证的事实：`invalid_arguments | unknown_command | manifest_invalid |
entry_tampered | environment_unidentified | environment_unsupported | release_identity_missing |
release_identity_mismatch | config_identity_drifted | config_identity_unverifiable |
write_flag_without_authorization | authorization_ref_invalid | authorization_ref_misplaced |
escalation_without_write | receipt_dir_unavailable | script_spawn_failed | script_exit_nonzero |
script_signal | launcher_internal`。**`script_exit_nonzero` 不区分脚本门禁拒绝与运行失败**——
  launcher 不解析 stderr 猜测。
- `actor.trusted` 永远为 `false`：SSH 手工执行没有可信身份源，`USER`/`SUDO_USER` 可伪造。回执的可信部分是
  release/config identity 与 digest，不是「谁」。
- 序列化前做双保险扫描：凭据形态（`scheme://user:pass@`、Bearer、常见 token 前缀、`password/secret/token`
  键名）或 `/etc /opt /mnt /home /Users /var /run /tmp` 绝对路径出现即拒绝写入（exit 4）。
- 退出码：`0` 成功；子进程非零码透传；`3` launcher 拒绝；`4` 回执写入失败；`128+signal` 取消。

## 6. Config Identity fail-closed 矩阵

| 环境               | 意图                | consistent | drifted          | unverifiable(expected_not_bound)  | unverifiable(其他) / CLI 失败 |
| ------------------ | ------------------- | ---------- | ---------------- | --------------------------------- | ----------------------------- |
| production         | write               | 放行       | 拒绝             | **拒绝**                          | 拒绝                          |
| production         | read_only / dry_run | 放行       | 拒绝             | 放行 + 回执 `gate=annotated`      | 拒绝                          |
| staging            | 任意                | 放行       | 拒绝             | 拒绝（staging 必须绑定 identity） | 拒绝                          |
| development / test | 任意                | 放行       | 放行 + annotated | 放行 + annotated                  | 放行 + annotated              |

已知后果：合并本治理层后到下一次绑定 expected identity 的正式 Promotion 之间，生产**写命令不可用**
（只读/dry-run 仍可跑并被标注）。紧急写操作必须先完成一次正式发布。production 有受管 SecretVault ref
而 vault 不可达时 `config-identity-cli` 会失败，按 `unverifiable(observation_failed)` 拒绝一切——与
运行期语义一致。

## 7. 新增脚本进入 Admin Runner

1. 脚本必须默认 dry-run / 只读，写操作有显式 flag 或审批门禁；
2. 在 `server/scripts/admin-runner-entries.mjs` 的 `ADMIN_RUNNER_ENTRIES` 增加条目并填全治理
   metadata（`build-release` 会强制 release 命令集、metadata 与该清单一致，漏配或漂移会在出包时失败）；
3. 运行 `node --test scripts/release/admin-runner.test.mjs`，把测试输出的新表格贴进本文档第 2 节
   标记之间（测试比对生成结果，漂移即失败）。

## 8. 边界

- 治理范围只覆盖生产 release 内的 `dist/admin`；dev 侧 `pnpm -C server run xxx` 与未进 Runner 的脚本
  （`repair-entitlement-scopes`、`cleanup-phantom-sessions` 等）不在本机制内。
- launcher 不改脚本 argv 解析与退出码，不建审批/调度平台，不收集或上报回执。
- Config Identity 只证明「`AGENT_SAAS_CONFIG_PATH` 指向的配置」与发布时一致；launcher 会把绝对化后的同一路径
  注入子进程，保证预检与脚本读的是同一份文件。但脚本自身的目标覆盖参数（如 `--connection-string`、
  `--root`、`--data-dir`）不在身份校验范围内——它们是操作者显式指定的目标，只能靠脚本自己的 dry-run
  报告与人工复核把关。
