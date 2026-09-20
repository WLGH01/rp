# RP-Hub 跨设备同步服务

把浏览器 IndexedDB 里的**全部用户数据**（角色卡、聊天记录与全部分支、记忆、预设、正则、世界书、UI 模板、设置、用户资料）持久化到 unraid 的挂载目录，让手机与电脑共享同一份数据。

## 为什么需要它

RP-Hub 是纯前端应用：数据只存在**各自浏览器**的 IndexedDB 里，服务端（nginx）不保存任何内容。所以手机和电脑天然是两份互不可见的数据。本服务提供一层可选的同步：数据仍以浏览器为主存储，服务器只做中转与归档。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 健康检查，返回摘要（不含数据本体） |
| GET | `/v1/state` | 拉取完整状态快照（流式转发 payload） |
| POST | `/v1/state` | 推送状态快照（payload 流式落盘） |
| GET | `/v1/status` | 仅返回摘要 + 进程内存，用于排查 |
| GET | `/v1/images` | 生图归档统计（张数 / 占用 / 最近时间） |
| POST | `/v1/images` | 归档一张图（`data` 传 data URL 或 base64；也可传 `url`，由浏览器先取回再上传） |
| GET | `/v1/images/<日期>/<hash>.<ext>` | **读取归档原图**（内容 hash 命名，可长期缓存） |

## 内存设计（为什么快照再大也不怕）

快照里约 **90% 是角色卡头像的 base64**（实测 118MB 里 105MB 是头像，聊天记录才 0.9MB），
而服务端真正要用到的只有 `updatedAt` / `deviceId` / `force` 这几个小字段。

早先的实现是「整份快照全内存」：启动 `readFile` 118MB 文本 → `JSON.parse` 成对象树
（V8 里字符串转对象树膨胀 2~4 倍）常驻内存；每次请求还 `JSON.stringify` 整份 payload ——
连 unraid 每 30 秒一次的健康检查都会凭空造一个上百 MB 的临时字符串。
实测：只推送一份 64MB 的快照，进程 RSS 就从 53MB 涨到 **671MB**。

现在 **payload 永远不进入内存**：

| 环节 | 做法 |
| --- | --- |
| 收请求 | 请求体流式落临时文件（`DATA_DIR/.tmp/`），只做顶层结构扫描 |
| 取字段 | 用 `json-scan.js` 拿到各字段的**字节区间**，只把 `updatedAt`/`deviceId`/`force` 解析出来 |
| 落盘 | payload 以原样字节从临时文件流式搬进 `state.json`（临时文件 → rename 原子替换） |
| 响应 | 按字节区间从 `state.json` 流式吐出，`Content-Length` 精确计算 |
| 健康检查 | 只读元数据；字节数取已记录的 `payloadBytes`，不做任何序列化 |

同样一份 64MB 快照：RSS 增量从 **+619MB 降到 +32MB**（约 20 倍）。
关键性质是**增量有界、与快照大小无关**（回归测试实测：30.7MB 快照 +31.2MB、
61.3MB 快照 +32.2MB）。常驻内存与快照大小解耦，角色卡再多也不会线性膨胀。

**并发一致性**：读 payload 的请求会持有一把「读锁」，写盘方改名覆盖 `state.json` 前先立旗
（挡住新读者）并等现有读者读完，改名与「发布新元数据」都在闸门内完成 ——
否则会出现「拿到旧字节区间 → 文件已被换成新内容 → 按旧区间读新文件」而切出错误数据。
之所以不用长期打开的文件句柄，是因为 Windows 不允许 rename 覆盖已打开的文件（EPERM），
用闸门可以让容器里的 Linux 与本地开发的 Windows 行为一致。
`tools/test-sync-state.mjs` 第 13 节用并发读写压测守住这条性质。

**代价**：写入时 payload 会在 `.tmp/` 里多占一份磁盘（请求体临时文件 + 新 `state.json`）。
这是拿磁盘换内存的取舍 —— 快照 118MB 时峰值约需 250MB 空闲磁盘，启动时会清理残留临时文件。

### 备份用硬链接

备份在覆盖 `state.json` **之前**把旧版本 `link()` 到 `backups/` 下，
同一份内容在文件系统里只占一份数据块（btrfs / xfs 支持；不支持时自动退回复制）。
因此 3 份 118MB 的备份不会再吃掉 294MB。

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

`sync-server/` 里的模块：

| 文件 | 作用 |
| --- | --- |
| `server.js` | HTTP 路由、状态元数据、读锁与写入闸门 |
| `json-scan.js` | 顶层字段字节区间扫描器（按字节扫描，兼容 UTF-8/转义） |
| `stream-store.js` | 请求体落盘、按区间搬运、按区间流式响应 |
| `base64-stream.js` | 增量 base64 解码（图片归档用，不整块进内存） |

## 数据落盘

- `state.json`：原子写（先写临时文件再 rename），避免崩溃留下半截文件。
- `.tmp/`：写入期间的请求体与新文件临时区，启动时自动清理。
- `images/`：生图归档（`<日期>/<hash16>.<ext>` + `index.json` 记录角色/提示词/模型/尺寸/hits）。
- `backups/state-<时间戳>.json`：每次写入前轮换备份，**双重上限**保护磁盘：
  - 份数上限 `MAX_BACKUPS`（默认 **3**）
  - 总大小上限 `MAX_BACKUP_BYTES`（默认 **10 GB**）
  - 两者都从**最旧**的开始清理，且**至少保留 1 份**。
  - 默认用硬链接（`BACKUP_HARDLINK=0` 可关掉改回整份复制）。
- 写入串行化，避免并发写坏文件。

> 头像以 base64 内联存储，单份快照可能较大（角色卡多时可达数十 MB）。因此备份不能只按份数限制，否则 5 份也可能占数百 MB；总大小上限就是为此设置的护栏。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；与 nginx 同容器时用 `127.0.0.1` |
| `DATA_DIR` | `/data` | 数据目录，存放 `state.json`、`.tmp/`、`backups/` 与 `images/` |
| `MAX_BACKUPS` | `3` | 备份保留份数（最小 1） |
| `MAX_BACKUP_BYTES` | `10737418240`（10GB） | 备份目录总占用上限；设为 `0` 表示不限制 |
| `BACKUP_HARDLINK` | `1` | 备份用硬链接；设为 `0` 改回整份复制 |

## 回归测试

```bash
node tools/test-sync-state.mjs 64   # 状态接口 + 内存回归（64MB 快照，断言 RSS）
node tools/test-json-scan.mjs       # 顶层扫描器（UTF-8 / 转义 / 分片 / 非法输入）
node tools/test-image-api.mjs       # 生图归档与目录穿越防护
node tools/test-backup-rotation.mjs # 备份双重上限
```

## 安全说明

服务无认证，**只应在内网使用**，不要直接暴露到公网。若需公网访问，请在前面加反向代理并启用认证（如 Basic Auth）。

## 本地运行

```bash
DATA_DIR=./data PORT=8791 node server.js
```
