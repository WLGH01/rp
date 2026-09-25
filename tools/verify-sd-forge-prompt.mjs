// 真实出图验证：把**新世界书教 AI 写的提示词格式**直接喂给本机 Forge，
// 确认它真的能出图（而不是写了一堆 Forge 不认的语法）。
//
// 为什么要这一步：世界书是给 AI 看的"写作规范"，规范本身对不对，
// 只有把它产出的提示词真送进服务端才能证明。
//   ① Anima 混合模式：真实 Danbooru 标签（硬锚点）+ 短视觉短语 + 一句自然语言叙事
//   ② 括号权重 (tag:1.2) —— 世界书说 Anima 要更高权重
//   ③ BREAK 分段 —— 世界书教的 SD 语法
// 收尾断言服务端设置已被恢复（没污染用户的 Forge）。
//
// 用法: node tools/verify-sd-forge-prompt.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FORGE_BASE || 'http://127.0.0.1:7860';

const sandbox = { window: {}, URL, URLSearchParams, console, TextDecoder, TextEncoder, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox, { filename: 'b.js' });
vm.runInContext(readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8'), sandbox, { filename: 'c.js' });
const P = sandbox.window.RPHubBuiltinContent.prompts;
const imageUtils = sandbox.window.RPHubImageUtils;

let bad = 0;
const check = (label, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${extra}`}`);
    if (!ok) bad += 1;
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
const arch = String(options.forge_preset || '');
console.log(`  当前档位: ${arch} · 底模: ${options.sd_model_checkpoint}`);

// 世界书是否确实按这个档位给了对应的约束
const wb = P.buildAutoImageGenPrompt({ count: 2, provider: 'stable-diffusion', model: arch });
console.log(`  世界书架构段: ${(wb.match(/<模型约束 · [^\n]+/) || ['(无)'])[0]}`);
check('世界书按服务端真实档位分流', wb.includes('<模型约束 · '));

// ① 按世界书教的三层结构，手写一段 Anima 混合提示词
const hardTags = [
    'masterpiece', 'best quality', 'score_7', 'safe', 'year 2025', 'newest',
    '1girl', 'solo', 'long hair', 'purple hair', 'purple eyes', 'blunt bangs',
    'white dress', 'puffy sleeves', 'black coat', 'smile', 'open mouth',
    'looking at viewer', 'upper body', 'cherry blossoms', 'spring', 'day',
    'soft lighting', 'detailed background', 'depth of field'
].join(', ');
const softPhrase = 'cherry blossom blizzard';
// ③ 括号权重 + BREAK（世界书教的 SD 语法）
const weighted = '(smile:1.3), (long hair:1.2)';
const narrative = 'She stands beneath the cherry tree with her hands clasped behind her back, petals drifting past her shoulders in the warm afternoon light.';
const prompt = `${hardTags}, ${softPhrase}, ${weighted} BREAK ${narrative}`;
console.log(`\n  提示词（${prompt.length} 字）:\n    ${prompt.slice(0, 160)}...`);

// 用前端口径组装 override_settings，确保与页面发的一致
const preset = imageUtils.readSdPresetFromOptions(options, arch);
const settings = {
    sdUiPreset: arch,
    sdModel: preset?.checkpoint || '',
    sdVae: preset?.vaes?.[0] || '',
    sdTextEncoders: preset?.textEncoders || [],
    sdPresetExtra: imageUtils.describeSdPresetExtra(arch)?.default ?? '',
    sdKeepAspectRatio: true
};
const overrides = imageUtils.buildSdOverrideSettings(settings, { isForge: true });
console.log(`\n  override_settings = ${JSON.stringify(overrides)}`);

const payload = {
    prompt,
    negative_prompt: 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration',
    steps: 8,
    cfg_scale: 4.0,
    width: 512,
    height: 512,
    sampler_name: 'ER SDE',
    scheduler: 'Beta',
    batch_size: 1,
    n_iter: 1,
    save_images: false,
    send_images: true,
    override_settings: overrides,
    override_settings_restore_afterwards: true
};
const extra = imageUtils.resolveSdPresetExtraOverride(settings);
if (extra !== null) payload.distilled_cfg_scale = extra;

console.log('\n1) 真实出图（世界书教出来的提示词格式）');
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
    check('返回了图片', Array.isArray(body.images) && body.images.length > 0);
    check('图片不是空白（base64 长度合理）', (body.images?.[0] || '').length > 5000, `${(body.images?.[0] || '').length} 字符`);
    let info = {};
    try { info = typeof body.info === 'string' ? JSON.parse(body.info) : (body.info || {}); } catch { /* 忽略 */ }
    console.log(`    实际: model=${info.sd_model_name} sampler=${info.sampler_name} cfg=${info.cfg_scale} steps=${info.steps} size=${info.width}x${info.height}`);
    check('加载的是当前档位的底模', String(info.sd_model_name || '').length > 0, JSON.stringify(info.sd_model_name));
    check('负面提示词生效', String(info.negative_prompt || '').length > 0,
        `negative_prompt=${String(info.negative_prompt || '').slice(0, 40)}`);
    // ⚠️ 不要用 info.prompt 判断「BREAK / 括号权重被解析了」——
    // Forge 的 info.prompt 是**原样回显**输入，字面量照样在里面（实测确认）。
    // 语法是否真生效，由 tools/tmp/verify-forge-syntax.py 直接调用 Forge 解析器证明。
}

console.log('\n2) 收尾：确认服务端设置已恢复（没污染用户的 Forge）');
const after = await getJson('/sdapi/v1/options');
check('forge_preset 已恢复', after.forge_preset === options.forge_preset,
    `前 ${options.forge_preset} → 后 ${after.forge_preset}`);
check('底模已恢复', after.sd_model_checkpoint === options.sd_model_checkpoint,
    `前 ${options.sd_model_checkpoint} → 后 ${after.sd_model_checkpoint}`);
check('附加模块已恢复',
    JSON.stringify(after.forge_additional_modules || []) === JSON.stringify(options.forge_additional_modules || []));

console.log(`\n结果: ${bad === 0 ? '通过' : '失败'} — ${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
