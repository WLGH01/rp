# RP-Hub 一体化镜像：nginx 静态站点 + 跨设备同步服务
#
# 为什么要合并：同步服务只需在容器内部监听 127.0.0.1，由 nginx 反代 /api 就能同源访问。
# 因此不需要对外暴露第二个端口，也不再有 CORS 问题。
#
# 镜像自带站点文件与 nginx 配置，开箱即用；需要自定义时再用 bind mount 覆盖（挂载优先于镜像内文件）。
#
# 构建上下文必须是仓库根目录：
#   docker build -f docker/Dockerfile -t rp-hub:local .
# 直接拉取预构建镜像（本仓库推送到 main 时自动构建）：
#   docker pull ghcr.io/wlgh01/rp:latest

FROM nginx:alpine

# 同步服务只用 Node 内置模块，因此不需要 npm 依赖，装运行时即可。
RUN apk add --no-cache nodejs \
    && mkdir -p /data /app

# 站点文件与 nginx 配置烘焙进镜像（bind mount 可覆盖它们）。
COPY index.html /usr/share/nginx/html/index.html
COPY assets /usr/share/nginx/html/assets
COPY character /usr/share/nginx/html/character
COPY novel /usr/share/nginx/html/novel
COPY docker/default.conf /etc/nginx/conf.d/default.conf

COPY sync-server/server.js /app/server.js
COPY sync-server/json-scan.js /app/json-scan.js
COPY sync-server/base64-stream.js /app/base64-stream.js
COPY sync-server/stream-store.js /app/stream-store.js
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 同步服务只监听容器内的 127.0.0.1，端口不对外发布。
ENV SYNC_PORT=3000 \
    DATA_DIR=/data \
    NODE_ENV=production

VOLUME ["/data"]

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/api/v1/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
