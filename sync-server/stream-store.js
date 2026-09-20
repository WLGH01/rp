// 流式磁盘助手：请求体落临时文件、按字节区间搬运、按区间流式响应。
//
// 设计前提
// --------
// 同步快照里约 90% 是头像 base64。服务端真正要用到的只有
// updatedAt / deviceId / force 几个小字段，以及 payload 在字节流里的区间。
// 因此约定：**payload 永远以原始字节在磁盘上搬运**，
//   请求体临时文件 → state.json → HTTP 响应
// 中间不做 JSON.parse、也不做 JSON.stringify，内存占用与快照大小无关。
//
// 一致性
// ------
// state.json 会被整体重写（temp + rename）。为了让「元数据快照」与
// 「payload 字节区间」始终指向同一个文件版本，响应前先 open() 拿到文件句柄，
// 再从该句柄开读流：rename 换掉目录项后，旧句柄仍指向原 inode，不会读到半个新文件。

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import { createBase64ToBytes } from './base64-stream.js';

// 顶层小字段的读取上限，防止误把大字段当元数据读进来。
export const MAX_TOKEN_BYTES = 64 * 1024;

const CHUNK_BYTES = 256 * 1024;

/**
 * 把请求体流式写入文件，超过 maxBytes 立即中止。
 * 全程不把请求体整块留在内存。
 *
 * 为什么不用 stream.pipeline：pipeline 出错时会 destroy(req)，
 * 而服务端的 req.destroy() 会连带销毁 socket，导致「请求体过大」这个
 * 413 根本发不回去（客户端只看到连接被重置）。
 * 这里手工接管：超额时只 pause 不再读，把 socket 留给响应使用。
 */
export const receiveBodyToFile = async (req, filePath, maxBytes) => {
    const out = createWriteStream(filePath);
    let size = 0;
    let settled = false;
    try {
        await new Promise((resolve, reject) => {
            const finish = (error) => {
                if (settled) return;
                settled = true;
                req.off('data', onData);
                req.off('end', onEnd);
                req.off('error', onError);
                out.off('error', onError);
                if (error) {
                    out.destroy();
                    reject(error);
                    return;
                }
                out.end(resolve);
            };
            const onData = (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    // 超额：停止读取，把剩下的请求体丢掉。
                    // 注意这里**必须**让上层在响应里带 Connection: close ——
                    // 否则 socket 里还残留着没读完的请求体字节，
                    // keep-alive 复用这条连接时会把它们当成下一个请求去解析，
                    // 于是后续请求莫名其妙地 "fetch failed"。
                    req.pause();
                    finish(Object.assign(new Error('请求体过大'), { statusCode: 413, closeConnection: true }));
                    return;
                }
                if (!out.write(chunk)) {
                    req.pause();
                    out.once('drain', () => req.resume());
                }
            };
            const onEnd = () => finish(null);
            const onError = (error) => finish(error);
            req.on('data', onData);
            req.on('end', onEnd);
            req.on('error', onError);
            out.on('error', onError);
        });
    } catch (error) {
        await fs.rm(filePath, { force: true }).catch(() => {});
        throw error;
    }
    if (!size) {
        await fs.rm(filePath, { force: true }).catch(() => {});
        throw Object.assign(new Error('请求体为空'), { statusCode: 400 });
    }
    return { bytes: size };
};

/** 读取一个小字段的原始 JSON 字面量并解析。 */
export const readToken = async (filePath, range) => {
    const length = range.end - range.start;
    if (length <= 0 || length > MAX_TOKEN_BYTES) throw new Error('字段长度异常');
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, range.start);
        return JSON.parse(buffer.toString('utf8'));
    } finally {
        await handle.close();
    }
};

/** 读不到就返回 undefined（用于可选字段，如 deviceId / force）。 */
export const readTokenSafe = async (filePath, range) => {
    if (!range) return undefined;
    try {
        return await readToken(filePath, range);
    } catch {
        return undefined;
    }
};

/** 状态元数据字段（不含外层花括号，也不含 payload）。 */
export const buildStateFields = (meta) => `"revision":${Number(meta.revision) || 0}`
    + `,"updatedAt":${Number(meta.updatedAt) || 0}`
    + `,"serverUpdatedAt":${Number(meta.serverUpdatedAt) || 0}`
    + `,"deviceId":${JSON.stringify(String(meta.deviceId || ''))},"payload":`;

/**
 * 流式写 state.json：元数据前缀 + payload 原始字节 + 结尾，然后原子 rename。
 * 返回新文件里 payload 的字节区间，供后续零拷贝响应使用。
 */
