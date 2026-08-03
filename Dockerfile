# agent-saas multi-target Dockerfile
#
# 三个 target：
#   - `server`：3200 主服务 + Web UI dist
#   - `hand-server`：3300 远端 hand（HttpTransport 对端，server-remote 调用入口）
#   - `acs-sandbox`：ACS Agent Sandbox 内部 runner 镜像
#   - `web-build`：仅用作中间层（给 server target COPY web/dist）
#
# 决策（06-14 β1 / 06-29 ACS 升级）：
#   - server/hand-server 复用 Alpine deps；acs-sandbox 是通用生产 Agent hand，
#     使用 Debian glibc + Python 3.12，并内置浏览器、中文字体、轻量 Office/PDF/OCR/媒体栈
#   - 不装 docker-cli：生产容器内的 ContainerExecutionProvider 路径**禁用**——server-container
#     在 docker-in-docker 上是反 pattern，自用阶段只用 server-local；要走容器隔离时跑独立 hand-server
#     target 并切 executionTarget=server-remote
#   - 排除 mobile（expo 依赖重，server 不需要）和 web 源码（用 web-build target 产出 dist 即可）
#   - patch-package 在 postinstall 自动跑（pnpm install 不带 --ignore-scripts）；patches 目录必须 COPY
#
# 本地构建测试：
#   docker buildx build --target=server -t agent-runtime:server .
#   docker buildx build --target=hand-server -t agent-runtime:hand-server .
#   docker buildx build --target=acs-sandbox -t agent-runtime:acs-sandbox .
#
# 编排见 docker-compose.yml；ECS 部署见 docs/ecs-deployment.md。

# ─────────────────────────────────────────────────────────────
# BASE_REGISTRY — 基础镜像来源前缀
#   本地构建: 默认 docker.io/library（Docker Hub, 走本机网络/代理）
#   ACR EE 云端构建: build rule 传 BASE_REGISTRY=
#     agentsaasacrprod-registry-vpc.cn-shenzhen.cr.aliyuncs.com/base
#   云端构建机直连 Docker Hub 被墙且「海外源智能加速」实测无效（2026-07-04）,
#   基础镜像已手动同步到实例 base 命名空间; 升级基础镜像时用 skopeo copy
#   --override-os linux --override-arch amd64 重新同步后再改此文件。
# ─────────────────────────────────────────────────────────────
ARG BASE_REGISTRY=docker.io/library

# ─────────────────────────────────────────────────────────────
# Stage: deps — pnpm install（共用底层缓存）
# ─────────────────────────────────────────────────────────────
FROM ${BASE_REGISTRY}/node:22-alpine AS deps
WORKDIR /app

# corepack 启用 pnpm；版本与 root package.json 的 packageManager 字段一致
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

# 仅复制 package manifests 让 deps 层在源码变更时仍可缓存
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json ./server/
COPY hand-server/package.json ./hand-server/
COPY acs-orchestrator/package.json ./acs-orchestrator/
COPY shared/package.json ./shared/
COPY web/package.json ./web/
COPY mobile/package.json ./mobile/
COPY patches ./patches/

# 跳过 mobile/web：mobile 装 expo 太重且 server 不用；web 由 web-build target 单独装
# patch-package 在 root postinstall 自动跑（patches 目录已 COPY）
RUN pnpm install --frozen-lockfile \
    --filter '!mobile' \
    --filter '!web'

# ─────────────────────────────────────────────────────────────
# Stage: node-bookworm — 给 Python 3.12 Debian 运行时复制 Node 22
# ─────────────────────────────────────────────────────────────
FROM ${BASE_REGISTRY}/node:22-bookworm-slim AS node-bookworm

# ─────────────────────────────────────────────────────────────
# Stage: acs-base — production Agent hand runtime
# ─────────────────────────────────────────────────────────────
FROM ${BASE_REGISTRY}/python:3.12-slim-bookworm AS acs-base
WORKDIR /app

# 这是用户代码执行环境，不是控制面。保留通用 Agent 生产任务常用工具。
# docker/kubectl 这类可触达宿主或集群控制面的命令仍不放入镜像。
# aliyun/gh 只内置 CLI 二进制，凭据必须由运行时按 tenant/user/任务临时注入，禁止烘进镜像。
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG GH_CLI_VERSION=2.96.0
ARG GH_CLI_SHA256=83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60
ARG ALIYUN_CLI_VERSION=3.4.4
ARG ALIYUN_CLI_SHA256=11dc3c6999e0e2f3cdac6e38775920e14ace7b52567534ff1222db22ae327684
ARG GWS_CLI_VERSION=0.22.5
ARG GWS_CLI_TARGET=x86_64-unknown-linux-musl

