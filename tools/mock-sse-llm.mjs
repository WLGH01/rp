// 假 LLM 后端：按 SSE 逐片吐字，片间留出明显间隔。
//
// 用途：判断「没有流式输出」到底是 App 的问题还是环境的问题。
//   ① 把「设置 → API 连接与服务 → 接口地址」指到 http://127.0.0.1:8801/v1（Key 随便填）
//   ② 发一条消息：如果文字是**一段段冒出来**的，说明 App 的流式链路正常，
//      问题在真实网关/反代（最常见是 nginx 没关 proxy_buffering，或网关自己攒包）；
//      如果整段**一次性出现**，那才需要往 App 侧查。
//   ③ 也可以完全绕开界面，用 curl 直接看它是不是逐片到达：
//      curl -N -X POST http://127.0.0.1:8801/v1/chat/completions -d '{"stream":true}'
//
// 用法: node tools/mock-sse-llm.mjs [port]    默认 8801
import http from 'node:http';

const port = Number(process.argv[2]) || 8801;

// 刻意重复到 40+ 片、每片 200ms：整段约 9 秒，采样出来的增长曲线不会有歧义。
const SENTENCE = '她抬起头看了你一眼，把杯子往桌上轻轻一放，说：“哟，人都齐了吧。”'
    + '说完也不等谁接话，自己先抿了一口，环视一圈，目光在每个人脸上都停了一瞬。';
const TEXT = SENTENCE.repeat(4);
const CHUNK_MS = 200;

const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600'
};

http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
    }
    if (!/\/chat\/completions$/.test(req.url || '')) {
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: 'not found' }));
        return;
    }

    // 读完请求体（不看内容，只为让 POST 正常结束）。
    await new Promise(resolve => {
        req.on('data', () => {});
        req.on('end', resolve);
    });

    console.log(`[mock-sse] ${req.method} ${req.url}`);
    res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // 反代若真做了缓冲，这个头能让它别攒包（nginx 认它）。
        'X-Accel-Buffering': 'no'
    });

    const chunks = TEXT.match(/.{1,6}/gs) || [];
    const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    for (const chunk of chunks) {
        send({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
        await new Promise(r => setTimeout(r, CHUNK_MS));
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
    console.log('[mock-sse] done');
}).listen(port, '127.0.0.1', () => {
    const pieces = (TEXT.match(/.{1,6}/gs) || []).length;
    console.log(`假 SSE 后端已启动: http://127.0.0.1:${port}/v1`);
    console.log(`（${TEXT.length} 字 / ${pieces} 片 × ${CHUNK_MS}ms ≈ ${(pieces * CHUNK_MS / 1000).toFixed(1)} 秒吐完）`);
});
