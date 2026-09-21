// RP-Hub core: shared utilities, character-card parsing and application configuration.

// --- Shared utilities ---
(function () {
const defaultAvatar = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2U1ZTdlYiIvPjwvc3ZnPg==';

const generateUUID = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
        const random = Math.random() * 16 | 0;
        const value = character === 'x' ? random : (random & 0x3 | 0x8);
        return value.toString(16);
    });
};

const parseCotCache = new Map();
const parseCot = (text) => {
    if (!text) return { cot: '', rawCot: '', ranges: [], closingTags: '', main: '', isFinished: false };
    if (parseCotCache.has(text)) return parseCotCache.get(text);

    // 重复开标签仍属于分析；只有真正的闭合标签才能放行正文。
    const tokens = /<(html|script|style|ui_template_updates)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<!--[\s\S]*?(?:-->|$)|```[\s\S]*?(?:```|$)|`[^`\r\n]*`|<\s*(\/?)\s*(thinking|think|cot)\s*>|<\/?[a-zA-Z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
    const openTags = [];
    const ranges = [];
    let blockStart = 0;
    let cotContent = '';
    let mainContent = '';
    let cursor = 0;
    let hasCot = false;
    const append = (part) => {
        if (openTags.length) cotContent += part;
        else mainContent += part;
    };
    for (const match of text.matchAll(tokens)) {
        append(text.slice(cursor, match.index));
        if (!match[3]) append(match[0]);
        else {
            const tag = match[3].toLowerCase();
            if (!match[2]) {
                hasCot = true;
                if (!openTags.length) blockStart = match.index;
                if (!openTags.includes(tag)) openTags.push(tag);
                if (cotContent) cotContent += '\n';
            } else if (openTags[openTags.length - 1] === tag) {
                openTags.pop();
                if (!openTags.length) ranges.push({ start: blockStart, end: match.index + match[0].length });
            }
        }
        cursor = match.index + match[0].length;
    }
    // 流式拆开的标签暂不展示，下一段到达后会重新解析完整文本。
    append(text.slice(cursor).replace(/<\s*\/?\s*(?:t|th|thi|thin|think|thinki|thinkin|thinking|c|co|cot)?\s*$/i, ''));

    if (openTags.length) ranges.push({ start: blockStart, end: text.length });
    const rawCot = cotContent.trim();
    const cot = rawCot.split(/(```[\s\S]*?(?:```|$)|`[^`\r\n]*`)/)
        .map((part, index) => index % 2 ? part : part.replace(/</g, '&lt;')).join('');
    const closingTags = [...openTags].reverse().map(tag => `</${tag}>`).join('');
    const result = { cot, rawCot, ranges, closingTags, main: mainContent.trim(), isFinished: hasCot && !openTags.length };
    parseCotCache.set(text, result);
    // Limit cache size to prevent memory leaks in extremely long sessions
    if (parseCotCache.size > 2000) {
        const firstKey = parseCotCache.keys().next().value;
        parseCotCache.delete(firstKey);
    }
    return result;
};

// 必须以闭合的 ### 或物理换行结束，禁止匹配流式输出末尾的 $，避免流式打字期间因部分提示词提前触发多次重复生图。
const getImageTagRegex = () => /image###((?:(?!image###|###)[^\r\n])+?)(?:###|(?=\r?\n))/gi;

const compressImage = (source, maxWidth = 300, quality = 0.7) => new Promise((resolve) => {
    const image = new Image();
    image.src = source;
    image.onload = () => {
        const scale = Math.min(1, maxWidth / image.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d');
        context.fillStyle = '#FFFFFF';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
    };
    image.onerror = () => resolve(source);
});

// 头像专用压缩参数。
// 头像在界面里最大也就渲染到卡片封面那么大（几百像素），
// 而导入原始 PNG 立绘可能是 1773×2364、单张 9.4MB（实测）——
// 这 70+MB 过去会被原样 base64 内联进快照，是磁盘与内存的大头。
// 512 宽 + JPEG 0.85 在肉眼几乎无差别的前提下能把单张压到 30~80KB。
const AVATAR_MAX_WIDTH = 512;
const AVATAR_QUALITY = 0.85;

// data URL 的体量估算：base64 部分每 4 个字符 3 字节。
const estimateDataUrlBytes = (dataUrl) => {
    const text = String(dataUrl || '');
    const comma = text.indexOf(',');
    if (comma < 0) return 0;
    const payload = text.length - comma - 1;
    if (!/;base64/i.test(text.slice(0, comma))) return payload;
    const padding = text.endsWith('==') ? 2 : (text.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(payload / 4) * 3 - padding);
};

// 把头像压到适合内联存储的大小。
//   * 本来就不是 data URL（例如 http 地址、空值）→ 原样返回
//   * 已经是小图（未超过阈值且体积不大）→ 原样返回，避免每次加载都重编码
//   * 压缩后反而更大（小图转 JPEG 可能变大）→ 保留原图
// 失败一律退回原值：宁可头像大一点，也不能把头像弄丢。
const shrinkAvatarDataUrl = async (dataUrl, options = {}) => {
    const text = String(dataUrl || '');
    if (!text.startsWith('data:image/')) return text;

    const maxWidth = Number(options.maxWidth) > 0 ? Number(options.maxWidth) : AVATAR_MAX_WIDTH;
    const quality = Number(options.quality) > 0 ? Number(options.quality) : AVATAR_QUALITY;
    // SVG 等矢量图体积本来就小，重编码成位图只会变糊。
    if (/^data:image\/svg/i.test(text)) return text;

    const originalBytes = estimateDataUrlBytes(text);
    const minBytes = Number(options.minBytes) > 0 ? Number(options.minBytes) : 64 * 1024;
    if (originalBytes > 0 && originalBytes <= minBytes) return text;

    try {
        const image = await new Promise((resolve, reject) => {
            const element = new Image();
            element.onload = () => resolve(element);
            element.onerror = () => reject(new Error('头像解码失败'));
            element.src = text;
        });
        // 尺寸已经很小且体积不大时没必要重编码。
        if (image.width <= maxWidth && originalBytes <= minBytes * 4) return text;

        const scale = Math.min(1, maxWidth / image.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        // 头像可能是透明 PNG：先铺白底，避免转 JPEG 后透明区域变黑。
        context.fillStyle = '#FFFFFF';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const compressed = canvas.toDataURL('image/jpeg', quality);
        // 压完更大就用原图（小尺寸 PNG 转 JPEG 常见）。
        return estimateDataUrlBytes(compressed) < originalBytes ? compressed : text;
    } catch {
        return text;
    }
};

// 判断一个头像是否值得压缩（给「一键压缩」统计用）。
const isAvatarWorthShrinking = (dataUrl) => {
    const text = String(dataUrl || '');
    if (!text.startsWith('data:image/')) return false;
    if (/^data:image\/svg/i.test(text)) return false;
    if (/^data:image\/jpeg/i.test(text)) return false;
    return estimateDataUrlBytes(text) > 64 * 1024;
};

const readUsageNumber = (...values) => {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return Math.round(number);
    }
    return null;
};

const getApiUsagePayload = (data) => {
    if (data?.usage && typeof data.usage === 'object') return data.usage;
    if (data?.usageMetadata && typeof data.usageMetadata === 'object') return data.usageMetadata;
    return null;
};


const normalizeApiUsage = (usage) => {
    const source = usage && typeof usage === 'object' ? usage : {};
    const promptDetails = source.prompt_tokens_details || source.input_tokens_details || {};
    const completionDetails = source.completion_tokens_details || source.output_tokens_details || {};
    const cacheReadTokens = readUsageNumber(
        promptDetails.cached_tokens,
        promptDetails.cache_read_tokens,
        source.cache_read_input_tokens,
        source.cache_read_tokens,
        source.cachedContentTokenCount,
        source.cached_content_token_count
    );
    const reportedCacheWriteTokens = readUsageNumber(
        promptDetails.cache_creation_tokens,
        promptDetails.cache_write_tokens,
        source.cache_creation_input_tokens,
        source.cache_creation_tokens,
        source.cache_write_input_tokens,
        source.cache_write_tokens
    );
    const cacheWriteTokens = reportedCacheWriteTokens ?? 0;
    const promptTokens = readUsageNumber(
        source.prompt_tokens,
        source.promptTokenCount,
        source.inputTokenCount
    );
    const nativeInputTokens = readUsageNumber(source.input_tokens);
    const inputTokens = promptTokens !== null
        ? promptTokens
        : nativeInputTokens !== null
            ? nativeInputTokens + (cacheReadTokens || 0) + cacheWriteTokens
            : null;
    const outputTokens = readUsageNumber(
        source.completion_tokens,
        source.output_tokens,
        source.candidatesTokenCount,
        source.outputTokenCount
    );
    const reasoningTokens = readUsageNumber(
        completionDetails.reasoning_tokens,
        source.reasoning_tokens,
        source.thoughtsTokenCount
    );
    let totalTokens = readUsageNumber(source.total_tokens, source.totalTokenCount);
    if (totalTokens === null && (inputTokens !== null || outputTokens !== null)) {
        totalTokens = (inputTokens || 0) + (outputTokens || 0);
    }
    const reported = [inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens, reportedCacheWriteTokens]
        .some(value => value !== null);
    return { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, reported };
};

const stringifyErrorDetail = (detail) => {
    if (detail === null || detail === undefined) return '';
    if (typeof detail === 'string') return detail;
    try {
        return JSON.stringify(detail, null, 2);
    } catch (_) {
        return String(detail);
    }
};

const getApiErrorStatus = (payload, fallbackStatus) => {
    const candidates = [
        payload?.status,
        payload?.statusCode,
        payload?.code,
        payload?.error?.status,
        payload?.error?.statusCode,
        payload?.error?.code,
        fallbackStatus
    ];
    return candidates.find(value => (
        value !== undefined && value !== null && value !== '' && /^\d+$/.test(String(value))
    )) || '';
};

const formatApiErrorMessage = (status, detail) => {
    const lines = [];
    if (status !== undefined && status !== null && status !== '') lines.push(`API Error: ${status}`);
    lines.push(stringifyErrorDetail(detail).trim() || '请求失败');
    return lines.join('\n');
};

const extractApiErrorMessage = (payload, fallbackStatus = '') => {
    if (!payload || typeof payload !== 'object') return '';
    const error = payload.error;
    const status = getApiErrorStatus(payload, fallbackStatus);
    if (typeof error === 'string') return formatApiErrorMessage(status, error);
    if (error && typeof error === 'object') {
        return formatApiErrorMessage(
            status,
            error.message || error.detail || payload.message || payload.detail || error
        );
    }
    const detail = payload.message || payload.detail;
    return detail ? formatApiErrorMessage(status, detail) : '';
};

window.RPHubUtils = {
    AVATAR_MAX_WIDTH,
    AVATAR_QUALITY,
    compressImage,
    defaultAvatar,
    estimateDataUrlBytes,
    extractApiErrorMessage,
    formatApiErrorMessage,
    generateUUID,
    getApiUsagePayload,
    getImageTagRegex,
    isAvatarWorthShrinking,
    normalizeApiUsage,
    parseCot,
    shrinkAvatarDataUrl,
    stringifyErrorDetail
};
})();

