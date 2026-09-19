# 第三方组件声明 (Third-Party Notices)

本项目的 `assets/vendor/` 目录包含从上游分发的第三方组件，用于让页面完全离线运行。
以下组件版权归各自作者所有，按其原始许可证分发。各文件均保留上游的许可证声明。

| 组件 | 版本 | 许可证 | 上游 |
| --- | --- | --- | --- |
| Vue | 3.5.43 | MIT | https://github.com/vuejs/core |
| Tailwind CSS（Play CDN 构建） | 3.4.16 | MIT | https://github.com/tailwindlabs/tailwindcss |
| marked | 15.0.12 | MIT | https://github.com/markedjs/marked |
| DOMPurify | 3.0.6 | Apache-2.0 OR MPL-2.0 | https://github.com/cure53/DOMPurify |
| SortableJS | 1.15.6 | MIT | https://github.com/SortableJS/Sortable |
| localForage | 1.10.0 | Apache-2.0 | https://github.com/localForage/localForage |
| jQuery | 3.7.1 | MIT | https://github.com/jquery/jquery |
| daisyUI | 4.7.2 | MIT | https://github.com/saadeghi/daisyui |
| Lora 字体 | — | SIL Open Font License 1.1 | https://fonts.google.com/specimen/Lora |
| Noto Serif SC 字体 | — | SIL Open Font License 1.1 | https://fonts.google.com/noto/specimen/Noto+Serif+SC |
| Ma Shan Zheng 字体 | — | SIL Open Font License 1.1 | https://fonts.google.com/specimen/Ma+Shan+Zheng |

## 说明

- 字体文件由 Google Fonts 提供的 CSS 中的 `fonts.gstatic.com` 分片镜像而来，仅包含上游 CSS 已声明的字重与字符子集。
- `assets/vendor/providers/` 下的三个图标（DeepSeek、OpenRouter、SiliconFlow）取自各服务站点，仅用于界面中的提供商标识，版权归各服务方所有。
- `assets/vendor/manifest.json` 记录了每个文件的来源 URL、版本与许可证。

## 重新生成

```bash
node tools/fetch-vendor.mjs      # 重新拉取并写入 assets/vendor/
node tools/verify-offline.mjs    # 校验无远程引用、本地引用与字体镜像完整
```

升级任一组件后，请同步更新上表的版本号。
