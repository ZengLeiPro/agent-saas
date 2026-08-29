FROM docker.io/library/node@sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605

WORKDIR /opt/agent-daemon

# Install the repository-authoritative pnpm version and verify its packageManager hash.
COPY package.json ./
RUN corepack enable \
    && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate

# Copy workspace files. The daemon depends on the same `server` package the
# brain uses, so we copy the whole repo. CI / multi-stage builds can prune.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/package.json
COPY hand-server/package.json ./hand-server/package.json

# Install dependencies; we only need server's runtime + tsx.
RUN pnpm install --frozen-lockfile --filter=server...

COPY server ./server

ENV NODE_ENV=production

# Daemon configuration is supplied via env vars (see client-daemon.mts).
ENV CLIENT_DAEMON_URL=""
ENV CLIENT_DAEMON_ID=""
ENV CLIENT_DAEMON_WORKSPACE_ROOT="/workspace"
ENV CLIENT_DAEMON_AUTH_TOKEN=""
ENV CLIENT_DAEMON_HAND_ID=""
ENV CLIENT_DAEMON_SESSION_ID=""
ENV CLIENT_DAEMON_WORKSPACE_ID=""

VOLUME ["/workspace"]

# Drop privileges. The node user comes from the digest-pinned Node Alpine image. Workspace mount
# permission is the operator's job.
USER node

CMD ["pnpm", "--filter=server", "exec", "tsx", "scripts/client-daemon.mts"]