COPY --from=node-bookworm /usr/local/bin/node /usr/local/bin/node
COPY --from=node-bookworm /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries \
    && sed -i "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      bind9-dnsutils \
      ca-certificates \
      curl \
      file \
      findutils \
      fontconfig \
      fonts-crosextra-caladea \
      fonts-crosextra-carlito \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      ffmpeg \
      git \
      git-lfs \
      ghostscript \
      iproute2 \
      iputils-ping \
      jq \
      less \
      libreoffice-calc \
      libreoffice-common \
      libreoffice-core \
      libreoffice-impress \
      libreoffice-writer \
      mariadb-client \
      netcat-openbsd \
      openssh-client \
      openssl \
      pandoc \
      poppler-utils \
      postgresql-client \
      procps \
      qpdf \
      ripgrep \
      sqlite3 \
      tesseract-ocr \
      tesseract-ocr-chi-sim \
      tesseract-ocr-eng \
      tree \
      tzdata \
      unzip \
      wget \
      xz-utils \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/local/bin/python3 /usr/local/bin/python \
    && ln -sf /usr/local/bin/pip3 /usr/local/bin/pip \
    && git lfs install --system \
    && git config --system http.lowSpeedLimit 1 \
    && git config --system http.lowSpeedTime 30 \
    && git config --system http.version HTTP/1.1 \
    && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo Asia/Shanghai > /etc/timezone \
    && fc-cache -fv \
    && update-ca-certificates

# GitHub CLI 的 apt 仓库只保留有限版本，固定版本会在下架后让历史镜像无法重建。
# 改用 GitHub 官方 immutable release，并校验官方发布的 SHA256。
RUN curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL \
      --retry 8 --retry-all-errors --retry-delay 5 --retry-max-time 1200 \
      --connect-timeout 20 --max-time 300 \
      "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh-cli.tar.gz \
    && echo "${GH_CLI_SHA256}  /tmp/gh-cli.tar.gz" | sha256sum -c - \
    && tar xzf /tmp/gh-cli.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh-cli.tar.gz "/tmp/gh_${GH_CLI_VERSION}_linux_amd64" \
    && gh --version

RUN curl -fsSL "https://aliyuncli.alicdn.com/aliyun-cli-linux-${ALIYUN_CLI_VERSION}-amd64.tgz" -o /tmp/aliyun-cli.tgz \
    && echo "${ALIYUN_CLI_SHA256}  /tmp/aliyun-cli.tgz" | sha256sum -c - \
    && tar xzf /tmp/aliyun-cli.tgz -C /tmp \
    && install -D -m 0755 /tmp/aliyun /usr/local/libexec/aliyun \
    && rm -f /tmp/aliyun /tmp/aliyun-cli.tgz \
    && /usr/local/libexec/aliyun version \
    && rg --version

COPY scripts/aliyun-runtime-wrapper.py /usr/local/bin/aliyun
RUN chmod 0755 /usr/local/bin/aliyun \
    && aliyun version

RUN corepack enable \
    && corepack prepare pnpm@10.18.3 --activate \
    && corepack prepare yarn@1.22.22 --activate \
    && corepack prepare pnpm@10.18.3 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json ./server/
COPY hand-server/package.json ./hand-server/
COPY acs-orchestrator/package.json ./acs-orchestrator/
COPY shared/package.json ./shared/
COPY web/package.json ./web/
COPY mobile/package.json ./mobile/
COPY patches ./patches/
COPY acs-orchestrator/requirements ./acs-orchestrator/requirements/
COPY acs-orchestrator/scripts/duckdb_cli.py /usr/local/bin/duckdb
RUN chmod +x /usr/local/bin/duckdb

RUN pnpm install --frozen-lockfile \
    --filter '!mobile' \
    --filter '!web'

# 能力中心官方 CLI — 全部 pin 版本，避免 latest 漂浮。
# Notion npm 包名/命令均为 ntn。
RUN npm install -g ntn@0.21.6 \
    && ntn --version

