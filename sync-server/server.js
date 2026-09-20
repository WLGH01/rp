#!/usr/bin/env node
// RP-Hub 状态同步服务
//
// 作用：把浏览器 IndexedDB 里的「全部用户数据」以单个 JSON 快照的形式
//       持久化到 unraid 的挂载目录，让手机与电脑可以共享同一份数据。
//
// 冲突策略：最后写入者胜（LWW）。客户端带 updatedAt（毫秒时间戳），
//           只有比服务端已存的时间戳更新才会被接受；否则返回服务端当前状态，
//           由客户端决定是否采用。这样不会出现「旧数据覆盖新数据」。
//
// 依赖：无（仅 Node 内置模块）。
// 环境变量：
//   PORT      监听端口（默认 3000）
//   HOST      监听地址（默认 0.0.0.0；与 nginx 同容器时建议 127.0.0.1）
//   DATA_DIR  数据目录（默认 /data），存放 state.json 与 backups/
//
// 另外提供生图归档：
//   POST /v1/images                 生成的图片落盘（内容 hash 去重、按日期分目录）
//   GET  /v1/images                 归档统计
//   GET  /v1/images/<day>/<file>    读取原图（供任何设备直接显示，不必本机存 base64）
//
// ── 内存设计（重要）──────────────────────────────────────────────
// 快照里约 90% 是角色卡头像的 base64（实测 118MB 里 105MB 是头像），
// 而服务端真正用到的只有 updatedAt / deviceId / force 这几个小字段。
// 因此本服务**不让 payload 进入内存**：
//
//   * 请求体流式落临时文件（不超过磁盘），只扫描顶层结构拿到各字段的字节区间；
//   * payload 以「原样字节」从临时文件流式写进 state.json，不经 JSON.parse；
//   * 对外响应时按区间从 state.json 流式读出，不 JSON.stringify；
//   * 健康检查/日志只用元数据，字节数来自文件 stat，不序列化任何大对象。
//
// 于是常驻内存与快照大小无关（几十 MB 级 → 十几 MB 级），
// 也彻底消除了「每 30 秒健康检查就造一个 107MB 字符串」那种峰值。
// 详见 sync-server/README.md 的「内存设计」一节。

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { scanFileTopLevel } from './json-scan.js';
import {
    decodeJsonFieldToFile,
    readToken,
    readTokenSafe,
    receiveBodyToFile,
    sendStateStream,
    writeStateFileStreaming
} from './stream-store.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
// 请求体临时文件与原子写临时文件都放这里：必须与 state.json 同一个文件系统，
// rename 才是原子的（跨设备 rename 会退化成复制）。
const TMP_DIR = path.join(DATA_DIR, '.tmp');
// 生图归档目录：按 <年-月-日>/ 分目录
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const IMAGE_INDEX = path.join(IMAGE_DIR, 'index.json');
const IMAGE_MAX_BYTES = 32 * 1024 * 1024;

// 头像以 base64 data URL 内联存储，整个快照可能很大，这里放宽上限。
const MAX_BODY_BYTES = 128 * 1024 * 1024;
// 备份保留份数。头像与聊天记录都可能内联进快照（实测单份 57MB+），
// 因此除了份数，还要用总大小兜底。
const MAX_BACKUPS = Math.max(1, Number(process.env.MAX_BACKUPS) || 3);
// 备份目录总占用上限（字节）。默认 10GB：给大快照留足空间，
// 同时避免备份无限膨胀占满磁盘。设为 0 表示不限制。
const MAX_BACKUP_BYTES = Math.max(0, Number(process.env.MAX_BACKUP_BYTES) || 10 * 1024 * 1024 * 1024);
// 备份默认用硬链接而不是复制：同一份内容在文件系统里只有一份数据块，
// unraid 的 btrfs / 单盘 xfs 都支持。不支持时自动退回复制。
const BACKUP_HARDLINK = process.env.BACKUP_HARDLINK !== '0';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// --- 状态 ---
// 注意：state 里**没有 payload**。payload 只以「文件 + 字节区间」的形式存在，
// 这样快照多大都不影响常驻内存。
//
// 一致性靠「读锁 + 写入闸门」保证，而不是长期持有文件句柄：
//   * 每次要读 payload 的请求先 beginRead()，响应写完再 endRead()；
//   * 写盘方在 rename 覆盖 state.json 之前 await readersDrained()；
//   * 因此 rename 期间绝不会有人在读 state.json。
// 之所以不长期持有 fd：Windows 不允许 rename 覆盖一个已打开的文件（EPERM），
// 而 unraid 容器里跑的就是 Linux —— 但项目本地开发在 Windows，
// 用读锁可以两端行为一致，也不必操心 fd 泄漏。
let state = {
    revision: 0,
    updatedAt: 0,
    serverUpdatedAt: 0,
    deviceId: '',
    hasPayload: false,
    payloadRange: null,
    payloadBytes: 0
};
let ingestQueue = Promise.resolve();

