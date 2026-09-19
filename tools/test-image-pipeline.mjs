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
    sdModel: '', sdSteps: 28, sdCfgScale: 6, sdSampler: 'DPM++ 2M SDE Karras', sdScheduler: 'Karras',
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

// --- 8. 接线检查：app.js 确实用了上面这套逻辑 ---
section('8) 接线检查（防止页面里又走回旧实现）');
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

const syncSource = readFileSync(join(root, 'assets/js/sync-client.js'), 'utf8');
assertTrue('生图回显缓存不进同步（413 修复）', syncSource.includes('LOCAL_ONLY_KEYS'));
assertTrue('上传前做体积预检', syncSource.includes('MAX_PUSH_BYTES'));

assertTrue('index.html 暴露自定义分辨率 UI',
    readFileSync(join(root, 'index.html'), 'utf8').includes('settings.sdCustomSizeEnabled'));

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
