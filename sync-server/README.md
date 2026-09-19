# RP-Hub 跨设备同步服务

把浏览器 IndexedDB 里的**全部用户数据**（角色卡、聊天记录与全部分支、记忆、预设、正则、世界书、UI 模板、设置、用户资料）持久化到 unraid 的挂载目录，让手机与电脑共享同一份数据。

## 为什么需要它

RP-Hub 是纯前端应用：数据只存在**各自浏览器**的 IndexedDB 里，服务端（nginx）不保存任何内容。所以手机和电脑天然是两份互不可见的数据。本服务提供一层可选的同步：数据仍以浏览器为主存储，服务器只做中转与归档。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 健康检查，返回摘要（不含数据本体） |
| GET | `/v1/state` | 拉取完整状态快照 |
| POST | `/v1/state` | 推送状态快照 |
| GET | `/v1/status` | 仅返回摘要，用于排查 |
| GET | `/v1/images` | 生图归档统计（张数 / 占用 / 最近时间） |
| POST | `/v1/images` | 归档一张图（`data` 传 data URL 或 base64；也可传 `url`，由浏览器先取回再上传） |
| GET | `/v1/images/<日期>/<hash>.<ext>` | **读取归档原图**（内容 hash 命名，可长期缓存） |

### 生图归档：为什么需要读接口

本地 Forge（sdapi）是**一次性把 base64 塞在响应里**返回的，服务端不提供可指向的图片地址。
早先的做法是把整张 base64 存在浏览器里，于是一台设备攒 100 张就有上百 MB，
换设备看图还得各自重跑一遍生图。

现在：生成完成即归档到 `DATA_DIR/images/<日期>/<hash 前16位>.<ext>`（内容 SHA-256 去重），
浏览器缓存里只留一个几十字节的地址。换任何设备都能直接取到这张图，本机不再囤积图片。

读取有两条路，前端优先走静态、失败自动退回接口：

```nginx
# 1) 静态（快）：把归档目录直接暴露在站点同源路径下
location ^~ /images/ {
    alias /data/images/;
    autoindex off;
    add_header Cache-Control "public, max-age=604800, immutable";
}
```

```text
# 2) 接口（任何部署都可用，不需要上面那段 nginx 配置）
GET /api/v1/images/<日期>/<hash>.<ext>
```

> 路径只接受 `<年-月-日>/<十六进制 hash>.<图片后缀>`，其余（含 `..`、索引文件、脚本后缀）一律拒绝。

### 冲突策略：最后写入者胜（LWW）

推送需带 `updatedAt`（毫秒时间戳）。服务端只在时间戳**更新**时接受写入，否则返回 `409` 并附上服务端当前状态。前端据此提示用户选择「从服务器拉取」或「以本机为准覆盖」（后者带 `force: true`）。

### 请求示例

```jsonc
// POST /v1/state
{
  "version": 1,
  "deviceId": "6179e014d22e4f2e9dc5bea446bae368",
  "updatedAt": 1789761805088,
  "userAgent": "...",
  "force": false,                  // true = 跳过 LWW 检查，强制覆盖
  "payload": {                     // 数据本体
    "main":    { "rp_hub_characters": [...], "rp_hub_chat_0": [...] },
    "chargen": { "storeName": "characters", "entries": {...} },
    "local":   { "ai_chargen_api": "..." }
  }
}
```

## 数据落盘

- `state.json`：原子写（先写临时文件再 rename），避免崩溃留下半截文件。
- `images/`：生图归档（`<日期>/<hash16>.<ext>` + `index.json` 记录角色/提示词/模型/尺寸/hits）。
- `backups/state-<时间戳>.json`：每次写入前轮换备份，**双重上限**保护磁盘：
  - 份数上限 `MAX_BACKUPS`（默认 **3**）
  - 总大小上限 `MAX_BACKUP_BYTES`（默认 **10 GB**）
  - 两者都从**最旧**的开始清理，且**至少保留 1 份**。
- 写入串行化，避免并发写坏文件。

> 头像以 base64 内联存储，单份快照可能较大（角色卡多时可达数十 MB）。因此备份不能只按份数限制，否则 5 份也可能占数百 MB；总大小上限就是为此设置的护栏。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；与 nginx 同容器时用 `127.0.0.1` |
| `DATA_DIR` | `/data` | 数据目录，存放 `state.json`、`backups/` 与 `images/` |
| `MAX_BACKUPS` | `3` | 备份保留份数（最小 1） |
| `MAX_BACKUP_BYTES` | `10737418240`（10GB） | 备份目录总占用上限；设为 `0` 表示不限制 |

## 安全说明

服务无认证，**只应在内网使用**，不要直接暴露到公网。若需公网访问，请在前面加反向代理并启用认证（如 Basic Auth）。

## 本地运行

```bash
DATA_DIR=./data PORT=8791 node server.js
```
