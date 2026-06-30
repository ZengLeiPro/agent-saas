# ACS Sandbox 镜像发布门禁

> 当前结论：ACS Sandbox 已有独立 GitHub Actions 发布链路（`.github/workflows/acs-sandbox.yml`）。相关路径 push 到 `main` 时会构建 `acs-sandbox` 镜像、本地 contract smoke、经 ECS 推送到 ACR VPC endpoint、更新 `ACS_SANDBOX_IMAGE`、重启 `agent-saas-acs-orchestrator.service`，并跑正式 `/provision + /execute Shell` smoke。主服务 CI/CD 绿灯仍不能代表 Sandbox 已发布；必须看 ACS Sandbox workflow 结果。

## 生产链路边界

生产当前拆成三段：

- 主服务：GitHub Actions 部署到 `/opt/agent-saas-app/current`，重启 `agent-saas-server.service`。
- ACS orchestrator：ECS 上的 `/opt/agent-saas`，systemd 服务 `agent-saas-acs-orchestrator.service`。
- ACS Sandbox 镜像：`/etc/agent-saas/acs-orchestrator.env` 中的 `ACS_SANDBOX_IMAGE`，由 ACS Sandbox Pod 实际执行工具。

Sandbox 镜像不是一个轻量 sidecar。它内置了自己的代码副本，包括 `server/src/agent/toolRuntime.ts`、`server/src/agent/workspaceHandTools.ts`、`acs-orchestrator/src/sandboxRunner.ts` 和 `shared/`。因此主服务更新后，Sandbox 仍可能运行旧工具名、旧 schema、旧输出格式或旧依赖。

ACS workspace 挂载也跨这三段：主服务把真实用户目录相对 `/mnt/agent-saas` 的路径写入 `WorkspaceRecipe.mountSubPath`，orchestrator 把它作为 PVC `subPath` 挂到 Sandbox `/workspace`，Sandbox runner 只在 `/workspace` 内执行工具。`workspaceId` 不再等同于 NAS 目录名，只保留为逻辑 ID。

## 触发条件

改到以下内容时，必须判断是否需要发布新 ACS Sandbox 镜像：

- `server/src/agent/toolRuntime.ts`
- `server/src/agent/workspaceHandTools.ts`
- `server/src/agent/descriptions/*.md`
- `server/src/runtime/handProtocol.ts`
- `acs-orchestrator/src/protocol.ts`
- `acs-orchestrator/src/sandboxRunner.ts`
- `Dockerfile` 的 `acs-sandbox` target
- `shared/`
- `package.json`、`pnpm-lock.yaml` 或 workspace 工具运行依赖

只改 ACS orchestrator 自身代码时，主服务 CI/CD 不会自动部署 `/opt/agent-saas`；现在由 ACS Sandbox workflow 同步 `/opt/agent-saas` 并重启 `agent-saas-acs-orchestrator.service`。如果同时改到 Sandbox runner 或工具运行依赖，同一个 workflow 会继续发布新 Sandbox 镜像。

其中工具名、tool schema、入参、返回结构、stream chunk、错误语义、权限语义发生变化时，必须二选一：

1. 发布新 ACS Sandbox 镜像。
2. 在 orchestrator 层做明确兼容，并写测试覆盖兼容映射。

兼容层只能作为过渡方案，不是替代镜像发布链路。

## 已知事故

2026-06-28，主服务已切到 PascalCase 工具名 `Read/List/Write/Shell`，但生产 ACS Sandbox 镜像仍是旧版本，只认识 `read_file/list_files/write_file/run_shell`，导致用户工具调用报错：

```text
ServerLocalExecutionProvider: unknown tool Read
```

当日止血方式是 commit `2af3d5b`：在 `acs-orchestrator/src/executor.ts` 把 `Read/List/Write/Shell` 临时翻译为旧 Sandbox runner 可识别的工具名。这个补丁解决了生产可用性，但没有解决镜像发布自动化缺口。

## 手工发布 checklist

发布前：

```bash
pnpm -F acs-orchestrator test
pnpm -F server typecheck
pnpm test
```

镜像内容基线（通用生产 Agent hand P0）：

