// 对抗检查：把两套世界书喂给真实 Forge 的解析器口径，确认没有会"弄坏提示词"的指令。
//
// 检查项（都是真实踩过或容易踩的坑）：
//   ① 世界书里教 AI 写的语法，本机 Forge 是否真的支持（BREAK / (tag:w) 括号权重 / @ 画师）
//   ② 世界书里有没有**自相矛盾**的指令（既要写 | 又禁止写 |）
//   ③ 世界书会不会把 image###…### 格式改坏（渲染正则依赖它）
//   ④ NAI 世界书是否仍然逐字节不变（改造不许碰 NAI 链路）
//   ⑤ 长度是否失控（世界书每轮都进上下文）
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (file) => {
    const sandbox = { window: {}, console };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(root, file), 'utf8'), sandbox, { filename: file });
    return sandbox.window;
};

const P = load('assets/js/built-in-content.js').RPHubBuiltinContent.prompts;
const appJs = readFileSync(join(root, 'assets/js/app.js'), 'utf8');

let bad = 0;
const check = (label, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${extra}`}`);
    if (!ok) bad += 1;
};

const wbAnima = P.buildAutoImageGenPrompt({ count: 3, provider: 'stable-diffusion', model: 'anima' });
const wbXl = P.buildAutoImageGenPrompt({ count: 3, provider: 'stable-diffusion', model: 'xl' });
const wbGenericSd = P.buildAutoImageGenPrompt({ count: 3, provider: 'stable-diffusion', model: '' });
const wbNai = P.buildAutoImageGenPrompt({ count: 3, provider: 'novelai', model: 'nai-diffusion-4-5-full' });

console.log('\n1) 教给 AI 的语法必须是本机 Forge 真支持的');
// BREAK：本机 backend/text_processing/parsing.py 里有 re_break
const parsing = readFileSync('D:/Stable-diffusion/sd-webui/backend/text_processing/parsing.py', 'utf8');
check('Forge 支持 BREAK（parsing.py 有 re_break）', /re_break/.test(parsing));
check('SD 世界书教的 BREAK 确实是 Forge 认的那个词', wbAnima.includes('BREAK') && /\\bBREAK\\b/.test(parsing));
// 括号权重：(tag:1.2) 走 re_attention 的 round_brackets + weight 分支
check('Forge 支持 (tag:权重) 括号语法', /round_brackets/.test(parsing) && /weight is not None/.test(parsing));
check('SD 世界书教的是括号权重而不是 :: 权重',
    wbAnima.includes('(tag:1.2)') && !/1\.3::tag::（常用/.test(wbAnima));

console.log('\n2) 世界书不能自相矛盾');
const pipeBanned = (t) => t.includes('一律不要写') || t.includes('不要写 `|`');
check('Anima 禁止写 |', pipeBanned(wbAnima));
check('SDXL 禁止写 |', pipeBanned(wbXl));
check('SD 世界书里没有"可以用 | 分栏"的旧指令',
    !/用 \| 分栏/.test(wbAnima) && !/用 \| 分栏/.test(wbXl));
check('SD 世界书里没有教 rating:* 的旧指令（只说"不是 rating:*"）',
    !/写 rating:explicit/.test(wbAnima));
// NAI 那份必须仍然教 | 分栏（没被 SD 的改动误伤）
check('NAI 世界书仍然教 | 分栏（没被误伤）', wbNai.includes('人数与场景 | 角色1'));

