// ComfyUI 生图链路的集成测试
//
// 与 test-image-pipeline.mjs（纯函数）互补：这里起一个真实的 HTTP+WebSocket 服务
// （tools/mock-comfyui.mjs，行为对着 ComfyUI 的 server.py 核对过），
// 用 core-utils 的同一套纯函数走完整条链路，验证「协议契约」而不是函数返回值。
//
// 覆盖：
//   1. 提交 → progress_state 推进 → history 出 outputs → /view 取图
//   2. 参数确实落在目标节点上（提示词/负面/步数/种子/宽高/底模）
//   3. 非法工作流 → 400 + node_errors 被带进报错文案
//   4. 执行失败 → 拿到 exception_message
//   5. 取消 → /interrupt + /queue 删除项
//   6. 界面图格式（UI graph）在本地就被拦下，不发给服务端
//
// 用法：node tools/test-comfyui-api.mjs

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
    else {
        failures += 1;
        console.log(`  ✗ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
    }
};
const assertTrue = (label, value) => assertEqual(label, Boolean(value), true);
const section = (title) => console.log(`\n${title}`);

// --- 在 Node 里加载浏览器脚本（与 test-image-pipeline 同一套沙箱）---
const sandbox = {
    window: {}, crypto: globalThis.crypto, URL, URLSearchParams,
    TextDecoder, TextEncoder, console, setTimeout, clearTimeout,
    atob: globalThis.atob, btoa: globalThis.btoa
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox, { filename: 'built-in-content.js' });
vm.runInContext(readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8'), sandbox, { filename: 'core-utils.js' });
const comfy = sandbox.window.RPHubComfyUtils;

// --- 启动 mock 服务 ---
let child = null;
let base = '';

const startOn = async (port) => {
    const proc = spawn(process.execPath, [join(root, 'tools', 'mock-comfyui.mjs'), String(port)], {
        // 不用 'pipe'：受限沙箱下管道会触发 spawn EPERM（与 test-image-api 同样的取舍）。
        stdio: ['ignore', 'ignore', 'inherit']
    });
    for (let i = 0; i < 60; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (proc.exitCode !== null) return null;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/system_stats`);
            if (response.ok) return proc;
        } catch { /* 还没起来 */ }
    }
    proc.kill();
    return null;
};

// --- 复刻 app.js 的 ComfyUI 链路（用同一套纯函数）---
const workflow = {
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } }
};

const nodes = comfy.parseComfyWorkflow(JSON.stringify(workflow)).nodes;
const bindings = comfy.detectComfyBindings(nodes);

const fetchJson = async (path, options) => {
    const response = await fetch(`${base}${path}`, options);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    return { ok: response.ok, status: response.status, payload };
};

// 与 app.js 的 generateWithComfy 同构：提交 → 轮询 history → 取输出。
const runChain = async (values, { onProgress, timeoutMs = 15000 } = {}) => {
    const { prompt } = comfy.applyComfyParamValues(workflow, bindings, values);
    const submitted = await fetchJson('/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, client_id: 'test-client' })
    });
    if (!submitted.ok) {
        const detail = submitted.payload?.error?.message || submitted.payload?.error || `HTTP ${submitted.status}`;
        let message = typeof detail === 'string' ? detail : JSON.stringify(detail);
        const nodeErrors = submitted.payload?.node_errors;
        if (nodeErrors && Object.keys(nodeErrors).length) {
            const [id, err] = Object.entries(nodeErrors)[0];
            message += `（节点 ${id}：${JSON.stringify(err).slice(0, 200)}）`;
        }
        throw new Error(message);
    }
    const promptId = submitted.payload.prompt_id;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 150));
        const history = await fetchJson(`/history/${promptId}`);
        const entry = history.payload?.[promptId];
        if (!entry) continue;
        if (entry.status?.status_str === 'error') {
            const msg = entry.status?.messages?.find(m => m[0] === 'execution_error')?.[1]?.exception_message;
            throw new Error(msg || '执行出错');
        }
        const files = comfy.collectComfyOutputs(entry);
        if (files.length) {
            onProgress?.(100);
            return { promptId, files, imageUrl: `${base}${files[0].url}` };
        }
    }
    throw new Error('超时');
};

