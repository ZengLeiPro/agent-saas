# Release preflight

`scripts/release/preflight.mjs` 是本地只读、fail-closed 的发布门禁。它不部署、不修改 Git，也不访问网络；输出一条 JSON，阻断时以状态码 `1` 退出并列出全部 `blockingReasons`。

```sh
node scripts/release/preflight.mjs \
  --target <40-character-target-sha> \
  --baseline <40-character-baseline-sha> \
  --identity ./runtime-identity.production.json \
  --main main
```

## 检查项

1. `target`、`baseline` 均为完整 40 位 SHA。
2. `target` 可从 `main` 到达，`baseline` 是 `target` 的祖先。
3. identity 仅从本地文件读取，且是完整 production JSON。
4. topology 的 `observedAt` 必须在 5 分钟内；API、Runtime Worker 的 systemd unit 必须为 active，release symlink 的真实目标必须匹配组件 SHA，pidfile 必须指向存活进程，readyfile 必须匹配组件 SHA。
5. 使用 `git diff --name-status --find-renames --find-copies <baseline>...<target>` 读取变更；rename/copy 的旧、新路径均分类，任何未知路径阻断发布。

| 路径前缀            | 组件                                 |
| ------------------- | ------------------------------------ |
| `web/`              | `web`                                |
| `server/`           | `api`, `runtimeWorker`, `acs`        |
| `shared/`           | `web`, `api`, `runtimeWorker`, `acs` |
| `workspace-shared/` | `api`, `runtimeWorker`, `acs`        |
| `hand-server/`      | `runtimeWorker`                      |
| `acs-orchestrator/` | `acs`                                |

## Runtime identity contract

identity 必须包含 `schemaVersion: 1`、`environment: production`、完整 `gitSha`、正整数 `configSchemaVersion` 和非敏感 `configFingerprint`。Web/API/Runtime Worker 分别提供完整 SHA、artifact digest 与 `deployedAt`；ACS 还必须分别提供 Orchestrator artifact digest 和 Sandbox image digest。此外必须包含实时 topology：

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
    "activeColor": "blue",
    "observedAt": "2026-08-26T07:00:00.000Z",
    "api": {
      "unit": "agent-saas-api@blue.service",
      "releaseSymlink": "/srv/agent-saas/blue/current",
      "pidfile": "/run/agent-saas/blue-api.pid",
      "readyfile": "/run/agent-saas/blue-api.ready"
    },
    "runtimeWorker": {
      "unit": "agent-saas-worker@blue.service",
      "releaseSymlink": "/srv/agent-saas/blue/worker-current",
      "pidfile": "/run/agent-saas/blue-worker.pid",
      "readyfile": "/run/agent-saas/blue-worker.ready"
    }
  }
}
```

`releaseSymlink` 的 realpath 和 `readyfile` 内容必须包含对应组件 SHA。无 URL、`file:` URI或远程 identity 来源会被接受。核心函数将 Git 和本地观测依赖注入，以支持无副作用单元测试。