console.log('\n3) 输出格式契约不能被改坏（渲染正则依赖 image###…###）');
const regexSource = readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8');
check('渲染正则仍是 image###…###', /image###/.test(regexSource));
for (const [name, text] of [['Anima', wbAnima], ['SDXL', wbXl], ['通用 SD', wbGenericSd], ['NAI', wbNai]]) {
    check(`${name} 世界书仍要求 image###英文Tag###`, text.includes('image###英文Tag###'));
    check(`${name} 世界书仍禁止换行`, text.includes('不得换行'));
}
check('三套 SD 世界书都覆盖了「分散穿插」这条硬要求',
    [wbAnima, wbXl, wbGenericSd].every(t => t.includes('分散插入')));

console.log('\n4) 各架构必须给出**不同**的世界书（否则分流没意义）');
check('Anima 与 SDXL 的世界书正文不同', wbAnima !== wbXl);
check('SDXL 与通用 SD 的世界书正文不同', wbXl !== wbGenericSd);
check('SD 与 NAI 的世界书正文不同', wbAnima !== wbNai);
const floorOf = (t) => t.split('\n').find(l => l.startsWith('- 每张图的提示词合计')) || '';
check('Anima 下限是 200 token', floorOf(wbAnima).includes('200 个 token'), floorOf(wbAnima));
check('SDXL 下限是 100 tag / 120 token',
    floorOf(wbXl).includes('100 个 tag') && floorOf(wbXl).includes('120'), floorOf(wbXl));
check('通用 SD 下限也有（不会漏掉档位为空的情况）', floorOf(wbGenericSd).length > 0, floorOf(wbGenericSd));
check('NAI 下限仍是 60 个 tag（未被改动）', floorOf(wbNai).includes('60 个 tag'), floorOf(wbNai));

console.log('\n5) 长度护栏（世界书每轮都进上下文）');
for (const [name, text] of [['Anima', wbAnima], ['SDXL', wbXl], ['通用 SD', wbGenericSd]]) {
    check(`${name} 世界书 < 4500 字（实际 ${text.length}）`, text.length < 4500);
}
check('SD 世界书不比 NAI 那份更臃肿', wbAnima.length <= wbNai.length);

console.log('\n6) 接线：SD 档位必须真的能驱动世界书重建');
check('enforceSpecialRules 里 SD 取 sdUiPreset',
    /const autoImageGenModel = isSdProvider\.value[\s\S]{0,160}settings\.sdUiPreset/.test(appJs));
check('sdUiPreset 在重建 watch 的依赖数组里',
    /settings\.sdUiPreset,/.test(appJs));
check('词典与世界书同源（同一个 autoImageGenModel）',
    /const tagLexiconContent = BUILTIN_PROMPTS\.buildImageTagLexicon\(\{[\s\S]{0,160}model: autoImageGenModel/.test(appJs));
check('sdUiPreset 也是生图预设 profile 字段（切预设能带过去）',
    /IMAGE_PROFILE_FIELDS[\s\S]{0,1200}sdUiPreset/.test(readFileSync(join(root, 'assets/js/core-utils.js'), 'utf8')));

console.log('\n7) NAI 链路逐字节不变（对照钉死的黄金摘要）');
// 这里**不能**拿 git HEAD 当基线：改动一旦提交，HEAD 就等于工作区，比较退化成「自己等于自己」，
// 把 NAI 世界书改坏也照样通过（反向验证实测过这种退化）。
// 因此把改造前实测出来的 sha256 直接钉在脚本里 —— 谁动了 NAI 链路，这里立刻变红。
const GOLDEN_NAI = {
    'NAI V4.5 世界书': { sha: 'a6c597ada99395ccf8c333b59abed423818f6449a26f5aee5941331736cac7f0', len: 6333 },
    'NAI V5 官方世界书': { sha: '0d0ba0b2800925bdb1b90d42c4ebe1c19aa56d88edd93bd530c7cd3d0610edb0', len: 6358 },
    'NAI 旧签名世界书': { sha: '6103756d28969d45f34373f2fa4439cb28a2e31b8dcf456529b18a0ffa33a788', len: 5390 },
    'NAI V5 词典': { sha: '61c02e9eb95e3fd06ec4fbe373fb752f8c8d4275dc0b833cbb1abf9cb7287c29', len: 7154 },
    'NAI V4.5 词典': { sha: '48b09d99421d615a28517eb78634f473d13ce69aeb80d773a83cdd8f7a4f0549', len: 6836 },
    'NAI V4.5 模型约束': { sha: '3b71ef86311b71e2613f070fe8129486565c8634494bfecd3bdaea4228f4be73', len: 941 },
    'NAI V5 模型约束': { sha: '7f64fe6b87008860fa8388b78b5c91ca71f41d64227b7219b259a2169551ff63', len: 959 },
    'NAI tag 规范器': { sha: 'b48e22d6bc41cce9fa167f36e2edd1805657ab83af4f6d0fe0668aaaccbc3950', len: 7427 }
};
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const naiOutputs = {
    'NAI V4.5 世界书': wbNai,
    'NAI V5 官方世界书': P.buildAutoImageGenPrompt({ count: 3, provider: 'novelai-official', model: 'nai-diffusion-5-full' }),
    'NAI 旧签名世界书': P.buildAutoImageGenPrompt(3),
    'NAI V5 词典': P.buildImageTagLexicon({ model: 'nai-diffusion-5-full', provider: 'novelai' }),
    'NAI V4.5 词典': P.buildImageTagLexicon({ model: 'nai-diffusion-4-5-full', provider: 'novelai' }),
    'NAI V4.5 模型约束': P.buildImageModelPromptRules({ provider: 'novelai', model: 'nai-diffusion-4-5-full' }),
    'NAI V5 模型约束': P.buildImageModelPromptRules({ provider: 'novelai', model: 'nai-diffusion-5-full' }),
    'NAI tag 规范器': P.buildImageTagNormalizePrompt({ model: 'nai-diffusion-4-5-full', provider: 'novelai' })
};
for (const [name, golden] of Object.entries(GOLDEN_NAI)) {
    const text = naiOutputs[name];
    check(`${name} 逐字节不变（长度 ${text.length}）`,
        sha(text) === golden.sha && text.length === golden.len,
        `期望 ${golden.len} 字 / ${golden.sha.slice(0, 12)}…，实际 ${text.length} 字 / ${sha(text).slice(0, 12)}…`);
}

console.log(`\n结果: ${bad === 0 ? '通过' : '失败'} — ${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