- 基础 OS：Debian/Ubuntu glibc slim，生产默认 Python 3.12；Alpine/musl 与 Python 3.14 只可作为回滚/实验，不是目标形态。
- 必须有：`node/npm/npx/pnpm/corepack`、`bash`、`git/git-lfs`、`ssh/scp`、`curl/wget`、`rg`、`jq`、`zip/unzip`、`python/python3/pip`、`gcc/g++/make/cmake/pkg-config`、`sqlite3/psql/mysql`、`dig/nslookup/nc/ping`。
- 通用 Agent full tools 必须有：Chromium/Playwright、`fontconfig` + 中文字体、`ffmpeg/ffprobe`、ImageMagick、LibreOffice、Pandoc、Poppler、Ghostscript、QPDF、Tesseract OCR。
- 必须用非 root 跑：当前默认 `runAsUser=501`、`runAsGroup=20`，与 NAS workspace 的 `501:dialout` 对齐；不要让 Sandbox 继续以 root 生成 workspace 文件。
- Python 必须走 workspace venv：ACS runner 会使用 `/workspace/.ky-agent/runtime/venv`，旧/不可用 venv 归档到 `.ky-agent/runtime/venv-archive/` 后用容器内 Python 重建 Linux venv；镜像默认 `PIP_REQUIRE_VIRTUALENV=1`，禁止 pip 静默写系统环境。
- workspace venv 必须有 `.ky-runtime.json` manifest：记录 runtime contract、Python major/minor、base requirements hash、Sandbox image ref。manifest 缺失/损坏、Python 版本变化、requirements hash 变化、image ref 变化或 `include-system-site-packages != false` 都必须归档旧 venv 并重建。
- 基础 Python 包安装到 workspace venv，不安装到系统 Python。权威清单是 `acs-orchestrator/requirements/base.txt`，应覆盖 requests/httpx/aiohttp、numpy/pandas、Office 文档、轻量 PDF（PyMuPDF + pypdf）、数据库客户端、dotenv/yaml、playwright、jieba 等通用任务基线；机器学习、科学计算、Parquet/Arrow、matplotlib、Selenium、PDF 高级解析/生成套件不放入默认基线。镜像必须预置 `/opt/ky-agent/python-wheels`，runner 优先用本地 wheelhouse 安装，避免生产运行时首个 workspace 依赖公网 PyPI。
- npm global prefix 必须走用户可写目录：镜像默认 `NPM_CONFIG_PREFIX=/home/agent/.npm-global`，`PATH` 必须包含 `/home/agent/.npm-global/bin`，保证 skill 里仍使用 `npm install -g` 的脚本不会写 root-owned `/usr/local`。
- Sandbox 业务时区必须显式注入：镜像默认 `TZ=Asia/Shanghai`，orchestrator 创建 Sandbox 时也注入同名 env；`date +%z` 应输出 `+0800`。
- 下载目录必须落 workspace：镜像与 orchestrator 创建 Sandbox 时都应提供 `DOWNLOAD_DIR=/workspace/downloads`、`XDG_DOWNLOAD_DIR=/workspace/downloads`，浏览器/下载类任务不得默认写进 `/home/agent` 或容器临时层。
- `find` 必须是 GNU findutils，不能退回 BusyBox；`tree` 也作为基础诊断工具保留。
- `pnpm` / `yarn` 要在 `agent` 用户的 Corepack cache 中预热，避免首次运行时下载。
- Browser skill 必须做 runtime capability gating：生产 `agent-saas-acs` 默认应显式暴露 browser capability；仅当运行态确实禁用浏览器时才隐藏 browser skill。
- 禁止放入：`docker`、`kubectl`、`aliyun` 等宿主或云控制面工具。Sandbox 只跑用户 workspace 工具，不应持有生产控制面能力。
- 2026-06-29 曾推送过 Debian/glibc 与 Alpine full-tools 测试 tag；首次真实 ACS Sandbox smoke 卡在 `Pending`，events 显示 image pull 鉴权 401，根因是 namespace 内 `acr-agentsaasacrprod` imagePullSecret 仍是旧 `cr_temp_user` token。后续不能只看 ACR push 成功，必须同时验证 Kubernetes imagePullSecret 与 ACS events。