// --- Character-card utilities ---
(function () {
    const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

    const { imageStyleArtists } = window.RPHubBuiltinContent;
    const getImageStyleArtists = (style, customArtists = '') => {
        if (style === 'custom') return customArtists || '';
        const normalizedStyle = style === 'default' ? 'vertical' : style === 'hentai' ? 'r18' : style;
        return imageStyleArtists[normalizedStyle] || imageStyleArtists.vertical;
    };

    const normalizeNativeReasoningPart = (value) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(normalizeNativeReasoningPart).join('');
        if (typeof value === 'object') {
            const keys = ['text', 'content', 'summary', 'reasoning', 'reasoning_content', 'thinking', 'thought', 'value'];
            for (const key of keys) {
                const text = normalizeNativeReasoningPart(value[key]);
                if (text) return text;
            }
            return '';
        }
        return String(value);
    };

    const isNativeReasoningPart = part => part?.thought === true
        || /reason|thinking|thought/i.test(String(part?.type || ''));

    const extractNativeReasoning = (source = {}) => {
        if (!source || typeof source !== 'object') return '';
        const directKeys = ['reasoning_content', 'reasoning', 'thinking', 'thinking_content', 'thought', 'thoughts', 'reasoning_text'];
        for (const key of directKeys) {
            const text = normalizeNativeReasoningPart(source[key]);
            if (text) return text;
        }
        if (Array.isArray(source.reasoning_details)) {
            const text = normalizeNativeReasoningPart(source.reasoning_details);
            if (text) return text;
        }
        if (Array.isArray(source.content)) {
            return source.content.filter(isNativeReasoningPart).map(normalizeNativeReasoningPart).join('');
        }
        return '';
    };

    const normalizeRegexModifiers = (pattern, flags = 'g') => {
        let normalizedPattern = pattern;
        let normalizedFlags = flags;
        for (const modifier of ['s', 'i', 'm']) {
            const marker = `(?${modifier})`;
            if (!normalizedPattern.includes(marker)) continue;
            normalizedPattern = normalizedPattern.split(marker).join('');
            if (!normalizedFlags.includes(modifier)) normalizedFlags += modifier;
        }
        return { pattern: normalizedPattern, flags: normalizedFlags };
    };

    const protectedContentPattern = /(<!DOCTYPE html>[\s\S]*?<\/html>|<html\b[^>]*>[\s\S]*?<\/html>|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!DOCTYPE html>[\s\S]*$|<html\b[^>]*>[\s\S]*$|<script\b[^>]*>[\s\S]*$|<style\b[^>]*>[\s\S]*$|<ui_template_updates\b[^>]*>[\s\S]*?(?:<\/ui_template_updates>|$)|<!--[\s\S]*?(?:-->|$)|```[\s\S]*?```|```[\s\S]*$|`[^`]+`|<\/?[a-zA-Z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>)/gi;
    const exactProtectedContentPattern = new RegExp('^' + protectedContentPattern.source + '$', 'i');
    const splitProtectedText = (text) => {
        const source = String(text || '');
        const parts = [];
        const appendPlain = value => value.split(protectedContentPattern).forEach(part => {
            if (part) parts.push({ text: part, protected: exactProtectedContentPattern.test(part) });
        });
        let cursor = 0;
        for (const { start, end } of window.RPHubUtils.parseCot(source).ranges) {
            appendPlain(source.slice(cursor, start));
            parts.push({ text: source.slice(start, end), protected: true });
            cursor = end;
        }
        appendPlain(source.slice(cursor));
        return parts;
    };
    const transformUnprotectedText = (text, transform) => splitProtectedText(text)
        .map(part => part.protected ? part.text : transform(part.text))
        .join('');

    const findUnprotectedMatches = (text, pattern, { includeUiTemplateUpdates = false } = {}) => {
        const source = String(text || '');
        let offset = 0;
        const matches = [];
        splitProtectedText(source).forEach(({ text: part, protected: isProtected }) => {
            // 变量解析器只需看到块的开标签；块内 JSON 仍不参与普通匹配。
            const searchable = !isProtected ? part : includeUiTemplateUpdates
                ? (part.match(/^<ui_template_updates\b[^>]*>/i)?.[0] || '') : '';
            if (searchable) {
                const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
                const matcher = new RegExp(pattern.source, flags.replace('y', ''));
                let match;
                while ((match = matcher.exec(searchable)) !== null) {
                    match.index += offset;
                    matches.push(match);
                    if (!match[0]) matcher.lastIndex += 1;
                }
            }
            offset += part.length;
        });
        return matches;
    };
    const findLastUnprotectedMatch = (text, pattern, options) => {
        const match = findUnprotectedMatches(text, pattern, options).pop();
        return match ? { index: match.index, text: match[0] } : null;
    };

    const encodeUtf8 = (value) => {
        if (textEncoder) return textEncoder.encode(String(value ?? ''));
        const encoded = encodeURIComponent(String(value ?? ''));
        const bytes = [];
        for (let i = 0; i < encoded.length; i += 1) {
            if (encoded[i] === '%') {
                bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
                i += 2;
            } else {
                bytes.push(encoded.charCodeAt(i));
            }
        }
        return new Uint8Array(bytes);
    };

    const decodeUtf8 = (bytes) => {
        if (textDecoder) return textDecoder.decode(bytes);
        let encoded = '';
        for (let i = 0; i < bytes.length; i += 1) {
            const hex = bytes[i].toString(16);
            encoded += '%' + (hex.length === 1 ? '0' + hex : hex);
        }
        try {
            return decodeURIComponent(encoded);
        } catch (_) {
            let text = '';
            for (let i = 0; i < bytes.length; i += 1) {
                text += String.fromCharCode(bytes[i]);
            }
            return text;
        }
    };

    const toBytes = (value) => {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        throw new TypeError('Expected ArrayBuffer or Uint8Array');
    };

    const encodeBase64Utf8 = (value) => {
        const bytes = encodeUtf8(value);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };

    const decodeBase64Utf8 = (value) => {
        try {
            const binary = atob(String(value || '').trim());
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
                bytes[i] = binary.charCodeAt(i);
            }
            return decodeUtf8(bytes);
        } catch (_) {
            return String(value || '');
        }
    };

    const readPngChunks = (buffer) => {
        const bytes = toBytes(buffer);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const chunks = {};
        let offset = 8;

        try {
            while (offset + 8 <= bytes.byteLength) {
                const length = view.getUint32(offset, false);
                const type = String.fromCharCode(
                    view.getUint8(offset + 4),
                    view.getUint8(offset + 5),
                    view.getUint8(offset + 6),
                    view.getUint8(offset + 7)
                );
                const dataStart = offset + 8;
                const dataEnd = dataStart + length;
                if (dataEnd + 4 > bytes.byteLength) break;

                const data = bytes.slice(dataStart, dataEnd);
                if (type === 'tEXt') {
                    const splitIndex = data.indexOf(0);
                    if (splitIndex !== -1) {
                        const key = decodeUtf8(data.slice(0, splitIndex));
                        chunks[key] = decodeUtf8(data.slice(splitIndex + 1));
                    }
                } else if (type === 'iTXt') {
                    let cursor = 0;
                    while (cursor < data.length && data[cursor] !== 0) cursor += 1;
                    const key = decodeUtf8(data.slice(0, cursor));
                    cursor += 1;

                    if (cursor + 2 <= data.length) {
                        const compressionFlag = data[cursor];
                        cursor += 2;
                        while (cursor < data.length && data[cursor] !== 0) cursor += 1;
                        cursor += 1;
                        while (cursor < data.length && data[cursor] !== 0) cursor += 1;
                        cursor += 1;

                        if (key && cursor < data.length && compressionFlag === 0) {
                            chunks[key] = decodeUtf8(data.slice(cursor));
                        }
                    }
                }

                offset += 12 + length;
            }
        } catch (error) {
            console.warn('PNG chunk read failed:', error);
        }

        return chunks;
    };

    const findPngCharacterPayload = (chunks) => {
        if (chunks.chara) return chunks.chara;
        if (chunks.ccv3) return chunks.ccv3;
        return Object.values(chunks).find((value) => {
            const text = String(value || '').trim();
            return text.length > 50 && (text.startsWith('{') || text.startsWith('ey'));
        }) || '';
    };

    const parseCharacterPayload = (payload) => {
        try {
            return JSON.parse(decodeBase64Utf8(payload));
        } catch (_) {
            return JSON.parse(String(payload || ''));
        }
    };

    const parsePngCharacterData = (buffer) => {
        const chunks = readPngChunks(buffer);
        const payload = findPngCharacterPayload(chunks);
        if (!payload) {
            const error = new Error('No character data found in PNG');
            error.chunks = chunks;
            throw error;
        }
        return {
            chunks,
            payload,
            data: parseCharacterPayload(payload)
        };
    };

    const mapExportItems = (items, mapper) => (
        Array.isArray(items) ? items.map((item, index) => mapper(item, index)) : []
    );

    const cloneJsonValue = (value, fallback) => {
        if (value === undefined || value === null) return fallback;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_) {
            return fallback;
        }
    };

    const toNumber = (value, fallback = null) => {
        if (value === undefined || value === null || value === '') return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const toBoolean = (value, fallback = false) => {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true') return true;
            if (normalized === 'false') return false;
        }
        return !!value;
    };

    const normalizeRegexScript = (script = {}, options = {}) => {
        const normalized = { ...script };
        const fallbackScope = options.fallbackScope || 'character';
        const systemNames = Array.isArray(options.systemNames) ? options.systemNames : [];
        if (normalized.disabled !== undefined) normalized.enabled = !normalized.disabled;
        else if (normalized.enabled === undefined) normalized.enabled = true;
        if (!normalized.name && normalized.scriptName) normalized.name = normalized.scriptName;
        if (!normalized.regex && normalized.findRegex) normalized.regex = normalized.findRegex;
        if (!normalized.replacement && normalized.replaceString) normalized.replacement = normalized.replaceString;
        if (!normalized.flags && normalized.regexFlags) normalized.flags = normalized.regexFlags;
        if (!normalized.flags) normalized.flags = 'g';
        if (!Array.isArray(normalized.placement)) normalized.placement = [1, 2];
        if (normalized.markdownOnly === undefined) normalized.markdownOnly = false;
        if (normalized.promptOnly === undefined) normalized.promptOnly = false;
        if (normalized.markdownOnly && normalized.promptOnly) normalized.promptOnly = false;
        if (normalized.runOnEdit === undefined) normalized.runOnEdit = false;
        if (normalized.minDepth === undefined) normalized.minDepth = null;
        if (normalized.maxDepth === undefined) normalized.maxDepth = null;
        normalized.scope = normalized.scope === 'global'
            || fallbackScope === 'global'
            || systemNames.includes(normalized.name || normalized.scriptName)
            ? 'global'
            : 'character';
        delete normalized.disabled;
        return normalized;
    };

    const normalizeImportedRegexScript = (script = {}, options = {}) => {
        const normalized = { ...script };
        if (!normalized.name) normalized.name = normalized.scriptName || 'Regex Script';
        if (!normalized.regex) normalized.regex = normalized.findRegex || '';
        if (normalized.regex.startsWith('/') && normalized.regex.lastIndexOf('/') > 0) {
            const lastSlash = normalized.regex.lastIndexOf('/');
            const possibleFlags = normalized.regex.slice(lastSlash + 1);
            if (/^[gimsuy]*$/.test(possibleFlags)) {
                normalized.flags = possibleFlags;
                normalized.regex = normalized.regex.slice(1, lastSlash);
            }
        }
        if (!normalized.replacement && normalized.replaceString) normalized.replacement = normalized.replaceString;
        if (!normalized.flags) normalized.flags = normalized.regexFlags || 'g';
        if (!normalized.placement) normalized.placement = script.placement || [1, 2];
        if (normalized.markdownOnly === undefined) normalized.markdownOnly = script.markdownOnly || false;
        if (normalized.promptOnly === undefined) normalized.promptOnly = script.promptOnly || false;
        if (normalized.runOnEdit === undefined) normalized.runOnEdit = script.runOnEdit || false;
        if (normalized.minDepth === undefined) normalized.minDepth = script.minDepth || null;
        if (normalized.maxDepth === undefined) normalized.maxDepth = script.maxDepth || null;
        return normalizeRegexScript(normalized, options);
    };

    const normalizeWorldInfoEntry = (entry = {}, options = {}) => {
        const mergedEntry = { ...entry };
        Object.entries(entry.extensions || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null) mergedEntry[key] = value;
        });
        delete mergedEntry.extensions;
        const systemNames = Array.isArray(options.systemNames) ? options.systemNames : [];
        const normalizeBoolean = (value, fallback) => {
            if (value === undefined || value === null) return fallback;
            if (typeof value === 'string') {
                if (value.toLowerCase() === 'false') return false;
                if (value.toLowerCase() === 'true') return true;
            }
            return !!value;
        };
        const getValue = (keys, fallback) => {
            for (const key of keys) {
                if (mergedEntry[key] !== undefined && mergedEntry[key] !== null) return mergedEntry[key];
            }
            return fallback;
        };

        let keys = mergedEntry.keys || mergedEntry.key || [];
        if (typeof keys === 'string') keys = keys.split(/[,，]/).map(key => key.trim()).filter(Boolean);
        else if (!Array.isArray(keys)) keys = [];

        const validPositions = ['system_top', 'global_note', 'before_char', 'after_char', 'at_depth', 'user_top', 'assistant_top'];
        const positionAliases = {
            before_character: 'before_char',
            after_character: 'after_char',
            character_top: 'before_char',
            character_bottom: 'after_char',
            before_examples: 'before_char',
            after_examples: 'after_char',
            example_top: 'before_char',
            example_bottom: 'after_char',
            an_top: 'global_note',
            author_note: 'global_note',
            an_bottom: 'global_note'
        };
        let position = 'at_depth';
        const rawPosition = mergedEntry.position;
        if (typeof rawPosition === 'string') {
            const normalizedPosition = rawPosition.toLowerCase().replace(/ /g, '_');
            const mappedPosition = positionAliases[normalizedPosition] || normalizedPosition;
            if (validPositions.includes(mappedPosition)) position = mappedPosition;
        } else if (typeof rawPosition === 'number') {
            position = ({ 0: 'before_char', 1: 'after_char', 2: 'global_note', 3: 'global_note', 4: 'at_depth' })[rawPosition]
                || 'at_depth';
        }

        const comment = getValue(['comment'], '');
        return {
            comment,
            content: getValue(['content'], ''),
            enabled: normalizeBoolean(getValue(['enabled'], true), true)
                && !normalizeBoolean(getValue(['disable', 'disabled'], false), false),
            scope: systemNames.includes(comment) || getValue(['scope'], 'character') === 'global' ? 'global' : 'character',
            keys,
            useRegex: normalizeBoolean(getValue(['use_regex', 'useRegex'], false), false),
            constant: normalizeBoolean(getValue(['constant'], false), false),
            position,
            order: toNumber(getValue(['insertion_order', 'order'], 0), 0),
            depth: toNumber(getValue(['depth'], 4), 4),
            scanDepth: toNumber(getValue(['scan_depth', 'scanDepth'], null), null),
            probability: toNumber(getValue(['probability'], 100), 100),
            useProbability: normalizeBoolean(getValue(['useProbability', 'use_probability'], true), true)
        };
    };

    const parseWorldInfoKeysText = (text, preserveRegex = false) => {
        const rawText = String(text || '');
        if (!preserveRegex) return rawText.split(/[,，]/).map(key => key.trim()).filter(Boolean);

        const parts = [];
        let current = '';
        let inRegex = false;
        let inClass = false;
        let escaped = false;
        for (const character of rawText) {
            if (escaped) {
                current += character;
                escaped = false;
            } else if (inRegex) {
                current += character;
                if (character === '\\') escaped = true;
                else if (character === '[') inClass = true;
                else if (character === ']') inClass = false;
                else if (character === '/' && !inClass) inRegex = false;
            } else if (character === ',' || character === '，') {
                parts.push(current);
                current = '';
            } else {
                if (character === '/' && !current.trim()) inRegex = true;
                current += character;
            }
        }
        parts.push(current);
        return parts.map(key => key.trim()).filter(Boolean);
    };

    const parseImportedCharacterCard = (rawData = {}) => {
        const source = rawData && typeof rawData === 'object' ? rawData : {};
        const character = source.data && typeof source.data === 'object' ? source.data : source;
        const characterBook = character.character_book || source.character_book || null;
        const regexScripts = character.extensions?.regex_scripts
            || source.extensions?.regex_scripts
            || character.regex_scripts
            || source.regex_scripts
            || [];
        const uiTemplates = character.uiTemplates
            || character.ui_templates
            || source.uiTemplates
            || source.ui_templates
            || character.extensions?.ui_templates
            || character.extensions?.rp_hub_ui_templates
            || source.extensions?.ui_templates
            || source.extensions?.rp_hub_ui_templates
            || [];

        let worldInfoEntries = [];
        if (Array.isArray(characterBook?.entries)) worldInfoEntries = characterBook.entries;
        else if (characterBook?.entries && typeof characterBook.entries === 'object') {
            worldInfoEntries = Object.values(characterBook.entries);
        } else if (Array.isArray(characterBook)) worldInfoEntries = characterBook;

        return {
            name: character.name || character.char_name || 'Unknown',
            description: character.description || character.char_persona || '',
            personality: character.personality || '',
            first_mes: character.first_mes || '',
            creator_notes: character.creator_notes || character.creatorcomment || character.creator_comment || '',
            regexScripts: Array.isArray(regexScripts) ? regexScripts : [],
            uiTemplates: Array.isArray(uiTemplates) ? uiTemplates : [],
            worldInfoEntries
        };
    };

    const toWorldInfoExportEntry = (entry = {}) => ({
        comment: entry.comment || entry.name || '',
        content: entry.content || '',
        enabled: toBoolean(entry.enabled, true),
        scope: entry.scope || 'character',
        keys: Array.isArray(entry.keys) ? entry.keys : [],
        useRegex: toBoolean(entry.useRegex, false),
        constant: toBoolean(entry.constant, false),
        position: entry.position || 'at_depth',
        order: toNumber(entry.order, 0),
        depth: toNumber(entry.depth, 4),
        scanDepth: toNumber(entry.scanDepth, null),
        probability: toNumber(entry.probability, 100),
        useProbability: toBoolean(entry.useProbability, true)
    });

    const toRegexExportEntry = (script = {}) => {
        const placement = Array.isArray(script.placement)
            ? script.placement.map(Number).filter(value => value === 1 || value === 2)
            : [1, 2];
        const markdownOnly = toBoolean(script.markdownOnly, false);
        const promptOnly = markdownOnly ? false : toBoolean(script.promptOnly, false);

        return {
            name: script.name || script.scriptName || '',
            regex: script.regex || script.findRegex || '',
            flags: script.flags || script.regexFlags || 'g',
            replacement: script.replacement !== undefined ? script.replacement : (script.replaceString || ''),
            placement: placement.length ? placement : [2],
            markdownOnly,
            promptOnly,
            runOnEdit: toBoolean(script.runOnEdit, false),
            minDepth: toNumber(script.minDepth, null),
            maxDepth: toNumber(script.maxDepth, null),
            scope: script.scope || 'character',
            disabled: script.disabled !== undefined
                ? toBoolean(script.disabled, false)
                : !toBoolean(script.enabled, true)
        };
    };

    const toUiTemplateExportEntry = (template = {}, options = {}) => {
        const variableState = cloneJsonValue(template.variableState, {});
        return {
            id: template.id,
            name: template.name || 'UI模板',
            enabled: template.enabled !== false,
            scope: options.scope || template.scope || 'character',
            order: toNumber(template.order, 100),
            placement: ['top', 'bottom'].includes(template.placement) ? template.placement : 'bottom',
            htmlTemplate: template.htmlTemplate || template.template || '',
            initialVariableState: cloneJsonValue(template.initialVariableState, variableState),
            variableSchema: (typeof template.variableSchema === 'string' || typeof template.variableSchema === 'object')
                ? cloneJsonValue(template.variableSchema, template.variableSchema)
                : '',
            updateMode: template.updateMode || 'merge'
        };
    };

    const buildCharacterCardData = (character = {}, options = {}) => {
        const worldInfoMapper = options.worldInfoMapper || toWorldInfoExportEntry;
        const regexScriptMapper = options.regexScriptMapper || toRegexExportEntry;
        const uiTemplateMapper = options.uiTemplateMapper || toUiTemplateExportEntry;
        const includeUiTemplates = options.includeUiTemplates !== false;
        const worldEntries = mapExportItems(
            character.worldInfo,
            worldInfoMapper
        );
        const regexScripts = mapExportItems(
            character.regexScripts,
            regexScriptMapper
        );
        const uiTemplates = includeUiTemplates
            ? mapExportItems(character.uiTemplates, uiTemplateMapper)
            : [];

        const data = {
            name: character.name,
            description: character.description,
            personality: character.personality,
            first_mes: character.first_mes,
            creator_notes: character.creator_notes || 'Exported from RolePlay Hub',
            ...(includeUiTemplates ? { uiTemplates } : {}),
            extensions: {
                rp_hub_watermark: 'rp-hub',
                regex_scripts: regexScripts,
                ...(includeUiTemplates ? { rp_hub_ui_templates: uiTemplates } : {})
            },
            character_book: worldEntries.length > 0 ? { entries: worldEntries } : undefined
        };

        return { data };
    };

    const crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crc32Table[i] = c;
    }

    const crc32 = (bytes) => {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i += 1) {
            crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[i]) & 0xFF];
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    };

    const createTextChunk = (key, value) => {
        const type = encodeUtf8('tEXt');
        const keyData = encodeUtf8(key);
        const valueData = encodeUtf8(value);
        const chunkData = new Uint8Array(keyData.length + 1 + valueData.length);
        chunkData.set(keyData, 0);
        chunkData[keyData.length] = 0;
        chunkData.set(valueData, keyData.length + 1);

        const crcInput = new Uint8Array(type.length + chunkData.length);
        crcInput.set(type, 0);
        crcInput.set(chunkData, type.length);

        const fullChunk = new Uint8Array(12 + chunkData.length);
        const view = new DataView(fullChunk.buffer);
        view.setUint32(0, chunkData.length, false);
        fullChunk.set(type, 4);
        fullChunk.set(chunkData, 8);
        view.setUint32(8 + chunkData.length, crc32(crcInput), false);
        return fullChunk;
    };

    const injectPngTextChunk = (pngBuffer, key, value) => {
        const pngBytes = toBytes(pngBuffer);
        const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
        const textChunk = createTextChunk(key, value);
        let insertPos = 33;
        let offset = 8;

        while (offset + 8 <= pngBytes.byteLength) {
            const length = view.getUint32(offset, false);
            const type = String.fromCharCode(
                view.getUint8(offset + 4),
                view.getUint8(offset + 5),
                view.getUint8(offset + 6),
                view.getUint8(offset + 7)
            );
            const nextOffset = offset + 12 + length;
            if (type === 'IHDR') {
                insertPos = nextOffset;
                break;
            }
            offset = nextOffset;
        }

        const result = new Uint8Array(pngBytes.length + textChunk.length);
        result.set(pngBytes.slice(0, insertPos), 0);
        result.set(textChunk, insertPos);
        result.set(pngBytes.slice(insertPos), insertPos + textChunk.length);
        return result;
    };

    const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });

    const imageUrlToPngBytes = (src, options = {}) => new Promise((resolve, reject) => {
        const img = new Image();
        if (options.crossOrigin !== undefined && options.crossOrigin !== null) {
            img.crossOrigin = options.crossOrigin;
        }
        if (options.referrerPolicy) {
            img.referrerPolicy = options.referrerPolicy;
        }
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(async (blob) => {
                if (!blob) {
                    reject(new Error('Could not create PNG blob'));
                    return;
                }
                try {
                    resolve(new Uint8Array(await blob.arrayBuffer()));
                } catch (error) {
                    reject(error);
                }
            }, 'image/png');
        };
        img.onerror = () => reject(new Error('Could not load image'));
        img.src = src;
    });

    const downloadBlob = (blob, filename, options = {}) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        if (options.targetBlank) a.target = '_blank';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        const cleanup = () => {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(url);
        };
        const delay = Number(options.revokeDelay || 0);
        if (delay > 0) {
            setTimeout(cleanup, delay);
        } else {
            cleanup();
        }
    };

    window.RPHubCardUtils = {
        blobToDataUrl,
        buildCharacterCardData,
        decodeBase64Utf8,
        downloadBlob,
        encodeBase64Utf8,
        extractNativeReasoning,
        findPngCharacterPayload,
        findLastUnprotectedMatch,
        findUnprotectedMatches,
        isNativeReasoningPart,
        getImageStyleArtists,
        imageUrlToPngBytes,
        injectPngTextChunk,
        normalizeImportedRegexScript,
        normalizeRegexScript,
        normalizeRegexModifiers,
        normalizeWorldInfoEntry,
        parseImportedCharacterCard,
        parseCharacterPayload,
        parseWorldInfoKeysText,
        parsePngCharacterData,
        readPngChunks,
        toBoolean,
        toNumber,
        toRegexExportEntry,
        toUiTemplateExportEntry,
        toWorldInfoExportEntry,
        transformUnprotectedText
    };
})();

