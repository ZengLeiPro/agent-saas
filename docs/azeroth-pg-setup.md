# Azeroth RDS 上建独立 database 给 agent-saas 用

> 路径：在 Azeroth RDS（同实例）建独立 database `agent_runtime` + 独立 role `agent_runtime_app`。
> 不跟 Azeroth 业务 schema 混在一起，提供 database/role/连接池的逻辑隔离；同实例仍共享存储、IOPS、WAL 与备份故障域。
>
> 关联：
> - 路线规划 `assets/20260607/Managed-Agents架构-完整路线规划.md` Stage 2 EventStore 外部化
> - α5 任务（α 上线路径）
> - SQL DDL：`server/scripts/sql/agent-runtime-init.sql`

## 1. 决策背景

曾磊 06-14 拍板：**用 Azeroth RDS 同实例新建一个 database**（不是 schema 隔离）。
理由：

- 比 schema 隔离强化 database/role/连接治理，但**不能**隔离实例级 IOPS、WAL、存储耗尽或故障
- 比单独跑一个 RDS 少一套实例运维，但备份/PITR 是否覆盖新 database 必须单独取证，不能由拓扑推断
- 比起公网另建 RDS 省钱

风险已知（已在路线 §14 进度日志声明）：

- 共用 IOPS / 共用 WAL 带宽 / 共用连接池（已用 `agent_runtime_app` `CONNECTION LIMIT 20` 兜住）
- 单 RDS 实例宕机两个服务一起停（Azeroth 已经是生产关键，这点可接受）
- 维护时间窗共享

---

## 2. 准备：先生成应用密码

不要直接编辑 SQL 里的明文密码。

```bash
# 生成 32 字符强密码（不含特殊字符方便 connection string）
APP_PW=$(openssl rand -base64 48 | tr -d '/+=' | head -c 32)
echo "应用密码已生成（保存好，待会儿要塞进 config.json）: $APP_PW"
```

把 `APP_PW` 同时存进 1Password 或开沿密码本，**不要写进任何 git tracked 文件**。

---

## 3. 跑 SQL 初始化（在阿里云 RDS 后台或本地 psql）

### 3.1 用阿里云 RDS DMS 后台跑

如果不愿意从公网开 psql 客户端，登 RDS 控制台 → DMS（数据管理）→ 选 azeroth 实例 → 选 `postgres` 默认 database → SQL 窗口贴入 `server/scripts/sql/agent-runtime-init.sql` 前 3 节（建 db / role / grant CONNECT）。

然后切到刚建的 `agent_runtime` database，贴入第 4 节（schema 权限）。

注意：DMS 不会自动展开 `:app_password` 变量，需要把 `:app_password` 手动改成 `'<生成的密码>'`（含单引号）。

### 3.2 用本地 psql（推荐，可一次性跑完）

需要 RDS 白名单允许你当前 IP，且有高权限账号（能 CREATE DATABASE / CREATE ROLE）。

```bash
RDS_HOST="<azeroth-rds-公网或内网域名>"
RDS_ADMIN_USER="<高权限账号>"
ADMIN_PW="<高权限密码>"
APP_PW="<上一步生成的应用密码>"

# 用 ON_ERROR_STOP 失败立刻退出
PGPASSWORD="$ADMIN_PW" /opt/homebrew/opt/libpq/bin/psql \
    -h "$RDS_HOST" \
    -U "$RDS_ADMIN_USER" \
    -d postgres \
    -v ON_ERROR_STOP=1 \
    -v "app_password='$APP_PW'" \
    -f server/scripts/sql/agent-runtime-init.sql
```

预期输出：

```
CREATE DATABASE
COMMENT
CREATE ROLE
COMMENT
GRANT
You are now connected to database "agent_runtime" as user "<admin>".
REVOKE
GRANT
GRANT
GRANT
ALTER DEFAULT PRIVILEGES
ALTER DEFAULT PRIVILEGES
```

### 3.3 验收