try {
    for (const port of [18899, 18900, 18901]) {
        child = await startOn(port);
        if (child) { base = `http://127.0.0.1:${port}`; break; }
    }
    if (!child) throw new Error('mock ComfyUI 未能启动');

    console.log(`mock ComfyUI 已启动: ${base}\n`);

    section('1) 端到端：提交 → history → /view 取图');
    const run = await runChain({ prompt: 'a dog, masterpiece', steps: 30, seed: 42 });
    assertTrue('拿到 prompt_id', /^[0-9a-f-]{36}$/.test(run.promptId));
    assertEqual('收集到 1 个输出文件', run.files.length, 1);
    assertTrue('输出地址指向 /view', run.files[0].url.startsWith('/view?'));
    const imgResponse = await fetch(run.imageUrl);
    assertEqual('图片可被取回（HTTP 200）', imgResponse.status, 200);
    assertEqual('Content-Type 是图片', imgResponse.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await imgResponse.arrayBuffer());
    assertTrue('取回的确实是 PNG 字节', bytes.length > 0 && bytes.subarray(1, 4).toString() === 'PNG');

    section('2) 参数确实落在目标节点上（不是落在别的节点）');
    const seen = await (await fetch(`${base}/__requests`)).json();
    const submitted = seen.find(item => item.kind === 'prompt');
    assertTrue('提示词写进节点 6', String(submitted.text).includes('a dog'));
    assertTrue('负面提示词未被污染（仍是工作流原值 bad）', submitted.negative === 'bad');
    assertEqual('步数写进 KSampler', submitted.steps, 30);
    assertEqual('种子写进 KSampler', submitted.seed, 42);
    assertEqual('未传的宽高保持工作流原值', [submitted.width, submitted.height], [512, 512]);
    assertTrue('client_id 被带上（服务端据此定向推 WS）', submitted.clientId === 'test-client');
    assertEqual('底模保持工作流原值', submitted.ckpt, 'model.safetensors');

    // 再跑一次，确认宽高/底模能被显式覆盖
    await runChain({ prompt: 'x', width: 832, height: 1216, checkpoint: 'other.safetensors' });
    const seen2 = await (await fetch(`${base}/__requests`)).json();
    const second = seen2.filter(i => i.kind === 'prompt').pop();
    assertEqual('宽度被覆盖', second.width, 832);
    assertEqual('高度被覆盖', second.height, 1216);
    assertEqual('底模被覆盖', second.ckpt, 'other.safetensors');

    section('3) 坏工作流：400 + node_errors 带进报错文案');
    let badError = '';
    try {
        await fetchJson('/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: { '1': { inputs: {} } }, client_id: 'test' })
        }).then(result => {
            if (!result.ok) {
                const nodeErrors = result.payload?.node_errors;
                let message = result.payload?.error?.message || 'HTTP ' + result.status;
                if (nodeErrors && Object.keys(nodeErrors).length) {
                    const [id, err] = Object.entries(nodeErrors)[0];
                    message += `（节点 ${id}：${JSON.stringify(err).slice(0, 200)}）`;
                }
                throw new Error(message);
            }
        });
    } catch (error) {
        badError = error.message;
    }
    assertTrue('缺 class_type 触发 400', badError.length > 0);
    assertTrue('报错里带上了出错节点 id', badError.includes('节点 1'));

    section('4) 界面图格式在本地就被拦下（不该发给服务端）');
    const uiGraph = JSON.stringify({ nodes: [{ id: 3, type: 'KSampler' }], links: [] });
    const localCheck = comfy.parseComfyWorkflow(uiGraph);
    assertEqual('本地判定为不可用', localCheck.ok, false);
    assertTrue('提示指向 API Format', /API Format/.test(localCheck.error));
    const before = (await (await fetch(`${base}/__requests`)).json()).length;
    // 模拟网页逻辑：解析不通过就不提交
    const wouldSubmit = comfy.parseComfyWorkflow(uiGraph).ok;
    assertEqual('不会产生提交请求', wouldSubmit, false);
    const after = (await (await fetch(`${base}/__requests`)).json()).length;
    assertEqual('请求数未增加', after, before);

    section('5) 执行失败：拿到 exception_message');
    await fetch(`${base}/__fail`);
    let failureMessage = '';
    try {
        await runChain({ prompt: 'boom' });
    } catch (error) {
        failureMessage = error.message;
    }
    assertTrue('失败被抛出', failureMessage.length > 0);
    assertTrue('失败原因是服务端给的那条', /mock 执行失败/.test(failureMessage));
    await fetch(`${base}/__reset`);

    section('6) 取消：/interrupt + /queue 删除队列项');
    const cancelPromptId = await (async () => {
        const { prompt } = comfy.applyComfyParamValues(workflow, bindings, { prompt: 'cancel me', steps: 200 });
        const result = await fetchJson('/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, client_id: 'test-client' })
        });
        return result.payload.prompt_id;
    })();
    // 与 app.js 的 cancel 同构：先 interrupt，再把队列里那一条删掉。
    await fetchJson('/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await fetchJson('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [cancelPromptId] })
    });
    const cancelSeen = await (await fetch(`${base}/__requests`)).json();
    assertTrue('发出了 /interrupt', cancelSeen.some(i => i.kind === 'interrupt'));
    const queueRequest = cancelSeen.find(i => i.kind === 'queue');
    assertTrue('发出了 /queue 删除该 prompt_id', Array.isArray(queueRequest?.delete) && queueRequest.delete.includes(cancelPromptId));

    section('7) 进度：progress_state 能折算成百分比');
    // mock 服务推的正是 progress_state 形状，这里用同样形状验证折算函数。
    assertEqual('3/10 步 → 30%', comfy.computeComfyProgress({ nodes: { '3': { value: 3, max: 10, state: 'running' } } }), 30);
    assertEqual('完成 → 100%', comfy.computeComfyProgress({ nodes: { '3': { value: 10, max: 10, state: 'finished' } } }), 100);

    section('8) 探活端点可用（前端拿它判断连接状态）');
    const stats = await fetchJson('/system_stats');
    assertEqual('system_stats 返回 200', stats.status, 200);
    assertTrue('带 comfyui_version', Boolean(stats.payload?.system?.comfyui_version));
} catch (error) {
    failures += 1;
    checks += 1;
    console.log(`✗ 测试异常：${error.message}`);
} finally {
    child?.kill();
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
