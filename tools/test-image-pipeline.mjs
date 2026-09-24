// 生图链路回归测试
//
// 覆盖两个真实出现过的 bug：
//   1. 切换生图地址后，用「旧地址」生成的历史图片消失
//      —— 根因：缓存回放时用「当前地址」重新拼旧 job 的 content URL，新服务不认识该 job。
//      修复：生成成功时把绝对地址固化成 resolvedUrl，回放优先用它。
//   2. SD 需要自定义分辨率（长宽）与按比例出图
//      —— 新增 sdCustomSizeEnabled / sdCustomWidth / sdCustomHeight + 比例预设。
//
// 被测对象是 assets/js/core-utils.js 的 window.RPHubImageUtils（纯函数），
// 页面里 app.js 只是接线，因此这里通过的断言等价于线上逻辑。
//
// 用法：node tools/test-image-pipeline.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- 在 Node 里加载浏览器脚本 ---
const sandbox = {
    window: {},
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    atob: globalThis.atob,
    btoa: globalThis.btoa
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
// core-utils 依赖 built-in-content（画师串等），按 index.html 的加载顺序先注入。
vm.runInContext(readFileSync(join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox, { filename: 'built-in-content.js' });
vm.runInContext(readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8'), sandbox, { filename: 'core-utils.js' });

const imageUtils = sandbox.window.RPHubImageUtils;
const config = sandbox.window.RPHubConfig;

if (!imageUtils) {
    console.error('✗ core-utils.js 未导出 RPHubImageUtils');
    process.exit(1);
}

let failures = 0;
let checks = 0;

const assertEqual = (label, actual, expected) => {
    checks += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  ✓ ${label}`);
    } else {
        failures += 1;
        console.log(`  ✗ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
    }
};
const assertTrue = (label, value) => assertEqual(label, Boolean(value), true);
const section = (title) => console.log(`\n${title}`);

// --- 1. 尺寸：默认沿用语义比例 ---
section('1) 尺寸：未开启自定义时沿用「生图比例」');
assertEqual('竖图 → 832×1216', imageUtils.resolveSdSize({ imageSize: '竖图' }), { width: 832, height: 1216 });
assertEqual('横图 → 1216×832', imageUtils.resolveSdSize({ imageSize: '横图' }), { width: 1216, height: 832 });
assertEqual('方图 → 1024×1024', imageUtils.resolveSdSize({ imageSize: '方图' }), { width: 1024, height: 1024 });
assertEqual('未知比例 → 兜底竖图', imageUtils.resolveSdSize({ imageSize: '乱填' }), { width: 832, height: 1216 });

// --- 2. 尺寸：自定义宽高 ---
section('2) 尺寸：开启自定义后按填写值出图');
const custom = (width, height) => imageUtils.resolveSdSize({
    imageSize: '竖图',
    sdCustomSizeEnabled: true,
    sdCustomWidth: width,
    sdCustomHeight: height
});
assertEqual('1024×1536 原样保留', custom(1024, 1536), { width: 1024, height: 1536 });
assertEqual('非 8 倍数吸附到栅格（1001×1500 → 1000×1504）', custom(1001, 1500), { width: 1000, height: 1504 });
assertEqual('过小值夹到下限 64', custom(12, 20), { width: 64, height: 64 });
assertEqual('过大值夹到上限 4096', custom(99999, 99999), { width: 4096, height: 4096 });
assertEqual('非法值退回兜底 832×1216', custom('', 'abc'), { width: 832, height: 1216 });
assertEqual('关闭开关后忽略自定义值', imageUtils.resolveSdSize({
    imageSize: '横图',
    sdCustomSizeEnabled: false,
    sdCustomWidth: 512,
    sdCustomHeight: 512
}), { width: 1216, height: 832 });

// --- 3. 比例预设 ---
section('3) 比例预设 → 宽高');
const presets = config.uiOptions?.sdSizePresets || [];
assertTrue('预设表非空', presets.length > 0);
for (const name of ['portrait-2-3', 'portrait-3-4', 'portrait-9-16', 'square-1-1', 'landscape-4-3', 'landscape-3-2', 'landscape-16-9']) {
    const preset = presets.find(item => item.value === name);
    assertTrue(`预设 ${name} 存在且宽高为 8 的倍数`,
        preset && preset.width % 8 === 0 && preset.height % 8 === 0);
}
assertEqual('16:9 预设 → 1344×768', imageUtils.resolveSdSizePreset('landscape-16-9'), { width: 1344, height: 768 });
assertEqual('custom 预设 → null（保留手填值）', imageUtils.resolveSdSizePreset('custom'), null);
assertEqual('未知预设 → null', imageUtils.resolveSdSizePreset('不存在'), null);

// --- 4. 回归：切换生图地址后历史图仍指向原地址 ---
section('4) 回归：切换生图地址后历史图不得改指向新地址');
const endpointA = { baseUrl: 'http://nai-a.local' };
const endpointB = { baseUrl: 'http://nai-b.local' };
const naiJobA = { id: 'job-abc', status: 'done', generationProgress: { percent: 100 } };

// 生成完成时：按当时的地址固化 resolvedUrl（与 app.js 的 cacheCompletedImageJob 同一调用）
const cachedA = { ...naiJobA, resolvedUrl: imageUtils.resolveGeneratedImageUrl(naiJobA, endpointA) };
assertEqual('固化地址使用生成时的服务 A', cachedA.resolvedUrl, 'http://nai-a.local/api/jobs/job-abc/content?token=');

// 切到地址 B 后回放：必须仍然是 A 的地址，否则 B 上不存在该 job → 404 → 图消失
const replayed = imageUtils.resolveGeneratedImageUrl(cachedA, endpointB);
assertEqual('切换地址后回放仍指向 A', replayed, 'http://nai-a.local/api/jobs/job-abc/content?token=');
assertTrue('回放地址不包含新地址 B', !replayed.includes('nai-b.local'));

// 对照：没有修复时（无 resolvedUrl）会拼到新地址上 —— 这正是旧行为
const unfixed = imageUtils.resolveGeneratedImageUrl(naiJobA, endpointB);
assertTrue('无 resolvedUrl 的旧机会拼到当前地址（说明修复点确实生效）', unfixed.includes('nai-b.local'));

// 带 token 的任务：token 必须保留在固化地址里
const tokenTask = { baseUrl: 'http://nai-a.local', token: 'tk-123' };
const cachedToken = imageUtils.resolveGeneratedImageUrl({ id: 'job-xyz', status: 'done' }, tokenTask);
assertTrue('固化地址携带原 token', cachedToken.includes('token=tk-123'));

// 服务端直接返回图片地址的情况
assertEqual('服务端返回相对 imageUrl → 解析成绝对地址',
    imageUtils.resolveGeneratedImageUrl({ id: 'j1', imageUrl: '/api/jobs/j1/content' }, endpointA),
    'http://nai-a.local/api/jobs/j1/content');

// --- 5. SD（base64 data URL）不受地址切换影响 ---
section('5) SD：base64 图与地址无关');
const sdDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
const sdJob = { status: 'done', directImage: true, imageUrl: sdDataUrl, width: 1024, height: 1536 };
const sdCached = { ...sdJob, resolvedUrl: imageUtils.resolveGeneratedImageUrl(sdJob, { baseUrl: 'http://forge-a:7860' }) };
assertEqual('SD 固化的是 data URL 本身', sdCached.resolvedUrl, sdDataUrl);
assertEqual('切到别的地址后仍是 data URL', imageUtils.resolveGeneratedImageUrl(sdCached, { baseUrl: 'http://nai-b.local' }), sdDataUrl);

// --- 6. 卡片宽高比 ---
section('6) 卡片宽高比：优先用生成时的真实尺寸');
assertEqual('SD 自定义 1024×1536', imageUtils.resolveGeneratedImageAspect({ width: 1024, height: 1536 }, 'http://x/sdapi?size=竖图&w=832&h=1216'),
    { width: 1024, height: 1536 });
assertEqual('NAI 缓存的横图（当前 URL 已是 SD 且无 size）', imageUtils.resolveGeneratedImageAspect({ sizeLabel: '横图' }, 'http://forge/sdapi/v1/txt2img?tag=a&provider=stable-diffusion&size=竖图&w=832&h=1216'),
    { width: 1216, height: 832 });
assertEqual('无 job 时读 URL 的 w/h', imageUtils.resolveGeneratedImageAspect(null, 'http://x/sdapi?size=竖图&w=896&h=1152'),
    { width: 896, height: 1152 });
assertEqual('无 job 无 w/h 时读语义比例', imageUtils.resolveGeneratedImageAspect(null, 'http://x/generate?size=方图'),
    { width: 1024, height: 1024 });
assertEqual('全都没有 → 兜底竖图', imageUtils.resolveGeneratedImageAspect(null, ''), { width: 832, height: 1216 });
// 官方 API 的真实画布尺寸来自「分辨率档位」，而正则 URL 里的 w/h 是拼 URL 当时的快照：
// 用户改完分辨率后，URL 里可能还是上一次的 w/h（切设置不一定重建正则）。
// 这时必须以任务返回的真实像素建框，否则横图会落在竖框里——
// 卡片是 object-fit: contain，框比图高就在上下各留一大片空白（「怎么没有自适应」）。
assertEqual('真实像素优先于过期的 URL w/h（横图不被塞进竖框）',
    imageUtils.resolveGeneratedImageAspect({ width: 832, height: 1216 }, 'http://x/ai/generate-image?size=横图&w=1216&h=832'),
    { width: 832, height: 1216 });
assertEqual('没有真实像素时才退回 URL 的 w/h',
    imageUtils.resolveGeneratedImageAspect({ status: 'done' }, 'http://x/ai/generate-image?size=横图&w=1216&h=832'),
    { width: 1216, height: 832 });

// --- 7. 每个生图预设自带一套出图参数（风格/SD 参数不再互相串改） ---
section('7) 预设隔离：改一个预设不应影响其他预设');
const baseSettings = {
    imageStyle: 'vertical', customImageArtists: '', imageModel: 'nai-diffusion-4-5-full', imageSize: '竖图',
    sdModel: '', sdVae: '', sdSteps: 28, sdCfgScale: 6, sdSampler: 'DPM++ 2M SDE Karras', sdScheduler: 'Karras',
    sdLoras: '', sdPromptPrefix: '', sdNegativePrompt: '', sdKeepAspectRatio: true,
    sdCustomSizeEnabled: false, sdSizePreset: 'portrait-2-3', sdCustomWidth: 832, sdCustomHeight: 1216,
    imageGenCount: 4
};
const presetA = { id: 'a', name: '本地 Forge', url: 'http://forge:7860', provider: 'stable-diffusion', key: '' };
const presetB = { id: 'b', name: '远端 NAI', url: 'https://nai.example', provider: 'novelai', key: 'k' };
const endpoints = [presetA, presetB];

assertTrue('老预设被补上 profile 基线', imageUtils.seedEndpointProfiles(endpoints, baseSettings));
assertTrue('已带 profile 的预设不被二次覆盖', !imageUtils.seedEndpointProfiles(endpoints, { ...baseSettings, imageStyle: 'anime' }));
assertEqual('A 的基线 = 当前参数', presetA.profile.imageStyle, 'vertical');

// 切到 A → 改风格与 SD 参数 → 回写 A → 再切到 B
const live = { ...baseSettings };
imageUtils.applyImageProfile(live, presetA.profile);
live.imageStyle = 'anime';
live.sdSampler = 'Euler a';
live.sdSteps = 40;
presetA.profile = imageUtils.captureImageProfile(live);

imageUtils.applyImageProfile(live, presetB.profile);
assertEqual('切到 B 后风格回到 B 自己的值', live.imageStyle, 'vertical');
assertEqual('切到 B 后采样器回到 B 自己的值', live.sdSampler, 'DPM++ 2M SDE Karras');
assertEqual('切到 B 后步数回到 B 自己的值', live.sdSteps, 28);

// 切回 A：A 的改动仍在
imageUtils.applyImageProfile(live, presetA.profile);
assertEqual('切回 A 后风格恢复为 A 的改动', live.imageStyle, 'anime');
assertEqual('切回 A 后采样器恢复为 A 的改动', live.sdSampler, 'Euler a');
assertEqual('切回 A 后步数恢复为 A 的改动', live.sdSteps, 40);
assertEqual('B 的 profile 未被 A 的改动污染', presetB.profile.imageStyle, 'vertical');

// 不该被预设切换带走的字段
assertTrue('期望张数不在 profile 字段里', !imageUtils.IMAGE_PROFILE_FIELDS.includes('imageGenCount'));
assertTrue('接口地址不在 profile 字段里', !imageUtils.IMAGE_PROFILE_FIELDS.includes('imageGenBaseUrl'));
assertTrue('生图方式不在 profile 字段里', !imageUtils.IMAGE_PROFILE_FIELDS.includes('imageProvider'));
assertTrue('鉴权密钥不在 profile 字段里', !imageUtils.IMAGE_PROFILE_FIELDS.includes('imageGenKey'));
assertTrue('SD 参数在 profile 字段里',
    ['sdModel', 'sdSteps', 'sdCfgScale', 'sdSampler', 'sdScheduler', 'sdLoras', 'sdPromptPrefix', 'sdNegativePrompt']
        .every(field => imageUtils.IMAGE_PROFILE_FIELDS.includes(field)));
assertTrue('VAE 在 profile 字段里（跟着预设一起保存）',
    imageUtils.IMAGE_PROFILE_FIELDS.includes('sdVae'));
assertTrue('自定义分辨率在 profile 字段里',
    ['sdCustomSizeEnabled', 'sdSizePreset', 'sdCustomWidth', 'sdCustomHeight']
        .every(field => imageUtils.IMAGE_PROFILE_FIELDS.includes(field)));

// 只有一个字段的残缺 profile 不该把其他参数清成 undefined
const partial = { imageStyle: 'galgame' };
imageUtils.applyImageProfile(live, partial);
assertEqual('残缺 profile 只覆盖带了的字段', live.imageStyle, 'galgame');
assertEqual('残缺 profile 不影响其他字段', live.sdSteps, 40);
assertEqual('空 profile 返回 false（调用方据此补基线）', imageUtils.applyImageProfile(live, {}), false);
assertEqual('null profile 返回 false', imageUtils.applyImageProfile(live, null), false);

// --- 7b. VAE：默认不使用；选了才下发，且随预设走 ---
section('7b) VAE：默认不使用，选了才下发');
assertEqual('未设置 sdVae → 不下发（默认不使用）', imageUtils.resolveSdVaeOverride({}), null);
assertEqual('空串 → 不下发', imageUtils.resolveSdVaeOverride({ sdVae: '' }), null);
assertEqual('纯空白 → 不下发', imageUtils.resolveSdVaeOverride({ sdVae: '   ' }), null);
assertEqual('null/undefined 设置对象也安全', imageUtils.resolveSdVaeOverride(null), null);
assertEqual('选了 VAE → 原样下发', imageUtils.resolveSdVaeOverride({ sdVae: 'vae-ft-mse-840000-ema-pruned' }), 'vae-ft-mse-840000-ema-pruned');
assertEqual('首尾空格被裁掉', imageUtils.resolveSdVaeOverride({ sdVae: ' sdxl_vae ' }), 'sdxl_vae');

// 服务端返回的字段名不一致：model_name / title / name / 只有 filename 都要能兜出名字
assertEqual('model_name 优先', imageUtils.normalizeSdVaeEntry({ model_name: 'a', title: 'b', filename: '/x/c.safetensors' }), 'a');
assertEqual('退到 title', imageUtils.normalizeSdVaeEntry({ title: 'b', filename: '/x/c.safetensors' }), 'b');
assertEqual('退到 name', imageUtils.normalizeSdVaeEntry({ name: 'c' }), 'c');
assertEqual('只有 filename → 取文件名去扩展名', imageUtils.normalizeSdVaeEntry({ filename: '/models/VAE/kl-f8-anime2.ckpt' }), 'kl-f8-anime2');
assertEqual('Windows 路径分隔符也能处理', imageUtils.normalizeSdVaeEntry({ filename: 'D:\\models\\VAE\\sdxl_vae.safetensors' }), 'sdxl_vae');
assertEqual('字符串条目直接用', imageUtils.normalizeSdVaeEntry('plain-vae'), 'plain-vae');
assertEqual('空对象 → 空串（调用方据此过滤）', imageUtils.normalizeSdVaeEntry({}), '');
assertEqual('null 安全', imageUtils.normalizeSdVaeEntry(null), '');

// 两个服务端的 VAE 列表解析（这是实际踩到的坑：Forge neo 没有 /sdapi/v1/sd-vae）
section('7c) VAE 列表解析：兼容 A1111 与 Forge neo');
// A1111：/sdapi/v1/sd-vae → value 用名称
const a1111Raw = [
    { model_name: 'vae-ft-mse-840000-ema-pruned', filename: '/models/VAE/vae-ft-mse-840000-ema-pruned.safetensors' },
    { model_name: 'sdxl_vae', filename: '/models/VAE/sdxl_vae.safetensors' },
    { filename: '/models/VAE/kl-f8-anime2.ckpt' }
];
const a1111List = imageUtils.parseSdVaeList(a1111Raw, { usePath: false });
assertEqual('A1111: value 用名称而非路径', a1111List[0].value, 'vae-ft-mse-840000-ema-pruned');
assertEqual('A1111: 只有 filename 时用文件名去扩展名', a1111List[2].value, 'kl-f8-anime2');
assertEqual('A1111: 三项都保留', a1111List.length, 3);

// Forge neo：/sdapi/v1/sd-modules → value 用绝对路径，且要剔除 text_encoder
const forgeRaw = [
    { model_name: 'qwen_3_06b_base.safetensors', filename: 'D:\\Stable-diffusion\\sd-webui\\models\\text_encoder\\qwen_3_06b_base.safetensors' },
    { model_name: 'qwenimagevae_v7.safetensors', filename: 'D:\\Stable-diffusion\\sd-webui\\models\\VAE\\qwenimagevae_v7.safetensors' }
];
const forgeList = imageUtils.parseSdVaeList(forgeRaw, { usePath: true });
assertEqual('Forge: text_encoder 被剔除，只剩 1 个 VAE', forgeList.length, 1);
assertEqual('Forge: value 是绝对路径（Forge 要求）', forgeList[0].value,
    'D:\\Stable-diffusion\\sd-webui\\models\\VAE\\qwenimagevae_v7.safetensors');
assertEqual('Forge: label 是可读名字', forgeList[0].label, 'qwenimagevae_v7.safetensors');
assertTrue('Forge: 剔除项不是那个 VAE',
    !forgeList.some(i => i.value.includes('text_encoder')));

// text_encoder 判定：正/反斜杠、大小写都要认
assertTrue('识别 text_encoder（反斜杠）', !imageUtils.isSdVaeModulePath('D:\\m\\models\\text_encoder\\x.safetensors'));
assertTrue('识别 text_encoder（正斜杠）', !imageUtils.isSdVaeModulePath('/m/models/text_encoder/x.safetensors'));
assertTrue('识别 text_encoder（大小写混合）', !imageUtils.isSdVaeModulePath('/m/models/Text_Encoder/x.safetensors'));
assertTrue('VAE 目录不被误杀', imageUtils.isSdVaeModulePath('/m/models/VAE/x.safetensors'));
assertTrue('名为 text_encoder 的 VAE 文件不被误杀', imageUtils.isSdVaeModulePath('/m/models/VAE/text_encoder_v2.safetensors'));
assertTrue('无路径信息时保守保留', imageUtils.isSdVaeModulePath(''));

// 边界：空列表 / 非数组 / 重复项
assertEqual('空列表 → 空数组', imageUtils.parseSdVaeList([], { usePath: true }), []);
assertEqual('非数组 → 空数组', imageUtils.parseSdVaeList(null, { usePath: false }), []);
assertEqual('重复项去重', imageUtils.parseSdVaeList([
    { model_name: 'same', filename: '/a/VAE/same.safetensors' },
    { model_name: 'same', filename: '/b/VAE/same.safetensors' }
], { usePath: false }).length, 1);

// 随预设保存：A 选了 VAE、B 没选，切换后互不影响
const vaeLive = { ...baseSettings, sdVae: '' };
imageUtils.applyImageProfile(vaeLive, presetA.profile);
vaeLive.sdVae = 'vae-ft-mse-840000-ema-pruned';
presetA.profile = imageUtils.captureImageProfile(vaeLive);
assertEqual('A 的 profile 记住了 VAE', presetA.profile.sdVae, 'vae-ft-mse-840000-ema-pruned');
imageUtils.applyImageProfile(vaeLive, presetB.profile);
assertEqual('切到 B 后 VAE 回到 B 自己的值（不使用）', vaeLive.sdVae, '');
assertEqual('B 的 profile 没被 A 的 VAE 污染', presetB.profile.sdVae, '');
imageUtils.applyImageProfile(vaeLive, presetA.profile);
assertEqual('切回 A 后 VAE 恢复', vaeLive.sdVae, 'vae-ft-mse-840000-ema-pruned');

// --- 8. 归档后缓存只留服务端短地址 ---section('8) 归档：缓存里只留短地址，本机不再堆 base64');
const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
const sdEntry = { status: 'done', directImage: true, imageUrl: dataUrl, width: 1024, height: 1536, sizeLabel: '竖图' };
const archived = imageUtils.promoteImageJobToServer(sdEntry, { url: '/images/2026-09-19/abc12345.png', apiUrl: '/api/v1/images/2026-09-19/abc12345.png' });
assertEqual('本地 base64 被丢掉', archived.imageUrl, undefined);
assertEqual('resolvedUrl 指向服务端原图', archived.resolvedUrl, '/images/2026-09-19/abc12345.png');
assertEqual('尺寸信息保留（卡片宽高比还要用）', [archived.width, archived.height, archived.sizeLabel], [1024, 1536, '竖图']);
assertEqual('原条目不被就地改写', sdEntry.imageUrl, dataUrl);
assertEqual('只有 apiUrl 时退回它', imageUtils.promoteImageJobToServer(sdEntry, { apiUrl: '/api/v1/images/2026-09-19/abc12345.png' }).resolvedUrl, '/api/v1/images/2026-09-19/abc12345.png');
assertEqual('归档没给地址 → 原样返回（宁可留本地）', imageUtils.promoteImageJobToServer(sdEntry, { ok: false }), sdEntry);
assertEqual('archive 为空 → 原样返回', imageUtils.promoteImageJobToServer(sdEntry, null), sdEntry);

const naiEntry = { status: 'done', id: 'job-1', imageUrl: '/api/jobs/job-1/content', resolvedUrl: 'http://nai-a.local/api/jobs/job-1/content?token=t' };
const naiPromoted = imageUtils.promoteImageJobToServer(naiEntry, { url: '/images/2026-09-19/nai00001.png' });
assertEqual('NAI 条目改为指向归档图', naiPromoted.resolvedUrl, '/images/2026-09-19/nai00001.png');
assertEqual('NAI 条目保留原 job 链接', naiPromoted.imageUrl, '/api/jobs/job-1/content');
assertEqual('渲染时 resolvedUrl 优先于 imageUrl', imageUtils.resolveGeneratedImageUrl({ resolvedUrl: '/images/x.png', imageUrl: 'data:image/png;base64,AAA', directImage: true }, {}), '/images/x.png');

section('8b) 静态路径不可用时的兜底地址');
assertEqual('→ 换同步服务接口', imageUtils.resolveArchivedImageFallbackUrl('/images/2026-09-19/abc.png', '/api'), '/api/v1/images/2026-09-19/abc.png');
assertEqual('apiUrl 是绝对地址也正确', imageUtils.resolveArchivedImageFallbackUrl('http://host/images/2026-09-19/abc.png', 'http://host:18082'), 'http://host:18082/v1/images/2026-09-19/abc.png');
assertEqual('apiUrl 尾部斜杠被规范化', imageUtils.resolveArchivedImageFallbackUrl('/images/2026-09-19/abc.png', '/api/'), '/api/v1/images/2026-09-19/abc.png');
assertEqual('非归档地址不兜底', imageUtils.resolveArchivedImageFallbackUrl(dataUrl, '/api'), '');
assertEqual('没配同步服务时不兜底', imageUtils.resolveArchivedImageFallbackUrl('/images/a/b.png', ''), '');
assertEqual('base64 老条目被识别', imageUtils.isLocalBase64ImageJob(sdEntry), true);
assertEqual('已归档条目不算老条目', imageUtils.isLocalBase64ImageJob(archived), false);
assertEqual('地址类条目不算老条目', imageUtils.isLocalBase64ImageJob(naiEntry), false);

// 归档后的 SD 条目只剩 resolvedUrl，重载时不能被当成"空条目"丢掉（丢了图会白重生一次）
assertEqual('只有 resolvedUrl 的归档条目仍可回显', imageUtils.isRenderableImageJob({ status: 'done', resolvedUrl: '/images/a.png' }), true);
assertEqual('base64 条目可回显', imageUtils.isRenderableImageJob({ status: 'done', imageUrl: 'data:image/png;base64,AAA' }), true);
assertEqual('没有地址的条目不回显', imageUtils.isRenderableImageJob({ status: 'done' }), false);
assertEqual('未完成的条目不回显', imageUtils.isRenderableImageJob({ status: 'running', resolvedUrl: '/images/a.png' }), false);
assertEqual('空条目不回显', imageUtils.isRenderableImageJob(null), false);

section('8c) 同步用的缓存整理：短地址随快照走，base64 只留本机');
const mixedCache = {
    'tag-archived': { status: 'done', resolvedUrl: '/images/2026-09-19/a.png', width: 1024, height: 1536 },
    'tag-url': { status: 'done', imageUrl: '/api/jobs/job-1/content' },
    'tag-local': { status: 'done', directImage: true, imageUrl: 'data:image/png;base64,AAAA' }
};
const compacted = imageUtils.compactImageCacheForSync(mixedCache);
assertEqual('短地址条目保留（换设备靠它看图）', Object.keys(compacted.entries), ['tag-archived', 'tag-url']);
assertEqual('仍存 base64 的老条目被剔除', compacted.dropped, 1);
assertEqual('被剔除的条目确实不在结果里', compacted.entries['tag-local'], undefined);
assertEqual('空输入返回空表', imageUtils.compactImageCacheForSync(null), { entries: {}, dropped: 0 });
assertEqual('全空对象也安全', imageUtils.compactImageCacheForSync({}), { entries: {}, dropped: 0 });

// --- 9. 接线检查：app.js 确实用了上面这套逻辑 ---
section('9) 接线检查（防止页面里又走回旧实现）');
const appSource = readFileSync(join(root, 'assets/js/app.js'), 'utf8');
assertTrue('app.js 使用 RPHubImageUtils', appSource.includes('window.RPHubImageUtils'));
assertTrue('缓存写入时固化 resolvedUrl', /cacheCompletedImageJob[\s\S]{0,600}resolvedUrl/.test(appSource));
assertTrue('渲染图片走统一解析函数', appSource.includes('resolveGeneratedImageUrl(job, task)'));
assertTrue('SD 请求 URL 带上 w/h', appSource.includes('&w=${sdSize.width}&h=${sdSize.height}'));
assertTrue('自定义分辨率开关进入重建正则的 watch', appSource.includes('settings.sdCustomWidth'));
// 卡片比例必须贴合「真正出的那张图」：任务完成时按真实像素再刷一次；
// 官方分辨率/自定义宽高也要进「重建正则」的 watch（否则 URL 里的 w/h 一直是旧值）。
assertTrue('任务完成时按真实像素刷新卡片比例（否则框不跟着图片自适应）',
    /applyGeneratedImageCardAspect\(card, \{ requestUrl: card\.dataset\.imageRequest, job \}\)/.test(appSource));
assertTrue('官方分辨率/自定义宽高进入重建正则的 watch',
    /settings\.imageSize,[\s\S]{0,500}settings\.naiOfficialResolution,[\s\S]{0,300}settings\.naiOfficialCustomHeight,/.test(appSource));
// 第 53 条：换预设/换方式/改参数之后重新进入会话，历史图一律不自动重跑。
assertTrue('参数变了不再删缓存条目、不再自动重跑',
    !appSource.includes('completedImageJobsByTag.delete(tagKey)')
    && appSource.includes('markGeneratedImageOutdated(card, outdated)'));
assertTrue('改为在卡片上标「按旧参数出的」（↻ 高亮提示）',
    readFileSync(join(root, 'assets/css/styles.css'), 'utf8').includes('.generated-image-card.is-image-outdated'));
assertTrue('切换预设时载入 profile', /selectImageEndpoint[\s\S]{0,900}applyImageProfile\(found\.profile\)/.test(appSource));
assertTrue('保存预设时带上 profile', /endpointData = \{[\s\S]{0,400}profile: captureImageProfile\(\)/.test(appSource));
assertTrue('参数变化回写当前预设', /IMAGE_PROFILE_FIELDS\.map[\s\S]{0,220}writeActiveImageProfile\(\)/.test(appSource));
assertTrue('启动时为老预设补 profile', appSource.includes('seedEndpointProfiles(settings.savedImageEndpoints, settings)'));
assertTrue('从 /sdapi/v1/sd-vae 拉取 VAE 列表', appSource.includes("fetchSdJson('/sdapi/v1/sd-vae')"));
assertTrue('Forge 无 sd-vae 时回退 /sdapi/v1/sd-modules', appSource.includes("fetchSdJson('/sdapi/v1/sd-modules')"));
assertTrue('Forge 分支用路径作 value', /parseSdVaeList\(modules, \{ usePath: true \}\)/.test(appSource));
assertTrue('A1111 分支用名称作 value', /parseSdVaeList\(list, \{ usePath: false \}\)/.test(appSource));
assertTrue('VAE 走 resolveSdVaeOverride 决定是否下发', appSource.includes('imageUtils.resolveSdVaeOverride(settings)'));
assertTrue('VAE 写进 override_settings.sd_vae', /overrideSettings\.sd_vae\s*=\s*vae/.test(appSource));
assertTrue('老存档的 sdVae 被收敛为字符串', appSource.includes('settings.sdVae = String(settings.sdVae || '));
assertTrue('VAE 下拉暴露给模板', appSource.includes('sdVaeOptions,'));

const syncSource = readFileSync(join(root, 'assets/js/sync-client.js'), 'utf8');
assertTrue('快照里剔除以 base64 存的生图（413 防线）', syncSource.includes('compactImageCache'));
assertTrue('生图短地址随快照同步（换设备直接看图）', syncSource.includes('IMAGE_CACHE_KEY'));
assertTrue('拉取时合并而非抹掉本机生图缓存', /localImages[\s\S]{0,500}IMAGE_CACHE_KEY/.test(syncSource));
assertTrue('上传前做体积预检', syncSource.includes('MAX_PUSH_BYTES'));

section('9b) 归档链路的接线与部署配置');
assertTrue('归档成功后把缓存条目换成短地址', appSource.includes('promoteCachedImageToServer'));
assertTrue('缓存加载器接受只有 resolvedUrl 的归档条目（漏了会白重生一次）', appSource.includes('isRenderableImageJob(v)'));
assertTrue('老 base64 条目按需补传归档', appSource.includes('upgradeLegacyCachedImage'));
assertTrue('静态路径失败时退回同步接口', appSource.includes('resolveArchivedImageFallbackUrl'));
assertTrue('sync-client 回传归档地址', syncSource.includes('imageAddressesOf'));
const nginxConf = readFileSync(join(root, 'docker/default.conf'), 'utf8');
assertTrue('nginx 用 ^~ 提供 /images/（否则被静态后缀正则抢先）',
    /\^\~\s*\/images\//.test(nginxConf) && nginxConf.includes('alias /data/images/'));
const serverSource = readFileSync(join(root, 'sync-server/server.js'), 'utf8');
assertTrue('同步服务提供读图路由', serverSource.includes("url.pathname.startsWith('/v1/images/')"));
assertTrue('读图路由有文件名白名单校验', serverSource.includes('ARCHIVED_FILE_PATTERN'));
assertTrue('归档响应带 url / apiUrl', serverSource.includes('imageUrlsOf'));

assertTrue('index.html 暴露自定义分辨率 UI',
    readFileSync(join(root, 'index.html'), 'utf8').includes('settings.sdCustomSizeEnabled'));
const indexSource = readFileSync(join(root, 'index.html'), 'utf8');
assertTrue('index.html 暴露 VAE 选择框', indexSource.includes('settings.sdVae') && indexSource.includes('sdVaeOptions'));
assertTrue('VAE 默认项文案是「不使用」', appSource.includes('不使用 VAE（默认）'));
assertTrue('mock 服务提供 /sdapi/v1/sd-vae', readFileSync(join(root, 'tools/mock-sdapi.mjs'), 'utf8').includes("'/sdapi/v1/sd-vae'"));
assertTrue('mock 服务提供 /sdapi/v1/sd-modules（Forge 场景）', readFileSync(join(root, 'tools/mock-sdapi.mjs'), 'utf8').includes("'/sdapi/v1/sd-modules'"));

// --- 10. ComfyUI：API 工作流解析 / 绑定探测 / 参数改写 / 输出收集 ---
// 被测对象是 core-utils.js 的 window.RPHubComfyUtils（纯函数）。
// ComfyUI 与 NAI/SD 的根本差异是「它只认识节点图」，所以这里的重点是
// 「有没有在对的节点上改对的输入」以及「别把用户的图结构改坏」。
const comfy = sandbox.window.RPHubComfyUtils;
assertTrue('core-utils 导出 RPHubComfyUtils', Boolean(comfy));

section('10) ComfyUI：工作流解析与校验');
assertEqual('空串被拒', comfy.parseComfyWorkflow('').ok, false);
assertEqual('坏 JSON 被拒', comfy.parseComfyWorkflow('{oops').ok, false);
assertEqual('数组被拒（不是节点表）', comfy.parseComfyWorkflow('[]').ok, false);
// 用户最容易犯的错：粘了画布的界面图格式。必须给出可读提示，而不是发出去让服务端报错。
const uiGraph = JSON.stringify({ nodes: [{ id: 3, type: 'KSampler' }], links: [] });
const uiResult = comfy.parseComfyWorkflow(uiGraph);
assertEqual('界面图格式被识别并拒收', uiResult.ok, false);
assertTrue('界面图格式的提示指向「API Format」', /API Format/.test(uiResult.error));
assertEqual('节点缺 class_type 被拒', comfy.parseComfyWorkflow(JSON.stringify({ '1': { inputs: {} } })).ok, false);

// 一份贴近真实的最小工作流（结构参考 ComfyUI 默认 txt2img）
const comfyWorkflow = {
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } }
};
const parsedOk = comfy.parseComfyWorkflow(JSON.stringify(comfyWorkflow));
assertEqual('合法工作流解析成功', parsedOk.ok, true);
assertEqual('节点全部纳入', parsedOk.nodes.length, 7);
assertEqual('节点 id 被规范成字符串', parsedOk.nodes.find(n => n.classType === 'KSampler').id, '3');
assertEqual('数字 id 的 JSON 也能解析', comfy.parseComfyWorkflow('{"3":{"class_type":"KSampler","inputs":{}}}').nodes[0].id, '3');
assertEqual('识别到采样节点', comfy.comfyWorkflowHasSampler(parsedOk.nodes), true);
assertEqual('只有输出节点不算采样工作流', comfy.comfyWorkflowHasSampler([{ id: '1', classType: 'SaveImage', inputs: {} }]), false);

section('10b) ComfyUI：节点连线不能被当参数覆盖');
assertEqual('数组形节点引用被识别为连线', comfy.isComfyNodeLink(['4', 0]), true);
assertEqual('数字节点引用也是连线', comfy.isComfyNodeLink([3, 0]), true);
assertEqual('字符串不是连线', comfy.isComfyNodeLink('a cat'), false);
assertEqual('数字不是连线', comfy.isComfyNodeLink(7), false);
assertEqual('长度不足不是连线', comfy.isComfyNodeLink(['4']), false);
assertEqual('节点引用被规范成字符串', comfy.normalizeComfyNodeRef([3, 0]), ['3', 0]);
assertEqual('非法引用返回 null', comfy.normalizeComfyNodeRef(['3']), null);
assertEqual('null 返回 null', comfy.normalizeComfyNodeRef(null), null);
// 只挑标量输入：model/positive/negative/latent_image 都是连线，不该出现在可改列表里
assertEqual('标量输入被挑出（连线被排除）',
    comfy.scalarComfyInputs(parsedOk.nodes.find(n => n.classType === 'KSampler')).sort(),
    ['cfg', 'denoise', 'sampler_name', 'scheduler', 'seed', 'steps'].sort());

section('10c) ComfyUI：自动绑定必须区分正向/负面提示词');
const detected = comfy.detectComfyBindings(parsedOk.nodes);
assertEqual('正向绑到连 KSampler.positive 的那个 CLIPTextEncode', detected.prompt, { nodeId: '6', input: 'text' });
assertEqual('负向绑到连 KSampler.negative 的那个（不能和正向撞在一起）', detected.negativePrompt, { nodeId: '7', input: 'text' });
assertTrue('正负向不是同一个节点', detected.prompt.nodeId !== detected.negativePrompt.nodeId);
assertEqual('宽度绑到 EmptyLatentImage', detected.width, { nodeId: '5', input: 'width' });
assertEqual('高度绑到 EmptyLatentImage', detected.height, { nodeId: '5', input: 'height' });
assertEqual('步数绑到 KSampler.steps', detected.steps, { nodeId: '3', input: 'steps' });
assertEqual('CFG 绑到 KSampler.cfg', detected.cfg, { nodeId: '3', input: 'cfg' });
assertEqual('采样器绑到 KSampler.sampler_name', detected.sampler, { nodeId: '3', input: 'sampler_name' });
assertEqual('种子绑到 KSampler.seed', detected.seed, { nodeId: '3', input: 'seed' });
assertEqual('底模绑到 CheckpointLoaderSimple（不是 UNETLoader）', detected.checkpoint, { nodeId: '4', input: 'ckpt_name' });
assertEqual('文件名前缀绑到 SaveImage', detected.filenamePrefix, { nodeId: '9', input: 'filename_prefix' });

// 回归：节点里没有 cfg 这个输入时，绝不能退化成绑到第一个标量输入。
// 曾经的写法是 `rule.inputs.find(...) || inputs[0]`，会把 cfg/sampler/seed 全绑到 steps，
// 于是「传 cfg」实际改掉的是步数——静默改坏参数，且现象很难排查。
const bareSampler = comfy.parseComfyWorkflow(JSON.stringify({
    '3': { class_type: 'KSampler', inputs: { steps: 20, positive: ['6', 0], negative: ['7', 0] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'bad' } }
})).nodes;
const bareBindings = comfy.detectComfyBindings(bareSampler);
assertEqual('没有 cfg 输入时不绑 cfg（而非绑到 steps）', bareBindings.cfg, undefined);
assertEqual('没有 seed 输入时不绑 seed', bareBindings.seed, undefined);
assertEqual('没有 sampler_name 输入时不绑 sampler', bareBindings.sampler, undefined);
assertEqual('steps 仍然绑对', bareBindings.steps, { nodeId: '3', input: 'steps' });
assertEqual('文本类角色仍可退回第一个标量输入', bareBindings.prompt, { nodeId: '6', input: 'text' });
// 直接验证「写 cfg 不会动到 steps」
const bareApplied = comfy.applyComfyParamValues(
    JSON.parse(JSON.stringify({ '3': { class_type: 'KSampler', inputs: { steps: 20 } } })),
    bareBindings, { cfg: 9 }
);
assertEqual('传 cfg 不会改写 steps', bareApplied.prompt['3'].inputs.steps, 20);
assertEqual('未被绑定的参数不产生 applied', bareApplied.applied.length, 0);

// 没有 KSampler 连线信息时（正负向都是孤立节点）退化成「第一个 / 第二个」，但绝不能相同
const looseNodes = [
    { id: '1', classType: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['9', 1] } },
    { id: '2', classType: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['9', 1] } }
];
const loose = comfy.detectComfyBindings(looseNodes);
assertEqual('无连线时正向取第一个', loose.prompt, { nodeId: '1', input: 'text' });
assertEqual('无连线时负向取第二个', loose.negativePrompt, { nodeId: '2', input: 'text' });
assertTrue('退化路径也不会正负撞车', loose.prompt.nodeId !== loose.negativePrompt.nodeId);