# Google Workspace CLI 的 npm 包只是一层 postinstall 壳：它用 Node native fetch
# 直连 GitHub Releases，既无重试，也不读取 HTTP_PROXY/HTTPS_PROXY。
# 直接按官方推荐下载 immutable release，保留官方 SHA256 校验并显式重试。
RUN set -eu; \
    archive="google-workspace-cli-${GWS_CLI_TARGET}.tar.gz"; \
    release_url="https://github.com/googleworkspace/cli/releases/download/v${GWS_CLI_VERSION}"; \
    download_dir="$(mktemp -d)"; \
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL \
      --retry 8 --retry-all-errors --retry-delay 5 --retry-max-time 1200 \
      --connect-timeout 20 --max-time 300 \
      -o "${download_dir}/${archive}" "${release_url}/${archive}"; \
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL \
      --retry 8 --retry-all-errors --retry-delay 5 --retry-max-time 300 \
      --connect-timeout 20 --max-time 60 \
      -o "${download_dir}/${archive}.sha256" "${release_url}/${archive}.sha256"; \
    (cd "${download_dir}" && sha256sum -c "${archive}.sha256"); \
    tar -xzf "${download_dir}/${archive}" -C "${download_dir}" ./gws; \
    install -m 0755 "${download_dir}/gws" /usr/local/bin/gws; \
    rm -rf "${download_dir}"; \
    gws --version

# dws CLI（钉钉工作台 skill 依赖）
# npm 包名: dingtalk-workspace-cli（bin 名: dws）；不用 dws@... 会拉到无关的 Decarta wrapper。
RUN npm install -g dingtalk-workspace-cli@1.0.55 \
    && dws --version

# 飞书官方 CLI（能力中心飞书连接器 + feishu skill）。
# @larksuite/cli 的 postinstall 会按当前平台下载官方二进制，bin 名为 lark-cli。
RUN npm install -g @larksuite/cli@1.0.81 \
    && lark-cli --version \
    && mkdir -p /tmp/lark-smoke/config /tmp/lark-smoke/data \
    && output="$(LARKSUITE_CLI_CONFIG_DIR=/tmp/lark-smoke/config \
      LARKSUITE_CLI_DATA_DIR=/tmp/lark-smoke/data \
      LARKSUITE_CLI_APP_ID=cli_smoke \
      LARKSUITE_CLI_USER_ACCESS_TOKEN=u-smoke-token \
      lark-cli auth status --json 2>&1 || true)" \
    && printf '%s' "$output" | grep -q 'credentials are provided externally' \
    && ! printf '%s' "$output" | grep -q 'u-smoke-token' \
    && rm -rf /tmp/lark-smoke

# Office skills（pptx/docx）Node 依赖 — 预装到独立前缀（2026-07-16 生产反馈修复）
# skills-pool 的 pptx skill「从零制作」主路径 require('pptxgenjs')、docx skill 新建文档 require('docx')；
# agent cwd 在 /workspace，解析不到 /app/node_modules，靠 acs-sandbox stage 的 NODE_PATH 兜底解析。
# pin 版本避免漂浮；构建期自检 require 可解析，fail-fast。
RUN mkdir -p /opt/ky-agent/node \
    && npm install --prefix /opt/ky-agent/node pptxgenjs@4.0.1 docx@9.7.1 \
    && NODE_PATH=/opt/ky-agent/node/node_modules node -e "require('pptxgenjs'); require('docx'); console.log('office node deps ok')" \
    && chmod -R a+rX /opt/ky-agent/node

RUN pnpm -F server exec playwright install --with-deps chromium \
    && apt-get purge -y --auto-remove \
      fonts-freefont-ttf \
      fonts-ipafont-gothic \
      fonts-tlwg-loma-otf \
      fonts-unifont \
      fonts-wqy-zenhei \
      xfonts-scalable \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────
# Stage: acs-wheel-builder — build wheelhouse without leaking compilers into runtime
# ─────────────────────────────────────────────────────────────
FROM acs-base AS acs-wheel-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      libffi-dev \
      libfreetype6-dev \
      libfribidi-dev \
      libharfbuzz-dev \
      libjpeg62-turbo-dev \
      liblcms2-dev \
      libopenjp2-7-dev \
      libpng-dev \
      libtiff-dev \
      libxml2-dev \
      libxslt1-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/ky-agent/python-wheels \
    && python3 -m pip wheel --no-cache-dir \
      --wheel-dir /opt/ky-agent/python-wheels \
      -r acs-orchestrator/requirements/base.txt

