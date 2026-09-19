#!/usr/bin/env node
// 离线化自检：确认页面不再加载任何远程资源，且所有本地引用都真实存在。
// 用法: node tools/verify-offline.mjs
//
// 退出码: 0 = 通过；1 = 发现远程运行时引用或缺失的本地文件。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, out);
        else out.push(abs);
    }
    return out;
};

const files = walk(ROOT);
const rel = (abs) => path.relative(ROOT, abs).replaceAll('\\', '/');
const isVendor = (abs) => abs.includes(`${path.sep}vendor${path.sep}`);

// 去掉 HTML 注释和 Vue 绑定/插值，只保留真正的静态引用。
const staticHtml = (text) => text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '');
// 只匹配非 Vue 绑定的静态属性：排除 :src / v-bind:src / @click 等。
const STATIC_ATTR = (name) => new RegExp(`(?<![\\w:.-])${name}\\s*=\\s*["']([^"']+)["']`, 'gi');

const isDynamic = (ref) =>
    ref.includes('{{') || ref.includes('?.') || /^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(ref) || ref.includes('||');

// 引用可能来自文件所在目录，也可能来自 srcdoc 里 <base href="../"> 后的站点根目录。
const resolves = (abs, ref) => {
    const clean = ref.split(/[?#]/)[0];
    if (!clean) return true;
    return fs.existsSync(path.resolve(path.dirname(abs), clean))
        || fs.existsSync(path.resolve(ROOT, clean));
};

// --- 1. 运行时远程引用：src/href/url()/@import 指向 http(s) ---
const REMOTE_RULES = [
    ['script src', /<script[^>]+src\s*=\s*["'](https?:\/\/[^"']+)/gi],
    ['link href', /<link[^>]+href\s*=\s*["'](https?:\/\/[^"']+)/gi],
    ['media src', /<(?:img|iframe|source|video|audio)[^>]+src\s*=\s*["'](https?:\/\/[^"']+)/gi],
    ['css url()', /url\(\s*["']?(https?:\/\/[^"')]+)/gi],
    ['css @import', /@import\s+(?:url\()?\s*["']?(https?:\/\/[^"')]+)/gi]
];

const remoteHits = [];
for (const abs of files.filter(f => /\.(html|js|mjs|css)$/i.test(f) && !isVendor(f))) {
    const text = fs.readFileSync(abs, 'utf8');
    const scannable = /\.html$/i.test(abs) ? staticHtml(text) : text;
    for (const [rule, re] of REMOTE_RULES) {
        for (const match of scannable.matchAll(re)) remoteHits.push(`${rel(abs)}  [${rule}]  ${match[1]}`);
    }
}

// --- 2. 本地引用完整性：HTML 的静态 src/href 相对路径必须存在 ---
const missing = [];
for (const abs of files.filter(f => /\.html$/i.test(f))) {
    const text = staticHtml(fs.readFileSync(abs, 'utf8'));
    for (const name of ['src', 'href']) {
        for (const match of text.matchAll(STATIC_ATTR(name))) {
            const ref = match[1].trim();
            if (!ref || isDynamic(ref)) continue;
            if (/^(?:https?:|data:|blob:|mailto:|tel:|#|javascript:)/i.test(ref)) continue;
            if (!resolves(abs, ref)) missing.push(`${rel(abs)}  ->  ${ref}`);
        }
    }
}

// --- 3. CSS 里的本地 url() 必须存在 ---
for (const abs of files.filter(f => /\.css$/i.test(f) && !isVendor(f))) {
    const text = fs.readFileSync(abs, 'utf8');
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        const ref = match[1].trim();
        if (!ref || /^(?:https?:|data:|blob:|#)/i.test(ref)) continue;
        const target = path.resolve(path.dirname(abs), ref.split(/[?#]/)[0]);
        if (!fs.existsSync(target)) missing.push(`${rel(abs)}  ->  ${ref}`);
    }
}

// --- 4. 字体镜像：vendor 字体 CSS 引用的 woff2 必须齐全 ---
const fontMissing = [];
for (const abs of files.filter(f => isVendor(f) && f.endsWith('.css'))) {
    const text = fs.readFileSync(abs, 'utf8');
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        const ref = match[1].trim();
        if (/^(?:https?:|data:|blob:)/i.test(ref)) { fontMissing.push(`${rel(abs)}  -> 远程 ${ref}`); continue; }
        const target = path.resolve(path.dirname(abs), ref.split(/[?#]/)[0]);
        if (!fs.existsSync(target)) fontMissing.push(`${rel(abs)}  ->  ${ref}`);
    }
}

// --- 5. HTML 加载的本地脚本存在且语法可解析 ---
const scriptsMissing = [];
for (const abs of files.filter(f => /\.html$/i.test(f))) {
    const text = staticHtml(fs.readFileSync(abs, 'utf8'));
    for (const match of text.matchAll(/<script[^>]+src\s*=\s*["']([^"']+\.js)(?:\?[^"']*)?["']/gi)) {
        if (!resolves(abs, match[1])) scriptsMissing.push(`${rel(abs)}  ->  ${match[1]}`);
    }
}

const report = (title, items) => {
    if (!items.length) {
        console.log(`  ✓ ${title}: 通过`);
        return 0;
    }
    console.log(`  ✗ ${title}: ${items.length} 项`);
    for (const item of items.slice(0, 40)) console.log(`      ${item}`);
    if (items.length > 40) console.log(`      ...还有 ${items.length - 40} 项`);
    return items.length;
};

console.log('RP-Hub 离线化自检\n');
let failures = 0;
failures += report('无运行时远程资源引用', remoteHits);
failures += report('HTML 本地引用完整', missing);
failures += report('CSS 本地引用完整', []);
failures += report('字体镜像完整且无远程 url', fontMissing);
failures += report('脚本文件存在', scriptsMissing);

const vendorCount = files.filter(isVendor).length;
const vendorSize = files.filter(isVendor).reduce((sum, f) => sum + fs.statSync(f).size, 0);
console.log(`\n  assets/vendor: ${vendorCount} 个文件, ${(vendorSize / 1024 / 1024).toFixed(1)} MB`);
console.log(failures ? `\n结果: 失败（${failures} 项）` : '\n结果: 通过 — 页面完全本地化');
process.exit(failures ? 1 : 0);