本地构建后先跑命令矩阵：

```bash
docker run --rm --user 501:20 --entrypoint /bin/sh "$IMAGE" -c '
set -eu
for c in node npm npx pnpm corepack yarn bash git git-lfs ssh scp curl wget rg jq zip unzip python python3 pip gcc g++ make cmake pkg-config sqlite3 psql mysql dig nslookup nc ping tree openssl ffmpeg ffprobe convert identify soffice pandoc pdftotext qpdf gs tesseract fc-match; do
  command -v "$c" >/dev/null || { echo "missing $c"; exit 1; }
done
python3 - <<'PY'
import sys
assert sys.version_info[:2] == (3, 12), sys.version
PY
test "$(id -u)" = "501"
test "$(find --version | head -1 | grep -c "GNU findutils")" = "1"
test "$TZ" = "Asia/Shanghai"
test "$(date +%z)" = "+0800"
test "$(cat /etc/timezone)" = "Asia/Shanghai"
test "$(readlink -f /etc/localtime)" = "/usr/share/zoneinfo/Asia/Shanghai"
test "$NPM_CONFIG_PREFIX" = "/home/agent/.npm-global"
test "$(npm config get prefix)" = "/home/agent/.npm-global"
npm list -g --depth=0 >/dev/null
test "$PLAYWRIGHT_BROWSERS_PATH" = "/ms-playwright"
test "$DOWNLOAD_DIR" = "/workspace/downloads"
test "$XDG_DOWNLOAD_DIR" = "/workspace/downloads"
test "$ACS_PYTHON_WHEELHOUSE" = "/opt/ky-agent/python-wheels"
test -d "$ACS_PYTHON_WHEELHOUSE"
test "$(find "$ACS_PYTHON_WHEELHOUSE" -name "*.whl" | wc -l)" -gt 0
fc-match "Noto Sans CJK SC" | grep -Ei "Noto|CJK|Sans" >/dev/null
case ":$PATH:" in *":/home/agent/.npm-global/bin:"*) ;; *) echo "missing npm global bin in PATH"; exit 1 ;; esac
touch "$NPM_CONFIG_PREFIX/.write-test" && rm "$NPM_CONFIG_PREFIX/.write-test"
mkdir -p "$DOWNLOAD_DIR" && touch "$DOWNLOAD_DIR/.write-test" && rm "$DOWNLOAD_DIR/.write-test"
'
node <<'NODE' \
  | docker run --rm --user 501:20 -i "$IMAGE" /app/acs-orchestrator/node_modules/.bin/tsx /app/acs-orchestrator/src/sandboxRunner.ts
const command = [
  'set -eu',
  'test "$(id -u)" = 501',
  'test "$(which python3)" = /workspace/.ky-agent/runtime/venv/bin/python3',
  'test "$TZ" = Asia/Shanghai',
  'test "$(date +%z)" = +0800',
  'test "$(cat /etc/timezone)" = Asia/Shanghai',
  'test "$(readlink -f /etc/localtime)" = /usr/share/zoneinfo/Asia/Shanghai',
  'test "$(npm config get prefix)" = /home/agent/.npm-global',
  'npm list -g --depth=0 >/dev/null',
  'test "$DOWNLOAD_DIR" = /workspace/downloads',
  'test "$PLAYWRIGHT_BROWSERS_PATH" = /ms-playwright',
  'test "$ACS_PYTHON_WHEELHOUSE" = /opt/ky-agent/python-wheels',
  'for c in openssl ffmpeg ffprobe convert identify soffice pandoc pdftotext qpdf gs tesseract fc-match; do command -v "$c" >/dev/null; done',
  'fc-match "Noto Sans CJK SC" | grep -Ei "Noto|CJK|Sans" >/dev/null',
  'mkdir -p "$DOWNLOAD_DIR"',
  'touch "$DOWNLOAD_DIR/.write-test"',
  'rm "$DOWNLOAD_DIR/.write-test"',
  'python3 - <<\\PY',
  'import requests, httpx, aiohttp, bs4, lxml, numpy, pandas, openpyxl, xlsxwriter, docx, pptx, PIL, jinja2, markdown, pypdf, fitz, sqlalchemy, pymysql, psycopg, redis, dotenv, yaml, jieba, playwright',
  'print("PYTHON_BASE_IMPORTS_OK")',
  'PY',
  'node - <<\\NODE',
  'const { chromium } = require("/app/server/node_modules/playwright");',
  '(async () => {',
  '  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });',
  '  const page = await browser.newPage();',
  '  await page.setContent("<html><body><h1>中文测试</h1></body></html>");',
  '  await page.screenshot({ path: "/tmp/playwright-smoke.png" });',
  '  await browser.close();',
  '  console.log("PLAYWRIGHT_CHROMIUM_OK");',
  '})().catch((err) => { console.error(err); process.exit(1); });',
  'NODE',
  'yarn --version',
].join('\n');
process.stdout.write(JSON.stringify({
  toolName: 'Shell',
  input: { command, timeoutMs: 120000 },
  workspace: { id: 'ws-local', sessionId: 's-local', root: '/workspace' },
}));
NODE
```

