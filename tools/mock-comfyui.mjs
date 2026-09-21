#!/usr/bin/env node
// 假的 ComfyUI 服务，仅用于本地验证 RP-Hub 的 ComfyUI 生图链路。
//
// 覆盖真实 ComfyUI 0.34 的关键行为（对着 ComfyUI 的 server.py 核对过）：
//   POST /prompt       提交 API 工作流 → { prompt_id }；工作流非法时 400 + node_errors
//   GET  /history/{id} 执行完成后才有 outputs —— 这正是前端要轮询、不能只信 WS 的原因
//   GET  /view         按 filename/subfolder/type 返回图片字节
//   POST /interrupt    中断当前执行
//   POST /queue        删除队列项 { delete: [prompt_id] }
//   GET  /system_stats 探活端点（根路径会 403/重定向，所以前端不能拿根路径探活）
//   GET  /ws           WebSocket，推 progress_state / executing / execution_error
//
// 用法: node tools/mock-comfyui.mjs [port]      默认 8899
// 查看收到的请求: curl http://127.0.0.1:8899/__requests
// 让它下一次执行失败: curl http://127.0.0.1:8899/__fail
// 重置状态:     curl http://127.0.0.1:8899/__reset

import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2]) || 8899;
// 2x2 红色 PNG
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ3wXh8AAAAASUVORK5CYII=', 'base64');

const requests = [];
const prompts = new Map();
let shouldFail = false;

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

// --- 极简 WebSocket 服务端（只推文本帧，不引第三方依赖）---
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Set();

const encodeWsText = (text) => {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x81; // FIN + text
    return Buffer.concat([header, payload]);
};

const broadcast = (type, data) => {
    const frame = encodeWsText(JSON.stringify({ type, data }));
    for (const socket of wsClients) {
        try { socket.write(frame); } catch { wsClients.delete(socket); }
    }
};

const upgradeWebSocket = (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '', ''
    ].join('\r\n'));
    wsClients.add(socket);
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
    // 连上先发一条 status（真实 ComfyUI 也这么做）
    socket.write(encodeWsText(JSON.stringify({
        type: 'status',
        data: { status: { exec_info: { queue_remaining: 0 } }, sid: 'mock-sid' }
    })));
};

// 逐帧推进进度，再落 history，最后推 executing:null —— 复刻真实时序。
const runPrompt = (promptId, prompt, fail) => {
    const totalSteps = Number(prompt?.['3']?.inputs?.steps) || 20;
    let step = 0;
    const tick = () => {
        const item = prompts.get(promptId);
        // 已被 /interrupt 打断：停在这里，不再落 history。
        if (item?.status === 'interrupted') {
            broadcast('execution_interrupted', { prompt_id: promptId });
            return;
        }
        step += Math.max(1, Math.round(totalSteps / 5));
        const done = step >= totalSteps;
        broadcast('progress_state', {
            prompt_id: promptId,
            nodes: {
                '3': {
                    value: Math.min(step, totalSteps),
                    max: totalSteps,
                    state: done ? 'finished' : 'running',
                    node_id: '3',
                    prompt_id: promptId
                }
            }
        });
        if (!done) { setTimeout(tick, 120); return; }
        if (fail) {
            const errorInfo = {
                prompt_id: promptId,
                node_id: '3',
                exception_type: 'RuntimeError',
                exception_message: 'mock 执行失败'
            };
            broadcast('execution_error', errorInfo);
            if (item) {
                item.status = 'error';
                // 真实 ComfyUI 在失败时也会写 history（status_str=error + messages 里的 execution_error），
                // 前端因此可以从 history 读到失败原因，而不是只能干等超时。
                item.entry = {
                    prompt: [0, promptId, prompt, {}, []],
                    outputs: {},
                    status: {
                        status_str: 'error',
                        completed: false,
                        messages: [['execution_error', errorInfo]]
                    }
                };
            }
            broadcast('executing', { node: null, prompt_id: promptId });
            return;
        }
        // 文件名里带上提示词片段，便于断言「参数确实写进了工作流」。
        const text = String(prompt?.['6']?.inputs?.text || 'none').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) || 'none';
        if (item) {
            item.status = 'success';
            item.entry = {
                prompt: [0, promptId, prompt, {}, []],
                outputs: {
                    '9': { images: [{ filename: `ComfyUI_${text}_00001_.png`, subfolder: '', type: 'output' }] }
                },
                status: { status_str: 'success', completed: true, messages: [] }
            };
        }
        broadcast('executing', { node: null, prompt_id: promptId });
    };
    setTimeout(tick, 120);
};

