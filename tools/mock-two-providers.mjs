// 假 LLM 后端 ×2：两个端口、模型清单与回复标记都不同，用来验证「模型绑定了哪条 API 地址，
// 请求就发到哪条地址」（阶段二十：槽位 / 记忆总结 / 向量 / 生图 Tag 工具的多地址路由）。
//
// 用法: node tools/mock-two-providers.mjs
//   8801 → 只有 mock-alpha-* 模型，回复带 [FROM-8801]
//   8802 → 只有 mock-beta-*  模型，回复带 [FROM-8802]
//
// 验证步骤（浏览器里）：
//   ① 设置 → API 连接与服务：两条自定义地址分别填 http://127.0.0.1:8801/v1 与 .../8802/v1（Key 随便填）
//   ② 点「刷新可用模型列表」：模型列表应同时出现两个地址的模型，且在弹窗里能看到每条模型属于哪条地址
//   ③ 给槽位 1 选 mock-alpha-chat（地址 A）、槽位 3 选 mock-beta-chat（地址 B），
//      界面的「API 提供商」停在地址 A，然后激活槽位 3 发一条消息
//   ④ 期望：回复是 [FROM-8802]（而不是地址 A 报错）；两个进程的日志里也能看出请求只到了 8802
//   ⑤ 记忆总结模型绑地址 B、向量模型绑地址 A 时，点「补录记忆」/ 增强模式召回，请求分别落到 8802 / 8801
import http from 'node:http';

const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const createProvider = (port, models, tag) => http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
    }
    if (/\/models$/.test(req.url || '')) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
            .end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model' })) }));
        return;
    }
    const body = await new Promise(resolve => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => resolve(raw));
    });
    if (/\/chat\/completions$/.test(req.url || '')) {
        let model = '';
        try { model = JSON.parse(body).model || ''; } catch { /* 请求体不是为了校验，解析失败就当没给模型 */ }
        console.log(`[mock-${port}] chat model=${model}`);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
            .end(JSON.stringify({
                id: 'mock',
                object: 'chat.completion',
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: `${tag} model=${model}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            }));
        return;
    }
    if (/\/embeddings$/.test(req.url || '')) {
        console.log(`[mock-${port}] embeddings`);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
            .end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
        return;
    }
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
});

createProvider(8801, ['mock-alpha-chat', 'mock-alpha-fast', 'mock-alpha-embedding'], '[FROM-8801]')
    .listen(8801, '127.0.0.1', () => console.log('假地址 A: http://127.0.0.1:8801/v1'));
createProvider(8802, ['mock-beta-chat', 'mock-beta-small'], '[FROM-8802]')
    .listen(8802, '127.0.0.1', () => console.log('假地址 B: http://127.0.0.1:8802/v1'));
