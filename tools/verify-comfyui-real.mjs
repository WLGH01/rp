// 对「真实」ComfyUI 跑一次端到端验证（不是 mock）。
//
// 目的：确认我们对着 server.py 推断的协议在真机上成立 —— 尤其是
//   POST /prompt → WS progress_state → GET /history/{id} → GET /view 这条链路，
//   以及「参数是否真的改到了目标节点上」。
//
// 它会真的占用一次 GPU 出图（步数压到 6 步以减少耗时），并可能留下一个输出文件。
//
// 用法：node tools/verify-comfyui-real.mjs [baseUrl] [--yes]
//   默认 baseUrl = http://127.0.0.1:8188
//   不加 --yes 时只做只读探测（列出模型/采样器），不出图。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const base = (args.find(a => a.startsWith('http')) || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const doGenerate = args.includes('--yes');

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

// --- 加载纯函数 ---
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

const fetchJson = async (path, options) => {
    const response = await fetch(`${base}${path}`, options);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    return { ok: response.ok, status: response.status, payload };
};

try {
    section('1) 探活与能力发现（只读）');
    const stats = await fetchJson('/system_stats');
    assertEqual('system_stats 200', stats.status, 200);
    const version = stats.payload?.system?.comfyui_version;
    const device = stats.payload?.devices?.[0]?.name;
    console.log(`      ComfyUI ${version} / ${device}`);
    assertTrue('拿到版本号', Boolean(version));

    const ckptInfo = await fetchJson('/object_info/CheckpointLoaderSimple');
    const ckpts = ckptInfo.payload?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    assertTrue('能列出底模', ckpts.length > 0);
    console.log(`      可用底模 ${ckpts.length} 个，例如：${ckpts[0]}`);

    const samplerInfo = await fetchJson('/object_info/KSampler');
    const samplers = samplerInfo.payload?.KSampler?.input?.required?.sampler_name?.[0] || [];
    assertTrue('能列出采样器', samplers.length > 0);
    // 这条是「对下拉选项提取」真实数据的验证（不是造的数据）
    const options = comfy.pickComfyComboOptions(samplerInfo.payload, 'KSampler', 'sampler_name');
    assertEqual('采样器被转成下拉选项（数量一致）', options.length, samplers.length);
    assertEqual('首项与真实列表一致', options[0].value, samplers[0]);

    if (!doGenerate) {
        console.log('\n（未加 --yes，跳过真实出图。加 --yes 可跑一次 6 步的真实生图）');
    } else {
        section('2) 真实工作流：提交 → 轮询 → /view 取图');
        // 用真实存在的底模/采样器搭一份最小工作流（就是 ComfyUI 默认 txt2img 的骨架）。
        const workflow = {
            '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 6, cfg: 7, sampler_name: samplers[0], scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
            '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpts[0] } },
            '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
            '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat, masterpiece', clip: ['4', 1] } },
            '7': { class_type: 'CLIPTextEncode', inputs: { text: 'bad quality, blurry', clip: ['4', 1] } },
            '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
            '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'RPHubVerify' } }
        };
        const nodes = comfy.parseComfyWorkflow(JSON.stringify(workflow)).nodes;
        const bindings = comfy.detectComfyBindings(nodes);
        assertEqual('自动绑定到真实工作流：正向=节点6', bindings.prompt, { nodeId: '6', input: 'text' });
        assertEqual('自动绑定：负向=节点7', bindings.negativePrompt, { nodeId: '7', input: 'text' });

        // 走与 app.js 相同的改写 → 提交路径
        const { prompt, applied } = comfy.applyComfyParamValues(workflow, bindings, {
            prompt: 'a red fox, masterpiece',
            negativePrompt: 'lowres, bad anatomy',
            steps: 6,
            seed: 12345,
            filenamePrefix: 'RPHubVerify'
        });
        assertEqual('改写项数正确', applied.length, 5);

        const submitted = await fetchJson('/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, client_id: 'rphub-verify' })
        });
        if (!submitted.ok) {
            const nodeErrors = submitted.payload?.node_errors;
            throw new Error(`提交被拒：${submitted.payload?.error?.message || submitted.status} ${JSON.stringify(nodeErrors || {}).slice(0, 400)}`);
        }
        const promptId = submitted.payload.prompt_id;
        assertTrue('提交成功并拿到 prompt_id', Boolean(promptId));

        const wsMessages = [];
        let wsOpened = false;
        try {
            const wsUrl = `${base.replace(/^http/, 'ws')}/ws?clientId=rphub-verify`;
            const socket = new WebSocket(wsUrl);
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 3000);
                socket.onopen = () => { wsOpened = true; clearTimeout(timer); resolve(); };
                socket.onerror = () => { clearTimeout(timer); resolve(); };
            });
            socket.onmessage = (event) => { if (typeof event.data === 'string') wsMessages.push(event.data); };
            // 等执行结束
            const startedAt = Date.now();
            let entry = null;
            while (Date.now() - startedAt < 300000) {
                await new Promise(r => setTimeout(r, 1000));
                const history = await fetchJson(`/history/${promptId}`);
                entry = history.payload?.[promptId];
                if (entry?.status?.status_str === 'error') {
                    const info = entry.status.messages?.find(m => m[0] === 'execution_error')?.[1];
                    throw new Error(`执行失败：${info?.exception_message || '未知'}`);
                }
                if (entry && comfy.collectComfyOutputs(entry).length) break;
            }
            socket.close();
            assertTrue('WebSocket 能连上', wsOpened);
            const sawProgress = wsMessages.some(m => m.includes('progress_state'));
            const sawExecuting = wsMessages.some(m => m.includes('executing'));
            console.log(`      收到 WS 消息 ${wsMessages.length} 条（progress_state=${sawProgress}, executing=${sawExecuting}）`);
            assertTrue('收到过 progress_state 事件（进度条的数据源）', sawProgress);

            assertTrue('history 里有 outputs', Boolean(entry));
            const files = comfy.collectComfyOutputs(entry);
            assertTrue('收集到输出文件', files.length > 0);
            console.log(`      输出：${files[0].filename}`);
            assertTrue('文件名前缀是设置值', files[0].filename.startsWith('RPHubVerify'));

            // 取图（真机 /view）
            const viewUrl = `${base}${files[0].url}`;
            const imgResponse = await fetch(viewUrl);
            assertEqual('/view 返回 200', imgResponse.status, 200);
            const bytes = Buffer.from(await imgResponse.arrayBuffer());
            assertTrue('/view 返回了真实图片字节', bytes.length > 1000);
            assertEqual('是 PNG（前 8 字节 magic）', bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
            console.log(`      图片 ${(bytes.length / 1024).toFixed(0)} KB`);
        } catch (error) {
            if (typeof socket !== 'undefined' && socket) { try { socket.close(); } catch { /* 忽略 */ } }
            throw error;
        }
    }
} catch (error) {
    failures += 1;
    checks += 1;
    console.log(`✗ 异常：${error.message}`);
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
