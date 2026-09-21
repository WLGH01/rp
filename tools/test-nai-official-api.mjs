// NovelAI 官方 API 生图链路的集成测试
//
// 与 test-image-pipeline.mjs（纯函数）互补：这里起一个真实的 HTTP 服务
// （tools/mock-nai-official.mjs，响应是按官方格式构造的真 ZIP），
// 用 core-utils 的同一套纯函数走完整条链路，验证「协议契约」。
//
// 覆盖：
//   1. Bearer 鉴权 + 提交 → 拿到 ZIP → 解出 PNG 字节
//   2. 参数确实按官方结构落到 parameters（含 v4_prompt、params_version）
//   3. 401/402/400 的错误信息能被带出来
//   4. 宽高非 64 倍数会被服务端拒绝（本地已对齐，故正常路径不会触发）
//   5. 免费额度判定与实际提交的 width/height/steps 一致
//
// 用法：node tools/test-nai-official-api.mjs

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;
const assertEqual = (label, actual, expected) => {
    checks += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) console.log(`  ✓ ${label}`);
    else { failures += 1; console.log(`  ✗ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`); }
};
const assertTrue = (label, value) => assertEqual(label, Boolean(value), true);
const section = (title) => console.log(`\n${title}`);

// --- 加载浏览器脚本 ---
const sandbox = {
    window: {}, crypto: globalThis.crypto, URL, URLSearchParams,
    TextDecoder, TextEncoder, console, setTimeout, clearTimeout,
    atob: globalThis.atob, btoa: globalThis.btoa,
    Blob, Response, DecompressionStream
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox);
vm.runInContext(readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8'), sandbox);
const nai = sandbox.window.RPHubNaiOfficialUtils;

let child = null;
let base = '';

const startOn = async (port) => {
    const proc = spawn(process.execPath, [join(root, 'tools', 'mock-nai-official.mjs'), String(port)], {
        // 不用 'pipe'：受限沙箱下管道会触发 spawn EPERM。
        stdio: ['ignore', 'ignore', 'inherit']
    });
    for (let i = 0; i < 60; i += 1) {
        await new Promise(r => setTimeout(r, 100));
        if (proc.exitCode !== null) return null;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/user/subscription`, { headers: { Authorization: 'Bearer t' } });
            if (res.ok) return proc;
        } catch { /* 还没起来 */ }
    }
    proc.kill();
    return null;
};

// 复刻 app.js 的官方链路：构建载荷 → Bearer 提交 → 解 ZIP → data URL
const runChain = async (settings, { token = 'pst-test-token', prompt = 'a cat', negative = 'bad' } = {}) => {
    const payload = nai.buildNaiOfficialPayload({ settings, prompt, negativePrompt: negative });
    const response = await fetch(`${base}/ai/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const text = await response.text();
        let message = '';
        try { message = JSON.parse(text)?.message || ''; } catch { /* 原样 */ }
        throw new Error(message || text.slice(0, 200) || `HTTP ${response.status}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const image = await nai.extractNaiOfficialImage(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        response.headers.get('content-type') || ''
    );
    return { payload, image, dataUrl: nai.bytesToPngDataUrl(image.data) };
};

try {
    for (const port of [18897, 18898, 18896]) {
        child = await startOn(port);
        if (child) { base = `http://127.0.0.1:${port}`; break; }
    }
    if (!child) throw new Error('mock NovelAI 官方服务未能启动');

    console.log(`mock NovelAI 官方服务已启动: ${base}\n`);

    section('1) 端到端：Bearer 提交 → ZIP → PNG');
    const run = await runChain({
        naiOfficialModel: 'nai-diffusion-5-full',
        naiOfficialResolution: '1024x1024',
        naiOfficialSteps: 28,
        naiOfficialScale: 5,
        naiOfficialSeed: '777'
    });
    assertEqual('响应解出 kind=zip', run.image.kind, 'zip');
    assertTrue('ZIP 内文件名形如 image_<seed>.png', /^image_777\.png$/.test(run.image.name));
    assertTrue('得到的 data URL 前缀正确', run.dataUrl.startsWith('data:image/png;base64,'));
    const pngBytes = Buffer.from(run.dataUrl.split(',')[1], 'base64');
    assertTrue('PNG 魔数正确', pngBytes.subarray(1, 4).toString() === 'PNG');

    section('2) 参数按官方结构落到 parameters');
    const seen = await (await fetch(`${base}/__requests`)).json();
    const req = seen.filter(r => r.kind === 'generate').pop();
    assertEqual('Bearer 鉴权被带上', req.hasAuth, true);
    assertEqual('token 原样送达', req.token, 'pst-test-token');
    assertEqual('model 正确', req.model, 'nai-diffusion-5-full');
    assertEqual('action 是 generate', req.action, 'generate');
    assertEqual('input 是正向提示词', req.input, 'a cat');
    assertEqual('width/height 在 parameters', [req.width, req.height], [1024, 1024]);
    assertEqual('steps 在 parameters', req.steps, 28);
    assertEqual('scale 在 parameters', req.scale, 5);
    assertEqual('seed 被采用', req.seed, 777);
    assertEqual('V5 的 params_version=4', req.paramsVersion, 4);
    assertEqual('负面词走 parameters.negative_prompt', req.negativePrompt, 'bad');
    assertEqual('v4_prompt.base_caption 是正向', req.v4Base, 'a cat');
    assertEqual('v4_negative_prompt.base_caption 是负面', req.v4NegBase, 'bad');
    assertEqual('v4_prompt.use_order=true', req.useOrder, true);
    assertEqual('V5 不带 skip_cfg_above_sigma', req.skipCfg, undefined);
    // 噪声计划必须真的送达：漏写 noise_schedule 时该下拉会完全没作用。
    assertEqual('noise_schedule 送达（默认 karras）', req.noiseSchedule, 'karras');
    assertEqual('sampler 送达', req.sampler, 'k_euler_ancestral');

    section('3) V4.5 与 V3 的差异');
    await runChain({
        naiOfficialModel: 'nai-diffusion-4-5-full',
        naiOfficialResolution: '832x1216',
        naiOfficialSteps: 28
    });
    const seen2 = await (await fetch(`${base}/__requests`)).json();
    const req45 = seen2.filter(r => r.kind === 'generate').pop();
    assertEqual('V4.5 的 params_version=3', req45.paramsVersion, 3);
    assertEqual('V4.5 带 skip_cfg_above_sigma=58', req45.skipCfg, 58);

    await runChain({
        naiOfficialModel: 'nai-diffusion-3',
        naiOfficialResolution: '832x1216',
        naiOfficialSteps: 28
    });
    const seen3 = await (await fetch(`${base}/__requests`)).json();
    const req3 = seen3.filter(r => r.kind === 'generate').pop();
    assertEqual('V3 的 params_version=3', req3.paramsVersion, 3);
    assertEqual('V3 不带 v4_prompt', req3.v4Base, undefined);

    section('4) 自定义分辨率走真实请求（64 对齐）');
    await runChain({
        naiOfficialModel: 'nai-diffusion-5-full',
        naiOfficialCustomSizeEnabled: true,
        naiOfficialCustomWidth: 1001,   // 会被对齐到 1024
        naiOfficialCustomHeight: 1499,  // 会被对齐到 1472
        naiOfficialSteps: 28
    });
    const seen4 = await (await fetch(`${base}/__requests`)).json();
    const req4 = seen4.filter(r => r.kind === 'generate').pop();
    assertEqual('宽度已 64 对齐', req4.width, 1024);
    assertEqual('高度已 64 对齐', req4.height, 1472);
    // 服务端也要求 64 的倍数，能通过说明本地对齐是对的
    assertEqual('服务端接受（说明对齐正确）', req4.width % 64, 0);
    assertEqual('服务端接受高度', req4.height % 64, 0);

    section('5) 错误分支：401 / 402 / 500 的信息要能带出来');
    await fetch(`${base}/__fail?mode=payment`);
    let msg402 = '';
    try { await runChain({ naiOfficialModel: 'nai-diffusion-5-full' }); }
    catch (e) { msg402 = e.message; }
    assertTrue('402 的 message 被带出', /subscription/.test(msg402));

    await fetch(`${base}/__fail?mode=error`);
    let msg500 = '';
    try { await runChain({ naiOfficialModel: 'nai-diffusion-5-full' }); }
    catch (e) { msg500 = e.message; }
    assertTrue('500 的 message 被带出', /internal generation error/.test(msg500));

    await fetch(`${base}/__reset`);
    // 无 token（不传 Authorization）
    let msg401 = '';
    try {
        const payload = nai.buildNaiOfficialPayload({ settings: { naiOfficialModel: 'nai-diffusion-5-full' }, prompt: 'x', negativePrompt: '' });
        const res = await fetch(`${base}/ai/generate-image`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const t = await res.text();
        let m = ''; try { m = JSON.parse(t)?.message || ''; } catch { /* 原样 */ }
        throw new Error(m || `HTTP ${res.status}`);
    } catch (e) { msg401 = e.message; }
    assertTrue('缺鉴权时给出 401 相关信息', /Unauthorized/i.test(msg401));

    section('6) 免费额度判定要与实际提交的尺寸一致');
    const freeCase = { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialResolution: '1024x1024', naiOfficialSteps: 28 };
    assertEqual('判定为免费', nai.isNaiOfficialFreeTier(freeCase), true);
    await runChain(freeCase);
    const seen6 = await (await fetch(`${base}/__requests`)).json();
    const req6 = seen6.filter(r => r.kind === 'generate').pop();
    assertTrue('提交的尺寸确实 ≤1MP', req6.width * req6.height <= 1024 * 1024);
    assertTrue('提交的步数确实 ≤28', req6.steps <= 28);

    const paidCase = { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialResolution: '1024x1536', naiOfficialSteps: 28 };
    assertEqual('判定为超线', nai.isNaiOfficialFreeTier(paidCase), false);
    await runChain(paidCase);
    const seen7 = await (await fetch(`${base}/__requests`)).json();
    const req7 = seen7.filter(r => r.kind === 'generate').pop();
    assertTrue('超线尺寸确实 >1MP', req7.width * req7.height > 1024 * 1024);

    section('7) 探活端点可用');
    const sub = await fetch(`${base}/user/subscription`, { headers: { Authorization: 'Bearer t' } });
    assertEqual('带 token 时 200', sub.status, 200);
} catch (error) {
    failures += 1;
    checks += 1;
    console.log(`✗ 测试异常：${error.message}`);
} finally {
    child?.kill();
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
