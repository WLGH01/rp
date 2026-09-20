# RP-Hub 同步服务镜像
# 无第三方依赖，仅用 Node 内置模块，因此不需要 npm install。
FROM node:22-alpine

WORKDIR /app

# 只拷贝服务本体，保持镜像最小。
COPY server.js json-scan.js base64-stream.js stream-store.js ./

ENV PORT=3000 \
    DATA_DIR=/data \
    NODE_ENV=production

# 数据目录由外部挂载持久化。
VOLUME ["/data"]

EXPOSE 3000

# 以非 root 运行；/data 由挂载提供，启动时确保可写。
RUN mkdir -p /data && chown -R node:node /app /data
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
