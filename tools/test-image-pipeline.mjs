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

section('12) NovelAI 官方 API：provider 与常量');
assertTrue('novelai-official 进入生图方式列表',
    config.uiOptions.imageProviders.some(p => p.value === 'novelai-official'));
assertTrue('原先的 novelai 改名为 RP Hub 网关',
    config.uiOptions.imageProviders.find(p => p.value === 'novelai').label.includes('RP Hub'));
assertTrue('两个 NAI 方式并存（网关 + 官方）',
    config.uiOptions.imageProviders.filter(p => p.value.startsWith('novelai')).length === 2);

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
section('12h) NAI（RP Hub 网关）参数默认值与配置项');
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

section('12h) 官方 API：账户额度（订阅等级 / 试用张数 / 训练步数）');
// 前提事实：官方公开 API 不返回 Anlas。断言我们确实没有去请求一个不存在的端点/字段，
//（注释里出现「Anlas」是在说明这件事，所以只查是否真的去读了该字段或打了该路径）。
assertTrue('app.js 没有请求 Anlas 端点',
    !/[`'"][^`'"]*\/anlas/i.test(appSource) && !/\.anlas\b/i.test(appSource));
assertTrue('官方账户查询用 /user/subscription', appSource.includes('${baseUrl}/user/subscription'));
assertTrue('官方账户查询用 /user/information', appSource.includes('${baseUrl}/user/information'));

const acct = naiOff.resolveNaiOfficialAccount({
    subscription: {
        tier: 3, active: true, expiresAt: 1789000000000,
        trainingStepsLeft: { fixedTrainingStepsLeft: 30, purchasedTrainingSteps: 5 }
    },
    information: { trialImagesLeft: 27, trialActionsLeft: 100 }
});
assertEqual('Opus 档位标签', acct.tierLabel, 'Opus');
assertEqual('订阅生效', acct.active, true);
assertEqual('到期时间保留', acct.expiresAt, 1789000000000);
assertEqual('试用剩余张数', acct.trialImagesLeft, 27);
assertEqual('训练步数为两者之和', acct.trainingStepsLeft, 35);
assertEqual('已购训练步数分开记', acct.purchasedTrainingSteps, 5);

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

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);process.exit(failures === 0 ? 0 : 1);
