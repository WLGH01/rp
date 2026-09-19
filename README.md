# Roleplay Hub

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Vue](https://img.shields.io/badge/Vue-3-4FC08D.svg?logo=vue.js)](https://vuejs.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![DaisyUI](https://img.shields.io/badge/DaisyUI-5A0EF8?logo=daisyui&logoColor=white)](https://daisyui.com/)

> **一款纯前端运行的本地角色扮演（Roleplay）对话和角色卡生成工具。**

**【免责与授权声明】**  
本项目基于 **[CC BY-NC 4.0（知识共享-署名-非商业性使用 4.0 国际许可协议）](./LICENSE)** 开源。**明确禁止任何形式的商业化使用（包括但不限于：作为收费服务提供、打包在付费产品中售卖、在产品内植入广告盈利等）。** 任何使用者必须遵守该协议，尊重原作者的署名权。对于违反协议的商业行为，保留追究法律责任的权利。

---

## 核心特性 (Features)

Roleplay Hub 致力于提供流畅、私密且功能强大的本地化AI Roleplay体验。

- **完全离线运行**：所有前端资源（Vue、Tailwind、marked、DOMPurify、SortableJS、localForage、daisyUI、jQuery）与字体均已固化到 `assets/vendor/`，页面不加载任何远程 CDN。
- **仅通过你自填的 API 联网**：除你在设置中填写的 API 地址外，应用不向任何第三方服务发起请求。
- 角色卡、世界书、正则脚本和多用户资料管理
- 总结记忆与向量记忆，可按角色和剧情分支独立保存
- 剧情分支创建、切换、回档、重命名和完整导入导出
- UI 模板变量分析与对话状态展示
- 自动生图、单张重新生成和多套内置画师风格
- 角色卡生成与“墨韵 · 造梦”在线工具

## 快速开始 (Quick Start)

本项目无需复杂的 Node.js 环境或依赖安装，即开即用！

### 1. 下载与运行
1. 点击项目主页绿色的 `Code` 按钮，选择 `Download ZIP`。
2. 将下载的 ZIP 压缩包解压到您的本地任意文件夹中。
3. 双击打开 `index.html` 文件，即可在浏览器（推荐 Chrome / Edge / Firefox）中启动 Roleplay Hub。

*(注：如果您遇到跨域或本地文件读取权限问题，可以尝试使用 VS Code 的 `Live Server` 插件，或简单的本地服务器工具来运行该目录。但在绝大多数现代浏览器中，双击 index.html 即可正常使用所有核心功能。)*

### 2. 初始化设置
1. 打开应用后，点击侧边栏（或顶部菜单）的**设置 (Settings)** 选项。
2. 选择自定义配置，填入您自己的或第三方提供的 API 节点 (`API URL`)。
3. 填入对应的 `API Key`，并输入或选择您想使用的 `模型名称 (Model)`。
4. 如需自动生图，在**生图设置**里填入你自己的生图接口地址与密钥；留空则不启用，应用不会访问任何内置生图服务。
5. 在**角色管理**界面，导入您的角色卡文件（或点击新建角色并手动填写设定）。
6. 回到对话界面，开始属于您的 Roleplay 旅程

---

## 跨设备同步 (Cross-Device Sync)

RP-Hub 的数据默认只存在**各自浏览器**的 IndexedDB 里，所以手机和电脑天然是两份互不可见的数据。若需要共享（例如手机和电脑用同一份角色卡与聊天记录），可使用随附的同步服务：

- 服务本体在 `sync-server/`，无第三方依赖，数据以单个 JSON 快照持久化到挂载目录。
- 前端在**设置 → 跨设备同步**里操作：`立即同步` / `从服务器拉取` / `以本机为准覆盖`。
- 冲突策略为**最后写入者胜（LWW）**：服务器上有更新数据时，本机推送会被拒绝并提示，避免误覆盖。

同步地址通过 `index.html` 里的 `<meta name="rphub-sync-api">` 配置，默认 `/api`。留空即关闭同步。

### 一体化部署（推荐）

`docker/` 提供了把 nginx 与同步服务合并进**单个容器**的构建文件。同步服务仅在容器内 `127.0.0.1:3000` 监听，由 nginx 反代 `/api`：

- **只暴露一个端口**（80），同步服务不对外开端口，比独立容器更安全；
- 前端同源访问 `/api`，无 CORS 问题。

#### 方式 A：直接拉预构建镜像（最省事）

推送到 `main`（或打 `v*` tag）时，GitHub Actions 会自动构建并推送多架构镜像（linux/amd64 + linux/arm64）：

```bash
docker pull ghcr.io/wlgh01/rp:latest

docker run -d --name RP-Hub --restart unless-stopped \
  -p 18080:80 \
  -v /path/to/data:/data \
  ghcr.io/wlgh01/rp:latest
```

镜像里已经自带站点文件与 nginx 配置，只需要挂一个 `/data` 就能用。若要覆盖站点文件或 nginx 配置（例如把 `/llm/`、`/sd/` 反代指到你自己的服务），再加两个挂载即可：

```bash
  -v /path/to/www:/usr/share/nginx/html:ro \
  -v /path/to/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro \
```

> **提示**：GHCR 新建的包默认是 Private，可见性不会从仓库继承。要让别人能匿名 `docker pull`，
> 需在 `Profile → Packages → rp → Package settings → Change visibility` 里改成 **Public**（一次性操作）。

#### 方式 B：本地自行构建

```bash
# 在仓库根目录执行
docker build -f docker/Dockerfile -t rp-hub:local .

docker run -d --name RP-Hub --restart unless-stopped \
  -p 18080:80 \
  -v /path/to/www:/usr/share/nginx/html:ro \
  -v /path/to/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /path/to/data:/data \
  rp-hub:local
```

三个挂载：站点文件、nginx 配置、以及**数据目录 `/data`**（`state.json` 与 `backups/` 落在这里，因此容器重建不会丢数据）。

详见 [`sync-server/README.md`](./sync-server/README.md) 与 [`docker/Dockerfile`](./docker/Dockerfile)。

> **注意**：同步服务仅用于内网，未内置认证。若需公网访问，请自行在前置反向代理上启用认证。

---

## 本地化与离线说明 (Offline & Privacy)

本仓库已做完整离线化改造：

- 所有第三方前端库与字体都放在 `assets/vendor/`，页面只引用本地相对路径，**不加载任何远程 CDN**。
- 已移除原项目内置的远程在线服务：万相广场（远程 iframe）、在线人数/版本检查接口（`presence-server`）、项目作者的 API 网关与「获取 API / 生图密钥」外链。
- 运行期唯一会联网的地方，是你在设置里自己填写的 API 地址（对话、模型列表）与生图接口地址。

### 重新拉取第三方资源

`assets/vendor/` 由脚本生成。若要升级依赖或补回资源，执行：

```bash
node tools/fetch-vendor.mjs
```

脚本通过 Node 原生 fetch（OpenSSL）下载，并把结果写入 `assets/vendor/`，同时生成 `assets/vendor/manifest.json` 记录每个文件的来源 URL 与版本。

### 本地预览

```bash
node tools/serve.mjs        # 默认 http://127.0.0.1:8788/
node tools/serve.mjs 9000   # 指定端口
```

---

## 目录结构 (Directory Structure)

```text
Roleplay-Hub/
├── .github/
│   └── workflows/
│       └── docker-publish.yml     # 推送到 main 即构建并发布 ghcr.io 镜像
├── index.html                     # 主界面与脚本加载入口
├── character/                     # 角色卡生成工具
│   └── index.html
├── novel/                         # 墨韵 · 造梦
│   └── index.html
├── sync-server/                   # 可选的跨设备同步服务（Node，无依赖）
│   ├── server.js
│   ├── Dockerfile                 # 独立部署用
│   └── README.md
├── docker/                        # 一体化镜像（nginx + 同步服务，单端口）
│   ├── Dockerfile
│   ├── entrypoint.sh
│   └── default.conf               # nginx 站点配置（含 /api 内部反代）
├── tools/                         # 开发辅助脚本（不影响页面运行）
│   ├── fetch-vendor.mjs           # 拉取并本地化第三方资源
│   ├── mock-sdapi.mjs             # 假的 sdapi 服务（本地验证生图链路）
│   ├── test-image-pipeline.mjs    # 生图链路回归测试
│   └── serve.mjs                  # 本地静态预览服务（含 /api 代理）
├── assets/
│   ├── css/
│   │   └── styles.css             # 全局样式
│   ├── js/
│   │   ├── built-in-content.js    # 默认预设、模式提示词、画师串与更新公告
│   │   ├── core-utils.js          # 通用工具、角色卡处理与基础配置
│   │   ├── data-services.js       # 存储、记忆、上下文、分支与 UI 状态
│   │   ├── runtime-services.js    # API 请求、消息渲染与运行状态
│   │   ├── sync-client.js         # 跨设备同步客户端（可选）
│   │   ├── ui-components.js       # 选择器、侧边栏、弹窗与页面组件
│   │   └── app.js                 # 主业务入口与页面状态
│   └── vendor/                    # 本地化的第三方库与字体（离线运行）
└── README.md                      # 项目说明
```

### 代码组织说明

页面会按照上方顺序加载 JavaScript 文件，请不要随意调整依赖顺序。

- 修改默认预设、各模式提示词、生图画师串或工具说明时，统一编辑 `built-in-content.js`。
- 更新公告固定放在 `built-in-content.js` 最底部，方便查找和替换。
- 可复用界面统一放在 `ui-components.js`，业务数据处理放在 `data-services.js`。
- 项目没有构建步骤，修改后刷新浏览器即可验证。

---

## 协议与许可 (License)

> **来源署名**：本项目是 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub) 的二次开发版本，
> 主要改动为：全量离线化（去 CDN）、跨设备同步服务、单容器单端口部署、
> 双生图引擎（NovelAI + 本地 Stable Diffusion）与多生图预设管理。
> 上游原始作品与二次开发部分均按下方协议发布。

本项目严格遵守以下开源协议：

**[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)**

* **您可以**：自由地共享（在任何媒介以任何形式复制、发行本作品）与演绎（修改、转换或以本作品为基础进行创作）。
* **您必须**：
  * **署名 (Attribution)**：给出适当的署名，提供指向本许可协议的链接，同时标明是否对原始作品作了修改。
  * **非商业性使用 (NonCommercial)**：**您不得将本作品或演绎作品用于任何商业目的。** 禁止任何形式的售卖、付费订阅集成或利用本项目进行广告牟利。
* 若要获取本项目的商业授权，请直接联系项目原作者。

详细许可条款请参见根目录下的 [`LICENSE`](./LICENSE) 文件。
