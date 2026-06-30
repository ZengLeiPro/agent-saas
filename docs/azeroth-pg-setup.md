# Azeroth RDS 上建独立 database 给 agent-saas 用

> 路径：在 Azeroth RDS（同实例）建独立 database `agent_runtime` + 独立 role `agent_runtime_app`。
> 不跟 Azeroth 业务 schema 混在一起，物理隔离写入、连接池、备份恢复。
>
> 关联：
> - 路线规划 `assets/20260607/Managed-Agents架构-完整路线规划.md` Stage 2 EventStore 外部化
> - α5 任务（α 上线路径）
> - SQL DDL：`server/scripts/sql/agent-runtime-init.sql`

## 1. 决策背景

曾磊 06-14 拍板：**用 Azeroth RDS 同实例新建一个 database**（不是 schema 隔离）。
理由：

- 比 schema 隔离物理隔离强：runtime 跑垮自己的 db 不影响 azeroth 主 db 的 query 计划缓存、WAL 段、autovacuum
- 比单独跑一个 RDS 省运维：共用一个实例的备份/快照/监控/补丁
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

## 6. retention 策略（后续，不在初始化阶段做）

`runtime_events` 表会无限增长（每个 tool call / approval / model response 几行）。后续要加 retention：

- **手动**：每月跑一次 `DELETE FROM runtime_events WHERE timestamp < NOW() - INTERVAL '90 days';`
- **自动**：等 PG 切默认稳定后启用 SQL 文件第 5 节里的 `runtime_events_prune_older_than(90)` 函数 + 系统 cron / pg_cron 调用

保留多久看真实使用密度。第一个月先看曲线，再定 30/60/90 天。

---

## 7. 监控 / 容灾（β 阶段补）

- **PG 慢/挂时应用熔断**：当前 `PgEventStore` 没有 fallback，PG 卡顿会拖死 agent loop。β 阶段加超时 + 断路器，超时切到本地 file backend 临时挡一阵（接受短期数据写两份）
- **dump 备份**：Azeroth 主备份策略已经覆盖整个实例（包括 `agent_runtime` db），不需要单独配；但要确认快照 retention 跟 azeroth 一致
- **连接数监控**：通过 RDS 控制台看 `agent_runtime_app` 的活跃连接数；触发 CONNECTION LIMIT 20 时报警（暂不接告警通道，曾磊明示）