assertEqual('空节点表安全', comfy.detectComfyBindings([]), {});

section('10d) ComfyUI：绑定表整理（换了工作流后旧绑定必须失效）');
assertEqual('节点不存在的绑定被剔除',
    comfy.normalizeComfyBindings({ prompt: { nodeId: '999', input: 'text' } }, parsedOk.nodes), {});
assertEqual('缺输入名的绑定被剔除',
    comfy.normalizeComfyBindings({ prompt: { nodeId: '6', input: '' } }, parsedOk.nodes), {});
assertEqual('非法角色被剔除',
    comfy.normalizeComfyBindings({ nonsense: { nodeId: '6', input: 'text' } }, parsedOk.nodes), {});
assertEqual('合法绑定保留',
    comfy.normalizeComfyBindings({ prompt: { nodeId: '6', input: 'text' } }, parsedOk.nodes),
    { prompt: { nodeId: '6', input: 'text' } });

section('10e) ComfyUI：参数写入（深拷贝，不动原对象）');
const applied = comfy.applyComfyParamValues(comfyWorkflow, detected, { prompt: 'a dog', steps: 30, seed: 42 });
assertEqual('提示词写进正向节点', applied.prompt['6'].inputs.text, 'a dog');
assertEqual('负面提示词未被误改', applied.prompt['7'].inputs.text, 'bad');
assertEqual('步数写进 KSampler', applied.prompt['3'].inputs.steps, 30);
assertEqual('种子写进 KSampler', applied.prompt['3'].inputs.seed, 42);
assertEqual('原工作流对象未被修改（深拷贝）', comfyWorkflow['6'].inputs.text, 'a cat');
assertEqual('原工作流步数未被修改', comfyWorkflow['3'].inputs.steps, 20);
assertEqual('applied 记录了实际写入项', applied.applied.length, 3);
assertTrue('applied 里记录了提示词写入', applied.applied.some(item => item.role === 'prompt' && item.nodeId === '6'));
assertEqual('未传值的角色不写入', applied.prompt['5'].inputs.width, 512);

