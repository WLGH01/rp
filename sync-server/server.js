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
// 读取接口是「同源通道」，不需要额外配置；若 nginx 上再加一条
//   location ^~ /images/ { alias /data/images/; }
// 就能走静态文件（更快），前端会优先用那条路径、失败再退回本接口。

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
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

const log = (...args) => console.log(new Date().toISOString(), ...args);

// --- 状态 ---
let state = null;        // { revision, updatedAt, serverUpdatedAt, deviceId, payload }
let writeQueue = Promise.resolve();

const emptyState = () => ({ revision: 0, updatedAt: 0, serverUpdatedAt: 0, deviceId: '', payload: null });

const ensureDirs = async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(BACKUP_DIR, { recursive: true });
};

// 原子写：先写临时文件再 rename，避免中途崩溃留下半截 JSON。
const atomicWrite = async (file, data) => {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
};

const loadState = async () => {
    await ensureDirs();
    try {
        const raw = await fs.readFile(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        state = { ...emptyState(), ...parsed };
        log(`已载入状态: revision=${state.revision} updatedAt=${state.updatedAt} 大小=${(raw.length / 1048576).toFixed(2)}MB`);
    } catch (error) {
        if (error.code !== 'ENOENT') log('载入状态失败，将以空状态启动:', error.message);
        state = emptyState();
    }
};

// 轮换备份：按时间戳命名，同时按"份数"和"总大小"两个上限裁剪。
// 只在最旧的开始删，保证最近几份始终可回滚。
const rotateBackup = async () => {
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.copyFile(STATE_FILE, path.join(BACKUP_DIR, `state-${stamp}.json`)).catch(() => {});

        const names = (await fs.readdir(BACKUP_DIR))
            .filter(name => name.startsWith('state-') && name.endsWith('.json'))
            .sort();

        // 1) 份数上限
        let keep = names.slice(Math.max(0, names.length - MAX_BACKUPS));
        for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
            await fs.unlink(path.join(BACKUP_DIR, name)).catch(() => {});
        }

        // 2) 总大小上限：从最旧的开始删，但至少保留 1 份。
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

const persist = () => {
    // 串行化写入，避免并发写导致文件损坏。
    writeQueue = writeQueue.then(async () => {
        await atomicWrite(STATE_FILE, JSON.stringify(state));
        await rotateBackup();
    }).catch(error => log('持久化失败:', error.message));
    return writeQueue;
};

// --- 生图归档 ---
// 图片按内容 SHA-256 去重：同图重复提交不会重复占空间。
// 目录结构：images/<年-月-日>/<hash 前16位>.<ext>，索引记录在 images/index.json。
let imageIndex = null;
let imageIndexQueue = Promise.resolve();

const loadImageIndex = async () => {
    if (imageIndex) return imageIndex;
    await fs.mkdir(IMAGE_DIR, { recursive: true });
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

// 同时兼容 data URL 与裸 base64。
const decodeImagePayload = (raw) => {
    const text = String(raw || '');
    const match = text.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (match) {
        return {
            mime: match[1] || 'image/png',
            buffer: Buffer.from(match[3], match[2] ? 'base64' : 'utf8')
        };
    }
    return { mime: 'image/png', buffer: Buffer.from(text, 'base64') };
};

const archiveImage = async ({ data, character, prompt, model, size, source, jobId }) => {
    const { mime, buffer } = decodeImagePayload(data);
    if (!buffer.length) throw Object.assign(new Error('图片数据为空'), { statusCode: 400 });
    if (buffer.length > IMAGE_MAX_BYTES) throw Object.assign(new Error('图片超过上限'), { statusCode: 413 });

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const index = await loadImageIndex();

    // 命中同内容图片：只更新统计，不重复写盘。
    if (index.items[hash]) {
        index.items[hash].lastSeenAt = new Date().toISOString();
        index.items[hash].hits = (index.items[hash].hits || 1) + 1;
        await saveImageIndex();
        return { deduplicated: true, hash, file: index.items[hash].file, bytes: buffer.length, ...imageUrlsOf(index.items[hash].file) };
    }

    const day = new Date().toISOString().slice(0, 10);
    const ext = EXT_BY_MIME[mime] || 'png';
    const dir = path.join(IMAGE_DIR, day);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `${hash.slice(0, 16)}.${ext}`;
    await fs.writeFile(path.join(dir, fileName), buffer);

    index.items[hash] = {
        hash,
        file: `images/${day}/${fileName}`,
        mime,
        bytes: buffer.length,
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
    return { deduplicated: false, hash, file: index.items[hash].file, bytes: buffer.length, ...imageUrlsOf(index.items[hash].file) };
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
const sendJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(text);
};

const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => {
        try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (error) {
            reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
        }
    });
    req.on('error', reject);
});

