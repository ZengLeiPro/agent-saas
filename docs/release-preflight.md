# Release preflight

`scripts/release/preflight.mjs` 是生产主机侧只读、fail-closed 的发布门禁。它不部署、不修改 Git，也不访问网络；输出一条 JSON，阻断时以状态码 `1` 退出并列出全部 `blockingReasons`。

```sh
node scripts/release/preflight.mjs \
  --target <40-character-target-sha> \
  --baseline <40-character-baseline-sha>
```

`main` 身份固定为仓库契约 `origin/main`，调用者不能用 SHA 或其他 ref 覆盖。

## Staging startup identity

Staging 启动除 Release SHA/digest、数据库和代理变量外，还必须显式提供：

- Server 实际 `process.cwd()/data`、Agent `uploads/`、sharedDir 与 Vault 文件都必须预创建并位于 `AGENT_SAAS_STAGING_ROOT`；
- Staging/Production 各自的 credential namespace、JWT SHA-256 fingerprint 和 Hand store namespace，两侧值必须不同；
- Staging/Production 各自的 ACS namespace、PVC、ServiceAccount，以及 `AGENT_SAAS_STAGING_ACS_READY=0|1`；ACS 未就绪时 `toolControls.enabled` 必须为 `false`；
- `AGENT_SAAS_STAGING_OAUTH_ENABLED=0|1`；启用时两个 callback 必须使用 Staging allowlist，关闭时 callback 必须不存在；
- `AGENT_SAAS_STAGING_NOTIFICATION_MODE=disabled`；在正式建设测试 sink 前，DingTalk、阿里云短信和 Web Push 必须关闭；
- Hand/SecretVault token 只能使用 Staging credential namespace 下的 Vault 引用，禁止 inline token。

Staging 会在解析任何 Vault 引用前先安装无凭据、全代理、`failOpen=false` 的 bootstrap egress，再把动态 egress fetch 安装为进程级 `globalThis.fetch`。HTTP Vault 明确绑定 bootstrap fetch，避免提前捕获直连 fetch；bootstrap 不读取 Vault 中的代理凭据，以免形成“访问 Vault 前先访问 Vault”的循环依赖。因此未显式接入 dispatcher 的 DingTalk、短信等全局 fetch 调用也不能绕过出口策略。以上是应用启动契约；数据库、Vault、K8s RBAC/PVC 等“无法访问生产”的反向权限证明仍属于阶段 C 的基础设施验收，不能由配置字符串替代。

## 检查项

1. `target`、`baseline` 均为完整 40 位 SHA。
2. `target` 可从受信 `origin/main` 到达，`baseline` 是 `target` 的祖先。
3. CLI 只读取生产主机受控路径 `/etc/agent-saas/runtime-identity.json`，不接受调用方传入 identity 路径；该文件必须由部署过程写入并由主机权限保护。
4. topology 的 `observedAt` 必须在 5 分钟内。API 与 Runtime Worker 分别读取自己的 active-color 文件；systemd `MainPID` 必须与 pidfile PID 完全相等，并与 release symlink 真实目标、进程 cgroup 相互绑定；Worker readyfile 按现行契约保存 PID并与 MainPID 一致，API 不虚构 readyfile。
5. 使用 `git diff --name-status --find-renames --find-copies <baseline>...<target>` 读取变更；rename/copy 的旧、新路径均分类，任何未知路径阻断发布。

| 路径前缀            | 组件                                 |
| ------------------- | ------------------------------------ |
| `Dockerfile`        | `web`, `api`, `runtimeWorker`, `acs` |
| `web/`              | `web`                                |
| `server/`           | `api`, `runtimeWorker`, `acs`        |
| `shared/`           | `web`, `api`, `runtimeWorker`, `acs` |
| `workspace-shared/` | `api`, `runtimeWorker`, `acs`        |
| `hand-server/`      | `api`, `runtimeWorker`               |
| `acs-orchestrator/` | `acs`                                |

`scripts/pr-preflight.sh`、`scripts/pr-preflight-task.sh` 与
`scripts/pr-preflight-contract.test.mjs` 只定义 CI 门禁，不进入运行时制品，明确按非运行时文件处理；
其他未映射的 `scripts/**` 仍保持 fail-closed。

## Runtime identity contract

identity 必须包含 `schemaVersion: 1`、`environment: production`、完整 `gitSha`、正整数 `configSchemaVersion` 和非敏感 `configFingerprint`。Web/API/Runtime Worker 分别提供完整 SHA、artifact digest 与 `deployedAt`；API 与 Runtime Worker 共享 Server bundle，因此两者 SHA 和 digest 必须相同。ACS 还必须分别提供 Orchestrator artifact digest 和 Sandbox image digest。此外必须包含实时 topology：

```json
{
  "schemaVersion": 1,
  "environment": "production",
  "gitSha": "<40-char-sha>",
  "configSchemaVersion": 1,
  "configFingerprint": "sha256:<digest>",
  "components": {
    "web": { "gitSha": "<sha>", "artifactDigest": "sha256:<digest>", "deployedAt": "<utc>" },
    "api": { "gitSha": "<sha>", "artifactDigest": "sha256:<digest>", "deployedAt": "<utc>" },
    "runtimeWorker": {
      "gitSha": "<sha>",
      "artifactDigest": "sha256:<digest>",
      "deployedAt": "<utc>"
    },
    "acs": {
      "gitSha": "<sha>",
      "orchestratorArtifactDigest": "sha256:<digest>",
      "sandboxImageDigest": "sha256:<digest>",
      "deployedAt": "<utc>"
    }
  },
  "topology": {
    "observedAt": "2026-08-26T07:00:00.000Z",
    "api": {
      "activeColor": "blue",
      "activeColorFile": "/etc/agent-saas/active-color",
      "unit": "agent-saas-server@blue.service",
      "releaseSymlink": "/opt/agent-saas-app/color/blue",
      "pidfile": "/run/agent-saas-server-blue.pid"
    },
    "runtimeWorker": {
      "activeColor": "green",
      "activeColorFile": "/etc/agent-saas/runtime-worker-active-color",
      "unit": "agent-saas-runtime-worker@green.service",
      "releaseSymlink": "/opt/agent-saas-app/worker/green",
      "pidfile": "/run/agent-saas-runtime-worker-green.pid",
      "readyfile": "/run/agent-saas-runtime-worker-green.ready"
    }
  }
}
```

`releaseSymlink` 的 realpath 必须包含对应组件 SHA；pidfile、Worker readyfile 和 systemd MainPID 必须为同一存活进程。
