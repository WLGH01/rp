# RP-Hub Docker 部署

> 本仓库是 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub) 的本地化分支，已同步至上游 **2.0.3**。
> 相对上游的改造：**全离线**（无任何 CDN）、**跨设备同步**、**四路生图引擎**、**TTS 语音**、**角色卡批量导入**、**多预设集**。
> English: [README.en.md](./README.en.md)

## 相对上游的差异

| 方面 | 本分支 |
| --- | --- |
| 第三方资源 | 全部固化在 `assets/vendor/`，**不访问任何 CDN**，断网可用（`node tools/verify-offline.mjs` 可自检） |
| 跨设备同步 | `assets/js/sync-client.js` + `sync-server/`，把浏览器 IndexedDB 全量快照持久化到服务器，手机与电脑共享同一份数据 |
| 生图引擎 | 四路可选：`novelai`（作者网关）/ `novelai-official`（官方 API）/ `stable-diffusion`（Forge·A1111）/ `comfyui` |
| TTS | `assets/js/tts-services.js`，上游没有 |
| 角色卡 | 支持批量导入（`.json` / `.png`），整批只落盘一次 |
| 预设 | 多预设集可切换，兼容导入酒馆（SillyTavern）预设 |
| 夜间模式 | `assets/js/theme.js` + `theme.css`，三个页面用 `postMessage` 同步 |

## 2.0 系列上游更新（已同步）

- **2.0.0**：全新设计 token 与配色动效、记忆引用（正文标出参考的记忆轮次，点击查看判断依据）、
  上下文查看器按系统提示词/世界书/记忆/原文分类统计、输入区与用量统计重构、
  角色卡工坊「智能修改」对比界面重构、深色模式清晰度、未启用项灰色显示、字体改为按内容自动适配
- **2.0.1**：长上下文/复杂角色卡性能优化、角色卡工坊显示思考过程、记忆系统回调准确率、toast 动画、iOS 滑动修复
- **2.0.2**：适配 Gemini-4-Argon 的 COT 输出、重新支持 Gemini 模型部分预设
- **2.0.3**：输入混淆（解决英文输入审查，Gemini 模型）
- **1.9.8**：随机生成工具支持自定义选项、部分 UI 与新手引导优化

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
| `/usr/share/nginx/html` | ro | **否（建议不挂）** | 站点根目录。镜像内已烘焙一份；**挂载会盖住镜像里的文件**，于是「拉了新镜像页面还是老版本」。要更新前端请重新构建镜像，不要用挂载覆盖 |
| `/etc/nginx/conf.d/default.conf` | ro | 否 | nginx 配置（`/api` 反代到容器内同步服务，`/llm/`、`/sd/`、`/mimo/` 为反代示例，并屏蔽 `tools/`、`sync-server/`） |

## 自检与测试

```bash
node tools/verify-offline.mjs        # 离线化自检：确认没有残留的远程资源引用
node tools/test-image-pipeline.mjs   # 生图链路（含 tag 词典、世界书分流、预设）
node tools/test-chat-presets.mjs     # 预设集与酒馆预设导入
node tools/test-tts-voice.mjs        # TTS 音色与朗读
node tools/test-sync-state.mjs       # 跨设备同步状态机
```

## 协议与许可

CC BY-NC 4.0，见 [LICENSE](./LICENSE)。本项目基于上游 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub)。
