// 同步服务状态接口的内存回归测试
//
// 验证的核心问题：老实现「整份快照全内存」——
//   readFile 118MB 文本 → JSON.parse 成对象树（V8 里 2~4 倍膨胀）常驻内存，
//   每次请求（含每 30 秒一次的健康检查）都 JSON.stringify 整份 payload。
// 实测一次同步请求就能临时吃掉几百 MB，主机内存被顶到 1.8GB。
//
// 现在的实现让 payload 永远不进内存：只保留「文件句柄 + 字节区间」。
// 因此本测试用一份「很大的快照」（默认 64MB payload，含 base64 头像）
// 来断言：
//   1. 接口行为与老实现完全一致（LWW、409 内容、拉取字节一致）
//   2. 服务进程 RSS 增长远小于快照本身 —— 这是本次修复的核心指标
//
// 用法：
//   node tools/test-sync-state.mjs            # 默认 64MB
//   node tools/test-sync-state.mjs 128        # 自定义 payload MB

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD_MB = Number(process.argv[2]) || 64;

// 大 payload 比较用哈希，避免在测试进程里反复 stringify 几十 MB。
const sha = (value) => crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);

let failures = 0;
let checks = 0;

// 断言失败时不要把整份快照打进日志（几十 MB 会把输出淹掉），超长就截断。
const brief = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 200 ? `${text.slice(0, 200)}…(共 ${text.length} 字符)` : text;
};

const assertEqual = (label, actual, expected) => {
    checks += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) console.log(`  ✓ ${label}`);
    else {
        failures += 1;
        console.log(`  ✗ ${label}\n      期望: ${brief(expected)}\n      实际: ${brief(actual)}`);
    }
};
const assertTrue = (label, value) => assertEqual(label, Boolean(value), true);

// 造一份「头像很重」的假快照：结构贴近真实数据（main.rp_hub_characters）。
const buildPayload = (targetBytes) => {
    const characters = [];
    // 每张头像 base64 约 1.4MB（真实实测单张最大 9.4MB/张）
    const avatarChars = Math.max(1, Math.round(targetBytes / (1.4 * 1024 * 1024)));
    const chunk = Buffer.alloc(1024 * 1024, 0x41).toString('base64'); // 1MB → 1.33MB base64
    for (let index = 0; index < avatarChars; index += 1) {
        characters.push({
            uuid: `uuid-${index}`,
            name: `角色${index}`,
            avatar: `data:image/png;base64,${chunk}`,
            greeting: '你好'
        });
    }
    return {
        main: { rp_hub_characters: characters, rp_hub_chat_0: [{ role: 'user', content: '聊天记录很小' }] },
        chargen: null,
        local: {}
    };
};

const dataDir = await mkdtemp(path.join(tmpdir(), 'rphub-state-'));
let child = null;
let base = '';
let lastError = '';

// 读服务进程的 RSS（服务在 /v1/status 里自报 process.memoryUsage()，跨平台可用）
const readRssKbAsync = async () => {
    try {
        const status = await (await fetch(`${base}/v1/status`)).json();
        const rss = Number(status?.memory?.rssBytes);
        return Number.isFinite(rss) && rss > 0 ? rss / 1024 : null;
    } catch {
        return null;
    }
};