```bash
PGPASSWORD="$APP_PW" /opt/homebrew/opt/libpq/bin/psql \
    -h "$RDS_HOST" \
    -U agent_runtime_app \
    -d agent_runtime \
    -c "\dn+" \
    -c "SELECT current_database(), current_user, version();"
```

`\dn+` 应当能看到 `public` schema 有 `agent_runtime_app` 的 USAGE/CREATE 权限。

---

## 4. 配置 3200 连 Azeroth PG

`config.json` 不在 git，**只在本机和未来 ECS 上单独配**。

```json
{
  "runtimeEventStore": {
    "backend": "pg",
    "connectionString": "postgresql://agent_runtime_app:<APP_PW>@<RDS_HOST>:5432/agent_runtime?sslmode=require",
    "tablePrefix": "runtime"
  }
}
```

注意点：

- **sslmode=require**：阿里云 RDS 默认要求 SSL，必须加，否则握手失败
- **连接池上限（应用端）**：当前 `PgEventStore` 用 `pg.Pool` 默认（max=10）。如果未来发现 RDS 这边连接吃紧，在 `pgEventStore.ts` 加 `max: 5` 限制；现在不动
- 切换默认 backend 之前：用 ETL `pnpm -C server run migrate:events-file-to-pg -- --connection-string "<URL>"` 先 dry-run，再 `--execute`，把现有 jsonl 历史灌过去

---

## 5. 切换默认 backend 时的步骤（上线动作）

⚠️ 这是「α 上线路径」最敏感的一步，按顺序做：

1. **3200 停服**（kill PID，launchd KeepAlive 会重启，先 `launchctl unload` plist）
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.agent-saas.server.plist
   ```
2. **跑 ETL dry-run 看会写多少**：
   ```bash
   pnpm -C server run migrate:events-file-to-pg -- --connection-string "<URL>"
   ```
   看 `[plan] aggregate` 报告。如果 conflicts > 0，先查为什么。
3. **跑 ETL execute**：
   ```bash
   pnpm -C server run migrate:events-file-to-pg -- --connection-string "<URL>" --execute
   ```
4. **改 `config.json` 加 `runtimeEventStore.backend: "pg"`**
5. **`launchctl load` 重新拉起 3200**
6. **验证 health + 跑一次 chat 看新事件落 PG**：
   ```bash
   PGPASSWORD=$APP_PW psql ... -d agent_runtime \
     -c "SELECT COUNT(*), MAX(timestamp) FROM runtime_events;"
   ```

回滚：删 `runtimeEventStore` 段（或改 backend 回 `"file"`），重启 3200。PG 数据保留作历史。

---

## 6. retention 与容量维护

禁止按 timestamp 做“90 天全表 DELETE”，也禁止启用旧的 `runtime_events_prune_older_than(90)` 草案；它会绕过事件类别 TTL、legal watermark 和 billing watermark。

受支持入口是 `pnpm -C server maintenance:runtime-events -- ...`，默认严格只读 dry-run；显式删除参数、retention 矩阵、分批上限、容量余量、VACUUM/索引回收与恢复演练门禁统一见 [`runtime-eventstore-retention-runbook.md`](runtime-eventstore-retention-runbook.md)。

---

## 7. 监控 / 容灾事实门禁

- **生产容量**：当前代码仓库无法证明 RDS 已分配容量、实时可用空间或增长率；上线 retention 前按 runbook 从 RDS 控制台/监控取证。
- **备份/PITR**：当前代码仓库无法证明 `agent_runtime` 已被备份、PITR 窗口或最近恢复成功；取得策略截图、成功任务 ID 和隔离恢复演练记录前，删除门禁保持关闭。
- **隔离边界**：独立 database/role 不等于独立实例；恢复演练必须恢复到隔离实例，禁止覆盖生产。
- **连接数监控**：通过 RDS 控制台监控 `agent_runtime_app` 活跃连接数，并为接近 `CONNECTION LIMIT 20` 配置告警；是否已配置需以控制台证据为准。
