// 推理强度（reasoning_effort）透传回归。
//
// 背景（真实故障）：Gemini 经 CLIProxyAPI 的 OpenAI 兼容接口时，**不传 reasoning_effort**
// 会让 reasoning_content 恒为 null（思考 token 照扣，但思考文本不回传），
// 界面上就只剩工具调用过程、看不到思考；而 DeepSeek 那条自定义地址不传也会正常回传，
// 于是现象被误判成「模型的问题」。修复是在统一出口对 Gemini 缺省档补 medium。
//
// 本测试守住三件事：
//   ① 纯函数 resolveRequestReasoningEffort 的判定（Gemini 缺省补 medium；显式档位一律透传）
//   ② 请求体确实带上了 reasoning_effort（起一个假后端，读它收到的 JSON）
//   ③ 用户显式选的 none / low 不被改写（否则「关掉思考」这个功能会失效）
//
// 用法：node tools/test-reasoning-effort.mjs

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// --- 1. 纯函数：从真实的 core-utils.js 里取，不另抄一份 ---
const sandbox = {
    window: {}, console, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    fetch: () => { throw new Error('不该发请求'); }
};
sandbox.window.RPHubBuiltinContent = { imageStyleArtists: {}, activeTools: [], uiOptions: {} };
vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox, { filename: 'built-in-content.js' });
vm.runInContext(readFileSync(path.join(root, 'assets/js/core-utils.js'), 'utf8'), sandbox, { filename: 'core-utils.js' });

const { resolveRequestReasoningEffort } = sandbox.window.RPHubUtils;
assertTrue('core-utils 导出了 resolveRequestReasoningEffort', typeof resolveRequestReasoningEffort === 'function');

console.log('\n[1] Gemini 缺省档补 medium（故障的直接修复）');
assertEqual('gemini 不传 → medium', resolveRequestReasoningEffort('gemini-3.1-pro-low', ''), 'medium');
assertEqual('gemini 未定义 → medium', resolveRequestReasoningEffort('gemini-3.7-flash-high', undefined), 'medium');
assertEqual('Gemini 大写也认 → medium', resolveRequestReasoningEffort('GEMINI-3.8-flash-high', ''), 'medium');
assertEqual('gemini-3.1-flash-image → medium', resolveRequestReasoningEffort('gemini-3.1-flash-image', ''), 'medium');

console.log('\n[2] 非 Gemini 不干预（DeepSeek 那条地址本来就有思考）');
assertEqual('deepseek 不传 → 空（透传，不带该字段）', resolveRequestReasoningEffort('global:deepseek-v4.1-flash', ''), '');
assertEqual('claude 不传 → 空', resolveRequestReasoningEffort('claude-opus-4-6-thinking', ''), '');
assertEqual('gpt-oss 不传 → 空', resolveRequestReasoningEffort('gpt-oss-120b-medium', ''), '');
assertEqual('空模型名 → 空', resolveRequestReasoningEffort('', ''), '');

console.log('\n[3] 用户显式选的档位一律原样透传（「关闭思考」必须还能关）');
for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'max']) {
    assertEqual(`gemini 显式 ${value} → ${value}`, resolveRequestReasoningEffort('gemini-3.1-pro-low', value), value);
    assertEqual(`deepseek 显式 ${value} → ${value}`, resolveRequestReasoningEffort('deepseek-v4.1-flash', value), value);
}
assertEqual('显式 none 不会被补成 medium', resolveRequestReasoningEffort('gemini-3.1-pro-low', 'none'), 'none');
assertEqual('大小写归一 MAX → max', resolveRequestReasoningEffort('gemini-3.1-pro-low', 'MAX'), 'max');
assertEqual('带空格归一 → high', resolveRequestReasoningEffort('gemini-3.1-pro-low', ' high '), 'high');
assertEqual('非法值按缺省处理 → medium', resolveRequestReasoningEffort('gemini-3.1-pro-low', 'bogus'), 'medium');

// --- 2. 接线：统一出口真的把 reasoning_effort 放进请求体 ---
const received = [];
const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
        received.push(JSON.parse(raw || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            id: 'mock', object: 'chat.completion', model: 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
    });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const apiSandbox = {
    window: {}, console, TextDecoder, TextEncoder, setTimeout, clearTimeout, fetch,
    AbortController, URL, Response
};
apiSandbox.window.RPHubUtils = sandbox.window.RPHubUtils;
apiSandbox.window.RPHubCardUtils = { extractNativeReasoning: () => '', isNativeReasoningPart: () => false };
vm.createContext(apiSandbox);
vm.runInContext(readFileSync(path.join(root, 'assets/js/api-utils.js'), 'utf8'), apiSandbox, { filename: 'api-utils.js' });

const { requestChatCompletion } = apiSandbox.window.RPHubApiClient;
const { buildApiEndpoint } = apiSandbox.window.RPHubApiUtils;
const send = async (model, effort) => {
    const resolved = resolveRequestReasoningEffort(model, effort);
    await requestChatCompletion({
        url: buildApiEndpoint(`http://127.0.0.1:${port}/v1`, 'chat/completions'),
        apiKey: 'test', model, stream: false, messages: [{ role: 'user', content: 'hi' }],
        ...(resolved ? { reasoningEffort: resolved } : {})
    });
    return received[received.length - 1];
};

console.log('\n[4] 请求体接线（起假后端读真实 body）');
const geminiBody = await send('gemini-3.1-pro-low', '');
assertEqual('gemini 缺省：body.reasoning_effort = medium', geminiBody.reasoning_effort, 'medium');
const deepseekBody = await send('deepseek-v4.1-flash', '');
assertTrue('deepseek 缺省：body 不带 reasoning_effort', !Object.prototype.hasOwnProperty.call(deepseekBody, 'reasoning_effort'));
const offBody = await send('gemini-3.1-pro-low', 'none');
assertEqual('gemini 显式 none：body.reasoning_effort = none', offBody.reasoning_effort, 'none');
const highBody = await send('gemini-3.1-pro-low', 'high');
assertEqual('gemini 显式 high：body.reasoning_effort = high', highBody.reasoning_effort, 'high');

server.close();

console.log(`\n断言 ${checks} 条，失败 ${failures} 条`);
process.exit(failures ? 1 : 0);