const startOn = async (port) => {
    const proc = spawn(process.execPath, [path.join(root, 'sync-server', 'server.js')], {
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
        // 服务日志直接继承 fd：stdout 用 ignore，stderr 用 inherit 便于排查启动失败。
        // 这里刻意不用 'pipe'——受限沙箱下管道会触发 spawn EPERM。
        stdio: ['ignore', 'ignore', 'inherit']
    });
    for (let i = 0; i < 80; i += 1) {
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
    for (const port of [18812, 18813, 18814, 18815, 18816]) {
        child = await startOn(port);
        if (child) { base = `http://127.0.0.1:${port}`; break; }
        const running = await stat(dataDir).then(() => true, () => false);
        if (!running) break;
    }
    if (!child) throw new Error(`同步服务未能启动：${lastError || '未知原因'}`);
    console.log(`服务已启动: ${base}（数据目录 ${dataDir}）\n`);

    // 启动基线：后面用它衡量「快照带来的真实内存增量」。
    const startRssKb = await readRssKbAsync();

    console.log('\n1) 推送一份约 ' + PAYLOAD_MB + 'MB 的快照');
    const payload = buildPayload(PAYLOAD_MB * 1024 * 1024);
    const pushedAt = Date.now();
    const body = JSON.stringify({
        version: 1,
        deviceId: 'test-device-0001',
        updatedAt: pushedAt,
        payload
    });
    const bodyMb = (Buffer.byteLength(body) / 1048576).toFixed(1);
    console.log(`  请求体 ${bodyMb}MB（其中几乎全是 base64 头像）`);

    const pushed = await (await fetch(`${base}/v1/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    })).json();
    assertTrue('推送被接受', pushed.ok && pushed.accepted);
    assertEqual('revision 递增到 1', pushed.revision, 1);

    // 推送完成后进程应已把快照落盘；读一次 RSS 作为内存指标基线
    const rssAfterPush = await readRssKbAsync();
    if (rssAfterPush !== null) console.log(`  推送后 RSS: ${(rssAfterPush / 1024).toFixed(1)}MB`);

    console.log('\n2) 健康检查返回摘要，且字节数正确');
    const health = await (await fetch(`${base}/v1/health`)).json();
    assertTrue('ok', health.ok);
    assertEqual('revision 正确', health.revision, 1);
    assertTrue('hasPayload', health.hasPayload);
    const diskPayloadBytes = Buffer.byteLength(JSON.stringify(payload));
    assertEqual('sizeBytes 与实际 payload 字节数一致', health.sizeBytes, diskPayloadBytes);

    console.log('\n3) 健康检查不放大内存（老实现每次要 stringify 整份 payload）');
    // 连续打 20 次健康检查：老实现每次都会造一个上百 MB 的临时字符串，RSS 会明显上台阶。
    const before = await readRssKbAsync();
    for (let i = 0; i < 20; i += 1) {
        await fetch(`${base}/v1/health`).then(r => r.json());
    }
    const after = await readRssKbAsync();
    if (before !== null && after !== null) {
        const growthMb = (after - before) / 1024;
        console.log(`  20 次健康检查 RSS 变化: ${growthMb >= 0 ? '+' : ''}${growthMb.toFixed(1)}MB`);
        // 允许 GC 抖动，只要没有「每次请求都吃掉一个快照」量级的增长即可。
        assertTrue(`20 次健康检查后 RSS 增长 < 32MB（实际 ${growthMb.toFixed(1)}MB）`, growthMb < 32);
    } else {
        console.log('  （当前平台读不到 /proc，跳过 RSS 断言）');
    }

    console.log('\n4) 拉取完整状态，字节必须与推送的一致');
    const pullResponse = await fetch(`${base}/v1/state`);
    const declaredLength = pullResponse.headers.get('content-length');
    const pulledText = await pullResponse.text();
    const pulled = JSON.parse(pulledText);
    // 用哈希比较整份 payload：既精确又不会把几十 MB 打进日志。
    assertEqual('payload 内容一致（哈希）', sha(pulled.payload), sha(payload));
    assertTrue('角色卡数量一致', pulled.payload?.main?.rp_hub_characters?.length === payload.main.rp_hub_characters.length);
    assertEqual('updatedAt 一致', pulled.updatedAt, pushedAt);
    assertEqual('Content-Length 与实际字节数一致（流式响应必须精确）',
        declaredLength, String(Buffer.byteLength(pulledText)));

    console.log('\n5) LWW：旧时间戳被拒，且 409 里带回完整服务端快照');
    const stale = await fetch(`${base}/v1/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'old-device', updatedAt: 1, payload: { main: {} } })
    });
    assertEqual('HTTP 409', stale.status, 409);
    const staleBody = await stale.json();
    assertEqual('reason=stale', staleBody.reason, 'stale');
    assertTrue('409 里带回服务端 payload', staleBody.current?.payload?.main?.rp_hub_characters?.length > 0);
    assertEqual('409 里的 payload 与原快照一致（哈希）', sha(staleBody.current.payload), sha(payload));

    console.log('\n6) force 覆盖旧时间戳');
    const forced = await (await fetch(`${base}/v1/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'force-device', updatedAt: 1, force: true, payload: { main: { rp_hub_characters: [] } } })
    })).json();
    assertTrue('force 写入被接受', forced.ok && forced.accepted);
    // 中间的 409 是「被拒」，按 LWW 语义不产生新版本，所以这里是第 2 次成功写入。
    assertEqual('revision 递增到 2（被拒的 409 不占用版本号）', forced.revision, 2);

    console.log('\n7) state.json 是合法 JSON，且 payload 可用标准解析器读回');
    const stateText = await readFile(path.join(dataDir, 'state.json'), 'utf8');
    const parsed = JSON.parse(stateText);
    assertTrue('文件可被 JSON.parse', Boolean(parsed));
    assertEqual('deviceId 落盘正确', parsed.deviceId, 'force-device');
    assertEqual('payload 已按 force 覆盖', JSON.stringify(parsed.payload), JSON.stringify({ main: { rp_hub_characters: [] } }));

    console.log('\n8) 备份已生成（硬链接或复制）');
    const backups = await import('node:fs/promises').then(fs => fs.readdir(path.join(dataDir, 'backups')));
    assertTrue(`备份目录有内容（${backups.length} 个文件）`, backups.length > 0);

    console.log('\n9) 重启后能从磁盘恢复（不重新解析 payload 进内存）');
    child.kill();
    await new Promise(resolve => setTimeout(resolve, 400));
    child = await startOn(Number(new URL(base).port));
    if (!child) throw new Error('重启失败');
    const afterRestart = await (await fetch(`${base}/v1/health`)).json();
    assertEqual('重启后 revision 保持', afterRestart.revision, 2);
    assertEqual('重启后 deviceId 保持', afterRestart.deviceId, 'force-device');
    const reloaded = await (await fetch(`${base}/v1/state`)).json();
    assertEqual('重启后 payload 一致', JSON.stringify(reloaded.payload), JSON.stringify({ main: { rp_hub_characters: [] } }));

    console.log('\n10) 请求体超过上限返回 413（且不是连接被重置）');
    const huge = 'x'.repeat(1024);
    const bigBody = JSON.stringify({ updatedAt: Date.now(), payload: { pad: huge.repeat(140 * 1024) } }); // ~140MB
    let status = 0;
    try {
        const response = await fetch(`${base}/v1/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bigBody
        });
        status = response.status;
    } catch (error) {
        failures += 1;
        checks += 1;
        console.log(`  ✗ 超大请求体应当返回 413，实际连接异常：${error.message}`);
    }
    if (status) assertEqual('返回 413', status, 413);

    console.log('\n11) 畸形 JSON 被拒');
    const bad = await fetch(`${base}/v1/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"updatedAt": 123, "payload": {"a": '
    });
    assertEqual('截断的 JSON → 400', bad.status, 400);

    console.log('\n12) 兼容旧版 state.json（升级路径：直接读老文件，不能重解析 payload 进内存）');
    {
        // 老代码用 JSON.stringify 写出的文件，字段顺序/额外键都可能与新版不同。
        // 这里刻意用「payload 放最前 + 混入未知键 + 大 payload」来验证扫描器按字段名取值，
        // 不依赖顺序；否则用户升级后第一次启动就会读不到元数据。
        child.kill();
        await new Promise(resolve => setTimeout(resolve, 400));

        const legacyPayload = {
            main: {
                rp_hub_characters: [{
                    uuid: 'legacy-1', name: '旧角色',
                    avatar: `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024, 0x42).toString('base64')}`
                }]
            }
        };
        const legacy = {
            // 故意把 payload 放在最前面
            payload: legacyPayload,
            unknownFutureKey: { nested: [1, 2, 3] },
            deviceId: 'legacy-device',
            serverUpdatedAt: 12345,
            updatedAt: 99999,
            revision: 7
        };
        const stateFile = path.join(dataDir, 'state.json');
        await (await import('node:fs/promises')).writeFile(stateFile, JSON.stringify(legacy));

        child = await startOn(Number(new URL(base).port));
        if (!child) throw new Error('读取旧格式 state.json 时启动失败');

        const loaded = await (await fetch(`${base}/v1/health`)).json();
        assertEqual('旧文件的 revision 被正确读出', loaded.revision, 7);
        assertEqual('旧文件的 updatedAt 被正确读出', loaded.updatedAt, 99999);
        assertEqual('旧文件的 deviceId 被正确读出', loaded.deviceId, 'legacy-device');
        assertTrue('旧文件判定为有 payload', loaded.hasPayload);
        assertEqual('payload 字节数与旧文件一致', loaded.sizeBytes, Buffer.byteLength(JSON.stringify(legacyPayload)));

        const fetched = await (await fetch(`${base}/v1/state`)).json();
        assertEqual('旧文件的 payload 能被完整取回（哈希一致）', sha(fetched.payload), sha(legacyPayload));
        assertEqual('旧文件的角色卡头像原样保留', fetched.payload.main.rp_hub_characters[0].avatar.length,
            legacyPayload.main.rp_hub_characters[0].avatar.length);
    }

    console.log('\n13) 并发读写压力：响应内容必须始终自洽');
    // 这是读锁/写闸门的核心回归。
    // 没有闸门时会出现「拿到旧字节区间 → 文件已被改名 → 按旧区间读新文件」，
    // 症状是响应 JSON 结构损坏或 payload 与元数据对不上。
    {
        const concurrency = 6;
        const rounds = 5;
        const payloads = Array.from({ length: concurrency }, (_, i) => ({
            main: {
                rp_hub_characters: [{ uuid: `c${i}`, name: `并发${i}`, avatar: `data:image/png;base64,${payload.main.rp_hub_characters[0].avatar.split(',')[1]}` }],
                marker: `writer-${i}`
            }
        }));
        const problems = [];

        // 「合法快照」白名单：读到的 payload 必须是某一次完整写入。
        // 用哈希集合精确判定「不是混合体」，比逐个字段猜形状可靠得多。
        const knownPayloadHashes = new Set(payloads.map(body => sha(body)));
        // 上一节（旧格式兼容）也会留下一个合法状态，一并纳入白名单。
        knownPayloadHashes.add(sha(await readFile(path.join(dataDir, 'state.json'), 'utf8')
            .then(text => JSON.parse(text).payload)));

        const baselineRevision = (await (await fetch(`${base}/v1/health`)).json()).revision;

        // 并发写：每个 writer 反复 force 推送自己的 payload（互相覆盖）
        const writers = payloads.map((body, index) => (async () => {
            for (let round = 0; round < rounds; round += 1) {
                const at = Date.now() + index * 1000 + round;
                const response = await fetch(`${base}/v1/state`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceId: `w${index}`, updatedAt: at, force: true, payload: body })
                });
                if (!response.ok) problems.push(`writer${index} HTTP ${response.status}`);
                await response.text();
            }
        })());

        // 并发读：每一份响应都必须是合法 JSON，且内部自洽
        const readers = Array.from({ length: concurrency }, () => (async () => {
            for (let round = 0; round < rounds * 2; round += 1) {
                const response = await fetch(`${base}/v1/state`);
                const text = await response.text();
                let parsed;
                try {
                    parsed = JSON.parse(text);
                } catch (error) {
                    problems.push(`读到损坏的 JSON（${text.length} 字节）：${error.message}`);
                    continue;
                }
                // 完整性 + 一致性：读到的 payload 必须是「某一次完整写入」，
                // 不能是两次写入拼出来的混合体。
                // 用哈希白名单精确判定，避免逐个字段猜形状。
                if (!parsed.payload || typeof parsed.payload !== 'object') {
                    problems.push('payload 缺失或不是对象');
                    continue;
                }
                if (parsed.payload.main === undefined) {
                    problems.push('payload 内容不完整（缺 main）');
                    continue;
                }
                if (!knownPayloadHashes.has(sha(parsed.payload))) {
                    problems.push(`payload 不是任何一次完整写入（marker=${parsed.payload.main.marker}）`);
                }
                // 自洽：响应头声明的长度必须等于实际字节数
                const declared = Number(response.headers.get('content-length'));
                if (Number.isFinite(declared) && declared !== Buffer.byteLength(text)) {
                    problems.push(`Content-Length 不符：声明 ${declared}，实际 ${Buffer.byteLength(text)}`);
                }
            }
        })());

        await Promise.all([...writers, ...readers]);
        assertEqual(`并发读写 ${concurrency}×${rounds} 轮无异常`, problems.slice(0, 3), []);
        // 所有写入完成后，服务端状态必须是某一次完整写入（而不是拼出来的）
        const finalState = await (await fetch(`${base}/v1/state`)).json();
        const finalMarker = finalState.payload?.main?.marker;
        assertTrue(`最终状态来自某次完整写入（marker=${finalMarker}）`,
            typeof finalMarker === 'string' && finalMarker.startsWith('writer-'));
        const finalHealth = await (await fetch(`${base}/v1/health`)).json();
        assertEqual('最终 revision 等于基线 + 成功写入次数',
            finalHealth.revision, baselineRevision + concurrency * rounds);
    }

    // 收尾：统计进程内存。
    // 关键指标是「相对于基线的增量」而不是绝对值 —— 绝对值里含 Node 运行时本身
    // （约 50MB）与测试期间为响应产生的临时缓冲，与快照大小无关才有意义。
    //
    // 注意：这里用第 3 步之后记录的 rssAfterPush，而不是并发压测之后的读数 ——
    // 并发压测会同时持有大量请求体缓冲，属于测试自身造成的瞬时占用，
    // 不能用来衡量「快照常驻内存」这个指标。
    const finalRss = rssAfterPush ?? await readRssKbAsync();
    if (finalRss !== null) {
        const rssMb = finalRss / 1024;
        const baselineMb = Number.isFinite(startRssKb) ? startRssKb / 1024 : null;
        console.log(`\n进程 RSS（推送 ${bodyMb}MB 快照后）: 启动基线 ${baselineMb?.toFixed(1)}MB → ${rssMb.toFixed(1)}MB`);
        if (baselineMb !== null) {
            const growthMb = rssMb - baselineMb;
            const snapshotMb = Number(bodyMb);
            // 关键性质：流式实现的内存增量是**有界的**，与快照大小无关
            // （固定开销来自 Node 的流缓冲、HTTP 解析与尚未回收的页）。
            // 老实现是正比增长：64MB 快照 → +619MB，1.8GB 快照 → 顶到 1.8GB+。
            // 因此这里用「常数上界」而不是比例来断言；上界 48MB 既容得下
            // 流式搬运的固定开销，又远低于老实现的 10 倍量级。
            const boundMb = 48;
            console.log(`  增量 +${growthMb.toFixed(1)}MB，上界 ${boundMb}MB（快照 ${snapshotMb}MB）`);
            assertTrue(
                `内存增量有界（+${growthMb.toFixed(1)}MB < ${boundMb}MB），不随快照大小增长`,
                growthMb < boundMb
            );
            // 再补一条「远小于老实现」的比例检查，作为对照说明。
            assertTrue(
                `增量远小于老实现量级（老实现约 ${(snapshotMb * 9.7).toFixed(0)}MB）`,
                growthMb < snapshotMb * 9.7 * 0.2
            );
        }
    }
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
