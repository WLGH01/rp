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
const { sections, v5Sections, naiOnlyTags, qualitySections, metaOnlyTags } = builtin.imageTagLexicon;
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
// SD 那一节（质量 / 年代 / 安全级别）的元 tag：语料基本不收，走单独白名单。
// 两个白名单**分开**维护：NAI 专有词（fur dataset / complexity 之类）不该出现在 SD 词典里，
// 反之亦然 —— 合成一个集合就会让「SD 词典里混进 NAI 专属词」这种错误查不出来。
const allowedMeta = new Set(metaOnlyTags.map(toDanbooruName));
const problems = [];
const seen = new Map();
const seenMeta = new Map();

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
const renderedSd = buildLexicon({ model: 'xl', provider: 'stable-diffusion' });
const renderedSdAnima = buildLexicon({ model: 'anima', provider: 'stable-diffusion' });
const renderedComfy = buildLexicon({ model: 'mock-model', provider: 'comfyui' });

// 直接校验结构化数据（渲染只用来确认可读性与接线）
sections.forEach(([title, tags]) => check(title, tags));
v5Sections.forEach(([title, tags]) => check(title, tags));

// SD 的元信息节：只认 metaOnlyTags 白名单（外加语料里确实有的那几个，如 highres / old）。
qualitySections.forEach(([title, tags]) => tags.forEach((tag) => {
    const name = toDanbooruName(tag);
    if (seenMeta.has(name)) {
        problems.push(`重复 tag：「${tag}」在 SD 元信息节里出现多次（${seenMeta.get(name)} 与 ${title}）`);
    } else {
        seenMeta.set(name, title);
    }
    // 与通用词典**不能重叠**（重叠说明这一节在重复登记，AI 会看到两遍）。
    if (seen.has(name)) problems.push(`${title}：「${tag}」与通用词典里的 tag 重复登记`);
    // 注意：这里**不查** naiOnlyTags。那个白名单只表示「语料查不到」，
    // 里面有 masterpiece / year 2024 这类词 —— 它们在 SDXL / Anima 里同样是合法元词，
    // 拿它当「SD 不认」的判据会大面积误报。SD 真正不认的那一小撮在下面的接线断言里单独查。
    if (corpus.has(name) || allowedMeta.has(name)) return;
    problems.push(`${title}：语料与元信息白名单里都查不到「${tag}」（${name}）—— 要么改成真实 tag，要么确属官方模型卡里的元词后加进 IMAGE_TAG_LEXICON_META_ONLY`);
}));
// 白名单里不允许有「其实语料里就有」的词：那说明它根本不需要豁免（口径要严）。
for (const tag of metaOnlyTags) {
    const name = toDanbooruName(tag);
    if (corpus.has(name)) problems.push(`IMAGE_TAG_LEXICON_META_ONLY 里的「${tag}」其实在语料里存在，不该走白名单`);
}

// 接线断言：V4.5 不含 V5 专属词；V5 含；SD 拿到 SD 词典且不含 NAI 专属写法；ComfyUI 为空
const v45HasV5Only = v5Sections.some(([, tags]) => tags.some(tag => renderedV45.includes(tag)));
if (v45HasV5Only) problems.push('V4.5 词典里混进了 V5 专属 tag');
if (!v5Sections.every(([, tags]) => tags.every(tag => renderedV5.includes(tag)))) {
    problems.push('V5 词典没有把 V5 专属 tag 渲染进去');
}
if (renderedComfy !== '') problems.push('ComfyUI 不应拿到词典（提示词由用户工作流决定，应当返回空串）');
// SD 词典必须包含元信息节，且**不含** NovelAI 专属写法。
//
// 注意两点，否则断言会自己误报：
//   ① 只能看 `【分类】` 那些**标签行**，不能看 `- ` 开头的解释行 ——
//      解释行里为了说明「不要写 rating:*」本来就会提到这个词。
//   ② 「NAI 专有」不等于「在 naiOnlyTags 白名单里」：白名单里有 masterpiece / year 2024
//      这类词，它们只是**语料查不到**，在 SDXL / Anima 里同样是合法元词。
//      真正 SD 不认的是下面这一小撮 NAI 独有的分级 / 数据集 / 复杂度写法。
const NAI_EXCLUSIVE_IN_SD = [
    'rating:general', 'rating:sensitive', 'rating:questionable', 'rating:explicit',
    'fur dataset', 'background dataset', 'depthness', 'has alpha', 'alpha transparency',
    'low complexity', 'medium complexity', 'high complexity', 'ultra complexity',
    'visual novel art', 'visual novel bg', 'visual novel cg', 'visual novel sprite',
    'visual novel chibi', 'meta:novel era', 'meta:golden era'
];
const sdTagLines = renderedSd.split('\n').filter(line => line.startsWith('【'));
const sdTagText = sdTagLines.join(',');
const sdAnimaTagText = renderedSdAnima.split('\n').filter(line => line.startsWith('【')).join(',');

if (!renderedSd.includes('【质量 · 年代 · 安全级别】')) problems.push('SD 词典缺少「质量 · 年代 · 安全级别」一节');
for (const tag of NAI_EXCLUSIVE_IN_SD) {
    if (sdTagText.includes(tag)) problems.push(`SD 词典的标签行里出现了 NovelAI 专属写法「${tag}」`);
}
if (sdTagText.includes('::') || sdTagText.includes('source#')) {
    problems.push('SD 词典的标签行里出现了 NovelAI 专属的权重 / 互动锚点语法');
}
if (!sdAnimaTagText.includes('safe') || !sdTagText.includes('safe')) {
    problems.push('SD 词典缺少 SD 的安全级别词（safe / sensitive / nsfw / explicit）');
}
if (!renderedSdAnima.includes('画师标签必须加')) problems.push('Anima 词典缺少「画师标签加 @ 前缀」这条官方要求');
if (renderedSdAnima.includes('画师标签必须加') && renderedSd.includes('画师标签必须加')) {
    problems.push('SDXL 词典不该带 Anima 专属的 @ 画师前缀说明');
}
if (renderedV3.length === 0) problems.push('V3 也应当拿到一份词典（只是不含多角色锚点）');
if (/long_hair|_/.test(renderedV5.split('\n').filter(l => l.startsWith('【') && !l.includes('rating:')).join(''))) {
    problems.push('词典里出现了下划线写法（NovelAI 要空格：long hair，不是 long_hair）');
}

const tagCount = seen.size + seenMeta.size;
console.log(`语料 ${corpus.size} 条 · 词典 ${tagCount} 个 tag（其中 NAI 专有白名单 ${allowed.size} 个、SD 元信息白名单 ${allowedMeta.size} 个）`);
console.log(`渲染长度：V4.5 ${renderedV45.length} 字 · V5 ${renderedV5.length} 字 · V3 ${renderedV3.length} 字 · SDXL ${renderedSd.length} 字 · Anima ${renderedSdAnima.length} 字`);
if (problems.length === 0) {
    console.log('✓ 全部 tag 都能在真实语料、NAI 白名单或 SD 元信息白名单里找到');
    process.exit(0);
}
console.log(`✗ 发现 ${problems.length} 个问题：`);
problems.forEach((item) => console.log(`  - ${item}`));
process.exit(1);
