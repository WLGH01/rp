#!/usr/bin/env node
// 假的 NovelAI 官方 API 服务（image.novelai.net），仅用于本地验证 RP-Hub 的官方生图链路。
//
// 复刻官方行为（对着官方文档与官方 Python 库核实过）：
//   POST /ai/generate-image   Bearer 鉴权；请求体 { input, model, action, parameters }
//                             成功时返回一个 ZIP（内含 PNG），而不是 JSON
//   401 无/错 token，400 参数非法（宽高非 64 倍数），402 无订阅
//   GET  /user/subscription   探活用；有 token 时 200
//
// 用法: node tools/mock-nai-official.mjs [port]     默认 8897
// 查看收到的请求: curl http://127.0.0.1:8897/__requests

import http from 'node:http';
import zlib from 'node:zlib';

const port = Number(process.argv[2]) || 8897;
// 2x2 红色 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ3wXh8AAAAASUVORK5CYII=', 'base64');

const requests = [];
let failMode = '';
// 默认接受任意 token；设环境变量可要求指定 token
const EXPECTED_TOKEN = process.env.MOCK_NAI_TOKEN || '';

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
    const url = new URL(request.url || '/', 'http://localhost');
    const p = url.pathname;

    if (request.method === 'OPTIONS') { response.writeHead(204, cors); response.end(); return; }
    if (p === '/__requests') { json(response, 200, requests); return; }
    if (p === '/__reset') { requests.length = 0; failMode = ''; json(response, 200, { ok: true }); return; }
    if (p === '/__fail') { failMode = url.searchParams.get('mode') || 'error'; json(response, 200, { ok: true, mode: failMode }); return; }

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
            trainingStepsLeft: { fixedTrainingStepsLeft: 30, purchasedTrainingSteps: 5 }
        });
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
        const raw = await readBody(request);
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch { /* 非法 JSON */ }
        const params = payload.parameters || {};
        requests.push({
            kind: 'generate',
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
            qualityToggle: params.qualityToggle,
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

        const zip = makeZip(`image_${Number(params.seed) || 0}.png`, PNG);
        response.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': zip.length,
            ...cors
        });
        response.end(zip);
        return;
    }

    json(response, 404, { statusCode: 404, message: 'Not Found' });
}).listen(port, '127.0.0.1', () => {
    console.log(`mock nai official listening on http://127.0.0.1:${port}`);
});