// --- 读写闸门 ---
// 目标：任何响应读 payload 的期间，写盘方都不能 rename 覆盖 state.json；
// 反过来，写盘方一旦决定要写，新的读者必须等它写完再读。
//
// 为什么需要「写者意图」这个状态：只在 rename 前等 readers==0 是不够的 ——
// 在「readers 归零」和「rename 完成」之间，新来的读者仍会拿到**旧**的
// 元数据/区间，然后按路径去读**新**文件，切出错误数据。
// 所以写者先立旗（activeWriter=true），新读者见旗就在门外等，
// 直到写者收旗，这样窗口期不存在。
let activeReaders = 0;
let activeWriter = false;
let readersIdleWaiters = null;
let writerIdleWaiters = null;

const wake = (list) => {
    if (list && list.length) list.splice(0).forEach(resolve => resolve());
};

// 读者进入：有写者立旗就在门外等。返回后即可安全取 state 快照并读文件。
const acquireRead = () => {
    if (!activeWriter) {
        activeReaders += 1;
        return Promise.resolve();
    }
    if (!writerIdleWaiters) writerIdleWaiters = [];
    return new Promise(resolve => {
        writerIdleWaiters.push(() => {
            activeReaders += 1;
            resolve();
        });
    });
};

const releaseRead = () => {
    activeReaders -= 1;
    if (activeReaders <= 0 && readersIdleWaiters) {
        wake(readersIdleWaiters);
        readersIdleWaiters = null;
    }
};

// 写者进入：立旗（挡住新读者）→ 等现有读者读完 → 执行 fn → 收旗放行。
const withWriteGate = async (fn) => {
    activeWriter = true;
    try {
        if (activeReaders > 0) {
            if (!readersIdleWaiters) readersIdleWaiters = [];
            await new Promise(resolve => readersIdleWaiters.push(resolve));
        }
        return await fn();
    } finally {
        activeWriter = false;
        if (writerIdleWaiters) {
            wake(writerIdleWaiters);
            writerIdleWaiters = null;
        }
    }
};

// 在「读锁已持有」的前提下取状态快照，然后执行 fn。
// 必须**先 acquireRead 再取 state**：反过来会出现
// 「拿到旧区间 → 写者改名 → 按旧区间读新文件」的错切。
const withStateSnapshot = async (fn) => {
    await acquireRead();
    try {
        return await fn(state);
    } finally {
        releaseRead();
    }
};

const emptyState = () => ({
    revision: 0,
    updatedAt: 0,
    serverUpdatedAt: 0,
    deviceId: '',
    hasPayload: false,
    payloadRange: null,
    payloadBytes: 0
});

// 对外暴露的元数据快照。字段都是小标量，构造它不产生任何大字符串。
const metaOf = (snapshot = state) => ({
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    serverUpdatedAt: snapshot.serverUpdatedAt,
    deviceId: snapshot.deviceId
});

// 响应视图：把「元数据 + payload 字节区间」打包给 sendStateStream。
// payloadIsNull 表示 payload 是字面量 null（此时不读文件，直接吐 null）。
const viewOf = (snapshot) => ({
    meta: metaOf(snapshot),
    payloadRange: snapshot.payloadRange,
    payloadIsNull: !snapshot.hasPayload
});

const ensureDirs = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    await fs.mkdir(TMP_DIR, { recursive: true });
    await fs.mkdir(IMAGE_DIR, { recursive: true });
};

