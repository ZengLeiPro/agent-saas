# 生产 NAS 目录布局

> 生产入口统一使用 `/mnt/agent-saas`。旧 `/mnt/agent-workspaces` 只作为迁移兼容路径保留，不再作为新逻辑的事实源。

## 目录约定

```text
/mnt/agent-saas/
  workspaces/
    <tenantId>/
      <userId>/
        .ky-agent/
          workspace.json
          skills/
          scripts/
          runtime/
            browser-profile/
            cache/
              npm/
              pip/
              azeroth-cli/
            provision/
            venv/
            venv-archive/
        memory/
        uploads/
        MEMORY.md
        PERSONA.md
  server-data/
  runtime/
```

- `workspaces/`：用户长期 workspace。路径使用稳定 `tenantId/userId`，不使用 `username`，避免用户名修改导致目录分叉。
- `.ky-agent/`：KY Agent 自有命名空间。平台初始化、skills、scripts、MCP settings、workspace 元数据和运行态缓存都放这里；不再初始化 `.claude`。
- `.ky-agent/runtime/`：workspace 内唯一运行态根。浏览器 profile、venv、npm/pip/业务 CLI cache、ACS provision hash 和 venv 归档都收敛到这里，避免 `.browser-profile`、`.venv`、`.cache`、`.agent-saas` 分散在 workspace 根。
- `memory/`、`uploads/`、`MEMORY.md`、`PERSONA.md`：用户长期数据和用户可见输入输出，必须随 workspace 保留。
- `server-data/`：主服务持久数据目录，部署后软链到 `server/data`。当前包含 SQLite/JSON 配置、SecretVault 密文、memory index、cron/artifacts 等本地态。
- `runtime/`：运行态和历史迁移归档，包括 ACS smoke/probe、旧 hand sandbox、旧目录快照等。不得让业务逻辑依赖这里的目录结构。

## workspaceId 与真实目录

`workspaceId=ws_<tenantId>__<userId>` 是逻辑 ID，用于 PG、HandStore、审计、Sandbox 名称、标签和日志检索。

真实文件目录由主服务解析：

```text
agentCwd=/mnt/agent-saas/workspaces
resolveUserCwd(agentCwd, user) => /mnt/agent-saas/workspaces/<tenantId>/<userId>
```

ACS Sandbox 不再把 `workspaceId` 当作 NAS 子目录。主服务会把真实 workspace 相对 NAS 总根的路径写入 `WorkspaceRecipe.mountSubPath`：

```text
mountSubPath=workspaces/<tenantId>/<userId>
```

orchestrator 只验证这是安全相对路径，然后作为 PVC `subPath` 挂载到 Sandbox 的 `/workspace`。

## 运维纪律

- 删除 Sandbox 只清理 Sandbox/TrafficPolicy/SNAT，不删除 `workspaces/`。
- 用户 workspace 重置只能走明确的归档流程，不能跟 Sandbox TTL、idle pause、会话删除混在一起。
- 批量删除旧测试目录前必须列出路径、数量、体积和判定依据，得到明确确认后再删。
- 改动 `server/src/agent/*`、`server/src/runtime/handProtocol.ts`、`acs-orchestrator/src/*` 或 workspace 工具契约时，必须同时检查 [ACS Sandbox 镜像发布门禁](acs-sandbox-release.md)。
