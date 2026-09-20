// 增量 base64 解码：把「data URL / 裸 base64」的 JSON 字符串按块解成二进制。
//
// 为什么需要它
// ------------
// 图片上传接口最多允许 32MB 原图，base64 之后请求体约 43MB。
// 老实现是 readBody() 把整个请求体攒进 chunks 数组 → Buffer.concat 再复制一份
// → toString('utf8') 再复制一份 → 正则匹配 → Buffer.from(...,'base64') 解出原图，
// 一趟下来瞬时会有 3~4 倍请求体的内存。
//
// 这里改成逐字节消费：内存只与输出块大小有关，与图片大小无关。
//
// 输入是 JSON 字符串字面量里的内容，因此要容忍：
//   - 首尾的 JSON 引号（"）
//   - JSON 的反斜杠转义（\/ \\ \" 以及 \uXXXX）
//   - data URL 前缀（data:image/png;base64,）
//   - 裸 base64（没有前缀）
//   - base64 内部的空白与换行

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const MAP = new Int16Array(256).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) {
    MAP[ALPHABET.charCodeAt(index)] = index;
}

const EMPTY = Buffer.alloc(0);

// 需要直接跳过的字节：JSON 引号 + 各种空白
const SKIP = new Set([0x22, 0x20, 0x09, 0x0a, 0x0d, 0x0c]);

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const EQUALS = 0x3d;
const LETTER_U = 0x75;

// data URL 前缀最长也就几十字节；超过这个长度还没出现逗号，就按裸 base64 处理。
const MAX_HEAD_CHARS = 256;

/**
 * 创建增量解码器。
 * @returns {{ push: (chunk: Buffer) => Buffer, end: () => { bytes: Buffer, mime: string }, mime: string }}
 */
export const createBase64ToBytes = () => {
    let head = '';
    let headDone = false;
    let mime = '';
    // 四字符一组解出三字节
    let quad = 0;
    let accum = 0;
    let padded = false;
    let escape = false;
    let unicode = null;

    const feedChar = (code, out) => {
        if (padded) return;
        if (code === EQUALS) {
            padded = true;
            return;
        }
        const value = MAP[code & 0xff];
        if (value < 0) return; // 容错：非法字符直接忽略
        accum = ((accum << 6) | value) >>> 0;
        quad += 1;
        if (quad === 4) {
            out.push((accum >>> 16) & 0xff, (accum >>> 8) & 0xff, accum & 0xff);
            quad = 0;
            accum = 0;
        }
    };

    const feedRange = (text, out) => {
        for (let index = 0; index < text.length; index += 1) feedChar(text.charCodeAt(index), out);
    };

    const feed = (code, out) => {
        if (!headDone) pushHead(code, out);
        else feedChar(code, out);
    };

    const pushHead = (code, out) => {
        head += String.fromCharCode(code);
        // 不是 data URL：整段 head 都是 base64 数据
        if (head.length >= 5 && head.slice(0, 5) !== 'data:') {
            headDone = true;
            const buffered = head;
            head = '';
            feedRange(buffered, out);
            return;
        }
        const comma = head.indexOf(',');
        if (comma >= 0) {
            const meta = head.slice(0, comma);
            const match = meta.match(/^data:([^;,]*)(;base64)?$/i);
            if (match) mime = match[1] || 'image/png';
            headDone = true;
            const buffered = head.slice(comma + 1);
            head = '';
            feedRange(buffered, out);
            return;
        }
        if (head.length > MAX_HEAD_CHARS) {
            headDone = true;
            const buffered = head;
            head = '';
            feedRange(buffered, out);
        }
    };

    return {
        push(chunk) {
            const out = [];
            for (let index = 0; index < chunk.length; index += 1) {
                const code = chunk[index];
                if (unicode !== null) {
                    unicode += String.fromCharCode(code);
                    if (unicode.length === 4) {
                        const point = Number.parseInt(unicode, 16);
                        unicode = null;
                        if (Number.isFinite(point)) feed(point & 0xff, out);
                    }
                    continue;
                }
                if (escape) {
                    escape = false;
                    if (code === LETTER_U) {
                        unicode = '';
                        continue;
                    }
                    if (code === SLASH || code === BACKSLASH || code === QUOTE) feedChar(code, out);
                    continue;
                }
                if (code === BACKSLASH) {
                    escape = true;
                    continue;
                }
                if (SKIP.has(code)) continue;
                feed(code, out);
            }
            return out.length ? Buffer.from(out) : EMPTY;
        },
        end() {
            const out = [];
            if (!headDone && head) {
                const buffered = head;
                head = '';
                feedRange(buffered, out);
            }
            // 收尾：不足一组时按剩余位数补字节
            if (quad === 2) out.push((accum >>> 4) & 0xff);
            else if (quad === 3) out.push((accum >>> 10) & 0xff, (accum >>> 2) & 0xff);
            quad = 0;
            accum = 0;
            return { bytes: out.length ? Buffer.from(out) : EMPTY, mime: mime || 'image/png' };
        },
        get mime() {
            return mime || 'image/png';
        }
    };
};
