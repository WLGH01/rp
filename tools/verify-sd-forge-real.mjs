// 真实 Forge 端到端验证：完全按前端 buildSdOverrideSettings 的口径发请求，
// 确认「从 SDXL 切到 Anima」在真机上真的能出图。
//
// 用法: node tools/verify-sd-forge-real.mjs [--yes]
//   不加 --yes 只做只读检查（拉能力清单），不真出图。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FORGE_BASE || 'http://127.0.0.1:7860';
const YES = process.argv.includes('--yes');

// 复用页面的纯函数，保证验证的就是线上口径
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

const getJson = async (path) => {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
};

console.log(`\n目标 Forge: ${BASE}`);
let options;
try {
    options = await getJson('/sdapi/v1/options');
} catch (error) {
    console.log(`  连不上 Forge：${error.message}`);
    process.exit(1);
}

console.log('\n1) 服务端能力探测（与设置页「拉取」同口径）');
const presets = imageUtils.parseSdUiPresetList(options);
check('解析出可用 UI Preset', presets.length > 0, JSON.stringify(presets.map(i => i.value)));
check('清单里含 anima（否则前端不会显示 Anima 选项）',
    presets.some(i => i.value === 'anima'), JSON.stringify(presets.map(i => i.value)));
console.log(`    档位: ${presets.map(i => i.value).join(', ')}`);

let modules;
try {
    modules = await getJson('/sdapi/v1/sd-modules');
} catch {
    modules = await getJson('/sdapi/v1/sd-vae');
}
const split = imageUtils.parseSdModuleList(modules, { usePath: true });
check('拆出 VAE', split.vaes.length > 0, `${split.vaes.length}`);
check('拆出 text_encoder（本次修复的重点）', split.textEncoders.length > 0, `${split.textEncoders.length}`);
console.log(`    VAE: ${split.vaes.map(i => i.label).join(', ') || '(无)'}`);
console.log(`    Text Encoder: ${split.textEncoders.map(i => i.label).join(', ') || '(无)'}`);

console.log('\n2) 读 Forge 为 anima 档位存好的配置（「套用服务端配置」按钮的口径）');
const animaPreset = imageUtils.readSdPresetFromOptions(options, 'anima');
check('anima 档位有底模', Boolean(animaPreset.checkpoint), JSON.stringify(animaPreset));
check('anima 档位有 text_encoder', animaPreset.textEncoders.length > 0, JSON.stringify(animaPreset.textEncoders));
check('anima 档位有 VAE', animaPreset.vaes.length > 0, JSON.stringify(animaPreset.vaes));
console.log(`    底模: ${animaPreset.checkpoint}`);
console.log(`    VAE : ${animaPreset.vaes.join(', ')}`);
console.log(`    TE  : ${animaPreset.textEncoders.join(', ')}`);

console.log('\n3) Shift/Distilled CFG 语义');
check('anima 的滑杆叫 Shift', imageUtils.describeSdPresetExtra('anima')?.label === 'Shift');
check('sd 架构不显示该滑杆', imageUtils.describeSdPresetExtra('sd') === null);

if (!YES) {
    console.log('\n（未加 --yes，跳过真实出图。加 --yes 可跑一次真实 Anima 出图）');
    console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${failures} 项失败`);
    process.exit(failures === 0 ? 0 : 1);
}

console.log('\n4) 真实出图：按前端口径从 SDXL 切到 Anima');
// 完全模拟设置页选好 anima 档位并点了「套用服务端配置」之后的 settings
const settings = {
    sdUiPreset: 'anima',
    sdModel: animaPreset.checkpoint,
    sdVae: animaPreset.vaes[0],
    sdTextEncoders: animaPreset.textEncoders,
    sdPresetExtra: imageUtils.describeSdPresetExtra('anima').default,
    sdKeepAspectRatio: true
};
const overrides = imageUtils.buildSdOverrideSettings(settings, { isForge: true });
console.log('    override_settings =', JSON.stringify(overrides, null, 2).replace(/\n/g, '\n    '));

const payload = {
    prompt: '1girl, solo, simple background',
    negative_prompt: 'low quality, worst quality',
    steps: 6,
    cfg_scale: 4.0,
    width: 512,
    height: 512,
    sampler_name: 'ER SDE',
    scheduler: 'Beta',
    batch_size: 1,
    n_iter: 1,
    save_images: false,
    send_images: true,
    override_settings: overrides
};
const presetExtra = imageUtils.resolveSdPresetExtraOverride(settings);
if (presetExtra !== null) payload.distilled_cfg_scale = presetExtra;
if (settings.sdKeepAspectRatio) payload.override_settings_restore_afterwards = true;

const started = Date.now();
const res = await fetch(`${BASE}/sdapi/v1/txt2img`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
});
const text = await res.text();
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`    HTTP ${res.status} · ${elapsed}s · ${text.length} bytes`);
if (!res.ok) {
    let msg = text.slice(0, 400);
    try { const j = JSON.parse(text); msg = j.message || j.detail || msg; } catch { /* 原样 */ }
    check('真实出图成功', false, msg);
} else {
    const body = JSON.parse(text);
    const info = typeof body.info === 'string' ? JSON.parse(body.info) : body.info;
    check('返回了图片', Array.isArray(body.images) && body.images.length > 0);
    check('实际加载的是 Anima 底模',
        String(info.sd_model_name || '').includes('anima'), `实际 ${info.sd_model_name}`);
    check('采样器是 Anima 的 ER SDE', info.sampler_name === 'ER SDE', `实际 ${info.sampler_name}`);
    console.log(`    实际出图: model=${info.sd_model_name} hash=${info.sd_model_hash} sampler=${info.sampler_name} cfg=${info.cfg_scale} steps=${info.steps}`);
}

console.log('\n5) 收尾：确认服务端设置已被恢复（没有污染用户的 Forge）');
const after = await getJson('/sdapi/v1/options');
check('forge_preset 已恢复', after.forge_preset === options.forge_preset,
    `前 ${options.forge_preset} → 后 ${after.forge_preset}`);
check('底模已恢复', after.sd_model_checkpoint === options.sd_model_checkpoint,
    `前 ${options.sd_model_checkpoint} → 后 ${after.sd_model_checkpoint}`);
check('附加模块已恢复',
    JSON.stringify(after.forge_additional_modules || []) === JSON.stringify(options.forge_additional_modules || []),
    `前 ${JSON.stringify(options.forge_additional_modules)} → 后 ${JSON.stringify(after.forge_additional_modules)}`);

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
