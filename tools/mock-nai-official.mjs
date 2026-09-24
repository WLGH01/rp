#!/usr/bin/env node
// 假的 NovelAI 官方 API 服务（image.novelai.net），仅用于本地验证 RP-Hub 的官方生图链路。
//
// 复刻官方行为（对着官方文档与官方 Python 库核实过）：
//   POST /ai/generate-image   Bearer 鉴权；请求体 { input, model, action, parameters }
//                             成功时返回一个 ZIP（内含 PNG），而不是 JSON
//   401 无/错 token，400 参数非法（宽高非 64 倍数），402 无订阅
//   429 账号并发已满（官方是「全局并发 1」）：__fail?mode=concurrency 会复刻它
//   GET  /user/subscription   探活用；有 token 时 200，并带上 V5 充能 usage
//   GET  /user/information    免费试用剩余张数在这里
//
// 用法: node tools/mock-nai-official.mjs [port]     默认 8897
// 查看收到的请求: curl http://127.0.0.1:8897/__requests
// 查看并发统计:   curl http://127.0.0.1:8897/__stats
// 切换充能形态:   curl 'http://127.0.0.1:8897/__usage?mode=empty|bonus|absent'
// 注入故障:       curl 'http://127.0.0.1:8897/__fail?mode=busy&count=1'（下 1 次请求 429）
//                 curl 'http://127.0.0.1:8897/__fail?mode=concurrency'（并发 >1 时 429）
//                 curl 'http://127.0.0.1:8897/__fail?mode=stall&count=1&ms=300'（下 1 次请求挂住）

import http from 'node:http';
import zlib from 'node:zlib';

const port = Number(process.argv[2]) || 8897;
// 2x2 红色 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ3wXh8AAAAASUVORK5CYII=', 'base64');

const requests = [];
let failMode = '';
// mode=busy 时还要吞掉多少次请求（每次 429 后减一）。
let busyRemaining = 0;
// mode=stall 时还要让多少次请求「卡住不返回」（用来验证客户端超时重试）。
let stallRemaining = 0;
let stallMs = 300;
// 账号级并发：inFlight 用来复刻「全局并发 1」，maxInFlight 用来断言客户端确实没并发。
let inFlight = 0;
let maxInFlight = 0;
// subscription 里 usage（V5 充能）的形态：normal / empty / bonus / absent。
let usageMode = 'normal';
// 默认接受任意 token；设环境变量可要求指定 token
const EXPECTED_TOKEN = process.env.MOCK_NAI_TOKEN || '';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
    response.end(JSON.stringify(body));
};

const readBody = (request) => new Promise(resolve => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => resolve(raw));
});

// 构造一个真实的 ZIP（deflate 压缩 + 中央目录），与官方响应同构。
const makeZip = (name, data) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);        // deflate
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);

    const localFull = Buffer.concat([local, nameBuf, comp]);
    const centralFull = Buffer.concat([central, nameBuf]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralFull.length, 12);
    eocd.writeUInt32LE(localFull.length, 16);
    return Buffer.concat([localFull, centralFull, eocd]);
};

