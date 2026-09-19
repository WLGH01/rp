#!/bin/sh
# RP-Hub 一体化容器入口：同时拉起同步服务与 nginx。
#
# 设计：nginx 保持 PID 1（信号处理正确），同步服务放在后台守护，
#       崩了就自动重启，不影响静态站点。

set -eu

SYNC_PORT="${SYNC_PORT:-3000}"
DATA_DIR="${DATA_DIR:-/data}"

echo "[entrypoint] 数据目录: ${DATA_DIR}"
mkdir -p "${DATA_DIR}" "${DATA_DIR}/backups"

# 后台守护同步服务：只监听回环地址，由 nginx 反代 /api 访问，不对外暴露端口。
(
    while true; do
        echo "[entrypoint] 启动同步服务 (127.0.0.1:${SYNC_PORT})"
        PORT="${SYNC_PORT}" HOST=127.0.0.1 DATA_DIR="${DATA_DIR}" node /app/server.js || {
            echo "[entrypoint] 同步服务退出（code $?），3 秒后重启" >&2
        }
        sleep 3
    done
) &

# nginx 作为主进程前台运行，容器生命周期与它绑定。
exec nginx -g 'daemon off;'
