# ACS Sandbox 镜像发布门禁

> 当前入口（2026-09-10）：ACS 的检查由统一 `CI` 提供；`测试环境部署` 准备镜像与不可变 RC，
> `生产环境发布` 晋级该 RC 的原制品。独立 ACS Manual Deploy 已退役。CI 绿灯不代表 ACS 已发布，
> 必须检查 RC 的组件选择、生产 durable receipts 与 `/health` 读回。CI 的手动 Web-only 兼容生产发布仍保留，不能用于 ACS。


## 生产链路边界

生产当前拆成三段：

- 主服务：GitHub Actions 部署到 `/opt/agent-saas-app/current`，重启 `agent-saas-server.service`。
- ACS orchestrator：ECS 上的 `/opt/agent-saas`，systemd 服务 `agent-saas-acs-orchestrator.service`。
- ACS Sandbox 镜像：`/etc/agent-saas/acs-orchestrator.env` 中的 `ACS_SANDBOX_IMAGE`，由 ACS Sandbox Pod 实际执行工具。

Sandbox 镜像不是一个轻量 sidecar。它内置了自己的代码副本，包括 `server/src/agent/toolRuntime.ts`、`server/src/agent/workspaceHandTools.ts`、`acs-orchestrator/src/sandboxRunner.ts` 和 `shared/`。因此主服务更新后，Sandbox 仍可能运行旧工具名、旧 schema、旧输出格式或旧依赖。

ACS workspace 挂载也跨这三段：主服务把真实用户目录相对 `/mnt/agent-saas` 的路径写入 `WorkspaceRecipe.mountSubPath`，orchestrator 把它作为 PVC `subPath` 挂到 Sandbox `/workspace`，Sandbox runner 只在 `/workspace` 内执行工具。`workspaceId` 不再等同于 NAS 目录名，只保留为逻辑 ID。

## 触发条件

统一 `CI` 不使用顶层 `paths`；`main` push 与面向 `main` 的 PR 均进入规划。
`.github/scripts/acs-classify.sh` 仍负责 ACS 镜像影响分类；`scripts/ci-acs-plan.mjs` 同时覆盖原修复证据的广义 Server/ACS 路径。
CI 不自动部署生产；`测试环境部署` 等待同 SHA 的 CI 成功，再准备 RC，最后由 `生产环境发布` 手动晋级。

改到以下内容时，应发布新 ACS Sandbox 镜像：

- `acs-orchestrator/**`
- `Dockerfile` / `.dockerignore` / `.npmrc`
- `patches/**`
- `server/package.json`
- `server/src/agent/toolRuntime.ts`
- `server/src/agent/workspaceHandTools.ts`
- `server/src/agent/toolOutput.ts`
- `server/src/agent/shellOutputFiles.ts`
- `server/src/agent/containerExecutionProvider.ts`
- `server/src/agent/memorySearchToolProvider.ts`
- `server/src/agent/tools/descriptionLoader.ts`
- 当前 Sandbox import 闭包会加载的工具 descriptions：`Read`、`Write`、`List`、`Shell`、`WaitForWorkspaceReady`、`Edit`、`Glob`、`Grep`、`CreateArtifact`、`MemorySearch`、`MemoryList`
- `server/src/runtime/handProtocol.ts`
- `server/src/runtime/httpTransport.ts`
- `server/src/runtime/inProcessTransport.ts`
- `server/src/runtime/clientDaemonTransport.ts`
- `server/src/runtime/handStore.ts`
- `server/src/runtime/networkPolicy.ts`
- `server/src/data/tenants/types.ts`
- `pnpm-workspace.yaml`
- root `package.json` 中会影响安装/runtime 的字段（`packageManager`、`postinstall`、依赖字段、pnpm/patch/override/resolution 配置等）
- `pnpm-lock.yaml` 与上述发布路径一起变化时

只改 `server/src/runtime/rawAgentLoop.ts` / `server/src/runtime/rawRuntimeRunDispatch.ts` 时，workflow 会跑 ACS contract check，但默认不发布镜像。这类变更主要是主服务侧契约风险，主服务 CI/CD 负责真正部署；除非同时改到 ACS 发布路径，否则滚 ACS 没有增量。

`shared/**` 不能整体视为非 ACS 输入：当前真实 Orchestrator bundle 已引用的 `shared/src/**` 会由 `.github/acs-bundle-inputs.txt` 命中并触发 ACS 发布；未进入真实 bundle 的 shared 文件按 classifier 结果处理。每次新增 import 都由 esbuild metafile 契约复核，不能靠文档白名单漏掉。

