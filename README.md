# RP-Hub Docker 部署

## 镜像

预构建镜像（推送到 `main` 时自动构建，`linux/amd64` + `linux/arm64`）：

```bash
docker pull ghcr.io/wlgh01/rp:latest
```

本地构建（构建上下文必须是仓库根目录）：

```bash
docker build -f docker/Dockerfile -t rp-hub:local .
```

## 运行

```bash
docker run -d \
  --name rp-hub \
  -p 18080:80 \
  -v /path/to/rp-hub/data:/data \
  --restart unless-stopped \
  ghcr.io/wlgh01/rp:latest
```

容器只暴露 `80` 一个端口，站点页面与 `/api` 同步接口共用；访问 `http://<主机IP>:18080`。

docker compose：

```yaml
services:
  rp-hub:
    image: ghcr.io/wlgh01/rp:latest
    container_name: rp-hub
    ports:
      - "18080:80"
    volumes:
      - /path/to/rp-hub/data:/data
    restart: unless-stopped
```

## 挂载目录

| 容器内路径 | 模式 | 必填 | 说明 |
| --- | --- | --- | --- |
| `/data` | rw | 是 | 数据目录：同步数据 `state.json`、备份 `backups/`，以及图片归档 `images/`（由站点以 `/images/` 提供）。容器删除重建后数据仍在这里，**不要删** |
| `/usr/share/nginx/html` | ro | 否 | 站点根目录。镜像内已烘焙一份，挂载后以挂载内容为准 |
| `/etc/nginx/conf.d/default.conf` | ro | 否 | nginx 配置（`/api` 反代到容器内同步服务，`/llm/`、`/sd/` 为待修改的反代示例，并屏蔽 `tools/`、`sync-server/`）。挂载后以挂载内容为准 |
