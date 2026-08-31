# 全局参考

## 认证

### SaaS 平台边界（Agent 必须遵守）

SaaS 会话中的 Agent **不得执行** `dws auth login`、`dws auth logout`、`dws auth reset` 或 `dws auth migrate-keychain`，也不得要求用户提供 Client ID、Client Secret 或 token。

- 首次连接、登录过期、scope 缺失或账号切换：只引导用户前往「能力中心 → 连接器 → 钉钉」完成连接或重新连接。
- 渠道、device flow、token 刷新、Keychain/file-DEK 迁移和本地凭证清理由平台 host 管理；Agent 不启动第二套登录流程。
- 业务命令返回认证错误时停止业务重试，说明需要在连接器页处理；连接成功后再重试原命令。

下文所有登录、迁移、退出、重置和 Headless 示例都**仅适用于平台外本地开发**，不得用于 SaaS Agent 会话。

### 多账号 profile

- SaaS 由连接器和 Broker 固定精确 `corpId:userId`，Agent 不自行切换 profile。
- 同一组织可保存多个账号，身份由 `corpId + userId` 唯一确定。
- 多账号组织没有 `isOrgCurrent=true` 时，只传 corpId/corpName 会产生歧义，自动化必须使用精确账号身份。
- token 生命周期与刷新由 host 管理；Agent 不读取、输出或迁移凭证。

| Token | 有效期 | 说明 |
|-------|--------|------|
| Access Token | 2 小时 | 调用 API 的凭证，过期由 host 自动刷新 |
| Refresh Token | 30 天 | 换新 Access Token，轮转与续期由 host 管理 |

### 仅平台外本地开发

以下命令只允许开发者在平台外、自己控制的终端中使用：

```bash
# 首次 OAuth 设备流登录
dws auth login

# 查看状态
dws auth status

# macOS: 将系统 Keychain 登录态迁移为本地 file-DEK（先预检）
env -u DWS_DISABLE_KEYCHAIN dws auth migrate-keychain --to file-dek --dry-run --format json
env -u DWS_DISABLE_KEYCHAIN dws auth migrate-keychain --to file-dek --yes --format json

# 退出或在确认可丢弃全部本地登录后重置
dws auth logout
dws auth reset

# 本地多账号调试
dws profile list --format json
dws profile switch <corpId:userId>
dws --profile <corpId:userId> contact user get-self --format json
```

本地认证失败时：
- `AUTH_TOKEN_EXPIRED` / `USER_TOKEN_ILLEGAL` / “Token验证失败”：开发者可在本地终端重新执行 `dws auth login`。
- macOS `ciphertext_key_mismatch`：先执行 `auth migrate-keychain --to file-dek --dry-run`，通过后再加 `--yes`；不要直接 reset。

#### 平台外 Headless 环境（CI/CD）

```bash
export DWS_CLIENT_ID=<your-app-key>
export DWS_CLIENT_SECRET=<your-app-secret>
dws auth login

# 或在远程服务器/Docker 使用设备流
dws auth login --device
```

refresh_token 单设备独占，远程刷新后源设备凭证失效。以上 Headless 方式不属于 SaaS Agent 授权路径。

## 全局标志

| 标志 | 短名 | 说明 | 默认 |
|------|:---:|------|------|
| `--format` | `-f` | 输出格式: json / table / raw | json |
| `--jq` | | jq 表达式过滤输出（如 `.result[].name`）。对产品命令（aitable/chat/mail/... 走 MCP 的）已生效；少数工具命令（auth/config/profile/doctor/schema 等）仍直接编码、暂不过滤 | 无 |
| `--fields` | | 筛选输出字段（逗号分隔）。按**顶层信封键**（data/result/success/status…）或**列表元素字段**投影；取 data 内的嵌套字段（如 baseName）请改用 `--jq '.data.baseName'`，`--fields baseName` 会因顶层无此键返回 `{}`。同 `--jq`：产品命令已生效，个别工具命令暂不生效 | 无 |
| `--verbose` | `-v` | 详细日志 | false |
| `--debug` | | 调试日志 | false |
| `--yes` | `-y` | 跳过确认提示 | false |
| `--dry-run` | | 预览操作不执行 | false |
| `--timeout` | | HTTP 超时 (秒) | 30 |
| `--mock` | | Mock 数据 (开发用) | false |
| `--client-id` | | 覆盖 OAuth Client ID | 无 |
| `--client-secret` | | 覆盖 OAuth Client Secret | 无 |
| `--profile` | | 单次指定组织或账号；支持 corpId/corpName 与 userId/userName 组合，推荐稳定的 corpId:userId | 当前账号 |

## 输出格式

### --format json (机器可读, 默认)

```json
{"success": true, "body": {...}}
```

### --format table (人类可读)

```
已创建 AI 表格 "项目管理" (UUID: abc123)

下一步:
  dws aitable base get --base-id abc123
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `DWS_CONFIG_DIR` | 覆盖默认配置目录 |
| `DWS_<PRODUCT>_MCP_URL` | 本地开发时覆盖指定产品 MCP endpoint |
| `DWS_CLIENT_ID` | 覆盖 OAuth Client ID (DingTalk AppKey) |
| `DWS_CLIENT_SECRET` | 覆盖 OAuth Client Secret (DingTalk AppSecret) |

凭证优先级: `--token` > `DWS_CLIENT_ID`/`DWS_CLIENT_SECRET` > OAuth 加密存储 (.data)
