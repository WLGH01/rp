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

// mock 以 MOCK_SD_MODE=forge 启动（见下方 spawn），模拟的就是 Forge neo。
const FORGE_MODE = true;
const lastRequest = async () => (await (await fetch(`${BASE}/__requests`)).json()).at(-1);

let failures = 0;
const check = (label, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${extra}`}`);
    if (!ok) failures += 1;
};

const server = spawn(process.execPath, [join(root, 'tools/mock-sdapi.mjs'), String(PORT)], {
    stdio: 'ignore',
    // 模拟 Forge neo：/sdapi/v1/sd-vae 返回 404，VAE 列表走 /sdapi/v1/sd-modules
    env: { ...process.env, MOCK_SD_MODE: 'forge' }
});
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
    // 与 app.js generateWithSd 同一套判定（口径已收口到 core-utils 的纯函数）。
    const overrideSettings = imageUtils.buildSdOverrideSettings(settings, { isForge: FORGE_MODE });
    if (Object.keys(overrideSettings).length) payload.override_settings = overrideSettings;
    const presetExtra = imageUtils.resolveSdPresetExtraOverride(settings);
    if (presetExtra !== null) payload.distilled_cfg_scale = presetExtra;
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

    console.log('\n3) Forge neo：/sdapi/v1/sd-vae 404 → 回退 /sdapi/v1/sd-modules');
    // 先确认 Forge 场景下 sd-vae 确实不可用
    const direct = await fetch(`${BASE}/sdapi/v1/sd-vae`);
    check('Forge 上 /sdapi/v1/sd-vae 返回 404（模拟真实环境）', direct.status === 404, `实际 HTTP ${direct.status}`);

    // 与 app.js fetchSdVaeList 同一套回退逻辑。
    // 注意：裸 fetch 对 404 不抛异常，必须自己按 response.ok 判失败，
    // 否则会把 404 的错误体当成列表（app.js 里的 fetchSdJson 已做这个判断）。
    const getJson = async (path) => {
        const res = await fetch(`${BASE}${path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    };
    const fetchSdVaeList = async () => {
        try {
            return imageUtils.parseSdVaeList(await getJson('/sdapi/v1/sd-vae'), { usePath: false });
        } catch {
            return imageUtils.parseSdVaeList(await getJson('/sdapi/v1/sd-modules'), { usePath: true });
        }
    };
    const vaes = await fetchSdVaeList();
    check('回退后能拉到 VAE（不再是 0 个）', vaes.length > 0, JSON.stringify(vaes));
    check('text_encoder 被剔除', !vaes.some(v => v.value.includes('text_encoder')), JSON.stringify(vaes));
    check('VAE 项被保留', vaes.some(v => v.value.includes('qwenimagevae_v7')), JSON.stringify(vaes));
    check('value 是绝对路径（Forge 要求）',
        vaes.every(v => /^[A-Za-z]:\\/.test(v.value)), JSON.stringify(vaes));
    check('label 是可读名字', vaes.every(v => !v.label.includes('\\')), JSON.stringify(vaes));

    console.log('\n3b) Forge 下 sd_vae 必须下发绝对路径');
    await txt2img({ sdVae: vaes[0].value, sdKeepAspectRatio: true });
    seen = (await (await fetch(`${BASE}/__requests`)).json()).at(-1);
    check('下发的 sd_vae 是绝对路径', /^[A-Za-z]:\\/.test(seen.vae || ''), `实际 ${seen.vae}`);

    console.log('\n4) 底模与 VAE 可同时覆盖');
    await txt2img({ sdModel: 'mock-model.safetensors [abc123]', sdVae: vaes[0].value, sdKeepAspectRatio: true });
    seen = await lastRequest();
    check('两个键都在 override_settings 里', seen.vae === vaes[0].value && seen.model === 'mock-model.safetensors [abc123]', JSON.stringify(seen));

    // --- Forge UI Preset：从 SDXL 切到 Anima 这条链路（本次需求）---
    console.log('\n5) Forge：UI Preset + 附加模块（Anima 的关键）');
    const animaVae = 'D:\\Stable-diffusion\\sd-webui\\models\\VAE\\qwenimagevae_v7.safetensors';
    const animaTe = 'D:\\Stable-diffusion\\sd-webui\\models\\text_encoder\\qwen_3_06b_base.safetensors';
    await txt2img({
        sdUiPreset: 'anima',
        sdModel: 'anima-base-v1.0.safetensors',
        sdVae: animaVae,
        sdTextEncoders: [animaTe],
        sdPresetExtra: 3.0,
        sdKeepAspectRatio: true
    });
    seen = await lastRequest();
    check('下发 forge_preset=anima', seen.preset === 'anima', `实际 ${seen.preset}`);
    check('下发 Anima 底模', seen.model === 'anima-base-v1.0.safetensors', `实际 ${seen.model}`);
    // 核心：VAE 与 text_encoder 必须一起走附加模块；text_encoder 是 Anima 能加载的前提。
    check('VAE 与 text_encoder 一起走 forge_additional_modules',
        Array.isArray(seen.modules) && seen.modules.length === 2, JSON.stringify(seen.modules));
    check('附加模块里含 text_encoder（以前被代码剔掉，选不到）',
        Array.isArray(seen.modules) && seen.modules.includes(animaTe), JSON.stringify(seen.modules));
    check('此时不再单独发 sd_vae（避免两条路打架）', seen.vae === undefined, `实际 vae=${JSON.stringify(seen.vae)}`);
    check('下发 Shift/Distilled CFG（顶层字段）', seen.dcfg === 3.0, `实际 ${seen.dcfg}`);
    check('开了「保持宽高比」→ 请求带恢复标记', seen.restore === true, `实际 ${seen.restore}`);

    console.log('\n5b) 只选 VAE（未选 text_encoder）→ 仍走 sd_vae，不整份替换模块');
    await txt2img({ sdVae: animaVae, sdKeepAspectRatio: true });
    seen = await lastRequest();
    check('走 sd_vae', seen.vae === animaVae, `实际 ${seen.vae}`);
    check('不发附加模块（不会把服务端其它模块弄丢）', seen.modules === undefined, JSON.stringify(seen.modules));

    console.log('\n6) 服务端档位清单：从 /sdapi/v1/options 读出可用 UI Preset 与该档位配置');
    const options = await (await fetch(`${BASE}/sdapi/v1/options`)).json();
    const presets = imageUtils.parseSdUiPresetList(options);
    check('解析出服务端真实档位（mock 提供 sd/xl/anima/qwen）',
        presets.map(i => i.value).sort().join(',') === 'anima,qwen,sd,xl', JSON.stringify(presets));
    check('档位带可读标签（anima → Anima）',
        presets.find(i => i.value === 'anima')?.label.includes('Anima') === true,
        JSON.stringify(presets.find(i => i.value === 'anima')));
    const animaFromServer = imageUtils.readSdPresetFromOptions(options, 'anima');
    check('读出 anima 档位存好的底模',
        animaFromServer.checkpoint === 'anima-base-v1.0.safetensors', animaFromServer.checkpoint);
    check('读出 anima 档位的 text_encoder（一键套用就靠它）',
        animaFromServer.textEncoders.includes(animaTe), JSON.stringify(animaFromServer.textEncoders));
    check('读出 anima 档位的 VAE',
        animaFromServer.vaes.includes(animaVae), JSON.stringify(animaFromServer.vaes));
    // 反向：xl 档位没有附加模块，套用后不该把 Anima 的 text_encoder 带过来
    const xlFromServer = imageUtils.readSdPresetFromOptions(options, 'xl');
    check('xl 档位没有 text_encoder（不会把 Anima 的模块串到 SDXL）',
        xlFromServer.textEncoders.length === 0, JSON.stringify(xlFromServer.textEncoders));

    console.log('\n7) 反向验证：不选 UI Preset / 不选模块时，一个 forge 键都不许发');
    await txt2img({ sdKeepAspectRatio: true });
    seen = await lastRequest();
    check('没有 forge_preset', seen.preset === undefined, `实际 ${seen.preset}`);
    check('没有 forge_additional_modules', seen.modules === undefined, JSON.stringify(seen.modules));
    check('没有 sd_vae', seen.vae === undefined, `实际 ${seen.vae}`);
    check('没有 distilled_cfg_scale', seen.dcfg === undefined, `实际 ${seen.dcfg}`);
    check('请求体里没有 override_settings 这个空壳',
        seen.vae === undefined && seen.model === undefined && seen.preset === undefined,
        JSON.stringify(seen));
} finally {
    server.kill();
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
