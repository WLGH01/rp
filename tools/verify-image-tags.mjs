// 生图 Tag 词典校验
//
// 为什么要有这个脚本：模型自己"编 tag"是生图质量最大的杀手（V4.5 用 T5 词表，
// 编出来的英文短语它根本不认识 —— 构图丢失、人物走形）。所以词典里每一个 tag
// 都必须能在真实语料里查到，否则就是又一次"自己编"。
//
// 做法：把 built-in-content.js 里的 IMAGE_TAG_LEXICON 渲染出来，逐条对照本地
// Danbooru 语料；NovelAI 自有的 tag（质量词 / dataset / alpha / complexity / rating…）
// 走 built-in-content.js 里的 IMAGE_TAG_LEXICON_NAI_ONLY 白名单。
//
// 语料：tools/tmp/danbooru/danbooru.csv（约 3.5MB，a1111-sd-webui-tagcomplete 的 danbooru 表，
// 14 万条，格式 `tag,category,count,aliases`）。首次运行会自动下载；下载失败会明确报错，
// **不会**静默通过。
//
// 用法：
//   node tools/verify-image-tags.mjs            # 校验
//   node tools/verify-image-tags.mjs --probe "tag1, tag2"   # 临时体检任意 tag
//
// 注意：语料是**代理**，不是权威。极少数老 tag（例如 NAI 官方文档把 `v` 改名成
// `peace sign`）在语料里没有、在 NAI 里却可用 —— 这类词应当进白名单并写明出处，
// 而不是从词典里删掉。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = join(root, 'tools/tmp/danbooru');
const CORPUS = join(CORPUS_DIR, 'danbooru.csv');
const CORPUS_URL = 'https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru.csv';

// --- 载入 built-in-content.js，拿到词典数据 ---
const sandbox = { window: {}, console };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'assets/js/built-in-content.js'), 'utf8'), sandbox, {
    filename: 'built-in-content.js'
});
const builtin = sandbox.window.RPHubBuiltinContent;
if (!builtin?.imageTagLexicon) {
    console.error('✗ built-in-content.js 未导出 imageTagLexicon');
    process.exit(1);
}
const { sections, v5Sections, naiOnlyTags } = builtin.imageTagLexicon;
const buildLexicon = builtin.prompts.buildImageTagLexicon;

// --- 语料 ---
const loadCorpus = async () => {
    if (!existsSync(CORPUS)) {
        console.log(`语料不存在，正在下载：${CORPUS_URL}`);
        mkdirSync(CORPUS_DIR, { recursive: true });
        try {
            const response = await fetch(CORPUS_URL);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            writeFileSync(CORPUS, Buffer.from(await response.arrayBuffer()));
        } catch (error) {
            console.error(`✗ 语料下载失败：${error.message}`);
            console.error('  请联网后重跑；本脚本不会在拿不到语料时假装通过。');
            process.exit(1);
        }
    }
    const set = new Set();
    for (const line of readFileSync(CORPUS, 'utf8').split('\n')) {
        const i = line.indexOf(',');
        if (i > 0) set.add(line.slice(0, i));
    }
    return set;
};

const toDanbooruName = (tag) => tag.trim().toLowerCase().replace(/\s+/g, '_');

// --- 临时体检模式 ---
const probeIndex = process.argv.indexOf('--probe');
if (probeIndex !== -1) {
    const corpus = await loadCorpus();
    const tags = String(process.argv[probeIndex + 1] || '').split(',').map(t => t.trim()).filter(Boolean);
    const miss = tags.filter(tag => !corpus.has(toDanbooruName(tag)));
    console.log(`语料 ${corpus.size} 条；体检 ${tags.length} 个 tag，未命中 ${miss.length}`);
    miss.forEach(tag => console.log(`  ✗ ${tag}  →  ${toDanbooruName(tag)}`));
    process.exit(0);
}

// --- 校验 ---
const corpus = await loadCorpus();
const allowed = new Set(naiOnlyTags.map(toDanbooruName));
const problems = [];
const seen = new Map();

const check = (label, tags) => tags.forEach((tag) => {
    const name = toDanbooruName(tag);
    if (seen.has(name)) {
        problems.push(`重复 tag：「${tag}」在词典里出现多次（${seen.get(name)} 与 ${label}）`);
    } else {
        seen.set(name, label);
    }
    if (tag !== tag.trim() || /\s{2,}/.test(tag)) {
        problems.push(`${label}：写法不规范「${tag}」`);
    }
    if (/[A-Z_]/.test(tag) || /[\u4e00-\u9fff]/.test(tag)) {
        problems.push(`${label}：「${tag}」应当全小写、空格分词、不含中文`);
    }
    if (corpus.has(name) || allowed.has(name)) return;
    problems.push(`${label}：语料里查不到「${tag}」（${name}）—— 要么改成真实 tag，要么确属 NAI 专有词后加进 IMAGE_TAG_LEXICON_NAI_ONLY`);
});

const renderedV45 = buildLexicon({ model: 'nai-diffusion-4-5-full', provider: 'novelai' });
const renderedV5 = buildLexicon({ model: 'nai-diffusion-5-full', provider: 'novelai' });
const renderedV3 = buildLexicon({ model: 'nai-diffusion-3', provider: 'novelai' });
const renderedSd = buildLexicon({ model: 'mock-model', provider: 'stable-diffusion' });

// 直接校验结构化数据（渲染只用来确认可读性与接线）
sections.forEach(([title, tags]) => check(title, tags));
v5Sections.forEach(([title, tags]) => check(title, tags));

// 接线断言：V4.5 不含 V5 专属词；V5 含；非 NAI 链路为空
const v45HasV5Only = v5Sections.some(([, tags]) => tags.some(tag => renderedV45.includes(tag)));
if (v45HasV5Only) problems.push('V4.5 词典里混进了 V5 专属 tag');
if (!v5Sections.every(([, tags]) => tags.every(tag => renderedV5.includes(tag)))) {
    problems.push('V5 词典没有把 V5 专属 tag 渲染进去');
}
if (renderedSd !== '') problems.push('SD / ComfyUI 不应拿到 NAI 词典（应当返回空串）');
if (renderedV3.length === 0) problems.push('V3 也应当拿到一份词典（只是不含多角色锚点）');
if (/long_hair|_/.test(renderedV5.split('\n').filter(l => l.startsWith('【') && !l.includes('rating:')).join(''))) {
    problems.push('词典里出现了下划线写法（NovelAI 要空格：long hair，不是 long_hair）');
}

const tagCount = seen.size;
console.log(`语料 ${corpus.size} 条 · 词典 ${tagCount} 个 tag（其中 NAI 专有白名单 ${allowed.size} 个）`);
console.log(`渲染长度：V4.5 ${renderedV45.length} 字 · V5 ${renderedV5.length} 字 · V3 ${renderedV3.length} 字`);
if (problems.length === 0) {
    console.log('✓ 全部 tag 都能在真实语料或 NAI 白名单里找到');
    process.exit(0);
}
console.log(`✗ 发现 ${problems.length} 个问题：`);
problems.forEach((item) => console.log(`  - ${item}`));
process.exit(1);
