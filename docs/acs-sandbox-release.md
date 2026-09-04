# ACS Sandbox 镜像发布门禁

> 当前结论：ACS Sandbox 已有独立 GitHub Actions 链路（`.github/workflows/acs-sandbox.yml`）。`main` push 只进入分类与测试，不部署生产；只有指向最新 `main` 的 `workflow_dispatch` 才可能进入 `build-deploy`，经 ECS 处理当前 SHA 的不可变镜像、更新 `ACS_SANDBOX_IMAGE`、重启 `agent-saas-acs-orchestrator.service`，并跑正式 `/provision + /execute Shell` smoke。非 `main` dispatch 同样不会进入该生产 job。主服务 CI/CD 绿灯仍不能代表 Sandbox 已发布；必须核对该次 ACS Sandbox 手工发布结果。

## 生产链路边界

生产当前拆成三段：

- 主服务：GitHub Actions 部署到 `/opt/agent-saas-app/current`，重启 `agent-saas-server.service`。
- ACS orchestrator：ECS 上的 `/opt/agent-saas`，systemd 服务 `agent-saas-acs-orchestrator.service`。
- ACS Sandbox 镜像：`/etc/agent-saas/acs-orchestrator.env` 中的 `ACS_SANDBOX_IMAGE`，由 ACS Sandbox Pod 实际执行工具。

Sandbox 镜像不是一个轻量 sidecar。它内置了自己的代码副本，包括 `server/src/agent/toolRuntime.ts`、`server/src/agent/workspaceHandTools.ts`、`acs-orchestrator/src/sandboxRunner.ts` 和 `shared/`。因此主服务更新后，Sandbox 仍可能运行旧工具名、旧 schema、旧输出格式或旧依赖。

ACS workspace 挂载也跨这三段：主服务把真实用户目录相对 `/mnt/agent-saas` 的路径写入 `WorkspaceRecipe.mountSubPath`，orchestrator 把它作为 PVC `subPath` 挂到 Sandbox `/workspace`，Sandbox runner 只在 `/workspace` 内执行工具。`workspaceId` 不再等同于 NAS 目录名，只保留为逻辑 ID。

## 触发条件

ACS Sandbox workflow 不使用顶层 `paths`；`main` push 与面向 `main` 的 PR 都会唤醒 workflow，`.github/scripts/acs-classify.sh` 是唯一影响分类真源。`Classify ACS Impact` job 按 changed files 输出发布或契约检查范围；分类结果只决定 CI 门禁，生产 `build-deploy` 仍只允许最新 `main` 的手工 dispatch。

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

## 自动化

`.github/workflows/acs-sandbox.yml` 负责这条链路：

- `Classify ACS Impact` 通过 `.github/scripts/acs-classify.sh` 读取 changed files，输出 `publish` / `contract_check`；workflow 顶层没有 `paths` 过滤。
- `main` push 只分类并执行相应测试，不进入生产 `build-deploy`；只有最新 `main` 的 `workflow_dispatch` 才能进入该 job，非 `main` dispatch 也不会进入。
- `publish=true` 时跑 typecheck、orchestrator tests 与 operational scripts；镜像由 GitHub push webhook 触发 ACR EE 源码构建。
- `workflow_dispatch` 遍历 ACR build-record API 全部分页，以 tag 的 6 位 SHA 后缀筛选全局唯一 build record；分页总数漂移、记录缺失或重复都会 fail closed。随后从该 record 的 `GIT_CLONE` 日志验证完整 40 位 `GITHUB_SHA`；解析前后必须再次遍历全部分页并维持同一 `BuildRecordId`，且两次 tag digest 读回稳定，最终只部署 digest reference。ACR build-record API 不直接返回产物 digest，因此现场必须把候选 tag 的写权限限制在受控构建链；不能把短 tag 或可被外部改写的 tag 本身当作精确 SHA 证据。读取生产 Secret 的 `build-deploy` job 显式绑定 `production` Environment。
- 全量分页后仍找不到完整 revision 候选构建记录且连续两次缺失时，按 `push + refs/heads/main + payload.after=GITHUB_SHA` 精确定位失败的 ACR webhook delivery，最多自动补投一次，然后继续原轮询；找不到或补投失败仍保持 fail-fast。
- 将 orchestrator release 包和安全解包 helper 上传到 ECS 的 root-only `/run/agent-saas-production-staging/`；部署脚本先校验 helper 的 runner-side SHA-256，再拒绝路径穿越、链接和特殊文件，仅从已验证目录安装制品。随后更新 `/etc/agent-saas/acs-orchestrator.env` 的 `ACS_SANDBOX_IMAGE`，并通过 drain 旧进程后由 systemd 拉起新版本；任一早期失败与正常结束都会清理该 staging。
- 正式跑 `/provision + /execute Shell` smoke，断言 workspace venv 路径、base Python 包 import、`ACS_SANDBOX_DEPLOY_SMOKE_OK`。
- `/health` 暴露当前 Sandbox image、runtime contract、capabilities、networkPolicy、SNAT 与 Sandbox inventory。
- `publish=false && contract_check=true` 时只跑 `server` / `acs-orchestrator` typecheck 和 `acs-orchestrator` tests，不发布。

Workflow 的必需生产 Secrets 是 `ECS_HOST`、`ECS_USER`、`ECS_SSH_KEY`、
`ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ACR_READ_ACCESS_KEY_ID`、
`ACR_READ_ACCESS_KEY_SECRET`，均只配置在 `production` Environment。后两项只读 ACR build record、
`GIT_CLONE` 日志与 image metadata，不得授予镜像写入或删除权限。
`ACS_WEBHOOK_REDELIVERY_TOKEN` 是可选恢复凭据：仅在当前 SHA 的 ACR 自动构建记录缺失时用于补投
一次 GitHub webhook；正常命中构建记录时不需要，必须补投但未配置时 Workflow fail closed。该 token
必须仅授权 `ZengLeiPro/agent-saas`，Repository permissions 只有 `Webhooks: write`，禁止复用个人
broad-scope token。集群 `acr-agentsaasacrprod` imagePullSecret 只用于拉取生产镜像，不作为 webhook
补投凭据。所有同名 Repository/organization Secret 在 Environment 迁移核验后必须删除。

旧 tag 清理不是自动化的一部分。删除 ACR tag 仍需单独确认回滚窗口。