// 空值（'' / null / undefined）一律视为「不覆盖」，避免把工作流改空
const blank = comfy.applyComfyParamValues(comfyWorkflow, detected, { prompt: '', steps: null, cfg: undefined });
assertEqual('空串不覆盖', blank.prompt['6'].inputs.text, 'a cat');
assertEqual('null 不覆盖', blank.prompt['3'].inputs.steps, 20);
assertEqual('undefined 不覆盖', blank.prompt['3'].inputs.cfg, 7);
assertEqual('全空时没有 applied', blank.applied.length, 0);

// 绑定指向连线时必须拒绝，否则会把图结构改成字符串，跑出完全错误的结果
const linkBinding = { model: { nodeId: '3', input: 'model' } };
const linkAttempt = comfy.applyComfyParamValues(comfyWorkflow, linkBinding, { model: 'x' });
assertEqual('指向连线的绑定被跳过', linkAttempt.skipped.length, 1);
assertEqual('连线本身没被改写', linkAttempt.prompt['3'].inputs.model, ['4', 0]);
assertEqual('跳过原因被记录', linkAttempt.skipped[0].role, 'model');

// 节点不存在（用户改了工作流但绑定没更新）
const ghost = comfy.applyComfyParamValues(comfyWorkflow, { prompt: { nodeId: '404', input: 'text' } }, { prompt: 'x' });
assertEqual('节点不存在时被跳过而非崩溃', ghost.skipped.length, 1);
assertEqual('跳过时工作流保持原样', ghost.prompt['6'].inputs.text, 'a cat');

section('10f) ComfyUI：输出收集与 /view 地址');
const historyEntry = {
    outputs: {
        '9': { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] },
        '12': { gifs: [{ filename: 'anim.mp4', subfolder: 'video', type: 'output' }] }
    }
};
const outputs = comfy.collectComfyOutputs(historyEntry);
assertEqual('图片与视频都被收集', outputs.length, 2);
assertEqual('图片文件名正确', outputs[0].filename, 'ComfyUI_00001_.png');
assertEqual('图片来源节点被记录', outputs[0].nodeId, '9');
assertEqual('媒体类型被记录', outputs[1].kind, 'gifs');
assertEqual('默认 type 为 output', outputs[0].type, 'output');
assertTrue('图片地址指向 /view', outputs[0].url.startsWith('/view?'));
assertTrue('图片地址带 filename', outputs[0].url.includes('filename=ComfyUI_00001_.png'));
assertTrue('视频的子目录进入查询串', outputs[1].url.includes('subfolder=video'));
assertEqual('无 outputs 返回空数组', comfy.collectComfyOutputs({}), []);
assertEqual('null 安全', comfy.collectComfyOutputs(null), []);
// 没有 filename 的条目（某些节点的占位返回）必须被丢掉，否则会拼出空地址
assertEqual('缺 filename 的条目被丢弃', comfy.collectComfyOutputs({ outputs: { '1': { images: [{ type: 'output' }] } } }), []);

assertEqual('buildComfyViewUrl 带 baseUrl',
    comfy.buildComfyViewUrl({ filename: 'a.png', type: 'output' }, 'http://127.0.0.1:8188'),
    'http://127.0.0.1:8188/view?filename=a.png&type=output');
assertEqual('buildComfyViewUrl 尾部斜杠被规范化',
    comfy.buildComfyViewUrl({ filename: 'a.png', type: 'output' }, 'http://x:8188/'),
    'http://x:8188/view?filename=a.png&type=output');
assertTrue('subfolder 被编码进查询串',
    comfy.buildComfyViewUrl({ filename: 'a b.png', subfolder: 'my dir', type: 'output' }, '').includes('subfolder=my+dir'));

section('10g) ComfyUI：进度（progress_state → 百分比）');
assertEqual('无 nodes 返回 null（退回不确定态，不假装有进度）', comfy.computeComfyProgress({}), null);
assertEqual('max 为 0 的节点被忽略', comfy.computeComfyProgress({ nodes: { '1': { value: 0, max: 0, state: 'running' } } }), null);
// 单个采样节点跑一半
assertEqual('单节点 5/10 → 50%', comfy.computeComfyProgress({ nodes: { '3': { value: 5, max: 10, state: 'running' } } }), 50);
assertEqual('单节点完成 → 100%', comfy.computeComfyProgress({ nodes: { '3': { value: 10, max: 10, state: 'finished' } } }), 100);
// 两节点：一个已完成，一个跑一半 → (1 + 0.5) / 2 = 75%
assertEqual('混合节点按比例折算',
    comfy.computeComfyProgress({ nodes: { a: { value: 1, max: 1, state: 'finished' }, b: { value: 5, max: 10, state: 'running' } } }), 75);
assertEqual('进度夹在 0–100 之间（value 超界也不越界）',
    comfy.computeComfyProgress({ nodes: { a: { value: 99, max: 10, state: 'running' } } }), 100);
assertEqual('负值被夹到 0', comfy.computeComfyProgress({ nodes: { a: { value: -5, max: 10, state: 'running' } } }), 0);
assertEqual('文案带百分比', comfy.describeComfyProgress({ nodes: { a: { value: 5, max: 10, state: 'running' } } }), '生成中 50%');
assertEqual('拿不到进度时文案退化为「生成中」', comfy.describeComfyProgress({}), '生成中');

section('10h) ComfyUI：object_info 下拉选项提取');
const objectInfo = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['m1.safetensors', 'm2.safetensors']] } } },
    KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m']], steps: ['INT', { default: 20 }] } } }
};
assertEqual('COMBO 列表被转成选项',
    comfy.pickComfyComboOptions(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name'),
    [{ value: 'm1.safetensors', label: 'm1.safetensors' }, { value: 'm2.safetensors', label: 'm2.safetensors' }]);
assertEqual('非 COMBO 的 INT 输入返回空', comfy.pickComfyComboOptions(objectInfo, 'KSampler', 'steps'), []);
assertEqual('未知节点安全', comfy.pickComfyComboOptions(objectInfo, 'Nope', 'x'), []);
assertEqual('缺 objectInfo 安全', comfy.pickComfyComboOptions(null, 'KSampler', 'sampler_name'), []);

section('10i) ComfyUI：接线与配置检查');
assertEqual('comfyui 进入生图方式列表',
    config.uiOptions.imageProviders.some(p => p.value === 'comfyui'), true);
assertTrue('ComfyUI 参数随预设保存（切预设不该串参数）',
    ['comfyWorkflow', 'comfyBindings', 'comfySteps', 'comfyPrompt']
        .every(field => imageUtils.IMAGE_PROFILE_FIELDS.includes(field)));
// 工作流库是全局资产（多份工作流共享），不该跟着生图预设来回切。
assertTrue('工作流库不随生图预设走（它是全局资产）',
    !imageUtils.IMAGE_PROFILE_FIELDS.includes('comfyWorkflowLibrary')
    && !imageUtils.IMAGE_PROFILE_FIELDS.includes('comfyActiveWorkflowId'));
assertTrue('app.js 使用 RPHubComfyUtils', appSource.includes('window.RPHubComfyUtils'));
assertTrue('生成链路走 generateWithComfy', appSource.includes('generateWithComfy'));
assertTrue('提交前用 /prompt 且带 client_id', /submitComfyPrompt[\s\S]{0,400}client_id/.test(appSource));
assertTrue('进度读 progress_state 事件（0.34 已无 /progress 端点）', appSource.includes("case 'progress_state'"));
assertTrue('输出从 /history 取文件名', appSource.includes('/history/${encodeURIComponent(promptId)}'));
assertTrue('取消走 /interrupt', appSource.includes("fetchComfyJson('/interrupt'"));
assertTrue('取消时同时清理队列项', appSource.includes("'/queue'"));
assertTrue('ComfyUI 图片是远程地址（归档要按 URL 下载而非当 base64）', appSource.includes('remoteImage'));
assertTrue('探活走 /system_stats（根路径会 403/重定向）', appSource.includes('/system_stats'));
assertTrue('watch 里重建正则带上 ComfyUI 尺寸', appSource.includes('settings.comfyOverrideSize'));
const comfyIndexSource = readFileSync(join(root, 'index.html'), 'utf8');
assertTrue('index.html 暴露工作流输入框', comfyIndexSource.includes('settings.comfyWorkflow'));
assertTrue('index.html 暴露参数绑定表格', comfyIndexSource.includes('setComfyBinding'));
assertTrue('index.html 暴露取消开关', comfyIndexSource.includes('settings.comfyAllowCancel'));
assertTrue('旧文案提到三种生图方式', comfyIndexSource.includes('ComfyUI 提交'));

// --- 11. ComfyUI 工作流库：保存多份 JSON，按名字切换 ---
section('11) ComfyUI：工作流库（多份保存/切换）');
const wfA = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { steps: 20 } }, '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'a' } } });
const wfB = JSON.stringify({ '5': { class_type: 'LoadImage', inputs: { image: 'x.png' } }, '9': { class_type: 'SaveImage', inputs: {} } });

assertEqual('空库被规范成空数组', comfy.normalizeComfyWorkflowLibrary(null), []);
assertEqual('非数组被规范成空数组', comfy.normalizeComfyWorkflowLibrary('nope'), []);
// 坏条目（没有 workflow 内容）不该进库，否则下拉里会出现点不开的空项
assertEqual('缺 workflow 的条目被剔除', comfy.normalizeComfyWorkflowLibrary([{ name: 'x' }]).length, 0);
assertEqual('空 workflow 的条目被剔除', comfy.normalizeComfyWorkflowLibrary([{ name: 'x', workflow: '   ' }]).length, 0);
assertEqual('缺名字时自动补一个', comfy.normalizeComfyWorkflowLibrary([{ workflow: wfA }])[0].name.length > 0, true);
assertEqual('缺 id 时自动补一个', Boolean(comfy.normalizeComfyWorkflowLibrary([{ workflow: wfA }])[0].id), true);
// id 撞车必须去重，否则切换会选错条目
const dupIds = comfy.normalizeComfyWorkflowLibrary([{ id: 'same', workflow: wfA }, { id: 'same', workflow: wfB }]);
assertEqual('重复 id 被去重', dupIds[0].id === dupIds[1].id, false);
assertEqual('重复 id 两条都保留', dupIds.length, 2);
assertEqual('非对象条目被剔除', comfy.normalizeComfyWorkflowLibrary([null, 1, 'x', { workflow: wfA }]).length, 1);

section('11b) ComfyUI：库的增删改查');
let lib = [];
const added = comfy.upsertComfyWorkflow(lib, { name: '文生图', workflow: wfA });
lib = added.library;
assertEqual('新增成功', added.added, true);
assertEqual('新增后有 1 条', lib.length, 1);
assertEqual('名字正确', lib[0].name, '文生图');
assertEqual('空工作流被拒', comfy.upsertComfyWorkflow(lib, { name: 'x', workflow: '' }).error, '工作流为空');
assertEqual('被拒时库不变', comfy.upsertComfyWorkflow(lib, { name: 'x', workflow: '' }).library.length, 1);

const second = comfy.upsertComfyWorkflow(lib, { name: '图生图', workflow: wfB });
lib = second.library;
assertEqual('加第二条', lib.length, 2);
assertEqual('两条 id 不同', lib[0].id !== lib[1].id, true);

// 用 id 更新：应覆盖而不是新增
const updated = comfy.upsertComfyWorkflow(lib, { id: lib[0].id, name: '文生图改', workflow: wfA });
lib = updated.library;
assertEqual('按 id 更新不是新增', updated.added, false);
assertEqual('更新后仍是 2 条', lib.length, 2);
assertEqual('名字被更新', lib.find(i => i.id === updated.id).name, '文生图改');

// 保存时带上绑定与开关：切回来要一并还原
const withBindings = comfy.upsertComfyWorkflow(lib, {
    id: lib[0].id, name: '带绑定', workflow: wfA,
    bindings: { prompt: { nodeId: '6', input: 'text' } }, autoDetect: false
});
lib = withBindings.library;
const saved = comfy.findComfyWorkflow(lib, withBindings.id);
assertEqual('绑定被保存', saved.bindings.prompt, { nodeId: '6', input: 'text' });
assertEqual('探测开关被保存', saved.autoDetect, false);

assertEqual('按 id 查得到', Boolean(comfy.findComfyWorkflow(lib, lib[0].id)), true);
assertEqual('查不存在的返回 null', comfy.findComfyWorkflow(lib, 'nope'), null);
assertEqual('删除后剩 1 条', comfy.removeComfyWorkflow(lib, lib[0].id).length, 1);
assertEqual('删除不存在的 id 不报错', comfy.removeComfyWorkflow(lib, 'nope').length, 2);
assertEqual('数量上限被夹住',
    comfy.normalizeComfyWorkflowLibrary(
        Array.from({ length: comfy.COMFY_LIBRARY_LIMIT + 10 }, (_, i) => ({ id: `w${i}`, workflow: wfA }))
    ).length,
    comfy.COMFY_LIBRARY_LIMIT);

section('11c) ComfyUI：工作流命名建议');
// ComfyUI 的 API 导出会写节点级 _meta.title；官方示例只有数字键。
// 注意 _meta 属于「节点内部」，不是顶层键——顶层出现非节点键会被服务端整份拒绝
//（execution.py 的 validate_prompt 逐个顶层键检查 class_type）。
assertEqual('优先用 JSON 里的 title',
    comfy.readComfyWorkflowTitle(JSON.stringify({ _meta: { title: '我的工作流' }, '3': { class_type: 'KSampler' } })),
    '我的工作流');
assertEqual('没有 _meta 时返回空串', comfy.readComfyWorkflowTitle('{}'), '');
assertEqual('坏 JSON 不抛异常', comfy.readComfyWorkflowTitle('{oops'), '');
// 真实的 API 导出形状：_meta 在节点内部，解析必须通过，且改写后元信息不能被丢掉
const nodeMetaWorkflow = {
    '3': { class_type: 'KSampler', _meta: { title: '采样器' }, inputs: { steps: 20, positive: ['6', 0], negative: ['7', 0] } },
    '6': { class_type: 'CLIPTextEncode', _meta: { title: '正向' }, inputs: { text: 'a cat' } },
    '7': { class_type: 'CLIPTextEncode', _meta: { title: '负向' }, inputs: { text: 'bad' } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'X' } }
};
const nodeMetaParsed = comfy.parseComfyWorkflow(JSON.stringify(nodeMetaWorkflow));
assertEqual('节点级 _meta 不阻碍解析', nodeMetaParsed.ok, true);
assertEqual('节点级 _meta 的节点被正常计入', nodeMetaParsed.nodes.length, 4);
const nodeMetaApplied = comfy.applyComfyParamValues(
    nodeMetaWorkflow, comfy.detectComfyBindings(nodeMetaParsed.nodes), { prompt: 'a dog', steps: 30 }
);
assertEqual('改写后节点的 _meta 仍保留（不丢用户元信息）',
    nodeMetaApplied.prompt['3']._meta.title, '采样器');
assertEqual('改写确实生效', nodeMetaApplied.prompt['6'].inputs.text, 'a dog');
// 顶层混入非节点键：服务端会整份拒绝，我们本地就先拦下并说清楚
const topLevelMeta = comfy.parseComfyWorkflow(JSON.stringify({ _meta: { title: 'T' }, '3': { class_type: 'KSampler', inputs: {} } }));
assertEqual('顶层非节点键被拦下（与服务端 validate_prompt 行为一致）', topLevelMeta.ok, false);
assertTrue('报错里点出是哪个键', topLevelMeta.error.includes('_meta'));
assertTrue('按节点猜出「视频」',
    /视频/.test(comfy.suggestComfyWorkflowName([{ id: '1', classType: 'SaveVideo', inputs: {} }], 1)));
assertTrue('按节点猜出「图生图」',
    /图生图/.test(comfy.suggestComfyWorkflowName([{ id: '1', classType: 'LoadImage', inputs: {} }], 1)));
assertTrue('按节点猜出「文生图」',
    /文生图/.test(comfy.suggestComfyWorkflowName([{ id: '1', classType: 'KSampler', inputs: {} }], 1)));
assertTrue('认不出来时退回通用名',
    comfy.suggestComfyWorkflowName([{ id: '1', classType: 'SomethingElse', inputs: {} }], 3).length > 0);

section('11d) 回归：NAI 专属项不得出现在 SD / ComfyUI 下');
// 「生图版本」是 NAI 的 V4.5/V5，只有 NovelAI 认识。
// 曾经的写法是 v-if="!isSdProvider" —— 新增第三个生图方式后它就把 NAI 版本显示到了 ComfyUI 上。
assertTrue('存在 isNaiProvider 判定（而不是用「不是 SD」反推）', appSource.includes('const isNaiProvider'));
// 「生图版本」必须由 isNaiProvider 门控（不能用 !isSdProvider，否则新增方式时会串出去）。
// 断言直接查那个 div 的 v-if，而不是匹配附近的注释文字。
assertTrue('生图版本用 isNaiProvider 门控',
    /<!-- Image Model[^>]*-->\s*<div v-if="isNaiProvider"/.test(comfyIndexSource));
assertTrue('生图版本不再用 !isSdProvider 门控', !comfyIndexSource.includes('v-if="!isSdProvider"'));
// 归档索引里的 model 也不能一律写 NAI 版本名
assertTrue('归档 model 按生图方式区分', appSource.includes('archiveModel'));
assertTrue('ComfyUI 归档时读工作流里的底模', appSource.includes('comfyCheckpointFromWorkflow'));
assertTrue('index.html 暴露工作流库下拉', comfyIndexSource.includes('comfyLibrarySelection'));
assertTrue('index.html 暴露多文件导入', /accept="\.json,application\/json"\s+multiple/.test(comfyIndexSource));

// --- 12. NovelAI 官方 API：尺寸 / 免费额度 / 载荷 ---
// 被测对象是 core-utils.js 的 window.RPHubNaiOfficialUtils（纯函数）。
// 关键事实（对着官方文档与官方 Python 库核实过）：
//   - 端点 /ai/generate-image，Bearer 鉴权，响应是 ZIP
//   - 宽高必须是 64 的倍数
//   - Opus 免费额度：步数 ≤ 28 且像素 ≤ 1024*1024（ImagePreset.calculate_cost）
//   - V5 用 params_version 4，V4/V4.5 用 3
const naiOff = sandbox.window.RPHubNaiOfficialUtils;
assertTrue('core-utils 导出 RPHubNaiOfficialUtils', Boolean(naiOff));
const naiOffSource = readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8');

section('12) NovelAI 官方 API：provider 与常量');
assertTrue('novelai-official 进入生图方式列表',
    config.uiOptions.imageProviders.some(p => p.value === 'novelai-official'));
assertTrue('原先的 novelai 改名为 Nai2API (RP HUB 网关)',
    config.uiOptions.imageProviders.find(p => p.value === 'novelai').label === 'Nai2API (RP HUB 网关)');
assertTrue('两个 NAI 方式并存（网关 + 官方）',
    config.uiOptions.imageProviders.filter(p => p.value.startsWith('novelai')).length === 2);

