#!/usr/bin/env node
// 从归档图片里把「历史图缓存」反推回来（一次性数据修复工具，服务端运行，零依赖）。
//
// 背景（踩坑第 79 条）
// ------------------
// 生图缓存过去只落盘最近 100 条（`slice(-100)`）。条目被挤掉之后，历史图在缓存里就
// 没有任何记录了 —— 重新进入那个会话（切角色卡 / 刷新 / 同步拉取）会整片重新生成：
// 既烧额度，**画面也和当初不一样了**（种子变了）。
//
// 但图片本体还在 data/images 里，而且 NovelAI 会把完整提示词写进 PNG 的 tEXt(Description) 块，
// 于是「聊天里的图 tag → 已归档文件」可以重新对上，历史图因此不必重跑。
//
// 两个必须知道的坑
// ----------------
// 1. **提示词的 tag 顺序会被重排**（实测：网关那条链路会重排，同一段提示词在归档里
//    与消息里的顺序不同），所以不能按字符串后缀匹配，必须按「逗号切分后的多项集合」比。
// 2. 归档提示词是 `画师串 + 前缀 + tag`：tag 的多项集合是它的**子集**，
//    因此匹配规则是「tag ⊆ prompt，且多出来的项数不超过 artistItems 上限」，
//    并优先取「多出来最少」的那个；再多一层保护是按归档索引里的 character 名对齐。
//
// 用法
// ----
//   node tools/recover-archived-image-cache.mjs --state /data/state.json --images /data/images
//   node tools/recover-archived-image-cache.mjs ... --write --out /data/state.recovered.json
//
// 默认**只报告**（dry-run）。--write 也只写到 --out，绝不原地覆盖 state.json。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback = '') => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);

const statePath = argOf('--state');
const imagesDir = argOf('--images');
const write = hasFlag('--write');
const outPath = argOf('--out', statePath ? statePath.replace(/\.json$/, '') + '.recovered.json' : '');
// 画师串最多能有多少项：超过这个差额就不认为是「同一段 tag 加了前缀」。
const MAX_EXTRA_ITEMS = Math.max(0, Number(argOf('--max-extra-items', '60')) || 60);

if (!statePath || !imagesDir) {
    console.error('用法: node tools/recover-archived-image-cache.mjs --state <state.json> --images <images 目录> [--write --out <输出文件>]');
    process.exit(2);
}

const IMAGE_TAG_PATTERN = /image###((?:(?!image###|###)[^\r\n])+?)(?:###|(?=\r?\n))/gi;

// 缓存的 key 口径必须与客户端一致（app.js 的 normalizeImageTagKey）：
// trim + 小写 + 连续空白折叠。逗号两侧的空白**不动**，否则对不上客户端的查表。
const tagKey = (tag) => String(tag || '').trim().toLowerCase().replace(/\s+/g, ' ');

// 「多项集合」：大小写、空白、逗号两侧一律抹平，顺序不参与比较。
const promptItems = (text) => String(text || '')
    .toLowerCase()
    .split(',')
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
const itemKey = (items) => [...items].sort().join('\u0000');

// --- 1. 聊天里出现过的图 tag（含分支会话），并记住「属于哪个角色、哪条消息」 ---
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const main = state?.payload?.main || {};
const cache = main['rp_hub_generated_images_cache'] || {};

const characterNameById = new Map();
for (const character of (Array.isArray(main['rp_hub_characters']) ? main['rp_hub_characters'] : [])) {
    if (character?.uuid) characterNameById.set(String(character.uuid), String(character.name || ''));
}

