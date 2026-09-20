// 顶层字段扫描器：只认 JSON 的顶层结构，不做整份 JSON.parse。
//
// 为什么需要它
// ------------
// 同步快照里绝大部分是头像 base64（实测 118MB 里 105MB 是头像），
// 而服务端真正用到的只有 updatedAt / deviceId / force 三个小字段，
// 以及 payload 在字节流里的区间（原样转发、原样落盘即可）。
// 一旦 JSON.parse 成对象树，V8 里会膨胀 2~4 倍；而且每次响应、每次日志
// 都要再 JSON.stringify 一遍，等于凭空造出上百 MB 的临时字符串。
//
// 因此这里只做「结构扫描」：找出顶层每个字段名的值在字节流里的
// [start, end) 区间。有了区间，payload 就能以流的方式在「请求体临时文件 →
// state.json → HTTP 响应」之间搬运，全程不进入内存。
//
// 内存占用只与 chunk 大小和嵌套深度有关，与快照大小无关。
//
// 正确性说明
// ----------
// UTF-8 多字节序列的每个字节都 >= 0x80，永远不会等于 ASCII 结构字符
// （" { } [ ] : ,），因此按字节扫描对 UTF-8 文本是正确的。
// 扫描同时校验括号配对、字符串闭合与顶层字面量合法性，
// 结构不完整会明确报错，不会把半截 JSON 当合法数据落盘。

import { createReadStream } from 'node:fs';

const CHUNK_BYTES = 256 * 1024;

const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;

const isWs = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

// 顶层字面量只可能是数字 / true / false / null。
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
// 顶层字面量都很短；超长只可能是畸形输入，直接判错，避免无界累积。
const MAX_PRIMITIVE_BYTES = 64;

const isValidPrimitive = (bytes) => {
    const token = Buffer.from(bytes).toString('utf8');
    return token === 'true' || token === 'false' || token === 'null' || NUMBER_PATTERN.test(token);
};

/**
 * 创建一个增量扫描器。可以反复 push 分片，最后调用 finish()。
 * @returns {{ push: (chunk: Buffer, chunkStart: number) => void, finish: () => { ok: boolean, fields?: Record<string, {start: number, end: number}>, error?: string }, hasError: () => boolean }}
 */