# ─────────────────────────────────────────────────────────────
# Stage: acs-deps — runtime + prebuilt Python wheels
# ─────────────────────────────────────────────────────────────
FROM acs-base AS acs-deps

COPY --from=acs-wheel-builder /opt/ky-agent/python-wheels /opt/ky-agent/python-wheels

# 构建期自检（fail-fast）：wheelhouse 里 playwright wheel 期望的 chromium 构建号
# 必须与 /ms-playwright 预装二进制（上方 Node 侧 playwright install，版本锁在 pnpm-lock）一致。
# 不一致时 sandbox 内 browser skill 会在运行时报 "Executable doesn't exist"（2026-07-03 生产事故）。
# 临时 venv 在同一 RUN 内创建并删除，不进镜像 layer。
COPY acs-orchestrator/scripts/verify_playwright_browsers.py /tmp/verify_playwright_browsers.py
RUN python3 -m venv /tmp/pwcheck \
    && /tmp/pwcheck/bin/pip install --no-cache-dir --no-index \
      --find-links /opt/ky-agent/python-wheels playwright duckdb \
    && /tmp/pwcheck/bin/python3 /tmp/verify_playwright_browsers.py \
    && PATH="/tmp/pwcheck/bin:$PATH" duckdb --version \
    && PATH="/tmp/pwcheck/bin:$PATH" duckdb -json -c "select 1 as ok" \
    && rm -rf /tmp/pwcheck /tmp/verify_playwright_browsers.py

# ─────────────────────────────────────────────────────────────
# Stage: web-build — 仅产出 web/dist 给 server target COPY
# ─────────────────────────────────────────────────────────────
FROM ${BASE_REGISTRY}/node:22-alpine AS web-build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json ./web/
COPY shared/package.json ./shared/
COPY patches ./patches/

RUN pnpm install --frozen-lockfile --filter web... --filter shared...

COPY shared ./shared
COPY web ./web
RUN pnpm -F web build

# ─────────────────────────────────────────────────────────────
# Stage: server — 3200 main brain + Web UI
# ─────────────────────────────────────────────────────────────
FROM deps AS server
WORKDIR /app

COPY shared ./shared
COPY server ./server
COPY --from=web-build /app/web/dist ./web/dist

# data/ 目录（business.sqlite / audit.duckdb / cron jobs）在容器内可写，
# 真实生产应当挂载 volume 把 data 持久化；本地 docker-compose 用 named volume 兜底
RUN mkdir -p server/data logs

# Clash Verge 代理在容器内不可用；HTTP_PROXY 等由 docker-compose / ECS task definition
# 显式注入。NODE_ENV=production 让 pnpm install 跳 devDeps（已发生过）
ENV NODE_ENV=production
ENV PORT=3200

EXPOSE 3200

# 直接 exec node 进 tsx CLI 避免多一层 pnpm wrapper（SIGTERM 信号直达 node）
CMD ["sh", "-c", "exec node node_modules/tsx/dist/cli.mjs server/src/index.ts"]

# ─────────────────────────────────────────────────────────────
# Stage: hand-server — 3300 远端 hand（HttpTransport 对端）
# ─────────────────────────────────────────────────────────────
FROM deps AS hand-server
WORKDIR /app

COPY shared ./shared
COPY server ./server
COPY hand-server ./hand-server

ENV NODE_ENV=production
# hand-server 配置见 hand-server/src/config.ts
# HAND_SERVER_PORT/HAND_SERVER_AUTH_TOKEN/HAND_SERVER_SANDBOX_ROOT/HAND_SERVER_BACKEND
ENV HAND_SERVER_PORT=3300
# AUTH_TOKEN 由 docker-compose / ECS task definition 注入（不在镜像里）

EXPOSE 3300

CMD ["sh", "-c", "exec node node_modules/tsx/dist/cli.mjs hand-server/src/index.ts"]

# ─────────────────────────────────────────────────────────────
# Stage: acs-sandbox — ACS Sandbox 内执行镜像
# ─────────────────────────────────────────────────────────────
FROM acs-deps AS acs-sandbox
WORKDIR /app

COPY shared ./shared
COPY server ./server
COPY acs-orchestrator ./acs-orchestrator