const missing = new Map(); // itemKey → { tag, character, timestamp, occurrences }
let totalOccurrences = 0;
for (const key of Object.keys(main)) {
    if (!key.startsWith('rp_hub_chat_')) continue;
    const scopeId = key.slice('rp_hub_chat_'.length);
    const characterName = characterNameById.get(scopeId.split('__branch__')[0]) || '';
    const history = Array.isArray(main[key]) ? main[key] : [];
    for (const message of history) {
        const content = String(message?.content || '');
        let match;
        IMAGE_TAG_PATTERN.lastIndex = 0;
        while ((match = IMAGE_TAG_PATTERN.exec(content)) !== null) {
            const tag = match[1].trim();
            if (!tag) continue;
            totalOccurrences += 1;
            const key = itemKey(promptItems(tag));
            if (cache[tagKey(tag)]) continue;
            if (!key) continue;
            if (!missing.has(key)) {
                missing.set(key, {
                    tag,
                    items: promptItems(tag),
                    character: characterName,
                    timestamp: Number(message?.timestamp || 0) || 0,
                    occurrences: 0
                });
            }
            missing.get(key).occurrences += 1;
        }
    }
}

// --- 2. 归档：读 PNG 里的提示词 + 归档索引里的角色/时间 ---
const archiveIndex = (() => {
    const file = path.join(imagesDir, 'index.json');
    if (!fs.existsSync(file)) return new Map();
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const items = parsed?.items && typeof parsed.items === 'object' ? Object.values(parsed.items) : [];
        return new Map(items.map(item => [String(item.file || ''), item]));
    } catch {
        return new Map();
    }
})();

const readPngPrompt = (file) => {
    const fd = fs.openSync(file, 'r');
    try {
        const header = Buffer.alloc(8);
        fs.readSync(fd, header, 0, 8, 0);
        if (header.toString('hex') !== '89504e470d0a1a0a') return null;
        const size = Math.min(fs.fstatSync(fd).size, 64 * 1024);
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, 0);
        let offset = 8;
        let description = '';
        let comment = '';
        while (offset + 8 <= buffer.length) {
            const length = buffer.readUInt32BE(offset);
            const type = buffer.slice(offset + 4, offset + 8).toString('latin1');
            if (!/^[A-Za-z]{4}$/.test(type)) break;
            if (type === 'tEXt' || type === 'iTXt') {
                const data = buffer.slice(offset + 8, offset + 8 + length).toString('latin1');
                const separator = data.indexOf('\u0000');
                const key = separator === -1 ? data : data.slice(0, separator);
                const value = separator === -1 ? '' : data.slice(separator + 1);
                if (key === 'Description' && !description) description = value;
                if (key === 'Comment' && !comment) comment = value;
            }
            offset += 12 + length;
            if (type === 'IEND') break;
            if (description && comment) break;
        }
        let width = 0;
        let height = 0;
        if (comment) {
            try {
                const parsed = JSON.parse(comment);
                width = Number(parsed.width) || 0;
                height = Number(parsed.height) || 0;
            } catch { /* 不是 JSON 就只当没有尺寸 */ }
        }
        return { description, width, height };
    } finally {
        fs.closeSync(fd);
    }
};

const files = [];
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.png$/i.test(entry.name)) files.push(full);
    }
};
walk(imagesDir);

// 反向索引：某一项 → 含这一项的归档图片（用于先按最稀有的一项筛候选）
const postings = new Map();
const archived = [];
let withPrompt = 0;
for (const file of files) {
    let meta = null;
    try { meta = readPngPrompt(file); } catch { meta = null; }
    if (!meta?.description) continue;
    withPrompt += 1;
    const items = promptItems(meta.description);
    const relative = path.relative(imagesDir, file).replace(/\\/g, '/');
    const indexItem = archiveIndex.get(`images/${relative}`) || {};
    archived.push({
        file: relative,
        items,
        itemSet: new Set(items),
        character: String(indexItem.character || ''),
        savedAt: Date.parse(indexItem.savedAt || '') || 0,
        width: meta.width,
        height: meta.height
    });
    for (const item of new Set(items)) {
        if (!postings.has(item)) postings.set(item, []);
        postings.get(item).push(archived.length - 1);
    }
}

