#!/usr/bin/env node
// 把 RP-Hub 运行期需要的远程资源固化到 assets/vendor/，让页面完全离线运行。
// 用法: node tools/fetch-vendor.mjs
//
// 注意: 本机 schannel 直连 HTTPS 会报 SEC_E_NO_CREDENTIALS，本脚本走 Node/OpenSSL，
//       因此能正常下载。不要为了绕过该问题去改 registry 或关闭证书校验。

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VENDOR = path.join(ROOT, 'assets', 'vendor');
// Google Fonts 只有带浏览器 UA 时才返回 woff2，否则会给 ttf。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const get = async (url) => {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return Buffer.from(await res.arrayBuffer());
};

const writeFile = async (abs, buf) => {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
    return buf.length;
};

const pool = async (items, limit, worker) => {
    const queue = [...items.entries()];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) {
            const [index, item] = queue.shift();
            await worker(item, index);
        }
    }));
};

const manifest = { generatedAt: new Date().toISOString(), note: 'RP-Hub 本地化第三方资源；由 tools/fetch-vendor.mjs 生成。', libraries: [], fonts: [] };

// --- 1. 前端库：每个条目给出显式源 URL（与原项目引用的 CDN 保持一致） ---
const libraries = [
    { name: 'vue', version: '3.5.43', out: 'vue/vue.global.prod.js', license: 'MIT', usedBy: 'index.html, character/index.html, novel/index.html',
      urls: ['https://unpkg.com/vue@3.5.43/dist/vue.global.prod.js'] },
    { name: 'marked', version: '15.0.12', out: 'marked/marked.min.js', license: 'MIT', usedBy: 'index.html, novel/index.html',
      urls: ['https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js', 'https://unpkg.com/marked@15.0.12/marked.min.js'] },
    { name: 'dompurify', version: '3.0.6', out: 'dompurify/purify.min.js', license: 'MPL-2.0 OR Apache-2.0', usedBy: 'index.html',
      urls: ['https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js'] },
    { name: 'sortablejs', version: '1.15.6', out: 'sortablejs/Sortable.min.js', license: 'MIT', usedBy: 'index.html',
      urls: ['https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js'] },
    { name: 'localforage', version: '1.10.0', out: 'localforage/localforage.min.js', license: 'Apache-2.0', usedBy: 'character/index.html',
      urls: ['https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js'] },
    { name: 'jquery', version: '3.7.1', out: 'jquery/jquery.min.js', license: 'MIT', usedBy: 'data-services.js 执行型 HTML iframe 运行时垫片',
      urls: ['https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js'] },
    { name: 'daisyui', version: '4.7.2', out: 'daisyui/daisyui-4.7.2.full.min.css', license: 'MIT', usedBy: 'character/index.html',
      urls: ['https://cdn.jsdelivr.net/npm/daisyui@4.7.2/dist/full.min.css'] },
    { name: 'tailwindcss-play-cdn', version: '3.4.16', out: 'tailwind/tailwind-play.js', license: 'MIT', usedBy: 'index.html, character/index.html, novel/index.html',
      urls: ['https://cdn.tailwindcss.com/3.4.16'] }
];

console.log('== 前端库 ==');
for (const item of libraries) {
    let done = false;
    for (const url of item.urls) {
        try {
            const size = await writeFile(path.join(VENDOR, item.out), await get(url));
            console.log(`  ✓ ${item.out}  (${item.name}@${item.version}, ${(size / 1024).toFixed(0)} KB)`);
            manifest.libraries.push({ name: item.name, version: item.version, out: item.out, source: url, size, license: item.license, usedBy: item.usedBy });
            done = true;
            break;
        } catch (error) {
            console.warn(`  · ${error.message}`);
        }
    }
    if (!done) {
        console.error(`  ✗ ${item.name} 全部源失败`);
        process.exitCode = 1;
    }
}

// --- 2. Google Fonts：抓取 CSS 并把每个 woff2 镜像到本地 ---
console.log('== 字体 ==');
const fontSheets = [
    { name: 'lora', url: 'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400..700;1,400..700&display=swap', usedBy: 'index.html, character/index.html' },
    { name: 'novel', url: 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600;700&family=Ma+Shan+Zheng&display=swap', usedBy: 'novel/index.html' }
];

for (const sheet of fontSheets) {
    const rawCss = (await get(sheet.url)).toString('utf8');
    // 只保留 latin/latin-ext（Lora）与中文分片，全部落到本地 gstatic/ 目录。
    const urls = [...new Set([...rawCss.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(match => match[1]))];
    console.log(`  ${sheet.name}: ${urls.length} 个字体分片`);

    const localFor = (url) => `gstatic/${url.replace('https://fonts.gstatic.com/', '')}`;
    await pool(urls, 12, async (url) => {
        await writeFile(path.join(VENDOR, 'fonts', localFor(url)), await get(url));
    });

    // CSS 落在 assets/vendor/fonts/<name>.css，所以 gstatic/... 相对路径可直接解析。
    const localized = rawCss.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g, (_all, url) => `url(${localFor(url)})`);
    const cssOut = `fonts/${sheet.name}.css`;
    const size = await writeFile(path.join(VENDOR, cssOut), Buffer.from(localized, 'utf8'));
    console.log(`  ✓ ${cssOut}  (${(size / 1024).toFixed(0)} KB)`);
    manifest.fonts.push({ name: sheet.name, sourceCss: sheet.url, out: cssOut, files: urls.length, usedBy: sheet.usedBy });
}

await writeFile(path.join(VENDOR, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
console.log('\n完成，清单写入 assets/vendor/manifest.json');