只改 ACS orchestrator 自身代码也必须生成或选择相应不可变 RC，由生产晋级的 ACS 阶段安装已校验制品并执行生命周期门禁；不会通过源码直发入口单独滚动生产。

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
- 必须有：`node/npm/npx/pnpm/corepack`、`bash`、`git/git-lfs`、`ssh/scp`、`curl/wget`、`rg`、`jq`、`zip/unzip`、`python/python3/pip`、`sqlite3/psql/mysql`、`dig/nslookup/nc/ping`。
- 默认 runtime 不带 `gcc/g++/make/cmake/pkg-config` 和 `*-dev` 编译头文件；需要现场编译 Python/Node native 依赖时走扩展镜像或预构建 wheelhouse。
- 通用 Agent 默认工具必须有：Chromium/Playwright、`fontconfig` + CJK/emoji 字体、`ffmpeg/ffprobe`、最小 LibreOffice（core/common/writer/calc/impress）、Poppler、Ghostscript、QPDF、Tesseract OCR。Pandoc 与 ImageMagick 不进默认镜像，后续按扩展层提供。
- 必须用非 root 跑：当前默认 `runAsUser=501`、`runAsGroup=20`，与 NAS workspace 的 `501:dialout` 对齐；不要让 Sandbox 继续以 root 生成 workspace 文件。
- Python 必须走 workspace venv：ACS runner 会使用 `/workspace/.ky-agent/runtime/venv`，旧/不可用 venv 归档到 `.ky-agent/runtime/venv-archive/` 后用容器内 Python 重建 Linux venv；默认只保留最近 2 个 `.venv-*` 归档，可用 `ACS_MAX_VENV_ARCHIVES` 调整；镜像默认 `PIP_REQUIRE_VIRTUALENV=1`，禁止 pip 静默写系统环境。
- workspace venv 必须有 `.ky-runtime.json` manifest。Python runtime contract 当前为 **v2**；真实重建条件仅包括 manifest 缺失/损坏、contract version 变化、Python major/minor 变化、`baseRequirementsHash` 变化、Python 不可用或 `include-system-site-packages != false`。manifest 中可保留完整 Sandbox `imageRef` 供诊断，但它不是兼容性条件，镜像 tag/digest 单独变化不得触发共享 NAS venv 归档重建。
- Running Sandbox 发现镜像漂移时，若仍被其他活跃调用占用，发布升级必须安全延后并继续服务当前调用，不得向工具透出 `busy; refuse to recreate`；不修改旧实例 spec，待空闲后的下一次 `ensureRunning` 再重建。broken/mount 漂移等正确性问题仍保持原有 busy 防护。
- runtime bootstrap 在 provision/hand ready 前除 requests/duckdb 外，必须用 `/opt/ky-agent/browser-runtime/bin/python3` 验证 Python Playwright；旧镜像没有该解释器时才 fallback 当前 workspace `python3`。验证必须覆盖 Chromium executable 存在以及一次本地 headless launch/close，不能只做 import。
- 基础 Python 包安装到 workspace venv，不安装到系统 Python。权威清单是 `acs-orchestrator/requirements/base.txt`，应覆盖 requests/httpx、numpy/pandas、Office 文档、轻量 PDF（PyMuPDF + pypdf）、数据库客户端、dotenv/yaml、playwright、jieba 等通用任务基线；aiohttp、redis、机器学习、科学计算、Parquet/Arrow、matplotlib、Selenium、PDF 高级解析/生成套件不放入默认基线。镜像必须预置 `/opt/ky-agent/python-wheels`，runner 优先用本地 wheelhouse 安装，避免生产运行时首个 workspace 依赖公网 PyPI；wheelhouse 只保留默认基线所需 wheels。
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
for c in node npm npx pnpm corepack yarn bash git git-lfs ssh scp curl wget rg jq zip unzip python python3 pip sqlite3 psql mysql dig nslookup nc ping tree openssl ffmpeg ffprobe soffice pdftotext qpdf gs tesseract fc-match; do
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
test "$ACS_MAX_VENV_ARCHIVES" = "2"
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
  'test "$ACS_MAX_VENV_ARCHIVES" = 2',
  'for c in openssl ffmpeg ffprobe soffice pdftotext qpdf gs tesseract fc-match; do command -v "$c" >/dev/null; done',
  'fc-match "Noto Sans CJK SC" | grep -Ei "Noto|CJK|Sans" >/dev/null',
  'mkdir -p "$DOWNLOAD_DIR"',
  'touch "$DOWNLOAD_DIR/.write-test"',
  'rm "$DOWNLOAD_DIR/.write-test"',
  'python3 - <<\\PY',
  'import requests, httpx, bs4, lxml, numpy, pandas, openpyxl, xlsxwriter, docx, pptx, PIL, jinja2, markdown, pypdf, fitz, sqlalchemy, pymysql, psycopg, dotenv, yaml, jieba, playwright',
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
curl -sf http://127.0.0.1:3400/health
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

## 自动化（当前主链）

当前自动化分工：

- `CI / ACS Impact Gate`：类型检查、完整 Orchestrator 回归、真实 Python 远程进程测试、构建及必要的生命周期/运维契约。检查失败不被日志上传或证据整理隐藏。
- `测试环境部署 / prepare-acs`：运行 `wait-for-acr-image.sh` 与其 supervisor，查全量 build records；短 tag 只用于候选筛选，必须以 GIT_CLONE 日志绑定完整 release SHA，并对同一 BuildRecordId 和 digest 二次校验。总等待及阶段等待均有界，禁止换成“最新可用镜像”。
- `生产环境发布 / promote`：只消费已选 RC 的制品与清单；ACS unit、源码包、配置及镜像选择与清单绑定，受共享生产锁、drain、回滚和最终身份读回约束。它不再构建或部署任意源码 HEAD。
- ACR 云端构建和集群 imagePullSecret 不在本次清理范围内，不得因为旧 workflow 删除就停掉镜像构建。

`ACS_WEBHOOK_REDELIVERY_TOKEN` 是可选恢复凭据，原生产兼容入口退役不意味着可以删除被当前
Staging `prepare-acs` 使用的同类恢复能力。`ACR_READ_ACCESS_KEY_ID`、`ACR_READ_ACCESS_KEY_SECRET`
等共享凭据也必须按剩余调用者审计后处理，本次不改 Secret、云资源或运行配置。
生产写 job 继续绑定 `production` Environment；镜像准备按现有代码绑定 `staging`。
历史手工诊断/回滚命令仅供受授权事故处置参考，正常发布以本节的不可变 RC 主链为准。

旧 tag 清理不是自动化的一部分。删除 ACR tag 仍需单独确认回滚窗口。