section('12a-2) 生图预设的方式标签：网关叫 Nai2API，官方不能被错标');
assertEqual('网关预设标签是 Nai2API', imageUtils.imageEndpointProviderTag('novelai'), 'Nai2API');
// 关键回归：novelai-official 也以 'novelai' 开头，若按「不是 comfyui/SD」兜底会被错标成 Nai2API
assertEqual('官方 API 预设标签不是 Nai2API', imageUtils.imageEndpointProviderTag('novelai-official'), 'NovelAI');
assertEqual('SD 预设标签仍是 SD', imageUtils.imageEndpointProviderTag('stable-diffusion'), 'SD');
assertEqual('ComfyUI 预设标签仍是 ComfyUI', imageUtils.imageEndpointProviderTag('comfyui'), 'ComfyUI');
assertEqual('未知方式兜底为 Nai2API', imageUtils.imageEndpointProviderTag(''), 'Nai2API');
assertEqual('旧标签 (NAI) 不再出现在预设标签函数里', /'NAI'/.test(String(imageUtils.imageEndpointProviderTag)), false);

section('12b) 官方 API：尺寸必须按 64 对齐并夹住范围');
// 对齐是「四舍五入到最近的 64 倍数」：1001 距 1024 为 23、距 960 为 41，故取 1024。
assertEqual('非 64 倍数四舍五入到最近（1001 → 1024）', naiOff.normalizeNaiOfficialDimension(1001, 832), 1024);
assertEqual('1499 → 1472（距 1472 更近）', naiOff.normalizeNaiOfficialDimension(1499, 832), 1472);
assertEqual('已是 64 倍数则原样', naiOff.normalizeNaiOfficialDimension(1024, 832), 1024);
assertEqual('过小值夹到 64', naiOff.normalizeNaiOfficialDimension(10, 832), 64);
assertEqual('过大值夹到 2048', naiOff.normalizeNaiOfficialDimension(99999, 832), 2048);
assertEqual('非法值退回兜底', naiOff.normalizeNaiOfficialDimension('abc', 832), 832);
assertEqual('0 退回兜底', naiOff.normalizeNaiOfficialDimension(0, 832), 832);

section('12c) 官方 API：Opus 免费额度判定（步数 ≤28 且 ≤1MP）');
// 免费线是 1024*1024 = 1048576 像素。默认竖图 832×1216 = 1011712，**在**线内。
// 这一点容易凭直觉搞错（1.01MP 看着像超了 1MP，但 1MP 在代码里是 1048576 而非 10^6）。
assertEqual('832×1216（1011712px < 1048576px）在免费线内', naiOff.isNaiOfficialFreeTier({
    naiOfficialResolution: '832x1216', naiOfficialSteps: 28
}), true);
assertEqual('1024×1024（正好 1MP）在免费线内', naiOff.isNaiOfficialFreeTier({
    naiOfficialResolution: '1024x1024', naiOfficialSteps: 28
}), true);
assertEqual('640×640 免费', naiOff.isNaiOfficialFreeTier({
    naiOfficialResolution: '640x640', naiOfficialSteps: 28
}), true);
assertEqual('28 步正好免费', naiOff.isNaiOfficialFreeTier({
    naiOfficialResolution: '1024x1024', naiOfficialSteps: 28
}), true);
assertEqual('29 步超线', naiOff.isNaiOfficialFreeTier({
    naiOfficialResolution: '1024x1024', naiOfficialSteps: 29
}), false);
// 1024×1536 = 1572864 > 1048576，确实超线
assertEqual('1024×1536（1.57MP）超线', naiOff.isNaiOfficialFreeTier({
    naiOfficialResolution: '1024x1536', naiOfficialSteps: 28
}), false);
// 免费线换算成像素的边界：1216×832 与 832×1216 同值
assertEqual('横图 1216×832 同样免费', naiOff.isNaiOfficialFreeTier({
    naiOfficialResolution: '1216x832', naiOfficialSteps: 28
}), true);
// 自定义尺寸同样参与判定
assertEqual('自定义 512×512 + 20 步 → 免费', naiOff.isNaiOfficialFreeTier({
    naiOfficialCustomSizeEnabled: true, naiOfficialCustomWidth: 512, naiOfficialCustomHeight: 512, naiOfficialSteps: 20
}), true);
assertEqual('自定义 1472×1472 → 超线', naiOff.isNaiOfficialFreeTier({
    naiOfficialCustomSizeEnabled: true, naiOfficialCustomWidth: 1472, naiOfficialCustomHeight: 1472, naiOfficialSteps: 28
}), false);
// 恰好压在免费线上：1024×1024 免费、且只需再多一个 64 格就超线
assertEqual('1088×1024 = 1114112 超线', naiOff.isNaiOfficialFreeTier({
    naiOfficialCustomSizeEnabled: true, naiOfficialCustomWidth: 1088, naiOfficialCustomHeight: 1024, naiOfficialSteps: 28
}), false);

section('12d) 官方 API：超线原因要说清楚（否则用户不知道被扣了什么）');
const hintSteps = naiOff.describeNaiOfficialFreeStatus({ naiOfficialResolution: '1024x1024', naiOfficialSteps: 40 });
assertTrue('步数超线时点明步数', /步数 40 > 28/.test(hintSteps));
const hintPixels = naiOff.describeNaiOfficialFreeStatus({ naiOfficialResolution: '1024x1536', naiOfficialSteps: 28 });
assertTrue('像素超线时点明像素', /1\.57MP > 1\.00MP/.test(hintPixels));
assertEqual('在免费线内时不给提示', naiOff.describeNaiOfficialFreeStatus({
    naiOfficialResolution: '1024x1024', naiOfficialSteps: 28
}), '');
// 步数与像素同时超线时两条原因都要给
const hintBoth = naiOff.describeNaiOfficialFreeStatus({ naiOfficialResolution: '1024x1536', naiOfficialSteps: 40 });
assertTrue('两项都超线时都说明', /步数 40 > 28/.test(hintBoth) && /1\.57MP/.test(hintBoth));

section('12e) 官方 API：skip_cfg_above_sigma 必须区分 4.5 与 4');
// "nai-diffusion-4-5-full" 里含有 "nai-diffusion-4"，判断顺序写反会把 4.5 当成 4。
assertEqual('V4.5 → 58', naiOff.naiOfficialSkipCfgAboveSigma('nai-diffusion-4-5-full'), 58);
assertEqual('V4 → 19', naiOff.naiOfficialSkipCfgAboveSigma('nai-diffusion-4-full'), 19);
assertEqual('V3 → null（不启用）', naiOff.naiOfficialSkipCfgAboveSigma('nai-diffusion-3'), null);
assertEqual('V5 → null', naiOff.naiOfficialSkipCfgAboveSigma('nai-diffusion-5-full'), null);

section('12f) 官方 API：载荷结构与 params_version');
const p45 = naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-4-5-full', naiOfficialResolution: '1024x1024', naiOfficialSteps: 28, naiOfficialScale: 6, naiOfficialSeed: '12345' },
    prompt: 'a cat', negativePrompt: 'bad'
});
assertEqual('model 字段正确', p45.model, 'nai-diffusion-4-5-full');
assertEqual('action 是 generate', p45.action, 'generate');
assertEqual('input 是提示词', p45.input, 'a cat');
assertEqual('V4.5 用 params_version 4（与官方前端一致）', p45.parameters.params_version, 4);
// 官方侧三个「网关没有」的开关默认必须是关的：否则两边配置看起来一样、出图却不同。
assertEqual('默认 UC 预设=无（不叠官方短词）', p45.parameters.ucPresetId, 'none');
assertEqual('默认不发质量标签（qualityPresetId=none）', p45.parameters.qualityPresetId, 'none');
assertEqual('默认不带多样性增强（skip_cfg_above_sigma）', p45.parameters.skip_cfg_above_sigma, undefined);
const p45On = naiOff.buildNaiOfficialPayload({
    settings: {
        naiOfficialModel: 'nai-diffusion-4-5-full', naiOfficialResolution: '832x1216', naiOfficialSteps: 28,
        naiOfficialUcPreset: 0, naiOfficialQualityToggle: true, naiOfficialVarietyBoost: true
    },
    prompt: 'a cat', negativePrompt: 'bad'
});
assertEqual('显式选 Heavy 时发 heavy', p45On.parameters.ucPresetId, 'heavy');
assertEqual('显式开质量标签时发 standard', p45On.parameters.qualityPresetId, 'standard');
assertEqual('显式开多样性增强时带 58', p45On.parameters.skip_cfg_above_sigma, 58);
assertEqual('V4.5 不再发旧字段 ucPreset', p45.parameters.ucPreset, undefined);
assertEqual('V4.5 不再发旧字段 qualityToggle', p45.parameters.qualityToggle, undefined);
assertEqual('width/height 进 parameters', [p45.parameters.width, p45.parameters.height], [1024, 1024]);
assertEqual('steps 进 parameters', p45.parameters.steps, 28);
assertEqual('scale 进 parameters', p45.parameters.scale, 6);
assertEqual('seed 是数字', typeof p45.parameters.seed, 'number');
assertEqual('固定种子被采用', p45.parameters.seed, 12345);
assertEqual('extra_noise_seed 与 seed 一致（官方两者同值）', p45.parameters.extra_noise_seed, p45.parameters.seed);
assertEqual('n_samples 为 1', p45.parameters.n_samples, 1);
assertEqual('negative_prompt 在 parameters 里（不在顶层）', p45.parameters.negative_prompt, 'bad');
// 噪声计划必须落到 noise_schedule：漏掉它会导致「噪声计划」下拉完全没作用（曾漏过一次）。
assertEqual('noise_schedule 被写入（默认 karras）', p45.parameters.noise_schedule, 'karras');
const pSchedule = naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialNoiseSchedule: 'exponential' },
    prompt: 'x', negativePrompt: ''
});
assertEqual('用户选的 noise_schedule 生效', pSchedule.parameters.noise_schedule, 'exponential');
// 采样器同理
const pSampler = naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialSampler: 'k_dpmpp_2m' },
    prompt: 'x', negativePrompt: ''
});
assertEqual('用户选的 sampler 生效', pSampler.parameters.sampler, 'k_dpmpp_2m');
assertEqual('顶层没有 parameters 之外的多余键', Object.keys(p45).sort(), ['action', 'input', 'model', 'parameters']);
// V4/V5 才带 v4_prompt 结构
assertEqual('V4.5 带 v4_prompt', p45.parameters.v4_prompt.caption.base_caption, 'a cat');
assertEqual('V4.5 带 v4_negative_prompt', p45.parameters.v4_negative_prompt.caption.base_caption, 'bad');
assertEqual('V4.5 默认不带 skip_cfg_above_sigma（多样性增强默认关）', p45.parameters.skip_cfg_above_sigma, undefined);

const p5 = naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialResolution: '1024x1024', naiOfficialSteps: 28 },
    prompt: 'x', negativePrompt: ''
});
assertEqual('V5 用 params_version 4', p5.parameters.params_version, 4);
assertEqual('V5 不带 skip_cfg_above_sigma', p5.parameters.skip_cfg_above_sigma, undefined);

const p3 = naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-3', naiOfficialResolution: '832x1216', naiOfficialSteps: 28 },
    prompt: 'x', negativePrompt: ''
});
assertEqual('V3 用 params_version 3（老模型仍走旧字段）', p3.parameters.params_version, 3);
assertEqual('V3 旧字段 ucPreset 默认也是「无」（4）', p3.parameters.ucPreset, 4);
assertTrue('V3 旧字段 qualityToggle 默认关', p3.parameters.qualityToggle === false);
const p3On = naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-3', naiOfficialUcPreset: 0, naiOfficialQualityToggle: true },
    prompt: 'x', negativePrompt: ''
});
assertEqual('V3 显式选 Heavy → ucPreset 0', p3On.parameters.ucPreset, 0);
assertTrue('V3 显式开质量标签 → qualityToggle true', p3On.parameters.qualityToggle === true);