// --- Application configuration ---
(function () {
    window.RPHubConfig = Object.freeze({
        systemRegexNames: Object.freeze(['NAI画图正则']),
        systemWorldInfoNames: Object.freeze(['自动生图']),
        // 生图与聊天一样只走用户自填的接口；不再预置项目作者的网关。
        imageGenBaseUrl: '',
        defaultApiProviderId: 'custom',
        defaultApiConfig: Object.freeze({
            apiUrl: '',
            apiKey: '',
            model: '',
            qualityModel: '',
            balancedModel: '',
            fastModel: ''
        }),
        apiProviderOptions: Object.freeze([
            Object.freeze({
                id: 'deepseek',
                name: 'DeepSeek',
                apiUrl: 'https://api.deepseek.com/v1',
                icon: 'assets/vendor/providers/deepseek.ico'
            }),
            Object.freeze({
                id: 'openrouter',
                name: 'OpenRouter',
                apiUrl: 'https://openrouter.ai/api/v1',
                icon: 'assets/vendor/providers/openrouter.ico'
            }),
            Object.freeze({
                id: 'siliconflow',
                name: 'SiliconFlow',
                apiUrl: 'https://api.siliconflow.cn/v1',
                icon: 'assets/vendor/providers/siliconflow.ico'
            })
        ]),
        activeTools: window.RPHubBuiltinContent.activeTools,
        uiOptions: Object.freeze({
            popularModelFamilies: Object.freeze(['claude', 'gemini', 'deepseek', 'llama', 'glm', 'minimax', 'moonshot', 'grok']),
            presetRoles: Object.freeze([
                { value: 'system', label: '系统提示词' },
                { value: 'user', label: 'User消息' },
                { value: 'assistant', label: 'AI消息' }
            ]),
            presetRoleDisplayLabels: Object.freeze({ system: '系统', user: 'User', assistant: 'AI' }),
            fontFamilies: Object.freeze([
                { value: 'modern', label: '现代通用字体' },
                { value: 'serif', label: '衬线字体' },
                { value: 'system', label: '系统字体' }
            ]),
            fontSizes: Object.freeze([12, 13, 14, 15, 16, 17, 18, 19, 20].map(size => ({
                value: size,
                label: `${size}px`
            }))),
            imageStyles: Object.freeze([
                { value: 'vertical', label: '韩漫小清新风' },
                { value: 'comicDoujin', label: '动漫同人风' },
                { value: 'r18', label: '2.5D唯美风' },
                { value: 'lolita25d', label: '2.5D唯美风（萝）' },
                { value: 'anime', label: '本子里番风' },
                { value: 'galgame', label: 'GalGame风' },
                { value: 'custom', label: '自定义' }
            ]),
            imageModels: Object.freeze([
                { value: 'nai-diffusion-4-5-full', label: 'V4.5 完整版（-1）' },
                { value: 'nai-diffusion-5-full', label: 'V5 完整版（-5）' }
            ]),
            // 生图方式：
            //   novelai          第三方网关（RP Hub 作者的 nai.sta1n.cn 那套）：POST /api/jobs → 轮询 → content 取图
            //   novelai-official NovelAI 官方 API：POST /ai/generate-image → ZIP 字节流
            //   stable-diffusion Forge/A1111 的 sdapi 同步返回 base64
            //   comfyui          提交 API 格式工作流 → 进度/历史 → /view 取图
            imageProviders: Object.freeze([
                { value: 'novelai', label: 'NAI（RP Hub 网关）' },
                { value: 'novelai-official', label: 'NovelAI 官方 API' },
                { value: 'stable-diffusion', label: 'Stable Diffusion（Forge / A1111）' },
                { value: 'comfyui', label: 'ComfyUI（API 工作流）' }
            ]),
            // NovelAI 官方 API 常量（取自官方文档与官方 Python 库实测值）。
            novelaiOfficialBaseUrl: 'https://image.novelai.net',
            // NAI（RP Hub 网关）的出图参数默认值 = 网关自己的默认（nai.sta1n.cn 的 /api/settings）。
            // 以前本站硬编码成 steps=40 + 一条带残字的旧负面词，与网关界面/官方接口都对不上。
            naiGatewayDefaults: Object.freeze({
                steps: 28,
                scale: 6,
                cfg: 0,
                sampler: 'k_dpmpp_2m_sde',
                noiseSchedule: 'karras'
            }),
            // 默认负面词：网关历史值（就是原来硬编码在生图 URL 里的那条，含 ink eyes/owres/uta 等残字）。
            // 网关与官方共用同一份，两边默认就发同一段文本，避免「配置看起来一样、出图不一样」。
            naiDefaultNegative: '{{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,ink eyes,ink hair,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers}},{{missing legs}},{{{more than 2 nipples}}},mutated hands,{{{mutation}}},normal quality,owres,{{poorly drawn face}},{{poorly drawn hands}},reen eyes,signature,text,{{too many fingers}},{{{ugly}}},username,uta,watermark,worst quality,{{{more than 2 legs}}},awkward hand sign,weird hand gesture,contorted hand,unnatural finger pose,deformed hand gesture,{shaka},{hang loose},{{rock on}},{shaka sign}',
            // 网关采样器：value 必须用官方采样器 id（网关原样转给 NovelAI）。
            // 上一版（提交 5fe9b75）的默认值：网关服务端的「干净版」。仅在加载设置时做一次性比对，
            // 命中就清空该字段（= 用内置默认），用户自己写过的文本不受影响。
            naiLegacyCleanNegative: '{{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},{{missing legs}},mutated hands,{{{mutation}}},normal quality,poorly drawn face,{{poorly drawn hands}},signature,text,{{too many fingers}},{{{ugly}}},username,watermark,worst quality',
            naiGatewaySamplers: Object.freeze([
                { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE（网关默认）' },
                { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
                { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
                { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
                { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
                { value: 'k_euler', label: 'Euler' }
            ]),
            novelaiOfficialModels: Object.freeze([
                { value: 'nai-diffusion-5-full', label: 'V5 完整版（Full）' },
                { value: 'nai-diffusion-5-curated', label: 'V5 精选版（Curated）' },
                { value: 'nai-diffusion-4-5-full', label: 'V4.5 完整版（Full）' },
                { value: 'nai-diffusion-4-5-curated', label: 'V4.5 精选版（Curated）' },
                { value: 'nai-diffusion-4-full', label: 'V4 完整版（Full）' },
                { value: 'nai-diffusion-4-curated-preview', label: 'V4 精选版（Curated）' },
                { value: 'nai-diffusion-3', label: 'V3（Anime V3）' },
                // 官方库枚举里的写法就是 furry-3（不是 3-furry），不要顺手改名。
                { value: 'nai-diffusion-furry-3', label: 'V3 兽人（Furry）' }
            ]),
            // 官方采样器（来自官方库的 ImageSampler 枚举，去掉作者标注「不工作」的项）。
            novelaiOfficialSamplers: Object.freeze([
                'k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde',
                'k_dpmpp_sde', 'k_dpmpp_2s_ancestral', 'k_dpm_2', 'k_dpm_2_ancestral',
                'k_heun', 'k_lms', 'ddim', 'ddim_v3'
            ]),
            novelaiOfficialNoiseSchedules: Object.freeze([
                'native', 'karras', 'exponential', 'polyexponential'
            ]),
            // 负面提示词（UC）预设：官方是 0-4 的档位，不是文本。
            novelaiOfficialUcPresets: Object.freeze([
                { value: 0, label: '重度（Heavy）' },
                { value: 1, label: '轻量（Light）' },
                { value: 2, label: '人类优先（Human Focus）' },
                { value: 3, label: '兽人优先（Furry Focus）' },
                { value: 4, label: '无（None）' }
            ]),
            // 官方分辨率档位。
            // free=true 表示「Opus 订阅下不消耗 Anlas（免费）」——判定规则来自官方库
            // ImagePreset.calculate_cost：is_opus and steps <= 28 and 像素 <= 1024*1024。
            // 因此 1MP 及以下免费，超过 1MP 的（如 1024×1536、1472×1472、1088×1920）会扣 Anlas。
            novelaiOfficialResolutions: Object.freeze([
                { value: '832x1216', label: '竖图 832×1216（1.01MP）', width: 832, height: 1216, free: true },
                { value: '1216x832', label: '横图 1216×832（1.01MP）', width: 1216, height: 832, free: true },
                { value: '1024x1024', label: '方图 1024×1024（1.00MP）', width: 1024, height: 1024, free: true },
                { value: '640x640', label: '小方图 640×640', width: 640, height: 640, free: true },
                { value: '512x768', label: '小竖图 512×768', width: 512, height: 768, free: true },
                { value: '768x512', label: '小横图 768×512', width: 768, height: 512, free: true },
                { value: '512x512', label: '最小方图 512×512', width: 512, height: 512, free: true },
                { value: '1024x1536', label: '大竖图 1024×1536（1.57MP · 扣 Anlas）', width: 1024, height: 1536, free: false },
                { value: '1536x1024', label: '大横图 1536×1024（1.57MP · 扣 Anlas）', width: 1536, height: 1024, free: false },
                { value: '1472x1472', label: '大方图 1472×1472（2.17MP · 扣 Anlas）', width: 1472, height: 1472, free: false },
                { value: '1088x1920', label: '壁纸竖图 1088×1920（扣 Anlas）', width: 1088, height: 1920, free: false },
                { value: '1920x1088', label: '壁纸横图 1920×1088（扣 Anlas）', width: 1920, height: 1088, free: false }
            ]),
            // 官方 API 的免费挡位上限：步数 ≤28 且像素 ≤1MP。
            novelaiOfficialFreeSteps: 28,
            novelaiOfficialFreePixels: 1024 * 1024,
            novelaiOfficialSizeLimits: Object.freeze({ min: 64, max: 2048, step: 64 }),
            // ComfyUI 可调参数的角色：与具体节点类名解耦，探测结果可在设置页逐行改。
            comfyRoles: Object.freeze([
                { value: 'prompt', label: '正向提示词' },
                { value: 'negativePrompt', label: '负面提示词' },
                { value: 'width', label: '宽度' },
                { value: 'height', label: '高度' },
                { value: 'steps', label: '采样步数' },
                { value: 'cfg', label: 'CFG' },
                { value: 'sampler', label: '采样器' },
                { value: 'scheduler', label: '调度器' },
                { value: 'seed', label: '种子' },
                { value: 'batchSize', label: '批次数量' },
                { value: 'denoise', label: '重绘幅度' },
                { value: 'checkpoint', label: '底模' },
                { value: 'vae', label: 'VAE' },
                { value: 'filenamePrefix', label: '文件名前缀' },
                { value: 'none', label: '（不控制）' }
            ]),
            // ComfyUI 默认端口；仅作为输入框占位提示，不预置任何地址。
            comfyDefaultPort: 8188,
            imageSizes: Object.freeze([
                { value: '竖图', label: '竖图' },
                { value: '横图', label: '横图' },
                { value: '方图', label: '方图' }
            ]),
            // 尺寸像素：NovelAI 与 SD 共用同一套映射，避免两套尺寸语义。
            imageSizePixels: Object.freeze({
                '竖图': { width: 832, height: 1216 },
                '横图': { width: 1216, height: 832 },
                '方图': { width: 1024, height: 1024 }
            }),
            // SD 自定义分辨率预设：宽高都取 8 的倍数（sdapi 的硬性要求），
            // 总像素量贴着 SDXL 原生档（约 1M）上下浮动，兼顾比例与显存。
            sdSizePresets: Object.freeze([
                { value: 'portrait-2-3', label: '竖图 2:3 · 832×1216', width: 832, height: 1216 },
                { value: 'portrait-3-4', label: '竖图 3:4 · 896×1152', width: 896, height: 1152 },
                { value: 'portrait-9-16', label: '竖屏 9:16 · 768×1344', width: 768, height: 1344 },
                { value: 'square-1-1', label: '方图 1:1 · 1024×1024', width: 1024, height: 1024 },
                { value: 'landscape-4-3', label: '横图 4:3 · 1152×896', width: 1152, height: 896 },
                { value: 'landscape-3-2', label: '横图 3:2 · 1216×832', width: 1216, height: 832 },
                { value: 'landscape-16-9', label: '宽屏 16:9 · 1344×768', width: 1344, height: 768 },
                { value: 'custom', label: '自定义（手动填宽高）', width: 0, height: 0 }
            ]),
            // SD 分辨率的取值范围与栅格：低于 64 无意义，高于 4096 基本必然 OOM。
            sdSizeLimits: Object.freeze({ min: 64, max: 4096, step: 8 }),
            // SD 采样器常见项；实际可用列表由 /sdapi/v1/samplers 动态拉取后合并。
            sdSamplers: Object.freeze([
                'Euler a', 'Euler', 'DPM++ 2M', 'DPM++ 2M Karras', 'DPM++ 2M SDE',
                'DPM++ SDE', 'DPM++ 2M SDE Karras', 'DDIM', 'UniPC', 'Restart'
            ]),
            sdSchedulers: Object.freeze([
                'Automatic', 'Karras', 'Exponential', 'Polyexponential', 'SGM Uniform', 'Simple', 'Normal', 'DDIM', 'Beta'
            ]),
            imageCounts: Object.freeze([2, 3, 4, 5, 6, 7, 8].map(count => ({
                value: count,
                label: `${count} 张`
            }))),
            uiTemplatePlacements: Object.freeze([
                { value: 'top', label: '对话顶部' },
                { value: 'bottom', label: '对话底部' }
            ]),
            worldInfoPositions: Object.freeze([
                { group: '系统提示词', value: 'system_top', label: '最顶层' },
                { group: '系统提示词', value: 'global_note', label: '全局备注' },
                { group: '系统提示词', value: 'before_char', label: '角色设定前' },
                { group: '系统提示词', value: 'after_char', label: '角色设定后' },
                { group: '对话中', value: 'at_depth', label: '按深度插入' },
                { group: '对话中', value: 'user_top', label: '用户消息顶部' },
                { group: '对话中', value: 'assistant_top', label: '助手消息顶部' }
            ])
        }),
        latestUpdate: window.RPHubLatestUpdate
    });
})();

// --- 生图地址 / 分辨率：纯函数，便于单测（tools/test-image-pipeline.mjs）---
//
// 这里集中放「切换生图地址后历史图仍要能显示」与「SD 自定义分辨率」两件事的判定逻辑，
// 它们不依赖 Vue、DOM 或网络，是这两处 bug 最容易回归的地方。
(function () {
    const uiOptions = () => window.RPHubConfig?.uiOptions || {};
    const sizeLimits = () => uiOptions().sdSizeLimits || { min: 64, max: 4096, step: 8 };
    const sizeTable = () => uiOptions().imageSizePixels || {};
    const sizePresets = () => uiOptions().sdSizePresets || [];

    // sdapi 要求宽高为 8 的倍数；同时夹到合理区间，避免误填 0 或 99999。
    const normalizeSdDimension = (value, fallback) => {
        const { min, max, step } = sizeLimits();
        const number = Math.round(Number(value));
        if (!Number.isFinite(number) || number <= 0) return fallback;
        return Math.max(min, Math.min(max, Math.round(number / step) * step));
    };

    // 实际出图尺寸：开启自定义就走自定义宽高，否则沿用「生图比例」的语义尺寸。
    const resolveSdSize = (settings = {}) => {
        const table = sizeTable();
        const fallback = table['竖图'] || { width: 832, height: 1216 };
        if (settings.sdCustomSizeEnabled) {
            return {
                width: normalizeSdDimension(settings.sdCustomWidth, fallback.width),
                height: normalizeSdDimension(settings.sdCustomHeight, fallback.height)
            };
        }
        const size = table[settings.imageSize] || fallback;
        return { width: size.width, height: size.height };
    };

    // 解析任务结果的图片地址。
    // 顺序很关键：resolvedUrl 是「生成当时」固化下来的绝对地址，
    // 一旦用户切换了生图地址，若还用新 baseUrl 去拼旧 job id，新服务不认识该 job → 404 → 历史图消失。
    const resolveGeneratedImageUrl = (job, task) => {
        if (!job) return '';
        if (job.resolvedUrl) return job.resolvedUrl;
        if (job.directImage && job.imageUrl) return job.imageUrl;
        if (job.imageUrl) {
            try {
                return new URL(job.imageUrl, task?.baseUrl || 'http://localhost/').href;
            } catch {
                return String(job.imageUrl);
            }
        }
        if (job.id) {
            return `${task?.baseUrl || ''}/api/jobs/${encodeURIComponent(job.id)}/content?token=${encodeURIComponent(task?.token || '')}`;
        }
        return '';
    };

    // 卡片宽高比：优先生成时记录的真实像素，其次当时记下的语义比例，最后才看当前 URL 参数。
    const resolveGeneratedImageAspect = (job, requestUrl) => {
        const table = sizeTable();
        let width = Number(job?.width) || 0;
        let height = Number(job?.height) || 0;
        if (!width || !height) {
            const recorded = table[job?.sizeLabel];
            if (recorded) {
                width = recorded.width;
                height = recorded.height;
            }
        }
        if (!width || !height) {
            let size = '';
            try {
                const parsed = new URL(String(requestUrl || ''), 'http://localhost/');
                width = Number(parsed.searchParams.get('w')) || 0;
                height = Number(parsed.searchParams.get('h')) || 0;
                size = parsed.searchParams.get('size') || '';
            } catch { /* 地址不可解析时走语义兜底 */ }
            if (!width || !height) {
                const fallback = table[size] || table['竖图'] || { width: 832, height: 1216 };
                width = fallback.width;
                height = fallback.height;
            }
        }
        return { width, height };
    };

    // 预设 → 宽高；选到「custom」返回 null，表示保留用户手填的数值。
    const resolveSdSizePreset = (value) => {
        const preset = sizePresets().find(item => item.value === value);
        if (!preset || preset.value === 'custom' || !preset.width || !preset.height) return null;
        return { width: preset.width, height: preset.height };
    };

    // VAE 覆盖值：留空 = 不使用（不下发 sd_vae，模型自带 VAE 照常生效）。
    // 返回 null 表示「这次请求不碰 VAE 设置」，调用方据此决定要不要写 override_settings。
    // 注意：不能下发空串，Forge/A1111 收到空串会当成无效 VAE 名而报错。
    const resolveSdVaeOverride = (settings = {}) => {
        const raw = String(settings?.sdVae || '').trim();
        return raw ? raw : null;
    };

    // 从服务端返回的 VAE 条目里取出可读名字。
    // A1111 与 Forge 的字段名不完全一致（model_name / title / name），且 filename 是绝对路径，
    // 这里统一兜底，避免某一版服务端返回的列表在下拉里显示成空白。
    const normalizeSdVaeEntry = (item) => {
        if (typeof item === 'string') return item.trim();
        if (!item || typeof item !== 'object') return '';
        const direct = item.model_name || item.title || item.name || item.value;
        if (typeof direct === 'string' && direct.trim()) return direct.trim();
        const file = String(item.filename || item.path || '').split(/[\\/]/).pop() || '';
        return file.replace(/\.(safetensors|ckpt|pt|bin)$/i, '').trim();
    };

    // Forge 的 /sdapi/v1/sd-modules 把 VAE 与 text_encoder 混在同一个列表里返回
    // （Forge 源码里该接口就叫 get_sd_vaes_and_text_encoders，UI 标签是 "VAE / Text Encoder"）。
    // 这里按目录名把 text_encoder 剔掉，只留真正的 VAE。
    // 拿不到路径信息时不敢乱排除，宁可多留一项。
    const isSdVaeModulePath = (filepath) => {
        const normalized = String(filepath || '').replace(/\\/g, '/').toLowerCase();
        if (!normalized) return true;
        return !/(^|\/)text_encoder\//.test(normalized);
    };

    // 把服务端返回的 VAE 列表统一成下拉选项 [{value, label}]。
    //
    // 两个服务端的差异（都实测过）：
    //   - 标准 A1111: GET /sdapi/v1/sd-vae → sd_vae 传 VAE 名称（如 x.safetensors）
    //   - Forge neo : 没有 sd-vae，改用 GET /sdapi/v1/sd-modules；
    //                 且 sd_vae 必须传【绝对路径】，传文件名会 500「Model is corrupt or invalid」
    //                 （Forge 把该值直接交给 load_torch_file，不做名字解析）
    // 因此 value 就是「应当下发给服务端的值」，由 usePath 决定用路径还是名字。
    const parseSdVaeList = (items, options = {}) => {
        const usePath = options.usePath === true;
        const list = [];
        const seen = new Set();
        for (const item of (Array.isArray(items) ? items : [])) {
            const filepath = item && typeof item === 'object' ? String(item.filename || item.path || '') : '';
            if (usePath && !isSdVaeModulePath(filepath)) continue;
            const label = normalizeSdVaeEntry(item);
            if (!label) continue;
            const value = usePath && filepath ? filepath : label;
            if (seen.has(value)) continue;
            seen.add(value);
            list.push({ value, label });
        }
        return list;
    };

    // 每个生图预设各自携带的「出图参数」：决定画面长什么样。
    // 刻意不含 imageGenBaseUrl / imageProvider / imageGenKey（那是「连哪儿」，本来就按预设存），
    // 也不含 imageGenCount（期望张数属于这一次生成的操作习惯，不该被切预设改掉）。
    const IMAGE_PROFILE_FIELDS = Object.freeze([
        'imageStyle', 'customImageArtists', 'imageModel', 'imageSize',
        // NAI（RP Hub 网关）专用：这些是直接写进生图 URL 的出图参数。
        // 以前它们被硬编码在正则 URL 里（steps=40、那条旧负面词），界面上既看不到也改不了，
        // 于是「官方面板调的参数」与「网关实际收到的参数」对不上，两边永远对不齐。
        'naiGatewaySteps', 'naiGatewayScale', 'naiGatewayCfg', 'naiGatewaySampler',
        'naiGatewayNoiseSchedule', 'naiGatewayNegativePrompt',
        'sdModel', 'sdVae', 'sdSteps', 'sdCfgScale', 'sdSampler', 'sdScheduler',
        'sdLoras', 'sdPromptPrefix', 'sdNegativePrompt', 'sdKeepAspectRatio',
        'sdCustomSizeEnabled', 'sdSizePreset', 'sdCustomWidth', 'sdCustomHeight',
        // ComfyUI：工作流与绑定属于「这个服务上的这套配置」，随预设走。
        'comfyWorkflow', 'comfyBindings', 'comfyAutoDetect',
        'comfyPrompt', 'comfyNegativePrompt', 'comfySteps', 'comfyCfg',
        'comfySampler', 'comfyScheduler', 'comfySeed', 'comfyRandomizeSeed',
        'comfyWidth', 'comfyHeight', 'comfyBatchSize', 'comfyDenoise',
        'comfyCheckpoint', 'comfyVae', 'comfyFilenamePrefix', 'comfyOverrideSize',
        'comfyTimeout', 'comfyAllowCancel',
        // NovelAI 官方 API：出图参数随预设走。
        // 刻意不含 naiOfficialToken —— 鉴权信息统一由 imageGenKey 管理，
        // 放进 profile 会让切预设时静默换掉密钥。
        // 地址也只有一个（通用 imageGenBaseUrl），由预设的 url 字段承载。
        'naiOfficialModel', 'naiOfficialResolution',
        'naiOfficialCustomSizeEnabled', 'naiOfficialCustomWidth', 'naiOfficialCustomHeight',
        'naiOfficialSteps', 'naiOfficialScale', 'naiOfficialSampler', 'naiOfficialNoiseSchedule',
        'naiOfficialUcPreset', 'naiOfficialCfgRescale', 'naiOfficialQualityToggle',
        'naiOfficialVarietyBoost', 'naiOfficialNegativePrompt', 'naiOfficialSeed'
    ]);

    const captureImageProfile = (settings = {}) => {
        const profile = {};
        IMAGE_PROFILE_FIELDS.forEach(field => { profile[field] = settings[field]; });
        return profile;
    };

    // ===== 已完成图片缓存的「参数指纹」 =====
    // 起因：缓存原先只按提示词 tag 存。改了负面/风格/模型/步数后，同样的 tag 仍然命中旧图，
    // 表现为「参数改了却像没生效」。指纹把这些「决定画面长什么样」的输入算进去即可判定复用。
    // 注意：指纹只是**附加**在条目上，key 仍是 tag —— 老条目（没有指纹）按旧行为放行，
    // 避免升级后把历史图片全部重跑（官方 API 会花 Anlas）。
    const IMAGE_CACHE_VOLATILE_PARAMS = Object.freeze(['tag', 'token', 'nocache', 't']);

    const resolveImageCacheFingerprint = ({ settings = {}, requestUrl = '' } = {}) => {
        const parts = {
            provider: settings.imageProvider || '',
            baseUrl: settings.imageGenBaseUrl || '',
            profile: captureImageProfile(settings)
        };
        if (requestUrl) {
            try {
                // 请求 URL 里也带着一部分出图参数（网关的 steps/sampler/negative、SD 的 w/h）。
                const params = [...new URL(requestUrl, 'http://localhost').searchParams.entries()]
                    .filter(([key]) => !IMAGE_CACHE_VOLATILE_PARAMS.includes(key))
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
                parts.request = Object.fromEntries(params);
            } catch { /* 非法 URL 就只按设置算指纹 */ }
        }
        return JSON.stringify(parts);
    };

    // 缓存条目能不能复用：没记指纹的老条目一律复用（升级兼容），有指纹就必须完全一致。
    const shouldReuseCachedImageJob = (entry, fingerprint) => {
        if (!entry) return false;
        if (!entry.imageFingerprint) return true;
        return entry.imageFingerprint === fingerprint;
    };


    // 只覆盖 profile 里真正带了的字段，缺字段保持原值（老预设向前兼容）。
    const applyImageProfile = (settings, profile) => {
        if (!settings || !profile || typeof profile !== 'object') return false;
        let applied = false;
        IMAGE_PROFILE_FIELDS.forEach(field => {
            if (profile[field] === undefined) return;
            settings[field] = profile[field];
            applied = true;
        });
        return applied;
    };

    // 老存档的预设只有地址、没有出图参数：用当前这套补一份基线，
    // 让「每个预设各有一套参数」从升级当次就开始生效。
    const seedEndpointProfiles = (endpoints, settings) => {
        if (!Array.isArray(endpoints) || !endpoints.length) return false;
        const profile = captureImageProfile(settings);
        let seeded = false;
        endpoints.forEach(endpoint => {
            if (!endpoint || typeof endpoint !== 'object') return;
            if (endpoint.profile && typeof endpoint.profile === 'object') return;
            endpoint.profile = { ...profile };
            seeded = true;
        });
        return seeded;
    };

    // 缓存条目升级：归档成功后，把「图片本体」换成服务端地址。
    // 之前每台设备各自扛一份 base64 原图（SD 图 1–2MB/张，100 条就是上百 MB），
    // 换地址看别处的图还得重跑；换成短地址后，任何设备都直接取服务器上那一份。
    // 归档没给地址（服务不可用等）时原样返回，宁可继续留本地，也不让图片变成需要重新生成。
    const promoteImageJobToServer = (job, archive) => {
        if (!job || !archive) return job;
        const resolvedUrl = archive.url || archive.apiUrl;
        if (!resolvedUrl) return job;
        const next = { ...job, resolvedUrl };
        // SD 的整张图原本就存在 imageUrl 里（data URL），换成地址后本地不必再留着。
        if (typeof next.imageUrl === 'string' && next.imageUrl.startsWith('data:')) delete next.imageUrl;
        return next;
    };

    // 静态路径取不到图时（部署没配 nginx 的 /images/ 静态路径），退回同步服务的同源接口。
    // 入参是刚加载失败的那个地址；换不出更合适的地址就返回空串。
    const resolveArchivedImageFallbackUrl = (failedUrl, apiUrl) => {
        const match = String(failedUrl || '').match(/\/images\/([A-Za-z0-9._/-]+)$/);
        if (!match || !apiUrl) return '';
        return `${String(apiUrl).replace(/\/+$/, '')}/v1/images/${match[1]}`;
    };

    // 缓存里是否还留着「整张图」（base64）：用于把老条目按需补传到服务端。
    const isLocalBase64ImageJob = (job) => typeof job?.imageUrl === 'string' && job.imageUrl.startsWith('data:');

    // 缓存条目是否可以拿来直接回显。
    // 注意：归档后的 SD 条目只有 resolvedUrl（base64 已被替换掉），
    // 所以判断条件必须是「有地址」而不是「有 imageUrl」——否则重载后条目被丢掉，图会白白重生一次。
    const isRenderableImageJob = (job) => {
        if (!job || job.status !== 'done') return false;
        const hasResolved = typeof job.resolvedUrl === 'string' && job.resolvedUrl !== '';
        const hasInline = typeof job.imageUrl === 'string' && job.imageUrl !== '';
        return hasResolved || hasInline;
    };

    // 同步用的生图缓存整理：条目里只剩服务端短地址（几十字节）时可以随快照走，
    // 这样换设备也能直接看到旧图，不用各自重跑一遍；
    // 但升级前的老条目里是整张 base64（单张 1–2MB，100 张能顶到上百 MB，还撞过 128MB 的 413），
    // 这些一律只留本机、不进快照。
    const compactImageCacheForSync = (value) => {
        if (!value || typeof value !== 'object') return { entries: {}, dropped: 0 };
        const entries = {};
        let dropped = 0;
        for (const [tag, entry] of Object.entries(value)) {
            if (typeof entry?.imageUrl === 'string' && entry.imageUrl.startsWith('data:')) {
                dropped += 1;
                continue;
            }
            entries[tag] = entry;
        }
        return { entries, dropped };
    };

    // 两条 NAI 链路（RP Hub 网关 / 官方 API）共用的负面词取值：
    // 留空 = 用内置默认（网关历史值），这与 SD 面板「留空用内置默认」的语义一致。
    const resolveNaiNegativePrompt = (value) => {
        const text = String(value ?? '').trim();
        return text || String(window.RPHubConfig?.uiOptions?.naiDefaultNegative || '');
    };

    // ===== NAI（RP Hub 网关）出图参数写回生图 URL =====
    //
    // 正则 replacement 里嵌的就是生图 URL（`data-image-request`）。网关按 query 取参数，
    // 所以改了步数/采样器/负面词必须把 URL 重写一遍——老存档里那条硬编码的 steps=40
    // 与旧负面词，就是靠这里被换成当前设置值的。纯字符串处理，便于直接回归测试。
    const applyNaiGatewayUrlParams = (replacement, params = {}) => {
        const text = String(replacement || '');
        if (!text.includes('generate?tag=')) return text; // 非网关链路（官方/SD/ComfyUI）不动
        const negative = encodeURIComponent(String(params.negative ?? ''));
        // 注意用 [^&"]* 而不是 [^&]*：URL 嵌在 HTML 属性 data-image-request="…" 里，
        // 最后一个参数后面紧跟的是 `"`，用 [^&]* 会把 `">` 一起吃掉、把卡片结构搞坏。
        let next = text
            .replace(/steps=[^&"]*/, 'steps=' + String(params.steps ?? ''))
            .replace(/scale=[^&"]*/, 'scale=' + String(params.scale ?? ''))
            .replace(/cfg=[^&"]*/, 'cfg=' + String(params.cfg ?? ''))
            .replace(/sampler=[^&"]*/, 'sampler=' + String(params.sampler ?? ''))
            .replace(/noise_schedule=[^&"]*/, 'noise_schedule=' + String(params.noiseSchedule ?? ''));
        // negative 一定在 nocache 之前（URL 模板就是这么拼的），非贪婪匹配到 &nocache= 为止。
        next = next.replace(/negative=[\s\S]*?&nocache=/, 'negative=' + negative + '&nocache=');
        return next;
    };

    // ===== ComfyUI：API 格式工作流的解析、参数绑定与输出收集 =====
    //
    // ComfyUI 与 NAI/SD 的根本差异：它不认识「提示词」「步数」这些概念，只认识一张节点图。
    // 因此这里做的是「在用户自己的工作流里找到该改哪个节点的哪个输入」，而不是拼一份固定请求体。
    // 全部是纯函数（不碰 Vue/DOM/网络），便于 tools/test-image-pipeline.mjs 直接覆盖。

    // ComfyUI 的节点引用必须写成 [字符串节点id, 槽位]。
    // 部分工作流里 id 是数字（如 {"3": {...}} 被 JSON.stringify 后仍是字符串键，
    // 但手工粘贴的 JSON 可能写成 [3, 0]），这里统一转成字符串，避免服务端 KeyError。
    const normalizeComfyNodeRef = (ref) => {
        if (!Array.isArray(ref) || ref.length < 2) return null;
        const nodeId = ref[0];
        const slot = Number(ref[1]);
        if (nodeId === undefined || nodeId === null || !Number.isFinite(slot)) return null;
        return [String(nodeId), slot];
    };

    // 判断一个值是不是「节点引用」（形如 ["3", 0]），而不是普通标量。
    const isComfyNodeLink = (value) => Array.isArray(value)
        && value.length >= 2
        && (typeof value[0] === 'string' || typeof value[0] === 'number')
        && typeof value[1] === 'number';

    // 解析并校验一份 API 格式工作流。
    // 返回 { ok, prompt, nodes, error }；只有 ok 时才拿去提交，避免把坏 JSON 发到服务端才报错。
    const parseComfyWorkflow = (text) => {
        const raw = typeof text === 'string' ? text.trim() : text;
        if (!raw || (typeof raw === 'string' && !raw.length)) {
            return { ok: false, prompt: null, nodes: [], error: '工作流为空' };
        }
        let parsed = raw;
        if (typeof raw === 'string') {
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                return { ok: false, prompt: null, nodes: [], error: `JSON 解析失败：${error.message}` };
            }
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, prompt: null, nodes: [], error: '工作流必须是「节点id → 节点」的对象' };
        }
        // 容错：用户可能把 UI 图格式（含 nodes/links 数组）粘进来。
        // 这种格式不能直接运行，明确说清楚，而不是发出去让服务端报 key 错误。
        if (Array.isArray(parsed.nodes) && !parsed.class_type) {
            return {
                ok: false,
                prompt: null,
                nodes: [],
                error: '这看起来是 ComfyUI 的界面图格式（UI graph），请用「保存（API Format）」导出的 JSON'
            };
        }
        const nodes = [];
        for (const [nodeId, node] of Object.entries(parsed)) {
            if (!node || typeof node !== 'object') continue;
            if (!node.class_type) {
                // 顶层出现非节点键（如误把 _meta 放在最外层）时服务端会整份拒绝
                //（execution.py 的 validate_prompt 逐个顶层键要求 class_type），
                // 因此这里也说清楚是哪个键，而不是笼统报「缺少 class_type」。
                return {
                    ok: false,
                    prompt: null,
                    nodes: [],
                    error: `顶层键 ${nodeId} 不是节点（缺少 class_type）。注意 _meta 之类的元信息要放在节点内部，不能放在最外层`
                };
            }
            nodes.push({ id: String(nodeId), classType: String(node.class_type), inputs: node.inputs || {} });
        }
        if (!nodes.length) {
            return { ok: false, prompt: null, nodes: [], error: '工作流里没有可用节点' };
        }
        return { ok: true, prompt: parsed, nodes, error: '' };
    };

    // 从一个节点的 inputs 里挑出「可以被参数控制」的输入名（标量，不是节点连线）。
    // 节点连线（["3",0]）由工作流结构决定，不能当参数改。
    const scalarComfyInputs = (node) => Object.entries(node?.inputs || {})
        .filter(([, value]) => !isComfyNodeLink(value))
        .map(([name]) => name);

    // 各角色对应的「候选类名 → 候选输入名」，按优先级排列。
    // 探测是通用规则，不针对某个具体工作流；探测不到时用户可在设置页手改。
    //
    // textLike=true 的角色，其输入名在不同节点上写法不一（text / prompt / text_g…），
    // 因此找不到候选名时可以退而用第一个标量输入；
    // 其余角色的输入名是明确的（cfg 就是 cfg），**找不到就必须跳过**——
    // 否则会退化成「绑到第一个标量输入」，把 cfg 写进 steps 之类的字段，静默改坏生成参数。
    const COMFY_ROLE_RULES = Object.freeze({
        prompt: {
            classes: ['CLIPTextEncode', 'BNK_CLIPTextEncodeAdvanced', 'CLIPTextEncodeSDXL', 'TextEncodeQwenImageEdit', 'PromptExpansion'],
            inputs: ['text', 'prompt', 'positive', 'text_g', 'text_l'],
            textLike: true
        },
        negativePrompt: {
            classes: ['CLIPTextEncode', 'BNK_CLIPTextEncodeAdvanced', 'CLIPTextEncodeSDXL'],
            inputs: ['text', 'prompt'],
            textLike: true
        },
        width: { classes: ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLatentImagePresets'], inputs: ['width'] },
        height: { classes: ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLatentImagePresets'], inputs: ['height'] },
        batchSize: { classes: ['EmptyLatentImage', 'EmptySD3LatentImage'], inputs: ['batch_size'] },
        steps: { classes: ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'KSamplerSelect'], inputs: ['steps', 'noise_seed_steps'] },
        cfg: { classes: ['KSampler', 'KSamplerAdvanced', 'SamplerCustom'], inputs: ['cfg', 'cfg_scale'] },
        sampler: { classes: ['KSampler', 'KSamplerAdvanced', 'KSamplerSelect'], inputs: ['sampler_name', 'sampler'] },
        scheduler: { classes: ['KSampler', 'KSamplerAdvanced'], inputs: ['scheduler'] },
        seed: { classes: ['KSampler', 'KSamplerAdvanced', 'RandomNoise'], inputs: ['seed', 'noise_seed'] },
        denoise: { classes: ['KSampler', 'KSamplerAdvanced'], inputs: ['denoise'] },
        checkpoint: { classes: ['CheckpointLoaderSimple', 'CheckpointLoader', 'UNETLoader'], inputs: ['ckpt_name', 'unet_name'] },
        vae: { classes: ['VAELoader'], inputs: ['vae_name'] },
        filenamePrefix: { classes: ['SaveImage', 'SaveAnimatedWEBP'], inputs: ['filename_prefix'] }
    });

    // 找出工作流里「最终会落盘」的输出节点。
    // 输出节点 = 类名以 Save/Preview 开头，或是自定义节点里带 images/video/audio 输入且无输出的终端节点。
    const COMFY_OUTPUT_CLASS_RE = /^(Save|Preview)/;
    const comfyOutputNodes = (nodes) => nodes.filter(node => {
        const inputs = node?.inputs || {};
        const isNamedOutput = COMFY_OUTPUT_CLASS_RE.test(node?.classType || '');
        // SwarmUI/VHS 等自定义节点：类名不叫 Save，但吃 IMAGE/VIDEO/AUDIO 且没有下游输出。
        const hasMediaInput = ['images', 'image', 'video', 'audio', 'filename_prefix', 'frames']
            .some(name => name in inputs);
        return isNamedOutput || hasMediaInput;
    });

    // 自动探测参数绑定：为每个角色找一组 { nodeId, input }。
    //
    // 关键细节：CLIPTextEncode 有很多个（正/负提示词各一个），不能都绑到同一个。
    // 正向取「连到采样器 positive 槽」的那个，负向取「连到 negative 槽」的那个；
    // 找不到连线关系时退化为「第一个 / 第二个」并靠用户手工纠正。
    const detectComfyBindings = (nodes) => {
        const list = Array.isArray(nodes) ? nodes : [];
        const byId = new Map(list.map(node => [node.id, node]));
        const bindings = {};

        // 顺着 KSampler 的 positive/negative 输入回溯到文本节点。
        const findTextNodeVia = (slotName) => {
            for (const node of list) {
                if (!/^KSampler/.test(node.classType || '')) continue;
                const ref = normalizeComfyNodeRef(node.inputs?.[slotName]);
                if (!ref) continue;
                const upstream = byId.get(ref[0]);
                if (upstream && /CLIPTextEncode|TextEncode|Prompt/.test(upstream.classType || '')) return upstream.id;
            }
            return '';
        };
        const positiveId = findTextNodeVia('positive');
        const negativeId = findTextNodeVia('negative');

        // 其余文本节点（排除已认领的正/负向）作为负向的兜底候选。
        const textNodeIds = list
            .filter(node => /CLIPTextEncode|TextEncode/.test(node.classType || ''))
            .map(node => node.id);

        // 记录正向最终落在哪个节点：负向必须避开它，否则正负提示词会被写进同一个输入。
        // 依赖 COMFY_ROLE_RULES 的定义顺序（prompt 在 negativePrompt 之前）。
        let chosenPromptNodeId = '';

        for (const [role, rule] of Object.entries(COMFY_ROLE_RULES)) {
            const candidates = list.filter(node => rule.classes.some(name => name === node.classType));
            if (!candidates.length) continue;

            let chosen = candidates[0];
            if (role === 'prompt') {
                if (positiveId) chosen = byId.get(positiveId) || chosen;
                chosenPromptNodeId = chosen.id;
            } else if (role === 'negativePrompt') {
                // 明确排除「已认领为正向」的那一个，否则正负会被绑成同一个节点。
                const others = candidates.filter(node => node.id !== chosenPromptNodeId);
                if (negativeId && byId.get(negativeId) && byId.get(negativeId).id !== chosenPromptNodeId) {
                    chosen = byId.get(negativeId);
                } else if (others.length) {
                    chosen = others[0];
                } else if (textNodeIds.length > 1) {
                    chosen = byId.get(textNodeIds[1]) || chosen;
                }
                // 只剩一个文本节点时宁可不绑，也不要把正负写成同一个输入。
                if (chosen.id === chosenPromptNodeId) continue;
            }

            const inputs = scalarComfyInputs(chosen);
            // 先按候选名精确匹配；文本类角色才允许退回第一个标量输入。
            // 其余角色退回第一个输入会把 cfg 写成 steps（静默改坏参数），因此宁可不绑。
            let input = rule.inputs.find(name => inputs.includes(name));
            if (!input && rule.textLike) input = inputs[0];
            if (!input) continue;
            bindings[role] = { nodeId: chosen.id, input };
        }
        return bindings;
    };

    // 把绑定表整理成「只有真正可用的条目」：节点存在、输入名非空、角色合法。
    // 绑定存在 settings 里可能因为用户换了工作流而失效，应用前必须过滤。
    const normalizeComfyBindings = (bindings, nodes) => {
        const list = Array.isArray(nodes) ? nodes : [];
        const byId = new Map(list.map(node => [node.id, node]));
        const validRoles = new Set(Object.keys(COMFY_ROLE_RULES));
        const out = {};
        for (const [role, binding] of Object.entries(bindings || {})) {
            if (!validRoles.has(role)) continue;
            const nodeId = String(binding?.nodeId ?? '');
            const input = String(binding?.input ?? '');
            if (!nodeId || !input) continue;
            const node = byId.get(nodeId);
            if (!node) continue;
            out[role] = { nodeId, input };
        }
        return out;
    };

    // 把参数值写进工作流的一份深拷贝；返回 { prompt, applied, skipped }。
    // skipped 记录「想写但写不进去」的项（节点/输入不存在），由调用方决定是否提示用户，
    // 绝不静默改坏用户的图。
    const applyComfyParamValues = (workflow, bindings, values) => {
        const copy = JSON.parse(JSON.stringify(workflow || {}));
        const applied = [];
        const skipped = [];
        for (const [role, rawValue] of Object.entries(values || {})) {
            const binding = bindings?.[role];
            if (!binding) continue;
            if (rawValue === undefined || rawValue === null || rawValue === '') continue;
            const node = copy[binding.nodeId];
            if (!node || typeof node !== 'object') {
                skipped.push({ role, reason: `节点 ${binding.nodeId} 不存在` });
                continue;
            }
            if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {};
            // 连线不能当参数覆盖，否则会把图结构改坏。
            if (isComfyNodeLink(node.inputs[binding.input])) {
                skipped.push({ role, reason: `${binding.nodeId}.${binding.input} 是节点连线` });
                continue;
            }
            node.inputs[binding.input] = rawValue;
            applied.push({ role, nodeId: binding.nodeId, input: binding.input, value: rawValue });
        }
        return { prompt: copy, applied, skipped };
    };

    // 从 /history/{prompt_id} 的结果里收集输出文件。
    // 结构：{ outputs: { "9": { images: [{filename, subfolder, type}] } } }
    // 视频类节点（VHS_VideoCombine）用 gifs/videos，音频用 audio，统一成同一种形状。
    const collectComfyOutputs = (historyEntry) => {
        const outputs = historyEntry?.outputs;
        if (!outputs || typeof outputs !== 'object') return [];
        const files = [];
        for (const [nodeId, output] of Object.entries(outputs)) {
            if (!output || typeof output !== 'object') continue;
            for (const key of ['images', 'gifs', 'videos', 'audio', 'files']) {
                const items = output[key];
                if (!Array.isArray(items)) continue;
                for (const item of items) {
                    if (!item || typeof item !== 'object' || !item.filename) continue;
                    files.push({
                        nodeId: String(nodeId),
                        kind: key,
                        filename: String(item.filename),
                        subfolder: String(item.subfolder || ''),
                        type: String(item.type || 'output'),
                        // 前端渲染 / 归档都需要一个可直接 GET 的地址。
                        url: buildComfyViewUrl(item)
                    });
                }
            }
        }
        return files;
    };

    // /view 的查询串：filename + subfolder + type，三者缺一不可（ComfyUI 用它们定位文件）。
    const buildComfyViewUrl = (file, baseUrl = '') => {
        const params = new URLSearchParams();
        params.set('filename', String(file?.filename || ''));
        if (file?.subfolder) params.set('subfolder', String(file.subfolder));
        params.set('type', String(file?.type || 'output'));
        const query = `/view?${params.toString()}`;
        return baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}${query}` : query;
    };

    // 从 WS 的 progress_state 事件里算出「整体百分比」。
    //
    // ComfyUI 的进度是按节点报的（每个节点有自己的 value/max），没有全局百分比。
    // 这里用「已完成的采样步数 / 总步数」估算，只覆盖 value/max 有效且 max>0 的节点；
    // 拿不到任何有效进度时返回 null，调用方退回不确定态（转圈 + 文案），不假装有进度。
    const computeComfyProgress = (event) => {
        const nodes = event?.nodes;
        if (!nodes || typeof nodes !== 'object') return null;
        const entries = Object.values(nodes).filter(node => node && Number(node.max) > 0);
        if (!entries.length) return null;
        const finished = entries.filter(node => node.state === 'finished').length;
        // 未完成的节点按 value/max 折算，完成的直接算满。
        const partial = entries.reduce((sum, node) => {
            if (node.state === 'finished') return sum + 1;
            const ratio = Number(node.value) / Number(node.max);
            return sum + (Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0);
        }, 0);
        const percent = Math.round((Math.max(finished, partial) / entries.length) * 100);
        return Math.max(0, Math.min(100, percent));
    };

    // 从 progress_state 里挑出「当前正在跑」的节点，用于文案（如「采样中」）。
    const describeComfyProgress = (event) => {
        const percent = computeComfyProgress(event);
        if (percent === null) return '生成中';
        if (percent >= 100) return '生成中 100%';
        return `生成中 ${percent}%`;
    };

    // 工作流里是否有 KSampler 之类会真正出图的节点：
    // 没有的话多半是用户粘错了 JSON，提前给出可读的提示。
    const comfyWorkflowHasSampler = (nodes) => (Array.isArray(nodes) ? nodes : [])
        .some(node => /Sampler|SamplerCustom|RandomNoise|KSampler/.test(node?.classType || ''));

    // 汇总工作流里的可用下拉选项：从 object_info 里取该节点输入声明的 COMBO 列表。
    // 用于设置页给「底模 / VAE / 采样器」这类参数提供下拉，而不是让用户背文件名。
    const pickComfyComboOptions = (objectInfo, classType, inputName) => {
        const spec = objectInfo?.[classType]?.input;
        if (!spec) return [];
        for (const group of ['required', 'optional']) {
            const entry = spec[group]?.[inputName];
            if (!Array.isArray(entry)) continue;
            const first = entry[0];
            if (Array.isArray(first)) return first.map(item => ({ value: String(item), label: String(item) }));
        }
        return [];
    };

    // ===== ComfyUI 工作流库：保存多个工作流并按名字切换 =====
    //
    // 与生图预设（savedImageEndpoints）的关系：
    //   生图预设 = 「连哪个服务」+ 一套出图参数（其中包含 comfyWorkflow）
    //   工作流库 = 「这个服务上可以跑哪几张图」，是给 ComfyUI 用的、可复用的资产
    // 因此工作流库存的是「名字 + JSON + 绑定」，切工作流即把 JSON/绑定写进当前生图参数。

    const COMFY_LIBRARY_LIMIT = 50;

    // 给工作流起一个可读的默认名字：优先 JSON 里的 _meta.title（ComfyUI 导出会带），
    // 其次按节点构成猜测（文生图 / 图生图 / 视频…），最后退回序号。
    const suggestComfyWorkflowName = (nodes, fallbackIndex = 0) => {
        const list = Array.isArray(nodes) ? nodes : [];
        const classes = new Set(list.map(node => String(node?.classType || '')));
        const has = (re) => [...classes].some(name => re.test(name));
        if (has(/SaveVideo|VideoCombine|SaveWEBM|SaveAnimated/)) return `视频工作流 ${fallbackIndex}`;
        if (has(/LoadImage|LoadImageMask|ImageBatch|LoadImageSet/)) return `图生图工作流 ${fallbackIndex}`;
        if (has(/KSampler|SamplerCustom/)) return `文生图工作流 ${fallbackIndex}`;
        if (has(/Upscale|ImageScale/)) return `放大工作流 ${fallbackIndex}`;
        return `工作流 ${fallbackIndex}`;
    };

    // 从 API 格式 JSON 里尽量读出一个天然的名字（ComfyUI 的导出会写 _meta.title）。
    const readComfyWorkflowTitle = (text) => {
        try {
            const parsed = typeof text === 'string' ? JSON.parse(text) : text;
            const title = parsed?._meta?.title || parsed?._meta?.name;
            return typeof title === 'string' ? title.trim() : '';
        } catch {
            return '';
        }
    };

    // 整理工作流库：丢掉坏条目、去重 id、夹住数量上限。
    // 存档里可能有用户手改坏的数据，这里一律当不可信输入处理。
    const normalizeComfyWorkflowLibrary = (library) => {
        const list = Array.isArray(library) ? library : [];
        const seen = new Set();
        const out = [];
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const workflow = String(item.workflow || '');
            if (!workflow.trim()) continue;
            let id = String(item.id || '').trim() || `comfy-wf-${out.length}-${Date.now()}`;
            while (seen.has(id)) id = `${id}-1`;
            seen.add(id);
            out.push({
                id,
                name: String(item.name || '').trim() || suggestComfyWorkflowName([], out.length + 1),
                workflow,
                bindings: (item.bindings && typeof item.bindings === 'object' && !Array.isArray(item.bindings))
                    ? item.bindings
                    : {},
                // 记住保存时刻的自动探测开关，恢复时一并还原，避免「换工作流后绑定语义变了」。
                autoDetect: item.autoDetect !== false,
                note: String(item.note || '')
            });
            if (out.length >= COMFY_LIBRARY_LIMIT) break;
        }
        return out;
    };

    // 保存/更新一条工作流。传 id 且命中则覆盖，否则新增。
    // 返回 { library, id, added }，由调用方决定提示文案。
    const upsertComfyWorkflow = (library, entry = {}) => {
        const list = normalizeComfyWorkflowLibrary(library);
        const workflow = String(entry.workflow || '');
        if (!workflow.trim()) return { library: list, id: '', added: false, error: '工作流为空' };
        const name = String(entry.name || '').trim() || suggestComfyWorkflowName([], list.length + 1);
        const targetId = String(entry.id || '').trim();
        const index = targetId ? list.findIndex(item => item.id === targetId) : -1;
        const record = {
            id: index !== -1 ? list[index].id : `comfy-wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            name,
            workflow,
            bindings: (entry.bindings && typeof entry.bindings === 'object') ? entry.bindings : {},
            autoDetect: entry.autoDetect !== false,
            note: String(entry.note || '')
        };
        if (index !== -1) list[index] = record;
        else list.push(record);
        return { library: list.slice(0, COMFY_LIBRARY_LIMIT), id: record.id, added: index === -1 };
    };

    const removeComfyWorkflow = (library, id) => normalizeComfyWorkflowLibrary(library)
        .filter(item => item.id !== String(id || ''));

    const findComfyWorkflow = (library, id) => normalizeComfyWorkflowLibrary(library)
        .find(item => item.id === String(id || '')) || null;

    // ===== NovelAI 官方 API（image.novelai.net）=====
    //
    // 与「NAI（RP Hub 网关）」的区别（那套是作者自己的套壳，走 /api/jobs 异步任务）：
    //   - 端点  POST https://image.novelai.net/ai/generate-image
    //   - 鉴权  Authorization: Bearer <pst 开头的 access token>（不是 query token）
    //   - 请求体 { input, model, action, parameters }，参数全在 parameters 里
    //   - 响应  直接回一个 ZIP（内含 PNG），不是任务 id + 轮询
    // 以上均以官方文档与官方 Python 库（novelai_api）的实现为准。

    // 官方要求宽高必须为 64 的倍数。
    const normalizeNaiOfficialDimension = (value, fallback) => {
        const limits = (window.RPHubConfig?.uiOptions?.novaiOfficialSizeLimits)
            || (window.RPHubConfig?.uiOptions?.novelaiOfficialSizeLimits)
            || { min: 64, max: 2048, step: 64 };
        const number = Math.round(Number(value));
        if (!Number.isFinite(number) || number <= 0) return fallback;
        return Math.max(limits.min, Math.min(limits.max, Math.round(number / limits.step) * limits.step));
    };

    // 本次生成是否落在「Opus 免费额度」内（不扣 Anlas）。
    //
    // 规则直接来自官方库 ImagePreset.calculate_cost：
    //   opus_discount = is_opus and steps <= 28 and 像素 <= 1024*1024
    // 注意两点：
    //   1. V5 同样适用这条判定（官方 FAQ：V5 在 normal resolution 且 ≤28 步时不消耗 Anlas）。
    //   2. 免费与否跟「模型版本」无关，只跟步数与像素量有关。
    const isNaiOfficialFreeTier = (settings = {}) => {
        const uiOptions = window.RPHubConfig?.uiOptions || {};
        const maxSteps = Number(uiOptions.novelaiOfficialFreeSteps) || 28;
        const maxPixels = Number(uiOptions.novelaiOfficialFreePixels) || 1024 * 1024;
        const steps = Math.round(Number(settings.naiOfficialSteps) || 28);
        const { width, height } = resolveNaiOfficialSize(settings);
        return steps <= maxSteps && width * height <= maxPixels;
    };

    // 官方出图尺寸：预设档位优先，其次自定义宽高，最后兜底竖图。
    const resolveNaiOfficialSize = (settings = {}) => {
        const uiOptions = window.RPHubConfig?.uiOptions || {};
        const presets = uiOptions.novelaiOfficialResolutions || [];
        const fallback = presets[0] || { width: 832, height: 1216 };
        if (settings.naiOfficialCustomSizeEnabled) {
            return {
                width: normalizeNaiOfficialDimension(settings.naiOfficialCustomWidth, fallback.width),
                height: normalizeNaiOfficialDimension(settings.naiOfficialCustomHeight, fallback.height)
            };
        }
        const preset = presets.find(item => item.value === settings.naiOfficialResolution);
        const size = preset || fallback;
        return { width: size.width, height: size.height };
    };

    // 「超出免费额度」的说明文案；在免费额度内返回空串。
    // 用于设置页给出明确提示，而不是等用户被扣了 Anlas 才发现。
    const describeNaiOfficialFreeStatus = (settings = {}) => {
        const uiOptions = window.RPHubConfig?.uiOptions || {};
        const maxSteps = Number(uiOptions.novelaiOfficialFreeSteps) || 28;
        const maxPixels = Number(uiOptions.novelaiOfficialFreePixels) || 1024 * 1024;
        const steps = Math.round(Number(settings.naiOfficialSteps) || 28);
        const { width, height } = resolveNaiOfficialSize(settings);
        const pixels = width * height;
        const reasons = [];
        if (steps > maxSteps) reasons.push(`步数 ${steps} > ${maxSteps}`);
        if (pixels > maxPixels) reasons.push(`像素 ${(pixels / 1e6).toFixed(2)}MP > 1.00MP`);
        if (!reasons.length) return '';
        return `超出 Opus 免费额度（${reasons.join('，')}），本次会消耗 Anlas`;
    };

    // skip_cfg_above_sigma 的默认值。
    // 注意顺序：必须先判 4-5，再判 4——"nai-diffusion-4-5-full" 里含有 "nai-diffusion-4"，
    // 反过来判会把 4.5 错当成 4。
    const naiOfficialSkipCfgAboveSigma = (model) => {
        const id = String(model || '');
        if (id.includes('4-5')) return 58;
        if (id.startsWith('nai-diffusion-4')) return 19;
        return null;
    };

    // ===== 官方 UC 预设：数字档位 → 字符串 id =====
    //
    // 官方网页端发的是 ucPresetId（heavy / light / humanFocus / furryFocus / none），
    // 且各模型可用的档位不同（V4 Full 只有 heavy/light/none）。这里逐字对照官方前端实现：
    // 先按界面档位取目标 id，该模型没有就按官方偏好表往下降级（furry → heavy → light → none）。
    const NAI_OFFICIAL_UC_PRESET_ID_BY_VALUE = Object.freeze({
        0: 'heavy', 1: 'light', 2: 'humanFocus', 3: 'furryFocus', 4: 'none'
    });
    const NAI_OFFICIAL_UC_PRESET_CATEGORY = Object.freeze({
        heavy: 'heavy', light: 'light', humanFocus: 'human', furryFocus: 'furry', none: 'none'
    });
    const NAI_OFFICIAL_UC_FALLBACK = Object.freeze({
        none: ['none', 'light', 'heavy'],
        light: ['light', 'none', 'heavy'],
        heavy: ['heavy', 'light', 'none'],
        human: ['human', 'heavy', 'light', 'none'],
        furry: ['furry', 'heavy', 'light', 'none']
    });

    const naiOfficialUcPresetIds = (model) => {
        const id = String(model || '');
        if (id.startsWith('nai-diffusion-5')) return ['heavy', 'light', 'furryFocus', 'humanFocus', 'none'];
        if (id.startsWith('nai-diffusion-4-5-full')) return ['heavy', 'light', 'furryFocus', 'humanFocus', 'none'];
        if (id.startsWith('nai-diffusion-4-5-curated')) return ['heavy', 'light', 'humanFocus', 'none'];
        if (id.startsWith('nai-diffusion-4')) return ['heavy', 'light', 'none'];
        if (id === 'nai-diffusion-3') return ['heavy', 'light', 'humanFocus', 'none'];
        if (id.startsWith('nai-diffusion-furry')) return ['heavy', 'light', 'none'];
        return ['none'];
    };

    // 界面档位 → 字符串 id。缺省（undefined / null / 空）与非法值一律当「无」：
    // 官方这三个默认值与网关对齐后就该是「什么都不加」，只有用户显式选了才加。
    const resolveNaiOfficialUcPresetId = (model, requested) => {
        const available = naiOfficialUcPresetIds(model);
        const numeric = (requested === undefined || requested === null || requested === '') ? 4 : Number(requested);
        const wanted = NAI_OFFICIAL_UC_PRESET_ID_BY_VALUE[numeric] || 'none';
        if (available.includes(wanted)) return wanted;
        const order = NAI_OFFICIAL_UC_FALLBACK[NAI_OFFICIAL_UC_PRESET_CATEGORY[wanted]] || ['none'];
        for (const category of order) {
            const hit = available.find(id => NAI_OFFICIAL_UC_PRESET_CATEGORY[id] === category);
            if (hit) return hit;
        }
        return 'none';
    };

    // 构建官方 API 的请求体。
    // 返回 { input, model, action, parameters }，可直接 JSON.stringify 后 POST。
    const buildNaiOfficialPayload = ({ settings = {}, prompt = '', negativePrompt = '' } = {}) => {
        const uiOptions = window.RPHubConfig?.uiOptions || {};
        const model = String(settings.naiOfficialModel || uiOptions.novelaiOfficialModels?.[0]?.value || 'nai-diffusion-5-full');
        const { width, height } = resolveNaiOfficialSize(settings);
        const steps = Math.max(1, Math.min(50, Math.round(Number(settings.naiOfficialSteps) || 28)));
        const scale = Number(settings.naiOfficialScale);
        const seedRaw = Number(settings.naiOfficialSeed);
        // 种子留空或 0 = 让服务端随机（官方语义：seed 0 由后端随机）。
        const seed = Number.isFinite(seedRaw) && seedRaw > 0 ? Math.floor(seedRaw) : Math.floor(Math.random() * 4294967295);
        const sampler = String(settings.naiOfficialSampler || uiOptions.novelaiOfficialSamplers?.[0] || 'k_euler_ancestral');
        const noiseSchedule = String(settings.naiOfficialNoiseSchedule || 'karras');
        const cfgRescale = Number(settings.naiOfficialCfgRescale);

        const parameters = {
            width,
            height,
            n_samples: 1,
            seed,
            extra_noise_seed: seed,
            sampler,
            steps,
            scale: Number.isFinite(scale) ? scale : 5,
            negative_prompt: String(negativePrompt || ''),
            cfg_rescale: Number.isFinite(cfgRescale) ? cfgRescale : 0,
            // 噪声计划：用户选的调度器必须落到 noise_schedule，否则该选项完全没作用。
            noise_schedule: noiseSchedule,
            legacy: false,
            legacy_v3_extend: false
        };

        // 参数表版本：官方网页端**所有**模型现在都发 params_version 4，并用字符串 id
        // （ucPresetId / qualityPresetId）。旧版数字 ucPreset / 布尔 qualityToggle 已被官方
        // 前端迁移逻辑删掉——这正是「官方侧负面预设选了却像没生效」的原因之一。
        // V3 / Furry V3 走原来的旧字段（实测可用），不跟着改，避免影响老模型。
        const usesV4Schema = model.startsWith('nai-diffusion-4') || model.startsWith('nai-diffusion-5');
        if (usesV4Schema) {
            parameters.params_version = 4;
            parameters.ucPresetId = resolveNaiOfficialUcPresetId(model, settings.naiOfficialUcPreset);
            // 质量标签默认关（网关没有这一项）；只有显式开启才发 standard。
            parameters.qualityPresetId = settings.naiOfficialQualityToggle === true ? 'standard' : 'none';
        } else {
            parameters.params_version = 3;
            parameters.qualityToggle = settings.naiOfficialQualityToggle === true;
            parameters.ucPreset = Number.isFinite(Number(settings.naiOfficialUcPreset))
                ? Number(settings.naiOfficialUcPreset)
                : 4;
        }

        const skipCfg = naiOfficialSkipCfgAboveSigma(model);
        // 多样性增强（Variety+）默认关：网关没有这个参数，开了就是多一个变量。
        if (skipCfg !== null && settings.naiOfficialVarietyBoost === true) {
            parameters.skip_cfg_above_sigma = skipCfg;
        }

        // V4 及以上才有 v4_prompt / v4_negative_prompt 这套结构。
        if (model.startsWith('nai-diffusion-4') || model.startsWith('nai-diffusion-5')) {
            parameters.add_original_image = true;
            parameters.legacy_uc = false;
            parameters.v4_prompt = {
                caption: { base_caption: String(prompt || ''), char_captions: [] },
                use_coords: false,
                use_order: true
            };
            parameters.v4_negative_prompt = {
                caption: { base_caption: String(negativePrompt || ''), char_captions: [] },
                use_coords: false,
                use_order: false
            };
        }

        return { input: String(prompt || ''), model, action: 'generate', parameters };
    };

    // ===== 官方 API 的并发闸门与退避重试 =====
    //
    // 官方账号侧是「全局并发 1」：同一账号同一时刻只允许一张在跑。而本站每张图都是一个
    // 独立任务（一次对话出 2 张 = 2 个任务），两张同时发 → 第二张必然 429。
    // 这里放两段可测的逻辑：并发度可配的 Promise 队列 + 429/5xx 退避重试的请求执行器。

    // 429/5xx/408 属于「等一会儿就好」；401/402/400 重试没有意义。
    const NAI_OFFICIAL_RETRYABLE_STATUS = Object.freeze([408, 429, 500, 502, 503, 504]);
    // 报错重试的默认策略：只重试 2 次，间隔刻意拉长到 3s / 5s。
    // 撞 429 说明服务端已经在限流，短间隔连打更容易被当成滥用；两次都不成就交回用户手动重试。
    const NAI_OFFICIAL_RETRY_DEFAULTS = Object.freeze({ retryMax: 2, delaysMs: Object.freeze([3000, 5000]) });
    const NAI_OFFICIAL_RETRY_MAX_LIMIT = 5;
    // 单次尝试的超时：官方生图通常 10～40 秒，卡住 120 秒就该重试而不是无限等（也会堵住队列）。
    const NAI_OFFICIAL_TIMEOUT_MS = 120000;

    // 并发度 1 的任务队列：超出并发度的任务排队，前面的跑完自动补位。
    // onWait(position, total) 只在「确实要等」和位次变化时回调，用来在卡片上显示排队位次。
    const createSerialTaskQueue = ({ concurrency = 1 } = {}) => {
        const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
        const pending = [];
        let active = 0;

        const notify = () => {
            pending.forEach((entry, index) => entry.onWait?.(index + 1, pending.length));
        };

        const pump = () => {
            while (active < limit && pending.length) {
                const entry = pending.shift();
                active += 1;
                notify();
                Promise.resolve()
                    .then(() => entry.task())
                    .then(entry.resolve, entry.reject)
                    .finally(() => {
                        active -= 1;
                        pump();
                    });
            }
        };

        return {
            // task 需返回 Promise；onWait 可选。
            run(task, { onWait } = {}) {
                return new Promise((resolve, reject) => {
                    pending.push({ task, onWait, resolve, reject });
                    // 只有真要排队才报位次，避免立刻开跑的任务闪一下「排队中」。
                    if (active >= limit) notify();
                    pump();
                });
            },
            get activeCount() { return active; },
            get pendingCount() { return pending.length; }
        };
    };

    // 解析设置里的「重试间隔」：支持 "3,5" / "3，5" / "3、5" / "3 5"，单位秒，1～60 秒，回落默认。
    const parseNaiOfficialRetryDelays = (value) => {
        const defaults = NAI_OFFICIAL_RETRY_DEFAULTS.delaysMs;
        if (value === undefined || value === null || value === '') return [...defaults];
        const seconds = String(value)
            .split(/[,\uFF0C\u3001;\s]+/)
            .map(part => Math.round(Number(part)))
            .filter(ms => Number.isFinite(ms) && ms > 0)
            .map(seconds => Math.max(1, Math.min(60, seconds)) * 1000);
        return seconds.length ? seconds : [...defaults];
    };

    // 从设置解析这次生成要用的重试策略；次数 0 = 不自动重试（失败就直接报错，交用户手动重试）。
    const resolveNaiOfficialRetryPolicy = (settings = {}) => {
        const rawMax = Number(settings.naiOfficialRetryMax);
        const retryMax = Number.isFinite(rawMax)
            ? Math.max(0, Math.min(NAI_OFFICIAL_RETRY_MAX_LIMIT, Math.round(rawMax)))
            : NAI_OFFICIAL_RETRY_DEFAULTS.retryMax;
        return {
            retryMax,
            delaysMs: parseNaiOfficialRetryDelays(settings.naiOfficialRetryDelays)
        };
    };

    // 第 attempt（0 起）次重试前等多久；超出间隔表就沿用最后一个（不无限增长）。
    const naiOfficialRetryDelayMs = (attempt, policy = NAI_OFFICIAL_RETRY_DEFAULTS) => {
        const list = (Array.isArray(policy) ? policy : policy?.delaysMs) || NAI_OFFICIAL_RETRY_DEFAULTS.delaysMs;
        const delays = list.length ? list : NAI_OFFICIAL_RETRY_DEFAULTS.delaysMs;
        const index = Math.max(0, Math.round(Number(attempt) || 0));
        return delays[Math.min(index, delays.length - 1)];
    };

    const isNaiOfficialRetryableStatus = (status) => NAI_OFFICIAL_RETRYABLE_STATUS.includes(Number(status));

    const describeNaiOfficialHttpError = (status, detail = '') => {
        const text = String(detail || '').trim() || `HTTP ${status}`;
        if (status === 401) return `鉴权失败（401）：请检查 token 是否正确、是否已过期。${text}`;
        if (status === 402) return `需要有效订阅（402）：${text}`;
        if (status === 429) return `请求过于频繁或额度用尽（429）：${text}`;
        return text;
    };

    // 单次尝试的返回：{ outcome: 'ok' | 'http' | 'network' }。
    // 拆成「一次尝试」的好处：超时、网络中断、HTTP 状态码三条失败路径共用同一套重试判定，
    // 且读响应体（下载）失败也能进入重试，而不是把半截数据当成成品。
    const runNaiOfficialImageAttempt = async ({
        url,
        token,
        payload,
        doFetch,
        onProgress,
        timeoutMs = NAI_OFFICIAL_TIMEOUT_MS
    }) => {
        const canAbort = typeof AbortController === 'function';
        const controller = canAbort ? new AbortController() : null;
        const limitMs = Math.max(0, Math.round(Number(timeoutMs) || 0));
        const timer = controller && limitMs > 0 ? setTimeout(() => controller.abort(), limitMs) : null;

        const readOkBody = async (response) => {
            // 边读边报进度：官方 ZIP 通常几百 KB～数 MB，进度条能反映下载阶段。
            const total = Number(response.headers?.get?.('content-length')) || 0;
            let buffer;
            if (response.body && typeof response.body.getReader === 'function') {
                const reader = response.body.getReader();
                const chunks = [];
                let received = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.length;
                    // 下载阶段占 10%～70%，剩余留给解压与渲染。
                    const ratio = total ? Math.min(1, received / total) : 0.5;
                    onProgress?.(Math.round(10 + ratio * 60));
                }
                buffer = new Uint8Array(received);
                let offset = 0;
                for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
            } else {
                buffer = new Uint8Array(await response.arrayBuffer());
            }
            return buffer;
        };

        try {
            onProgress?.(8);
            let response;
            try {
                response = await doFetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify(payload),
                    ...(controller ? { signal: controller.signal } : {})
                });
            } catch (error) {
                return {
                    outcome: 'network',
                    timedOut: controller?.signal?.aborted === true,
                    message: error?.message || String(error)
                };
            }

            if (response.ok) {
                try {
                    const buffer = await readOkBody(response);
                    return {
                        outcome: 'ok',
                        arrayBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
                        contentType: response.headers?.get?.('content-type') || ''
                    };
                } catch (error) {
                    // 下载中断/超时：不能当成成品，走重试。
                    return {
                        outcome: 'network',
                        timedOut: controller?.signal?.aborted === true,
                        message: error?.message || String(error)
                    };
                }
            }

            // 官方错误体是 { statusCode, message }，把 message 带出来更有用。
            let text = '';
            try { text = await response.text(); } catch { /* 读不出就只用状态码 */ }
            let message = '';
            try { message = JSON.parse(text)?.message || ''; } catch { /* 非 JSON 就原样用 */ }
            if (!message) message = text.slice(0, 300);
            return { outcome: 'http', status: response.status, message };
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    // 提交一次官方生图请求并读回响应体。
    // 报错重试机制：HTTP 408/429/5xx、请求超时、网络中断都按「重试间隔」重试，
    // 默认只重试 2 次（3s / 5s），可在设置页改；401/402/400 这类重试也不会变的错误直接抛。
    // fetch / sleep 可注入（便于测试）；onProgress(percent) 报下载进度，onRetry(info) 报重试。
    // 返回 { arrayBuffer, contentType }。
    const fetchNaiOfficialImageBytes = async ({
        baseUrl,
        token,
        payload,
        fetchImpl,
        sleep,
        retryMax = NAI_OFFICIAL_RETRY_DEFAULTS.retryMax,
        retryDelaysMs = NAI_OFFICIAL_RETRY_DEFAULTS.delaysMs,
        timeoutMs = NAI_OFFICIAL_TIMEOUT_MS,
        onProgress,
        onRetry
    } = {}) => {
        const doFetch = fetchImpl || ((...args) => fetch(...args));
        const doSleep = sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
        const url = `${String(baseUrl || '').replace(/\/+$/, '')}/ai/generate-image`;
        const maxRetry = Math.max(0, Math.round(Number(retryMax) || 0));

        for (let attempt = 0; ; attempt += 1) {
            const result = await runNaiOfficialImageAttempt({ url, token, payload, doFetch, onProgress, timeoutMs });
            if (result.outcome === 'ok') {
                return { arrayBuffer: result.arrayBuffer, contentType: result.contentType };
            }

            const retryable = result.outcome === 'network' || isNaiOfficialRetryableStatus(result.status);
            if (retryable && attempt < maxRetry) {
                const delayMs = naiOfficialRetryDelayMs(attempt, retryDelaysMs);
                onRetry?.({
                    attempt: attempt + 1,
                    retryMax: maxRetry,
                    delayMs,
                    status: result.outcome === 'http' ? result.status : 0,
                    timedOut: result.outcome === 'network' && result.timedOut === true,
                    reason: result.outcome === 'network' ? result.message : ''
                });
                await doSleep(delayMs);
                continue;
            }

            if (result.outcome === 'network') {
                const why = result.timedOut ? '请求超时' : '网络错误';
                throw new Error(`${why}（已尝试 ${attempt + 1} 次）：${result.message}`);
            }
            const retried = attempt > 0 ? `（已重试 ${attempt} 次）` : '';
            throw new Error(describeNaiOfficialHttpError(result.status, result.message) + retried);
        }
    };

    // --- 极简 ZIP 读取（浏览器内置解压，不引第三方库）---
    //
    // 官方 /ai/generate-image 直接回一个 ZIP 包着 PNG。浏览器侧用
    // DecompressionStream('deflate-raw') 解 inflate，无需依赖。
    // 只支持 ZIP 里常见的两种压缩法：0 = 存储，8 = deflate。
    const readZipEntries = async (buffer) => {
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        // 从尾部找 End of Central Directory（EOCD 签名 0x06054b50）。
        let eocd = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i -= 1) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('响应不是有效的 ZIP（找不到 EOCD）');
        const count = view.getUint16(eocd + 10, true);
        let offset = view.getUint32(eocd + 16, true);

        const entries = [];
        for (let index = 0; index < count; index += 1) {
            if (view.getUint32(offset, true) !== 0x02014b50) break;
            const method = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            offset += 46 + nameLength + extraLength + commentLength;

            // 本地头长度可能与中央目录不同（extra 字段），必须从本地头重新读。
            const localNameLength = view.getUint16(localOffset + 26, true);
            const localExtraLength = view.getUint16(localOffset + 28, true);
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            const raw = bytes.subarray(dataStart, dataStart + compressedSize);

            let data;
            if (method === 0) {
                data = raw.slice();
            } else if (method === 8) {
                data = await inflateRaw(raw);
            } else {
                throw new Error(`ZIP 用了不支持的压缩方式（method=${method}）`);
            }
            entries.push({ name, data: new Uint8Array(data) });
        }
        return entries;
    };

    // 用浏览器内置 DecompressionStream 解 raw deflate。
    const inflateRaw = async (bytes) => {
        if (typeof DecompressionStream !== 'function') {
            throw new Error('当前环境不支持 DecompressionStream，无法解压 ZIP');
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    };

    // 从官方响应里取出第一张 PNG 的字节。
    // 兼容三种返回：ZIP（常态）、裸 PNG 字节、以及 JSON 错误体。
    const extractNaiOfficialImage = async (buffer, contentType = '') => {
        const bytes = new Uint8Array(buffer);
        const type = String(contentType || '').toLowerCase();
        // 裸 PNG：直接看魔数，不看 content-type（有的网关会写错）。
        if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
            return { data: bytes, kind: 'png' };
        }
        // ZIP：看 PK 魔数（0x50 0x4b）。
        if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
            const entries = await readZipEntries(buffer);
            const image = entries.find(entry => /\.(png|webp|jpg|jpeg)$/i.test(entry.name)) || entries[0];
            if (!image) throw new Error('ZIP 里没有图片条目');
            return { data: image.data, kind: 'zip', name: image.name };
        }
        // 其余按 JSON 错误体处理，把服务端的话带出来。
        if (type.includes('json') || bytes[0] === 0x7b) {
            let message = '';
            try {
                const payload = JSON.parse(new TextDecoder().decode(bytes));
                message = payload?.message || payload?.error || payload?.detail || JSON.stringify(payload).slice(0, 300);
            } catch {
                message = new TextDecoder().decode(bytes).slice(0, 300);
            }
            throw new Error(message || '官方 API 返回了错误');
        }
        throw new Error(`无法识别的响应（content-type=${contentType || '未知'}）`);
    };

    // 字节流 → 可直接放进 <img> 的 data URL。
    const bytesToPngDataUrl = (bytes) => {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return `data:image/png;base64,${btoa(binary)}`;
    };

    // 官方订阅等级（来自官方库的 SubscriptionTier 枚举）：0=PAPER 是免费试用档。
    const NAI_OFFICIAL_TIER_LABELS = Object.freeze(['免费试用（Paper）', 'Tablet', 'Scroll', 'Opus']);

    // 把官方账户接口的响应整理成可直接显示的形态。
    //
    // 【重要事实】NovelAI 官方公开 API **不返回 Anlas 余额**：
    // swagger 里 anlas 出现 0 次，/user/subscription 与 /user/information 的 schema
    // 都没有该字段；维护中的社区实现也只把 Anlas 当「会被扣」的概念，从不查询余额。
    // 所以这里展示官方**真正给得出**的额度信息，不编造 Anlas：
    //   订阅等级 / 是否生效 / 到期时间 / 试用剩余张数 / 模块训练步数剩余
    const resolveNaiOfficialAccount = (payload) => {
        // 注意默认参数只对 undefined 生效，传 null 会在解构时抛错——这里统一收口。
        const source = (payload && typeof payload === 'object') ? payload : {};
        const sub = (source.subscription && typeof source.subscription === 'object') ? source.subscription : null;
        const info = (source.information && typeof source.information === 'object') ? source.information : null;
        if (!sub && !info) return null;
        const tierRaw = Number(sub?.tier);
        const tier = Number.isFinite(tierRaw) ? tierRaw : null;
        const steps = sub?.trainingStepsLeft || {};
        const fixed = Number(steps.fixedTrainingStepsLeft) || 0;
        const purchased = Number(steps.purchasedTrainingSteps) || 0;
        const expiry = Number(sub?.expiresAt);
        const trial = Number(info?.trialImagesLeft);
        const trialActions = Number(info?.trialActionsLeft);
        return {
            tier,
            tierLabel: tier === null ? '未知' : (NAI_OFFICIAL_TIER_LABELS[tier] || `等级 ${tier}`),
            active: sub?.active === true,
            expiresAt: Number.isFinite(expiry) && expiry > 0 ? expiry : null,
            // 免费试用剩余张数：对应官方 FAQ 里「注册送 30 张（≤1024×1024）」的那个计数器。
            trialImagesLeft: Number.isFinite(trial) ? trial : null,
            trialActionsLeft: Number.isFinite(trialActions) ? trialActions : null,
            trainingStepsLeft: fixed + purchased,
            fixedTrainingStepsLeft: fixed,
            purchasedTrainingSteps: purchased
        };
    };

    // 额度文案：一句话讲清「还能免费用多少 / 订阅状态」。
    const describeNaiOfficialAccount = (account) => {
        if (!account) return '';
        const parts = [account.tierLabel];
        if (account.active === false) parts.push('订阅未生效');
        if (account.trialImagesLeft !== null) parts.push(`试用剩余 ${account.trialImagesLeft} 张`);
        if (account.trainingStepsLeft > 0) parts.push(`训练步数 ${account.trainingStepsLeft}`);
        return parts.join(' · ');
    };

    window.RPHubNaiOfficialUtils = Object.freeze({
        NAI_OFFICIAL_TIER_LABELS,
        resolveNaiOfficialAccount,
        describeNaiOfficialAccount,
        normalizeNaiOfficialDimension,
        resolveNaiOfficialSize,
        isNaiOfficialFreeTier,
        describeNaiOfficialFreeStatus,
        naiOfficialSkipCfgAboveSigma,
        naiOfficialUcPresetIds,
        resolveNaiOfficialUcPresetId,
        buildNaiOfficialPayload,
        NAI_OFFICIAL_RETRYABLE_STATUS,
        NAI_OFFICIAL_RETRY_DEFAULTS,
        NAI_OFFICIAL_RETRY_MAX_LIMIT,
        NAI_OFFICIAL_TIMEOUT_MS,
        parseNaiOfficialRetryDelays,
        resolveNaiOfficialRetryPolicy,
        createSerialTaskQueue,
        naiOfficialRetryDelayMs,
        isNaiOfficialRetryableStatus,
        describeNaiOfficialHttpError,
        fetchNaiOfficialImageBytes,
        readZipEntries,
        extractNaiOfficialImage,
        bytesToPngDataUrl
    });

    window.RPHubComfyUtils = Object.freeze({
        COMFY_ROLE_RULES,
        COMFY_LIBRARY_LIMIT,
        normalizeComfyNodeRef,
        isComfyNodeLink,
        parseComfyWorkflow,
        scalarComfyInputs,
        comfyOutputNodes,
        detectComfyBindings,
        normalizeComfyBindings,
        applyComfyParamValues,
        collectComfyOutputs,
        buildComfyViewUrl,
        computeComfyProgress,
        describeComfyProgress,
        comfyWorkflowHasSampler,
        pickComfyComboOptions,
        suggestComfyWorkflowName,
        readComfyWorkflowTitle,
        normalizeComfyWorkflowLibrary,
        upsertComfyWorkflow,
        removeComfyWorkflow,
        findComfyWorkflow
    });

    window.RPHubImageUtils = Object.freeze({
        IMAGE_PROFILE_FIELDS,
        resolveNaiNegativePrompt,
        resolveImageCacheFingerprint,
        shouldReuseCachedImageJob,
        applyNaiGatewayUrlParams,
        normalizeSdDimension,
        resolveSdSize,
        resolveGeneratedImageUrl,
        resolveGeneratedImageAspect,
        resolveSdSizePreset,
        resolveSdVaeOverride,
        normalizeSdVaeEntry,
        isSdVaeModulePath,
        parseSdVaeList,
        captureImageProfile,
        applyImageProfile,
        seedEndpointProfiles,
        promoteImageJobToServer,
        resolveArchivedImageFallbackUrl,
        isLocalBase64ImageJob,
        isRenderableImageJob,
        compactImageCacheForSync
    });
})();

