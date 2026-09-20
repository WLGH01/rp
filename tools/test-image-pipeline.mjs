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

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