const tmpFile = (tag) => path.join(TMP_DIR, `${tag}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);

// 原子写小文件：先写临时文件再 rename，避免中途崩溃留下半截 JSON。
const atomicWrite = async (file, data) => {
    const tmp = tmpFile('w');
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
};

const loadState = async () => {
    await ensureDirs();
    try {
        const stat = await fs.stat(STATE_FILE);
        // 只扫描顶层结构，不解析 payload：多大的快照都只是顺序读一遍。
        const scanned = await scanFileTopLevel(STATE_FILE);
        if (!scanned.ok) throw new Error(`state.json 结构损坏：${scanned.error}`);
        const fields = scanned.fields;

        const revision = await readTokenSafe(STATE_FILE, fields.revision);
        const updatedAt = await readTokenSafe(STATE_FILE, fields.updatedAt);
        const serverUpdatedAt = await readTokenSafe(STATE_FILE, fields.serverUpdatedAt);
        const deviceId = await readTokenSafe(STATE_FILE, fields.deviceId);
        const payload = fields.payload;

        // 判断 payload 是否为 null：只有 4 个字节的 "null" 才当空。
        let hasPayload = false;
        if (payload) {
            hasPayload = payload.end - payload.start > 4
                || await readTokenSafe(STATE_FILE, payload) !== null;
        }

        state = {
            revision: Number(revision) || 0,
            updatedAt: Number(updatedAt) || 0,
            serverUpdatedAt: Number(serverUpdatedAt) || 0,
            deviceId: typeof deviceId === 'string' ? deviceId : '',
            hasPayload,
            payloadRange: hasPayload ? { start: payload.start, end: payload.end } : null,
            payloadBytes: hasPayload ? payload.end - payload.start : 0
        };
        log(`已载入状态: revision=${state.revision} updatedAt=${state.updatedAt} 快照=${(stat.size / 1048576).toFixed(2)}MB payload=${(state.payloadBytes / 1048576).toFixed(2)}MB`);
    } catch (error) {
        if (error.code !== 'ENOENT') log('载入状态失败，将以空状态启动:', error.message);
        state = emptyState();
    }
};

// 轮换备份：在覆盖 state.json **之前** 先给旧版本留一份备份。
// 按时间戳命名，同时按"份数"和"总大小"两个上限裁剪，只在最旧的开始删。
//
// 备份用硬链接而不是复制：把 state.json 当前指向的 inode 再挂一个名字，
// 同一份内容在文件系统里只有一份数据块（省下 118MB/份的磁盘）。
// 后续 rename 换掉 state.json 不会影响这个链接指向的旧内容。
const rotateBackup = async () => {
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = path.join(BACKUP_DIR, `state-${stamp}.json`);
        let linked = false;
        if (BACKUP_HARDLINK) {
            linked = await fs.link(STATE_FILE, target).then(() => true, () => false);
        }
        if (!linked) await fs.copyFile(STATE_FILE, target).catch(() => {});

        const names = (await fs.readdir(BACKUP_DIR))
            .filter(name => name.startsWith('state-') && name.endsWith('.json'))
            .sort();

        // 1) 份数上限
        let keep = names.slice(Math.max(0, names.length - MAX_BACKUPS));
        for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
            await fs.unlink(path.join(BACKUP_DIR, name)).catch(() => {});
        }

        // 2) 总大小上限：从最旧的开始删，但至少保留 1 份。
        //    注意硬链接的 stat.size 仍是逻辑大小，多份备份可能共享同一份数据块，
        //    因此这里按逻辑大小保守估算上限（宁可多删，不会超上限）。
        if (MAX_BACKUP_BYTES > 0) {
            const sized = [];
            for (const name of keep) {
                const stat = await fs.stat(path.join(BACKUP_DIR, name)).catch(() => null);
                if (stat) sized.push({ name, size: stat.size });
            }
            let total = sized.reduce((sum, item) => sum + item.size, 0);
            for (const item of sized) {
                if (total <= MAX_BACKUP_BYTES || keep.length <= 1) break;
                await fs.unlink(path.join(BACKUP_DIR, item.name)).catch(() => {});
                total -= item.size;
                keep = keep.filter(name => name !== item.name);
            }
        }
    } catch (error) {
        log('备份轮换失败（不影响主流程）:', error.message);
    }
};

// --- 生图归档 ---
// 图片按内容 SHA-256 去重：同图重复提交不会重复占空间。
// 目录结构：images/<年-月-日>/<hash 前16位>.<ext>，索引记录在 images/index.json。
let imageIndex = null;
let imageIndexQueue = Promise.resolve();

const loadImageIndex = async () => {
    if (imageIndex) return imageIndex;
    try {
        imageIndex = JSON.parse(await fs.readFile(IMAGE_INDEX, 'utf8'));
        if (!imageIndex || typeof imageIndex !== 'object' || !imageIndex.items) {
            imageIndex = { version: 1, items: {} };
        }
    } catch {
        imageIndex = { version: 1, items: {} };
    }
    return imageIndex;
};

const saveImageIndex = () => {
    imageIndexQueue = imageIndexQueue.then(async () => {
        await atomicWrite(IMAGE_INDEX, JSON.stringify(imageIndex));
    }).catch(error => log('图片索引写入失败:', error.message));
    return imageIndexQueue;
};

const EXT_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif'
};

const MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif'
};

// 归档图片的对外地址：
//   url    —— 站点同源静态路径（nginx alias 到 /data/images/）
//   apiUrl —— 走同步服务本体的同源接口，任何部署方式都可用
// file 形如 images/2026-09-19/abcd1234.png（相对 DATA_DIR）。
const imageUrlsOf = (file) => {
    const rest = String(file || '').replace(/^images\//, '');
    if (!rest) return { url: '', apiUrl: '' };
    return { url: `/images/${rest}`, apiUrl: `/api/v1/images/${rest}` };
};

/**
 * 归档一张图。data 字段以流式方式解码，不把 base64 或整张原图留在内存。
 * @param {string} sourceFile 请求体临时文件
 * @param {{start:number,end:number}} dataRange data 字段在临时文件里的区间
 */
const archiveImageStreaming = async ({ sourceFile, dataRange, character, prompt, model, size, source, jobId }) => {
    if (!dataRange) throw Object.assign(new Error('缺少图片数据'), { statusCode: 400 });

    const index = await loadImageIndex();
    const staged = tmpFile('img');
    let decoded;
    try {
        decoded = await decodeJsonFieldToFile({
            sourceFile,
            range: dataRange,
            destPath: staged,
            maxBytes: IMAGE_MAX_BYTES
        });
    } catch (error) {
        throw error;
    }

    const { hash, bytes, mime } = decoded;

    // 命中同内容图片：丢掉暂存文件，只更新统计。
    if (index.items[hash]) {
        await fs.rm(staged, { force: true }).catch(() => {});
        index.items[hash].lastSeenAt = new Date().toISOString();
        index.items[hash].hits = (index.items[hash].hits || 1) + 1;
        await saveImageIndex();
        return { deduplicated: true, hash, file: index.items[hash].file, bytes, ...imageUrlsOf(index.items[hash].file) };
    }

    const day = new Date().toISOString().slice(0, 10);
    const ext = EXT_BY_MIME[mime] || 'png';
    const dir = path.join(IMAGE_DIR, day);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `${hash.slice(0, 16)}.${ext}`;
    // 暂存文件已经解好码，直接 rename 到归档位置，省一次整文件复制。
    const moved = await fs.rename(staged, path.join(dir, fileName)).then(() => true, () => false);
    if (!moved) {
        await fs.copyFile(staged, path.join(dir, fileName));
        await fs.rm(staged, { force: true }).catch(() => {});
    }

    index.items[hash] = {
        hash,
        file: `images/${day}/${fileName}`,
        mime,
        bytes,
        savedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        hits: 1,
        character: String(character || '').slice(0, 200),
        prompt: String(prompt || '').slice(0, 2000),
        model: String(model || '').slice(0, 100),
        size: String(size || '').slice(0, 50),
        source: String(source || '').slice(0, 300),
        jobId: String(jobId || '').slice(0, 100)
    };
    await saveImageIndex();
    return { deduplicated: false, hash, file: index.items[hash].file, bytes, ...imageUrlsOf(index.items[hash].file) };
};

// 读取已归档的原图。
// 路径只接受 <年-月-日>/<hash>.<ext>：日期必须是合法日期串，文件名必须是十六进制 hash，
// 二者都做白名单校验，再加上一次「必须落在 IMAGE_DIR 内」的兜底，杜绝目录穿越。
const ARCHIVED_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ARCHIVED_FILE_PATTERN = /^[a-f0-9]{8,64}\.(?:png|jpe?g|webp|gif|avif)$/;

const sendArchivedImage = async (res, rest) => {
    const [day, file, ...trailing] = String(rest || '').split('/');
    if (trailing.length || !ARCHIVED_DAY_PATTERN.test(day || '') || !ARCHIVED_FILE_PATTERN.test(file || '')) {
        return sendJson(res, 400, { ok: false, error: '图片路径不合法' });
    }
    const full = path.join(IMAGE_DIR, day, file);
    if (!full.startsWith(IMAGE_DIR + path.sep)) {
        return sendJson(res, 400, { ok: false, error: '图片路径不合法' });
    }
    let stat;
    try {
        stat = await fs.stat(full);
    } catch {
        return sendJson(res, 404, { ok: false, error: '图片不存在' });
    }
    if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: '图片不存在' });

    // 文件名即内容 hash，内容不会变，可以放心长缓存。
    res.writeHead(200, {
        'Content-Type': MIME_BY_EXT[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=604800, immutable',
        'Access-Control-Allow-Origin': '*'
    });
    createReadStream(full).pipe(res);
};

const imageStats = async () => {
    const index = await loadImageIndex();
    const items = Object.values(index.items);
    return {
        count: items.length,
        bytes: items.reduce((sum, item) => sum + (item.bytes || 0), 0),
        latest: items.map(item => item.savedAt).sort().at(-1) || null
    };
};

// --- HTTP 辅助 ---
// close: true 用于「请求体没读完」的场景：socket 里还残留着未读字节，
// 必须关掉连接，否则 keep-alive 复用时会把这些字节当成下一个请求解析。
const sendJson = (res, status, body, { close = false } = {}) => {
    const text = JSON.stringify(body);
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };
    if (close) headers.Connection = 'close';
    res.writeHead(status, headers);
    res.end(text);
};

// 对外只暴露必要的摘要。
// sizeBytes 直接取已记录的 payload 字节数——**不再 JSON.stringify 整份 payload**。
// 老实现每次健康检查都会造一个上百 MB 的临时字符串，正是内存高位的元凶。
const summary = () => ({
    revision: state.revision,
    updatedAt: state.updatedAt,
    serverUpdatedAt: state.serverUpdatedAt,
    deviceId: state.deviceId,
    hasPayload: state.hasPayload,
    sizeBytes: state.payloadBytes
});

// 请求处理入口。
const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Max-Age': '86400'
        });
        return res.end();
    }

    // 健康检查：只读元数据，零序列化开销。
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
        return sendJson(res, 200, { ok: true, ...summary() });
    }

    // 调试：仅返回摘要（不含 payload 内容）
    // 顺便带上进程内存：排查「快照越大内存越高」这类问题时，
    // 这里能直接看到常驻内存，不必进容器翻 cgroup / ps。
    if (req.method === 'GET' && url.pathname === '/v1/status') {
        const memory = process.memoryUsage();
        return sendJson(res, 200, {
            ...summary(),
            memory: {
                rssBytes: memory.rss,
                heapUsedBytes: memory.heapUsed,
                heapTotalBytes: memory.heapTotal,
                externalBytes: memory.external
            },
            uptimeSeconds: Math.round(process.uptime())
        });
    }

    // 生图归档：统计信息
    if (req.method === 'GET' && url.pathname === '/v1/images') {
        try {
            return sendJson(res, 200, { ok: true, ...(await imageStats()) });
        } catch (error) {
            return sendJson(res, 500, { ok: false, error: error.message });
        }
    }

    // 生图归档：读取原图（同源通道；nginx 配了 /images/ 静态路径时前端会优先走那条）
    if (req.method === 'GET' && url.pathname.startsWith('/v1/images/')) {
        return sendArchivedImage(res, url.pathname.slice('/v1/images/'.length));
    }

    // 生图归档：接收图片（base64 或 data URL）
    if (req.method === 'POST' && url.pathname === '/v1/images') {
        const bodyFile = tmpFile('body');
        try {
            await receiveBodyToFile(req, bodyFile, MAX_BODY_BYTES);
            const scanned = await scanFileTopLevel(bodyFile);
            if (!scanned.ok) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
            const fields = scanned.fields;
            const readField = async (name) => {
                const range = fields[name];
                if (!range) return undefined;
                // 归档的元信息都是小字符串，超出上限就当没给，避免把大对象读进内存。
                const value = await readTokenSafe(bodyFile, range);
                return typeof value === 'string' ? value : undefined;
            };
            const result = await archiveImageStreaming({
                sourceFile: bodyFile,
                dataRange: fields.data,
                character: await readField('character'),
                prompt: await readField('prompt'),
                model: await readField('model'),
                size: await readField('size'),
                source: await readField('source'),
                jobId: await readField('jobId')
            });
            log(`图片归档: ${result.deduplicated ? '命中已有' : '新增'} ${result.file} (${(result.bytes / 1024).toFixed(0)}KB)`);
            return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
            return sendJson(res, error.statusCode || 500, { ok: false, error: error.message }, { close: error.closeConnection === true });
        } finally {
            await fs.rm(bodyFile, { force: true }).catch(() => {});
        }
    }

    // 拉取完整状态：payload 以字节区间从 state.json 流式吐出，不整份 JSON.stringify。
    if (req.method === 'GET' && (url.pathname === '/v1/state' || url.pathname === '/')) {
        return withStateSnapshot(async (snapshot) => {
            if (!snapshot.hasPayload) {
                return sendJson(res, 200, {
                    revision: snapshot.revision,
                    updatedAt: snapshot.updatedAt,
                    serverUpdatedAt: snapshot.serverUpdatedAt,
                    deviceId: snapshot.deviceId,
                    payload: null
                });
            }
            return sendStateStream(res, { snapshot: viewOf(snapshot), stateFile: STATE_FILE });
        });
    }

    // 推送状态（LWW）
    if (req.method === 'POST' && (url.pathname === '/v1/state' || url.pathname === '/')) {
        const bodyFile = tmpFile('body');
        try {
            await receiveBodyToFile(req, bodyFile, MAX_BODY_BYTES);

            // 只扫描顶层结构：拿到各字段的字节区间，payload 不进内存。
            const scanned = await scanFileTopLevel(bodyFile);
            if (!scanned.ok) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
            const fields = scanned.fields;

            if (!fields.payload) return sendJson(res, 400, { ok: false, error: '缺少 payload' });
            const payloadRange = fields.payload;
            // payload 为字面量 null 时按「无 payload」处理。
            const payloadIsNull = payloadRange.end - payloadRange.start === 4
                && await readTokenSafe(bodyFile, payloadRange) === null;

            const incomingAt = Number(await readTokenSafe(bodyFile, fields.updatedAt));
            if (!Number.isFinite(incomingAt) || incomingAt <= 0) {
                return sendJson(res, 400, { ok: false, error: 'updatedAt 必须是正整数毫秒时间戳' });
            }
            const deviceId = String(await readTokenSafe(bodyFile, fields.deviceId) || '').slice(0, 128);
            const force = (await readTokenSafe(bodyFile, fields.force)) === true;

            // LWW 比较用一个「请求进入时」的状态快照即可（标量读取在 JS 里是原子的）。
            // 注意：这里**不能**为写盘再加读锁 —— 写盘要等所有读者结束，
            // 自己持有读锁再去等就会死锁（并发写入时互相等待）。
            // 并发写的正确性由 ingestQueue 串行化保证。
            const entry = state;

            // LWW：只有更新的时间戳才接受；force 用于「以本设备为准」的手动覆盖。
            if (!force && incomingAt <= entry.updatedAt) {
                log(`拒绝旧写入: 客户端=${incomingAt} <= 服务端=${entry.updatedAt}`);
                if (!entry.hasPayload) {
                    return sendJson(res, 409, {
                        ok: false,
                        accepted: false,
                        reason: 'stale',
                        message: '服务端已有更新的数据',
                        current: {
                            revision: entry.revision,
                            updatedAt: entry.updatedAt,
                            serverUpdatedAt: entry.serverUpdatedAt,
                            deviceId: entry.deviceId,
                            payload: null
                        }
                    });
                }
                // 409 要把服务端当前快照整份带回，同样走流式，避免造出上百 MB 字符串。
                // 用 withStateSnapshot 保证「元数据 + 区间」与文件内容同一版本。
                return withStateSnapshot(snapshot => sendStateStream(res, {
                    snapshot: viewOf(snapshot),
                    stateFile: STATE_FILE,
                    status: 409,
                    // outerPrefix 多开了一层 "current":{，所以后缀要闭两个花括号，
                    // 否则响应会比 Content-Length 短，socket 被中断、客户端只看到 fetch failed。
                    outerPrefix: '{"ok":false,"accepted":false,"reason":"stale","message":"服务端已有更新的数据","current":',
                    outerSuffix: '}}'
                }));
            }

            // 串行落盘：把 payload 原始字节从临时文件搬进 state.json。
            // ingestQueue 必须始终停在「已解决」状态：一旦变成 rejected，
            // 后续每次 then 都会直接跳过落盘逻辑，写入会被永久卡死。
            const task = ingestQueue.then(async () => {
                // 写闸门：立旗挡住新读者，等现有读者读完，改名覆盖，**并在闸门内发布新状态**。
                // 发布必须也在闸门内：否则「rename 完成 → 闸门放行 → 才更新 state」
                // 之间来的读者会拿到旧区间去读新文件，切出错误数据。
                return withWriteGate(async () => {
                    // revision 与备份都基于「轮到本写入时的实际状态」，
                    // 而不是请求进入时的快照 —— 否则并发写入会算出重复版本号。
                    const current = state;

                    // 先备份旧版本（硬链接到当前 inode），再覆盖 state.json。
                    // 顺序很重要：rename 之后 state.json 就是新内容，再备份就备份到新的了。
                    if (current.hasPayload) await rotateBackup();

                    const nextMeta = {
                        revision: current.revision + 1,
                        updatedAt: incomingAt,
                        serverUpdatedAt: Date.now(),
                        deviceId
                    };
                    const written = await writeStateFileStreaming({
                        sourceFile: bodyFile,
                        payloadRange,
                        payloadIsNull,
                        meta: nextMeta,
                        tmpPath: tmpFile('state'),
                        finalPath: STATE_FILE
                    });
                    state = {
                        ...nextMeta,
                        hasPayload: !payloadIsNull,
                        payloadRange: payloadIsNull ? null : written.payloadRange,
                        payloadBytes: payloadIsNull ? 0 : written.payloadBytes
                    };
                    return state;
                });
            });
            ingestQueue = task.then(() => {}, () => {});
            await task;

            log(`接受写入: revision=${state.revision} updatedAt=${incomingAt} device=${state.deviceId} payload=${(state.payloadBytes / 1048576).toFixed(2)}MB`);
            return sendJson(res, 200, { ok: true, accepted: true, revision: state.revision, updatedAt: state.updatedAt });
        } catch (error) {
            return sendJson(res, error.statusCode || 500, { ok: false, error: error.message }, { close: error.closeConnection === true });
        } finally {
            await fs.rm(bodyFile, { force: true }).catch(() => {});
        }
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
};

const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
        log('请求处理失败:', error.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务内部错误' });
        else res.end();
    });
});

const shutdown = () => {
    server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await loadState();
// 清掉上次异常退出残留的临时文件，避免 /data/.tmp 无限堆积。
await fs.readdir(TMP_DIR).then(async names => {
    for (const name of names) await fs.rm(path.join(TMP_DIR, name), { force: true }).catch(() => {});
}).catch(() => {});

server.listen(PORT, HOST, () => {
    log(`RP-Hub 同步服务已启动: ${HOST}:${PORT}, 数据目录 ${DATA_DIR}`);
});

export { server };