// --- 3. 匹配：tag 的项集合必须是提示词的子集，且多出来的项尽量少 ---
const results = { matched: [], ambiguous: [], unmatched: [] };
for (const entry of missing.values()) {
    const { items } = entry;
    if (!items.length) { results.unmatched.push(entry); continue; }
    // 用最稀有的一项做候选筛选
    let candidates = null;
    for (const item of items) {
        const list = postings.get(item);
        if (!list) { candidates = []; break; }
        if (!candidates || list.length < candidates.length) candidates = list;
    }
    const scored = [];
    for (const index of candidates || []) {
        const candidate = archived[index];
        if (candidate.items.length < items.length) continue;
        if (candidate.items.length - items.length > MAX_EXTRA_ITEMS) continue;
        if (!items.every(item => candidate.itemSet.has(item))) continue;
        scored.push({
            candidate,
            extra: candidate.items.length - items.length,
            // 同名角色优先；其次时间更近的优先
            sameCharacter: entry.character && candidate.character === entry.character
        });
    }
    if (!scored.length) { results.unmatched.push(entry); continue; }
    scored.sort((a, b) => {
        if (a.extra !== b.extra) return a.extra - b.extra;
        if (a.sameCharacter !== b.sameCharacter) return a.sameCharacter ? -1 : 1;
        return b.candidate.savedAt - a.candidate.savedAt;
    });
    const best = scored[0];
    const runnerUp = scored[1];
    const clear = !runnerUp
        || (best.extra !== runnerUp.extra && best.sameCharacter && !runnerUp.sameCharacter)
        || best.extra < runnerUp.extra;
    if (clear || (best.sameCharacter && !runnerUp?.sameCharacter)) {
        results.matched.push({ entry, best });
    } else {
        results.ambiguous.push({ entry, best, runnerUp, alternatives: scored.length });
    }
}

const matchedTags = results.matched.length + results.ambiguous.length;
console.log(JSON.stringify({
    statePath,
    imagesDir,
    archivedImages: files.length,
    archivedWithPrompt: withPrompt,
    chatImageTagOccurrences: totalOccurrences,
    uniqueMissingTags: missing.size,
    recoverable: results.matched.length,
    ambiguous: results.ambiguous.length,
    unmatched: results.unmatched.length,
    recoveredOccurrences: [...results.matched].reduce((sum, item) => sum + item.entry.occurrences, 0)
        + [...results.ambiguous].reduce((sum, item) => sum + item.entry.occurrences, 0),
    samples: {
        matched: results.matched.slice(0, 3).map(item => ({
            tag: item.entry.tag.slice(0, 70),
            file: item.best.candidate.file,
            extra: item.best.extra,
            sameCharacter: item.best.sameCharacter,
            occurrences: item.entry.occurrences
        })),
        ambiguous: results.ambiguous.slice(0, 3).map(item => ({
            tag: item.entry.tag.slice(0, 70),
            bestFile: item.best.candidate.file,
            bestExtra: item.best.extra,
            alternatives: item.alternatives,
            occurrences: item.entry.occurrences
        })),
        unmatched: results.unmatched.slice(0, 5).map(item => item.tag.slice(0, 70))
    },
    matchedTags
}, null, 2));

if (!write) {
    console.log('\n（dry-run：没有写任何文件。要落盘请加 --write --out <文件>）');
    process.exit(0);
}

// --- 4. 生成补好的缓存（只新增条目，不动已有条目） ---
const additions = {};
for (const { entry, best } of [...results.matched, ...results.ambiguous]) {
    const key = tagKey(entry.tag);
    if (cache[key] || additions[key]) continue;
    additions[key] = {
        status: 'done',
        resolvedUrl: `/images/${best.candidate.file}`,
        sizeLabel: '',
        width: best.candidate.width || undefined,
        height: best.candidate.height || undefined,
        lastUsedAt: Date.now(),
        recoveredFromArchive: true
    };
}
const patched = JSON.parse(JSON.stringify(state));
patched.payload.main['rp_hub_generated_images_cache'] = { ...cache, ...additions };
fs.writeFileSync(outPath, JSON.stringify(patched));
console.log(`\n已写出 ${outPath}：新增 ${Object.keys(additions).length} 条缓存条目（原文件未改动）。`);