// UC 预设档位 → 字符串 id：各模型可用档位不同，缺档要按官方偏好表降级（不能硬塞未知 id）。
section('12g) 官方 UC 预设：数字档位 → 字符串 id（按模型可用性降级）');
assertEqual('V4.5 Full：0=heavy', naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-4-5-full', 0), 'heavy');
assertEqual('V4.5 Full：2=humanFocus', naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-4-5-full', 2), 'humanFocus');
assertEqual('V4.5 Full：3=furryFocus', naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-4-5-full', 3), 'furryFocus');
assertEqual('V4.5 Full：4=none', naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-4-5-full', 4), 'none');
assertEqual('V4.5 Curated：没有 furryFocus → 降级到 heavy',
    naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-4-5-curated', 3), 'heavy');
assertEqual('V4 Full：只有 heavy/light/none → humanFocus 降级到 heavy',
    naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-4-full', 2), 'heavy');
assertEqual('V4 Full：none 仍然可用', naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-4-full', 4), 'none');
assertEqual('V5：humanFocus 可用', naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-5-full', 2), 'humanFocus');
assertEqual('V3：furryFocus 没有 → 降级到 heavy',
    naiOff.resolveNaiOfficialUcPresetId('nai-diffusion-3', 3), 'heavy');
assertEqual('未知模型：一律 none', naiOff.resolveNaiOfficialUcPresetId('whatever-model', 0), 'none');
assertEqual('质量标签开了发 standard', naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialQualityToggle: false }, prompt: 'x', negativePrompt: ''
}).parameters.qualityPresetId, 'none');

// 网关参数：默认值必须与网关自己的默认一致（否则「两边看起来一样、出图不一样」重演）。
section('12h) Nai2API (RP HUB 网关) 参数默认值与配置项');
const gatewayDefaults = sandbox.window.RPHubConfig.uiOptions.naiGatewayDefaults;
assertEqual('网关默认步数 28', gatewayDefaults.steps, 28);
assertEqual('网关默认 scale 6', gatewayDefaults.scale, 6);
assertEqual('网关默认 cfg 0', gatewayDefaults.cfg, 0);
assertEqual('网关默认采样器 k_dpmpp_2m_sde', gatewayDefaults.sampler, 'k_dpmpp_2m_sde');
assertEqual('网关默认噪声计划 karras', gatewayDefaults.noiseSchedule, 'karras');
// 默认负面词：两条链路（网关 / 官方）共用同一份，就是原来硬编码在网关 URL 里的旧值。
const defaultNegative = sandbox.window.RPHubConfig.uiOptions.naiDefaultNegative;
assertTrue('内置默认负面词仍是旧值（含 owres/uta 等残字与手型词）',
    /^\{\{\{\{bad anatomy\}\}\}\}/.test(defaultNegative)
    && defaultNegative.includes('owres')
    && defaultNegative.includes('uta')
    && /\{shaka sign\}$/.test(defaultNegative));
assertEqual('默认负面词词数 53', defaultNegative.split(',').length, 53);
assertTrue('上一版干净版仍作为一次性迁移比对常量保留',
    sandbox.window.RPHubConfig.uiOptions.naiLegacyCleanNegative !== defaultNegative
    && sandbox.window.RPHubConfig.uiOptions.naiLegacyCleanNegative.includes('worst quality'));
// 留空 = 用内置默认；写了就用写的（两条链路共用同一个取值函数）
assertEqual('留空 → 内置默认', imageUtils.resolveNaiNegativePrompt(''), defaultNegative);
assertEqual('只有空白 → 内置默认', imageUtils.resolveNaiNegativePrompt('   '), defaultNegative);
assertEqual('undefined → 内置默认', imageUtils.resolveNaiNegativePrompt(undefined), defaultNegative);
assertEqual('自定义文本原样使用', imageUtils.resolveNaiNegativePrompt(' my-neg '), 'my-neg');
assertEqual('默认值本身原样使用', imageUtils.resolveNaiNegativePrompt(defaultNegative), defaultNegative);

assertTrue('网关采样器下拉有 k_dpmpp_2m_sde',
    sandbox.window.RPHubConfig.uiOptions.naiGatewaySamplers.some(item => item.value === 'k_dpmpp_2m_sde'));
// 这些参数决定画面，必须进「生图预设」字段表（同时也是缓存指纹的一部分）。
for (const field of ['naiGatewaySteps', 'naiGatewayScale', 'naiGatewayCfg', 'naiGatewaySampler', 'naiGatewayNoiseSchedule', 'naiGatewayNegativePrompt']) {
    assertTrue(`生图预设/指纹包含 ${field}`, imageUtils.IMAGE_PROFILE_FIELDS.includes(field));
}

// 网关参数写回生图 URL：老存档里硬编码的 steps=40 与旧负面词必须被换成当前设置值。
section('12i) NAI 网关：把出图参数写回生图 URL');
const legacyReplacement = '<div class="generated-image-card" data-image-request="http://gw.local/generate?tag=$1&token=abc&model=nai-diffusion-4-5-full&artist=AAA&size=%E7%AB%96%E5%9B%BE&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative=OLD_NEGATIVE_LIST&nocache=0&noise_schedule=karras"></div>';
const synced = imageUtils.applyNaiGatewayUrlParams(legacyReplacement, {
    steps: 28, scale: 6, cfg: 0, sampler: 'k_dpmpp_2m_sde', noiseSchedule: 'karras', negative: 'bad anatomy, low quality'
});
assertTrue('steps=40 被换成当前设置值 28', synced.includes('steps=28'));
assertTrue('旧的 OLD_NEGATIVE_LIST 被换掉', !synced.includes('OLD_NEGATIVE_LIST'));
assertTrue('新增的负面词被 URL 编码（逗号→%2C、空格→%20）', synced.includes('negative=bad%20anatomy%2C%20low%20quality&nocache=0'));
assertTrue('nocache 与 noise_schedule 仍然保留', synced.includes('nocache=0') && synced.includes('noise_schedule=karras'));
assertTrue('URL 之外的 HTML 结构没被破坏', synced.startsWith('<div class="generated-image-card"') && synced.endsWith('"></div>'));
const switchedSampler = imageUtils.applyNaiGatewayUrlParams(synced, { steps: 33, scale: 5, cfg: 0.2, sampler: 'k_euler', noiseSchedule: 'exponential', negative: 'x' });
assertTrue('采样器/噪声计划/scale/cfg 都能换', switchedSampler.includes('sampler=k_euler')
    && switchedSampler.includes('noise_schedule=exponential')
    && switchedSampler.includes('scale=5')
    && switchedSampler.includes('cfg=0.2')
    && switchedSampler.includes('steps=33'));
assertEqual('非网关 URL 原样返回（官方/SD/ComfyUI 不受影响）',
    imageUtils.applyNaiGatewayUrlParams('<img data-image-request="http://x/ai/generate-image?tag=$1&provider=novelai-official">', { steps: 33 }),
    '<img data-image-request="http://x/ai/generate-image?tag=$1&provider=novelai-official">');
assertEqual('V3 不带 v4_prompt（老模型没这套结构）', p3.parameters.v4_prompt, undefined);

// 种子留空 → 随机（官方语义 seed 0 由后端随机）
const pRandom = naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialSeed: '' },
    prompt: 'x', negativePrompt: ''
});
assertTrue('留空种子会生成一个正整数', Number.isInteger(pRandom.parameters.seed) && pRandom.parameters.seed > 0);

// 步数被夹在 1..50
const pClamp = naiOff.buildNaiOfficialPayload({
    settings: { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialSteps: 999 },
    prompt: 'x', negativePrompt: ''
});
assertEqual('步数上限夹到 50', pClamp.parameters.steps, 50);

section('12g) 官方 API：接线与界面检查');
assertTrue('app.js 使用 RPHubNaiOfficialUtils', appSource.includes('window.RPHubNaiOfficialUtils'));
assertTrue('生成链路走 generateWithNaiOfficial', appSource.includes('generateWithNaiOfficial'));
assertTrue('端点用 /ai/generate-image', appSource.includes('/ai/generate-image'));
assertTrue('鉴权用 Bearer（不是 URL token）', /'Authorization':\s*`Bearer \$\{token\}`/.test(appSource));
assertTrue('探活用 /user/subscription', appSource.includes('/user/subscription'));
assertTrue('官方 token 可回落到通用密钥', appSource.includes('settings.naiOfficialToken || settings.imageGenKey'));
// 密钥是独立的（不与网关那套互相覆盖）；地址则**只有一个**，与其余生图方式共用通用字段。
assertTrue('官方有独立密钥字段', appSource.includes('naiOfficialToken:'));
assertTrue('index.html 暴露官方密钥输入框', comfyIndexSource.includes('settings.naiOfficialToken'));
// 两个地址框功能完全一样，已合并成一个：官方地址只从通用字段取，留空用官方默认。
assertTrue('官方地址只从通用字段解析（不再有专属地址字段）',
    /const naiOfficialBaseUrl = \(\) => \{[\s\S]{0,260}normalizeServiceBaseUrl\(settings\.imageGenBaseUrl\)/.test(appSource));
assertTrue('官方不再暴露专属地址输入框', !comfyIndexSource.includes('settings.naiOfficialBaseUrl'));
assertTrue('官方专属地址不再进预设字段', !imageUtils.IMAGE_PROFILE_FIELDS.includes('naiOfficialBaseUrl'));
assertTrue('历史遗留的专属地址键被清理', appSource.includes('delete settings.naiOfficialBaseUrl'));
// 尺寸只有一个来源：官方用「分辨率」档位，通用的「生图比例」在官方下隐藏（避免两个控件打架）。
assertTrue('官方下隐藏通用「生图比例」',
    /<!-- Image Size[\s\S]{0,400}v-if="!isNaiOfficialProvider"[\s\S]{0,400}settings\.imageSize/.test(comfyIndexSource));
assertTrue('官方「分辨率」仍在', comfyIndexSource.includes('naiOfficialResolutionOptions'));
// 密钥不该随预设走
assertTrue('官方 token 不随生图预设保存（避免切预设换密钥）',
    !imageUtils.IMAGE_PROFILE_FIELDS.includes('naiOfficialToken'));
assertTrue('官方出图参数随预设保存',
    ['naiOfficialModel', 'naiOfficialResolution', 'naiOfficialSteps', 'naiOfficialScale']
        .every(f => imageUtils.IMAGE_PROFILE_FIELDS.includes(f)));
assertTrue('index.html 暴露官方面板', comfyIndexSource.includes('settings.naiOfficialModel'));
assertTrue('index.html 暴露官方分辨率档位', comfyIndexSource.includes('naiOfficialResolutionOptions'));
assertTrue('index.html 暴露免费额度标记', comfyIndexSource.includes('naiOfficialIsFree'));
assertTrue('index.html 暴露官方自定义分辨率', comfyIndexSource.includes('settings.naiOfficialCustomSizeEnabled'));
assertTrue('index.html 暴露 UC 预设', comfyIndexSource.includes('naiOfficialUcPresetOptions'));
assertTrue('免费判定走纯函数（不在模板里重算）',
    appSource.includes('naiOfficialUtils.isNaiOfficialFreeTier'));
// 归档 model 要区分官方 API
assertTrue('归档 model 区分官方 API', /isNaiOfficialProvider\.value[\s\S]{0,120}naiOfficialModel/.test(appSource));

section('12h) 官方 API：账户额度（订阅等级 / 试用张数 / 训练步数 / V5 充能）');
// 前提事实：官方公开 API 不返回 Anlas。断言我们确实没有去请求一个不存在的端点/字段，
//（注释里出现「Anlas」是在说明这件事，所以只查是否真的去读了该字段或打了该路径）。
assertTrue('app.js 没有请求 Anlas 端点',
    !/[`'"][^`'"]*\/anlas/i.test(appSource) && !/\.anlas\b/i.test(appSource));
assertTrue('官方账户查询用 /user/subscription', appSource.includes('${baseUrl}/user/subscription'));
assertTrue('官方账户查询用 /user/information', appSource.includes('${baseUrl}/user/information'));
// V5 充能来自 subscription.usage：**不是**新端点，也没有编造字段。
assertTrue('充能走的是既有 subscription 响应的 usage 字段',
    appSource.includes('naiOfficialUtils.resolveNaiOfficialAccount({ subscription, information })')
    && naiOffSource.includes('resolveNaiOfficialUsage(sub?.usage)'));
assertTrue('充能没有额外发请求（仍是那两个端点）',
    !/\/user\/(usage|battery|quota)/i.test(appSource));

const acct = naiOff.resolveNaiOfficialAccount({
    subscription: {
        tier: 3, active: true, expiresAt: 1789000000000,
        trainingStepsLeft: { fixedTrainingStepsLeft: 30, purchasedTrainingSteps: 5 },
        usage: { percent: 69, isNegative: false, timeUntilNextPercent: 7888 }
    },
    information: { trialImagesLeft: 27, trialActionsLeft: 100 }
});
assertEqual('Opus 档位标签', acct.tierLabel, 'Opus');
assertEqual('订阅生效', acct.active, true);
assertEqual('到期时间保留', acct.expiresAt, 1789000000000);
assertEqual('试用剩余张数', acct.trialImagesLeft, 27);
assertEqual('训练步数为两者之和', acct.trainingStepsLeft, 35);
assertEqual('已购训练步数分开记', acct.purchasedTrainingSteps, 5);
assertEqual('V5 充能挂在账户对象上', acct.usage?.percent, 69);

// --- V5 充能条的口径（逐字对照官方前端）---
assertEqual('充能百分比是「剩余」不是「已用」', naiOff.naiOfficialUsagePercent(acct.usage), 69);
assertEqual('条宽取百分比', naiOff.naiOfficialUsageBarPercent(acct.usage), 69);
assertEqual('回充速度 = 86400 / 每 1% 秒数（1 位小数）',
    naiOff.naiOfficialUsageRefillRatePerDay(acct.usage), 11);
assertEqual('可出图数 = 17.3 张 / %', naiOff.naiOfficialUsageImagesLeft(acct.usage), 1194);
assertEqual('官方比例常量就是 17.3', naiOff.NAI_OFFICIAL_USAGE_IMAGES_PER_PERCENT, 17.3);
assertEqual('69% 不是低位', naiOff.isNaiOfficialUsageLow(acct.usage), false);
assertEqual('4.9% 算低位', naiOff.isNaiOfficialUsageLow({ percent: 4.9, isNegative: false }), true);
assertEqual('5% 不算低位（边界）', naiOff.isNaiOfficialUsageLow({ percent: 5, isNegative: false }), false);
assertEqual('isNegative 一定算低位', naiOff.isNaiOfficialUsageLow({ percent: 80, isNegative: true }), true);

// 用尽：官方显示 0%
assertEqual('用尽时条宽 0', naiOff.naiOfficialUsageBarPercent({ percent: 0, isNegative: true }), 0);
assertEqual('用尽时秒数为 0 → 回充速度 0（不除零、不出 Infinity）',
    naiOff.naiOfficialUsageRefillRatePerDay({ percent: 0, isNegative: true, timeUntilNextPercent: 0 }), 0);
assertTrue('用尽文案含「已用尽」', /已用尽/.test(naiOff.describeNaiOfficialUsage({ percent: 0, isNegative: true })));

// 奖励额度（官方发过 100% 奖励）：>100 合法，数字不封顶、条宽封顶
const bonus = naiOff.resolveNaiOfficialUsage({ percent: 140, isNegative: false, timeUntilNextPercent: 0 });
assertEqual('奖励额度数字保留 140', naiOff.naiOfficialUsagePercent(bonus), 140);
assertEqual('奖励额度条宽封顶 100', naiOff.naiOfficialUsageBarPercent(bonus), 100);

// 负数/坏数据不许把条画反
assertEqual('负百分比的条宽夹到 0', naiOff.naiOfficialUsageBarPercent({ percent: -30, isNegative: false }), 0);
assertEqual('负百分比的数字夹到 0', naiOff.naiOfficialUsagePercent({ percent: -30, isNegative: false }), 0);

// 缺字段不崩、不编造
assertEqual('无 usage → null', naiOff.resolveNaiOfficialUsage(undefined), null);
assertEqual('percent 缺失 → null', naiOff.resolveNaiOfficialUsage({ isNegative: false }), null);
assertEqual('usage=null 时文案为空串', naiOff.describeNaiOfficialUsage(null), '');
assertEqual('usage=null 时条宽 0', naiOff.naiOfficialUsageBarPercent(null), 0);
assertEqual('秒数缺失时只记 null（回充暂停/已满）',
    naiOff.resolveNaiOfficialUsage({ percent: 50, isNegative: false }).secondsPerPercent, null);
assertEqual('非 Opus 响应没有 usage 字段时整块为 null',
    naiOff.resolveNaiOfficialAccount({ subscription: { tier: 1, active: true } }).usage, null);

// 只有 V5 消耗充能（官方前端 opusUsageLimit 只对 nai-diffusion-5-* 为真）
assertEqual('V5 Full 消耗充能', naiOff.isNaiOfficialUsageModel('nai-diffusion-5-full'), true);
assertEqual('V5 Curated 消耗充能', naiOff.isNaiOfficialUsageModel('nai-diffusion-5-curated'), true);
assertEqual('V4.5 不消耗充能', naiOff.isNaiOfficialUsageModel('nai-diffusion-4-5-full'), false);
assertEqual('V4 不消耗充能', naiOff.isNaiOfficialUsageModel('nai-diffusion-4-full'), false);
assertEqual('空模型不消耗充能', naiOff.isNaiOfficialUsageModel(''), false);

// 界面接线：条宽只能用封顶后的值，且文案与提示都要接上
assertTrue('index.html 暴露充能条', comfyIndexSource.includes('V5 充能（Opus 生成额度）'));
assertTrue('index.html 的条宽用封顶值（naiOfficialUsageBarPercent）',
    /:style="\{ width: Math\.min\(100, Math\.max\(0, naiOfficialUsageBarPercent\)\) \+ '%' \}"/.test(comfyIndexSource));
assertTrue('index.html 没有直接把未封顶的百分比当宽度用',
    !/:style="\{ width: naiOfficialUsagePercentLabel/.test(comfyIndexSource));
assertTrue('没有 usage 时整块不渲染（v-if，不摆空条）',
    /<div v-if="naiOfficialUsage" class="mt-3 pt-3 border-t border-gray-100">/.test(comfyIndexSource));
assertTrue('用尽时给 Anlas 提醒', comfyIndexSource.includes('继续出图会消耗 Anlas'));
assertTrue('回充速度写进界面', comfyIndexSource.includes('naiOfficialUsageRefillRate'));
assertTrue('界面按「是否 V5」区分充能是否被消耗', comfyIndexSource.includes('naiOfficialUsageApplies'));
// 用尽时不重复同一句提醒（条下面那句已经说过了）
assertTrue('用尽时不重复提醒（hint 直接返回空串）',
    /if \(usage\.isNegative\) return '';[\s\S]{0,120}V5 充能偏低/.test(appSource));
assertTrue('用尽时不再叠一句「当前选的正是 V5」',
    /v-if="!naiOfficialUsage\.isNegative && naiOfficialUsageApplies"/.test(comfyIndexSource));
assertTrue('app.js 导出充能相关状态给模板',
    ['naiOfficialUsage,', 'naiOfficialUsageBarPercent', 'naiOfficialUsagePercentLabel',
        'naiOfficialUsageRefillRate', 'naiOfficialUsageLow', 'naiOfficialUsageApplies']
        .every(name => appSource.includes(name)));
assertTrue('充能提示是本地推导，不额外发请求',
    /naiOfficialUsageHint = computed\(\(\) => \{/.test(appSource));
// 对抗检查发现的真 bug：查询失败时界面一边报错、一边还画着上次的充能条（会误导成当前额度）。
assertTrue('查询失败时清掉上一次的数据（不留旧充能条）',
    /catch \(error\) \{[\s\S]{0,300}naiOfficialAccount\.data = null;/.test(appSource));
assertTrue('充能只在本次查询成功时才取（loaded 且无 error）',
    /naiOfficialUsage = computed\([\s\S]{0,160}naiOfficialAccount\.loaded && !naiOfficialAccount\.error/.test(appSource));

assertEqual('免费试用档（tier 0）标签', naiOff.resolveNaiOfficialAccount({ subscription: { tier: 0 } }).tierLabel, '免费试用（Paper）');
assertEqual('Tablet 档', naiOff.resolveNaiOfficialAccount({ subscription: { tier: 1 } }).tierLabel, 'Tablet');
assertEqual('Scroll 档', naiOff.resolveNaiOfficialAccount({ subscription: { tier: 2 } }).tierLabel, 'Scroll');
assertEqual('未知档位有兜底', naiOff.resolveNaiOfficialAccount({ subscription: { tier: 9 } }).tierLabel, '等级 9');
// 缺字段不能崩，且不能编造数字
const partialAcct = naiOff.resolveNaiOfficialAccount({ subscription: { tier: 3 } });
assertEqual('缺 trainingStepsLeft 时步数为 0', partialAcct.trainingStepsLeft, 0);
assertEqual('缺 trialImagesLeft 时为 null（不假装是 0）', partialAcct.trialImagesLeft, null);
assertEqual('expiresAt 缺失时为 null', partialAcct.expiresAt, null);
assertEqual('完全空响应返回 null', naiOff.resolveNaiOfficialAccount({}), null);
assertEqual('null 入参安全', naiOff.resolveNaiOfficialAccount(null), null);
// expiresAt 为 0（免费档常见）不该显示成 1970 年
assertEqual('expiresAt=0 视为无到期时间', naiOff.resolveNaiOfficialAccount({ subscription: { tier: 0, expiresAt: 0 } }).expiresAt, null);

const label = naiOff.describeNaiOfficialAccount(acct);
assertTrue('额度文案含档位', /Opus/.test(label));
assertTrue('额度文案含试用张数', /试用剩余 27 张/.test(label));
assertTrue('额度文案含训练步数', /训练步数 35/.test(label));
assertEqual('空账户文案为空串', naiOff.describeNaiOfficialAccount(null), '');
assertTrue('订阅未生效时会点明', /订阅未生效/.test(naiOff.describeNaiOfficialAccount({ tierLabel: 'Opus', active: false, trialImagesLeft: null, trainingStepsLeft: 0 })));

// --- 13. 夜间模式（移植自上游 1.9.6，1.9.7 优化观感）---
// 主题必须是「零依赖 + 样式前同步执行」，否则深色下会闪白。
section('13) 夜间模式：接线与防闪白');
const themeJs = readFileSync(join(root, 'assets/js/theme.js'), 'utf8');
const themeCss = readFileSync(join(root, 'assets/css/theme.css'), 'utf8');
const indexSource2 = readFileSync(join(root, 'index.html'), 'utf8');
assertTrue('theme.js 存在并暴露 RPHubTheme', themeJs.includes('window.RPHubTheme'));
assertTrue('主题存 localStorage（跨会话记住）', themeJs.includes("localStorage.getItem(key)"));
assertTrue('主题靠 data-app-theme 驱动', themeJs.includes('root.dataset.appTheme = theme'));
assertTrue('三个入口用 postMessage 同步', themeJs.includes('RPHUB_THEME') && themeJs.includes('RPHUB_THEME_REQUEST'));
// theme.js 必须排在 styles.css 之前：它是同步脚本，晚于样式就会先渲染浅色再切深色（闪白）
const themeJsPos = indexSource2.indexOf('assets/js/theme.js');
const stylesCssPos = indexSource2.indexOf('assets/css/styles.css');
assertTrue('theme.js 在样式之前加载（防深色闪白）', themeJsPos > 0 && themeJsPos < stylesCssPos);
assertTrue('theme.css 被引入', indexSource2.includes('assets/css/theme.css'));
// 两个 iframe 页也要接入，否则切主题时它们不跟着变
for (const page of ['character/index.html', 'novel/index.html']) {
    const src = readFileSync(join(root, page), 'utf8');
    assertTrue(`${page} 引入 theme.js`, src.includes('theme.js'));
    assertTrue(`${page} 引入 theme.css`, src.includes('theme.css'));
}
assertTrue('导航面板有主题切换按钮', readFileSync(join(root, 'assets/js/ui-components.js'), 'utf8').includes('appearance-switch'));
assertTrue('theme.css 无远程依赖（本机全离线）', !/https?:\/\//.test(themeCss) && !/@import/.test(themeCss));
assertTrue('theme.css 定义深色变量', themeCss.includes('--night-canvas') && themeCss.includes('--night-text'));
assertTrue('深色覆盖到 .app-main（主容器不露白）', themeCss.includes('body .app-main'));
// 本机特有的容器也要覆盖，否则深色下会露白
assertTrue('深色覆盖开场过渡层（防启动闪白）', themeCss.includes('.entry-transition'));
assertTrue('深色覆盖聊天根容器（壁纸半透明处不露浅底）', themeCss.includes('.chat-view-root'));
assertTrue('深色覆盖本机设置卡片', themeCss.includes('.generation-setting-card'));

// --- 14. 批量导入角色卡 ---
// 逻辑写在 character/index.html 的内联 setup 里，这里按仓库惯例做源码级断言，
// 保证「多选/拖拽 → 逐卡汇报 → 坏卡不中断」这条链路不被后续改动弄断。
section('14) 批量导入角色卡：多选/拖拽、逐卡汇报、坏卡不中断');
const characterPage = readFileSync(join(root, 'character/index.html'), 'utf8');

assertTrue('侧栏有批量导入入口', characterPage.includes('@click="openBatchImport"'));
assertTrue('弹窗由 batchImport.show 驱动', characterPage.includes("'modal-open': batchImport.show"));
assertTrue('支持多选（input multiple）', /<input type="file" class="hidden" multiple accept="\.png,\.json/.test(characterPage));
assertTrue('支持拖拽放入', characterPage.includes('@drop.prevent="onBatchImportDrop"'));
assertTrue('拖拽高亮不因划过子元素闪断', characterPage.includes('isInsideDropZone(event)'));
assertTrue('逐个文件展示状态（待导入/已导入/已跳过/失败）', [
    "pending: '待导入'",
    "ok: '已导入'",
    "skip: '已跳过'",
    "fail: '失败'"
].every(label => characterPage.includes(label)));
assertTrue('展示导入进度条', characterPage.includes('class="progress progress-primary w-full"'));
assertTrue('同一批里重复选择的文件自动忽略', characterPage.includes('已忽略 ${ignored} 个重复选择的文件'));
assertTrue('可跳过与已有卡片重复的角色', characterPage.includes('v-model="batchImport.skipDuplicates"'));
assertTrue('重复判定用「名称 + 开场白」指纹', characterPage.includes('const characterFingerprint = (char) =>'));
assertTrue('坏卡逐个捕获，不中断整批', /catch \(err\) \{\s*item\.status = 'fail'/.test(characterPage));
assertTrue('顺序处理（不并发铺开整个批次）', characterPage.includes('for (const item of queue)'));
assertTrue('批量与单张共用同一解析器（避免两套逻辑分叉）',
    (characterPage.match(/parseCharacterCardFile\(/g) || []).length >= 2);
assertTrue('File 以 markRaw 存入响应式数组（否则 FileReader 拒绝代理对象）', characterPage.includes('file: markRaw(file)'));
assertTrue('不支持的格式列进列表并标注原因', characterPage.includes('不支持的格式（仅 .json / .png）'));
assertTrue('导入完成后跳到刚导入的角色', characterPage.includes('currentCharacterIndex.value = lastImportedIndex'));

// --- 15. 缓存指纹：切换比例/分辨率不算「参数变了」 ---
// 线上现象（第 51 条）：用官方 API 出一批横图后把分辨率切成竖图，前面那批横图被判成
// 「参数变了」而全部重跑（白花 Anlas）。根因是比例/尺寸类字段与 URL 里的 size/w/h
// 也进了缓存指纹。这里把「尺寸不进指纹、其余参数照旧进」两件事都钉住。
section('15) 缓存指纹：切换比例/分辨率不得让历史图重跑');

const fpBase = {
    imageProvider: 'novelai-official',
    imageGenBaseUrl: '',
    imageStyle: 'vertical',
    customImageArtists: '',
    imageModel: 'nai-diffusion-4-5-full',
    imageSize: '横图',
    naiOfficialModel: 'nai-diffusion-4-5-full',
    naiOfficialResolution: '1216x832',
    naiOfficialSteps: 28,
    naiOfficialScale: 5,
    naiOfficialSampler: 'k_euler_ancestral',
    naiOfficialUcPreset: 4,
    naiOfficialQualityToggle: false,
    naiOfficialVarietyBoost: false,
    naiOfficialNegativePrompt: '',
    naiOfficialSeed: ''
};
const officialUrl = (size, w, h) => `http://x/ai/generate-image?tag=1girl&provider=novelai-official&size=${size}&w=${w}&h=${h}`;
const fpOf = (patch = {}, url) => imageUtils.resolveImageCacheFingerprint({
    settings: { ...fpBase, ...patch },
    requestUrl: url || officialUrl('横图', 1216, 832)
});
const fpJson = (fingerprint) => JSON.parse(fingerprint);

// 尺寸字段清单必须与「生图预设字段表」对得上：改名/删字段时这里会先炸。
assertTrue('被排除的尺寸字段都还在生图预设字段表里（改名不会静默漏掉）',
    imageUtils.IMAGE_CACHE_SIZE_FIELDS.every(field => imageUtils.IMAGE_PROFILE_FIELDS.includes(field)));
assertTrue('比例仍留在生图预设里（切预设照样带比例）',
    imageUtils.IMAGE_PROFILE_FIELDS.includes('imageSize')
    && imageUtils.captureImageProfile(fpBase).naiOfficialResolution === '1216x832');
assertTrue('尺寸字段确实不在指纹里（结构级）',
    !fpJson(fpOf()).profile.imageSize
    && !fpJson(fpOf()).profile.naiOfficialResolution
    && !('w' in fpJson(fpOf()).request)
    && !('size' in fpJson(fpOf()).request));
assertEqual('URL 里其余参数仍然留下（provider）', fpJson(fpOf()).request.provider, 'novelai-official');
assertEqual('网关 URL 的 steps 仍在指纹里',
    fpJson(imageUtils.resolveImageCacheFingerprint({
        settings: fpBase,
        requestUrl: 'http://x/generate?tag=a&steps=40&size=横图&w=1216&h=832&sampler=k_euler'
    })).request.steps, '40');

// 用户场景：官方 API 横图（1216×832）→ 竖图（832×1216）
const fpHorizontal = fpOf();
const fpVertical = fpOf({ naiOfficialResolution: '832x1216' }, officialUrl('竖图', 832, 1216));
assertEqual('官方分辨率 横→竖：指纹不变', fpHorizontal === fpVertical, true);
assertEqual('切换后历史横图条目不算过期（不重跑、不烧 Anlas）',
    imageUtils.isCachedImageJobOutdated({ imageFingerprint: fpHorizontal }, fpVertical), false);
assertEqual('通用「生图比例」横→竖：指纹不变', fpOf({ imageSize: '横图' }) === fpOf({ imageSize: '竖图' }), true);
assertEqual('SD 自定义分辨率：指纹不变',
    fpOf({ imageProvider: 'stable-diffusion', sdCustomWidth: 1216, sdCustomHeight: 832 })
    === fpOf({ imageProvider: 'stable-diffusion', sdCustomWidth: 832, sdCustomHeight: 1216 }), true);
assertEqual('ComfyUI 尺寸覆盖：指纹不变',
    fpOf({ imageProvider: 'comfyui', comfyWidth: 1216, comfyHeight: 832, comfyOverrideSize: true })
    === fpOf({ imageProvider: 'comfyui', comfyWidth: 832, comfyHeight: 1216, comfyOverrideSize: true }), true);

// 真正改变画面的参数：只会被判成「这张图是按旧参数出的」——用来给卡片打提示，
// **不再触发重跑**（第 53 条：历史图是快照，进旧会话/换预设都不该付重跑那笔 Anlas；
//  想按新参数重出，由用户点卡片上的 ↻，走 fresh 路径）。
const fpChanged = [
    ['负面提示词', { naiOfficialNegativePrompt: 'bad anatomy' }],
    ['步数', { naiOfficialSteps: 40 }],
    ['采样器', { naiOfficialSampler: 'k_euler' }],
    ['模型', { naiOfficialModel: 'nai-diffusion-5-full' }],
    ['画风', { imageStyle: 'r18' }],
    ['生图方式', { imageProvider: 'novelai' }],
    ['服务地址', { imageGenBaseUrl: 'http://elsewhere' }]
];
fpChanged.forEach(([label, patch]) => {
    const changed = fpOf(patch);
    assertEqual(`改了${label} → 判为「按旧参数出的」（只提示，不重跑）`,
        imageUtils.isCachedImageJobOutdated({ imageFingerprint: fpHorizontal }, changed), true);
});
assertEqual('URL 里的 steps 变化 → 判为「按旧参数出的」',
    imageUtils.isCachedImageJobOutdated(
        { imageFingerprint: imageUtils.resolveImageCacheFingerprint({ settings: fpBase, requestUrl: 'http://x/generate?tag=a&steps=40' }) },
        imageUtils.resolveImageCacheFingerprint({ settings: fpBase, requestUrl: 'http://x/generate?tag=a&steps=28' })
    ), true);

// 升级兼容：老存档里的指纹是「带尺寸字段」的旧算法算出来的字符串，
// 直接比字符串会让升级后历史图全部被当成「参数变了」，所以比较前两边都要归一化。
const legacyFingerprint = JSON.stringify({
    provider: 'novelai-official',
    baseUrl: '',
    profile: {
        ...imageUtils.captureImageProfile(fpBase)
    },
    request: { provider: 'novelai-official', size: '横图', w: '1216', h: '832' }
});
assertEqual('老指纹（带尺寸字段）在新比例下不算过期',
    imageUtils.isCachedImageJobOutdated({ imageFingerprint: legacyFingerprint }, fpVertical), false);
const legacyChanged = JSON.stringify({
    provider: 'novelai-official',
    baseUrl: '',
    profile: { ...imageUtils.captureImageProfile({ ...fpBase, naiOfficialSteps: 40 }) },
    request: { provider: 'novelai-official', size: '横图', w: '1216', h: '832' }
});
assertEqual('老指纹里真正变了的参数仍然判为「按旧参数出的」',
    imageUtils.isCachedImageJobOutdated({ imageFingerprint: legacyChanged }, fpVertical), true);
const shuffledKeys = JSON.stringify({
    baseUrl: '',
    profile: Object.fromEntries(Object.entries(imageUtils.captureImageProfile(fpBase)).reverse()),
    request: { h: '832', size: '横图', w: '1216', provider: 'novelai-official' },
    provider: 'novelai-official'
});
assertEqual('键顺序不影响比较结果（老存档字段顺序可能不同）',
    imageUtils.isCachedImageJobOutdated({ imageFingerprint: shuffledKeys }, fpVertical), false);
assertEqual('没有指纹的老条目一律不算过期（升级不重跑）',
    imageUtils.isCachedImageJobOutdated({ status: 'done', imageUrl: 'x' }, fpVertical), false);
assertEqual('非 JSON 指纹不会炸，也不会误判', imageUtils.isCachedImageJobOutdated({ imageFingerprint: 'v1' }, 'v1'), false);

// --- 16. 角色卡管理：批量导入接线 ---
// 主应用（index.html + app.js + ui-components.js）里「添加角色卡」菜单下的批量入口。
section('16) 角色卡管理 → 添加角色卡：批量导入接线');
const mainIndex = readFileSync(join(root, 'index.html'), 'utf8');
const appJs = readFileSync(join(root, 'assets/js/app.js'), 'utf8');
const uiJs = readFileSync(join(root, 'assets/js/ui-components.js'), 'utf8');

assertTrue('菜单里新增「批量导入角色卡」', uiJs.includes('批量导入角色卡'));
assertTrue('批量入口是多选文件（multiple + 专用事件）', /multiple[^>]*import-character-batch/.test(uiJs));
assertTrue('AddCharacterModal 声明批量事件', uiJs.includes("'import-character-batch'"));
assertTrue('批量弹窗组件已导出到 RPHubComponents', uiJs.includes('BatchImportCharacterModal,'));
assertTrue('批量弹窗与事件在 index.html 接线',
    mainIndex.includes('<batch-import-character-modal') && mainIndex.includes('@import-character-batch="openBatchCharacterImport($event)"'));
assertTrue('app.js 引入批量弹窗组件', appJs.includes('BatchImportCharacterModal,'));
assertTrue('弹窗拖拽高亮过滤内部元素', uiJs.includes('isInsideDropZone(event)'));
assertTrue('批量导入复用单张解析（parseCharacterCardFile）', appJs.includes('const parseCharacterCardFile = async (file) =>'));
assertTrue('File 以 markRaw 存放（否则 FileReader 拒绝代理对象）', appJs.includes('file: markRaw(file)'));
assertTrue('重复判定用「名称 + 开场白」指纹', appJs.includes('const characterCardFingerprint = (char) =>'));
assertTrue('单张导入新增 save 开关供批量复用',
    /const importCharacterData = async \(rawData, avatarUrl, \{ askImageGeneration = true, activate = true, save = true \} = \{\}\)/.test(appJs));
assertTrue('批量导入不逐张落盘（save: false）', appJs.includes('save: false'));
assertTrue('整批只落盘一次并在失败时回滚', appJs.includes('const rollback = new Set(importedUuids);'));
assertTrue('顺序处理且逐张让出主线程', appJs.includes('for (const item of queue)') && appJs.includes('await new Promise(resolve => setTimeout(resolve, 0));'));

// --- 17. 生图风格：自定义画师串的命名预设（保存 / 删除）---
// 需求：把自定义画师串存成命名预设（存「可爱风格」→ 下拉显示「可爱风格(自定义)」），
// 且**所有生图方式**都能选到；内置风格不可删除，只有自己存的能删。
const cardUtils = sandbox.window.RPHubCardUtils;
assertTrue('core-utils 导出 RPHubCardUtils', Boolean(cardUtils));

section('17) 生图风格预设：命名、显示、取值');
const cuteArtists = 'artist:cute, soft lighting, pastel colors';
const stylePreset = cardUtils.upsertImageStylePreset([], { name: '可爱风格', artists: cuteArtists });
assertEqual('保存成功', stylePreset.added, true);
assertEqual('返回新 id', typeof stylePreset.id, 'string');
assertEqual('列表里有一条', stylePreset.presets.length, 1);
assertEqual('画师串原样保存', stylePreset.presets[0].artists, cuteArtists);

// 显示名：自定义预设统一带「(自定义)」后缀，与内置风格区分开
assertEqual('下拉显示名带「(自定义)」后缀', cardUtils.imageStylePresetLabel('可爱风格'), '可爱风格(自定义)');
assertEqual('下拉显示名能拼进选项列表', cardUtils.imageStylePresetLabel(stylePreset.presets[0].name), '可爱风格(自定义)');

// imageStyle 的值：'custom:<id>'，四个生图方式共用同一个字段
const cuteValue = cardUtils.imageStylePresetValue(stylePreset.id);
assertTrue('预设值以 custom: 前缀标识', cardUtils.isImageStylePresetValue(cuteValue));
assertEqual('能从值里取回 id', cardUtils.parseImageStylePresetValue(cuteValue), stylePreset.id);
assertEqual('内置风格不会被认成预设', cardUtils.isImageStylePresetValue('vertical'), false);
assertEqual('裸「自定义」不是命名预设', cardUtils.isImageStylePresetValue('custom'), false);
assertEqual('空值安全', cardUtils.parseImageStylePresetValue(null), '');

// 取值：选中预设 + 文本框为空 → 用预设里存的画师串（不能静默回落到内置风格）
assertEqual('选中预设时用预设的画师串',
    cardUtils.getImageStyleArtists(cuteValue, '', stylePreset.presets), cuteArtists);
// 文本框优先：选中预设时界面已把画师串载入文本框，用户改动要生效
assertEqual('文本框优先于预设（可见即可得）',
    cardUtils.getImageStyleArtists(cuteValue, 'artist:edited', stylePreset.presets), 'artist:edited');
// 预设被删（或老存档没带列表）→ 退回文本框，绝不换成内置风格出图
assertEqual('预设已删时退回文本框内容', cardUtils.getImageStyleArtists(cuteValue, 'artist:kept', []), 'artist:kept');
assertEqual('预设与文本框都没有时不落到内置风格',
    cardUtils.getImageStyleArtists(cuteValue, '', []), '');

// 内置风格的行为完全不变
assertEqual('内置风格仍然取内置画师串',
    cardUtils.getImageStyleArtists('vertical', '', stylePreset.presets),
    sandbox.window.RPHubBuiltinContent.imageStyleArtists.vertical);
assertEqual('裸「自定义」仍然只认文本框',
    cardUtils.getImageStyleArtists('custom', 'artist:raw', stylePreset.presets), 'artist:raw');
assertEqual('未知风格仍然回落内置竖图风格',
    cardUtils.getImageStyleArtists('who-knows', '', stylePreset.presets),
    sandbox.window.RPHubBuiltinContent.imageStyleArtists.vertical);

section('17b) 生图风格预设：更新 / 去重 / 删除');
// 同名再存 = 更新那一条，不会出现两个「可爱风格(自定义)」
const styleUpdated = cardUtils.upsertImageStylePreset(stylePreset.presets, { name: '可爱风格', artists: 'artist:cute-v2' });
assertEqual('同名不新增', styleUpdated.presets.length, 1);
assertEqual('同名视为更新', styleUpdated.added, false);
assertEqual('id 保持不变（选中状态不丢）', styleUpdated.id, stylePreset.id);
assertEqual('画师串被更新', styleUpdated.presets[0].artists, 'artist:cute-v2');

const styleTwo = cardUtils.upsertImageStylePreset(styleUpdated.presets, { name: '暗黑风格', artists: 'artist:dark' });
assertEqual('不同名会新增', styleTwo.presets.length, 2);

// 空名 / 空画师串要报错，不能存出无名或空预设
assertEqual('空名被拒', cardUtils.upsertImageStylePreset(styleTwo.presets, { name: '  ', artists: 'x' }).error, '预设名称不能为空');
assertEqual('空画师串被拒', cardUtils.upsertImageStylePreset(styleTwo.presets, { name: 'n', artists: ' ' }).error, '画师串不能为空');
assertEqual('被拒时不改动列表', cardUtils.upsertImageStylePreset(styleTwo.presets, { name: '', artists: '' }).presets.length, 2);

// 删除只影响指定的一条
const styleAfterDelete = cardUtils.removeImageStylePreset(styleTwo.presets, styleTwo.id);
assertEqual('删除后只剩一条', styleAfterDelete.length, 1);
assertEqual('删掉的是指定那条', styleAfterDelete[0].id, stylePreset.id);
assertEqual('删不存在的 id 不报错', cardUtils.removeImageStylePreset(styleAfterDelete, 'nope').length, 1);
assertEqual('删空列表安全', cardUtils.removeImageStylePreset(null, 'x').length, 0);

section('17c) 生图风格预设：坏存档收敛');
// 存档是不可信输入：坏条目丢弃、重复 id 收敛、数量封顶
assertEqual('非数组 → 空列表', cardUtils.normalizeImageStylePresets('oops'), []);
assertEqual('缺 name 的条目被丢弃', cardUtils.normalizeImageStylePresets([{ artists: 'x' }]).length, 0);
assertEqual('缺画师串的条目被丢弃', cardUtils.normalizeImageStylePresets([{ name: 'n' }]).length, 0);
assertEqual('非对象条目被丢弃', cardUtils.normalizeImageStylePresets([null, 'x', 3]).length, 0);
const duped = cardUtils.normalizeImageStylePresets([
    { id: 'same', name: 'a', artists: '1' },
    { id: 'same', name: 'b', artists: '2' }
]);
assertEqual('重复 id 被收敛成两条', duped.length, 2);
assertTrue('重复 id 不再相同', duped[0].id !== duped[1].id);
// 无 id 的坏条目兜底 id 必须稳定：normalize 会被反复调用，id 每次都变就永远匹配不上
assertEqual('无 id 条目兜底 id 稳定',
    cardUtils.normalizeImageStylePresets([{ name: 'a', artists: '1' }])[0].id,
    cardUtils.normalizeImageStylePresets([{ name: 'a', artists: '1' }])[0].id);
assertEqual('查询命中', cardUtils.findImageStylePreset(styleTwo.presets, styleTwo.id).name, '暗黑风格');
assertEqual('查询未命中返回 null', cardUtils.findImageStylePreset(styleTwo.presets, 'nope'), null);
assertTrue('数量有上限',
    cardUtils.normalizeImageStylePresets(Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, artists: 'a' }))).length <= 50);

section('17d) 生图风格预设：全局生效（不进生图预设 profile）');
// 关键回归：「存下来的风格在所有生图方式下都能选到」。
// 若把预设列表塞进 IMAGE_PROFILE_FIELDS，换个生图服务就会被预设的 profile 覆盖/看不到。
assertTrue('风格预设列表不进生图预设 profile（否则换服务就看不到自己的风格）',
    !imageUtils.IMAGE_PROFILE_FIELDS.includes('imageStylePresets'));
// 「当前选了哪一个」仍然是 imageStyle，照旧随生图预设走
assertTrue('imageStyle 仍在 profile 字段里（选中状态跟着生图预设）',
    imageUtils.IMAGE_PROFILE_FIELDS.includes('imageStyle'));

// 四条生图链路都走同一个取值函数（它不接收 provider 参数），
// 所以「全局所有生图方式都有效」只需要保证：预设列表是全局的，不随生图预设被换掉。
const providerSwitch = { ...baseSettings, imageStyle: cuteValue, imageStylePresets: stylePreset.presets };
for (const provider of ['novelai', 'novelai-official', 'stable-diffusion', 'comfyui']) {
    const settingsForProvider = { ...providerSwitch, imageProvider: provider };
    assertEqual(`${provider} 取到同一份自定义风格画师串`,
        cardUtils.getImageStyleArtists(
            settingsForProvider.imageStyle,
            settingsForProvider.customImageArtists,
            settingsForProvider.imageStylePresets),
        cuteArtists);
}
// 切换生图预设（换服务）会用 profile 覆盖 imageStyle，但预设列表不在 profile 字段里 → 不会被抹掉
const switched = { ...providerSwitch };
imageUtils.applyImageProfile(switched, presetA.profile);
assertEqual('切换生图预设后风格预设列表仍在（全局资产）', switched.imageStylePresets.length, 1);
assertEqual('切回自定义预设仍取到原画师串',
    cardUtils.getImageStyleArtists(cuteValue, '', switched.imageStylePresets), cuteArtists);

section('17e) 生图风格预设：界面与接线');
assertTrue('index.html 有「保存预设」按钮', indexSource.includes('@click="saveImageStylePreset"'));
assertTrue('index.html 有「删除预设」按钮', indexSource.includes('@click="deleteImageStylePreset"'));
assertTrue('删除按钮只在选中自定义预设时出现', /v-if="activeImageStylePreset"[\s\S]{0,300}deleteImageStylePreset/.test(indexSource));
assertTrue('文本框在自定义预设下也显示（不再是 imageStyle === custom）',
    indexSource.includes('v-if="isCustomImageStyle"'));
assertTrue('素材串文本框仍绑定 customImageArtists', indexSource.includes('v-model="settings.customImageArtists"'));
assertTrue('设置页说明了「名称(自定义)」的显示规则', indexSource.includes('可爱风格(自定义)'));
assertTrue('设置页说明了只有自己存的能删', indexSource.includes('只有自己保存的预设能删除'));
assertTrue('app.js 接线保存/删除处理函数',
    appJs.includes('const saveImageStylePreset = () =>') && appJs.includes('const deleteImageStylePreset = () =>'));
assertTrue('保存/删除导出给模板',
    appJs.includes('saveImageStylePreset, deleteImageStylePreset,'));
assertTrue('新状态默认空列表', /imageStylePresets: \[\],/.test(appJs));
assertTrue('启动时收敛风格预设（老存档没有该键）',
    appJs.includes('cardUtils.normalizeImageStylePresets(settings.imageStylePresets)'));
assertTrue('预设被删后 imageStyle 收敛回 custom',
    /const stylePresetId = cardUtils\.parseImageStylePresetValue\(settings\.imageStyle\)[\s\S]{0,220}settings\.imageStyle = 'custom'/.test(appJs));
assertTrue('选中预设时把画师串载入文本框',
    /watch\(\(\) => settings\.imageStyle, \(style\) => \{[\s\S]{0,600}settings\.customImageArtists = preset\.artists/.test(appJs));
assertTrue('风格预设变更会同步进生图正则',
    /settings\.imageStylePresets[\s\S]{0,200}updateImageGenRegexState/.test(appJs));
assertTrue('风格预设随 SYNC_SETTINGS 同步进角色卡生成器',
    /settings\.imageStylePresets,[\s\S]{0,400}syncSettingsToGenerator/.test(appJs));
// 取画师串的地方都要带上预设列表，漏一处就会出现「某条链路不认自定义风格」。
// 断言写成「调用总数 == 带预设列表的调用数」，这样以后增删调用点都不会误报。
const styleArtistCalls = appJs.match(/getImageStyleArtists\(settings\.imageStyle, settings\.customImageArtists, settings\.imageStylePresets\)/g) || [];
const styleArtistTotal = (appJs.match(/getImageStyleArtists\(/g) || []).length;
assertEqual('app.js 取画师串的地方一律带上预设列表', styleArtistCalls.length, styleArtistTotal);
assertTrue('四条链路（网关 / 官方 / SD / ComfyUI）都还在取画师串', styleArtistTotal >= 4);
assertTrue('角色卡生成器同步时也传预设列表',
    /getImageStyleArtists\(\s*mainSettings\.imageStyle,\s*mainSettings\.customImageArtists,\s*mainSettings\.imageStylePresets\s*\)/.test(
        readFileSync(join(root, 'character/index.html'), 'utf8')));
// V5 只过滤内置的少数风格，不能把自定义预设一起打回内置风格
assertTrue('V5 模型过滤不误伤自定义预设',
    /nai-diffusion-5-full'[\s\S]{0,150}!isCustomImageStyle\.value[\s\S]{0,150}v5UnsupportedImageStyles\.has/.test(appJs));

// --- 18. 内置生图预设不可删除 ---
section('18) 内置生图预设：只有自定义的能删除');
assertTrue('内置预设按 id 识别（老存档没有 builtin 字段）',
    imageUtils.isBuiltinImageEndpoint({ id: 'preset-forge-proxy' }));
assertTrue('ComfyUI 默认节点也是内置',
    imageUtils.isBuiltinImageEndpoint({ id: 'preset-comfyui-local' }));
assertTrue('用户自己存的预设可删除',
    !imageUtils.isBuiltinImageEndpoint({ id: 'endpoint-123456' }));
assertTrue('builtin 标记优先于 id 兜底',
    !imageUtils.isBuiltinImageEndpoint({ id: 'preset-forge-proxy', builtin: false }));
assertTrue('显式 builtin: true 也算内置',
    imageUtils.isBuiltinImageEndpoint({ id: 'endpoint-user', builtin: true }));
assertEqual('非对象安全', imageUtils.isBuiltinImageEndpoint(null), false);
assertEqual('空对象安全', imageUtils.isBuiltinImageEndpoint({}), false);

// 老存档补标记：只动内置那几条
const legacyEndpoints = [
    { id: 'preset-forge-proxy', name: 'a' },
    { id: 'endpoint-mine', name: '我的节点' }
];
assertTrue('老存档的内置预设被补上标记', imageUtils.markBuiltinImageEndpoints(legacyEndpoints));
assertEqual('内置预设被标记', legacyEndpoints[0].builtin, true);
assertEqual('用户预设不被标记', legacyEndpoints[1].builtin, undefined);
assertTrue('已标记过的不重复标记', !imageUtils.markBuiltinImageEndpoints(legacyEndpoints));
assertEqual('非数组安全', imageUtils.markBuiltinImageEndpoints(null), false);
// 用户预设即使 id 撞上内置 id（不可能，但存档不可信）也按 builtin:false 放行
const explicitUser = [{ id: 'preset-forge-proxy', builtin: false }];
assertTrue('显式 builtin:false 不被补标记', !imageUtils.markBuiltinImageEndpoints(explicitUser));

assertTrue('删除时拦截内置预设', /imageUtils\.isBuiltinImageEndpoint\(found\)[\s\S]{0,200}return;/.test(appJs));
assertTrue('覆盖保存内置预设时保留不可删标记',
    /isBuiltinImageEndpoint\(existing\)[\s\S]{0,120}endpointData\.builtin = true/.test(appJs));
assertTrue('默认示例预设带 builtin: true', /preset-comfyui-local'[\s\S]{0,200}builtin: true/.test(appJs));
assertTrue('启动时为老存档补内置标记', appJs.includes('imageUtils.markBuiltinImageEndpoints(settings.savedImageEndpoints)'));

// --- 19. 期望生图数量：界面上有注释说明 ---
section('19) 期望生图数量：注释说明其语义与不随预设走');
assertTrue('数量下拉下方有说明文字',
    /Image Count[\s\S]{0,1200}期望生图数量[\s\S]{0,1600}每一次 AI 回复要插入几张插图/.test(indexSource));
assertTrue('说明了不随生图预设切换而改变', indexSource.includes('不随「生图预设配置」的切换而改变'));
assertTrue('说明了可点 ↻ 重出失败的图', /期望生图数量[\s\S]{0,1600}点 ↻ 重出/.test(indexSource));

// --- 20. 生图缓存的持久化策略：历史图一条都不许悄悄丢 ---
//
// 第 79 条：这里以前是 `slice(-100)`，只把最近生成的 100 条落盘。
// 用户实测：对话里有 677 个图 tag、缓存里只剩 100 条 —— 切到早先的角色卡
// （或任何一次刷新 / 同步拉取之后）那一片图全部重新生成，官方 API 一张图一次消耗。
section('20) 生图缓存持久化：不再按 100 条截断，改按条数 + 字节双上限淘汰');

// 20a. 指纹改存摘要：条目体积从 ~1.4KB 降到几百字节，几千条也放得下
const fpSample = imageUtils.resolveImageCacheFingerprint({
    settings: { imageProvider: 'novelai', imageGenBaseUrl: 'http://x', imageStyle: 'r18' },
    requestUrl: 'http://x/generate?tag=a&steps=28&sampler=k_euler&size=竖图&w=832&h=1216'
});
const hashSample = imageUtils.hashImageCacheFingerprint(fpSample);
assertTrue('指纹摘要带版本前缀', hashSample.startsWith('h1:'));
assertEqual('同一份指纹 → 同一段摘要', hashSample, imageUtils.hashImageCacheFingerprint(fpSample));
assertTrue('摘要比整份指纹短得多', hashSample.length < fpSample.length / 4);
const fpOther = imageUtils.resolveImageCacheFingerprint({
    settings: { imageProvider: 'novelai', imageGenBaseUrl: 'http://x', imageStyle: 'r18' },
    requestUrl: 'http://x/generate?tag=a&steps=40&sampler=k_euler'
});
assertTrue('参数不同 → 摘要不同', hashSample !== imageUtils.hashImageCacheFingerprint(fpOther));
assertEqual('摘要条目：参数没变 → 不算过期',
    imageUtils.isCachedImageJobOutdated({ imageFingerprint: hashSample }, fpSample), false);
assertEqual('摘要条目：参数变了 → 提示「按旧参数出的」',
    imageUtils.isCachedImageJobOutdated({ imageFingerprint: hashSample }, fpOther), true);
assertEqual('老条目（整份指纹 JSON）与摘要条目可以混存',
    imageUtils.isCachedImageJobOutdated({ imageFingerprint: fpOther }, fpSample), true);

// 20b. 核心回归：条目数超过旧的 100 条上限时，一条都不许丢
const manyEntries = [];
for (let index = 0; index < 377; index += 1) {
    manyEntries.push([`tag-${index}`, { status: 'done', resolvedUrl: `/images/2026-09-19/f${index}.png`, lastUsedAt: 1000 + index }]);
}
const persistedAll = imageUtils.selectImageCacheEntriesForPersist(manyEntries);
assertEqual('377 条全部落盘（旧的 slice(-100) 会丢 277 条）', persistedAll.entries.length, 377);
assertEqual('没有条目被淘汰', persistedAll.dropped, 0);
assertEqual('落盘顺序保持原插入顺序', persistedAll.entries[0][0], 'tag-0');
assertEqual('最后一条也在', persistedAll.entries[376][0], 'tag-376');

// 20c. 真的超上限时：淘汰最久没用过的，最近用过的必须留下
const lruEntries = [
    ['old-unused', { status: 'done', resolvedUrl: '/images/a.png' }],
    ['recently-used', { status: 'done', resolvedUrl: '/images/b.png', lastUsedAt: Date.now() }],
    ['middle', { status: 'done', resolvedUrl: '/images/c.png', lastUsedAt: 5000 }]
];
const lruKept = imageUtils.selectImageCacheEntriesForPersist(lruEntries, { maxEntries: 2, maxBytes: 1e9 });
assertEqual('按条数上限裁到 2 条', lruKept.entries.length, 2);
assertEqual('最近用过的留下', lruKept.entries.some(([tag]) => tag === 'recently-used'), true);
assertEqual('久未用过的先走', lruKept.entries.some(([tag]) => tag === 'old-unused'), false);
assertEqual('被淘汰数如实汇报', lruKept.dropped, 1);

// 20d. 字节上限：先丢大块 base64（本机独有但最占体积），短地址条目优先保住
const byteEntries = [
    ['archived-small', { status: 'done', resolvedUrl: '/images/2026-09-19/a.png' }],
    ['local-big', { status: 'done', directImage: true, imageUrl: `data:image/png;base64,${'A'.repeat(4000)}` }]
];
const byteKept = imageUtils.selectImageCacheEntriesForPersist(byteEntries, { maxEntries: 10, maxBytes: 600 });
assertEqual('短地址条目保住', byteKept.entries.some(([tag]) => tag === 'archived-small'), true);
assertEqual('大块 base64 被让出', byteKept.entries.some(([tag]) => tag === 'local-big'), false);
const onlyBig = imageUtils.selectImageCacheEntriesForPersist(
    [['local-big', { status: 'done', imageUrl: `data:image/png;base64,${'A'.repeat(4000)}` }]],
    { maxEntries: 10, maxBytes: 10 }
);
assertEqual('极端上限下也至少留一条（不清空缓存）', onlyBig.entries.length, 1);

// 20e. 坏输入不炸
assertEqual('空表安全', imageUtils.selectImageCacheEntriesForPersist([]).entries, []);
assertEqual('null 安全', imageUtils.selectImageCacheEntriesForPersist(null).entries, []);
assertEqual('普通对象也可入参', imageUtils.selectImageCacheEntriesForPersist({ t: { status: 'done', resolvedUrl: '/images/a.png' } }).entries.length, 1);
assertEqual('非对象条目被过滤', imageUtils.selectImageCacheEntriesForPersist([['bad', null]]).entries.length, 0);

// 20f. 接线：页面必须用新策略，不能又退回「只留 100 条」
assertTrue('app.js 不再按 100 条截断生图缓存', !appJs.includes('completedImageJobsByTag.entries()].slice(-100)'));
assertTrue('app.js 改用 selectImageCacheEntriesForPersist', appJs.includes('imageUtils.selectImageCacheEntriesForPersist('));
assertTrue('缓存写入时记 lastUsedAt（淘汰要按它排优先级）', /const entry = \{ \.\.\.job, sizeLabel[\s\S]{0,120}lastUsedAt: Date\.now\(\)/.test(appJs));
assertTrue('命中缓存时刷新 lastUsedAt', /cachedJob\.lastUsedAt = now[\s\S]{0,120}persistCompletedImageJob\(\)/.test(appJs));
assertTrue('指纹按摘要存', appJs.includes('entry.imageFingerprint = imageUtils.hashImageCacheFingerprint('));
assertTrue('同 tag 在途任务去重（首屏重复生图的防线）', appJs.includes('pendingImageTasksByTag'));
assertTrue('去重表在任务结算后释放', /releasePendingTag[\s\S]{0,200}pendingImageTasksByTag\.delete\(requestTagKey\)/.test(appJs));
assertTrue('去重不是无条件的：点 ↻ 走 fresh 仍会真重出', /if \(!fresh && requestTagKey\) \{\s*\n\s*const inFlight/.test(appJs));

// --- 21. 历史图：条数上限可调 + 缺图不再自动生成 ---
//
// 第 79 条的后续：上限从写死的 100 改成「可调、默认 2 万」；
// 并且历史消息里缓存缺失的图**不再自动重跑**（花额度 + 画面会变），
// 改成占位卡 + 一个「生成这张图」的按钮由用户自己点。只有本会话新回复里
// 出现的图 tag 才允许自动出图。
section('21) 历史图缓存：条数上限可调（默认 2 万）+ 缺图不自动生成');

// 21a. 上限默认值与可调
assertEqual('缓存条数上限默认 2 万', imageUtils.IMAGE_CACHE_LIMITS.maxEntries, 20000);
assertEqual('字节上限仍是防膨胀护栏', imageUtils.IMAGE_CACHE_LIMITS.maxBytes, 12 * 1024 * 1024);
const twentyThousand = [];
for (let index = 0; index < 20000; index += 1) {
    twentyThousand.push([`t-${index}`, { status: 'done', resolvedUrl: `/images/2026-09-19/f${index}.png`, lastUsedAt: index }]);
}
const keptAll = imageUtils.selectImageCacheEntriesForPersist(twentyThousand, { maxEntries: 20000 });
assertEqual('2 万条上限下 2 万条一条不少', keptAll.entries.length, 20000);
assertEqual('没有淘汰', keptAll.dropped, 0);
const keptTiny = imageUtils.selectImageCacheEntriesForPersist(twentyThousand, { maxEntries: 100 });
assertEqual('上限调小到 100 → 只留 100 条', keptTiny.entries.length, 100);
assertEqual('被淘汰数如实汇报', keptTiny.dropped, 19900);
assertTrue('留下的是 lastUsedAt 最大的那批', keptTiny.entries.every(([, entry]) => Number(entry.lastUsedAt) >= 19900));

// 21b. 设置项接线
assertTrue('settings 里有 imageCacheMaxEntries 且默认 2 万',
    /imageCacheMaxEntries: 20000/.test(appJs));
assertTrue('老存档缺这个键时用 2 万兜底并夹范围',
    /settings\.imageCacheMaxEntries = Math\.max\(100, Math\.min\(200000,/.test(appJs));
assertTrue('落盘时把上限传给 selectImageCacheEntriesForPersist',
    /\{ maxEntries: settings\.imageCacheMaxEntries \}/.test(appJs));
assertTrue('改上限立即按新上限整理一次', /watch\(\(\) => settings\.imageCacheMaxEntries/.test(appJs));
assertTrue('设置页显示当前条数', appJs.includes('imageCacheEntryCount') && indexSource.includes('imageCacheEntryCount'));
assertTrue('控件在高级设置里（跨设备同步之前）',
    /历史图缓存[\s\S]{0,3000}settings\.imageCacheMaxEntries[\s\S]{0,3000}Cross-Device Sync/.test(indexSource));

// 21c. 「哪些图允许自动生成」的判定
assertTrue('只有本会话新回复里出现过的 tag 才自动出图', appJs.includes('liveImageTagKeys'));
assertTrue('同一张图本会话只自动跑一次', appJs.includes('attemptedImageTagKeys'));
assertTrue('流式增量里登记新 tag', /if \(field === 'content'\) markLiveImageTagsByText\(message\.content\)/.test(appJs));
assertTrue('非流式一次到齐也登记', /if \(content\) markLiveImageTagsByText\(content\)/.test(appJs));
assertTrue('新卡开场白算新图', /markLiveImageTagsByText\(char\.first_mes\)/.test(appJs));
const markLiveCalls = (appJs.match(/markLiveImageTagsByText\(/g) || []).length;
assertEqual('登记入口只有三处（流式 / 非流式 / 开场白），历史加载那条路不许登记', markLiveCalls, 3);
assertTrue('缓存没命中且不是本会话新图 → 走占位卡',
    /const isLiveImage[\s\S]{0,200}if \(!options\.fresh && !isLiveImage\) \{[\s\S]{0,300}renderUncachedImageCard/.test(appJs)
    || /const inFlightTask[\s\S]{0,400}if \(!options\.fresh && !inFlightTask && !isLiveImage\) \{[\s\S]{0,300}renderUncachedImageCard/.test(appJs));
// 第 81 条：流式期间消息会被反复重渲染（v-html 整段替换 → 卡片节点是崭新的），
// 新节点若只按「这个 tag 已经尝试过」来判，就会把**正在生成**的那张顶成占位卡 ——
// 现象正是「新会话的图也不生了」。所以必须先把在途任务接过来。
assertTrue('在途任务要被接手，而不是判成占位卡',
    /const inFlightTask = tagKey \? pendingImageTasksByTag\.get\(tagKey\) : null;/.test(appJs)
    && /if \(!options\.fresh && !inFlightTask && !isLiveImage\)/.test(appJs));
assertTrue('接上在途任务不算「新一次尝试」',
    /if \(tagKey && !inFlightTask\) attemptedImageTagKeys\.add\(tagKey\)/.test(appJs));
assertTrue('占位卡由 renderUncachedImageCard 渲染', appJs.includes('const renderUncachedImageCard'));
assertTrue('占位卡给出「生成这张图」按钮', appJs.includes('generated-image-generate'));
assertTrue('占位卡文案区分「历史图缺缓存」与「本会话新图生成没成功」',
    appJs.includes('历史图未缓存') && appJs.includes('这张图没生成成功'));
assertTrue('点它走 fresh 出图（按原 tag，不改写消息）',
    /generated-image-generate'\)[\s\S]{0,700}loadGeneratedImageCard\(card, requestUrl, \{ fresh: true \}\)/.test(appJs));
assertTrue('出图前把占位层收掉', /card\.classList\.remove\('is-image-uncached'\)/.test(appJs));
const stylesSource = readFileSync(join(root, 'assets/css/styles.css'), 'utf8');
assertTrue('占位卡有独立样式', stylesSource.includes('.generated-image-card.is-image-uncached'));
assertTrue('占位卡样式覆盖深色模式',
    readFileSync(join(root, 'assets/css/theme.css'), 'utf8').includes('.generated-image-generate'));

// --- 22. NAI 多角色 / 模型约束 / 共用附加前缀（第 82 条） ---
//
// 官方文档核实（docs.novelai.net）：
//   - V4.5 / V4：base + 所有角色段合计约 512 T5 token；多角色最多 6 个；定位只支持 5×5 网格；
//     画面文字**只支持英文且 ≤118 字符**；
//   - V5：Curated ≈703 / Full ≈1471；最多 22 个角色；定位自由；文字额度独立
//     （Curated ≈374 / Full ≈750，含空格换行），且能渲染英文/日文/中文；
//   - 人数 tag 只能写在 base 里，角色段用不带数字的 girl/boy/other；
//   - 互动动作用 source# / target# / mutual# 标主被动。
section('22) NAI 多角色：| 分段与 @位置 解析、官方载荷、模型约束世界书、共用附加前缀');

// 22a. 解析
const naiUtils = sandbox.window.RPHubNaiOfficialUtils;
const parsedSingle = naiUtils.parseNaiMultiCharacterPrompt('1girl, red hair, solo');
assertEqual('单段：base 就是整段、没有角色段', [parsedSingle.base, parsedSingle.chars.length], ['1girl, red hair, solo', 0]);
const parsedMulti = naiUtils.parseNaiMultiCharacterPrompt('2girls, indoors, night | girl, purple hair, pointing | boy, blonde hair, blush');
assertEqual('多段：base 保留人数与场景', parsedMulti.base, '2girls, indoors, night');
assertEqual('多段：两个角色段', parsedMulti.chars.map(item => item.caption), ['girl, purple hair, pointing', 'boy, blonde hair, blush']);
assertEqual('没写位置 → hasPositions 为 false', parsedMulti.hasPositions, false);
const parsedKeyword = naiUtils.parseNaiMultiCharacterPrompt('2girls, park | @左上 girl, sitting | @右下 boy, standing');
assertEqual('九宫格关键字 → 5×5 网格上的坐标',
    parsedKeyword.chars.map(item => item.centers), [[{ x: 0.1, y: 0.1 }], [{ x: 0.9, y: 0.9 }]]);
assertEqual('位置前缀必须从角色文本里剥掉', parsedKeyword.chars[0].caption, 'girl, sitting');
assertEqual('给了位置 → hasPositions 为 true', parsedKeyword.hasPositions, true);
const parsedCoordsV4 = naiUtils.parseNaiMultiCharacterPrompt('2girls | @0.33,0.66 girl, lying', { grid: true });
assertEqual('V4/V4.5：坐标吸附到 0.1 格点', parsedCoordsV4.chars[0].centers, [{ x: 0.3, y: 0.7 }]);
const parsedCoordsV5 = naiUtils.parseNaiMultiCharacterPrompt('2girls | @0.33,0.66 girl, lying', { grid: false });
assertEqual('V5：坐标不被吸附', parsedCoordsV5.chars[0].centers, [{ x: 0.33, y: 0.66 }]);
assertEqual('空段被忽略', naiUtils.parseNaiMultiCharacterPrompt('solo || girl, x').chars.length, 1);
assertEqual('@ 后面没有正文时不当作位置（保持原文）',
    naiUtils.parseNaiMultiCharacterPrompt('solo | @左上').chars[0].caption, '@左上');

// 22b. 官方 API 载荷
const payloadBase = { naiOfficialModel: 'nai-diffusion-4-5-full', naiOfficialResolution: '832x1216', naiOfficialSteps: 28, naiOfficialScale: 5 };
const singlePayload = naiUtils.buildNaiOfficialPayload({ settings: payloadBase, prompt: 'artist, 1girl, solo', negativePrompt: 'bad' });
assertEqual('单段提示词：base_caption 就是原文', singlePayload.parameters.v4_prompt.caption.base_caption, 'artist, 1girl, solo');
assertEqual('单段：char_captions 为空（不改变原有行为）', singlePayload.parameters.v4_prompt.caption.char_captions.length, 0);
assertEqual('单段：use_coords 保持 false', singlePayload.parameters.v4_prompt.use_coords, false);
const multiPayload = naiUtils.buildNaiOfficialPayload({
    settings: payloadBase,
    prompt: '2girls, indoors | @左上 girl, purple hair | boy, blonde hair',
    negativePrompt: 'bad'
});
assertEqual('多段：base_caption 只含 base 段', multiPayload.parameters.v4_prompt.caption.base_caption, '2girls, indoors');
assertEqual('多段：char_captions 逐段给出', multiPayload.parameters.v4_prompt.caption.char_captions.map(item => item.char_caption),
    ['girl, purple hair', 'boy, blonde hair']);
assertEqual('多段：给了位置 → use_coords = true', multiPayload.parameters.v4_prompt.use_coords, true);
assertEqual('多段：未指定位置的角色落到中心', multiPayload.parameters.v4_prompt.caption.char_captions[1].centers, [{ x: 0.5, y: 0.5 }]);
assertEqual('多段：input 用 | 拼回人可读的整段（@ 已剥掉）',
    multiPayload.input, '2girls, indoors | girl, purple hair | boy, blonde hair');
const v5Payload = naiUtils.buildNaiOfficialPayload({ settings: { ...payloadBase, naiOfficialModel: 'nai-diffusion-5-full' }, prompt: '2girls | @0.33,0.66 girl, lying' });
assertEqual('V5：坐标不吸附', v5Payload.parameters.v4_prompt.caption.char_captions[0].centers, [{ x: 0.33, y: 0.66 }]);
const v3Payload = naiUtils.buildNaiOfficialPayload({ settings: { ...payloadBase, naiOfficialModel: 'nai-diffusion-3' }, prompt: '2girls, indoors | girl, x' });
assertEqual('V3：没有 v4_prompt 结构', v3Payload.parameters.v4_prompt, undefined);
assertEqual('V3：提示词原样下发（不解析 |）', v3Payload.input, '2girls, indoors | girl, x');

// 22c. 世界书按模型切换（V4.5 / V5 的硬差别必须写进去）
const builtinPrompts = sandbox.window.RPHubBuiltinContent.prompts;
const v45Rules = builtinPrompts.buildImageModelPromptRules({ provider: 'novelai-official', model: 'nai-diffusion-4-5-full' });
const v5Rules = builtinPrompts.buildImageModelPromptRules({ provider: 'novelai', model: 'nai-diffusion-5-full' });
const v3Rules = builtinPrompts.buildImageModelPromptRules({ provider: 'novelai', model: 'nai-diffusion-3' });
const sdRules = builtinPrompts.buildImageModelPromptRules({ provider: 'stable-diffusion', model: 'mock-model' });
assertTrue('V4.5：写明 512 T5 token 合计预算', v45Rules.includes('512'));
assertTrue('V4.5：禁止中文与 emoji（T5 词表）', v45Rules.includes('不要写中文与 emoji'));
assertTrue('V4.5：多角色上限 6', v45Rules.includes('最多 6 个'));
assertTrue('V4.5：定位是 5×5 网格', v45Rules.includes('5×5'));
assertTrue('V4.5：文字只支持英文且 ≤118 字符', v45Rules.includes('118'));
assertTrue('V5：给出 703 / 1471 预算', v5Rules.includes('703') && v5Rules.includes('1471'));
assertTrue('V5：多角色上限 22', v5Rules.includes('22'));
assertTrue('V5：文字额度独立且能写中日文', v5Rules.includes('374') && v5Rules.includes('750') && v5Rules.includes('日文'));
assertTrue('V5：Text: 必须放在最后', v5Rules.includes('Text:'));
assertTrue('V3：明确不要用 | 分段', v3Rules.includes('不要用 | 分段'));
assertTrue('网关（Nai2API）不教 @位置（网关不解析它，会原样进提示词）',
    builtinPrompts.buildImageModelPromptRules({ provider: 'novelai', model: 'nai-diffusion-4-5-full' }).includes('不要写 @'));
assertTrue('官方 API 才教 @位置',
    builtinPrompts.buildImageModelPromptRules({ provider: 'novelai-official', model: 'nai-diffusion-4-5-full' }).includes('定位可选'));
assertEqual('SD/ComfyUI 不套 NAI 的模型规则', sdRules, '');
const v5RulesOfficial = builtinPrompts.buildImageModelPromptRules({ provider: 'novelai-official', model: 'nai-diffusion-5-full' });
assertTrue('网关与官方共用同一份预算 / 多角色规则',
    v5Rules.includes('703') && v5RulesOfficial.includes('703') && v5Rules.includes('22') && v5RulesOfficial.includes('22'));
assertTrue('两者唯一的差别是「只有官方教 @位置」',
    !v5Rules.includes('定位可选') && v5RulesOfficial.includes('定位可选'));
const worldbookV45 = builtinPrompts.buildAutoImageGenPrompt({ count: 3, provider: 'novelai', model: 'nai-diffusion-4-5-full' });
const worldbookGeneric = builtinPrompts.buildAutoImageGenPrompt(3);
assertTrue('世界书里带上模型约束段', worldbookV45.includes('<模型约束 · NovelAI V4.5>'));
assertTrue('旧签名（只传数量）仍然可用，且不带模型段', worldbookGeneric.includes('image###英文Tag###') && !worldbookGeneric.includes('<模型约束'));
assertTrue('模型约束段不能把世界书写爆（V4.5 增量 ≤ 1200 字）',
    worldbookV45.length - worldbookGeneric.length < 1200);

// 22d. 接线：模型换了要重建世界书；附加前缀四种方式共用
assertTrue('世界书按当前模型构建', /buildAutoImageGenPrompt\(\{[\s\S]{0,200}model: autoImageGenModel/.test(appJs));
assertTrue('官方模型（naiOfficialModel）进入重建 watch', /settings\.naiOfficialModel,[\s\S]{0,1200}enforceSpecialRules/.test(appJs));
assertTrue('网关的 artist 参数带上附加前缀', appJs.includes('encodeURIComponent(imageArtistsWithPrefix())'));
assertTrue('附加前缀改动会重建正则', /settings\.sdPromptPrefix\s*\n\s*\], \(\) => \{/.test(appJs));
assertTrue('附加前缀输入框在四种方式共用区（不在 SD 专属块里）',
    /附加正面提示词（可选 · 四种生图方式共用）/.test(indexSource));
assertTrue('SD 专属块里不再有重复的前缀输入框',
    (indexSource.match(/v-model="settings\.sdPromptPrefix"/g) || []).length === 1);

// 22e. 提示词文本归一化（第 83 条）：换行 / 重复逗号 / 全角逗号
const normalizePrompt = imageUtils.normalizePromptText;
assertEqual('真换行 → 空格', normalizePrompt('a::,\r\n20::b::, c'), 'a::, 20::b::, c');
assertEqual('字面量 \\n（两字符）→ 空格', normalizePrompt('a::, \\n20::b::'), 'a::, 20::b::');
assertEqual('连续逗号合并（画师串自带的 ::,,）', normalizePrompt('masterpiece::,, very aesthetic'), 'masterpiece::, very aesthetic');
assertEqual('join 造成的 “no text, , 1girl” 被吃掉', normalizePrompt('no text, , 1girl'), 'no text, 1girl');
assertEqual('全角逗号归一化', normalizePrompt('masterpiece，best quality'), 'masterpiece, best quality');
assertEqual('首尾逗号与空白去掉', normalizePrompt('  , masterpiece, best quality, , '), 'masterpiece, best quality');
assertEqual('多余空格压成一个', normalizePrompt('a,    b'), 'a, b');
assertEqual('空输入安全', normalizePrompt(''), '');
assertEqual('null 安全', normalizePrompt(null), '');
// 真实场景：内置 r18 画师串（带 CRLF 与 ::,,）+ 尾逗号前缀 + tag
const dirtyPrompt = 'masterpiece::,\r\n20::best quality::,, very aesthetic, masterpiece, no text,';
assertEqual('内置画师串那种脏文本被整段理干净',
    normalizePrompt(`${dirtyPrompt}, 1girl, solo`), 'masterpiece::, 20::best quality::, very aesthetic, masterpiece, no text, 1girl, solo');
assertTrue('四条链路都在拼装处归一化',
    (appJs.match(/imageUtils\.normalizePromptText\(/g) || []).length >= 4);
assertTrue('官方载荷内部也归一化（多角色解析跑在干净文本上）',
    /parseNaiMultiCharacterPrompt\(normalizePromptText\(prompt\), \{ grid \}\)/.test(
        readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8')));

// --- 23. 生图 Tag 词典 / MCP Tag 查询工具 / 网关换行归一化 ---
// 这一节守三件事：
//   a) 世界书里多出一条「生图Tag词典」，且词典里全是**真实存在**的 Danbooru tag
//      （逐条核对语料是另一支脚本：tools/verify-image-tags.mjs）；
//   b) 「生图 Tag 查询」工具的两种调用方式：主模型（进上下文）/ 另配模型（零开销）；
//   c) 网关请求体里的 tag 必须先归一化 —— AI 写的字面「\n」不再原样进请求。
section('23) 生图 tag 词典、MCP Tag 查询工具、网关换行归一化');
const lexiconV45 = builtinPrompts.buildImageTagLexicon({ model: 'nai-diffusion-4-5-full', provider: 'novelai' });
const lexiconV5 = builtinPrompts.buildImageTagLexicon({ model: 'nai-diffusion-5-full', provider: 'novelai' });
const lexiconSd = builtinPrompts.buildImageTagLexicon({ model: 'mock-model', provider: 'stable-diffusion' });
assertTrue('词典按【分类】行渲染', lexiconV45.includes('【人数 · 主体】') && lexiconV45.includes('【NSFW · 状态与体位】'));
assertTrue('词典用 NovelAI 的空格写法（不是下划线）',
    lexiconV45.includes('long hair') && !lexiconV45.includes('long_hair'));
assertTrue('V5 专属 tag 只出现在 V5 那份里',
    lexiconV5.includes('ultra complexity') && !lexiconV45.includes('ultra complexity'));
assertEqual('SD / ComfyUI 不注入 NAI 词典', lexiconSd, '');
assertTrue('词典带互动锚点与权重语法说明（用 - 行，校验脚本只解析【】行）',
    lexiconV45.includes('source#动作') && lexiconV45.includes('1.3::tag::'));
assertTrue('词典规模够大（≥400 个 tag）', (lexiconV45.match(/,/g) || []).length > 400);

const normalizerV45 = builtinPrompts.buildImageTagNormalizePrompt({ model: 'nai-diffusion-4-5-full', provider: 'novelai' });
assertTrue('另配模型用的规范器与词典同源', normalizerV45.includes('<tag_normalizer>') && normalizerV45.includes('【NSFW'));
assertTrue('规范器要求：只输出一行、保留 | 分栏、不得臆造设定',
    normalizerV45.includes('只输出一行') && normalizerV45.includes('分栏') && normalizerV45.includes('不得臆造'));
assertEqual('SD / ComfyUI 不生成规范器提示词',
    builtinPrompts.buildImageTagNormalizePrompt({ model: 'mock-model', provider: 'stable-diffusion' }), '');

const worldbookWithTool = builtinPrompts.buildAutoImageGenPrompt({
    count: 2, model: 'nai-diffusion-4-5-full', provider: 'novelai', tagLookupTool: 'tool_tag'
});
const worldbookWithoutTool = builtinPrompts.buildAutoImageGenPrompt({
    count: 2, model: 'nai-diffusion-4-5-full', provider: 'novelai'
});
assertTrue('启用工具时世界书教 AI 先查 tag', worldbookWithTool.includes('tool_tag'));
assertTrue('没启用工具时不出现工具名', !worldbookWithoutTool.includes('tool_tag'));
assertTrue('世界书写明 tag 数量下限（默认不到 100 token 的那档被顶掉）',
    worldbookWithTool.includes('不少于 60 个 tag') && worldbookWithTool.includes('每个角色段不少于 30 个 tag'));
assertTrue('世界书强制两人以上写 Character Prompt', worldbookWithTool.includes('Character Prompt') && worldbookWithTool.includes('人数与场景 | 角色1'));
assertTrue('世界书禁止自造英文短语/整句英文', worldbookWithTool.includes('严禁自造英文短语'));
assertTrue('世界书禁止在 tag 里写换行与字面 \\n', worldbookWithTool.includes('不得换行'));
assertTrue('世界书给出权重与排除语法', worldbookWithTool.includes('1.3::tag::') && worldbookWithTool.includes('-1::tag::'));

const toolDefaults = sandbox.window.RPHubBuiltinContent.activeTools.defaults;
const tagToolDefault = toolDefaults.find(tool => tool.id === 'tool_tag');
assertTrue('工具栏里有「生图 Tag 查询」工具（默认关）',
    !!tagToolDefault && tagToolDefault.type === 'tag_lookup' && tagToolDefault.enabled === false);
assertEqual('默认调用方式是主模型', tagToolDefault.mode, 'main');
assertEqual('默认没配 MCP 端点（回落 Danbooru 官方接口）', tagToolDefault.mcpUrl, '');

assertTrue('aux 模式不进请求上下文（工具说明书的开销就省在这里）',
    /isAuxTagLookupTool\(tool\)/.test(appJs) && /\.filter\(tool => !isAuxTagLookupTool\(tool\)\)/.test(appJs));
assertTrue('出图前用另配的模型规范化 tag',
    /const backendTag = await resolveBackendImageTag\(rawTag\)/.test(appJs));
assertTrue('缓存 key 仍是 AI 原本写的 tag（规范化只影响发给后端的提示词）',
    /const tags = request\?\.searchParams\?\.get\('tag'\) \|\| '';/.test(appJs));
assertTrue('MCP 端点走 JSON-RPC tools/call', appJs.includes("method: 'tools/call'"));
assertTrue('留空回落到 Danbooru 官方标签接口', appJs.includes('https://danbooru.donmai.us/tags.json'));
assertTrue('规范化失败绝不挡住出图（catch 后返回原 tag）',
    /规范化失败，按原样出图[\s\S]{0,120}return tag;/.test(appJs));
assertTrue('工具面板能选调用方式 / 模型 / MCP 端点',
    uiJs.includes("'update:tag-mode'") && uiJs.includes("'update:mcp-url'") && mainIndex.includes(':tag-tool="isTagActiveTool'));
assertTrue('工具栏上能看出当前是哪种调用方式',
    mainIndex.includes('另配模型调用（') && mainIndex.includes('需要选择调用模型'));
assertTrue('「生图Tag词典」登记为系统世界书条目',
    sandbox.window.RPHubConfig.systemWorldInfoNames.includes('生图Tag词典'));
assertTrue('世界书里会创建/更新词典条目', appJs.includes("const tagLexiconWIName = '生图Tag词典'"));
assertTrue('自动生图开关联动词典开关',
    /const lexicon = worldInfo\.value\.find\(w => w\.comment === '生图Tag词典'\)/.test(appJs));
assertTrue('网关请求体里的 tag 先归一化（字面 \\n 不再原样转发给 nai2api）',
    /tag: imageUtils\.normalizePromptText\(backendTag\)/.test(appJs));

// --- 24. 系统资产重建：官方 API「地址留空」与 Tag 工具开关 ---
// 两个真实出现过的 bug：
//   A) enforceSpecialRules 在拼 URL 之前用「baseUrl 为空」整体 return，而官方 API 的地址
//      留空是**合法配置**（回落 https://image.novelai.net，见 naiOfficialBaseUrl）。
//      结果：官方 + 留空的用户一条 NAI画图正则 / 自动生图 / 生图Tag词典都拿不到。
//   B) 「自动生图」世界书里的 tag 工具说明只在 enforceSpecialRules 被调用时重算，
//      而 activeTools 不在触发它的 watch 依赖里 → 开关工具后世界书纹丝不动。
section('24) 系统资产重建：官方 API 留空地址、Tag 工具开关');

// 24a. 守卫必须从「baseUrl 为空」改成「没有任何可用目标地址」
// 只看 enforceSpecialRules 自己的函数体：app.js 别处（fetchQuota / ComfyUI / SD）也有
// `if (!baseUrl)`，全文件级断言会误伤。
const enforceSpecialRulesBody = (() => {
    const start = appJs.indexOf('const enforceSpecialRules = () => {');
    return start === -1 ? '' : appJs.slice(start, start + 1400);
})();
assertTrue('定位到 enforceSpecialRules 函数体', enforceSpecialRulesBody.includes('const imageGenRegexName'));
assertTrue('守卫变量由 baseUrl 与「是否官方 provider」共同决定',
    /const baseUrl = normalizeServiceBaseUrl\(settings\.imageGenBaseUrl\);[\s\S]{0,600}const hasImageTarget = Boolean\(baseUrl\) \|\| isNaiOfficialProvider\.value;/.test(enforceSpecialRulesBody));
assertTrue('整体 return 的条件是 !hasImageTarget（官方+空地址不再被拦）',
    /if \(!hasImageTarget\) \{/.test(enforceSpecialRulesBody));
assertTrue('enforceSpecialRules 内不再有「baseUrl 为空就整体 return」的旧守卫',
    !/if \(!baseUrl\) \{/.test(enforceSpecialRulesBody));
// 24b. 安全语义：无可用目标时照旧只做「清理内嵌旧网关正则」然后返回，不生成任何远程链接
assertTrue('无可用目标时仍走「清理内嵌旧网关正则 + return」的安全分支',
    /if \(!hasImageTarget\) \{[\s\S]{0,500}embedsRemovedProvider\(script\.replacement\)[\s\S]{0,500}return;/.test(enforceSpecialRulesBody));
assertTrue('该安全分支里不含任何 URL 拼装（不生成远程生图链接）',
    !/if \(!hasImageTarget\) \{[\s\S]{0,500}data-image-request/.test(enforceSpecialRulesBody));
// 24c. 官方分支拼 URL 用 naiOfficialBaseUrl()，其余三条仍只用 baseUrl（空地址时不会拼出坏 URL）
assertTrue('官方分支用 naiOfficialBaseUrl() 拼 URL（本身不依赖 baseUrl）',
    /isNaiOfficialProvider\.value\s*\n?\s*\? `\$\{naiOfficialBaseUrl\(\)\}\/ai\/generate-image\?tag=\$1&provider=novelai-official/.test(appJs));
assertTrue('ComfyUI 分支用 baseUrl 拼 /view（空地址时不会被走到）',
    appJs.includes('? `${baseUrl}/view?tag=$1&provider=comfyui'));
assertTrue('SD 分支用 baseUrl 拼 /sdapi/v1/txt2img（空地址时不会被走到）',
    appJs.includes('? `${baseUrl}/sdapi/v1/txt2img?tag=$1&provider=stable-diffusion'));
assertTrue('网关分支用 baseUrl 拼 /generate（空地址时不会被走到）',
    appJs.includes('`${baseUrl}/generate?tag=$1&token='));
assertTrue('naiOfficialBaseUrl 在留空时回落官方默认地址',
    /return configured \|\| \(window\.RPHubConfig\?\.uiOptions\?\.novelaiOfficialBaseUrl \|\| 'https:\/\/image\.novelai\.net'\)/.test(appJs));

// 24d. 新增 watch：启用/关闭 tag 工具（含 callName 与 mode）后重建系统资产
assertTrue('新增 activeTools watch：tag 工具变化时调用 enforceSpecialRules',
    /watch\(\(\) => JSON\.stringify\([\s\S]{0,700}isTagActiveTool\(tool\)[\s\S]{0,300}enforceSpecialRules\(\);/.test(appJs));
assertTrue('watch 依赖取 [callName, mode]（稳定可比较，避免整体重写触发循环）',
    /\.map\(tool => \[tool\.callName, tool\.mode\]\)/.test(appJs));
assertTrue('watch 过滤掉 aux 模式（与 getEnabledActiveTools 口径一致，aux 不进世界书）',
    /isTagActiveTool\(tool\) && !isAuxTagLookupTool\(tool\)/.test(appJs));
assertTrue('watch 也要求工具已启用（enabled !== false）',
    /tool\?\.enabled !== false && isTagActiveTool\(tool\) && !isAuxTagLookupTool\(tool\)/.test(appJs));
// 24e. 世界书构建处仍然读的是「已启用的 tag 工具名」
assertTrue('世界书构建处的工具名取自 getEnabledActiveTools().find(isTagActiveTool)',
    /tagLookupTool: getEnabledActiveTools\(\)\.find\(isTagActiveTool\)\?\.callName \|\| ''/.test(appJs));

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);process.exit(failures === 0 ? 0 : 1);
