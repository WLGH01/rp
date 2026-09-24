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
    Blob, Response, DecompressionStream, fetch,
    AbortController, AbortSignal, DOMException
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
            if (!res.ok) continue;
            // 还要确认应答的是「本次这个 mock」：端口上若残留着旧进程，
            // 缺 /__stats（并发统计）会导致后面出现假失败。
            const stats = await fetch(`http://127.0.0.1:${port}/__stats`);
            const payload = await stats.json().catch(() => null);
            if (typeof payload?.maxInFlight === 'number') return proc;
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
    assertEqual('V4.5 的 params_version=4（与官方前端一致）', req45.paramsVersion, 4);
    assertEqual('V4.5 的 UC 预设走 ucPresetId 字符串（默认=无）', req45.ucPresetId, 'none');
    assertEqual('V4.5 的质量标签走 qualityPresetId 字符串（默认=不发）', req45.qualityPresetId, 'none');
    assertEqual('V4.5 不再发数字 ucPreset', req45.ucPreset, undefined);
    assertEqual('V4.5 不再发布尔 qualityToggle', req45.qualityToggle, undefined);
    assertEqual('V4.5 默认不发 skip_cfg_above_sigma（多样性增强默认关）', req45.skipCfg, undefined);
    // 显式打开时才发（且 4.5 是 58、V4 是 19）
    await runChain({
        naiOfficialModel: 'nai-diffusion-4-5-full',
        naiOfficialResolution: '832x1216',
        naiOfficialSteps: 28,
        naiOfficialVarietyBoost: true
    });
    const seen45on = await (await fetch(`${base}/__requests`)).json();
    const req45on = seen45on.filter(r => r.kind === 'generate').pop();
    assertEqual('显式开多样性增强时带 58', req45on.skipCfg, 58);

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

    section('8) 账户额度查询（订阅等级 / 试用张数 / 训练步数）');
    // 复刻 app.js 的 fetchNaiOfficialAccount：两个端点并行取，再交给纯函数整理。
    const accountOf = async (token = 'pst-test-token') => {
        const headers = { Authorization: `Bearer ${token}` };
        const [subRes, infoRes] = await Promise.all([
            fetch(`${base}/user/subscription`, { headers }),
            fetch(`${base}/user/information`, { headers })
        ]);
        if (subRes.status === 401 || infoRes.status === 401) throw new Error('鉴权失败（401）');
        const subscription = subRes.ok ? await subRes.json().catch(() => null) : null;
        const information = infoRes.ok ? await infoRes.json().catch(() => null) : null;
        return nai.resolveNaiOfficialAccount({ subscription, information });
    };

    const account = await accountOf();
    assertEqual('档位识别为 Opus', account.tierLabel, 'Opus');
    assertEqual('订阅生效', account.active, true);
    assertEqual('试用剩余张数取到', account.trialImagesLeft, 27);
    assertEqual('训练步数为固定+已购', account.trainingStepsLeft, 35);
    assertTrue('额度文案可直接展示', /Opus/.test(nai.describeNaiOfficialAccount(account)));

    section('8b) V5 充能（Opus 生成额度）：从 /user/subscription 的 usage 取');
    // 前提：官方在「Opus 且订阅生效」时会多带 usage{percent,isNegative,timeUntilNextPercent}。
    // percent 是**剩余**百分比，timeUntilNextPercent 是「每回 1% 需要多少秒」。
    assertEqual('充能百分比解析出来', account.usage?.percent, 69);
    assertEqual('回充秒数解析出来', account.usage?.secondsPerPercent, 7888);
    assertEqual('未透支', account.usage?.isNegative, false);
    assertEqual('条宽用百分比（未封顶时就是原值）', nai.naiOfficialUsageBarPercent(account.usage), 69);
    // 官方条上的换算：86400/7888 ≈ 10.95 → 保留 1 位小数
    assertEqual('回充速度 = 86400 / 秒数', nai.naiOfficialUsageRefillRatePerDay(account.usage), 11);
    // 官方「~N images」用的就是 17.3 张 / %
    assertEqual('可出图数 ≈ 17.3 张 / %', nai.naiOfficialUsageImagesLeft(account.usage), 1194);
    assertEqual('69% 不算低位', nai.isNaiOfficialUsageLow(account.usage), false);
    assertTrue('额度文案里带上充能', /V5 充能 剩余 69%/.test(nai.describeNaiOfficialAccount(account)));

    // 只有 V5 消耗这条充能：官方前端里 opusUsageLimit 只对 nai-diffusion-5-* 为真。
    assertEqual('V5 消耗充能', nai.isNaiOfficialUsageModel('nai-diffusion-5-full'), true);
    assertEqual('V5 Curated 同样消耗', nai.isNaiOfficialUsageModel('nai-diffusion-5-curated'), true);
    assertEqual('V4.5 不消耗充能', nai.isNaiOfficialUsageModel('nai-diffusion-4-5-full'), false);
    assertEqual('V4 不消耗充能', nai.isNaiOfficialUsageModel('nai-diffusion-4-full'), false);

    // 用尽：官方把 isNegative 的条显示成 0%，但**数字口径**仍是「剩余 0%」
    const emptyUsage = nai.resolveNaiOfficialUsage({ percent: 0, isNegative: true, timeUntilNextPercent: 0 });
    assertEqual('用尽时条宽为 0', nai.naiOfficialUsageBarPercent(emptyUsage), 0);
    assertEqual('用尽时算低位（会提醒）', nai.isNaiOfficialUsageLow(emptyUsage), true);
    assertEqual('秒数为 0 时回充速度记 0（不除零）', nai.naiOfficialUsageRefillRatePerDay(emptyUsage), 0);
    assertTrue('用尽文案点明会走 Anlas', /已用尽/.test(nai.describeNaiOfficialUsage(emptyUsage)));

    // >100 是合法状态（官方发过 100% 奖励）：数字不封顶，条宽才封顶
    const bonusUsage = nai.resolveNaiOfficialUsage({ percent: 140, isNegative: false, timeUntilNextPercent: 0 });
    assertEqual('奖励额度：数字不封顶', nai.naiOfficialUsagePercent(bonusUsage), 140);
    assertEqual('奖励额度：条宽封顶 100', nai.naiOfficialUsageBarPercent(bonusUsage), 100);

    // 缺字段不能崩，也不能编造数字
    assertEqual('无 usage 时为 null（不假装是 0）', nai.resolveNaiOfficialUsage(undefined), null);
    assertEqual('percent 非数字时为 null', nai.resolveNaiOfficialUsage({ percent: 'x' }), null);
    assertEqual('usage 为 null 时条宽 0', nai.naiOfficialUsageBarPercent(null), 0);
    assertEqual('usage 为 null 时文案为空串', nai.describeNaiOfficialUsage(null), '');
    assertEqual('usage 缺失不影响其他字段',
        nai.resolveNaiOfficialAccount({ subscription: { tier: 3, active: true } }).usage, null);

    // 切到「没有 usage」的账号（非 Opus / 未生效）：整条不显示，而不是显示 0%
    await fetch(`${base}/__usage?mode=absent`);
    const noUsage = await accountOf();
    assertEqual('官方不返回 usage 时为 null', noUsage.usage, null);
    assertTrue('此时额度文案里没有充能段', !/充能/.test(nai.describeNaiOfficialAccount(noUsage)));

    // 切到用尽的账号：接口层也要能带出来
    await fetch(`${base}/__usage?mode=empty`);
    const emptyAcct = await accountOf();
    assertEqual('用尽账号：isNegative 透传', emptyAcct.usage?.isNegative, true);
    assertEqual('用尽账号：条宽 0', nai.naiOfficialUsageBarPercent(emptyAcct.usage), 0);
    await fetch(`${base}/__usage?mode=normal`);

    // 无 token 时必须报错，不能静默返回空数据
    let noAuth = '';
    try { await accountOf(''); } catch (e) { noAuth = e.message; }
    assertTrue('无 token 时明确报鉴权失败', /401/.test(noAuth));

    // 两个端点都要带鉴权
    const seenAcct = await (await fetch(`${base}/__requests`)).json();
    const infoReq = seenAcct.filter(r => r.kind === 'information').pop();
    assertTrue('information 端点带上了 Bearer', infoReq?.auth === 'present');

    section('9) 官方并发闸门：并发度 1 的队列必须串行');
    const serialQueue = nai.createSerialTaskQueue({ concurrency: 1 });
    let runningTasks = 0;
    let maxRunningTasks = 0;
    const finishedOrder = [];
    await Promise.all([1, 2, 3].map(n => serialQueue.run(async () => {
        runningTasks += 1;
        maxRunningTasks = Math.max(maxRunningTasks, runningTasks);
        await new Promise(r => setTimeout(r, 15));
        finishedOrder.push(n);
        runningTasks -= 1;
    })));
    assertEqual('同一时刻只有 1 个任务在跑', maxRunningTasks, 1);
    assertEqual('按入队顺序完成', finishedOrder, [1, 2, 3]);

    const waits = [];
    const queue2 = nai.createSerialTaskQueue({ concurrency: 1 });
    await Promise.all([
        queue2.run(() => new Promise(r => setTimeout(r, 40)), { onWait: (pos, total) => waits.push(['a', pos, total]) }),
        queue2.run(async () => {}, { onWait: (pos, total) => waits.push(['b', pos, total]) }),
        queue2.run(async () => {}, { onWait: (pos, total) => waits.push(['c', pos, total]) })
    ]);
    assertTrue('排队的第 2 个任务拿到第 1 位', waits.some(([who, pos]) => who === 'b' && pos === 1));
    assertTrue('第 3 个任务先排第 2 位、再补到第 1 位',
        waits.some(([who, pos]) => who === 'c' && pos === 2) && waits.some(([who, pos]) => who === 'c' && pos === 1));

    section('10) 报错重试策略：408/429/5xx 与超时都重试，4xx 业务错误不重试');
    assertEqual('429 可重试', nai.isNaiOfficialRetryableStatus(429), true);
    assertEqual('503 可重试', nai.isNaiOfficialRetryableStatus(503), true);
    assertEqual('408（请求超时）可重试', nai.isNaiOfficialRetryableStatus(408), true);
    assertEqual('402 不重试', nai.isNaiOfficialRetryableStatus(402), false);
    assertEqual('400 不重试', nai.isNaiOfficialRetryableStatus(400), false);
    assertEqual('默认只重试 2 次', nai.NAI_OFFICIAL_RETRY_DEFAULTS.retryMax, 2);
    assertEqual('默认间隔是 3s / 5s', nai.NAI_OFFICIAL_RETRY_DEFAULTS.delaysMs, [3000, 5000]);
    assertTrue('单次尝试有超时上限', nai.NAI_OFFICIAL_TIMEOUT_MS > 0);
    assertEqual('间隔解析支持中文逗号/顿号',
        [nai.parseNaiOfficialRetryDelays('3,5'), nai.parseNaiOfficialRetryDelays('4，6'), nai.parseNaiOfficialRetryDelays('7、9')],
        [[3000, 5000], [4000, 6000], [7000, 9000]]);
    assertEqual('间隔留空回落默认', nai.parseNaiOfficialRetryDelays(''), [3000, 5000]);
    assertEqual('间隔非法值回落默认', nai.parseNaiOfficialRetryDelays('abc'), [3000, 5000]);
    assertEqual('间隔被夹在 1–60 秒（非正数直接忽略）',
        [nai.parseNaiOfficialRetryDelays('0,120'), nai.parseNaiOfficialRetryDelays('0')],
        [[60000], [3000, 5000]]);
    assertEqual('策略：次数与间隔都从设置读',
        nai.resolveNaiOfficialRetryPolicy({ naiOfficialRetryMax: 1, naiOfficialRetryDelays: '9' }),
        { retryMax: 1, delaysMs: [9000] });
    assertEqual('策略：次数被夹在 0–5',
        [nai.resolveNaiOfficialRetryPolicy({ naiOfficialRetryMax: -3 }).retryMax,
            nai.resolveNaiOfficialRetryPolicy({ naiOfficialRetryMax: 99 }).retryMax],
        [0, 5]);
    assertEqual('策略：缺设置时用默认',
        nai.resolveNaiOfficialRetryPolicy({}),
        { retryMax: 2, delaysMs: [3000, 5000] });
    assertEqual('第 1/2 次重试取 3s / 5s',
        [0, 1].map(i => nai.naiOfficialRetryDelayMs(i, { delaysMs: [3000, 5000] })),
        [3000, 5000]);
    assertEqual('次数多于间隔时沿用最后一个',
        [2, 5].map(i => nai.naiOfficialRetryDelayMs(i, { delaysMs: [3000, 5000] })),
        [5000, 5000]);
    assertTrue('429 文案带出服务端 message',
        /429/.test(nai.describeNaiOfficialHttpError(429, 'Too Many Requests'))
        && /Too Many Requests/.test(nai.describeNaiOfficialHttpError(429, 'Too Many Requests')));

    section('11) 撞 429 时自动退避重试（真实 HTTP）');
    await fetch(`${base}/__reset`);
    await fetch(`${base}/__fail?mode=busy&count=1`);
    const officialSettings = { naiOfficialModel: 'nai-diffusion-5-full', naiOfficialResolution: '1024x1024', naiOfficialSteps: 28 };
    const callOfficial = (tag, options = {}) => nai.fetchNaiOfficialImageBytes({
        baseUrl: base,
        token: 'pst-test-token',
        payload: nai.buildNaiOfficialPayload({ settings: officialSettings, prompt: tag, negativePrompt: 'bad' }),
        fetchImpl: fetch,
        sleep: () => Promise.resolve(),
        ...options
    });
    const retries = [];
    const retried = await callOfficial('retry-me', { onRetry: info => retries.push(info) });
    assertTrue('429 之后重试成功（拿到 ZIP 字节）', retried.arrayBuffer.byteLength > 0);
    assertEqual('确实重试了 1 次', retries.length, 1);
    assertEqual('重试原因是 429', retries[0].status, 429);
    assertEqual('重试间隔取设置里的第一次间隔（默认 3s）', retries[0].delayMs, 3000);
    assertEqual('重试不是超时导致的', retries[0].timedOut, false);
    const seenBusy = await (await fetch(`${base}/__requests`)).json();
    assertEqual('服务端收到 2 次提交（1 次 429 + 1 次成功）',
        seenBusy.filter(r => r.kind === 'generate').length, 2);

    section('11b) 请求超时也会重试，而不是一直挂着');
    await fetch(`${base}/__reset`);
    await fetch(`${base}/__fail?mode=stall&count=1&ms=250`);
    const timeoutRetries = [];
    const afterTimeout = await callOfficial('slow-first', {
        timeoutMs: 40,
        onRetry: info => timeoutRetries.push(info)
    });
    assertTrue('第一次超时后重试拿到了图', afterTimeout.arrayBuffer.byteLength > 0);
    assertEqual('超时触发了 1 次重试', timeoutRetries.length, 1);
    assertEqual('重试原因标记为超时', timeoutRetries[0].timedOut, true);
    assertEqual('超时重试的 status 记 0', timeoutRetries[0].status, 0);
    // 一直挂住时不能无限重试：retryMax=0 必须直接报「请求超时」
    await fetch(`${base}/__reset`);
    await fetch(`${base}/__fail?mode=stall&count=1&ms=250`);
    let timeoutMessage = '';
    try { await callOfficial('stuck', { timeoutMs: 40, retryMax: 0 }); }
    catch (error) { timeoutMessage = error.message; }
    assertTrue('不重试时明确报「请求超时」', /请求超时/.test(timeoutMessage) && /已尝试 1 次/.test(timeoutMessage));

    section('11c) 业务错误不重试（省额度、不浪费时间）');
    await fetch(`${base}/__reset`);
    await fetch(`${base}/__fail?mode=payment`);
    const businessRetries = [];
    let businessMessage = '';
    try { await callOfficial('no-plan', { onRetry: info => businessRetries.push(info) }); }
    catch (error) { businessMessage = error.message; }
    assertEqual('402 一次都不重试', businessRetries.length, 0);
    assertTrue('402 的文案照旧带出 message', /已重试/.test(businessMessage) === false && /subscription/i.test(businessMessage));

    section('12) 账号并发 1：不加队列会 429，加了队列不会');
    await fetch(`${base}/__reset`);
    await fetch(`${base}/__fail?mode=concurrency`);
    // retryMax=0：让 429 直接失败，用来证明「并发会撞墙」这件事是真的。
    const rawPair = await Promise.allSettled([
        callOfficial('raw-a', { retryMax: 0 }),
        callOfficial('raw-b', { retryMax: 0 })
    ]);
    assertEqual('不加队列时必有一个 429',
        rawPair.filter(r => r.status === 'rejected' && /429/.test(r.reason.message)).length, 1);

    await fetch(`${base}/__reset`);
    await fetch(`${base}/__fail?mode=concurrency`);
    const queuedQueue = nai.createSerialTaskQueue({ concurrency: 1 });
    const queuedResults = await Promise.all(['q-a', 'q-b', 'q-c'].map(tag => queuedQueue.run(() => callOfficial(tag))));
    assertEqual('过队列后 3 张全部成功', queuedResults.filter(r => r.arrayBuffer.byteLength > 0).length, 3);
    const stats = await (await fetch(`${base}/__stats`)).json();
    assertEqual('服务端从未看到并发', stats.maxInFlight, 1);
    assertEqual('统计里是 3 次提交', stats.generates, 3);

    section('13) 已完成图片缓存：参数没变才复用，参数改了必须重跑');
    const imageUtils2 = sandbox.window.RPHubImageUtils;
    const baseSettings = {
        imageProvider: 'novelai-official',
        imageGenBaseUrl: '',
        imageStyle: 'vertical',
        customImageArtists: '',
        imageModel: 'nai-diffusion-4-5-full',
        imageSize: '竖图',
        naiOfficialModel: 'nai-diffusion-4-5-full',
        naiOfficialResolution: '832x1216',
        naiOfficialSteps: 28,
        naiOfficialScale: 5,
        naiOfficialSampler: 'k_euler_ancestral',
        naiOfficialUcPreset: 0,
        naiOfficialQualityToggle: true,
        naiOfficialVarietyBoost: true,
        naiOfficialNegativePrompt: '',
        naiOfficialSeed: ''
    };
    const requestUrl = 'http://x/ai/generate-image?tag=1girl&provider=novelai-official&size=竖图&w=832&h=1216';
    const fp = (patch = {}) => imageUtils2.resolveImageCacheFingerprint({
        settings: { ...baseSettings, ...patch },
        requestUrl
    });
    assertEqual('同一套参数指纹一致', fp() === fp(), true);
    assertEqual('改了负面 → 指纹变化', fp() !== fp({ naiOfficialNegativePrompt: 'bad anatomy' }), true);
    assertEqual('改了 UC 预设 → 指纹变化', fp() !== fp({ naiOfficialUcPreset: 4 }), true);
    assertEqual('改了风格 → 指纹变化', fp() !== fp({ imageStyle: 'r18' }), true);
    assertEqual('改了模型 → 指纹变化', fp() !== fp({ naiOfficialModel: 'nai-diffusion-5-full' }), true);
    assertEqual('改了步数 → 指纹变化', fp() !== fp({ naiOfficialSteps: 40 }), true);
    assertEqual('换了服务地址 → 指纹变化', fp() !== fp({ imageGenBaseUrl: 'http://elsewhere' }), true);
    assertEqual('换了生图方式 → 指纹变化', fp() !== fp({ imageProvider: 'novelai' }), true);
    assertEqual('输入框里没变的键不影响指纹（qualityToggle 显式同值）',
        fp() === fp({ naiOfficialQualityToggle: true }), true);

    // 第 51 条：切「分辨率」不是改参数，历史横图不该重跑（官方 API 会花 Anlas）。
    assertEqual('官方分辨率 832x1216 → 1216x832：指纹不变',
        fp() === fp({ naiOfficialResolution: '1216x832' }), true);
    assertEqual('URL 里的 size/w/h 变化不影响指纹',
        fp() === imageUtils2.resolveImageCacheFingerprint({
            settings: baseSettings,
            requestUrl: 'http://x/ai/generate-image?tag=1girl&provider=novelai-official&size=横图&w=1216&h=832'
        }), true);
    assertEqual('切成竖图后历史横图条目不算过期',
        imageUtils2.isCachedImageJobOutdated({ imageFingerprint: fp() }, fp({ naiOfficialResolution: '1216x832' })), false);
    assertEqual('老指纹（尺寸进了指纹的旧算法）升级后不算过期',
        imageUtils2.isCachedImageJobOutdated({
            imageFingerprint: JSON.stringify({
                provider: 'novelai-official',
                baseUrl: '',
                profile: imageUtils2.captureImageProfile(baseSettings),
                request: { provider: 'novelai-official', size: '竖图', w: '832', h: '1216' }
            })
        }, fp()), false);

    // 「过期」只表示「这张图是按旧参数出的」，用来给卡片打提示；
    // 它**不再**触发重跑（第 53 条）：进旧会话/换预设都不该重跑历史图，想重出要点 ↻。
    assertEqual('参数一致 → 不算过期', imageUtils2.isCachedImageJobOutdated({ imageFingerprint: fp() }, fp()), false);
    assertEqual('参数变了 → 判为过期（只提示，不重跑）',
        imageUtils2.isCachedImageJobOutdated({ imageFingerprint: fp() }, fp({ naiOfficialNegativePrompt: 'x' })), true);
    assertEqual('老条目没有指纹 → 一律不算过期（不烧额度）',
        imageUtils2.isCachedImageJobOutdated({ status: 'done', imageUrl: 'x' }, fp()), false);
    assertEqual('没有条目 → 也不当作过期', imageUtils2.isCachedImageJobOutdated(null, fp()), false);
    // 请求 URL 里的出图参数（网关的 steps/sampler/negative）也要参与指纹
    const gwA = imageUtils2.resolveImageCacheFingerprint({ settings: baseSettings, requestUrl: 'http://x/generate?tag=a&steps=40&sampler=k_euler' });
    const gwB = imageUtils2.resolveImageCacheFingerprint({ settings: baseSettings, requestUrl: 'http://x/generate?tag=a&steps=28&sampler=k_euler' });
    assertEqual('URL 里的 steps 变化 → 指纹变化', gwA !== gwB, true);
    const gwC = imageUtils2.resolveImageCacheFingerprint({ settings: baseSettings, requestUrl: 'http://x/generate?tag=a&steps=40&sampler=k_euler&nocache=1&token=abc' });
    assertEqual('nocache / token 这类易变参数不参与指纹', gwA === gwC, true);
} catch (error) {
    failures += 1;
    checks += 1;
    console.log(`✗ 测试异常：${error.message}`);
} finally {
    child?.kill();
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
