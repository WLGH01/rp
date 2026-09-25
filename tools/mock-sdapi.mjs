#!/usr/bin/env node
// 假的 sdapi（Forge / A1111）服务，仅用于本地验证 RP-Hub 的生图链路。
//
// 作用：
//   - 记录每一次 /sdapi/v1/txt2img 收到的请求体，方便断言「客户端到底发了什么分辨率」
//   - 回一张固定的 base64 PNG，使前端能走完「收图 → 渲染 → 归档」全流程
//   - 带上 CORS 头，模拟 RP-Hub 的 /sd/ 反代（直连时 Forge 默认不允许跨域）
//
// 用法: node tools/mock-sdapi.mjs [port]     默认 8898
// 查看收到的请求: curl http://127.0.0.1:8898/__requests

import http from 'node:http';

const port = Number(process.argv[2]) || 8898;
// 人为延迟（毫秒）：用来复现「生成还没回来时设置变了、同一条消息被渲染成第二个 URL」
// 这类竞态。默认 0，不影响其它测试。
const DELAY_MS = Math.max(0, Number(process.env.MOCK_SD_DELAY_MS) || 0);
// 2x2 红色 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ3wXh8AAAAASUVORK5CYII=';

const requests = [];

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

http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'OPTIONS') {
        response.writeHead(204, cors);
        response.end();
        return;
    }
    if (url.pathname === '/__requests') {
        json(response, 200, requests);
        return;
    }
    if (url.pathname === '/__reset') {
        requests.length = 0;
        json(response, 200, { ok: true });
        return;
    }
    if (url.pathname === '/sdapi/v1/txt2img' && request.method === 'POST') {
        const raw = await readBody(request);
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch { /* 原样记录 */ }
        requests.push({
            at: new Date().toISOString(),
            width: payload.width,
            height: payload.height,
            steps: payload.steps,
            sampler: payload.sampler_name,
            // VAE 走 override_settings.sd_vae；不下发时这里是 undefined，
            // 正好用来断言「默认不使用 VAE 时请求体里没有这个键」。
            vae: payload.override_settings?.sd_vae,
            model: payload.override_settings?.sd_model_checkpoint,
            // Forge 专属：架构档位与附加模块（VAE + text_encoder 整份替换）。
            preset: payload.override_settings?.forge_preset,
            modules: payload.override_settings?.forge_additional_modules,
            // Shift / Distilled CFG 是 sdapi 的顶层字段。
            dcfg: payload.distilled_cfg_scale,
            restore: payload.override_settings_restore_afterwards,
            prompt: String(payload.prompt || '').slice(0, 200)
        });
        console.log(`txt2img ← ${payload.width}x${payload.height} sampler=${payload.sampler_name} steps=${payload.steps} vae=${payload.override_settings?.sd_vae ?? '(未指定)'} preset=${payload.override_settings?.forge_preset ?? '(未指定)'} modules=${payload.override_settings?.forge_additional_modules?.length ?? 0} dcfg=${payload.distilled_cfg_scale ?? '(未指定)'}`);
        if (DELAY_MS) await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        json(response, 200, { images: [PNG], info: 'mock sdapi' });
        return;
    }
    if (url.pathname === '/sdapi/v1/sd-models') {
        json(response, 200, [{ title: 'mock-model.safetensors [abc123]', model_name: 'mock-model' }]);
        return;
    }
    if (url.pathname === '/sdapi/v1/sd-vae') {
        // 标准 A1111 端点：value 用名称。
        // 设 MOCK_SD_MODE=forge 时故意 404，模拟 Forge neo（它没有这个端点）。
        if (process.env.MOCK_SD_MODE === 'forge') {
            json(response, 404, { detail: 'Not Found' });
            return;
        }
        json(response, 200, [
            { model_name: 'vae-ft-mse-840000-ema-pruned', filename: '/models/VAE/vae-ft-mse-840000-ema-pruned.safetensors' },
            { model_name: 'sdxl_vae', filename: '/models/VAE/sdxl_vae.safetensors' },
            // 只有 filename 的条目：验证 normalizeSdVaeEntry 能从路径兜出名字。
            { filename: '/models/VAE/kl-f8-anime2.ckpt' }
        ]);
        return;
    }
    if (url.pathname === '/sdapi/v1/sd-modules') {
        // Forge neo 的 VAE 列表：把 VAE 与 text_encoder 混在一起返回，
        // 且 value 需要绝对路径（这里用 Windows 风格路径，贴近真实 Forge）。
        json(response, 200, [
            { model_name: 'qwen_3_06b_base.safetensors', filename: 'D:\\Stable-diffusion\\sd-webui\\models\\text_encoder\\qwen_3_06b_base.safetensors' },
            { model_name: 'qwenimagevae_v7.safetensors', filename: 'D:\\Stable-diffusion\\sd-webui\\models\\VAE\\qwenimagevae_v7.safetensors' },
            { model_name: 'vae-ft-mse-840000-ema-pruned.safetensors', filename: 'D:\\Stable-diffusion\\sd-webui\\models\\VAE\\vae-ft-mse-840000-ema-pruned.safetensors' }
        ]);
        return;
    }
    if (url.pathname === '/sdapi/v1/options') {
        // Forge 的 /sdapi/v1/options：本站从中读两件事
        //   1) 有哪些 UI Preset（判据是 <arch>_t2i_sampler 键是否存在）
        //   2) 每个档位在服务端存好的底模与 VAE/TE（forge_checkpoint_<arch> / forge_additional_modules_<arch>）
        // 这里只保留必要键，模拟一台「SDXL 与 Anima 都配好了」的 Forge。
        json(response, 200, {
            forge_preset: 'xl',
            sd_model_checkpoint: 'sdxl_base.safetensors',
            forge_additional_modules: [],
            sd_vae: 'Automatic',
            xl_t2i_sampler: 'Euler a',
            anima_t2i_sampler: 'ER SDE',
            sd_t2i_sampler: 'Euler a',
            qwen_t2i_sampler: 'LCM',
            // qwen 在 Forge 里没有 dcfg 滑杆（core-utils 的 sdPresetExtras 里也没有它）
            // → 用来验证「该架构不显示 Shift/Distilled CFG」。
            forge_checkpoint_xl: 'sdxl_base.safetensors',
            forge_additional_modules_xl: [],
            forge_checkpoint_anima: 'anima-base-v1.0.safetensors',
            forge_additional_modules_anima: [
                'D:\\Stable-diffusion\\sd-webui\\models\\VAE\\qwenimagevae_v7.safetensors',
                'D:\\Stable-diffusion\\sd-webui\\models\\text_encoder\\qwen_3_06b_base.safetensors'
            ],
            forge_checkpoint_qwen: '',
            forge_additional_modules_qwen: []
        });
        return;
    }
    if (url.pathname === '/sdapi/v1/samplers') {
        json(response, 200, [{ name: 'DPM++ 2M SDE Karras' }]);
        return;
    }
    if (url.pathname === '/sdapi/v1/schedulers') {
        json(response, 200, [{ name: 'Karras', label: 'Karras' }]);
        return;
    }
    if (url.pathname === '/sdapi/v1/progress' || url.pathname === '/internal/ping') {
        json(response, 200, { progress: 0, state: {} });
        return;
    }
    // NovelAI 协议：内容接口（用于验证「切换生图地址后历史图仍指向原地址」）。
    if (request.method === 'GET' && /^\/api\/jobs\/[^/]+\/content$/.test(url.pathname)) {
        requests.push({ at: new Date().toISOString(), kind: 'job-content', jobId: url.pathname.split('/')[3], token: url.searchParams.get('token') || '' });
        console.log(`job content ← ${url.pathname} token=${url.searchParams.get('token') || ''}`);
        response.writeHead(200, { 'Content-Type': 'image/png', ...cors });
        response.end(Buffer.from(PNG, 'base64'));
        return;
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
        const raw = await readBody(request);
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
        requests.push({ at: new Date().toISOString(), kind: 'job-create', tag: payload.tag });
        json(response, 200, { id: 'job-mock-1', status: 'done', imageUrl: '/api/jobs/job-mock-1/content' });
        return;
    }
    json(response, 404, { detail: 'Not Found' });
}).listen(port, '127.0.0.1', () => {
    console.log(`mock sdapi listening on http://127.0.0.1:${port}`);
});
