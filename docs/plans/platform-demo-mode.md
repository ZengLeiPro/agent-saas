# 平台演示模式（platform_demo）

> 状态：已实现（`feat/platform-demo-mode`）
>
> 目标：让**被授予能力的组织管理员**预览平台管理设置与分析的**示例数据**，并可走完整保存 UX，但**永不写入生产平台**。

## 能力授予

- Capability：`platform_demo_access`（membership 作用域：`tenantId + userId`）
- 仅 `platform_admin` 可授予/撤销：`POST/DELETE /api/platform-demo/grants`
- 目标必须是有效 `org_admin` membership
- 默认不授予任何组织管理员

## 访问模式 / Persona

在既有 `platform_admin | org_admin | member` 旁增加：

- `actorPersona: platform_demo`
- `accessMode: platform_demo`

解析入口：`resolvePlatformDemoAccess`（`server/src/platformDemo/auth.ts`）。
组织管理员在真实 membership 中仍保持 `org_admin`；进入演示壳层后以 `platform_demo` 身份操作。

## API 前缀

全部挂在 **`/api/platform-demo/...`**，与生产 admin 路由隔离：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/access` | 是否可进入演示 |
| POST | `/enter` | 进入演示（轻量审计） |
| GET | `/analytics` | fixture 分析序列 |
| GET | `/config` / `/config/:sectionId` | fixture 配置形状 + 本会话草稿 |
| PUT | `/config/:sectionId` | Save → `demo_session`（TTL ~24h） |
| GET/POST/DELETE | `/grants` | 平台管理员授予/列表/撤销（GET 可省略 tenantId 列出全部；响应含 featureFlag） |
| GET | `/grants/candidates?tenantId=` | 某组织的有效 `org_admin` 候选 |

**禁止**复用：`adminConfigOperations`、signed config publish、Vault、ACS control、以及其他 `/api/admin/*` 生产写路径。

## 读：仅 fixtures

- `server/src/platformDemo/fixtures.ts` 提供 analytics series / counts / 配置表单 shape
- 响应带 `source: "fixture"`，零生产数据泄漏

## 写：方案 A（假事务）

1. 客户端完整校验 UX
2. `PUT /api/platform-demo/config/:sectionId`
3. 服务端写入 `demo_session`，key = `actorTenantId::actorUserId::sectionId`
4. TTL 约 24 小时；其他用户不可见
5. 响应 `affectsProduction: false`；永不写 production raw/secret/runner

## UI

- 菜单文案：`平台管理（演示）`
- 持久横幅：`演示模式 · 数据与操作为示例，不会影响平台`
- 入口：统一设置侧栏 / 移动设置菜单（当无真实 `settings.platform.view` 但有 demo 能力时）
- 演示身份打开真实平台管理深链：`ManagementSettingsAccessGate` 回退到 `PlatformDemoShell`
- **平台管理 → 访问控制 → 演示访问**（仅 `platform_admin`）：全局开关只读（env 硬开关）+ 授予列表 + 选组织后仅列出该组织 `org_admin` 再授予/撤销

## 安全护栏

- `createRejectPlatformDemoProductionWrites`：持有 demo 能力的非平台管理员对 `/api/admin`、`/api/governance` 的写动词 → **403** `PLATFORM_DEMO_PRODUCTION_WRITE_FORBIDDEN`
- 生产 `requirePlatformAdmin` 仍对非 pantheon admin 拒绝

## Feature flag

环境变量 `PLATFORM_DEMO_MODE_ENABLED`：设为 `0` / `false` / `off` 时**硬关闭**演示入口（默认开启）。
硬关闭时面板仍只读展示状态，但无法靠面板改写；环境开启后由平台管理「演示访问」面板管理授予。

## 审计

对 grant / revoke / enter 追加轻量 governance audit（审计不可用时不阻断演示读写）。

## 存储

- Schema v49：`*_membership_capability_grants`、`*_platform_demo_sessions`（expand-only）
- 生产路径：`PgPlatformDemoCapabilityStore` / `PgPlatformDemoSessionStore`（governance 迁移后由 `runtimeGovernanceStores` 装配）
- 单测 / 无 PG：进程内 InMemory stores（`resetPlatformDemoRuntimeStoresForTests`）
- 授予在进程重启后仍保留（PG）；`demo_session` 草稿同样落库，TTL ~24h

## 测试

`server/src/platformDemo/platformDemo.test.ts`：

1. capability gate
2. fixture reads
3. demo_session save 隔离
4. production write 403
5. grant/revoke 仅平台管理员
6. feature flag 关闭
