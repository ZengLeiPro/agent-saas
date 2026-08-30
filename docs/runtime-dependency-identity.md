# Runtime Dependency Identity

## 边界

`config/runtime-dependency-contract.json` 是 Runtime 依赖的版本化所有权清单，只覆盖：

- Server、Runtime Worker、ACS Orchestrator、Admin Runner 与 ACS Sandbox 的精确 Node 版本、平台和架构；
- 生产构建实际使用的基础镜像 OCI digest；
- 运行契约直接依赖、且需要独立升级审计的系统工具。

应用 npm 依赖仍由 `pnpm-lock.yaml` 和 `sbom.json` 所有；ACS 最终 Sandbox 镜像仍由
`acsImage.digest` 所有；配置与 Secret 身份不属于此文档。manifest 禁止 secret、凭据、敏感本机路径和时间戳。

## Release 数据流

1. `build-release.mjs` 读取 contract，绑定完整 source SHA，生成规范化
   `runtime-dependencies.json`、仅由依赖字段计算的稳定 `dependencyDigest`，以及覆盖 source SHA 与依赖字段的 `identityDigest`。
2. identity 作为独立 artifact 写入 artifact index v2，并把 source/identity/contract/dependency digest 摘要写入 SBOM v2。历史 artifact index/SBOM v1 保持无 Runtime 字段的严格旧结构；新构建不会把字段原地塞回 v1。
3. Server bundle 与 ACS Orchestrator bundle 各自携带 identity 和校验器；Admin Runner manifest
   同时绑定 contract digest 与启动 guard 的文件摘要。兼容部署产生的 component index 也会独立持久化同一 identity。
4. `verify-artifact.mjs` 按版本严格校验：v1 仅接受历史应用制品与 SBOM，v2 同时校验完整制品集、文件摘要、identity 自摘要、source SHA、contract digest，以及 SBOM、Runtime identity 与 artifact index 的字段一致性。
5. Release Manifest v2 分别选择实际 Server 与 ACS 制品对应的 identity；`keep` 使用冻结基线 identity，`deploy`
   使用当前构建 identity。晋级还会逐字节核对所选 tgz 内嵌 identity，禁止 partial release 混用。

同一依赖输入不会包含时间、source SHA 或主机路径，因此跨 Release 产生相同 dependency digest；identity digest
仍绑定各自完整 source SHA。Node、基础镜像或受控工具任一升级都会改变 contract digest 和 dependency digest，
形成可审计差异。

## 启动门禁与兼容窗口

Production 与 Staging systemd unit 在 `ExecStart` 前运行；ACS 兼容直发入口在校验 archive digest 后先解包到 `/tmp` 执行同一 production guard，只有通过后才探写 `/etc`、创建持久 release 目录、修改 env/symlink 或替换进程。兼容直发与正式 Promotion 还共享同一 GitHub concurrency group 和主机 `flock`：

```bash
/usr/bin/node dist/runtime-dependency.mjs \
  --manifest=runtime-dependencies.json \
  --component=<server|runtimeWorker|acsOrchestrator> --production=true
```

Release Manifest v2 的 Server/ACS archive 同时携带对应 managed systemd unit；Promotion 仅为 `deploy` 组件从已校验的 selected archive 提取并安装 unit，`keep` 不要求历史 baseline archive 补带 unit，避免 partial RC 被旧基线阻断。这样也不会让批准 RC 后的主线 unit 变化污染旧 RC；显式历史 v1 仍走原兼容分支。

门禁精确比较 Node version、`process.arch`、`process.platform`，并对组件声明的宿主工具执行版本 probe。
缺文件、篡改、版本/架构不符、工具缺失或版本不符均阻断启动。工具 probe 仅允许“可执行文件名 + `--version|version`”两段结构，带超时执行，并要求输出中的首个规范化 semver token 精确等于契约版本，不能借后续兼容版本文本蒙混过关。`--production=true`（包括 bare flag）时禁止使用 `--mode=off`；local/dev 只有显式传入 `--mode=off` 才能跳过。

Node 升级采用单一兼容窗口：先更新 contract、所有 CI `NODE_VERSION` 和 Docker 基础镜像 digest，完成代码验证后
再合并；宿主环境升级与 Staging/Production 验证在合并后部署流程执行。不得在一个 Release 内同时接受两个 Node
patch 版本，也不得让 Admin Runner 与主 Server 使用不同 contract。

## 升级流程

1. 解析目标镜像的 `linux/amd64` OCI manifest digest，禁止提交 tag-only 引用。
2. 更新 `config/runtime-dependency-contract.json` 与 Dockerfile 中对应 digest；Node 升级同时更新根
   `package.json#engines.node` 和工作流 `NODE_VERSION`。
3. 新增或升级工具时，仅登记运行契约实际依赖的工具：名称、精确版本、架构、组件与无凭据 probe；
   同名工具在宿主与 Sandbox 版本不同时按组件分别声明（例如 git）。
4. 运行 `pnpm check:runtime-dependencies`、相关 typecheck/build，并检查生成 identity 的 digest 差异。
5. 合并后环境验证必须读回：宿主 `node --version`/架构、systemd `ExecStartPre` 成功日志、Sandbox 镜像内
   Node/Python/关键工具版本，以及 artifact index、SBOM、Admin Runner 报告的 contract digest 一致性。

正式镜像构建、宿主升级和部署不属于代码任务；代码只提供不可变输入、RC-bound managed unit、门禁与证据链。