http.createServer(async (request, response) => {
    // 客户端超时重试会主动断开连接，之后写响应会报错——这是预期行为，忽略即可。
    response.on('error', () => {});
    const url = new URL(request.url || '/', 'http://localhost');
    const p = url.pathname;

    if (request.method === 'OPTIONS') { response.writeHead(204, cors); response.end(); return; }
    if (p === '/__requests') { json(response, 200, requests); return; }
    if (p === '/__stats') { json(response, 200, { inFlight, maxInFlight, generates: requests.filter(r => r.kind === 'generate').length }); return; }
    if (p === '/__reset') {
        requests.length = 0;
        failMode = '';
        busyRemaining = 0;
        stallRemaining = 0;
        inFlight = 0;
        maxInFlight = 0;
        usageMode = 'normal';
        json(response, 200, { ok: true });
        return;
    }
    if (p === '/__fail') {
        const mode = url.searchParams.get('mode') || 'error';
        if (mode === 'busy') {
            // 「下 N 次请求回 429」：用于验证客户端的退避重试。
            busyRemaining = Math.max(1, Number(url.searchParams.get('count')) || 1);
            failMode = '';
        } else if (mode === 'stall') {
            // 「下 N 次请求挂住不返回」：用于验证客户端超时后也会重试。
            stallRemaining = Math.max(1, Number(url.searchParams.get('count')) || 1);
            stallMs = Math.max(50, Number(url.searchParams.get('ms')) || 300);
            failMode = '';
        } else {
            failMode = mode;
            busyRemaining = 0;
        }
        json(response, 200, { ok: true, mode, busyRemaining, stallRemaining });
        return;
    }

    const auth = request.headers['authorization'] || '';

    // 探活端点
    if (p === '/user/subscription') {
        requests.push({ kind: 'subscription', auth: auth ? 'present' : 'missing' });
        if (!auth.startsWith('Bearer ')) return json(response, 401, { statusCode: 401, message: 'Unauthorized' });
        return json(response, 200, {
            tier: 3,
            active: true,
            expiresAt: 1789000000000,
            perks: { maxPriorityActions: 30, startPriority: 30, contextTokens: 8192, unlimitedMaxPriority: true, moduleTrainingSteps: 30 },
            trainingStepsLeft: { fixedTrainingStepsLeft: 30, purchasedTrainingSteps: 5 },
            // V5 充能（Opus 生成额度）：官方在「Opus 且订阅生效」时才返回 usage。
            // percent 是**剩余**百分比；timeUntilNextPercent 是「每回 1% 需要多少秒」。
            // 7888 秒 / % → 86400/7888 ≈ 10.95 → 官方条上写 ~11%/天。
            ...(usageMode === 'absent' ? {} : {
                usage: usageMode === 'empty'
                    ? { percent: 0, isNegative: true, timeUntilNextPercent: 0 }
                    : usageMode === 'bonus'
                        // 官方发过 100% 奖励，所以 >100 是合法状态（条宽封顶，数字不封顶）。
                        ? { percent: 140, isNegative: false, timeUntilNextPercent: 0 }
                        : { percent: 69, isNegative: false, timeUntilNextPercent: 7888 }
            })
        });
    }

    // 充能用尽的账号：isNegative=true 时官方把条显示成 0%。
    // 通过 /__usage?mode=empty|bonus|absent 切换，用于验证各种边界口径。
    if (p === '/__usage') {
        usageMode = url.searchParams.get('mode') || 'normal';
        json(response, 200, { ok: true, usageMode });
        return;
    }

    // 账户信息端点：免费试用剩余张数在这里（官方把额度拆在 subscription / information 两处）
    if (p === '/user/information') {
        requests.push({ kind: 'information', auth: auth ? 'present' : 'missing' });
        if (!auth.startsWith('Bearer ')) return json(response, 401, { statusCode: 401, message: 'Unauthorized' });
        return json(response, 200, {
            emailVerified: true,
            emailVerificationLetterSent: false,
            hasPlaintextEmail: true,
            plaintextEmail: 'mock@example.com',
            allowMarketingEmails: false,
            trialActivated: true,
            trialActionsLeft: 100,
            trialImagesLeft: 27,
            accountCreatedAt: 1700000000000,
            banStatus: 'None',
            banMessage: ''
        });
    }

    if (p === '/ai/generate-image' && request.method === 'POST') {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
        const raw = await readBody(request);
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch { /* 非法 JSON */ }
        const params = payload.parameters || {};
        requests.push({
            kind: 'generate',
            concurrentAtStart: inFlight,
            model: payload.model,
            action: payload.action,
            input: payload.input,
            hasAuth: auth.startsWith('Bearer '),
            token: auth.replace(/^Bearer\s+/, ''),
            width: params.width,
            height: params.height,
            steps: params.steps,
            scale: params.scale,
            sampler: params.sampler,
            noiseSchedule: params.noise_schedule,
            seed: params.seed,
            paramsVersion: params.params_version,
            ucPreset: params.ucPreset,
            ucPresetId: params.ucPresetId,
            qualityToggle: params.qualityToggle,
            qualityPresetId: params.qualityPresetId,
            skipCfg: params.skip_cfg_above_sigma,
            negativePrompt: params.negative_prompt,
            v4Base: params.v4_prompt?.caption?.base_caption,
            v4NegBase: params.v4_negative_prompt?.caption?.base_caption,
            useOrder: params.v4_prompt?.use_order
        });

        if (failMode === 'unauthorized' || !auth.startsWith('Bearer ')) {
            return json(response, 401, { statusCode: 401, message: 'Unauthorized' });
        }
        if (EXPECTED_TOKEN && auth.replace(/^Bearer\s+/, '') !== EXPECTED_TOKEN) {
            return json(response, 401, { statusCode: 401, message: 'Invalid token' });
        }
        // 「下 N 次 429」：用来验证客户端的退避重试确实发生。
        if (busyRemaining > 0) {
            busyRemaining -= 1;
            return json(response, 429, { statusCode: 429, message: 'Too Many Requests: generation slot is busy' });
        }
        // 复刻官方的「账号级全局并发 1」：已有请求在跑时，后到的那个直接 429。
        if (failMode === 'concurrency' && inFlight > 1) {
            return json(response, 429, { statusCode: 429, message: 'Too Many Requests: only 1 concurrent generation per account' });
        }
        if (failMode === 'payment') {
            return json(response, 402, { statusCode: 402, message: 'An active subscription is required to access this endpoint.' });
        }
        if (failMode === 'error') {
            return json(response, 500, { statusCode: 500, message: 'internal generation error' });
        }
        // 官方要求宽高都是 64 的倍数
        if (Number(params.width) % 64 !== 0 || Number(params.height) % 64 !== 0) {
            return json(response, 400, { statusCode: 400, message: 'width and height must be multiples of 64' });
        }
        if (!payload.model || !params.width) {
            return json(response, 400, { statusCode: 400, message: 'invalid request' });
        }

        // concurrency 模式下让请求慢一点，否则两个请求根本来不及重叠。
        if (failMode === 'concurrency') await wait(150);
        // stall 模式：挂住不返回，逼客户端走到「超时 → 重试」这条分支。
        if (stallRemaining > 0) {
            stallRemaining -= 1;
            await wait(stallMs);
        }

        const zip = makeZip(`image_${Number(params.seed) || 0}.png`, PNG);
        response.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': zip.length,
            ...cors
        });
        response.end(zip);
        return;
        } finally {
            inFlight -= 1;
        }
    }

    json(response, 404, { statusCode: 404, message: 'Not Found' });
}).listen(port, '127.0.0.1', () => {
    console.log(`mock nai official listening on http://127.0.0.1:${port}`);
});
