# 三个用途（web / worker / migrate）共用同一个镜像，只是启动命令不同。
# 构建一次，三者版本永远一致。
#
# 基础镜像用 bookworm-slim 而非 alpine：既然选了内置的 node:sqlite，
# 整条依赖链是纯 JS，alpine 省下的几十 MB 换不来什么；而 musl 的
# getaddrinfo 行为与 TLS 细节在 IMAPS 长连接场景下有历史问题。
ARG NODE_VERSION=22.23-bookworm-slim

# ── 依赖 ──────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── 构建 ──────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建期不该需要真实凭证，给占位值让 env 校验通过。
# 这些值不会进入运行阶段 —— runner 阶段只 COPY 产物，不 COPY 环境。
RUN DATABASE_PATH=/tmp/build.db \
    ADMIN_PASSWORD_HASH=build-placeholder \
    SESSION_SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    TOKEN_ENC_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    PUBLIC_BASE_URL=https://placeholder.invalid \
    npm run build

# worker 必须单独打包：Next 的 standalone 只带它静态分析到的模块，
# worker 不在 Next 的依赖图里，imapflow / mailparser 不会被复制进去。
RUN npm run build:worker

# ── 运行 ──────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=UTC \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    MIGRATIONS_DIR=/app/dist/migrations

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

# standalone 产物不含静态资源，必须手动补齐这三份
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/dist ./dist

# web 与 worker 必须同一个 UID 运行，否则共享 volume 上
# WAL 的 -wal / -shm 文件会出现权限冲突
RUN mkdir -p /data/db /data/attachments && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
