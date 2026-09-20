#!/usr/bin/env node
// SD VAE 端到端验证：起 mock sdapi，按 app.js 的真实逻辑发两次 txt2img，
// 断言「默认不使用 VAE 时请求体里没有 sd_vae」以及「选了 VAE 才下发且能拉取到列表」。
//
// 用法: node tools/verify-sd-vae.mjs
// 说明：本脚本直接跑 node 侧的等价请求，不启动浏览器；
//      它验证的是协议层（发什么 JSON）与拉取解析，前端接线由 test-image-pipeline.mjs 覆盖。

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

// 复用页面里的纯函数，保证验证的就是线上逻辑
const sandbox = { window: {}, URL, URLSearchParams, console, TextDecoder, TextEncoder, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox, { filename: 'built-in-content.js' });
vm.runInContext(readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8'), sandbox, { filename: 'core-utils.js' });
const imageUtils = sandbox.window.RPHubImageUtils;

let failures = 0;
const check = (label, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${extra}`}`);
    if (!ok) failures += 1;
};

const server = spawn(process.execPath, [join(root, 'tools/mock-sdapi.mjs'), String(PORT)], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 等 mock 起来
for (let i = 0; i < 40; i += 1) {
    try { await fetch(`${BASE}/internal/ping`); break; } catch { await sleep(100); }
}

const txt2img = async (settings) => {
    const payload = {
        prompt: 'test', negative_prompt: 'bad', steps: 28, cfg_scale: 6,
        width: 832, height: 1216, sampler_name: 'DPM++ 2M SDE Karras', scheduler: 'Karras',
        batch_size: 1, n_iter: 1, save_images: false, send_images: true
    };
    // 与 app.js generateWithSd 同一套判定
    const model = String(settings.sdModel || '').trim();
    const vae = imageUtils.resolveSdVaeOverride(settings);
    const overrideSettings = {};
    if (model) overrideSettings.sd_model_checkpoint = model;
    if (vae) overrideSettings.sd_vae = vae;
    if (Object.keys(overrideSettings).length) payload.override_settings = overrideSettings;
    if (settings.sdKeepAspectRatio) payload.override_settings_restore_afterwards = true;
    await fetch(`${BASE}/sdapi/v1/txt2img`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
};

try {
    console.log('\n1) 默认（未选 VAE）不应下发 sd_vae');
    await txt2img({ sdVae: '', sdKeepAspectRatio: true });
    let seen = (await (await fetch(`${BASE}/__requests`)).json()).at(-1);
    check('请求体里没有 sd_vae', seen.vae === undefined, `实际 vae=${JSON.stringify(seen.vae)}`);

    console.log('\n2) 选中 VAE 后才下发，且只影响本次请求');
    await txt2img({ sdVae: 'vae-ft-mse-840000-ema-pruned', sdKeepAspectRatio: true });
    seen = (await (await fetch(`${BASE}/__requests`)).json()).at(-1);
    check('sd_vae 是所选值', seen.vae === 'vae-ft-mse-840000-ema-pruned', `实际 ${seen.vae}`);

    console.log('\n3) 从 /sdapi/v1/sd-vae 拉取并归一化名字');
    const vaes = await (await fetch(`${BASE}/sdapi/v1/sd-vae`)).json();
    const names = vaes.map(imageUtils.normalizeSdVaeEntry).filter(Boolean);
    check('拉到 3 个 VAE', names.length === 3, JSON.stringify(names));
    check('只有 filename 的条目也能出名字', names.includes('kl-f8-anime2'), JSON.stringify(names));
    check('model_name 优先于 filename', names.includes('vae-ft-mse-840000-ema-pruned'), JSON.stringify(names));

    console.log('\n4) 底模与 VAE 可同时覆盖');
    await txt2img({ sdModel: 'mock-model.safetensors [abc123]', sdVae: 'sdxl_vae', sdKeepAspectRatio: true });
    seen = (await (await fetch(`${BASE}/__requests`)).json()).at(-1);
    check('两个键都在 override_settings 里', seen.vae === 'sdxl_vae' && seen.model === 'mock-model.safetensors [abc123]', JSON.stringify(seen));
} finally {
    server.kill();
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