构建并推送镜像，tag 必须是不可变版本，建议格式为 `yyyymmdd-<shortsha>-amd64`：

```bash
TAG=20260629-<shortsha>-amd64
IMAGE=agentsaasacrprod-registry-vpc.cn-shenzhen.cr.aliyuncs.com/agent-saas/acs-sandbox:$TAG

docker buildx build \
  --platform linux/amd64 \
  --target acs-sandbox \
  -t "$IMAGE" \
  --push \
  .
```

切换生产镜像：

```bash
ssh root@47.106.14.205
grep '^ACS_SANDBOX_IMAGE=' /etc/agent-saas/acs-orchestrator.env
sudoedit /etc/agent-saas/acs-orchestrator.env
systemctl restart agent-saas-acs-orchestrator.service
systemctl is-active agent-saas-acs-orchestrator.service
curl -sf http://10.0.1.1:3400/health
```

验证时至少覆盖：

- `/provision` 可以创建或恢复测试 Sandbox。
- `/execute` 调用 `List` 成功。
- `/execute` 调用 `Read` 成功。
- `/execute` 调用 `Shell` 成功。
- 测试 Sandbox 按精确 workspace/session 标签清理干净。
- 业务侧不再出现 `unknown tool`。

回滚方式：

1. 把 `ACS_SANDBOX_IMAGE` 改回上一版镜像 tag。
2. 重启 `agent-saas-acs-orchestrator.service`。
3. 只清理精确测试 Sandbox；不要删除 NAS workspace。

## 自动化

`.github/workflows/acs-sandbox.yml` 负责这条链路：

- 相关路径变更时自动构建 `acs-sandbox` 镜像。
- 本地跑命令矩阵与 runner contract smoke。
- 将镜像 tar 和代码 release 包上传到 ECS。
- 在 ECS 上安装 orchestrator 依赖、用 ACR VPC endpoint 推送镜像、更新 `/etc/agent-saas/acs-orchestrator.env` 的 `ACS_SANDBOX_IMAGE`。
- 重启 `agent-saas-acs-orchestrator.service`。
- 正式跑 `/provision + /execute Shell` smoke，断言 workspace venv 路径、base Python 包 import、`ACS_SANDBOX_DEPLOY_SMOKE_OK`。
- `/health` 暴露当前 Sandbox image、runtime contract、capabilities、networkPolicy、SNAT 与 Sandbox inventory。

Workflow 依赖 GitHub Secrets：`ECS_HOST`、`ECS_USER`、`ECS_SSH_KEY`、`ACR_USERNAME`、`ACR_PASSWORD`。ACR 推送发生在 ECS 内，经 VPC endpoint；`ACR_USERNAME`/`ACR_PASSWORD` 是主登录路径。ECS 上的阿里云 CLI `cr GetAuthorizationToken` 与集群 `acr-agentsaasacrprod` imagePullSecret 只作为诊断兜底，不应依赖 orchestrator 最小 RBAC 去读 Secret。不要求打开 ACR 公网 endpoint。

旧 tag 清理不是自动化的一部分。删除 ACR tag 仍需单独确认回滚窗口。