const OBJECT_INFO = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['mock-model.safetensors']] } } },
    VAELoader: { input: { required: { vae_name: [['mock-vae.safetensors']] } } },
    KSampler: {
        input: {
            required: {
                sampler_name: [['euler', 'dpmpp_2m']],
                scheduler: [['normal', 'karras']],
                steps: ['INT', { default: 20 }]
            }
        }
    }
};

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const p = url.pathname;

    if (request.method === 'OPTIONS') { response.writeHead(204, cors); response.end(); return; }
    if (p === '/__requests') { json(response, 200, requests); return; }
    if (p === '/__reset') { requests.length = 0; prompts.clear(); shouldFail = false; json(response, 200, { ok: true }); return; }
    if (p === '/__fail') { shouldFail = true; json(response, 200, { ok: true }); return; }

    if (p === '/system_stats') {
        json(response, 200, {
            system: { comfyui_version: '0.34.0-mock', python_version: '3.12', pytorch_version: '2.11' },
            devices: [{ name: 'mock-cuda', type: 'cuda' }]
        });
        return;
    }

    if (p.startsWith('/object_info/')) {
        const name = p.slice('/object_info/'.length);
        json(response, 200, OBJECT_INFO[name] ? { [name]: OBJECT_INFO[name] } : {});
        return;
    }

    if (p === '/view' && request.method === 'GET') {
        const filename = url.searchParams.get('filename') || '';
        requests.push({
            at: new Date().toISOString(), kind: 'view', filename,
            subfolder: url.searchParams.get('subfolder') || '', type: url.searchParams.get('type') || ''
        });
        if (!filename) { json(response, 404, { error: 'not found' }); return; }
        response.writeHead(200, { 'Content-Type': 'image/png', ...cors });
        response.end(PNG_BYTES);
        return;
    }

    if (p === '/prompt' && request.method === 'POST') {
        const raw = await readBody(request);
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch { /* 下面按非法处理 */ }
        const prompt = payload.prompt;
        requests.push({
            at: new Date().toISOString(), kind: 'prompt', clientId: payload.client_id || '',
            text: prompt?.['6']?.inputs?.text, negative: prompt?.['7']?.inputs?.text,
            steps: prompt?.['3']?.inputs?.steps, seed: prompt?.['3']?.inputs?.seed,
            width: prompt?.['5']?.inputs?.width, height: prompt?.['5']?.inputs?.height,
            ckpt: prompt?.['4']?.inputs?.ckpt_name, filenamePrefix: prompt?.['9']?.inputs?.filename_prefix
        });
        if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) {
            json(response, 400, {
                error: { type: 'no_prompt', message: 'No prompt provided', details: 'No prompt provided', extra_info: {} },
                node_errors: {}
            });
            return;
        }
        for (const [nodeId, node] of Object.entries(prompt)) {
            if (!node || typeof node !== 'object' || !node.class_type) {
                json(response, 400, {
                    error: { type: 'invalid_prompt', message: `节点 ${nodeId} 无效`, details: '', extra_info: {} },
                    node_errors: { [nodeId]: { errors: [{ type: 'invalid_node', message: 'missing class_type' }] } }
                });
                return;
            }
        }
        const promptId = crypto.randomUUID();
        prompts.set(promptId, { prompt, entry: null, status: 'running' });
        json(response, 200, { prompt_id: promptId, number: 1, node_errors: {} });
        const fail = shouldFail;
        setTimeout(() => runPrompt(promptId, prompt, fail), 200);
        return;
    }

    if (p === '/history' && request.method === 'GET') {
        const all = {};
        for (const [id, item] of prompts.entries()) { if (item.entry) all[id] = item.entry; }
        json(response, 200, all);
        return;
    }
    if (p.startsWith('/history/') && request.method === 'GET') {
        const id = decodeURIComponent(p.slice('/history/'.length));
        const item = prompts.get(id);
        // 未完成时返回空对象（真实 ComfyUI 行为）——前端据此判断「还没写完」。
        json(response, 200, item?.entry ? { [id]: item.entry } : {});
        return;
    }

    if (p === '/interrupt' && request.method === 'POST') {
        requests.push({ at: new Date().toISOString(), kind: 'interrupt' });
        for (const item of prompts.values()) { if (item.status === 'running') item.status = 'interrupted'; }
        json(response, 200, {});
        return;
    }
    if (p === '/queue' && request.method === 'POST') {
        const raw = await readBody(request);
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
        requests.push({ at: new Date().toISOString(), kind: 'queue', delete: payload.delete || null, clear: !!payload.clear });
        json(response, 200, {});
        return;
    }
    if (p === '/queue' && request.method === 'GET') {
        json(response, 200, { queue_running: [], queue_pending: [] });
        return;
    }

    json(response, 404, { error: 'Not Found' });
});

server.on('upgrade', (request, socket) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    upgradeWebSocket(request, socket);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`mock comfyui listening on http://127.0.0.1:${port}`);
});