ENV NODE_ENV=production
ENV ACS_WORKSPACE_PATH=/workspace
ENV DOWNLOAD_DIR=/workspace/downloads
ENV XDG_DOWNLOAD_DIR=/workspace/downloads
ENV ACS_PYTHON_WHEELHOUSE=/opt/ky-agent/python-wheels
ENV ACS_MAX_VENV_ARCHIVES=2
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_REQUIRE_VIRTUALENV=1
ENV HOME=/home/agent
ENV TZ=Asia/Shanghai
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global
ENV PATH=/home/agent/.npm-global/bin:$PATH
# Office skills Node 依赖（pptxgenjs/docx）的 fallback 解析路径；
# 项目本地 node_modules 仍优先（NODE_PATH 是 require 解析的最后一级）
ENV NODE_PATH=/opt/ky-agent/node/node_modules
# Notion/Google Workspace 官方 CLI：凭据优先由用户级连接器注入 token env；
# 仍把官方 CLI 的本地状态限定到当前用户独立 workspace，避免落入临时 HOME。
ENV NOTION_KEYRING=0 \
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/workspace/.gws
# dws warm sandbox 隔离约定（agent 无需 source .dws/env.sh）：
# 强制 token/config 写工作区 /workspace/.dws/、禁用系统凭据管理器。
# 用绝对路径而非 $PWD/.dws/…：agent 走到子目录（如 assets/YYYYMMDD/）时 token 归属不漂移。
# 本地开发（非 ACS 容器）需自行 source .dws/env.sh 或用 dws_runtime.dws_env() 显式带 env。
ENV DWS_DISABLE_KEYCHAIN=1 \
    DWS_CONFIG_DIR=/workspace/.dws/config \
    DWS_KEYCHAIN_DIR=/workspace/.dws/keys
# lark-cli 的配置与 Linux 加密 keychain 必须同时持久化；只保留其中一个会导致
# sandbox 重建后 token 无法解密。两者均落当前用户独立的 NAS workspace。
ENV LARKSUITE_CLI_CONFIG_DIR=/workspace/.lark-cli/config \
    LARKSUITE_CLI_DATA_DIR=/workspace/.lark-cli/data \
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1
# dws PATH 前置薄 wrapper（2026-08-03 方案 A）：业务动作子命令注入 --format json。
# 默认 disable（KY_DWS_WRAPPER_ENABLE=1 才启用，经 wire env 按租户灰度）；
# 真实 CLI 原样保留，wrapper fail-open。构建期 fake CLI 断言三分支，fail-fast。
COPY scripts/dws-format-wrapper.sh /opt/ky-agent/wrappers/dws
ENV PATH=/opt/ky-agent/wrappers:$PATH
RUN chmod 0755 /opt/ky-agent/wrappers/dws \
    && mkdir -p /tmp/wsmoke \
    && printf '#!/bin/bash\necho "ARGS:$*"\n' > /tmp/wsmoke/dws \
    && chmod +x /tmp/wsmoke/dws \
    && out="$(PATH="/opt/ky-agent/wrappers:/tmp/wsmoke" KY_DWS_WRAPPER_ENABLE=1 /opt/ky-agent/wrappers/dws todo task create --title x)" \
    && [ "$out" = "ARGS:todo task create --title x --format json" ] \
    && out2="$(PATH="/opt/ky-agent/wrappers:/tmp/wsmoke" /opt/ky-agent/wrappers/dws todo task list)" \
    && [ "$out2" = "ARGS:todo task list" ] \
    && out3="$(PATH="/opt/ky-agent/wrappers:/tmp/wsmoke" KY_DWS_WRAPPER_ENABLE=1 /opt/ky-agent/wrappers/dws auth status)" \
    && [ "$out3" = "ARGS:auth status" ] \
    && rm -rf /tmp/wsmoke \
    && KY_DWS_WRAPPER_ENABLE=1 dws --version
RUN groupadd -f -g 20 dialout \
    && useradd -m -u 501 -g 20 -s /bin/bash agent \
    && mkdir -p /workspace /home/agent/.npm-global/bin /home/agent/.npm-global/lib /ms-playwright \
    && chown -R 501:20 /home/agent /workspace \
    && su agent -c 'corepack prepare yarn@1.22.22 --activate && corepack prepare pnpm@10.18.3 --activate'
WORKDIR /workspace

CMD ["/bin/sh", "-c", "sleep infinity"]
