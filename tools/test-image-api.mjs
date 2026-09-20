// 生图归档接口的集成测试
//
// 起一个真实的同步服务（临时数据目录 + 临时端口），验证：
//   1. POST /v1/images      落盘并返回可直接使用的 url / apiUrl
//   2. GET  /v1/images/<day>/<file>  能把原图按字节取回（手机/电脑跨设备看图靠它）
//   3. 同图重复提交命中 hash 去重，不重复占空间
//   4. 目录穿越、非法文件名、索引文件一律拒绝，只能取到归档目录里的图片
//
// 用法：node tools/test-image-api.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2x2 红色 PNG
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ3wXh8AAAAASUVORK5CYII=';
const PNG = Buffer.from(PNG_BASE64, 'base64');

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

const dataDir = await mkdtemp(path.join(tmpdir(), 'rphub-image-api-'));
let child = null;
let base = '';
let lastError = '';

const startOn = async (port) => {
    const proc = spawn(process.execPath, [path.join(root, 'sync-server', 'server.js')], {
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
        // 不用 'pipe'：受限沙箱下管道会触发 spawn EPERM。
        // 服务日志本来也不需要，stderr 只在启动失败时想看，交给上层终端即可。
        stdio: ['ignore', 'ignore', 'inherit']
    });
    for (let i = 0; i < 50; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (proc.exitCode !== null) return null;
        try {
            const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
            if (response.ok) return proc;
        } catch { /* 还没起来 */ }
    }
    proc.kill();
    return null;
};

try {
    for (const port of [18712, 18713, 18714, 18715, 18716]) {
        child = await startOn(port);
        if (child) { base = `http://127.0.0.1:${port}`; break; }
        const running = await stat(dataDir).then(() => true, () => false);
        if (!running) break;
    }
    if (!child) throw new Error(`同步服务未能启动：${lastError || '未知原因'}`);

    console.log(`服务已启动: ${base}（数据目录 ${dataDir}）\n`);
    console.log('1) 归档一张图');
    const posted = await (await fetch(`${base}/v1/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: `data:image/png;base64,${PNG_BASE64}`, character: '测试', prompt: 'a cat', size: '2x2' })
    })).json();
    assertTrue('归档成功', posted.ok);
    assertEqual('首次提交不是去重命中', posted.deduplicated, false);
    assertTrue('返回了 file（images/<日期>/<hash>.png）', /^images\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\.png$/.test(posted.file || ''));
    assertTrue('返回了静态 url', /^\/images\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\.png$/.test(posted.url || ''));
    assertTrue('返回了 apiUrl（走同步服务本体）', /^\/api\/v1\/images\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\.png$/.test(posted.apiUrl || ''));
    assertEqual('字节数与上传一致', posted.bytes, PNG.length);
    // nginx 的 /images/ 是 alias 到 /data/images/，因此 url 必须正好等于 / + file 才能在静态路径命中。
    assertEqual('静态 url 与磁盘布局一致', posted.url, `/${posted.file}`);
    const onDisk = await stat(path.join(dataDir, posted.file)).then(item => item.size, () => -1);
    assertEqual('图片确实落在数据目录里', onDisk, PNG.length);

    console.log('\n2) 取回原图（前端跨设备看图就走这条路）');
    // 服务端本体挂的是 /v1/*；浏览器看到的是 nginx 那层的 /api/v1/*（见上面的 apiUrl）。
    const fetched = await fetch(`${base}/v1/${posted.file}`);
    assertEqual('HTTP 200', fetched.status, 200);
    assertEqual('Content-Type 正确', fetched.headers.get('content-type'), 'image/png');
    assertTrue('带长缓存头（文件名即内容 hash）', /max-age=604800/.test(fetched.headers.get('cache-control') || ''));
    const bytes = Buffer.from(await fetched.arrayBuffer());
    assertTrue('取回的字节与上传完全一致', bytes.equals(PNG));

    console.log('\n3) 同图重复提交');
    const again = await (await fetch(`${base}/v1/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: `data:image/png;base64,${PNG_BASE64}` })
    })).json();
    assertEqual('命中去重', again.deduplicated, true);
    assertEqual('file 不变', again.file, posted.file);
    const stats = await (await fetch(`${base}/v1/images`)).json();
    assertEqual('归档统计仍然只有 1 张', stats.count, 1);
    assertEqual('占用字节仍是一张图', stats.bytes, PNG.length);

    console.log('\n4) 非法路径必须被拒绝（目录穿越防护）');
    const day = posted.file.split('/')[1];
    const name = posted.file.split('/')[2];
    const blocked = [
        ['相对路径穿越', `/v1/images/${day}/../../../etc/passwd`],
        ['编码后的穿越', `/v1/images/${day}/..%2f..%2fstate.json`],
        ['日期不合法', '/v1/images/notaday/abcdef12.png'],
        ['文件名不是 hash', `/v1/images/${day}/index.json`],
        ['文件名带脚本后缀', `/v1/images/${day}/evil.sh`],
        ['不存在的 hash', `/v1/images/${day}/deadbeefdeadbeef.png`]
    ];
    for (const [label, url] of blocked) {
        const response = await fetch(`${base}${url}`);
        // 穿越类被 URL 规范化后可能落到 /v1/images/... 之外（404），也可能被校验拦下（400）
        assertTrue(`${label} → 拒绝（HTTP ${response.status}）`, response.status === 400 || response.status === 404);
        const text = await response.text();
        assertTrue(`${label} → 不返回文件内容`, !text.includes('root:') && !text.includes('"items"'));
    }

    console.log('\n5) 索引文件不可通过读图接口泄露');
    const indexResponse = await fetch(`${base}/v1/images/2026-01-01/index.json`);
    assertEqual('index.json 被拒', indexResponse.status, 400);
} catch (error) {
    failures += 1;
    checks += 1;
    console.log(`✗ 测试异常：${error.message}`);
} finally {
    child?.kill();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n结果: ${failures === 0 ? '通过' : '失败'} — ${checks - failures}/${checks} 项断言`);
process.exit(failures === 0 ? 0 : 1);