export const writeStateFileStreaming = async ({ sourceFile, payloadRange, payloadIsNull, meta, tmpPath, finalPath }) => {
    const fields = buildStateFields(meta);
    const fieldsBytes = Buffer.byteLength(fields, 'utf8');
    const headBytes = 1 + fieldsBytes; // 前导 '{'
    const payloadBytes = payloadIsNull ? 4 : payloadRange.end - payloadRange.start;
    try {
        await pipeline(
            async function* generate() {
                yield Buffer.from(`{${fields}`, 'utf8');
                if (payloadIsNull) {
                    yield Buffer.from('null', 'utf8');
                } else {
                    for await (const chunk of createReadStream(sourceFile, {
                        start: payloadRange.start,
                        end: payloadRange.end - 1,
                        highWaterMark: CHUNK_BYTES
                    })) yield chunk;
                }
                yield Buffer.from('}', 'utf8');
            },
            createWriteStream(tmpPath)
        );
        await fs.rename(tmpPath, finalPath);
    } catch (error) {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        throw error;
    }
    return {
        payloadBytes,
        payloadRange: payloadIsNull ? null : { start: headBytes, end: headBytes + payloadBytes }
    };
};

/**
 * 按状态快照流式响应：外层前缀 + 元数据字段 + payload 原始字节 + 外层后缀。
 * Content-Length 精确计算。
 *
 * 调用方必须在整个响应期间持有「读锁」（见 server.js 的 beginRead/endRead），
 * 写盘方会等读锁全部释放后才 rename 覆盖 state.json。
 * 这样既保证读到的是快照对应的那一版内容，也不需要在 Windows 上
 * 保留一个长期打开的文件句柄（Windows 不允许 rename 覆盖已打开的文件）。
 *
 * @param {object} snapshot 状态快照 { meta, payloadRange, payloadIsNull }
 * @param {string} stateFile state.json 路径
 * @param {string} outerPrefix 例如 409 的 '{"ok":false,...,"current":{'
 * @param {string} outerSuffix 例如 409 的 '}}'
 */
export const sendStateStream = async (res, { snapshot, stateFile, status = 200, outerPrefix = '', outerSuffix = '}' }) => {
    const fields = buildStateFields(snapshot.meta);
    const payloadBytes = snapshot.payloadIsNull ? 4 : snapshot.payloadRange.end - snapshot.payloadRange.start;
    const contentLength = Buffer.byteLength(outerPrefix, 'utf8')
        + 1 + Buffer.byteLength(fields, 'utf8')
        + payloadBytes
        + Buffer.byteLength(outerSuffix, 'utf8');

    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': contentLength,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    await pipeline(
        async function* generate() {
            if (outerPrefix) yield Buffer.from(outerPrefix, 'utf8');
            yield Buffer.from(`{${fields}`, 'utf8');
            if (snapshot.payloadIsNull) {
                yield Buffer.from('null', 'utf8');
            } else {
                for await (const chunk of createReadStream(stateFile, {
                    start: snapshot.payloadRange.start,
                    end: snapshot.payloadRange.end - 1,
                    highWaterMark: CHUNK_BYTES
                })) yield chunk;
            }
            yield Buffer.from(outerSuffix, 'utf8');
        },
        res
    );
};

/**
 * 把某个 JSON 字段（base64 / data URL 字符串）流式解码到文件，同时算内容 hash。
 * 用于图片归档：不把 base64 文本或整张原图留在内存。
 */
export const decodeJsonFieldToFile = async ({ sourceFile, range, destPath, maxBytes }) => {
    const decoder = createBase64ToBytes();
    const hasher = crypto.createHash('sha256');
    let bytes = 0;

    const accept = (decoded) => {
        if (!decoded.length) return null;
        bytes += decoded.length;
        if (bytes > maxBytes) throw Object.assign(new Error('图片超过上限'), { statusCode: 413 });
        hasher.update(decoded);
        return decoded;
    };

    try {
        await pipeline(
            async function* generate() {
                for await (const chunk of createReadStream(sourceFile, {
                    start: range.start,
                    end: range.end - 1,
                    highWaterMark: CHUNK_BYTES
                })) {
                    const decoded = accept(decoder.push(chunk));
                    if (decoded) yield decoded;
                }
                const tail = accept(decoder.end().bytes);
                if (tail) yield tail;
            },
            createWriteStream(destPath)
        );
    } catch (error) {
        await fs.rm(destPath, { force: true }).catch(() => {});
        throw error;
    }

    if (!bytes) {
        await fs.rm(destPath, { force: true }).catch(() => {});
        throw Object.assign(new Error('图片数据为空'), { statusCode: 400 });
    }
    return { bytes, mime: decoder.mime, hash: hasher.digest('hex') };
};