// 对外只暴露必要的摘要，避免把整份数据在日志里打出来。
const summary = () => ({
    revision: state.revision,
    updatedAt: state.updatedAt,
    serverUpdatedAt: state.serverUpdatedAt,
    deviceId: state.deviceId,
    hasPayload: state.payload !== null,
    sizeBytes: state.payload === null ? 0 : Buffer.byteLength(JSON.stringify(state.payload))
});

const server = http.createServer(async (req, res) => {
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

    // 健康检查
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
        return sendJson(res, 200, { ok: true, ...summary() });
    }

    // 调试：数据文件直读（仅用于排查，不返回 payload 内容）
    if (req.method === 'GET' && url.pathname === '/v1/status') {
        return sendJson(res, 200, summary());
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
        let body;
        try {
            body = await readBody(req);
        } catch (error) {
            return sendJson(res, error.statusCode || 400, { ok: false, error: error.message });
        }
        try {
            const result = await archiveImage(body);
            log(`图片归档: ${result.deduplicated ? '命中已有' : '新增'} ${result.file} (${(result.bytes / 1024).toFixed(0)}KB)`);
            return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
            return sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
        }
    }

    // 拉取完整状态
    if (req.method === 'GET' && (url.pathname === '/v1/state' || url.pathname === '/')) {
        return sendJson(res, 200, {
            revision: state.revision,
            updatedAt: state.updatedAt,
            serverUpdatedAt: state.serverUpdatedAt,
            deviceId: state.deviceId,
            payload: state.payload
        });
    }

    // 推送状态（LWW）
    if (req.method === 'POST' && (url.pathname === '/v1/state' || url.pathname === '/')) {
        let body;
        try {
            body = await readBody(req);
        } catch (error) {
            return sendJson(res, error.statusCode || 400, { ok: false, error: error.message });
        }

        const incomingAt = Number(body.updatedAt);
        if (!Number.isFinite(incomingAt) || incomingAt <= 0) {
            return sendJson(res, 400, { ok: false, error: 'updatedAt 必须是正整数毫秒时间戳' });
        }
        if (body.payload === undefined) {
            return sendJson(res, 400, { ok: false, error: '缺少 payload' });
        }

        const force = body.force === true;
        // LWW：只有更新的时间戳才接受；force 用于「以本设备为准」的手动覆盖。
        if (!force && incomingAt <= state.updatedAt) {
            log(`拒绝旧写入: 客户端=${incomingAt} <= 服务端=${state.updatedAt}`);
            return sendJson(res, 409, {
                ok: false,
                accepted: false,
                reason: 'stale',
                message: '服务端已有更新的数据',
                current: {
                    revision: state.revision,
                    updatedAt: state.updatedAt,
                    serverUpdatedAt: state.serverUpdatedAt,
                    deviceId: state.deviceId,
                    payload: state.payload
                }
            });
        }

        state = {
            revision: state.revision + 1,
            updatedAt: incomingAt,
            serverUpdatedAt: Date.now(),
            deviceId: String(body.deviceId || '').slice(0, 128),
            payload: body.payload
        };
        await persist();
        log(`接受写入: revision=${state.revision} updatedAt=${incomingAt} device=${state.deviceId} 大小=${(Buffer.byteLength(JSON.stringify(state.payload)) / 1048576).toFixed(2)}MB`);
        return sendJson(res, 200, { ok: true, accepted: true, revision: state.revision, updatedAt: state.updatedAt });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
});

const shutdown = () => {
    server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await loadState();
server.listen(PORT, HOST, () => {
    log(`RP-Hub 同步服务已启动: ${HOST}:${PORT}, 数据目录 ${DATA_DIR}`);
});

export { server };