export const createScanner = () => {
    let state = 'root';
    let escape = false;
    let strRole = '';
    let bracketStack = [];
    let keyBytes = [];
    let key = '';
    let currentKey = '';
    let valueStart = 0;
    let primitiveBytes = [];
    let error = null;
    const fields = Object.create(null);

    const fail = (message) => {
        if (!error) {
            error = message;
            state = 'error';
        }
    };

    const emit = (end) => {
        if (currentKey) fields[currentKey] = { start: valueStart, end };
    };

    const step = (byte, position) => {
        switch (state) {
            case 'root':
                if (isWs(byte)) return;
                if (byte === LBRACE) {
                    bracketStack = [LBRACE];
                    state = 'topKeyOrEnd';
                    return;
                }
                return fail('根节点不是对象');
            case 'topKeyOrEnd':
                if (isWs(byte)) return;
                if (byte === RBRACE) {
                    bracketStack.pop();
                    state = 'rootDone';
                    return;
                }
                if (byte === QUOTE) {
                    keyBytes = [];
                    strRole = 'key';
                    state = 'str';
                    return;
                }
                return fail('顶层字段名不合法');
            case 'compoundStr':
                // 复合值内部的字符串，不参与字段名/字段值语义。
                if (escape) {
                    escape = false;
                    return;
                }
                if (byte === BACKSLASH) {
                    escape = true;
                    return;
                }
                if (byte === QUOTE) state = 'compound';
                return;
            case 'colon':
                if (isWs(byte)) return;
                if (byte === COLON) {
                    state = 'value';
                    return;
                }
                return fail('字段名后缺少冒号');
            case 'value':
                if (isWs(byte)) return;
                valueStart = position;
                currentKey = key;
                if (byte === QUOTE) {
                    strRole = 'value';
                    state = 'str';
                    return;
                }
                if (byte === LBRACE || byte === LBRACKET) {
                    bracketStack.push(byte);
                    state = 'compound';
                    return;
                }
                primitiveBytes = [byte];
                state = 'primitive';
                return;
            case 'str':
                if (escape) {
                    escape = false;
                    if (strRole === 'key') keyBytes.push(byte);
                    return;
                }
                if (byte === BACKSLASH) {
                    escape = true;
                    if (strRole === 'key') keyBytes.push(byte);
                    return;
                }
                if (byte === QUOTE) {
                    if (strRole === 'key') {
                        key = Buffer.from(keyBytes).toString('utf8');
                        state = 'colon';
                        return;
                    }
                    if (strRole === 'value') {
                        emit(position + 1);
                        state = 'afterValue';
                        return;
                    }
                    state = 'compound';
                    return;
                }
                if (strRole === 'key') keyBytes.push(byte);
                return;
            case 'primitive':
                // 空白、逗号、右花括号都表示字面量结束；这一字节本身要按
                // 结束后的语义重新处理一次（逗号→下一个字段，右花括号→根对象结束）。
                if (byte === COMMA || byte === RBRACE || isWs(byte)) {
                    if (!isValidPrimitive(primitiveBytes)) return fail('顶层字段值不是合法字面量');
                    emit(position);
                    state = 'afterValue';
                    return step(byte, position);
                }
                if (primitiveBytes.length >= MAX_PRIMITIVE_BYTES) return fail('顶层字段值过长');
                primitiveBytes.push(byte);
                return;
            case 'compound':
                if (byte === QUOTE) {
                    escape = false;
                    state = 'compoundStr';
                    return;
                }
                if (byte === LBRACE || byte === LBRACKET) {
                    bracketStack.push(byte);
                    return;
                }
                if (byte === RBRACE || byte === RBRACKET) {
                    const open = bracketStack.pop();
                    if ((byte === RBRACE && open !== LBRACE) || (byte === RBRACKET && open !== LBRACKET)) {
                        return fail('括号不匹配');
                    }
                    // 回到根对象那一层，说明这个复合值结束了。
                    if (bracketStack.length === 1) {
                        emit(position + 1);
                        state = 'afterValue';
                    }
                    return;
                }
                return;
            case 'afterValue':
                if (isWs(byte)) return;
                if (byte === COMMA) {
                    state = 'topKeyOrEnd';
                    return;
                }
                if (byte === RBRACE) {
                    bracketStack.pop();
                    state = 'rootDone';
                    return;
                }
                return fail('字段值后有多余内容');
            case 'rootDone':
                if (isWs(byte)) return;
                return fail('根对象之后有多余内容');
            default:
                return;
        }
    };

    return {
        push(chunk, chunkStart) {
            if (error) return;
            for (let index = 0; index < chunk.length; index += 1) {
                step(chunk[index], chunkStart + index);
                if (error) return;
            }
        },
        finish() {
            if (error) return { ok: false, error };
            if (state !== 'rootDone') {
                return { ok: false, error: state === 'root' ? 'JSON 内容为空' : 'JSON 结构不完整' };
            }
            return { ok: true, fields };
        },
        hasError: () => Boolean(error)
    };
};

/** 扫描内存中的 buffer（测试与「只读文件头」场景用）。 */
export const scanBufferTopLevel = (buffer) => {
    const scanner = createScanner();
    scanner.push(buffer, 0);
    return scanner.finish();
};

/** 流式扫描文件，返回顶层字段的字节区间；内存占用与文件大小无关。 */
export const scanFileTopLevel = async (filePath) => {
    const scanner = createScanner();
    const stream = createReadStream(filePath, { highWaterMark: CHUNK_BYTES });
    let offset = 0;
    for await (const chunk of stream) {
        scanner.push(chunk, offset);
        offset += chunk.length;
        // 结构已经错了就没必要读完整份文件。
        if (scanner.hasError()) {
            stream.destroy();
            break;
        }
    }
    return scanner.finish();
};
